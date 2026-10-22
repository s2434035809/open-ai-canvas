package app

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"

	"yingce/backend/internal/model"
)

// designDocumentFixture 构造一个带给定 DocJSON 的模型实例，用于视图投影测试。
func designDocumentFixture(docJSON string) model.DesignDocument {
	return model.DesignDocument{
		ID:        "design-1",
		UserID:    "user-1",
		Title:     "海报",
		PageCount: 1,
		Revision:  1,
		DocJSON:   docJSON,
	}
}

// 设计稿的入参校验是 S3 的唯一业务闸门：数据库层只做加列，不拦内容。
// 这些用例锁住"什么会被写进去、什么必须在写入前被拒"。

func TestNormalizeDesignRequest(t *testing.T) {
	cases := []struct {
		name     string
		req      SaveDesignDocumentRequest
		wantErr  bool
		wantDoc  string
		wantPage int
	}{
		{name: "常规文档", req: SaveDesignDocumentRequest{Title: "海报", Doc: json.RawMessage(`{"schemaVersion":1,"pages":[]}`)}, wantDoc: `{"schemaVersion":1,"pages":[]}`},
		{name: "标题两端空格会被裁掉", req: SaveDesignDocumentRequest{Title: "  海报  ", Doc: json.RawMessage(`{}`)}, wantDoc: `{}`},
		{name: "空正文按空文档处理", req: SaveDesignDocumentRequest{Title: "海报"}, wantDoc: `{}`},
		{name: "空白正文按空文档处理", req: SaveDesignDocumentRequest{Title: "海报", Doc: json.RawMessage("   ")}, wantDoc: `{}`},
		{name: "负页码归零", req: SaveDesignDocumentRequest{Title: "海报", PageCount: -3, Doc: json.RawMessage(`{}`)}, wantDoc: `{}`, wantPage: 0},
		{name: "标题缺失", req: SaveDesignDocumentRequest{Doc: json.RawMessage(`{}`)}, wantErr: true},
		{name: "标题只有空格", req: SaveDesignDocumentRequest{Title: "   ", Doc: json.RawMessage(`{}`)}, wantErr: true},
		{name: "非法 JSON", req: SaveDesignDocumentRequest{Title: "海报", Doc: json.RawMessage(`{oops`)}, wantErr: true},
		// json.Valid 对数组/字符串/数字同样返回 true，必须显式拒绝：
		// 放行会让前端读到无法渲染的正文。
		{name: "正文是数组", req: SaveDesignDocumentRequest{Title: "海报", Doc: json.RawMessage(`[]`)}, wantErr: true},
		{name: "正文是字符串", req: SaveDesignDocumentRequest{Title: "海报", Doc: json.RawMessage(`"x"`)}, wantErr: true},
		{name: "正文是数字", req: SaveDesignDocumentRequest{Title: "海报", Doc: json.RawMessage(`42`)}, wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := normalizeDesignRequest(tc.req)
			if tc.wantErr {
				if err == nil {
					t.Fatal("期望被拒绝，实际通过")
				}
				return
			}
			if err != nil {
				t.Fatalf("意外报错: %v", err)
			}
			if got.doc != tc.wantDoc {
				t.Fatalf("doc 不符合预期: got=%q want=%q", got.doc, tc.wantDoc)
			}
			if got.pageCount != tc.wantPage {
				t.Fatalf("pageCount 不符合预期: got=%d want=%d", got.pageCount, tc.wantPage)
			}
		})
	}
}

// 正文超限必须在写入数据库之前就被拒绝，否则会被 MaxBytesReader 截断成不可读错误。
func TestNormalizeDesignRequestRejectsOversizedDoc(t *testing.T) {
	oversized := json.RawMessage(`{"pad":"` + strings.Repeat("x", designMaxDocBytes) + `"}`)
	if _, err := normalizeDesignRequest(SaveDesignDocumentRequest{Title: "标题", Doc: oversized}); err == nil {
		t.Fatal("期望超限被拒绝，实际通过")
	}
}

// 配额边界：恰好等于上限应当放行（< 才 reject），确认没有差一错误。
func TestNormalizeDesignRequestAcceptsDocAtLimit(t *testing.T) {
	// {"pad":"..."} 的外壳占 10 字节：{"pad":"} 是 8 字节，结尾 "} 是 2 字节。
	exact := json.RawMessage(`{"pad":"` + strings.Repeat("x", designMaxDocBytes-10) + `"}`)
	if len(exact) != designMaxDocBytes {
		t.Fatalf("用例构造错误: len=%d want=%d", len(exact), designMaxDocBytes)
	}
	if _, err := normalizeDesignRequest(SaveDesignDocumentRequest{Title: "标题", Doc: exact}); err != nil {
		t.Fatalf("恰好等于配额时应放行: %v", err)
	}
}

func TestNormalizeDesignRequestRejectsLongTitle(t *testing.T) {
	long := strings.Repeat("标", designMaxTitleRunes+1)
	if _, err := normalizeDesignRequest(SaveDesignDocumentRequest{Title: long, Doc: json.RawMessage(`{}`)}); err == nil {
		t.Fatal("超长标题应被拒绝")
	}
	// 按 rune 计数而不是字节：120 个汉字应当放行。
	atLimit := strings.Repeat("标", designMaxTitleRunes)
	if utf8.RuneCountInString(atLimit) != designMaxTitleRunes {
		t.Fatalf("用例构造错误")
	}
	if _, err := normalizeDesignRequest(SaveDesignDocumentRequest{Title: atLimit, Doc: json.RawMessage(`{}`)}); err != nil {
		t.Fatalf("标题恰好等于上限时应放行: %v", err)
	}
}

func TestNormalizeDesignRequestRejectsLongDescription(t *testing.T) {
	long := strings.Repeat("说", designMaxDescRunes+1)
	if _, err := normalizeDesignRequest(SaveDesignDocumentRequest{Title: "标题", Description: long, Doc: json.RawMessage(`{}`)}); err == nil {
		t.Fatal("超长说明应被拒绝")
	}
}

// 视图投影：损坏的 DocJSON 不能让前端拿到无法解析的正文。
func TestDesignViewFallsBackToEmptyObject(t *testing.T) {
	for _, body := range []string{"", "   ", "{oops", "[]"} {
		view := designView(designDocumentFixture(body))
		if string(view.Doc) != "{}" {
			t.Fatalf("body=%q 应回退为 {}，实际 %s", body, view.Doc)
		}
	}
	view := designView(designDocumentFixture(`{"schemaVersion":1}`))
	if string(view.Doc) != `{"schemaVersion":1}` {
		t.Fatalf("合法正文应原样透出，实际 %s", view.Doc)
	}
}
