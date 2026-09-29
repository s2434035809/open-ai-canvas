package model

import "time"

// PortfolioDocument 保存一个用户的「作品集」编排文档，是 portfolio-studio 应用
// 插件的服务端持久化载体。
//
// DocJSON 存放页面与元素的完整结构，只在读写单篇文档时加载；列表查询必须显式
// select 元信息列，避免把大 JSON 带进列表响应。Revision 每次保存自增，供前端
// 判断本地草稿是否基于最新服务端版本。
type PortfolioDocument struct {
	ID          string    `json:"id" gorm:"primaryKey;size:36"`
	UserID      string    `json:"userId" gorm:"index;size:36;not null"`
	Title       string    `json:"title" gorm:"size:200;not null"`
	Description string    `json:"description" gorm:"size:1000"`
	CoverURL    string    `json:"coverUrl" gorm:"size:1000"`
	PageCount   int       `json:"pageCount" gorm:"not null;default:0"`
	Revision    int64     `json:"revision" gorm:"not null;default:0"`
	DocJSON     string    `json:"-" gorm:"type:text"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}
