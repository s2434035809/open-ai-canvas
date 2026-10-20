package app

import (
	"encoding/json"
	"log"
	"strings"

	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

// Only user-editable image options cross the approval boundary. Targets,
// references, prompt, snapshot and generation mode remain server-authored.
type CloudAgentMediaSettings struct {
	LogicalModelID             string `json:"logicalModelId,omitempty"`
	ChannelID                  string `json:"channelId,omitempty"`
	ChannelModelKey            string `json:"channelModelKey,omitempty"`
	Size                       string `json:"size"`
	ImageResolution            string `json:"imageResolution,omitempty"`
	ImageParameters            string `json:"imageParameters,omitempty"`
	Quality                    string `json:"quality"`
	DurationSeconds            *int   `json:"durationSeconds,omitempty"`
	VideoGenerateAudio         *bool  `json:"videoGenerateAudio,omitempty"`
	VideoWatermark             *bool  `json:"videoWatermark,omitempty"`
	VideoArkPrivateAssetUpload *bool  `json:"videoArkPrivateAssetUpload,omitempty"`
}

// updateCloudAgentMediaApproval rebuilds the complete prepared admission for an
// edited approval. It is called inside MutateCloudAgent so the new prepared
// hash, resource lease set and runtime checkpoint commit atomically.
func (s *Service) updateCloudAgentMediaApproval(repo *repository.Repository, run *model.CloudAgentExecution, state *cloudAgentRuntime, settings CloudAgentMediaSettings) error {
	if state == nil || state.Approval == nil {
		return creationConflict("审批不存在或已过期")
	}
	call := state.Approval.Call
	if call.Function.Name != "generate_media" {
		return BadAuthRequest("当前审批不是媒体生成，不能修改生成参数")
	}
	var args cloudAgentMediaArgs
	if err := decodeCloudAgentJSONObject(call.Function.Arguments, &args); err != nil {
		return err
	}
	if args.Mode != "image" && args.Mode != "video" {
		return BadAuthRequest("仅图片或视频生成审批支持修改模型和规格")
	}
	args.LogicalModelID, args.ChannelID, args.ChannelModelKey = settings.LogicalModelID, settings.ChannelID, settings.ChannelModelKey
	// These settings now come directly from the user, not the Agent's proposal.
	args.ConfigurationChange = nil
	args.Size, args.ImageResolution, args.Quality = settings.Size, settings.ImageResolution, settings.Quality
	args.ImageParameters = settings.ImageParameters
	if args.Mode == "video" {
		if settings.DurationSeconds != nil {
			if *settings.DurationSeconds < 0 {
				return BadAuthRequest("视频时长不能为负数")
			}
			args.Duration = *settings.DurationSeconds
		}
		args.VideoGenerateAudio = settings.VideoGenerateAudio
		args.VideoWatermark = settings.VideoWatermark
		args.VideoArkPrivateAssetUpload = settings.VideoArkPrivateAssetUpload
	}
	if args.Mode == "image" && (settings.DurationSeconds != nil || settings.VideoGenerateAudio != nil || settings.VideoWatermark != nil || settings.VideoArkPrivateAssetUpload != nil) {
		return BadAuthRequest("视频参数仅适用于视频生成审批")
	}
	raw, err := json.Marshal(args)
	if err != nil {
		return err
	}
	call.Function.Arguments = string(raw)
	req, plan, err := s.prepareCloudAgentMedia(run, state, call)
	if err != nil {
		return err
	}
	// Dry admission uses the same model, ownership and option checks as task
	// submission, without reserving credits or creating a generation task.
	// DecideCloudAgentApproval already holds storageMu for this mutation.
	preparation := &creationTaskPreparation{}
	req.creationPrepare = preparation
	req.callerHoldsStorageMu = true
	task, err := s.CreateTask(run.UserID, req)
	if err != nil {
		return err
	}
	// 常规任务准入负责能力默认值解析：模型目录可能把用户在审批卡里选的画幅/质量归一化成
	// 它真正支持的规格（自动执行路径同样依赖 applyCloudAgentResolvedMediaDefaults）。
	// 这里沿用解析后的契约，并把它回写到请求和 plan，使审批预览、报价和真正提交的任务
	// 共用同一套规格。旧实现在这里直接判「解析后的规格与审批参数不同」并拒绝，用户只要在
	// 审批卡里改过参数，每次点「同意执行」都会被驳回，审批卡片也就一直关不掉。
	logCloudAgentResolvedMediaNormalization(run.ID, req.Input["config"], task.InputJSON)
	if err := s.applyCloudAgentResolvedMediaDefaults(&req, plan, task); err != nil {
		return err
	}
	if err := validateCloudAgentMediaBudget(plan.Args, state); err != nil {
		return err
	}
	args = plan.Args
	raw, err = json.Marshal(args)
	if err != nil {
		return err
	}
	call.Function.Arguments = string(raw)
	name, err := s.cloudAgentMediaModelName(args)
	if err != nil {
		return err
	}
	canvas, err := repo.CanvasProjectForUser(run.UserID, state.Request.CanvasID)
	if err != nil {
		return err
	}
	doc, err := creationDocument(canvas.PayloadJSON)
	if err != nil {
		return err
	}
	prepared, err := prepareCloudAgentMediaApproval(repo, run.UserID, doc, plan, req, task, preparation.Order)
	if err != nil {
		return err
	}
	// Editing an approval changes the prepared inputs and quote, but it is still
	// the same user-approved generation intent until the user submits a new
	// generation from the canvas.
	if previous := state.Approval.Prepared; previous != nil && previous.GenerationID != "" {
		prepared.GenerationID = previous.GenerationID
		prepared.Hash = creationHash(prepared)
	}
	if err := replaceCloudAgentPreparedLeases(repo, run.UserID, run.ID, state.Approval.ID, prepared); err != nil {
		return err
	}
	state.Calls[state.CallIndex] = call
	state.Approval.Call = call
	state.Approval.CallHash = cloudAgentApprovalCallHash(call)
	state.Approval.ModelName = name
	state.Approval.Preview = cloudAgentMediaApprovalPreview(plan, name)
	state.Approval.Prepared = prepared
	return nil
}

func replaceCloudAgentPreparedLeases(repo *repository.Repository, userID, runID, approvalID string, prepared *cloudAgentPreparedMedia) error {
	ids := make([]string, 0, len(prepared.ResourceSignatures))
	for id := range prepared.ResourceSignatures {
		ids = append(ids, id)
	}
	return repo.ReplaceCloudAgentResourceLeases(userID, runID, approvalID, ids, prepared.Quote.ExpiresAt)
}

// cloudAgentResolvedMediaOptionKeys 是任务准入会按模型能力重新解析的生成规格键。
// 审批期与执行期的归一化都必须按这组键记录差异。
var cloudAgentResolvedMediaOptionKeys = []string{"size", "imageResolution", "videoSeconds", "vquality", "quality", "count", "videoGenerateAudio", "videoWatermark", "videoArkPrivateAssetUpload"}

// logCloudAgentResolvedMediaNormalization 记录审批改参后被模型目录归一化的规格差异。
// 归一化不再导致审批提交失败，差异必须留在日志里可追溯。上游 v1.6.8 起权威规格
// 写在 capabilityOptions（config 保留同名字段），两处都读，避免漏记或被旧值误导。
func logCloudAgentResolvedMediaNormalization(runID string, requested any, taskInputJSON string) {
	var resolved struct {
		CapabilityOptions map[string]any `json:"capabilityOptions"`
		Config            map[string]any `json:"config"`
	}
	if err := json.Unmarshal([]byte(taskInputJSON), &resolved); err != nil {
		return
	}
	resolvedValue := func(key string) string {
		if value := stringValue(resolved.CapabilityOptions[key]); value != "" {
			return value
		}
		return stringValue(resolved.Config[key])
	}
	requestedConfig, _ := requested.(map[string]any)
	for _, key := range cloudAgentResolvedMediaOptionKeys {
		value := stringValue(requestedConfig[key])
		if value == "" || strings.EqualFold(value, resolvedValue(key)) {
			continue
		}
		log.Printf("cloud agent approval normalized media option: run=%s %s=%q resolved=%q", runID, key, value, resolvedValue(key))
	}
}

// cloudAgentImageSizeAliasSpec 取回审批所指向模型的图片尺寸契约，用于识别
// “同一预设的像素值 / 比例值”这两种等价写法。任务准入会把公开比例意图编码成
// 线路需要的像素值（或反向），审批校验不能把它们当成用户改了规格。
func (s *Service) cloudAgentImageSizeAliasSpec(args cloudAgentMediaArgs) *CapabilitySpec {
	if args.Mode != "image" {
		return nil
	}
	if args.ChannelID == "" || args.ChannelModelKey == "" {
		return nil
	}
	channelModel, err := s.repo.ChannelModelByKey(args.ChannelID, args.ChannelModelKey)
	if err != nil {
		return nil
	}
	config, err := normalizedChannelModelCapability(channelModel, s.protocolRegistry())
	if err != nil || config == nil || config.Image == nil {
		return nil
	}
	spec, err := CapabilitySpecFromModelCapabilityConfig(config, channelModel.Capability)
	if err != nil {
		return nil
	}
	return &spec
}

func validateCloudAgentResolvedMediaOptions(requested, resolvedInput map[string]any, sizeSpec *CapabilitySpec) error {
	resolvedOptions, _ := resolvedInput["capabilityOptions"].(map[string]any)
	resolvedConfig, _ := resolvedInput["config"].(map[string]any)
	if raw := requested["imageParameters"]; raw != nil {
		var values map[string]any
		if encoded, ok := raw.(string); ok {
			if err := json.Unmarshal([]byte(encoded), &values); err != nil {
				return creationConflict("图片参数格式无效")
			}
		} else {
			values, _ = raw.(map[string]any)
		}
		for name, value := range values {
			if resolvedOptions[name] != value {
				return creationConflict("模型解析后的图片参数与审批内容不同")
			}
		}
	}
	for _, key := range []string{"size", "imageResolution", "videoSeconds", "vquality", "quality", "count", "videoGenerateAudio", "videoWatermark", "videoArkPrivateAssetUpload"} {
		requestedValue := stringValue(requested[key])
		resolvedValue := stringValue(resolvedOptions[key])
		if resolvedValue == "" {
			resolvedValue = stringValue(resolvedConfig[key])
		}
		if stringValue(resolvedInput["mode"]) == "image" && (key == "quality" || key == "imageResolution") && inactiveCapabilityOptionValue(key, requestedValue) {
			continue
		}
		// 图片目录保留比例，任务配置保存按预设换算的像素；审批可以提交任一种表达。
		if key == "size" && stringValue(resolvedInput["mode"]) == "image" && requestedValue != "" && strings.EqualFold(requestedValue, stringValue(resolvedConfig[key])) {
			continue
		}
		// 上面的直接比较只覆盖 config 原样保留的情况。任务准入还会把比例意图编码成
		// 预设像素（例如 16:9 → 2752x1536）并写回 capabilityOptions，此时两个字符串
		// 必然不同，但仍是同一条已声明预设，不应判成审批内容被篡改。
		if key == "size" && sizeSpec != nil && sizeSpec.ImageSize != nil && requestedValue != "" && resolvedValue != "" {
			requestedOptions := map[string]any{"imageResolution": stringValue(resolvedOptions["imageResolution"])}
			if capabilityImageSizePresetMatches(*sizeSpec, requestedValue, requestedOptions) &&
				capabilityImageSizePresetMatches(*sizeSpec, resolvedValue, requestedOptions) &&
				imageSizePresetsEquivalent(sizeSpec.ImageSize.Presets, requestedValue, resolvedValue) {
				continue
			}
		}
		if key == "quality" && requestedValue != "" {
			if _, declared := resolvedOptions[key]; !declared && !strings.EqualFold(requestedValue, stringValue(resolvedOptions["imageResolution"])) {
				return creationConflict("所选图片模型未声明质量参数，请使用模型声明的图片分辨率或质量选项")
			}
		}
		if requestedValue != "" && !strings.EqualFold(requestedValue, resolvedValue) {
			return creationConflict("模型解析后的生成规格与审批参数不同，请重新读取目录并审批")
		}
	}
	return nil
}

// imageSizePresetsEquivalent 判断两种图片尺寸写法是否指向同一条已声明预设。
func imageSizePresetsEquivalent(presets []ImageSizePreset, left, right string) bool {
	leftPreset, leftOK := declaredImageSizePreset(presets, left, "", "")
	rightPreset, rightOK := declaredImageSizePreset(presets, right, "", "")
	if !leftOK || !rightOK {
		return strings.EqualFold(strings.TrimSpace(left), strings.TrimSpace(right))
	}
	return strings.EqualFold(strings.TrimSpace(leftPreset.Ratio), strings.TrimSpace(rightPreset.Ratio)) &&
		strings.EqualFold(strings.TrimSpace(leftPreset.Size), strings.TrimSpace(rightPreset.Size))
}
