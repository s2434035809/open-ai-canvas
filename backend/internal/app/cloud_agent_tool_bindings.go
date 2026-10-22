package app

import (
	agenttool "yingce/backend/internal/agent/tool"
	"yingce/backend/internal/repository"
)

func cloudAgentToolHandlers() map[string]cloudAgentToolHandler {
	return map[string]cloudAgentToolHandler{
		agenttool.AgentProfileRead:       {Read: cloudAgentHandleAgentProfileRead},
		agenttool.PlanUpdate:             {Read: cloudAgentHandlePlanUpdate},
		agenttool.AskUser:                {Read: cloudAgentHandleAskUser},
		agenttool.PrevisSceneRead:        {Read: cloudAgentHandlePrevisSceneRead},
		agenttool.PrevisPreview:          {Read: cloudAgentHandlePrevisPreview},
		agenttool.PrevisSceneCreate:      {Write: applyCloudAgentPrevisMutation, Preview: cloudAgentPreviewPrevisCreate},
		agenttool.PrevisApplyPatch:       {Write: applyCloudAgentPrevisMutation, Preview: cloudAgentPreviewPrevisPatch},
		agenttool.CanvasListNodeTypes:    {Read: cloudAgentHandleCanvasListNodeTypes},
		agenttool.CanvasGetState:         {Read: cloudAgentHandleCanvasGetState},
		agenttool.CanvasReadText:         {Read: cloudAgentHandleCanvasReadText},
		agenttool.CanvasReadBatchTable:   {Read: cloudAgentHandleCanvasReadBatchTable},
		agenttool.CanvasReadStoryboard:   {Read: cloudAgentHandleCanvasReadStoryboard},
		agenttool.ImageTextDetect:        {Read: cloudAgentHandleImageTextDetect},
		agenttool.ImageAnnotationRender:  {Read: cloudAgentHandleImageAnnotationRender},
		agenttool.SkillReadFile:          {Read: cloudAgentHandleSkillReadFile},
		agenttool.SkillSearch:            {Read: cloudAgentHandleSkillSearch},
		agenttool.TaskGet:                {Read: cloudAgentHandleTaskGet},
		agenttool.CanvasInspectImage:     {Pipeline: cloudAgentToolVision},
		agenttool.RecallLessons:          {Read: cloudAgentHandleRecallLessons},
		agenttool.RememberLesson:         {Read: cloudAgentHandleRememberLesson},
		agenttool.ImageLayerSplit:        {Pipeline: cloudAgentToolMedia},
		agenttool.ModelList:              {Read: cloudAgentHandleModelList},
		agenttool.CanvasCreateStoryboard: {Write: applyCloudAgentStoryboardMutation, Preview: cloudAgentPreviewStoryboardCreate},
		agenttool.CanvasEditStoryboard:   {Write: applyCloudAgentStoryboardMutation, Preview: cloudAgentPreviewStoryboardEdit},
		agenttool.CanvasCreateCharacter:  {Write: applyCloudAgentCharacterCreate, Preview: cloudAgentPreviewCharacterCreate},
		agenttool.CanvasEditBatchTable:   {Write: applyCloudAgentBatchTableMutation, Preview: cloudAgentPreviewBatchTable},
		agenttool.CanvasApplyOps:         {Write: applyCloudAgentCanvas, Preview: cloudAgentPreviewCanvas},
		agenttool.CanvasArrangeNodes:     {Write: applyCloudAgentArrangeNodes, Preview: cloudAgentPreviewArrange},
		agenttool.GenerateMedia:          {Pipeline: cloudAgentToolMedia},
		agenttool.LoadCreationWorkflow:   {Read: cloudAgentHandleLoadCreationWorkflow},
		agenttool.CreationMediaRead:      {Read: cloudAgentHandleCreationMediaRead},
		// 电商计划提交由 advanceCloudAgentCommercePlan（报价/审批/执行）与
		// cloudAgentSaveCommercePlan（只读保存）显式分派，注册表只保留审批预演拒绝。
		agenttool.CommercePlanSubmit: {Preview: cloudAgentRejectCommercePreview},
		agenttool.CommercePlanWait:   {Read: cloudAgentRejectDirectCommerceRead},
		agenttool.GenerateImageBatch: {Pipeline: cloudAgentToolMedia},
	}
}

// 创作工作流与会话媒体读取需要运行时状态，不需要 Service；这里保持统一签名。
func cloudAgentHandleLoadCreationWorkflow(
	_ *repository.Repository,
	_ string,
	state *cloudAgentRuntime,
	call cloudAgentCall,
	_ ...*Service,
) (any, error) {
	return cloudAgentLoadCreationWorkflow(state, call)
}

func cloudAgentHandleCreationMediaRead(
	repo *repository.Repository,
	userID string,
	state *cloudAgentRuntime,
	call cloudAgentCall,
	_ ...*Service,
) (any, error) {
	return cloudAgentCreationMediaRead(repo, userID, state, call)
}

// 电商计划与批量生成由 advanceCloudAgentCommercePlan 提前分派，拥有独立的
// 授权、报价和恢复链。这里的注册项只是注册表兜底，必须显式拒绝，避免绕过
// 该链路直接执行写操作。
func cloudAgentRejectDirectCommerce(
	_ *repository.Repository,
	_ string,
	_ string,
	call cloudAgentCall,
	_ RuntimePolicySetting,
	_ ...cloudAgentMutationRecorder,
) (any, error) {
	return nil, BadAuthRequest("工具「" + truncateRunes(call.Function.Name, 60) + "」必须通过创作工作流执行，不能直接调用")
}

func cloudAgentRejectCommercePreview(
	_ *repository.Repository,
	_ string,
	_ string,
	call cloudAgentCall,
) (cloudAgentApprovalPreview, error) {
	return cloudAgentApprovalPreview{}, BadAuthRequest("工具「" + truncateRunes(call.Function.Name, 60) + "」必须通过创作工作流执行，不能直接预演")
}

func cloudAgentRejectDirectCommerceRead(
	_ *repository.Repository,
	_ string,
	_ *cloudAgentRuntime,
	call cloudAgentCall,
	_ ...*Service,
) (any, error) {
	return nil, BadAuthRequest("工具「" + truncateRunes(call.Function.Name, 60) + "」必须通过创作工作流执行，不能直接调用")
}

func cloudAgentPreviewCanvas(repo *repository.Repository, userID, canvasID string, call cloudAgentCall) (cloudAgentApprovalPreview, error) {
	plan, err := prepareCloudAgentCanvasMutation(repo, userID, canvasID, call)
	if err != nil {
		return cloudAgentApprovalPreview{}, err
	}
	return plan.Preview, nil
}

func cloudAgentPreviewArrange(repo *repository.Repository, userID, canvasID string, call cloudAgentCall) (cloudAgentApprovalPreview, error) {
	plan, err := prepareCloudAgentArrangeNodes(repo, userID, canvasID, call)
	if err != nil {
		return cloudAgentApprovalPreview{}, err
	}
	return plan.Preview, nil
}

func cloudAgentPreviewStoryboardCreate(repo *repository.Repository, userID, canvasID string, call cloudAgentCall) (cloudAgentApprovalPreview, error) {
	plan, err := prepareCloudAgentStoryboardCreate(repo, userID, canvasID, call)
	if err != nil {
		return cloudAgentApprovalPreview{}, err
	}
	return plan.Preview, nil
}

func cloudAgentPreviewStoryboardEdit(repo *repository.Repository, userID, canvasID string, call cloudAgentCall) (cloudAgentApprovalPreview, error) {
	plan, err := prepareCloudAgentStoryboardEdit(repo, userID, canvasID, call)
	if err != nil {
		return cloudAgentApprovalPreview{}, err
	}
	return plan.Preview, nil
}

func cloudAgentPreviewCharacterCreate(repo *repository.Repository, userID, canvasID string, call cloudAgentCall) (cloudAgentApprovalPreview, error) {
	plan, err := prepareCloudAgentCharacterCreate(repo, userID, canvasID, call)
	if err != nil {
		return cloudAgentApprovalPreview{}, err
	}
	return plan.Preview, nil
}

func cloudAgentPreviewBatchTable(repo *repository.Repository, userID, canvasID string, call cloudAgentCall) (cloudAgentApprovalPreview, error) {
	plan, err := prepareCloudAgentBatchTableEdit(repo, userID, canvasID, call)
	if err != nil {
		return cloudAgentApprovalPreview{}, err
	}
	return plan.Preview, nil
}

func cloudAgentPreviewPrevisCreate(repo *repository.Repository, userID, canvasID string, call cloudAgentCall) (cloudAgentApprovalPreview, error) {
	plan, err := prepareCloudAgentPrevisSceneCreate(repo, userID, canvasID, call)
	if err != nil {
		return cloudAgentApprovalPreview{}, err
	}
	return plan.Preview, nil
}

func cloudAgentPreviewPrevisPatch(repo *repository.Repository, userID, canvasID string, call cloudAgentCall) (cloudAgentApprovalPreview, error) {
	plan, err := prepareCloudAgentPrevisApplyPatch(repo, userID, canvasID, call)
	if err != nil {
		return cloudAgentApprovalPreview{}, err
	}
	return plan.Preview, nil
}
