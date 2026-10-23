package database

import (
	"strings"
	"testing"
	"time"

	"yingce/backend/internal/model"

	"gorm.io/gorm"
)

// seedUpstreamUserFeedbacksDatabase 构造上游 1.6.9.2 的库状态：
// v1-v59 与 dev 一致，v60 是上游的 user_feedbacks（对应表已建好）。
func seedUpstreamUserFeedbacksDatabase(t *testing.T, dsn string) *gorm.DB {
	t.Helper()
	db, err := Open(Config{Driver: "sqlite", DSN: "file:" + dsn + "?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&schemaMigration{}, &model.UserFeedback{}); err != nil {
		t.Fatal(err)
	}
	for _, item := range schemaMigrations {
		if item.version >= 60 {
			break
		}
		if err := db.Create(&schemaMigration{Version: item.version, Name: item.name, Checksum: item.checksum, AppliedAt: time.Now().UTC()}).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Create(&schemaMigration{
		Version:   60,
		Name:      userFeedbacksMigrationName,
		Checksum:  userFeedbacksChecksum,
		AppliedAt: time.Now().UTC(),
	}).Error; err != nil {
		t.Fatal(err)
	}
	return db
}

func TestMigrateSchemaRelocatesUpstreamUserFeedbacksV60ToV62(t *testing.T) {
	db := seedUpstreamUserFeedbacksDatabase(t, "migration-user-feedbacks-upstream")
	if err := MigrateSchema(db); err != nil {
		t.Fatalf("migrate upstream user feedbacks database: %v", err)
	}
	for _, expected := range []struct {
		version  int64
		name     string
		checksum string
	}{
		{60, "design_documents", designDocumentsChecksum},
		{61, "homepage_agent_workflow", "sha256:homepage-agent-workflow-v61"},
		{62, userFeedbacksMigrationName, userFeedbacksChecksum},
	} {
		var record schemaMigration
		if err := db.First(&record, "version = ?", expected.version).Error; err != nil {
			t.Fatalf("v%d migration missing: %v", expected.version, err)
		}
		if record.Name != expected.name || record.Checksum != expected.checksum {
			t.Fatalf("v%d = %#v, want %s/%s", expected.version, record, expected.name, expected.checksum)
		}
	}
	var duplicate int64
	if err := db.Model(&schemaMigration{}).Where("name = ?", userFeedbacksMigrationName).Count(&duplicate).Error; err != nil {
		t.Fatal(err)
	}
	if duplicate != 1 {
		t.Fatalf("user feedbacks ledger rows = %d, want 1", duplicate)
	}
	if !db.Migrator().HasTable(&model.UserFeedback{}) {
		t.Fatal("user_feedbacks table lost during relocation")
	}
	if !db.Migrator().HasTable(&model.DesignDocument{}) {
		t.Fatal("design_documents table was not applied at v60")
	}
	status, err := ReadSchemaStatus(db)
	if err != nil {
		t.Fatal(err)
	}
	if !status.Ready || status.Current != CurrentSchemaVersion {
		t.Fatalf("unexpected schema status: %#v", status)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatalf("second migrate must be a no-op: %v", err)
	}
}

func TestMigrateSchemaAdvancesDevDatabaseToUserFeedbacksV62(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:migration-user-feedbacks-dev?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatalf("migrate dev database: %v", err)
	}
	var design schemaMigration
	if err := db.First(&design, "version = ?", 60).Error; err != nil {
		t.Fatalf("dev v60 migration missing: %v", err)
	}
	if design.Name != "design_documents" || design.Checksum != designDocumentsChecksum {
		t.Fatalf("dev v60 must stay design_documents: %#v", design)
	}
	var feedback schemaMigration
	if err := db.First(&feedback, "version = ?", 62).Error; err != nil {
		t.Fatalf("dev v62 migration missing: %v", err)
	}
	if feedback.Name != userFeedbacksMigrationName || feedback.Checksum != userFeedbacksChecksum {
		t.Fatalf("dev v62 must be user_feedbacks: %#v", feedback)
	}
	if !db.Migrator().HasTable(&model.DesignDocument{}) || !db.Migrator().HasTable(&model.UserFeedback{}) {
		t.Fatal("dev schema is missing design_documents or user_feedbacks")
	}
}

func TestMigrateSchemaRejectsForeignUserFeedbacksLedger(t *testing.T) {
	for _, testCase := range []struct {
		name    string
		ledgers []schemaMigration
		message string
	}{
		{
			name: "checksum mismatch",
			ledgers: []schemaMigration{
				{Version: 60, Name: userFeedbacksMigrationName, Checksum: "sha256:user-feedbacks-unknown"},
			},
			message: "拒绝自动改写迁移账本",
		},
		{
			name: "target version occupied",
			ledgers: []schemaMigration{
				{Version: 60, Name: userFeedbacksMigrationName, Checksum: userFeedbacksChecksum},
				{Version: 62, Name: "unexpected_migration", Checksum: "sha256:unexpected-v62"},
			},
			message: "拒绝自动改写迁移账本",
		},
		{
			name: "table missing",
			ledgers: []schemaMigration{
				{Version: 60, Name: userFeedbacksMigrationName, Checksum: userFeedbacksChecksum},
			},
			message: "用户反馈表不存在",
		},
	} {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			db, err := Open(Config{Driver: "sqlite", DSN: "file:migration-user-feedbacks-conflict-" + strings.ReplaceAll(testCase.name, " ", "-") + "?mode=memory&cache=shared"})
			if err != nil {
				t.Fatal(err)
			}
			if err := db.AutoMigrate(&schemaMigration{}); err != nil {
				t.Fatal(err)
			}
			if testCase.name != "table missing" {
				if err := db.AutoMigrate(&model.UserFeedback{}); err != nil {
					t.Fatal(err)
				}
			}
			for _, ledger := range testCase.ledgers {
				copied := ledger
				copied.AppliedAt = time.Now().UTC()
				if err := db.Create(&copied).Error; err != nil {
					t.Fatal(err)
				}
			}
			err = MigrateSchema(db)
			if err == nil || !strings.Contains(err.Error(), testCase.message) {
				t.Fatalf("expected %q rejection, got %v", testCase.message, err)
			}
		})
	}
}
