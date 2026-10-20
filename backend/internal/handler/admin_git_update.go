package handler

import (
	"net"
	"net/http"
	"strings"

	"yingce/backend/internal/service"

	"github.com/gin-gonic/gin"
)

// registerAdminGitUpdateRoutes 提供开发态「合并上游 main 到 dev」接口。
// 该能力会执行 git 写操作，因此双重限制：仅管理员、且仅本机回环访问。
func registerAdminGitUpdateRoutes(r *gin.RouterGroup, svc *service.Service) {
	r.GET("/admin/git-update", func(c *gin.Context) {
		actor, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if !privateNetworkOnly(c) {
			fail(c, http.StatusForbidden, errRemoteUpdateForbidden)
			return
		}
		status, err := svc.AdminGitUpdateStatus(c.Request.Context(), actor)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, status)
	})

	r.POST("/admin/git-update/check", func(c *gin.Context) {
		actor, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if !privateNetworkOnly(c) {
			fail(c, http.StatusForbidden, errRemoteUpdateForbidden)
			return
		}
		status, err := svc.AdminGitUpdateCheck(c.Request.Context(), actor)
		if err != nil {
			// 检查失败也要把已收集的诊断信息返回，前端才能显示是拉取还是冲突失败。
			if status.Branch != "" {
				ok(c, status)
				return
			}
			failService(c, err)
			return
		}
		ok(c, status)
	})

	r.POST("/admin/git-update/apply", func(c *gin.Context) {
		actor, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if !privateNetworkOnly(c) {
			fail(c, http.StatusForbidden, errRemoteUpdateForbidden)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4<<10)
		var request struct {
			ExpectedCommit string `json:"expectedCommit" binding:"required"`
		}
		if err := c.ShouldBindJSON(&request); err != nil {
			fail(c, http.StatusBadRequest, err)
			return
		}
		status, err := svc.AdminGitUpdateApply(c.Request.Context(), actor, request.ExpectedCommit)
		if err != nil {
			if status.Branch != "" {
				ok(c, status)
				return
			}
			failService(c, err)
			return
		}
		ok(c, status)
	})
}

var errRemoteUpdateForbidden = &forbiddenError{detail: "源码更新仅允许局域网内访问，请勿通过公网隧道触发"}

type forbiddenError struct{ detail string }

func (e *forbiddenError) Error() string { return e.detail }

// privateNetworkOnly 拒绝来自公网地址的源码更新请求。
//
// 开发栈里请求要经过两层代理：浏览器 → Vite 容器（xfwd，写入 X-Forwarded-For）
// → backend。所以不能因为存在转发头就拒绝，那样 13000 页面永远点不动。
// 这里的判定是「整条链都必须是内网」：RemoteAddr 与 X-Forwarded-For 的每个地址
// 都必须是回环或私有网段；任何一跳是公网地址，或带 Cloudflare 隧道标记，一律拒绝。
func privateNetworkOnly(c *gin.Context) bool {
	if strings.TrimSpace(c.GetHeader("CF-Connecting-IP")) != "" {
		return false
	}
	if !privateAddress(c.Request.RemoteAddr) {
		return false
	}
	for _, part := range strings.Split(c.GetHeader("X-Forwarded-For"), ",") {
		if strings.TrimSpace(part) == "" {
			continue
		}
		if !privateAddress(part) {
			return false
		}
	}
	return true
}

func privateAddress(value string) bool {
	host := strings.TrimSpace(value)
	if splitHost, _, err := net.SplitHostPort(host); err == nil {
		host = splitHost
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && (ip.IsLoopback() || ip.IsPrivate())
}
