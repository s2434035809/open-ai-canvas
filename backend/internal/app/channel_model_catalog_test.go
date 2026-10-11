package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestChannelModelsPayloadAcceptsArrayAndEnvelopeData(t *testing.T) {
	cases := []struct {
		name string
		body string
		want []string
	}{
		{
			name: "OpenAI 兼容的 data 数组",
			body: `{"data":[{"id":"gpt-image-2"},{"id":"sora-2"}]}`,
			want: []string{"gpt-image-2", "sora-2"},
		},
		{
			name: "红鸟的 data.models 对象",
			body: `{"code":200,"message":"查询成功","data":{"models":[{"id":"sd2-th-2.0-720p"},{"id":"veo-omni-z"}]}}`,
			want: []string{"sd2-th-2.0-720p", "veo-omni-z"},
		},
		{
			name: "data 对象内再嵌 data 数组",
			body: `{"data":{"data":[{"id":"legacy-model"}]}}`,
			want: []string{"legacy-model"},
		},
		{
			name: "data 为 null",
			body: `{"data":null}`,
			want: nil,
		},
		{
			name: "data 对象里没有模型列表",
			body: `{"data":{"total":0}}`,
			want: nil,
		},
		{
			name: "顶层 models 形态",
			body: `{"models":[{"id":"gemini-3.0-pro"}]}`,
			want: []string{"gemini-3.0-pro"},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			var payload channelModelsPayload
			if err := json.Unmarshal([]byte(testCase.body), &payload); err != nil {
				t.Fatalf("解析失败：%v", err)
			}
			items := payload.Data
			if len(items) == 0 {
				items = payload.Models
			}
			got := make([]string, 0, len(items))
			for _, item := range items {
				got = append(got, item.ID)
			}
			if strings.Join(got, ",") != strings.Join(testCase.want, ",") {
				t.Fatalf("模型列表 = %v，期望 %v", got, testCase.want)
			}
		})
	}
}

func TestChannelModelsPayloadRejectsUnrecognizedData(t *testing.T) {
	var payload channelModelsPayload
	if err := json.Unmarshal([]byte(`{"data":"ok"}`), &payload); err == nil {
		t.Fatal("data 为标量时应报错，不能静默当成空目录")
	}
}

func TestChannelModelCatalogSuccessCode(t *testing.T) {
	for _, code := range []int{0, 200} {
		if !channelModelCatalogSuccessCode(code) {
			t.Fatalf("code %d 应视为成功", code)
		}
	}
	for _, code := range []int{401, 500, 1001} {
		if channelModelCatalogSuccessCode(code) {
			t.Fatalf("code %d 应视为失败", code)
		}
	}
}

func TestParseChannelModelCatalogItems(t *testing.T) {
	openaiItems, err := parseChannelModelCatalogItems([]byte(`{"code":200,"message":"查询成功","data":{"models":[{"id":"sd2-th-2.0-720p"}]}}`), "openai")
	if err != nil {
		t.Fatalf("红鸟形态解析失败：%v", err)
	}
	if len(openaiItems) != 1 || openaiItems[0].ID != "sd2-th-2.0-720p" {
		t.Fatalf("openai 条目异常：%+v", openaiItems)
	}

	geminiItems, err := parseChannelModelCatalogItems([]byte(`{"models":[{"id":"models/gemini-3.0-pro"}]}`), "gemini")
	if err != nil {
		t.Fatalf("gemini 形态解析失败：%v", err)
	}
	if len(geminiItems) != 1 || geminiItems[0].ID != "models/gemini-3.0-pro" {
		t.Fatalf("gemini 条目异常：%+v", geminiItems)
	}

	if _, err := parseChannelModelCatalogItems([]byte(`{"code":401,"message":"未授权"}`), "openai"); err == nil {
		t.Fatal("上游返回失败码时应报错")
	}
	if _, err := parseChannelModelCatalogItems([]byte(`{"data":"ok"}`), "openai"); err == nil {
		t.Fatal("无法识别的目录形态应报错")
	}
}

func TestChannelModelCatalogRetryable(t *testing.T) {
	live := context.Background()
	if channelModelCatalogRetryable(live, nil) {
		t.Fatal("nil 不应重试")
	}
	transportErr := &url.Error{Op: "Get", URL: "https://example.com/v1/models", Err: errors.New("connection reset by peer")}
	if !channelModelCatalogRetryable(live, transportErr) {
		t.Fatal("传输层错误应重试")
	}
	if !channelModelCatalogRetryable(live, io.ErrUnexpectedEOF) {
		t.Fatal("响应提前结束应重试")
	}
	// 单次尝试自己的超时也归属传输层：上游只是慢时，重试那次往往几百毫秒就能命中。
	if !channelModelCatalogRetryable(live, &url.Error{Op: "Get", URL: "https://example.com", Err: context.DeadlineExceeded}) {
		t.Fatal("单次尝试超时应重试")
	}
	if channelModelCatalogRetryable(live, providerHTTPError{StatusCode: 500, Status: "500 Internal Server Error"}) {
		t.Fatal("HTTP 状态错误不应重试")
	}
	if channelModelCatalogRetryable(live, &url.Error{Op: "Get", URL: "https://example.com", Err: context.Canceled}) {
		t.Fatal("上下文取消不应重试")
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if channelModelCatalogRetryable(canceled, transportErr) {
		t.Fatal("调用方上下文已结束不应重试")
	}
	if channelModelCatalogRetryable(live, errors.New("上游响应超过 64 MiB 限制")) {
		t.Fatal("普通业务错误不应重试")
	}
}

func TestChannelModelCatalogCache(t *testing.T) {
	cacheKey := channelModelCatalogCacheKey("https://open.hongniaoai.com/v1", "openai", "sk-plain-secret", []OutboundHeader{{Name: "X-Trace", Value: "alpha"}})
	if strings.Contains(cacheKey, "sk-plain-secret") || strings.Contains(cacheKey, "alpha") {
		t.Fatalf("缓存键不应包含明文密钥或头值：%s", cacheKey)
	}
	if _, ok := loadChannelModelCatalogCache(cacheKey); ok {
		t.Fatal("未写入时不应命中缓存")
	}
	storeChannelModelCatalogCache(cacheKey, []channelModelItem{{ID: "sd2-th-2.0-720p"}})
	cached, ok := loadChannelModelCatalogCache(cacheKey)
	if !ok || len(cached) != 1 || cached[0].ID != "sd2-th-2.0-720p" {
		t.Fatalf("缓存命中异常：ok=%v items=%+v", ok, cached)
	}
	if otherKey := channelModelCatalogCacheKey("https://open.hongniaoai.com/v1", "openai", "sk-other-secret", nil); otherKey == cacheKey {
		t.Fatal("不同密钥必须产生不同缓存键")
	} else if _, ok := loadChannelModelCatalogCache(otherKey); ok {
		t.Fatal("不同密钥不应共用缓存")
	}
	emptyKey := channelModelCatalogCacheKey("https://open.hongniaoai.com/v1", "openai", "sk-empty-secret", nil)
	storeChannelModelCatalogCache(emptyKey, nil)
	if _, ok := loadChannelModelCatalogCache(emptyKey); ok {
		t.Fatal("空目录不应写入缓存")
	}
}

// 下面三个用例走 httptest 直接打 fetchChannelModelCatalogItems，验证「传输层失败重试一次、
// HTTP 状态错误不重试、成功后短时缓存」这三条新增行为真的生效，而不只是单测了辅助函数。
func TestFetchChannelModelCatalogItemsRetriesTransportFailureOnce(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var attempts int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if atomic.AddInt32(&attempts, 1) == 1 {
			// 第一次直接掐断连接，模拟上游偶发断连。
			hijacker, ok := w.(http.Hijacker)
			if !ok {
				t.Error("响应写入器不支持 hijack")
				return
			}
			conn, _, err := hijacker.Hijack()
			if err != nil {
				t.Errorf("hijack 失败：%v", err)
				return
			}
			_ = conn.Close()
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":200,"data":{"models":[{"id":"sd2-th-2.0-720p"}]}}`))
	}))
	defer upstream.Close()

	items, err := fetchChannelModelCatalogItems(context.Background(), upstream.URL+"/v1/models", "openai", "sk-retry-secret", nil)
	if err != nil {
		t.Fatalf("断连后重试应成功：%v", err)
	}
	if len(items) != 1 || items[0].ID != "sd2-th-2.0-720p" {
		t.Fatalf("条目异常：%+v", items)
	}
	if got := atomic.LoadInt32(&attempts); got != 2 {
		t.Fatalf("上游请求次数 = %d，期望 2（断连后重试一次）", got)
	}
}

func TestFetchChannelModelCatalogItemsDoesNotRetryHTTPStatusError(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var attempts int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&attempts, 1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer upstream.Close()

	if _, err := fetchChannelModelCatalogItems(context.Background(), upstream.URL+"/v1/models", "openai", "sk-status-secret", nil); err == nil {
		t.Fatal("上游 500 应报错")
	}
	if got := atomic.LoadInt32(&attempts); got != 1 {
		t.Fatalf("上游请求次数 = %d，期望 1（HTTP 状态错误不重试）", got)
	}
}

func TestFetchChannelModelCatalogItemsReusesCachedSuccess(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var attempts int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&attempts, 1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"gpt-image-2"}]}`))
	}))
	defer upstream.Close()

	target := upstream.URL + "/v1/models"
	first, err := fetchChannelModelCatalogItems(context.Background(), target, "openai", "sk-cache-secret", nil)
	if err != nil {
		t.Fatalf("首次拉取失败：%v", err)
	}
	second, err := fetchChannelModelCatalogItems(context.Background(), target, "openai", "sk-cache-secret", nil)
	if err != nil {
		t.Fatalf("缓存命中失败：%v", err)
	}
	if len(first) != 1 || len(second) != 1 || second[0].ID != "gpt-image-2" {
		t.Fatalf("条目异常：first=%+v second=%+v", first, second)
	}
	if got := atomic.LoadInt32(&attempts); got != 1 {
		t.Fatalf("上游请求次数 = %d，期望 1（命中缓存不应再打上游）", got)
	}
}

// TestFetchChannelModelCatalogItemsRetriesSlowAttemptOnce 覆盖红鸟式的「慢」而不是「挂」：
// 第一次上游目录迟迟不返回（冷启动聚合），单次尝试超时后重试，此时上游侧目录已经建好，
// 第二次几百毫秒就能返回。旧实现把超时排除在可重试之外，只能干等满 5 分钟再报 502。
func TestFetchChannelModelCatalogItemsRetriesSlowAttemptOnce(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	previousTimeout := channelModelCatalogAttemptTimeout
	channelModelCatalogAttemptTimeout = 200 * time.Millisecond
	defer func() { channelModelCatalogAttemptTimeout = previousTimeout }()

	var attempts int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if atomic.AddInt32(&attempts, 1) == 1 {
			time.Sleep(700 * time.Millisecond)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":200,"data":{"models":[{"id":"sd2-th-2.0-720p"}]}}`))
	}))
	defer upstream.Close()

	items, err := fetchChannelModelCatalogItems(context.Background(), upstream.URL+"/v1/models", "openai", "sk-slow-secret", nil)
	if err != nil {
		t.Fatalf("单次尝试超时后重试应成功：%v", err)
	}
	if len(items) != 1 || items[0].ID != "sd2-th-2.0-720p" {
		t.Fatalf("条目异常：%+v", items)
	}
	if got := atomic.LoadInt32(&attempts); got != 2 {
		t.Fatalf("上游请求次数 = %d，期望 2（单次尝试超时后重试一次）", got)
	}
}

// TestFetchChannelModelCatalogItemsCoalescesConcurrentFetches 覆盖同一个渠道被连续点选：
// 上游挂住时，多个调用应合并成一次上游访问，而不是各自排队把上游拖得更慢。
func TestFetchChannelModelCatalogItemsCoalescesConcurrentFetches(t *testing.T) {
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	var attempts int32
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if atomic.AddInt32(&attempts, 1) == 1 {
			<-release
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":200,"data":{"models":[{"id":"gpt-image-2"}]}}`))
	}))
	defer upstream.Close()

	const callers = 4
	target := upstream.URL + "/v1/models"
	var wg sync.WaitGroup
	errs := make(chan error, callers)
	results := make(chan []channelModelItem, callers)
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			items, err := fetchChannelModelCatalogItems(context.Background(), target, "openai", "sk-coalesce-secret", nil)
			if err != nil {
				errs <- err
				return
			}
			results <- items
		}()
	}
	// 等首个上游请求挂住，让其余调用都进入合并窗口后再放行。
	time.Sleep(300 * time.Millisecond)
	close(release)
	wg.Wait()
	close(errs)
	close(results)

	for err := range errs {
		t.Fatalf("并发拉取失败：%v", err)
	}
	delivered := 0
	for items := range results {
		delivered++
		if len(items) != 1 || items[0].ID != "gpt-image-2" {
			t.Fatalf("条目异常：%+v", items)
		}
	}
	if delivered != callers {
		t.Fatalf("成功返回数 = %d，期望 %d", delivered, callers)
	}
	if got := atomic.LoadInt32(&attempts); got != 1 {
		t.Fatalf("上游请求次数 = %d，期望 1（同键并发应合并）", got)
	}
}
