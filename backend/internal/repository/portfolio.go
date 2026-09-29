package repository

import (
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

// 作品集文档的全部读写都带 user_id 归属条件：跨用户读取返回 gorm.ErrRecordNotFound，
// 由上层统一投影为 404，不向调用方暴露记录是否真实存在。

// portfolioDocumentListColumns 是列表查询的列白名单，显式排除 doc_json。
const portfolioDocumentListColumns = "id, user_id, title, description, cover_url, page_count, revision, created_at, updated_at"

// PortfolioDocumentUpdate 是保存作品集文档时可变字段的载体；Revision 由数据库自增，
// 不从这里写入。
type PortfolioDocumentUpdate struct {
	Title       string
	Description string
	CoverURL    string
	PageCount   int
	DocJSON     string
}

func (r *Repository) ListPortfolioDocuments(userID string) ([]model.PortfolioDocument, error) {
	var documents []model.PortfolioDocument
	err := r.db.Select(portfolioDocumentListColumns).
		Where("user_id = ?", userID).
		Order("updated_at DESC").
		Find(&documents).Error
	return documents, err
}

func (r *Repository) GetPortfolioDocument(userID string, id string) (*model.PortfolioDocument, error) {
	var document model.PortfolioDocument
	if err := r.db.First(&document, "id = ? AND user_id = ?", id, userID).Error; err != nil {
		return nil, err
	}
	return &document, nil
}

func (r *Repository) CreatePortfolioDocument(document *model.PortfolioDocument) error {
	return r.db.Create(document).Error
}

// UpdatePortfolioDocument 以 where 归属条件做原子更新，并把 revision 与 updated_at
// 一起推进，避免先读后写的竞态。记录不存在或不属于该用户时返回 gorm.ErrRecordNotFound。
func (r *Repository) UpdatePortfolioDocument(userID string, id string, update PortfolioDocumentUpdate) error {
	result := r.db.Model(&model.PortfolioDocument{}).
		Where("id = ? AND user_id = ?", id, userID).
		Updates(map[string]any{
			"title":       update.Title,
			"description": update.Description,
			"cover_url":   update.CoverURL,
			"page_count":  update.PageCount,
			"doc_json":    update.DocJSON,
			"revision":    gorm.Expr("revision + 1"),
			"updated_at":  time.Now(),
		})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

func (r *Repository) DeletePortfolioDocument(userID string, id string) error {
	result := r.db.Where("id = ? AND user_id = ?", id, userID).Delete(&model.PortfolioDocument{})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return gorm.ErrRecordNotFound
	}
	return nil
}
