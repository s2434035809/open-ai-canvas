package app

import (
	"encoding/json"
	"strings"
	"testing"

	"gorm.io/gorm"

	"infinite-canvas/backend/internal/model"
)

// 作品集 Agent 的工具契约与数据投影：壳画布 ID 解析、工具注册门控、
// 文档读投影、建议登记（不写文档）与看图资源校验。
func portfolioAgentFixture(t *testing.T) (*Service, *gorm.DB) {
	t.Helper()
	s, db, _, _ := creationTestService(t)
	document := map[string]any{
		"schemaVersion": 1,
		"title":         "我的第一本作品集",
		"description":   "示例文档",
		"coverUrl":      "",
		"pages": []map[string]any{
			{
				"id": "page-1", "name": "封面", "width": 1600.0, "height": 1000.0, "background": "#ffffff",
				"elements": []map[string]any{
					{"id": "img-1", "kind": "image", "assetId": "asset-1", "src": "", "caption": "", "tags": []string{}, "naturalWidth": 1200.0, "naturalHeight": 800.0},
					{"id": "img-2", "kind": "image", "assetId": "", "src": "https://example.invalid/two.png", "caption": "已有图注", "tags": []string{"人像"}, "naturalWidth": 900.0, "naturalHeight": 600.0},
					{"id": "text-1", "kind": "text", "text": "章节标题"},
				},
			},
			{
				"id": "page-2", "name": "作品", "width": 1600.0, "height": 1000.0, "background": "#ffffff",
				"elements": []map[string]any{
					{"id": "img-3", "kind": "image", "assetId": "asset-other", "src": "", "caption": "", "tags": []string{}, "naturalWidth": 800.0, "naturalHeight": 800.0},
				},
			},
		},
	}
	raw, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range []any{
		&model.PortfolioDocument{ID: "doc-1", UserID: "user", Title: "我的第一本作品集", Description: "示例文档", PageCount: 2, Revision: 3, DocJSON: string(raw)},
		&model.Resource{ID: "asset-1", UserID: "user", Kind: "image", Status: "ready", MimeType: "image/png", Width: 1200, Height: 800, Size: 2048},
		&model.Resource{ID: "asset-other", UserID: "other", Kind: "image", Status: "ready", MimeType: "image/png", Width: 800, Height: 800, Size: 2048},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	return s, db
}

func portfolioAgentRequest() CloudAgentRequest {
	req := agentTestRequest()
	req.CanvasID = cloudAgentPortfolioShellID("doc-1")
	req.PermissionMode = "read_only"
	req.ContextScope = []string{}
	return req
}

func portfolioAgentCall(t *testing.T, name, callID string, args any) cloudAgentCall {
	t.Helper()
	return cloudAgentStoryboardCall(t, name, callID, args)
}

func TestPortfolioAgentShellIDParsing(t *testing.T) {
	if got := cloudAgentPortfolioDocumentID("pf-doc-1"); got != "doc-1" {
		t.Fatalf("壳画布 ID 未解析出文档 ID：%q", got)
	}
	for _, canvasID := range []string{"", "agent-canvas", "pf-", "pfx-doc-1", strings.Repeat("pf-", 40)} {
		if got := cloudAgentPortfolioDocumentID(canvasID); got != "" {
			t.Fatalf("非作品集画布 ID %q 被当成作品集壳画布：%q", canvasID, got)
		}
	}
	if got := cloudAgentPortfolioShellID("doc-1"); got != "pf-doc-1" {
		t.Fatalf("壳画布 ID 生成错误：%q", got)
	}
}

func TestPortfolioAgentToolsFollowShellCanvas(t *testing.T) {
	shell := portfolioAgentRequest()
	shell.VisionEnabled = true
	names := map[string]bool{}
	for _, tool := range cloudAgentTools(shell) {
		function, _ := tool["function"].(map[string]any)
		names[stringValue(function["name"])] = true
	}
	for _, want := range []string{"portfolio_read_document", "portfolio_propose_annotations", "portfolio_inspect_image"} {
		if !names[want] {
			t.Fatalf("作品集壳画布缺少工具 %s（当前：%v）", want, names)
		}
	}
	// 作品集运行不带画布上下文，因此不能看到画布工具：它没有画布内容可读可写。
	for _, unwanted := range []string{"canvas_get_state", "canvas_apply_ops", "canvas_inspect_image"} {
		if names[unwanted] {
			t.Fatalf("作品集壳画布暴露了画布工具 %s", unwanted)
		}
	}
	// 模型没有图片输入能力时不暴露看图：否则模型会对着不支持图片的模型反复调用。
	noVision := portfolioAgentRequest()
	delete(names, "portfolio_read_document")
	for _, tool := range cloudAgentTools(noVision) {
		function, _ := tool["function"].(map[string]any)
		if stringValue(function["name"]) == "portfolio_inspect_image" {
			t.Fatal("模型未声明图片输入能力时不应暴露作品集看图工具")
		}
	}
	// 普通画布上一律不注册作品集工具。
	plain := agentTestRequest()
	for _, tool := range cloudAgentTools(plain) {
		function, _ := tool["function"].(map[string]any)
		if strings.HasPrefix(stringValue(function["name"]), "portfolio_") {
			t.Fatalf("普通画布暴露了作品集工具 %s", stringValue(function["name"]))
		}
	}
	if CloudAgentSupportedToolNames() == nil {
		t.Fatal("平台能力集不应为空")
	}
}

func TestPortfolioAgentReadDocument(t *testing.T) {
	s, _ := portfolioAgentFixture(t)
	state := cloudAgentRuntime{Request: portfolioAgentRequest()}

	catalog, err := cloudAgentPortfolioReadTool(s.repo, "user", &state, portfolioAgentCall(t, "portfolio_read_document", "read-1", map[string]any{}))
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := catalog.(map[string]any)
	if payload["documentId"] != "doc-1" || payload["pageCount"] != 2 {
		t.Fatalf("目录投影不正确：%v", payload)
	}
	pages, _ := payload["pages"].([]map[string]any)
	if len(pages) != 2 || pages[0]["imageCount"] != 2 || pages[0]["textCount"] != 1 {
		t.Fatalf("页面目录不正确：%v", pages)
	}
	if _, ok := payload["page"]; ok {
		t.Fatal("未指定 pageId 时不应展开页面元素")
	}

	focused, err := cloudAgentPortfolioReadTool(s.repo, "user", &state, portfolioAgentCall(t, "portfolio_read_document", "read-2", map[string]any{"pageId": "page-1"}))
	if err != nil {
		t.Fatal(err)
	}
	page, _ := focused.(map[string]any)["page"].(map[string]any)
	elements, _ := page["elements"].([]map[string]any)
	if len(elements) != 3 {
		t.Fatalf("页面元素数量不正确：%v", elements)
	}
	first := elements[0]
	if first["elementId"] != "img-1" || first["hasAccountAsset"] != true {
		t.Fatalf("图片元素投影不正确：%v", first)
	}
	if elements[1]["hasAccountAsset"] != false || elements[1]["caption"] != "已有图注" {
		t.Fatalf("未入库图片元素投影不正确：%v", elements[1])
	}

	if _, err := cloudAgentPortfolioReadTool(s.repo, "user", &state, portfolioAgentCall(t, "portfolio_read_document", "read-3", map[string]any{"pageId": "page-404"})); err == nil {
		t.Fatal("未知 pageId 应被拒绝")
	}
	// 归属隔离：别人的作品集读不到。
	if _, err := cloudAgentPortfolioReadTool(s.repo, "other", &state, portfolioAgentCall(t, "portfolio_read_document", "read-4", map[string]any{})); err == nil {
		t.Fatal("跨用户读取作品集应被拒绝")
	}
}

func TestPortfolioAgentProposeAnnotations(t *testing.T) {
	s, db := portfolioAgentFixture(t)
	state := cloudAgentRuntime{Request: portfolioAgentRequest()}
	call := portfolioAgentCall(t, "portfolio_propose_annotations", "propose-1", map[string]any{
		"items": []map[string]any{
			{"elementId": "img-2", "caption": "海边的人像", "tags": []string{"人像", "风景", "人像"}},
			{"elementId": "img-404", "caption": "不存在", "tags": []string{}},
			{"elementId": "text-1", "caption": "不是图片", "tags": []string{}},
			{"elementId": "img-2", "caption": "重复", "tags": []string{}},
		},
	})
	result, err := proposeCloudAgentPortfolioAnnotations(s.repo, "user", &state, "run-1", call)
	if err != nil {
		t.Fatal(err)
	}
	payload, _ := result.(map[string]any)
	if payload["accepted"] != 1 {
		t.Fatalf("应只接受一条建议：%v", payload)
	}
	rejected, _ := payload["rejected"].([]map[string]any)
	if len(rejected) != 3 {
		t.Fatalf("应拒绝三条建议：%v", rejected)
	}
	if len(state.Events) != 1 || state.Events[0].Type != "portfolio_annotations_proposed" {
		t.Fatalf("建议应登记为事件：%v", state.Events)
	}
	items, _ := state.Events[0].Payload["items"].([]map[string]any)
	if len(items) != 1 || items[0]["elementId"] != "img-2" {
		t.Fatalf("事件载荷不正确：%v", state.Events[0].Payload)
	}
	tags, _ := items[0]["tags"].([]string)
	if len(tags) != 2 {
		t.Fatalf("标签应去重并保留顺序：%v", tags)
	}
	// 建议不等于写入：文档必须原封不动。
	var stored model.PortfolioDocument
	if err := db.First(&stored, "id = ?", "doc-1").Error; err != nil {
		t.Fatal(err)
	}
	if stored.Revision != 3 {
		t.Fatalf("建议登记不应改动文档版本：%d", stored.Revision)
	}
	if !strings.Contains(stored.DocJSON, `"已有图注"`) {
		t.Fatal("建议登记改动了文档正文")
	}
}

func TestPortfolioAgentInspectImage(t *testing.T) {
	s, db := portfolioAgentFixture(t)
	capability := DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceChatCompletion), "text-test")
	capability.Text.References.MaxImages = 2
	capability.Text.References.MaxImageBytes = 1024 * 1024
	if err := db.Model(&model.ChannelModel{}).Where("id = ?", "cm").Update("capability_config_json", mustEncodeModelCapabilityConfig(t, capability)).Error; err != nil {
		t.Fatal(err)
	}
	req := portfolioAgentRequest()
	req.VisionEnabled = true
	state := cloudAgentRuntime{Request: req}

	result, err := s.prepareCloudAgentPortfolioInspection("user", &state, portfolioAgentCall(t, "portfolio_inspect_image", "inspect-1", map[string]any{"elementId": "img-1"}))
	if err != nil {
		t.Fatal(err)
	}
	inspection, ok := result.(cloudAgentImageInspection)
	if !ok {
		t.Fatalf("看图结果类型不正确：%T", result)
	}
	if inspection.ImageURL != "resource:asset-1" || inspection.Receipt["elementId"] != "img-1" {
		t.Fatalf("看图结果未指向账号资源：%+v", inspection)
	}

	// 图片必须先存入账号资源库：外链与 data URL 都不能交给模型。
	if _, err := s.prepareCloudAgentPortfolioInspection("user", &state, portfolioAgentCall(t, "portfolio_inspect_image", "inspect-2", map[string]any{"elementId": "img-2"})); err == nil {
		t.Fatal("未入库的图片应被拒绝")
	}
	// 带 assetId 但资源属于别人时同样拒绝。
	if _, err := s.prepareCloudAgentPortfolioInspection("user", &state, portfolioAgentCall(t, "portfolio_inspect_image", "inspect-3", map[string]any{"elementId": "img-3"})); err == nil {
		t.Fatal("他人资源应被拒绝")
	}
	if _, err := s.prepareCloudAgentPortfolioInspection("user", &state, portfolioAgentCall(t, "portfolio_inspect_image", "inspect-4", map[string]any{"elementId": "text-1"})); err == nil {
		t.Fatal("非图片元素应被拒绝")
	}
}

func TestPortfolioAgentEnsureShellCanvas(t *testing.T) {
	s, _ := portfolioAgentFixture(t)

	if err := s.ensureCloudAgentPortfolioShell("user", "doc-1"); err != nil {
		t.Fatal(err)
	}
	canvas, err := s.repo.CanvasProjectForUser("user", "pf-doc-1")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(canvas.Title, "作品集：") {
		t.Fatalf("壳画布标题不正确：%q", canvas.Title)
	}
	if strings.Contains(canvas.PayloadJSON, "img-1") {
		t.Fatal("壳画布不应镜像作品集内容")
	}
	if canvas.Revision == 0 {
		t.Fatalf("壳画布应完成一次保存并获得版本：%d", canvas.Revision)
	}
	// 幂等：已有壳画布时不再写一次，避免每次运行都产生画布历史。
	if err := s.ensureCloudAgentPortfolioShell("user", "doc-1"); err != nil {
		t.Fatal(err)
	}
	again, err := s.repo.CanvasProjectForUser("user", "pf-doc-1")
	if err != nil {
		t.Fatal(err)
	}
	if again.Revision != canvas.Revision || again.UpdatedAt.String() != canvas.UpdatedAt.String() {
		t.Fatalf("重复 ensure 改动了壳画布：%+v vs %+v", again, canvas)
	}
	// 文档不存在时不能凭空造壳画布。
	if err := s.ensureCloudAgentPortfolioShell("user", "doc-404"); err == nil {
		t.Fatal("不存在的作品集不应创建壳画布")
	}
	if err := s.ensureCloudAgentPortfolioShell("other", "doc-1"); err == nil {
		t.Fatal("跨用户不应创建壳画布")
	}
}
