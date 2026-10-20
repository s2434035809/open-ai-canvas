package handler

import (
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestPrivateNetworkOnlyAcceptsDevProxyChain(t *testing.T) {
	gin.SetMode(gin.TestMode)
	cases := []struct {
		name       string
		remoteAddr string
		headers    map[string]string
		want       bool
	}{
		{
			name:       "本机直连",
			remoteAddr: "127.0.0.1:54321",
			want:       true,
		},
		{
			name:       "浏览器经 Vite 代理",
			remoteAddr: "172.18.0.4:8080",
			headers:    map[string]string{"X-Forwarded-For": "127.0.0.1"},
			want:       true,
		},
		{
			name:       "局域网浏览器经 Vite 代理",
			remoteAddr: "172.18.0.4:8080",
			headers:    map[string]string{"X-Forwarded-For": "192.168.1.20"},
			want:       true,
		},
		{
			name:       "公网来源",
			remoteAddr: "8.8.8.8:443",
			want:       false,
		},
		{
			name:       "转发链中间出现公网地址",
			remoteAddr: "172.18.0.4:8080",
			headers:    map[string]string{"X-Forwarded-For": "203.0.113.9, 127.0.0.1"},
			want:       false,
		},
		{
			name:       "Cloudflare 隧道",
			remoteAddr: "172.18.0.4:8080",
			headers:    map[string]string{"CF-Connecting-IP": "203.0.113.9"},
			want:       false,
		},
		{
			name:       "无法解析的远端地址",
			remoteAddr: "not-an-ip",
			want:       false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest("GET", "/api/admin/git-update", nil)
			request.RemoteAddr = tc.remoteAddr
			for key, value := range tc.headers {
				request.Header.Set(key, value)
			}
			ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
			ctx.Request = request
			if got := privateNetworkOnly(ctx); got != tc.want {
				t.Fatalf("privateNetworkOnly() = %v, want %v", got, tc.want)
			}
		})
	}
}
