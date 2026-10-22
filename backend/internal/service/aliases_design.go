package service

import "yingce/backend/internal/app"

// 设计工作台的类型别名。独立成文件而不是写进 aliases_types.go：
// 那份是dev 原有文件，新插件的对外类型不该混进去。
type (
	DesignDocumentSummary     = app.DesignDocumentSummary
	DesignDocumentView        = app.DesignDocumentView
	SaveDesignDocumentRequest = app.SaveDesignDocumentRequest
)
