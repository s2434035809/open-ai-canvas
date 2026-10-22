package app

// cloudAgentInjectedMemoryIDs reads only source-tagged server data from the
// prepared model task input. It never infers use or outcome from a recall hit.
func cloudAgentInjectedMemoryIDs(input map[string]any) []string {
	requests, _ := input["agentRequests"].(map[string]any)
	canonical, _ := requests["canonical"].(map[string]any)
	messages, _ := canonical["messages"].([]any)
	ids := make([]string, 0, cloudAgentLessonRecallLimit)
	seen := make(map[string]bool)
	for _, value := range messages {
		message, _ := value.(map[string]any)
		if stringField(message, cloudAgentContextSourceKey) != "agent_memory" {
			continue
		}
		values, _ := message["agentMemoryIDs"].([]any)
		for _, value := range values {
			id, ok := value.(string)
			if ok && id != "" && !seen[id] {
				seen[id] = true
				ids = append(ids, id)
			}
		}
	}
	return ids
}

// cloudAgentWithoutMemoryMessages 去掉只属于本次模型请求的召回消息：
// 它们必须随请求临时注入，不能写回 canonical 历史，否则会污染会话并让下一轮重复携带。
func cloudAgentWithoutMemoryMessages(messages []map[string]any) []map[string]any {
	kept := make([]map[string]any, 0, len(messages))
	for _, message := range messages {
		if stringField(message, cloudAgentContextSourceKey) == "agent_memory" {
			continue
		}
		kept = append(kept, message)
	}
	return kept
}
