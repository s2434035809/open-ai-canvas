package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	"yingce/backend/internal/model"
	"yingce/backend/internal/protocol"
)

// 上游（如 ddcat）会以内嵌 data URL 不是「有效 url」直接拒绝带参考图的请求，
// 因此 openai-image 必须优先把对象存储资源换成短期签名地址；本地资源仍走字节路径。
func TestOpenAIImagePrefersObjectStorageReferencesOverInlineBytes(t *testing.T) {
	service := newResourceTestService(t)
	settingJSON, _ := json.Marshal(ossSettingValue{
		Enabled: true, Provider: "s3", Region: "us-east-1", Endpoint: "https://8.8.8.8",
		Bucket: "references", AccessKeyID: "access-id", AccessKeySecret: "secret-value",
	})
	if err := service.repo.SaveSystemSetting(&model.SystemSetting{Key: ossSettingKey, ValueJSON: string(settingJSON)}); err != nil {
		t.Fatal(err)
	}
	resource := model.Resource{
		ID: "ref-object", UserID: "user", Kind: "image", Status: model.ResourceStatusReady,
		Provider: "s3", Endpoint: "https://8.8.8.8", Bucket: "references",
		ObjectKey: "users/user/image/reference.png", MimeType: "image/png", Size: 1024,
	}
	if err := service.repo.CreateResource(&resource); err != nil {
		t.Fatal(err)
	}
	input := canvasGenerationInput{
		Mode: "image", Prompt: "Keep the character consistent with @图片1",
		Config:          providerConfig{InterfaceType: string(model.ChannelInterfaceOpenAIImage), Model: "test-image"},
		ReferenceImages: []providerMedia{{ID: "character", StorageKey: "resource:ref-object"}},
	}
	policy := providerMediaHydrationPolicyFor(context.Background(), input)
	if policy.requireURL || !policy.preferURL {
		t.Fatalf("openai image policy = %#v", policy)
	}
	if err := service.hydrateGenerationMedia("user", &input, policy); err != nil {
		t.Fatal(err)
	}
	media := input.ReferenceImages[0]
	if !strings.HasPrefix(media.URL, "https://8.8.8.8/references/") || !strings.Contains(media.URL, "X-Amz-Signature=") || media.DataURL != "" {
		t.Fatalf("object storage reference was not handed to the provider as a signed URL: %#v", media)
	}
}

func TestOpenAIImageLocalReferencesWithoutPublicURL(t *testing.T) {
	service, _, imageBytes := cloudAgentVisionFixture(t)
	t.Setenv("CANVAS_PUBLIC_BASE_URL", "")
	input := canvasGenerationInput{
		Mode: "image", Prompt: "Keep the character consistent with @图片1",
		Config:          providerConfig{InterfaceType: string(model.ChannelInterfaceOpenAIImage), Model: "test-image"},
		ReferenceImages: []providerMedia{{ID: "character", StorageKey: "resource:ref-one"}},
	}
	ctx := ensureOfficialProtocolAdapter(context.Background(), input.Config.InterfaceType)
	policy := providerMediaHydrationPolicyFor(ctx, input)
	if policy.requireURL {
		t.Fatal("local OpenAI image references must not require a public URL")
	}
	if err := service.hydrateGenerationMedia("user", &input, policy); err != nil {
		t.Fatal(err)
	}
	want := "data:image/png;base64," + base64.StdEncoding.EncodeToString(imageBytes)
	if input.ReferenceImages[0].DataURL != want || input.ReferenceImages[0].URL != "" {
		t.Fatal("reference did not hydrate from the authorized local resource")
	}
	adapter, ok := declarativeProtocolAdapterForContext(ctx, input.Config.InterfaceType)
	if !ok {
		t.Fatal("OpenAI image adapter is missing")
	}
	request, err := adapter.BuildCreate(ctx, protocol.RequestContext{Request: protocolRequestFromInput(input)})
	if err != nil {
		t.Fatal(err)
	}
	images := creationMaps(request.Body.(map[string]any)["images"])
	if request.Path != "/v1/images/edits" || len(images) != 1 || images[0]["image_url"] != want {
		t.Fatal("image edit request did not retain inline image bytes")
	}
	foreign := canvasGenerationInput{ReferenceImages: []providerMedia{{StorageKey: "resource:ref-one"}}}
	if err := service.hydrateGenerationMedia("other-user", &foreign, policy); err == nil {
		t.Fatal("another user's reference resource was accepted")
	}
}
