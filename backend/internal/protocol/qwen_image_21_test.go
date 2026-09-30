package protocol

import (
	"context"
	"testing"
)

func TestQwenImage21RequestMappingAndDimensions(t *testing.T) {
	adapter := officialPackageAdapter(t, "qwen-image-2-1.yingce-plugin", "qwen-image-2-1")
	create, err := adapter.BuildCreate(context.Background(), RequestContext{
		Request: GenerationRequest{
			Model:       "qwen_image_2.1",
			Prompt:      "透明背景小龙贴纸",
			AspectRatio: "16:9",
			ImageCount:  1,
			Extra: map[string]any{
				"transparentBackground": "true",
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if create.Method != "POST" || create.Path != "/v1/images/generations" {
		t.Fatalf("create = %#v", create)
	}
	if !create.OriginPath {
		t.Fatal("create 必须声明 originPath")
	}

	body := manifestTestBody(t, create)
	if body["model"] != "qwen_image_2.1" {
		t.Fatalf("model = %#v", body["model"])
	}
	if body["prompt"] != "透明背景小龙贴纸" {
		t.Fatalf("prompt = %#v", body["prompt"])
	}
	// 16:9 应根据推荐尺寸换算为 1360x768（16 的倍数）
	if body["size"] != "1360x768" {
		t.Fatalf("size = %#v, 期望 1360x768", body["size"])
	}
	// 透明背景
	if body["background"] != "transparent" {
		t.Fatalf("background = %#v, 期望 transparent", body["background"])
	}
	if body["output_format"] != "png" {
		t.Fatalf("output_format = %#v, 期望 png", body["output_format"])
	}
}

func TestQwenImage21ReferencesMapping(t *testing.T) {
	adapter := officialPackageAdapter(t, "qwen-image-2-1.yingce-plugin", "qwen-image-2-1")
	create, err := adapter.BuildCreate(context.Background(), RequestContext{
		Request: GenerationRequest{
			Model:       "qwen_image_2.1",
			Prompt:      "替换背景",
			AspectRatio: "1:1",
			ImageCount:  1,
			Images: []MediaReference{
				{DataURL: "data:image/png;base64,QUJD", Order: 2},
				{URL: "http://47.111.83.139:13527/v1/files/up_1.png", Order: 1},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	body := manifestTestBody(t, create)
	refImages, _ := body["ref_images"].([]any)
	if len(refImages) != 2 {
		t.Fatalf("ref_images = %#v, 期望 2 张图", refImages)
	}
	if refImages[0] != "http://47.111.83.139:13527/v1/files/up_1.png" {
		t.Fatalf("第一张图 = %#v", refImages[0])
	}
	if refImages[1] != "data:image/png;base64,QUJD" {
		t.Fatalf("第二张图 = %#v", refImages[1])
	}
	if body["size"] != "1024x1024" {
		t.Fatalf("size = %#v", body["size"])
	}
}

func TestQwenImage21SyncResponse(t *testing.T) {
	adapter := officialPackageAdapter(t, "qwen-image-2-1.yingce-plugin", "qwen-image-2-1")
	syncBody := []byte(`{
		"created": 1789959716,
		"data": [
			{ "url": "http://47.111.83.139:13527/images/qwen21/img_1.png", "width": 1024, "height": 1024 }
		],
		"task_id": "img_1101560001",
		"status": "completed",
		"elapsed_seconds": 80.2
	}`)
	created, err := adapter.ParseCreate(context.Background(), syncBody)
	if err != nil {
		t.Fatal(err)
	}
	if created.Status != StatusSucceeded {
		t.Fatalf("status = %q, want %q", created.Status, StatusSucceeded)
	}
	if created.Result == nil || len(created.Result.Images) != 1 {
		t.Fatalf("result = %#v", created.Result)
	}
	if created.Result.Images[0].URL != "http://47.111.83.139:13527/images/qwen21/img_1.png" {
		t.Fatalf("image URL = %q", created.Result.Images[0].URL)
	}
	if created.TaskID != "img_1101560001" {
		t.Fatalf("task_id = %q", created.TaskID)
	}
}

func TestQwenImage21AsyncLifecycle(t *testing.T) {
	adapter := officialPackageAdapter(t, "qwen-image-2-1.yingce-plugin", "qwen-image-2-1")
	asyncBody := []byte(`{
		"id": "task-async-1",
		"status": "pending"
	}`)
	created, err := adapter.ParseCreate(context.Background(), asyncBody)
	if err != nil {
		t.Fatal(err)
	}
	if created.Status != StatusPending {
		t.Fatalf("status = %q, want %q", created.Status, StatusPending)
	}
	if created.TaskID != "task-async-1" {
		t.Fatalf("task_id = %q", created.TaskID)
	}

	poll, err := adapter.BuildPoll(context.Background(), PollContext{TaskID: created.TaskID})
	if err != nil {
		t.Fatal(err)
	}
	if poll.Method != "GET" || poll.Path != "/v1/images/generations/task-async-1" {
		t.Fatalf("poll = %#v", poll)
	}
	if !poll.OriginPath {
		t.Fatal("poll 必须声明 originPath")
	}

	pollBody := []byte(`{
		"id": "task-async-1",
		"status": "completed",
		"data": [
			{ "url": "http://47.111.83.139:13527/images/qwen21/img_async.png" }
		]
	}`)
	polled, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: created.TaskID}, pollBody)
	if err != nil {
		t.Fatal(err)
	}
	if polled.Status != StatusSucceeded {
		t.Fatalf("poll status = %q, want %q", polled.Status, StatusSucceeded)
	}
	if len(polled.Result.Images) != 1 || polled.Result.Images[0].URL != "http://47.111.83.139:13527/images/qwen21/img_async.png" {
		t.Fatalf("poll result = %#v", polled.Result)
	}
}

func TestQwenImage21ValidationRejectsMultipleOutputs(t *testing.T) {
	adapter := officialPackageAdapter(t, "qwen-image-2-1.yingce-plugin", "qwen-image-2-1")
	_, err := adapter.BuildCreate(context.Background(), RequestContext{
		Request: GenerationRequest{
			Model:      "qwen_image_2.1",
			Prompt:     "test",
			ImageCount: 2,
		},
	})
	if err == nil {
		t.Fatal("imageCount > 1 必须报错")
	}
}
