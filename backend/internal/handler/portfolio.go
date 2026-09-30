package handler

import (
	"net/http"

	"infinite-canvas/backend/internal/service"

	"github.com/gin-gonic/gin"
)

// portfolioRequestBodyLimit 必须大于 service 层的文档配额，保证超限请求由业务校验
// 返回可读错误，而不是被 MaxBytesReader 直接截断。
const portfolioRequestBodyLimit = 12 << 20

// RegisterPortfolioRoutes 注册「作品集工作台」应用插件的数据接口。文档始终按登录
// 用户归属读写，handler 只负责鉴权上下文、入参反序列化和响应投影。
func RegisterPortfolioRoutes(r *gin.RouterGroup, svc *service.Service) {
	r.GET("/portfolio/documents", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		documents, err := svc.ListPortfolioDocuments(user.ID)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"items": documents})
	})

	r.POST("/portfolio/documents", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, portfolioRequestBodyLimit)
		var req service.SavePortfolioDocumentRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		document, err := svc.CreatePortfolioDocument(user.ID, req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, document)
	})

	r.GET("/portfolio/documents/:id", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		document, err := svc.GetPortfolioDocument(user.ID, c.Param("id"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, document)
	})

	r.PUT("/portfolio/documents/:id", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, portfolioRequestBodyLimit)
		var req service.SavePortfolioDocumentRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		document, err := svc.SavePortfolioDocument(user.ID, c.Param("id"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, document)
	})

	r.DELETE("/portfolio/documents/:id", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if err := svc.DeletePortfolioDocument(user.ID, c.Param("id")); err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"id": c.Param("id")})
	})
}
