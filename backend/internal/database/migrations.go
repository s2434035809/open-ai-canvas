package database

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"yingce/backend/internal/model"

	"gorm.io/gorm"
)

const CurrentSchemaVersion int64 = 61

const baselineSchemaChecksum = "sha256:open-ai-canvas-schema-v1-20260830"
const schemaMigrationAppliedAtIndexChecksum = "sha256:schema-migrations-applied-at-index-v2-20260830"
const assetTaxonomyCandidateIdentityChecksum = "sha256:asset-taxonomy-candidate-identity-v3-20260831-r1"
const resourceUploadKeyChecksum = "sha256:resource-upload-key-v4-20260901"
const paymentTopupChecksum = "sha256:payment-topup-v5-20260902"
const resourcePlaybackChecksum = "sha256:resource-playback-v6-20260902"
const assetLibraryFoldersChecksum = "sha256:asset-library-folders-v6-20260902"
const logicalModelActiveCodeChecksum = "sha256:logical-model-active-code-v8-20260905"
const creationRuntimeChecksum = "sha256:creation-runtime-v10-20260909"
const authNotificationsChecksum = "sha256:auth-notifications-v35-20260924"
const cloudAgentGeminiCacheChecksum = "sha256:cloud-agent-gemini-cache-v36-20260924"
const cloudAgentGeminiCacheIdentityChecksum = "sha256:cloud-agent-gemini-cache-identity-v37-20260925"
const prefixedIDSequenceReconcileChecksum = "sha256:prefixed-id-sequence-reconcile-v38-20260926"
const skillLibraryCategoriesChecksum = "sha256:skill-library-categories-v39-20260926"
const builtinSkillTombstonesChecksum = "sha256:builtin-skill-tombstones-v40-20260927"
const resourceThumbnailChecksum = "sha256:resource-thumbnail-v41-20260927"
const workbenchToolsMigrationName = "workbench_tools_and_presets"
const workbenchToolsMigrationChecksum = "sha256:workbench-tools-presets-v54-20261014"
const legacyWorkbenchToolsMigrationChecksum = "sha256:workbench-tools-presets-v51-20261014"

// designDocumentsChecksum 保持历史字符串不变：账本身份是已落库数据的一部分，
// 改名会让已升级的库在 checksum 校验阶段拒绝启动。版本号由 v59 顺延到 v60，
// 但记录身份沿用旧值。
const designDocumentsChecksum = "sha256:design-documents-v59-20261021"

// legacyDesignDocumentsChecksum 是本仓库早期把 design_documents 记在 v58 的账本身份。
// 上游 v58 被 agent_memory_proposals、v59 被 channel_model_protocol_length 占用后，
// 该记录必须精确归一化到 v60。
const legacyDesignDocumentsChecksum = "sha256:design-documents-v58-20261021"

const postgresSchemaMigrationLockID int64 = 73123910420260830

type SchemaStatus struct {
	Current  int64 `json:"current"`
	Expected int64 `json:"expected"`
	Ready    bool  `json:"ready"`
}

type schemaMigration struct {
	Version   int64     `gorm:"primaryKey"`
	Name      string    `gorm:"size:160;not null"`
	Checksum  string    `gorm:"size:96;not null"`
	AppliedAt time.Time `gorm:"not null"`
}

func (schemaMigration) TableName() string { return "schema_migrations" }

type migration struct {
	version  int64
	name     string
	checksum string
	apply    func(*gorm.DB) error
}

var schemaMigrations = []migration{
	// 44 and 45 are reserved for independent migrations.
	{version: 1, name: "baseline_gorm_schema", checksum: baselineSchemaChecksum, apply: migrateSchemaV1},
	{version: 2, name: "schema_migrations_applied_at_index", checksum: schemaMigrationAppliedAtIndexChecksum, apply: migrateSchemaV2},
	{version: 3, name: "asset_taxonomy_candidate_identity", checksum: assetTaxonomyCandidateIdentityChecksum, apply: migrateSchemaV3},
	{version: 4, name: "resource_upload_key", checksum: resourceUploadKeyChecksum, apply: migrateSchemaV4},
	{version: 5, name: "payment_topup", checksum: paymentTopupChecksum, apply: migrateSchemaV5},
	{version: 6, name: "resource_playback_variant", checksum: resourcePlaybackChecksum, apply: migrateSchemaV6},
	{version: 7, name: "asset_library_folders", checksum: assetLibraryFoldersChecksum, apply: migrateSchemaV7},
	{version: 8, name: "logical_model_active_code", checksum: logicalModelActiveCodeChecksum, apply: migrateSchemaV8},
	{version: 9, name: "channel_presentation", checksum: "sha256:channel-presentation-v9-20260908", apply: migrateChannelPresentation},
	{version: 10, name: "creation_runtime", checksum: creationRuntimeChecksum, apply: migrateSchemaV10},
	{version: 11, name: "cloud_agent_runtime", checksum: "sha256:cloud-agent-runtime-v11-20260912", apply: func(tx *gorm.DB) error { return tx.AutoMigrate(&model.CloudAgentExecution{}) }},
	{version: 12, name: "agent_token_charge_limit", checksum: "sha256:agent-token-charge-limit-v12-20260913", apply: migrateSchemaV12},
	{version: 13, name: "cloud_agent_canvas_mutation", checksum: "sha256:cloud-agent-canvas-mutation-v13-20260913", apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.CloudAgentCanvasMutation{})
	}},
	{version: 14, name: "cloud_agent_recovery_control", checksum: "sha256:cloud-agent-recovery-control-v14", apply: migrateSchemaV14},
	{version: 15, name: "agent_profiles", checksum: "sha256:agent-profiles-v15-20260914", apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.AgentProfile{})
	}},
	{version: 16, name: "agent_lessons", checksum: "sha256:agent-lessons-v16-20260917", apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.AgentLesson{})
	}},
	{version: 17, name: "agent_lessons_owner_index", checksum: "sha256:agent-lessons-owner-index-v17-20260917", apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.AgentLesson{})
	}},
	{version: 18, name: "agent_memory_settings", checksum: "sha256:agent-memory-settings-v18-20260917", apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.AgentMemorySetting{})
	}},
	{version: 19, name: "payment_plugin_version", checksum: "sha256:payment-plugin-version-v19-20260917", apply: migrateSchemaV19},
	{version: 20, name: "banner_announcements", checksum: "sha256:banner-announcements-v20-20260917", apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.BannerAnnouncement{})
	}},
	{version: 21, name: "banner_announcement_title_runs", checksum: "sha256:banner-announcement-title-runs-v21-20260917", apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.BannerAnnouncement{})
	}},
	{version: 22, name: "banner_announcement_notice_type", checksum: "sha256:banner-announcement-notice-type-v22-20260917", apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.BannerAnnouncement{})
	}},
	{version: 23, name: "canvas_revision_history", checksum: "sha256:canvas-revision-history-v23-20260918", apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.CanvasProject{}, &model.CanvasSnapshot{}, &model.CanvasSnapshotResource{})
	}},
	{version: 24, name: "channel_model_label", checksum: "sha256:channel-model-label-v24", apply: migrateChannelModelLabel},
	{version: 25, name: "video_token_formula_snapshot", checksum: "sha256:video-token-formula-snapshot-v25", apply: migrateVideoTokenFormulaSnapshot},
	{version: 26, name: "channel_model_description", checksum: "sha256:channel-model-description-v26", apply: migrateChannelModelDescription},
	{version: 27, name: "channel_credit_cost", checksum: "sha256:channel-credit-cost-v27", apply: migrateChannelCreditCost},
	{version: 28, name: "agent_execution_journal", checksum: "sha256:agent-execution-journal-v28", apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.CloudAgentExecution{}, &model.CloudAgentEventRecord{}, &model.CloudAgentMessageRecord{}, &model.Task{}, &model.BillingOrder{})
	}},
	{version: 29, name: "agent_resource_leases", checksum: "sha256:agent-resource-leases-v29-20260919", apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.CloudAgentResourceLease{})
	}},
	{version: 30, name: "builtin_tools", checksum: "sha256:builtin-tools-v30", apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.Tool{})
	}},
	{version: 31, name: "tool_favorites", checksum: "sha256:tool-favorites-v31", apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.ToolFavorite{})
	}},
	{version: 32, name: "channel_model_tags", checksum: "sha256:channel-model-tags-v32", apply: migrateChannelModelTags},
	{version: 33, name: "oauth_state_accepted_terms", checksum: "sha256:oauth-state-accepted-terms-v33", apply: migrateOAuthStateAcceptedTerms},
	{version: 34, name: "task_media_recovery", checksum: "sha256:task-media-recovery-v34", apply: func(tx *gorm.DB) error {
		for _, field := range []string{"MediaRecoveryJSON", "MediaStage"} {
			if !tx.Migrator().HasColumn(&model.Task{}, field) {
				if err := tx.Migrator().AddColumn(&model.Task{}, field); err != nil {
					return err
				}
			}
		}
		return nil
	}},
	{version: 35, name: "auth_notifications", checksum: authNotificationsChecksum, apply: migrateSchemaV35},
	{version: 36, name: "cloud_agent_gemini_cache", checksum: cloudAgentGeminiCacheChecksum, apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.CloudAgentGeminiCache{})
	}},
	{version: 37, name: "cloud_agent_gemini_cache_identity", checksum: cloudAgentGeminiCacheIdentityChecksum, apply: migrateCloudAgentGeminiCacheIdentity},
	{version: 38, name: "prefixed_id_sequence_reconcile", checksum: prefixedIDSequenceReconcileChecksum, apply: migratePrefixedIDSequenceReconcile},
	{version: 39, name: "skill_library_categories", checksum: skillLibraryCategoriesChecksum, apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.SkillLibraryCategory{}, &model.UserSkillState{})
	}},
	{version: 40, name: "builtin_skill_tombstones", checksum: builtinSkillTombstonesChecksum, apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.BuiltinSkillTombstone{})
	}},
	{version: 41, name: "resource_thumbnail", checksum: resourceThumbnailChecksum, apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.Resource{})
	}},
	{version: 42, name: "cloud_agent_pi_sessions", checksum: "sha256:cloud-agent-pi-sessions-v42-20260928", apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.CloudAgentPiSession{})
	}},
	{version: 43, name: "topup_sale_strategies", checksum: "sha256:topup-sale-strategies-v43-20260929", apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.TopupProduct{}, &model.PaymentOrder{})
	}},
	// v44 曾创建 portfolio_documents。作品集插件已移除，这里保留历史版本身份
	// 以满足迁移账本校验；新装环境不再建表，已装环境保留旧表数据不做破坏性删除。
	{version: 44, name: "portfolio_documents", checksum: "sha256:portfolio-documents-v44-20260929", apply: func(tx *gorm.DB) error {
		return nil
	}},
	{version: 45, name: "upload_reservations", checksum: "sha256:upload-reservations-v45-20261005", apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.UploadReservation{})
	}},
	{version: 46, name: "skill_curation", checksum: "sha256:skill-curation-v46-20261005", apply: migrateSkillCuration},
	{version: 47, name: "skill_curation_roots", checksum: "sha256:skill-curation-roots-v47-20261005", apply: migrateSkillCurationRoots},
	{version: 48, name: "channel_proxy_url", checksum: "sha256:channel-proxy-url-v48-20261009", apply: func(tx *gorm.DB) error {
		if !tx.Migrator().HasColumn(&model.ModelChannel{}, "ProxyURL") {
			return tx.Migrator().AddColumn(&model.ModelChannel{}, "ProxyURL")
		}
		return nil
	}},
	{version: 49, name: "banner_sort_order", checksum: "sha256:banner-sort-order-v49-20261010", apply: func(tx *gorm.DB) error {
		if !tx.Migrator().HasColumn(&model.BannerAnnouncement{}, "SortOrder") {
			return tx.Migrator().AddColumn(&model.BannerAnnouncement{}, "SortOrder")
		}
		return nil
	}},
	{version: 50, name: "canvas_mutation_receipts", checksum: "sha256:canvas-mutation-receipts-v50-20261011", apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.CanvasMutationReceipt{})
	}},
	{version: 51, name: "personal_profile_security", checksum: "sha256:personal-profile-security-v51-20261012", apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.User{}, &model.AuthSession{}, &model.OAuthState{}, &model.AuthVerification{}, &model.UserAvatar{})
	}},
	{version: 52, name: "user_avatar_presets", checksum: "sha256:user-avatar-presets-v52-20261012", apply: func(tx *gorm.DB) error {
		if tx.Migrator().HasColumn(&model.User{}, "AvatarPreset") {
			return nil
		}
		return tx.Migrator().AddColumn(&model.User{}, "AvatarPreset")
	}},
	{version: 53, name: "user_login_logs", checksum: "sha256:user-login-logs-v53", apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.LoginLog{})
	}},
	{version: 54, name: workbenchToolsMigrationName, checksum: workbenchToolsMigrationChecksum, apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.WorkbenchTool{}, &model.WorkbenchPreset{}, &model.Task{})
	}},
	{version: 55, name: "provider_catalog_source", checksum: "sha256:provider-catalog-source-v55", apply: func(tx *gorm.DB) error {
		if !tx.Migrator().HasColumn(&model.ModelChannel{}, "CatalogProviderID") {
			if err := tx.Migrator().AddColumn(&model.ModelChannel{}, "CatalogProviderID"); err != nil {
				return err
			}
		}
		if !tx.Migrator().HasColumn(&model.ChannelModel{}, "CatalogModelKey") {
			return tx.Migrator().AddColumn(&model.ChannelModel{}, "CatalogModelKey")
		}
		return nil
	}},
	{version: 56, name: "sql_perf_indexes", checksum: "sha256:sql-perf-indexes-v56-20261016", apply: migrateSchemaV56},
	{version: 57, name: "canvas_multi_session_sync", checksum: "sha256:canvas-multi-session-sync-v57", apply: migrateCanvasCollaboration},
	{version: 58, name: "agent_memory_proposals", checksum: "sha256:agent-memory-proposals-v58", apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.AgentLesson{}, &model.AgentMemorySetting{}, &model.AgentMemoryProposal{}, &model.AgentMemoryRevision{})
	}},
	{version: 59, name: "channel_model_protocol_length", checksum: "sha256:channel-model-protocol-length-v59", apply: migrateChannelModelProtocolLength},
	{version: 60, name: "design_documents", checksum: designDocumentsChecksum, apply: func(tx *gorm.DB) error {
		return tx.AutoMigrate(&model.DesignDocument{})
	}},
	// 首页 Agent 工作流的表结构来自上游 PR #823；dev 已占用 v58-v60，这里顺延为 v61。
	{version: 61, name: "homepage_agent_workflow", checksum: "sha256:homepage-agent-workflow-v61", apply: migrateHomepageAgentWorkflow},
}

func migrateChannelModelProtocolLength(tx *gorm.DB) error {
	if tx.Dialector.Name() == "postgres" {
		return tx.Exec("ALTER TABLE channel_models ALTER COLUMN protocol TYPE varchar(64)").Error
	}
	return tx.Migrator().AlterColumn(&model.ChannelModel{}, "Protocol")
}

func migratePrefixedIDSequenceReconcile(tx *gorm.DB) error {
	if err := tx.AutoMigrate(&model.IDSequence{}); err != nil {
		return fmt.Errorf("创建可读 ID 序列表：%w", err)
	}
	return reconcilePrefixedIDSequences(tx)
}

func migrateCloudAgentGeminiCacheIdentity(tx *gorm.DB) error {
	// v36 accidentally made cache_key globally unique while repository reads and
	// writes are user-scoped. Remove that index before creating the explicit
	// (user_id, cache_key) identity used by the model tags.
	for _, name := range []string{"idx_cloud_agent_gemini_caches_cache_key", "idx_cloud_agent_gemini_cache_cache_key"} {
		if tx.Migrator().HasIndex(&model.CloudAgentGeminiCache{}, name) {
			if err := tx.Migrator().DropIndex(&model.CloudAgentGeminiCache{}, name); err != nil {
				return fmt.Errorf("删除 Gemini 缓存旧唯一索引 %s：%w", name, err)
			}
		}
	}
	return tx.AutoMigrate(&model.CloudAgentGeminiCache{})
}

func migrateChannelModelTags(tx *gorm.DB) error {
	if tx.Migrator().HasColumn(&model.ChannelModel{}, "Tags") {
		return nil
	}
	return tx.Migrator().AddColumn(&model.ChannelModel{}, "Tags")
}

func migrateOAuthStateAcceptedTerms(tx *gorm.DB) error {
	if tx.Migrator().HasColumn(&model.OAuthState{}, "AcceptedTerms") {
		return nil
	}
	return tx.Migrator().AddColumn(&model.OAuthState{}, "AcceptedTerms")
}

func migrateChannelCreditCost(tx *gorm.DB) error {
	for _, entity := range []any{&model.ChannelModelPriceTier{}, &model.BillingOrder{}} {
		for _, column := range []string{"cost_configured", "cost_unit_price_microcredits", "cost_input_token_price_microcredits", "cost_output_token_price_microcredits", "cost_cached_token_price_microcredits"} {
			if !tx.Migrator().HasColumn(entity, column) {
				if err := tx.Migrator().AddColumn(entity, column); err != nil {
					return err
				}
			}
		}
	}
	for _, column := range []string{"CostBillingMode", "CostQuantity", "CostVideoFormulaTokens"} {
		if !tx.Migrator().HasColumn(&model.BillingOrder{}, column) {
			if err := tx.Migrator().AddColumn(&model.BillingOrder{}, column); err != nil {
				return err
			}
		}
	}
	return nil
}

func migrateChannelModelDescription(tx *gorm.DB) error {
	if tx.Migrator().HasColumn(&model.ChannelModel{}, "Description") {
		return nil
	}
	return tx.Migrator().AddColumn(&model.ChannelModel{}, "Description")
}

func migrateVideoTokenFormulaSnapshot(tx *gorm.DB) error {
	for _, field := range []string{"VideoFormulaTokens", "UsageSource"} {
		if !tx.Migrator().HasColumn(&model.BillingOrder{}, field) {
			if err := tx.Migrator().AddColumn(&model.BillingOrder{}, field); err != nil {
				return fmt.Errorf("增加视频 Token 结算字段 %s：%w", field, err)
			}
		}
	}
	return nil
}

func migrateChannelModelLabel(tx *gorm.DB) error {
	if tx.Migrator().HasColumn(&model.ChannelModel{}, "ChannelLabel") {
		return nil
	}
	return tx.Migrator().AddColumn(&model.ChannelModel{}, "ChannelLabel")
}

func migrateSchemaV14(tx *gorm.DB) error {
	if err := tx.AutoMigrate(&model.CloudAgentExecution{}); err != nil {
		return err
	}
	// Keep cancellation recoverable for executions admitted before this schema.
	// Bound memory while retaining the migration transaction's all-or-nothing semantics.
	after := ""
	for {
		var runs []model.CloudAgentExecution
		if err := tx.Where("id > ? AND status <> ?", after, "completed").Order("id ASC").Limit(100).Find(&runs).Error; err != nil {
			return err
		}
		if len(runs) == 0 {
			return nil
		}
		for _, run := range runs {
			var state struct {
				Request struct {
					CanvasID string `json:"canvasId"`
				} `json:"request"`
				ActiveTaskID string `json:"activeTaskId"`
				MediaTaskID  string `json:"mediaTaskId"`
			}
			// The root task ID is always a safe cancellation anchor. If an old
			// transcript is damaged, retain a durable warning and cancel that
			// root task during recovery instead of blocking the whole deployment.
			updates := map[string]any{"active_task_id": run.ID}
			if err := json.Unmarshal([]byte(run.StateJSON), &state); err != nil {
				updates["failure_message"] = "旧 Agent 运行记录损坏，已保留根任务并进入安全收尾；请核对任务中心"
			} else {
				updates["canvas_id"] = state.Request.CanvasID
				if state.ActiveTaskID != "" {
					updates["active_task_id"] = state.ActiveTaskID
				}
				updates["media_task_id"] = state.MediaTaskID
			}
			if run.Status == "cancelled" || run.Status == "failed" {
				updates["cleanup_pending"] = true
			}
			if err := tx.Model(&model.CloudAgentExecution{}).Where("id = ?", run.ID).Updates(updates).Error; err != nil {
				return err
			}
			after = run.ID
		}
	}
}

func migrateChannelPresentation(tx *gorm.DB) error {
	for _, column := range []struct {
		model any
		field string
	}{{&model.ModelChannel{}, "PublicAlias"}, {&model.ModelChannel{}, "SortOrder"}, {&model.ChannelModel{}, "SortOrder"}} {
		if !tx.Migrator().HasColumn(column.model, column.field) {
			if err := tx.Migrator().AddColumn(column.model, column.field); err != nil {
				return err
			}
		}
	}
	return nil
}

func migrationsForDatabase(db *gorm.DB) ([]migration, error) {
	var applied schemaMigration
	err := db.First(&applied, "version = ?", 6).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return schemaMigrations, nil
	}
	if err != nil {
		return nil, fmt.Errorf("读取数据库迁移 6：%w", err)
	}
	if applied.Name != "asset_library_folders" {
		return schemaMigrations, nil
	}
	legacy := migration{version: 6, name: "asset_library_folders", checksum: assetLibraryFoldersChecksum, apply: migrateSchemaV7}
	if err := validateMigrationRecord(applied, legacy); err != nil {
		return nil, err
	}
	plan := append([]migration(nil), schemaMigrations...)
	for index, item := range plan {
		switch item.version {
		case 6:
			plan[index] = legacy
		case 7:
			plan[index] = migration{version: 7, name: "resource_playback_variant", checksum: resourcePlaybackChecksum, apply: migrateSchemaV6}
		}
	}
	return plan, nil
}

func migrateSchemaV2(tx *gorm.DB) error {
	return tx.Exec("CREATE INDEX IF NOT EXISTS idx_schema_migrations_applied_at ON schema_migrations (applied_at)").Error
}

func migrateSchemaV3(tx *gorm.DB) error {
	if err := tx.AutoMigrate(&model.ProjectAssetCandidate{}); err != nil {
		return fmt.Errorf("扩展资产候选身份字段：%w", err)
	}
	if err := tx.Exec("UPDATE assets SET category = 'prop' WHERE category IN ('wardrobe', 'weapon', 'accessory')").Error; err != nil {
		return fmt.Errorf("合并资产道具分类：%w", err)
	}
	if err := tx.Exec("UPDATE assets SET category = 'material' WHERE category = 'style' OR (category = 'other' AND kind IN ('image', 'video', 'audio', 'model'))").Error; err != nil {
		return fmt.Errorf("迁移资产素材分类：%w", err)
	}
	if err := tx.Exec("UPDATE project_asset_candidates SET category = 'prop' WHERE category IN ('wardrobe', 'weapon', 'accessory')").Error; err != nil {
		return fmt.Errorf("合并候选道具分类：%w", err)
	}
	if err := tx.Exec("UPDATE project_asset_candidates SET category = 'material' WHERE category = 'style'").Error; err != nil {
		return fmt.Errorf("迁移候选素材分类：%w", err)
	}
	var candidates []model.ProjectAssetCandidate
	if err := tx.Order("created_at asc, id asc").Find(&candidates).Error; err != nil {
		return fmt.Errorf("读取资产候选身份：%w", err)
	}
	seenPending := make(map[string]string, len(candidates))
	for _, candidate := range candidates {
		nameKey := model.AssetCandidateNameKey(candidate.Name)
		updates := map[string]any{"name_key": nameKey}
		identity := candidate.ProjectID + ":" + string(candidate.Category) + ":" + nameKey
		if candidate.Status == "pending_confirmation" && nameKey != "" {
			if _, exists := seenPending[identity]; exists {
				updates["status"] = "ignored"
			} else {
				seenPending[identity] = candidate.ID
			}
		}
		if err := tx.Model(&model.ProjectAssetCandidate{}).Where("id = ?", candidate.ID).Updates(updates).Error; err != nil {
			return fmt.Errorf("回填资产候选身份 %s：%w", candidate.ID, err)
		}
	}
	return tx.Exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_project_asset_candidates_pending_identity ON project_asset_candidates(project_id, category, name_key) WHERE status = 'pending_confirmation' AND name_key <> ''").Error
}

func migrateSchemaV4(tx *gorm.DB) error {
	if !tx.Migrator().HasTable(&model.Resource{}) {
		return fmt.Errorf("资源表不存在")
	}
	if !tx.Migrator().HasColumn(&model.Resource{}, "upload_key") {
		if err := tx.Migrator().AddColumn(&model.Resource{}, "UploadKey"); err != nil {
			return fmt.Errorf("增加资源上传幂等列：%w", err)
		}
	}
	if err := tx.Exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_resources_user_upload_key ON resources (user_id, upload_key)").Error; err != nil {
		return fmt.Errorf("创建资源上传幂等索引：%w", err)
	}
	return nil
}
func migrateSchemaV5(tx *gorm.DB) error {
	if err := tx.AutoMigrate(
		&model.CreditLedgerEntry{},
		&model.TopupProduct{},
		&model.PaymentProviderConfig{},
		&model.PaymentOrder{},
		&model.PaymentNotification{},
		&model.PaymentReconciliationRun{},
		&model.PaymentReconciliationItem{},
	); err != nil {
		return fmt.Errorf("创建积分支付与对账结构：%w", err)
	}
	return nil
}

func migrateSchemaV19(tx *gorm.DB) error {
	for _, value := range []any{&model.PaymentProviderConfig{}, &model.PaymentOrder{}} {
		if !tx.Migrator().HasTable(value) {
			continue
		}
		if err := addPaymentPluginVersionColumn(tx, value); err != nil {
			return err
		}
	}
	return nil
}

func addPaymentPluginVersionColumn(tx *gorm.DB, value any) error {
	if tx.Migrator().HasColumn(value, "plugin_version") {
		return nil
	}
	if err := tx.Migrator().AddColumn(value, "PluginVersion"); err != nil {
		return fmt.Errorf("增加支付插件版本列：%w", err)
	}
	return nil
}

func migrateSchemaV6(tx *gorm.DB) error {
	if !tx.Migrator().HasTable(&model.Resource{}) {
		return fmt.Errorf("资源表不存在")
	}
	if !tx.Migrator().HasColumn(&model.Resource{}, "playback_status") {
		if err := tx.Migrator().AddColumn(&model.Resource{}, "PlaybackStatus"); err != nil {
			return fmt.Errorf("增加播放副本状态列：%w", err)
		}
	}
	if !tx.Migrator().HasColumn(&model.Resource{}, "playback_object_key") {
		if err := tx.Migrator().AddColumn(&model.Resource{}, "PlaybackObjectKey"); err != nil {
			return fmt.Errorf("增加播放副本对象键列：%w", err)
		}
	}
	if !tx.Migrator().HasColumn(&model.Resource{}, "playback_error") {
		if err := tx.Migrator().AddColumn(&model.Resource{}, "PlaybackError"); err != nil {
			return fmt.Errorf("增加播放副本错误列：%w", err)
		}
	}
	return nil
}

func migrateSchemaV7(tx *gorm.DB) error {
	if err := tx.AutoMigrate(&model.Asset{}, &model.AssetFolder{}); err != nil {
		return fmt.Errorf("创建个人素材分类并扩展素材目录字段：%w", err)
	}
	return nil
}

func migrateSchemaV8(tx *gorm.DB) error {
	if !tx.Migrator().HasTable(&model.LogicalModel{}) {
		return nil
	}
	if err := tx.Exec("DROP INDEX IF EXISTS idx_logical_models_code").Error; err != nil {
		return fmt.Errorf("移除前台模型旧 code 唯一索引：%w", err)
	}
	if err := tx.Exec("CREATE UNIQUE INDEX idx_logical_models_code ON logical_models(code) WHERE archived_at IS NULL").Error; err != nil {
		return fmt.Errorf("创建前台模型活动 code 唯一索引：%w", err)
	}
	return nil
}

// migrateSchemaV10 只增加创作运行时表和任务幂等关联；旧任务的空 submission ID 必须继续合法。
func migrateSchemaV10(tx *gorm.DB) error {
	if err := tx.AutoMigrate(&model.CreationRun{}, &model.CreationSubmission{}, &model.Task{}); err != nil {
		return fmt.Errorf("创建创作运行时结构：%w", err)
	}
	return nil
}

// migrateSchemaV12 为 Agent 的 Token 计费增加最终扣费上限；旧账单保持 0，继续沿用既有按 usage 结算语义。
func migrateSchemaV12(tx *gorm.DB) error {
	if !tx.Migrator().HasTable(&model.BillingOrder{}) {
		return nil
	}
	if tx.Migrator().HasColumn(&model.BillingOrder{}, "ChargeLimitMicrocredits") {
		return nil
	}
	if err := tx.Migrator().AddColumn(&model.BillingOrder{}, "ChargeLimitMicrocredits"); err != nil {
		return fmt.Errorf("增加 Agent Token 扣费上限列：%w", err)
	}
	return nil
}

func normalizeLegacyWorkbenchMigration(tx *gorm.DB) error {
	var legacy schemaMigration
	if err := tx.First(&legacy, "version = ?", 51).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		return fmt.Errorf("读取旧工作台迁移记录：%w", err)
	}
	if legacy.Name != workbenchToolsMigrationName || legacy.Checksum != legacyWorkbenchToolsMigrationChecksum {
		return nil
	}

	var later []schemaMigration
	if err := tx.Where("version > ?", legacy.Version).Order("version asc").Find(&later).Error; err != nil {
		return fmt.Errorf("读取旧工作台迁移后的记录：%w", err)
	}
	if len(later) > 0 {
		return fmt.Errorf("数据库迁移 51 使用旧工作台身份，但已存在后续迁移记录 %d；拒绝自动改写迁移账本", later[0].Version)
	}
	if !tx.Migrator().HasTable(&model.WorkbenchTool{}) || !tx.Migrator().HasTable(&model.WorkbenchPreset{}) {
		return fmt.Errorf("数据库迁移 51 记录为旧工作台迁移，但工作台表不完整；请从备份恢复后再升级")
	}

	result := tx.Model(&schemaMigration{}).
		Where("version = ? AND name = ? AND checksum = ?", legacy.Version, legacy.Name, legacy.Checksum).
		Updates(map[string]any{
			"version":  workbenchToolsMigrationVersion,
			"name":     workbenchToolsMigrationName,
			"checksum": workbenchToolsMigrationChecksum,
		})
	if result.Error != nil {
		return fmt.Errorf("归一化旧工作台迁移记录：%w", result.Error)
	}
	if result.RowsAffected != 1 {
		return fmt.Errorf("归一化旧工作台迁移记录影响 %d 行，拒绝继续启动", result.RowsAffected)
	}
	return nil
}

const workbenchToolsMigrationVersion int64 = 54

const designDocumentsMigrationVersion int64 = 60

// designDocumentsLegacyAliasVersion 是上游 v59 之前，本地把 design_documents
// 记在 v59 的版本号。上游 1.6.9 起 v59 属于 channel_model_protocol_length。
const designDocumentsLegacyAliasVersion int64 = 59

// normalizeLegacyDesignDocumentsMigration 把本地早期占用的 58/design_documents 与
// 59/design_documents 账本记录统一收敛到 60。上游 1.6.9 起 58 是
// agent_memory_proposals、59 是 channel_model_protocol_length，直接改版本号会让
// 已升级过的库在 checksum 校验阶段拒绝启动，所以必须精确改写而不是只换常量。
func normalizeLegacyDesignDocumentsMigration(tx *gorm.DB) error {
	if err := removeLegacyDesignDocumentsAlias(tx, 58, legacyDesignDocumentsChecksum); err != nil {
		return err
	}
	return relocateDesignDocumentsMigration(tx, designDocumentsLegacyAliasVersion)
}

// removeLegacyDesignDocumentsAlias 删除非目标版本上的 design_documents 别名行。
// 只删除身份完全匹配的记录，其余占用一律拒绝，避免误改他人账本。
func removeLegacyDesignDocumentsAlias(tx *gorm.DB, version int64, checksum string) error {
	var alias schemaMigration
	err := tx.First(&alias, "version = ?", version).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("读取数据库迁移 %d：%w", version, err)
	}
	if alias.Name != "design_documents" {
		return nil
	}
	if alias.Checksum != checksum {
		return fmt.Errorf("数据库迁移 %d 记录为 design_documents 但校验和为 %s；拒绝自动改写迁移账本", version, alias.Checksum)
	}
	if !tx.Migrator().HasTable(&model.DesignDocument{}) {
		return fmt.Errorf("数据库迁移 %d 记录为设计工作台迁移，但设计文档表不存在；请从备份恢复后再升级", version)
	}
	removed := tx.Where("version = ? AND name = ? AND checksum = ?", alias.Version, alias.Name, alias.Checksum).Delete(&schemaMigration{})
	if removed.Error != nil {
		return fmt.Errorf("清理旧设计工作台迁移别名：%w", removed.Error)
	}
	if removed.RowsAffected != 1 {
		return fmt.Errorf("清理旧设计工作台迁移别名影响 %d 行，拒绝继续启动", removed.RowsAffected)
	}
	return nil
}

// relocateDesignDocumentsMigration 把旧版本号上的 design_documents 记录顺延到
// designDocumentsMigrationVersion。目标版本已被同身份记录占用时只清理旧行。
func relocateDesignDocumentsMigration(tx *gorm.DB, legacyVersion int64) error {
	var legacy schemaMigration
	err := tx.First(&legacy, "version = ?", legacyVersion).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("读取数据库迁移 %d：%w", legacyVersion, err)
	}
	if legacy.Name != "design_documents" {
		return nil
	}
	if legacy.Checksum != designDocumentsChecksum {
		return fmt.Errorf("数据库迁移 %d 记录为 design_documents 但校验和为 %s；拒绝自动改写迁移账本", legacyVersion, legacy.Checksum)
	}
	if !tx.Migrator().HasTable(&model.DesignDocument{}) {
		return fmt.Errorf("数据库迁移 %d 为旧设计工作台记录，但设计文档表不存在；请从备份恢复后再升级", legacyVersion)
	}

	var occupied schemaMigration
	err = tx.First(&occupied, "version = ?", designDocumentsMigrationVersion).Error
	if err == nil {
		if occupied.Name != "design_documents" || occupied.Checksum != designDocumentsChecksum {
			return fmt.Errorf("数据库迁移 %d 为旧设计工作台记录，但 %d 已被 %s 占用；拒绝自动改写迁移账本", legacyVersion, designDocumentsMigrationVersion, occupied.Name)
		}
		removed := tx.Where("version = ? AND name = ? AND checksum = ?", legacy.Version, legacy.Name, legacy.Checksum).Delete(&schemaMigration{})
		if removed.Error != nil {
			return fmt.Errorf("清理旧设计工作台迁移别名：%w", removed.Error)
		}
		if removed.RowsAffected != 1 {
			return fmt.Errorf("清理旧设计工作台迁移别名影响 %d 行，拒绝继续启动", removed.RowsAffected)
		}
		return nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return fmt.Errorf("读取数据库迁移 %d：%w", designDocumentsMigrationVersion, err)
	}

	result := tx.Model(&schemaMigration{}).
		Where("version = ? AND name = ? AND checksum = ?", legacy.Version, legacy.Name, legacy.Checksum).
		Updates(map[string]any{
			"version":  designDocumentsMigrationVersion,
			"name":     "design_documents",
			"checksum": designDocumentsChecksum,
		})
	if result.Error != nil {
		return fmt.Errorf("归一化旧设计工作台迁移记录：%w", result.Error)
	}
	if result.RowsAffected != 1 {
		return fmt.Errorf("归一化旧设计工作台迁移记录影响 %d 行，拒绝继续启动", result.RowsAffected)
	}
	return nil
}

func migrateSchemaV56(tx *gorm.DB) error {
	if err := tx.AutoMigrate(&model.ApiCallLog{}, &model.Task{}, &model.CreditLedgerEntry{}); err != nil {
		return fmt.Errorf("迁移 SQL 性能索引：%w", err)
	}
	if tx.Dialector.Name() == "sqlite" {
		if err := tx.Exec("UPDATE api_call_logs SET created_at_epoch = unixepoch(created_at) WHERE created_at_epoch = 0 OR created_at_epoch IS NULL").Error; err != nil {
			return fmt.Errorf("回填 api_call_logs 时间戳：%w", err)
		}
		if err := tx.Exec("UPDATE tasks SET created_at_epoch = unixepoch(created_at) WHERE created_at_epoch = 0 OR created_at_epoch IS NULL").Error; err != nil {
			return fmt.Errorf("回填 tasks 时间戳：%w", err)
		}
	}
	return nil
}

func MigrateSchema(db *gorm.DB) error {
	return db.Transaction(func(tx *gorm.DB) error {
		if tx.Dialector.Name() == "postgres" {
			if err := tx.Exec("SELECT pg_advisory_xact_lock(?)", postgresSchemaMigrationLockID).Error; err != nil {
				return fmt.Errorf("获取数据库迁移锁：%w", err)
			}
		}
		if err := tx.AutoMigrate(&schemaMigration{}); err != nil {
			return fmt.Errorf("初始化数据库迁移记录：%w", err)
		}
		if err := normalizeLegacyWorkbenchMigration(tx); err != nil {
			return err
		}
		if err := normalizeLegacyDesignDocumentsMigration(tx); err != nil {
			return err
		}
		plan, err := migrationsForDatabase(tx)
		if err != nil {
			return err
		}
		for _, item := range plan {
			var applied schemaMigration
			err := tx.First(&applied, "version = ?", item.version).Error
			if err == nil {
				if err := validateMigrationRecord(applied, item); err != nil {
					return err
				}
				continue
			}
			if !errors.Is(err, gorm.ErrRecordNotFound) {
				return fmt.Errorf("读取数据库迁移 %d：%w", item.version, err)
			}
			if err := item.apply(tx); err != nil {
				return fmt.Errorf("执行数据库迁移 %d（%s）：%w", item.version, item.name, err)
			}
			record := schemaMigration{Version: item.version, Name: item.name, Checksum: item.checksum, AppliedAt: time.Now().UTC()}
			if err := tx.Create(&record).Error; err != nil {
				return fmt.Errorf("记录数据库迁移 %d：%w", item.version, err)
			}
		}
		return RequireSchemaVersion(tx)
	})
}

func ReadSchemaStatus(db *gorm.DB) (SchemaStatus, error) {
	status := SchemaStatus{Expected: CurrentSchemaVersion}
	if !db.Migrator().HasTable(&schemaMigration{}) {
		return status, nil
	}
	if err := db.Model(&schemaMigration{}).Select("COALESCE(MAX(version), 0)").Scan(&status.Current).Error; err != nil {
		return status, fmt.Errorf("读取数据库结构版本：%w", err)
	}
	if status.Current != status.Expected {
		return status, nil
	}
	if err := validateMigrationRecords(db); err != nil {
		return status, err
	}
	status.Ready = true
	return status, nil
}

func validateMigrationRecords(db *gorm.DB) error {
	plan, err := migrationsForDatabase(db)
	if err != nil {
		return err
	}
	for _, item := range plan {
		var applied schemaMigration
		if err := db.First(&applied, "version = ?", item.version).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return fmt.Errorf("数据库缺少迁移记录 %d（%s）", item.version, item.name)
			}
			return fmt.Errorf("读取数据库迁移 %d：%w", item.version, err)
		}
		if err := validateMigrationRecord(applied, item); err != nil {
			return err
		}
	}
	return nil
}

func validateMigrationRecord(applied schemaMigration, expected migration) error {
	if applied.Name != expected.name {
		return fmt.Errorf("数据库迁移 %d 名称不一致：记录为 %s，程序期望 %s", expected.version, applied.Name, expected.name)
	}
	if applied.Checksum != expected.checksum {
		return fmt.Errorf("数据库迁移 %d 校验和不一致：记录为 %s，程序期望 %s", expected.version, applied.Checksum, expected.checksum)
	}
	return nil
}

func RequireSchemaVersion(db *gorm.DB) error {
	status, err := ReadSchemaStatus(db)
	if err != nil {
		return err
	}
	if status.Current < status.Expected {
		return fmt.Errorf("数据库结构版本过旧：当前 %d，程序要求 %d，请先执行 migrate-schema up", status.Current, status.Expected)
	}
	if status.Current > status.Expected {
		return fmt.Errorf("数据库结构版本 %d 高于程序支持的 %d，拒绝使用旧程序连接新数据库", status.Current, status.Expected)
	}
	return nil
}
