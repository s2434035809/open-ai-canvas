package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"

	"yingce/backend/internal/model"
)

type ChannelModelsRequest struct {
	BaseURL   string           `json:"baseUrl"`
	APIKey    string           `json:"apiKey"`
	APIFormat string           `json:"apiFormat"`
	Headers   []OutboundHeader `json:"headers"`
}

type channelModelsPayload struct {
	Data   channelModelList   `json:"data"`
	Models []channelModelItem `json:"models"`
	Error  *providerError     `json:"error"`
	Code   *int               `json:"code"`
	Msg    string             `json:"msg"`
}

// channelModelList 兼容两种 data 形态：OpenAI 兼容接口的模型数组，以及红鸟等中转站
// 使用的 {"models":[...]} 对象。对象里既没有 models 也没有 data 时按空目录处理，
// 但 data 是标量等无法识别的形态会直接报错，避免把不认识的响应当成「上游没有模型」。
type channelModelList []channelModelItem

func (list *channelModelList) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		*list = nil
		return nil
	}
	switch trimmed[0] {
	case '[':
		var items []channelModelItem
		if err := json.Unmarshal(trimmed, &items); err != nil {
			return err
		}
		*list = items
		return nil
	case '{':
		var envelope struct {
			Models []channelModelItem `json:"models"`
			Data   []channelModelItem `json:"data"`
		}
		if err := json.Unmarshal(trimmed, &envelope); err != nil {
			return err
		}
		*list = envelope.Models
		if len(*list) == 0 {
			*list = envelope.Data
		}
		return nil
	default:
		return fmt.Errorf("模型目录 data 既不是数组也不是对象")
	}
}

// channelModelCatalogSuccessCode 收敛上游对成功 code 的不同约定：New-API 系用 0，
// 红鸟等中转站用 200；HTTP 状态码在传输层已单独判定。
func channelModelCatalogSuccessCode(code int) bool {
	return code == 0 || code == 200
}

type channelModelItem struct {
	ID                     string                        `json:"id"`
	Name                   string                        `json:"name"`
	DisplayName            string                        `json:"display_name"`
	ModelType              string                        `json:"model_type"`
	SupportedEndpointTypes []string                      `json:"supported_endpoint_types"`
	DefaultParameters      channelModelCatalogParameters `json:"default_parameters"`
	Options                channelModelCatalogOptions    `json:"options"`
	SupportsImages         *bool                         `json:"supports_images"`
	MinImages              *int                          `json:"min_images"`
	MaxImages              *int                          `json:"max_images"`
}

type channelModelCatalogParameters struct {
	AspectRatio     string `json:"aspect_ratio"`
	DurationSeconds string `json:"duration_seconds"`
	Resolution      string `json:"resolution"`
}

type channelModelCatalogOptions struct {
	AspectRatio     []ChannelModelCatalogOption `json:"aspect_ratio"`
	DurationSeconds []ChannelModelCatalogOption `json:"duration_seconds"`
	Resolution      []ChannelModelCatalogOption `json:"resolution"`
}

func (s *Service) FetchChannelModels(ctx context.Context, actor *model.User, input ChannelModelsRequest) ([]string, error) {
	items, err := s.FetchChannelModelCatalog(ctx, actor, input)
	if err != nil {
		return nil, err
	}
	seen := make(map[string]bool, len(items))
	models := make([]string, 0, len(items))
	for _, item := range items {
		name := strings.TrimSpace(item.ID)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		models = append(models, name)
	}
	sort.Strings(models)
	return models, nil
}

// ChannelModelCatalogItem 是前端自定义渠道拉取模型目录后的最小合同；
// 协议、能力和可选参数均来自上游公开元数据，不展开供应商内部兼容模型。
type ChannelModelCatalogItem struct {
	ID                     string                               `json:"id"`
	DisplayName            string                               `json:"displayName,omitempty"`
	ModelType              string                               `json:"modelType,omitempty"`
	SupportedEndpointTypes []string                             `json:"supportedEndpointTypes,omitempty"`
	DefaultParameters      ChannelModelCatalogDefaultParameters `json:"defaultParameters,omitempty"`
	Options                ChannelModelCatalogOptions           `json:"options,omitempty"`
	SupportsImages         *bool                                `json:"supportsImages,omitempty"`
	MinImages              *int                                 `json:"minImages,omitempty"`
	MaxImages              *int                                 `json:"maxImages,omitempty"`
}

type ChannelModelCatalogDefaultParameters struct {
	AspectRatio     string `json:"aspectRatio,omitempty"`
	DurationSeconds string `json:"durationSeconds,omitempty"`
	Resolution      string `json:"resolution,omitempty"`
}

type ChannelModelCatalogOptions struct {
	AspectRatio     []ChannelModelCatalogOption `json:"aspectRatio,omitempty"`
	DurationSeconds []ChannelModelCatalogOption `json:"durationSeconds,omitempty"`
	Resolution      []ChannelModelCatalogOption `json:"resolution,omitempty"`
}

type ChannelModelCatalogOption struct {
	Value string `json:"value"`
	Label string `json:"label,omitempty"`
}

func (s *Service) FetchChannelModelCatalog(ctx context.Context, actor *model.User, input ChannelModelsRequest) ([]ChannelModelCatalogItem, error) {
	if actor == nil || strings.TrimSpace(actor.ID) == "" {
		return nil, Unauthorized("请先登录")
	}
	baseURL := strings.TrimRight(strings.TrimSpace(input.BaseURL), "/")
	apiKey := strings.TrimSpace(input.APIKey)
	if baseURL == "" {
		return nil, BadAuthRequest("请填写 Base URL")
	}
	if apiKey == "" {
		return nil, BadAuthRequest("请填写 API Key")
	}
	apiFormat := strings.ToLower(strings.TrimSpace(input.APIFormat))
	if apiFormat == "" {
		apiFormat = "openai"
	}
	if apiFormat != "openai" && apiFormat != "gemini" {
		return nil, BadAuthRequest("接口协议不支持拉取模型")
	}
	headers, err := NormalizeOutboundHeaders(input.Headers)
	if err != nil {
		return nil, err
	}

	target := apiURL(baseURL, "/models")
	if apiFormat == "gemini" {
		if !strings.HasSuffix(strings.ToLower(baseURL), "/v1beta") {
			baseURL += "/v1beta"
		}
		target = baseURL + "/models"
	}
	if _, err := ValidateOutboundURL(target); err != nil {
		return nil, err
	}
	items, err := fetchChannelModelCatalogItems(ctx, target, apiFormat, apiKey, headers)
	if err != nil {
		return nil, err
	}
	seen := make(map[string]bool, len(items))
	catalog := make([]ChannelModelCatalogItem, 0, len(items))
	for _, item := range items {
		name := strings.TrimPrefix(strings.TrimSpace(firstNonEmpty(item.ID, item.Name)), "models/")
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		catalog = append(catalog, ChannelModelCatalogItem{
			ID:                     name,
			DisplayName:            strings.TrimSpace(item.DisplayName),
			ModelType:              normalizeCatalogModelType(item.ModelType),
			SupportedEndpointTypes: normalizeCatalogEndpointTypes(item.SupportedEndpointTypes),
			DefaultParameters: ChannelModelCatalogDefaultParameters{
				AspectRatio:     strings.TrimSpace(item.DefaultParameters.AspectRatio),
				DurationSeconds: strings.TrimSpace(item.DefaultParameters.DurationSeconds),
				Resolution:      strings.TrimSpace(item.DefaultParameters.Resolution),
			},
			Options: ChannelModelCatalogOptions{
				AspectRatio:     normalizeCatalogOptions(item.Options.AspectRatio),
				DurationSeconds: normalizeCatalogOptions(item.Options.DurationSeconds),
				Resolution:      normalizeCatalogOptions(item.Options.Resolution),
			},
			SupportsImages: item.SupportsImages,
			MinImages:      item.MinImages,
			MaxImages:      item.MaxImages,
		})
	}
	sort.Slice(catalog, func(left int, right int) bool {
		return catalog[left].ID < catalog[right].ID
	})
	if s.isPluginEnabled() {
		catalog = extendChannelModelCatalog(baseURL, apiFormat, headers, catalog)
	}
	return catalog, nil
}

func normalizeCatalogModelType(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	switch normalized {
	case "text", "image", "video", "audio":
		return normalized
	default:
		return ""
	}
}

func normalizeCatalogOptions(options []ChannelModelCatalogOption) []ChannelModelCatalogOption {
	seen := make(map[string]bool, len(options))
	normalized := make([]ChannelModelCatalogOption, 0, len(options))
	for _, option := range options {
		value := strings.TrimSpace(option.Value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		normalized = append(normalized, ChannelModelCatalogOption{Value: value, Label: strings.TrimSpace(option.Label)})
	}
	return normalized
}

func normalizeCatalogEndpointTypes(values []string) []string {
	seen := make(map[string]bool, len(values))
	normalized := make([]string, 0, len(values))
	for _, value := range values {
		item := strings.TrimSpace(value)
		if item == "" || seen[item] {
			continue
		}
		seen[item] = true
		normalized = append(normalized, item)
	}
	return normalized
}

func channelModelsUpstreamError(err error) error {
	var authErr *AuthError
	if errors.As(err, &authErr) {
		return authErr
	}
	var httpErr providerHTTPError
	if !errors.As(err, &httpErr) {
		return WrapAppError(http.StatusBadGateway, "连接模型服务失败，请检查渠道地址和网络", err)
	}
	switch httpErr.StatusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		return NewAppError(http.StatusBadGateway, "模型服务鉴权失败，请检查 API Key")
	case http.StatusNotFound:
		return NewAppError(http.StatusBadGateway, "模型服务未提供 /models 接口")
	case http.StatusTooManyRequests:
		return NewAppError(http.StatusBadGateway, "模型服务请求过于频繁或额度不足")
	default:
		return WrapAppError(http.StatusBadGateway, httpErr.Error(), err)
	}
}

const (
	// channelModelCatalogCacheTTL 拉取结果的短时缓存：后台连续点选时直接复用，
	// 不必每次都去等上游几十秒。2 分钟足以覆盖「点一次没反应再点一次」的场景。
	channelModelCatalogCacheTTL = 2 * time.Minute
	// channelModelCatalogCacheLimit 限制条目数，避免不同地址/密钥无限堆积。
	channelModelCatalogCacheLimit = 64
	// channelModelCatalogRetryDelay 上游偶发断连后的重试间隔。
	channelModelCatalogRetryDelay = 800 * time.Millisecond
)

// channelModelCatalogAttemptTimeout 是单次上游尝试的上限。红鸟这类聚合站的模型目录
// 冷启动实测十几秒到一分半，正常情况远低于这个值；真正挂死时靠它把等待从 5 分钟
// 压到可控范围，并给重试留出预算。声明成变量是为了让测试能把它压到毫秒级。
var channelModelCatalogAttemptTimeout = 75 * time.Second

type channelModelCatalogCacheEntry struct {
	items     []channelModelItem
	expiresAt time.Time
}

var channelModelCatalogCacheStore = struct {
	mu      sync.Mutex
	entries map[string]channelModelCatalogCacheEntry
}{entries: map[string]channelModelCatalogCacheEntry{}}

// channelModelCatalogGroup 合并同一缓存键的并发拉取，避免上游挂死时点选次数被放大成
// 上游侧的多份排队请求。
var channelModelCatalogGroup singleflight.Group

// fetchChannelModelCatalogItems 拉取并解析上游模型目录，比其它出站请求多三层保护：
// 同一「地址+协议+密钥+自定义头」的并发请求合并成一次上游访问；每次上游尝试单独限时，
// 超时/断连重试一次；成功结果短时缓存。鉴权失败、HTTP 状态错误、响应格式错误都不重试，
// 避免把配置问题当成网络抖动。
func fetchChannelModelCatalogItems(ctx context.Context, target string, apiFormat string, apiKey string, headers []OutboundHeader) ([]channelModelItem, error) {
	cacheKey := channelModelCatalogCacheKey(target, apiFormat, apiKey, headers)
	if items, ok := loadChannelModelCatalogCache(cacheKey); ok {
		return items, nil
	}
	// 上游红鸟这类聚合站的模型目录冷启动要十几秒，挂死时又可能几分钟不返回。并发点选
	// 若各自发起上游请求，只会在上游侧排队，于是所有人都一起超时。这里按缓存键合并，
	// 一次上游访问的结果（含错误）由所有等待者共享。
	shared, err, _ := channelModelCatalogGroup.Do(cacheKey, func() (any, error) {
		if items, ok := loadChannelModelCatalogCache(cacheKey); ok {
			return items, nil
		}
		items, err := fetchChannelModelCatalogUpstream(ctx, target, apiFormat, apiKey, headers)
		if err != nil {
			return nil, err
		}
		storeChannelModelCatalogCache(cacheKey, items)
		return items, nil
	})
	if err != nil {
		return nil, err
	}
	items, _ := shared.([]channelModelItem)
	return items, nil
}

// fetchChannelModelCatalogUpstream 是单次上游访问本体。每次尝试用独立的超时上下文，
// 这样上游只是「慢」而不是「挂」时，第一尝试超时后上游侧的目录通常已经建好，
// 第二次尝试往往几百毫秒就能命中，比继续等满 5 分钟更容易成功。
func fetchChannelModelCatalogUpstream(ctx context.Context, target string, apiFormat string, apiKey string, headers []OutboundHeader) ([]channelModelItem, error) {
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return nil, channelModelsUpstreamError(lastErr)
			case <-time.After(channelModelCatalogRetryDelay):
			}
		}
		attemptCtx, cancelAttempt := context.WithTimeout(ctx, channelModelCatalogAttemptTimeout)
		request, err := http.NewRequestWithContext(attemptCtx, http.MethodGet, target, nil)
		if err != nil {
			cancelAttempt()
			return nil, BadAuthRequest("模型服务地址无效")
		}
		if apiFormat == "gemini" {
			request.Header.Set("x-goog-api-key", apiKey)
		} else {
			request.Header.Set("Authorization", "Bearer "+apiKey)
		}
		ApplyOutboundHeaders(request, headers)

		// 只代理固定的模型目录 GET；用户密钥仅用于本次请求，不写入数据库或日志。
		data, _, err := doBinary(request)
		cancelAttempt()
		if err != nil {
			lastErr = err
			if attempt == 0 && channelModelCatalogRetryable(ctx, err) {
				continue
			}
			return nil, channelModelsUpstreamError(err)
		}
		items, err := parseChannelModelCatalogItems(data, apiFormat)
		if err != nil {
			return nil, err
		}
		return items, nil
	}
	return nil, channelModelsUpstreamError(lastErr)
}

func parseChannelModelCatalogItems(data []byte, apiFormat string) ([]channelModelItem, error) {
	var payload channelModelsPayload
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, WrapAppError(http.StatusBadGateway, "模型服务返回的模型目录无法识别", err)
	}
	if payload.Error != nil && strings.TrimSpace(payload.Error.Message) != "" {
		return nil, NewAppError(http.StatusBadGateway, "模型服务返回失败，请检查渠道配置")
	}
	if payload.Code != nil && !channelModelCatalogSuccessCode(*payload.Code) {
		return nil, NewAppError(http.StatusBadGateway, "模型服务返回失败，请检查渠道配置")
	}
	if apiFormat == "gemini" {
		return payload.Models, nil
	}
	return payload.Data, nil
}

// channelModelCatalogRetryable 只认传输层问题：连接被断、重置、读超时、响应提前结束。
// 单次尝试自己的超时（context.DeadlineExceeded）也算传输层失败——上游往往只是慢，
// 重试那次多半能命中它刚建好的目录。调用方主动取消（context.Canceled 或上下文已结束）
// 不再重试；HTTP 状态错误（providerHTTPError）同理，避免把配置问题当成网络抖动。
func channelModelCatalogRetryable(ctx context.Context, err error) bool {
	if err == nil {
		return false
	}
	if ctx.Err() != nil {
		return false
	}
	if errors.Is(err, context.Canceled) {
		return false
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		return true
	}
	return errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF)
}

// channelModelCatalogCacheKey 把「地址+协议+密钥+自定义头」压成一个哈希，缓存键里不出现明文密钥。
func channelModelCatalogCacheKey(target string, apiFormat string, apiKey string, headers []OutboundHeader) string {
	parts := []string{strings.ToLower(strings.TrimSpace(target)), strings.ToLower(strings.TrimSpace(apiFormat)), apiKey}
	for _, header := range headers {
		parts = append(parts, strings.ToLower(strings.TrimSpace(header.Name))+"="+header.Value)
	}
	digest := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(digest[:16])
}

// loadChannelModelCatalogCache 命中时返回上游原始条目；条目按只读使用，
// 调用方的排序与插件扩展都会生成新切片，不会回写缓存。
func loadChannelModelCatalogCache(key string) ([]channelModelItem, bool) {
	channelModelCatalogCacheStore.mu.Lock()
	defer channelModelCatalogCacheStore.mu.Unlock()
	entry, ok := channelModelCatalogCacheStore.entries[key]
	if !ok {
		return nil, false
	}
	if time.Now().After(entry.expiresAt) {
		delete(channelModelCatalogCacheStore.entries, key)
		return nil, false
	}
	return entry.items, true
}

func storeChannelModelCatalogCache(key string, items []channelModelItem) {
	// 空目录不缓存：上游刚补上模型时，下一次点击应立刻看到，而不是等缓存过期。
	if len(items) == 0 {
		return
	}
	channelModelCatalogCacheStore.mu.Lock()
	defer channelModelCatalogCacheStore.mu.Unlock()
	if _, exists := channelModelCatalogCacheStore.entries[key]; !exists && len(channelModelCatalogCacheStore.entries) >= channelModelCatalogCacheLimit {
		now := time.Now()
		for cachedKey, entry := range channelModelCatalogCacheStore.entries {
			if now.After(entry.expiresAt) {
				delete(channelModelCatalogCacheStore.entries, cachedKey)
			}
		}
		if len(channelModelCatalogCacheStore.entries) >= channelModelCatalogCacheLimit {
			channelModelCatalogCacheStore.entries = map[string]channelModelCatalogCacheEntry{}
		}
	}
	channelModelCatalogCacheStore.entries[key] = channelModelCatalogCacheEntry{
		items:     items,
		expiresAt: time.Now().Add(channelModelCatalogCacheTTL),
	}
}
