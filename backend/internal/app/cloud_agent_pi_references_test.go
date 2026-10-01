package app

import (
	"go/ast"
	"go/parser"
	"go/token"
	"strings"
	"testing"
)

// Pi 运行时的模型步骤（runCloudAgentModelStep）重建出来的 canonical 里，图片仍然是
// `resource:<id>` 占位符——它由 portfolio_inspect_image / canvas_inspect_image 产生，
// 经运行时消息原样回传。占位符只有先登记进参考图白名单，下游 hydrate 才会把它换成真实
// 图片数据；漏登记时整轮会以「模型协议引用了未获准的图片」失败（用户侧表现为"Agent 跑不通"，
// 而所有既有用例依旧全绿）。
//
// 本文件锁住这条链路：行为用例复现失败形态与修复形态，AST 守卫锁住调用点本身。
func TestCloudAgentResourcePlaceholdersNeedReferenceWhitelist(t *testing.T) {
	s, _, _ := cloudAgentVisionFixture(t)
	state := cloudAgentRuntime{Request: agentTestRequest()}
	state.Request.VisionEnabled = true

	newCanonical := func() *canonicalAgentRequest {
		return &canonicalAgentRequest{
			ToolChoice: "auto",
			Messages: []map[string]any{{
				"role": "user",
				"content": []any{
					map[string]any{"type": "text", "text": "看看这张图"},
					map[string]any{"type": "image_url", "image_url": map[string]any{"url": "resource:ref-one"}},
				},
			}},
		}
	}

	// 1. 不登记白名单：占位符无处解析，必须报错。这条就是修复前的现场。
	broken := canvasGenerationInput{Mode: "text", AgentRequests: &agentToolRequests{Canonical: newCanonical()}}
	if _, err := resolveAgentResourcePlaceholders(broken, true); err == nil {
		t.Fatal("缺少参考图白名单时，resource: 占位符应当被拒绝")
	} else if !strings.Contains(err.Error(), "未获准") {
		t.Fatalf("错误应当指向未获准的图片，实际：%v", err)
	}

	// 2. 登记白名单后：占位符被替换成可读取的图片数据，请求可以发出。
	canonical := newCanonical()
	refs, err := s.cloudAgentImageReferences("user", state.Request, canonical)
	if err != nil {
		t.Fatalf("登记参考图白名单失败：%v", err)
	}
	if len(refs) != 1 || refs[0].StorageKey != "resource:ref-one" {
		t.Fatalf("参考图白名单应当原样保留占位符，实际 %#v", refs)
	}
	// 白名单只影响本次请求，不能把 canonical 里的占位符改成内嵌数据：一旦写回运行状态，
	// 每一步都会把图片字节塞进上下文，既顶爆状态又绕开数量上限。
	if got := canonicalMessageImageURL(t, *canonical, 0); got != "resource:ref-one" {
		t.Fatalf("canonical 图片引用应保持占位符，实际 %q", got)
	}

	input := canvasGenerationInput{Mode: "text", ReferenceImages: refs, AgentRequests: &agentToolRequests{Canonical: canonical}}
	if err := s.hydrateGenerationMedia("user", &input, providerMediaHydrationPolicy{}); err != nil {
		t.Fatalf("读取参考图失败：%v", err)
	}
	resolved, err := resolveAgentResourcePlaceholders(input, true)
	if err != nil {
		t.Fatalf("登记白名单后请求应当通过：%v", err)
	}
	got := canonicalMessageImageURL(t, *resolved.AgentRequests.Canonical, 0)
	if !strings.HasPrefix(got, "data:image/") {
		t.Fatalf("占位符应被替换为图片数据 URL，实际 %q", got)
	}
}

// canonicalMessageImageURL 取出第 index 条消息里第一个图片部件的 url。
func canonicalMessageImageURL(t *testing.T, canonical canonicalAgentRequest, index int) string {
	t.Helper()
	if index >= len(canonical.Messages) {
		t.Fatalf("消息不足：%d", len(canonical.Messages))
	}
	parts, _ := canonical.Messages[index]["content"].([]any)
	for _, value := range parts {
		part, _ := value.(map[string]any)
		image, _ := part["image_url"].(map[string]any)
		if url := stringField(image, "url"); url != "" {
			return url
		}
	}
	t.Fatalf("第 %d 条消息里找不到图片部件", index)
	return ""
}

// AST 守卫：轮内每步的模型上下文准备必须登记参考图白名单。
//
// playbook 里"canonical 里的 resource: 占位符要有白名单"这条约束没有类型系统兜底，
// 漏掉只会让真实运行失败，因此这里直接读源码断言调用点还在。
// 上游把 Pi 运行时拆到 cloud_agent_pi_model.go 后，登记点统一挪到了 advanceCloudAgent
// （cloud_agent_runtime_scheduler.go）的建模步骤，守卫跟着挪。
func TestCloudAgentModelStepRegistersImageReferences(t *testing.T) {
	file, err := parser.ParseFile(token.NewFileSet(), "cloud_agent_runtime_scheduler.go", nil, 0)
	if err != nil {
		t.Fatalf("解析 cloud_agent_runtime_scheduler.go 失败：%v", err)
	}
	var body *ast.BlockStmt
	ast.Inspect(file, func(node ast.Node) bool {
		decl, ok := node.(*ast.FuncDecl)
		if !ok || decl.Name.Name != "advanceCloudAgent" || decl.Body == nil {
			return true
		}
		body = decl.Body
		return false
	})
	if body == nil {
		t.Fatal("找不到 advanceCloudAgent：实现被重命名或搬走了，守卫需要同步更新")
	}

	called, wired := false, false
	ast.Inspect(body, func(node ast.Node) bool {
		switch typed := node.(type) {
		case *ast.CallExpr:
			if selector, ok := typed.Fun.(*ast.SelectorExpr); ok && selector.Sel.Name == "cloudAgentImageReferences" {
				called = true
			}
		case *ast.BasicLit:
			if typed.Kind == token.STRING && strings.Trim(typed.Value, `"`) == "referenceImages" {
				wired = true
			}
		}
		return true
	})
	if !called {
		t.Fatal("advanceCloudAgent 没有调用 cloudAgentImageReferences：模型步骤会丢掉参考图白名单")
	}
	if !wired {
		t.Fatal("advanceCloudAgent 没有把参考图写进 input 的 referenceImages：白名单等于没登记")
	}
}
