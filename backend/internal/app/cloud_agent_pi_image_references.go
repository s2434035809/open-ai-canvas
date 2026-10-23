package app

// inspectedImages 返回一次工具调用对应的全部图片，兼容旧检查点的单图记录。
func (state *cloudAgentRuntime) inspectedImages(callID string) []cloudAgentImageInspection {
	if state == nil || callID == "" {
		return nil
	}
	if group, ok := state.PiInspectedImageGroups[callID]; ok {
		return group
	}
	if inspection, ok := state.PiInspectedImages[callID]; ok {
		return []cloudAgentImageInspection{inspection}
	}
	return nil
}

// bindInspectedImages 写入一次工具调用的图片结果：单图沿用旧字段，
// 多图写入分组字段，避免同一 call.ID 只能保留一张。
func (state *cloudAgentRuntime) bindInspectedImages(callID string, inspections []cloudAgentImageInspection) {
	if state == nil || callID == "" || len(inspections) == 0 {
		return
	}
	if len(inspections) == 1 {
		if state.PiInspectedImages == nil {
			state.PiInspectedImages = map[string]cloudAgentImageInspection{}
		}
		state.PiInspectedImages[callID] = inspections[0]
		delete(state.PiInspectedImageGroups, callID)
		return
	}
	if state.PiInspectedImageGroups == nil {
		state.PiInspectedImageGroups = map[string][]cloudAgentImageInspection{}
	}
	state.PiInspectedImageGroups[callID] = inspections
	delete(state.PiInspectedImages, callID)
}

// Pi keeps text tool receipts in its native journal; restore authorized image
// content only while the corresponding tool result remains in that branch.
func cloudAgentPiAttachInspectedImages(state *cloudAgentRuntime, canonical *canonicalAgentRequest) {
	if state == nil || canonical == nil || (len(state.PiInspectedImages) == 0 && len(state.PiInspectedImageGroups) == 0) {
		return
	}
	messages := make([]map[string]any, 0, len(canonical.Messages))
	var inspections []cloudAgentImageInspection
	for index, message := range canonical.Messages {
		messages = append(messages, message)
		if stringField(message, "role") != "tool" {
			continue
		}
		callID := stringField(message, "tool_call_id")
		for _, inspection := range state.inspectedImages(callID) {
			if inspection.ImageURL != "" {
				inspections = append(inspections, inspection)
			}
		}
		if len(inspections) > 0 && (index+1 == len(canonical.Messages) || stringField(canonical.Messages[index+1], "role") != "tool") {
			var existing []string
			if index+1 < len(canonical.Messages) {
				existing = cloudAgentImageMessageNodeIDs(canonical.Messages[index+1])
			}
			missing := inspections[:0]
			for _, inspection := range inspections {
				if !cloudAgentContainsString(existing, stringValue(inspection.Receipt["nodeId"])) {
					missing = append(missing, inspection)
				}
			}
			if len(missing) > 0 {
				messages = append(messages, map[string]any{"role": "user", "content": cloudAgentImageContentParts(missing...)})
			}
			inspections = nil
		}
	}
	canonical.Messages = messages
}

// 独立 Agent 运行时（Pi）的模型步骤带上获准图片清单。
//
// canvas_inspect_image 看图后，服务端的规范历史里会多一条带 resource: 图片占位的 user 消息。
// 旧的 Go 执行循环在发请求前调用 cloudAgentImageReferences，把这些占位对应的资源写进
// input.referenceImages，供应商层据此读取真实图片；Pi 路径（runCloudAgentModelStep）漏了这一步，
// 预检发现占位不在获准清单里，整轮以「模型协议引用了未获准的图片」失败。
//
// 这里复用同一个函数：校验资源归属与大小、按模型的图片数量上限移出多余图片，并返回清单。
// 它会改写传入的 canonical（只影响本次请求的副本），所以必须在组装任务输入之前调用，
// 且在 state.Canonical 已经保存完整历史之后调用。
func (s *Service) cloudAgentPiStepImageReferences(userID string, req CloudAgentRequest, canonical *canonicalAgentRequest) ([]providerMedia, error) {
	return s.cloudAgentImageReferences(userID, req, canonical)
}
