package protocol

import (
	"context"
	"encoding/json"
	"testing"
)

func TestOfficialHongniaoVideoCreateBody(t *testing.T) {
	adapter := officialPackageAdapter(t, "hongniao-videos.yingce-plugin", "hongniao-videos")
	request := GenerationRequest{
		Model:       "wan3-720p",
		Prompt:      "一只猫在海边奔跑",
		Duration:    4,
		AspectRatio: "16:9",
		Images:      []MediaReference{{URL: "https://cdn.example/first.png", Role: "reference_image", Order: 1}, {URL: "https://cdn.example/second.png", Role: "reference_image", Order: 2}},
		Videos:      []MediaReference{{URL: "https://cdn.example/motion.mp4", Role: "reference_video"}},
		Audios:      []MediaReference{{URL: "https://cdn.example/voice.mp3", Role: "reference_audio"}},
	}
	create, err := adapter.BuildCreate(context.Background(), RequestContext{Request: request})
	if err != nil {
		t.Fatal(err)
	}
	if create.Method != "POST" || create.Path != "/v1/videos" || create.ContentType != "application/json" {
		t.Fatalf("hongniao create = %#v", create)
	}
	body := manifestTestBody(t, create)
	if body["model"] != request.Model || body["prompt"] != request.Prompt {
		t.Fatalf("hongniao create body = %#v", body)
	}
	if body["aspect_ratio"] != "16:9" {
		t.Fatalf("aspect_ratio = %#v", body["aspect_ratio"])
	}
	// 红鸟公开请求示例里 seconds 是字符串；缺省时长固定提交 15。
	if body["seconds"] != "4" {
		t.Fatalf("seconds = %#v, want string \"4\"", body["seconds"])
	}
	for field, want := range map[string]int{"images": 2, "videos": 1, "audios": 1} {
		values, _ := body[field].([]any)
		if len(values) != want {
			t.Fatalf("%s = %#v, want %d entries", field, body[field], want)
		}
		for _, value := range values {
			if _, ok := value.(string); !ok {
				t.Fatalf("%s entries must be plain URL strings, got %#v", field, body[field])
			}
		}
	}
	if _, hasResolution := body["resolution"]; hasResolution {
		t.Fatalf("hongniao body must not send resolution: %#v", body)
	}

	defaulted, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{Model: "wan3-720p", Prompt: "默认时长"}})
	if err != nil {
		t.Fatal(err)
	}
	defaultBody := manifestTestBody(t, defaulted)
	if defaultBody["seconds"] != "15" || defaultBody["aspect_ratio"] != "9:16" {
		t.Fatalf("default create body = %#v", defaultBody)
	}
	if _, hasImages := defaultBody["images"]; hasImages {
		t.Fatalf("empty references must be omitted: %#v", defaultBody)
	}
}

func TestOfficialHongniaoVideoLifecycle(t *testing.T) {
	adapter := officialPackageAdapter(t, "hongniao-videos.yingce-plugin", "hongniao-videos")
	created, err := adapter.ParseCreate(context.Background(), []byte(`{"id":"video-1","status":"queued"}`))
	if err != nil || created.TaskID != "video-1" || created.Status != StatusPending {
		t.Fatalf("create result = %#v, err=%v", created, err)
	}
	poll, err := adapter.BuildPoll(context.Background(), PollContext{TaskID: "video-1"})
	if err != nil || poll.Path != "/v1/videos/video-1" {
		t.Fatalf("poll spec = %#v, err=%v", poll, err)
	}
	const directURL = "https://cdn.example.com/generated.mp4?signature=test"
	payload := map[string]any{"id": "video-1", "status": "completed", "metadata": map[string]any{"url": "/v1/videos/video-1/content", "direct_url": directURL}}
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	polled, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: "video-1"}, body)
	if err != nil {
		t.Fatal(err)
	}
	if polled.Status != StatusSucceeded || polled.TaskID != "video-1" {
		t.Fatalf("poll result = %#v", polled)
	}
	if polled.Result == nil || len(polled.Result.Videos) != 1 || polled.Result.Videos[0].URL != directURL {
		t.Fatalf("expected direct download URL, got %#v", polled.Result)
	}
	failed, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: "video-1"}, []byte(`{"id":"video-1","status":"failed","message":"生成失败"}`))
	if err != nil || failed.Status != StatusFailed || failed.Message != "生成失败" {
		t.Fatalf("failed poll = %#v, err=%v", failed, err)
	}
}
