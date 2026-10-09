package repository

import (
	"errors"
	"testing"

	"yingce/backend/internal/model"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func newGetCanvasTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	return db
}

// 自托管部署里没有旧 canvas 表，画布数据都在 canvas_projects。
// GetCanvas 曾经只查旧表，Agent 权限构建因此失败并退化成只读权限。
func TestGetCanvasReadsCanvasProjectsWithoutLegacyTable(t *testing.T) {
	db := newGetCanvasTestDB(t)
	if err := db.AutoMigrate(&model.CanvasProject{}); err != nil {
		t.Fatalf("migrate canvas_projects: %v", err)
	}
	repo := New(db)
	if err := db.Create(&model.CanvasProject{ID: "canvas-1", UserID: "user-1", Title: "画布"}).Error; err != nil {
		t.Fatalf("seed canvas project: %v", err)
	}

	canvas, err := repo.GetCanvas("user-1", "canvas-1")
	if err != nil {
		t.Fatalf("GetCanvas returned error: %v", err)
	}
	if canvas.ID != "canvas-1" || canvas.UserID != "user-1" || canvas.Name != "画布" {
		t.Fatalf("unexpected canvas: %#v", canvas)
	}
}

func TestGetCanvasMissingCanvasIsRecordNotFound(t *testing.T) {
	db := newGetCanvasTestDB(t)
	if err := db.AutoMigrate(&model.CanvasProject{}); err != nil {
		t.Fatalf("migrate canvas_projects: %v", err)
	}
	repo := New(db)

	if _, err := repo.GetCanvas("user-1", "missing"); !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("expected ErrRecordNotFound, got %v", err)
	}
}

// 旧表存在时回退查询不能再冒出“no such table”，也不该把缺行包装成 500。
// 注：legacy 表有行时的扫描路径依赖 glebarez 驱动（生产用），cgo 测试驱动无法扫描
// metadata 的 map 列，所以这里只覆盖“旧表存在但缺行”的分支。
func TestGetCanvasWithLegacyTableReturnsRecordNotFound(t *testing.T) {
	db := newGetCanvasTestDB(t)
	if err := db.AutoMigrate(&model.CanvasProject{}, &model.Canvas{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	repo := New(db)

	if _, err := repo.GetCanvas("user-1", "missing"); !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("expected ErrRecordNotFound, got %v", err)
	}
}
