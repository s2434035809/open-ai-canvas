package app

import (
	"encoding/json"
	"strings"
	"testing"
)

// normalizePortfolioRequest 是创建与保存共用的唯一入口校验，这里覆盖它的
// 收敛规则：标题必填、正文必须是 JSON 对象、超限提前拒绝。
func TestNormalizePortfolioRequest(t *testing.T) {
	tests := []struct {
		name     string
		req      SavePortfolioDocumentRequest
		wantErr  bool
		wantDoc  string
		wantNote string
	}{
		{
			name:    "标题去除首尾空白后保留",
			req:     SavePortfolioDocumentRequest{Title: "  海边的黄昏  ", Doc: json.RawMessage(`{"schemaVersion":1,"pages":[]}`)},
			wantDoc: `{"schemaVersion":1,"pages":[]}`,
		},
		{
			name:    "空正文按空对象处理",
			req:     SavePortfolioDocumentRequest{Title: "空文档"},
			wantDoc: "{}",
		},
		{
			name:    "正文为 null 时按空对象处理",
			req:     SavePortfolioDocumentRequest{Title: "空文档", Doc: json.RawMessage(`  `)},
			wantDoc: "{}",
		},
		{
			name:    "空标题被拒绝",
			req:     SavePortfolioDocumentRequest{Title: "   ", Doc: json.RawMessage(`{}`)},
			wantErr: true,
		},
		{
			name:    "标题超长被拒绝",
			req:     SavePortfolioDocumentRequest{Title: strings.Repeat("题", portfolioMaxTitleRunes+1), Doc: json.RawMessage(`{}`)},
			wantErr: true,
		},
		{
			name:    "简介超长被拒绝",
			req:     SavePortfolioDocumentRequest{Title: "标题", Description: strings.Repeat("字", portfolioMaxDescRunes+1), Doc: json.RawMessage(`{}`)},
			wantErr: true,
		},
		{
			name:    "非法 JSON 被拒绝",
			req:     SavePortfolioDocumentRequest{Title: "标题", Doc: json.RawMessage(`{"pages":`)},
			wantErr: true,
		},
		{
			name:     "JSON 字符串被拒绝",
			req:      SavePortfolioDocumentRequest{Title: "标题", Doc: json.RawMessage(`"not-an-object"`)},
			wantErr:  true,
			wantNote: "json.Valid 会放行字符串，必须由对象校验拦下",
		},
		{
			name:    "JSON 数组被拒绝",
			req:     SavePortfolioDocumentRequest{Title: "标题", Doc: json.RawMessage(`[1,2,3]`)},
			wantErr: true,
		},
		{
			name:    "JSON 数字被拒绝",
			req:     SavePortfolioDocumentRequest{Title: "标题", Doc: json.RawMessage(`42`)},
			wantErr: true,
		},
		{
			name:    "JSON null 被拒绝",
			req:     SavePortfolioDocumentRequest{Title: "标题", Doc: json.RawMessage(`null`)},
			wantErr: true,
		},
		{
			name:    "负页码归零",
			req:     SavePortfolioDocumentRequest{Title: "标题", PageCount: -3, Doc: json.RawMessage(`{}`)},
			wantDoc: "{}",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := normalizePortfolioRequest(tc.req)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("期望拒绝，实际通过（doc=%q）", got.doc)
				}
				return
			}
			if err != nil {
				t.Fatalf("期望通过，实际报错: %v", err)
			}
			if got.doc != tc.wantDoc {
				t.Fatalf("doc 不符合预期: got=%q want=%q", got.doc, tc.wantDoc)
			}
		})
	}
}

// 正文超限必须在写入数据库之前就被拒绝，否则会被 MaxBytesReader 截断成不可读错误。
func TestNormalizePortfolioRequestRejectsOversizedDoc(t *testing.T) {
	oversized := json.RawMessage(`{"pad":"` + strings.Repeat("x", portfolioMaxDocBytes) + `"}`)
	if _, err := normalizePortfolioRequest(SavePortfolioDocumentRequest{Title: "标题", Doc: oversized}); err == nil {
		t.Fatal("期望超限被拒绝，实际通过")
	}
}

// 归零后的负页码不应写回负数。
func TestNormalizePortfolioRequestClampsNegativePageCount(t *testing.T) {
	got, err := normalizePortfolioRequest(SavePortfolioDocumentRequest{
		Title: "标题", PageCount: -1, Doc: json.RawMessage(`{}`),
	})
	if err != nil {
		t.Fatalf("意外报错: %v", err)
	}
	if got.pageCount != 0 {
		t.Fatalf("pageCount 应归零, got=%d", got.pageCount)
	}
}
