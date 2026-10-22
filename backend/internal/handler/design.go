package handler

import (
	"net/http"

	"yingce/backend/internal/service"

	"github.com/gin-gonic/gin"
)

// designRequestBodyLimit 必须大于 service 层的文档配额（8MiB），保证超限请求由业务
// 校验返回可读错误，而不是被 MaxBytesReader 直接截断。
const designRequestBodyLimit = 12 << 20

// RegisterDesignRoutes 注册「设计工作台」应用插件的数据接口。文档始终按登录用户
// 归属读写，handler 只负责鉴权上下文、入参反序列化和响应投影。
func RegisterDesignRoutes(r *gin.RouterGroup, svc *service.Service) {
	r.GET("/design/documents", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		documents, err := svc.ListDesignDocuments(user.ID)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"items": documents})
	})

	r.POST("/design/documents", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, designRequestBodyLimit)
		var req service.SaveDesignDocumentRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		document, err := svc.CreateDesignDocument(user.ID, req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, document)
	})

	r.GET("/design/documents/:id", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		document, err := svc.GetDesignDocument(user.ID, c.Param("id"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, document)
	})

	r.PUT("/design/documents/:id", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, designRequestBodyLimit)
		var req service.SaveDesignDocumentRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		document, err := svc.SaveDesignDocument(user.ID, c.Param("id"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, document)
	})

	r.DELETE("/design/documents/:id", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if err := svc.DeleteDesignDocument(user.ID, c.Param("id")); err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"id": c.Param("id")})
	})
}
