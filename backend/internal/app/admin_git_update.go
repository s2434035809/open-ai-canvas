package app

import (
	"context"
	"net/http"

	"yingce/backend/internal/gitupdate"
	"yingce/backend/internal/model"
)

// GitUpdateManager 是开发态「合并上游 main 到 dev」的能力接口。
// 与 Host Updater 分离：后者负责发布版镜像更新，这里只处理源码分支合并。
type GitUpdateManager interface {
	Status(context.Context) gitupdate.Status
	Check(context.Context) (gitupdate.Status, error)
	Apply(context.Context) (gitupdate.Status, error)
}

func (s *Service) ConfigureGitUpdateManager(manager GitUpdateManager) {
	s.gitUpdateManager = manager
}

func (s *Service) AdminGitUpdateStatus(ctx context.Context, actor *model.User) (gitupdate.Status, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return gitupdate.Status{}, err
	}
	if s.gitUpdateManager == nil {
		return gitupdate.DisabledStatus(), nil
	}
	return s.gitUpdateManager.Status(ctx), nil
}

func (s *Service) AdminGitUpdateCheck(ctx context.Context, actor *model.User) (gitupdate.Status, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return gitupdate.Status{}, err
	}
	if s.gitUpdateManager == nil {
		return gitupdate.Status{}, NewAppError(http.StatusServiceUnavailable, "当前部署未开启源码更新（仅开发环境）")
	}
	return s.gitUpdateManager.Check(ctx)
}

func (s *Service) AdminGitUpdateApply(ctx context.Context, actor *model.User, expectedCommit string) (gitupdate.Status, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return gitupdate.Status{}, err
	}
	if s.gitUpdateManager == nil {
		return gitupdate.Status{}, NewAppError(http.StatusServiceUnavailable, "当前部署未开启源码更新（仅开发环境）")
	}
	status := s.gitUpdateManager.Status(ctx)
	// 二次确认：前端必须回传检查时看到的本地 commit，防止页面过期后误点。
	if expected, ok := trimCommit(expectedCommit); !ok || expected != status.LocalHead {
		return status, NewAppError(http.StatusConflict, "本地提交已变化，请重新检查后再应用")
	}
	next, err := s.gitUpdateManager.Apply(ctx)
	if err != nil {
		return next, WrapAppError(http.StatusConflict, "合并失败", err)
	}
	return next, nil
}

func trimCommit(value string) (string, bool) {
	trimmed := ""
	for _, r := range value {
		if r == ' ' || r == '\t' || r == '\n' || r == '\r' {
			continue
		}
		trimmed += string(r)
	}
	return trimmed, trimmed != ""
}
