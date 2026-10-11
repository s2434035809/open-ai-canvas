package app

import (
	"testing"

	"yingce/backend/internal/model"
)

// 红鸟 wan3-720p 的真实形态：视频能力未声明分辨率选项（resolutions 为空），
// 价格档使用通配分辨率。目录发布不能因为代码注入的默认值而把整个模型隔离。
const hongniaoWan3CapabilityJSON = `{"version":1,"video":{"references":{"promptMaxChars":1000,"minImages":0,"maxImages":9,"maxImageBytes":0,"maxVideos":0,"maxVideoBytes":0,"maxVideoDurationSeconds":0,"maxAudios":0,"maxAudioBytes":0,"maxAudioDurationSeconds":0},"duration":{"selection":"range","min":4,"max":30,"step":1,"default":4},"ratios":["16:9","9:16"],"defaultRatio":"16:9","resolutions":[],"defaultResolution":"","generateAudio":{"supported":false,"default":false},"watermark":{"supported":false,"default":false},"operations":["text_to_video","image_to_video"],"defaultOperation":"text_to_video"}}`

// 同一协议下声明了分辨率选项的形态，用于确认默认分辨率仍会被发布。
const hongniaoResolutionCapabilityJSON = `{"version":1,"video":{"references":{"promptMaxChars":1000,"minImages":0,"maxImages":9},"duration":{"selection":"range","min":4,"max":30,"step":1,"default":4},"ratios":["16:9","9:16"],"defaultRatio":"16:9","resolutions":["720P","1080P"],"defaultResolution":"1080P","generateAudio":{"supported":false,"default":false},"watermark":{"supported":false,"default":false},"operations":["text_to_video"],"defaultOperation":"text_to_video"}}`

func wantVideoPerSecondTier(resolution string) model.ChannelModelPriceTier {
	return model.ChannelModelPriceTier{
		ID:                    "TIER_TEST",
		ChannelModelID:        "HN_TEST",
		Resolution:            resolution,
		BillingMode:           "per_second",
		UnitPriceMicrocredits: 130000,
		PriceConfigured:       true,
		Enabled:               true,
	}
}

func TestSanitizeChannelModelPublishesVideoModelWithoutResolutionOptions(t *testing.T) {
	cm := model.ChannelModel{
		ID:                   "HN_TEST",
		ModelKey:             "wan3-720p",
		Capability:           "video",
		Protocol:             "hongniao-videos",
		Enabled:              true,
		CapabilityConfigJSON: hongniaoWan3CapabilityJSON,
		PriceTiers:           []model.ChannelModelPriceTier{wantVideoPerSecondTier("*")},
	}

	service := &Service{}
	publicModel, err := service.sanitizeChannelModel(&cm)
	if err != nil {
		t.Fatalf("未声明分辨率的视频模型应可发布，实际报错：%v", err)
	}
	if !publicModel.Available {
		t.Fatal("存在有效价格档时 Available 应为 true")
	}
	if len(publicModel.PriceTiers) != 1 {
		t.Fatalf("公开价格档数量 = %d，期望 1", len(publicModel.PriceTiers))
	}
	if value, exists := publicModel.DefaultOptions["vquality"]; exists {
		t.Fatalf("未声明分辨率的模型不应注入 vquality 默认值，实际为 %v", value)
	}
	if publicModel.DefaultOptions["videoSeconds"] != 4 {
		t.Fatalf("默认时长 = %v，期望 4", publicModel.DefaultOptions["videoSeconds"])
	}
	if publicModel.DefaultOptions["size"] != "16:9" {
		t.Fatalf("默认比例 = %v，期望 16:9", publicModel.DefaultOptions["size"])
	}
}

func TestSanitizeChannelModelKeepsDefaultResolutionWhenDeclared(t *testing.T) {
	cm := model.ChannelModel{
		ID:                   "HN_TEST",
		ModelKey:             "video-sd25-720p",
		Capability:           "video",
		Protocol:             "hongniao-videos",
		Enabled:              true,
		CapabilityConfigJSON: hongniaoResolutionCapabilityJSON,
		PriceTiers:           []model.ChannelModelPriceTier{wantVideoPerSecondTier("1080p")},
	}

	service := &Service{}
	publicModel, err := service.sanitizeChannelModel(&cm)
	if err != nil {
		t.Fatalf("声明了分辨率的视频模型应可发布，实际报错：%v", err)
	}
	if publicModel.DefaultOptions["vquality"] != "1080p" {
		t.Fatalf("默认分辨率 = %v，期望 1080p", publicModel.DefaultOptions["vquality"])
	}
}

// 发布只是第一步：默认值还必须能直接在路由与价格档上命中，否则模型可见却不可用。
func TestSanitizeChannelModelDefaultsRouteForVideoWithoutResolutionOptions(t *testing.T) {
	cm := model.ChannelModel{
		ID:                   "HN_TEST",
		ModelKey:             "wan3-720p",
		Capability:           "video",
		Protocol:             "hongniao-videos",
		Enabled:              true,
		CapabilityConfigJSON: hongniaoWan3CapabilityJSON,
		PriceTiers:           []model.ChannelModelPriceTier{wantVideoPerSecondTier("*")},
	}

	service := &Service{}
	publicModel, err := service.sanitizeChannelModel(&cm)
	if err != nil {
		t.Fatalf("目录发布失败：%v", err)
	}
	options := make(map[string]any, len(publicModel.DefaultOptions))
	for name, value := range publicModel.DefaultOptions {
		options[name] = value
	}

	spec, err := channelModelCapabilitySpec(cm)
	if err != nil {
		t.Fatalf("解析渠道模型能力失败：%v", err)
	}
	intent := ModelRequestIntent{Capability: "video", Operation: "text_to_video", Inputs: map[string]int{}, Options: options}
	if match := MatchCapability(spec, intent); !match.Matched {
		t.Fatalf("创作端默认参数应命中能力合同，实际拒绝原因：%v", match.Reasons)
	}
	if tier := channelModelPriceTierForIntent(cm, intent); tier == nil {
		t.Fatal("默认规格应命中一个可结算价格档")
	}
}
