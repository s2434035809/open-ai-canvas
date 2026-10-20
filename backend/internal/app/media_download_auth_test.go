package app

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"yingce/backend/internal/protocol"
)

// Host-initiated result downloads must reuse the auth a declarative protocol
// declared in its manifest. Ticket-protected media endpoints reject the generic
// bearer header, so regressing here silently breaks saving successful results.
func TestSameOriginMediaDownloadUsesProtocolAuth(t *testing.T) {
	allowLoopbackProviderTest(t)

	var observed http.Header
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		observed = r.Header.Clone()
		if r.Header.Get("X-Api-Key") != "secret-key" {
			w.WriteHeader(http.StatusForbidden)
			_, _ = io.WriteString(w, `{"error":{"code":"invalid_ticket"}}`)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(mediaTestPNG(t))
	}))
	defer server.Close()

	adapter, err := protocol.LoadManifest([]byte(`{
		"apiVersion":"yingce.plugin/v1",
		"id":"test-manifest-auth","version":"1.0.0","name":"Test Manifest Auth","author":"Test","documentation":"# Test",
		"contributes":{"providers":[{"id":"test-manifest-auth","label":"Test Manifest Auth","capabilities":["image"],"scopes":["canvas"],
		"auth":{"type":"header","field":"apiKey","header":"X-Api-Key"},
		"create":{"method":"POST","path":"/images/tasks"},"poll":{"method":"GET","path":"/images/tasks/{{taskId}}"},
		"response":{"taskIdPaths":["id"],"statusPaths":["status"],"resultPaths":["images"],"resultKind":"image"}}]}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	registry, err := protocol.NewRegistry(adapter)
	if err != nil {
		t.Fatal(err)
	}

	s, _ := newMediaRecoveryTestService(t)
	ctx := withProtocolRegistry(context.Background(), registry)
	config := providerConfig{BaseURL: server.URL, APIKey: "secret-key", InterfaceType: "test-manifest-auth"}

	name, mimeType, err := s.downloadTaskMedia(ctx, config, server.URL+"/api/open/v1/media/result-1-0?ticket=abc", "image")
	if err != nil {
		t.Fatalf("download failed: %v (headers=%v)", err, observed)
	}
	if mimeType != "image/png" || name == "" {
		t.Fatalf("mimeType=%q name=%q", mimeType, name)
	}
	if got := observed.Get("Authorization"); got != "" {
		t.Fatalf("protocol download leaked generic bearer auth: %q", got)
	}
	if got := observed.Get("X-Api-Key"); got != "secret-key" {
		t.Fatalf("protocol download auth = %q, want manifest header", got)
	}
}

// Channels whose protocol declares bearer auth (or whose interface has no
// declarative adapter) keep the previous bearer behaviour.
func TestSameOriginMediaDownloadFallsBackToBearer(t *testing.T) {
	allowLoopbackProviderTest(t)

	var observed http.Header
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		observed = r.Header.Clone()
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(mediaTestPNG(t))
	}))
	defer server.Close()

	s, _ := newMediaRecoveryTestService(t)
	ctx := withProviderRequestKind(context.Background(), "download")
	config := providerConfig{BaseURL: server.URL, APIKey: "secret-key", InterfaceType: "openai-image"}

	if _, _, err := s.downloadTaskMedia(ctx, config, server.URL+"/v1/files/result.png", "image"); err != nil {
		t.Fatalf("download failed: %v", err)
	}
	if got := observed.Get("Authorization"); got != "Bearer secret-key" {
		t.Fatalf("bearer fallback = %q, want Bearer secret-key", got)
	}
}
