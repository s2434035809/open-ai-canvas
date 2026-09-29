package app

import (
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/repository"

	"gorm.io/gorm"
)

const (
	// portfolioMaxDocBytes 限制单篇作品集文档正文大小。作品集是纯结构数据（页面、
	// 元素坐标与文字，图片只存资源引用），超过这个量级说明调用方在传二进制。
	portfolioMaxDocBytes   = 8 << 20
	portfolioMaxTitleRunes = 120
	portfolioMaxDescRunes  = 500
)

// PortfolioDocumentSummary 是作品集列表项视图，不含文档正文。
type PortfolioDocumentSummary struct {
	ID          string    `json:"id"`
	Title       string    `json:"title"`
	Description string    `json:"description"`
	CoverURL    string    `json:"coverUrl"`
	PageCount   int       `json:"pageCount"`
	Revision    int64     `json:"revision"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// PortfolioDocumentView 是单篇作品集视图，Doc 为文档 JSON 原文，前端直接反序列化。
type PortfolioDocumentView struct {
	PortfolioDocumentSummary
	Doc json.RawMessage `json:"doc"`
}

// SavePortfolioDocumentRequest 是创建与保存共用的入参；保存时整体覆盖文档内容。
type SavePortfolioDocumentRequest struct {
	Title       string          `json:"title"`
	Description string          `json:"description"`
	CoverURL    string          `json:"coverUrl"`
	PageCount   int             `json:"pageCount"`
	Doc         json.RawMessage `json:"doc"`
}

func (s *Service) ListPortfolioDocuments(userID string) ([]PortfolioDocumentSummary, error) {
	documents, err := s.repo.ListPortfolioDocuments(userID)
	if err != nil {
		return nil, err
	}
	summaries := make([]PortfolioDocumentSummary, 0, len(documents))
	for _, document := range documents {
		summaries = append(summaries, portfolioSummary(document))
	}
	return summaries, nil
}

func (s *Service) GetPortfolioDocument(userID string, id string) (*PortfolioDocumentView, error) {
	if strings.TrimSpace(id) == "" {
		return nil, BadAuthRequest("缺少作品集 ID")
	}
	document, err := s.repo.GetPortfolioDocument(userID, id)
	if err != nil {
		return nil, portfolioNotFound(err)
	}
	return portfolioView(*document), nil
}

func (s *Service) CreatePortfolioDocument(userID string, req SavePortfolioDocumentRequest) (*PortfolioDocumentView, error) {
	normalized, err := normalizePortfolioRequest(req)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	document := model.PortfolioDocument{
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
	if err := s.repo.CreatePortfolioDocument(&document); err != nil {
		return nil, err
	}
	return portfolioView(document), nil
}

func (s *Service) SavePortfolioDocument(userID string, id string, req SavePortfolioDocumentRequest) (*PortfolioDocumentView, error) {
	if strings.TrimSpace(id) == "" {
		return nil, BadAuthRequest("缺少作品集 ID")
	}
	normalized, err := normalizePortfolioRequest(req)
	if err != nil {
		return nil, err
	}
	update := repository.PortfolioDocumentUpdate{
		Title:       normalized.title,
		Description: normalized.description,
		CoverURL:    normalized.coverURL,
		PageCount:   normalized.pageCount,
		DocJSON:     normalized.doc,
	}
	if err := s.repo.UpdatePortfolioDocument(userID, id, update); err != nil {
		return nil, portfolioNotFound(err)
	}
	return s.GetPortfolioDocument(userID, id)
}

func (s *Service) DeletePortfolioDocument(userID string, id string) error {
	if strings.TrimSpace(id) == "" {
		return BadAuthRequest("缺少作品集 ID")
	}
	if err := s.repo.DeletePortfolioDocument(userID, id); err != nil {
		return portfolioNotFound(err)
	}
	return nil
}

type normalizedPortfolioRequest struct {
	title       string
	description string
	coverURL    string
	pageCount   int
	doc         string
}

// normalizePortfolioRequest 统一收敛创建与保存的入参校验：标题必填、正文必须是合法
// JSON 且不超过配额。空正文按空文档处理，避免前端首次保存必须先造结构。
func normalizePortfolioRequest(req SavePortfolioDocumentRequest) (normalizedPortfolioRequest, error) {
	title := strings.TrimSpace(req.Title)
	if title == "" {
		return normalizedPortfolioRequest{}, BadAuthRequest("作品集标题不能为空")
	}
	if utf8.RuneCountInString(title) > portfolioMaxTitleRunes {
		return normalizedPortfolioRequest{}, BadAuthRequest("作品集标题过长")
	}
	description := strings.TrimSpace(req.Description)
	if utf8.RuneCountInString(description) > portfolioMaxDescRunes {
		return normalizedPortfolioRequest{}, BadAuthRequest("作品集简介过长")
	}
	doc := strings.TrimSpace(string(req.Doc))
	if doc == "" {
		doc = "{}"
	}
	if len(doc) > portfolioMaxDocBytes {
		return normalizedPortfolioRequest{}, BadAuthRequest("作品集内容过大，请精简后重试")
	}
	if !json.Valid([]byte(doc)) {
		return normalizedPortfolioRequest{}, BadAuthRequest("作品集内容不是合法 JSON")
	}
	pageCount := req.PageCount
	if pageCount < 0 {
		pageCount = 0
	}
	return normalizedPortfolioRequest{
		title:       title,
		description: description,
		coverURL:    strings.TrimSpace(req.CoverURL),
		pageCount:   pageCount,
		doc:         doc,
	}, nil
}

func portfolioSummary(document model.PortfolioDocument) PortfolioDocumentSummary {
	return PortfolioDocumentSummary{
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

func portfolioView(document model.PortfolioDocument) *PortfolioDocumentView {
	view := &PortfolioDocumentView{PortfolioDocumentSummary: portfolioSummary(document)}
	if body := strings.TrimSpace(document.DocJSON); body != "" && json.Valid([]byte(body)) {
		view.Doc = json.RawMessage(body)
	} else {
		view.Doc = json.RawMessage("{}")
	}
	return view
}

// portfolioNotFound 把未命中归属的读取错误统一投影为 404，不区分「记录不存在」与
// 「不属于当前用户」，避免用错误信息探测他人作品集是否存在。
func portfolioNotFound(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return &AppError{Status: 404, Code: 404, Message: "作品集不存在或无权访问"}
	}
	return err
}
