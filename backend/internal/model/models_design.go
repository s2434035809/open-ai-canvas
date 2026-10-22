package model

import "time"

// DesignDocument 保存一个用户的「设计工作台」编排文档，是 design-studio 应用
// 插件的服务端持久化载体。
//
// 一张表只承载设计稿这一种业务：文档是「页面 + 元素」结构，元素语义是精确版式
// 与社媒尺寸。将来若出现结构完全不同、可空字段大量增加的文档类型，应单独建表，
// 而不是往这里塞 kind 列。
//
// DocJSON 只在读写单篇文档时加载；列表查询必须显式 select 元信息列。Revision
// 每次保存自增，供前端判断本地草稿是否基于最新服务端版本。
type DesignDocument struct {
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
