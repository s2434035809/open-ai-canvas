package app

import (
	"net/http"
	"strings"
	"testing"
)

func TestProviderFailureDetailsReadsTopLevelModerationError(t *testing.T) {
	code, message := providerFailureDetails(map[string]any{
		"code":    contentModerationErrorCode,
		"message": "prompt rejected",
	})
	if code != contentModerationErrorCode {
		t.Fatalf("unexpected code: %q", code)
	}
	if message != "prompt rejected" {
		t.Fatalf("unexpected message: %q", message)
	}
}

func TestProviderFailureDetailsReadsNestedError(t *testing.T) {
	code, message := providerFailureDetails(map[string]any{
		"error": map[string]any{"code": "invalid_request", "message": "invalid size"},
	})
	if code != "invalid_request" || message != "invalid size" {
		t.Fatalf("unexpected failure details: code=%q message=%q", code, message)
	}
}

func TestProviderFailureDetailsPrefersNestedBusinessCode(t *testing.T) {
	code, message := providerFailureDetails(map[string]any{
		"code": float64(400),
		"data": map[string]any{"code": contentModerationErrorCode, "message": "prompt rejected"},
	})
	if code != contentModerationErrorCode || message != "prompt rejected" {
		t.Fatalf("unexpected wrapped failure details: code=%q message=%q", code, message)
	}
}

func TestContentModerationFailureRequiresExactProviderCode(t *testing.T) {
	if !isContentModerationFailure(`{"code":"sensitive_words_detected"}`) {
		t.Fatal("expected moderation error to be detected")
	}
	if isContentModerationFailure("上游 HTTP 400") {
		t.Fatal("generic HTTP 400 must remain retryable")
	}
}

func TestProviderPayloadBusinessFailureRecognizesStringErrorCode(t *testing.T) {
	code, message, failed := providerPayloadBusinessFailure(map[string]any{
		"code": "RequestParameterIsWrong",
		"data": nil,
		"msg":  "参数: prompt 的长度: 23142 大于最大长度 10000",
	})
	if !failed || code != "RequestParameterIsWrong" || message != "参数: prompt 的长度: 23142 大于最大长度 10000" {
		t.Fatalf("business failure = (%q, %q, %v)", code, message, failed)
	}
}

func TestProviderPayloadBusinessFailureAcceptsStringSuccessCode(t *testing.T) {
	if code, message, failed := providerPayloadBusinessFailure(map[string]any{"code": "Success", "data": map[string]any{"task_id": "task-1"}}); failed {
		t.Fatalf("success payload was marked failed: (%q, %q)", code, message)
	}
}

func TestProviderPayloadBusinessFailureReadsNestedOutputFailure(t *testing.T) {
	code, message, failed := providerPayloadBusinessFailure(map[string]any{
		"output": map[string]any{
			"code":        "InvalidParameter",
			"message":     "Input should be '1080P', '720P' or '480P': parameters.resolution",
			"task_id":     "e0d8c86d-4939-4f2e-93f7-e2cd10a07d58",
			"task_status": "FAILED",
		},
		"request_id": "c3c98e67-830d-9f1d-8a62-fff019ffa522",
	})
	if !failed || code != "InvalidParameter" {
		t.Fatalf("nested output failure = (%q, %q, %v)", code, message, failed)
	}
	if !strings.Contains(message, "parameters.resolution") {
		t.Fatalf("unexpected message: %q", message)
	}
}

func TestProviderResponseBusinessFailureExplainsDoubaoSpeechDenial(t *testing.T) {
	body := []byte(`{"code":0,"data":"AAAA"}{"header":{"code":45000030,"message":"[resource_id=volc.seedtts.default] requested resource not granted"}}`)
	code, message, failed := providerResponseBusinessFailure(body)
	if !failed || !strings.Contains(message, "requested resource not granted") {
		t.Fatalf("business failure = (%q, %q, %v)", code, message, failed)
	}
	if code != "45000030" && code != "4.500003e+07" {
		t.Fatalf("unexpected code %q", code)
	}
}

func TestProviderPayloadBusinessFailureIgnoresOrdinaryHeader(t *testing.T) {
	if _, _, failed := providerPayloadBusinessFailure(map[string]any{
		"header": map[string]any{"code": float64(200), "message": "ok"},
		"data":   map[string]any{"audio": "AAAA"},
	}); failed {
		t.Fatal("ordinary header code was treated as a business failure")
	}
}

func TestProviderPayloadBusinessFailureIgnoresPendingOutput(t *testing.T) {
	if code, message, failed := providerPayloadBusinessFailure(map[string]any{
		"output":     map[string]any{"task_id": "task-1", "task_status": "PENDING"},
		"request_id": "req-1",
	}); failed {
		t.Fatalf("pending output marked failed: (%q, %q)", code, message)
	}
}

func TestProviderHTTPErrorReportsQuotaInsteadOfAuth(t *testing.T) {
	const want = "模型服务额度不足，请检查渠道余额或配额"
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusTooManyRequests} {
		err := providerHTTPError{StatusCode: status, Body: `{"error":{"code":"insufficient_user_quota","message":"用户额度不足, 剩余额度: ¥-0.07"}}`}
		if got := err.Error(); got != want {
			t.Fatalf("status %d: got %q, want %q", status, got, want)
		}
	}
	// 真·鉴权失败不能被误报成余额问题。
	err := providerHTTPError{StatusCode: http.StatusUnauthorized, Body: `{"error":{"message":"Invalid API key provided","code":"invalid_api_key"}}`}
	if got := err.Error(); got != "模型服务鉴权失败，请检查 API Key 和模型权限" {
		t.Fatalf("invalid key: got %q", got)
	}
	// DeepSeek 的工具消息协议错误必须保持原类目，不能落进额度提示。
	err = providerHTTPError{StatusCode: http.StatusBadRequest, Body: `{"error":{"message":"An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. (insufficient tool messages following tool_calls message)"}}`}
	if got := err.Error(); !strings.Contains(got, "工具调用与结果不匹配") {
		t.Fatalf("tool protocol error: got %q", got)
	}
}
