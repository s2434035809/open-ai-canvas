package app

import (
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"yingce/backend/internal/kernel"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"

	"gorm.io/gorm"
)

// 设计稿是「页面 + 元素」的纯结构数据（图片只存资源引用，不内联二进制），
// 超过这个量级说明调用方在传二进制。
const (
	// designMaxDocBytes 是 service 层业务配额。
	designMaxDocBytes = 8 << 20
	// designMaxTitleRunes 与模型列宽 200 留出余量。
	designMaxTitleRunes = 120
	designMaxDescRunes  = 500
)

// DesignDocumentSummary 是设计稿列表项视图，不含文档正文。
type DesignDocumentSummary struct {
	ID          string    `json:"id"`
	Title       string    `json:"title"`
	Description string    `json:"description"`
	CoverURL    string    `json:"coverUrl"`
	PageCount   int       `json:"pageCount"`
	Revision    int64     `json:"revision"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// DesignDocumentView 是单篇设计稿视图，Doc 为文档 JSON 原文，前端直接反序列化。
type DesignDocumentView struct {
	DesignDocumentSummary
	Doc json.RawMessage `json:"doc"`
}

// SaveDesignDocumentRequest 是创建与保存共用的入参；保存时整体覆盖文档内容。
type SaveDesignDocumentRequest struct {
	Title       string          `json:"title"`
	Description string          `json:"description"`
	CoverURL    string          `json:"coverUrl"`
	PageCount   int             `json:"pageCount"`
	Doc         json.RawMessage `json:"doc"`
}

func (s *Service) ListDesignDocuments(userID string) ([]DesignDocumentSummary, error) {
	documents, err := s.repo.ListDesignDocuments(userID)
	if err != nil {
		return nil, err
	}
	summaries := make([]DesignDocumentSummary, 0, len(documents))
	for _, document := range documents {
		summaries = append(summaries, designSummary(document))
	}
	return summaries, nil
}

func (s *Service) GetDesignDocument(userID string, id string) (*DesignDocumentView, error) {
	if strings.TrimSpace(id) == "" {
		return nil, BadAuthRequest("缺少设计稿 ID")
	}
	document, err := s.repo.GetDesignDocument(userID, id)
	if err != nil {
		return nil, designNotFound(err)
	}
	return designView(*document), nil
}

func (s *Service) CreateDesignDocument(userID string, req SaveDesignDocumentRequest) (*DesignDocumentView, error) {
	normalized, err := normalizeDesignRequest(req)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	document := model.DesignDocument{
		ID:          kernel.NewID(),
		UserID:      userID,
		Title:       normalized.title,
		Description: normalized.description,
		CoverURL:    normalized.coverURL,
		PageCount:   normalized.pageCount,
		DocJSON:     normalized.doc,
		Revision:    1,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := s.repo.CreateDesignDocument(&document); err != nil {
		return nil, err
	}
	return designView(document), nil
}

func (s *Service) SaveDesignDocument(userID string, id string, req SaveDesignDocumentRequest) (*DesignDocumentView, error) {
	if strings.TrimSpace(id) == "" {
		return nil, BadAuthRequest("缺少设计稿 ID")
	}
	normalized, err := normalizeDesignRequest(req)
	if err != nil {
		return nil, err
	}
	update := repository.DesignDocumentUpdate{
		Title:       normalized.title,
		Description: normalized.description,
		CoverURL:    normalized.coverURL,
		PageCount:   normalized.pageCount,
		DocJSON:     normalized.doc,
	}
	if err := s.repo.UpdateDesignDocument(userID, id, update); err != nil {
		return nil, designNotFound(err)
	}
	return s.GetDesignDocument(userID, id)
}

func (s *Service) DeleteDesignDocument(userID string, id string) error {
	if strings.TrimSpace(id) == "" {
		return BadAuthRequest("缺少设计稿 ID")
	}
	if err := s.repo.DeleteDesignDocument(userID, id); err != nil {
		return designNotFound(err)
	}
	return nil
}

type normalizedDesignRequest struct {
	title       string
	description string
	coverURL    string
	pageCount   int
	doc         string
}

// normalizeDesignRequest 统一收敛创建与保存的入参校验：标题必填、正文必须是合法
// JSON 对象且不超过配额。空正文按空文档处理，避免前端首次保存必须先造结构。
func normalizeDesignRequest(req SaveDesignDocumentRequest) (normalizedDesignRequest, error) {
	title := strings.TrimSpace(req.Title)
	if title == "" {
		return normalizedDesignRequest{}, BadAuthRequest("设计稿标题不能为空")
	}
	if utf8.RuneCountInString(title) > designMaxTitleRunes {
		return normalizedDesignRequest{}, BadAuthRequest("设计稿标题过长")
	}
	description := strings.TrimSpace(req.Description)
	if utf8.RuneCountInString(description) > designMaxDescRunes {
		return normalizedDesignRequest{}, BadAuthRequest("设计稿说明过长")
	}
	doc := strings.TrimSpace(string(req.Doc))
	if doc == "" {
		doc = "{}"
	}
	if len(doc) > designMaxDocBytes {
		return normalizedDesignRequest{}, BadAuthRequest("设计稿内容过大，请精简后重试")
	}
	if !json.Valid([]byte(doc)) {
		return normalizedDesignRequest{}, BadAuthRequest("设计稿内容不是合法 JSON")
	}
	// 契约里文档是对象（schemaVersion/pages/...）。json.Valid 对字符串、数组、
	// 数字同样返回 true，若放行会让前端读到无法渲染的正文，这里显式收口。
	if !strings.HasPrefix(doc, "{") {
		return normalizedDesignRequest{}, BadAuthRequest("设计稿内容必须是 JSON 对象")
	}
	pageCount := req.PageCount
	if pageCount < 0 {
		pageCount = 0
	}
	return normalizedDesignRequest{
		title:       title,
		description: description,
		coverURL:    strings.TrimSpace(req.CoverURL),
		pageCount:   pageCount,
		doc:         doc,
	}, nil
}

func designSummary(document model.DesignDocument) DesignDocumentSummary {
	return DesignDocumentSummary{
		ID:          document.ID,
		Title:       document.Title,
		Description: document.Description,
		CoverURL:    document.CoverURL,
		PageCount:   document.PageCount,
		Revision:    document.Revision,
		CreatedAt:   document.CreatedAt,
		UpdatedAt:   document.UpdatedAt,
	}
}

func designView(document model.DesignDocument) *DesignDocumentView {
	view := &DesignDocumentView{DesignDocumentSummary: designSummary(document)}
	// 投影必须与写入校验同口径：normalizeDesignRequest 只接受 JSON 对象，
	// 所以读到数组/字符串/数字（历史脏数据或手工改库）一律回退为空对象，
	// 否则前端会拿到无法渲染的正文。
	if body := strings.TrimSpace(document.DocJSON); body != "" && json.Valid([]byte(body)) && strings.HasPrefix(body, "{") {
		view.Doc = json.RawMessage(body)
	} else {
		view.Doc = json.RawMessage("{}")
	}
	return view
}

// designNotFound 把未命中归属的读写错误统一投影为 404，不区分「记录不存在」与
// 「不属于当前用户」，避免用错误信息探测他人设计稿是否存在。
func designNotFound(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return &AppError{Status: 404, Code: 404, Message: "设计稿不存在或无权访问"}
	}
	return err
}
