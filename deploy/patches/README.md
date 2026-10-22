# deploy/patches — 纯净 main 之上的最小补丁层

上游对齐纪律：`main` 永远等于 `upstream/main`，任何本地修复都以补丁形式叠在其上。
补丁只描述「为什么需要」和「改了哪些文件」，一旦某项修复进入 main 或 dev 正式分支，
对应补丁必须立即摘除，避免同一处改动既在分支里又在补丁里。

## 顺序与应用

严格按编号升序应用；四个补丁互不重叠文件，顺序无依赖但必须全上前提已满足。

```bash
git fetch origin main
git checkout -B deploy-main origin/main
for p in deploy/patches/0*.patch; do git apply "$p"; done
```

## 清单

| 编号 | 文件 | 解决的问题 |
| --- | --- | --- |
| 0001 | `0001-audio-category.patch` | 上游新增 `tag: audio` 技能未登记到分类白名单，`EnsureBuiltinSkills()` 失败后 `log.Fatal` 直接让后端退出。 |
| 0002 | `0002-agent-approval.patch` | 审批卡点「同意执行」无反应：服务端把模型目录归一化后的规格与审批参数做字符串严格相等，合法改参被误驳回；同时前端回传服务端持有的生成意图字段被判 400。补丁保留上游 `validateCloudAgentResolvedMediaOptions`（任务准入与测试仍需），只在审批期改为记录归一化差异，并收敛决策请求体白名单。覆盖 5 个文件。 |
| 0003 | `0003-agent-runtime-and-approval-hardening.patch` | agent-runtime 缺 `HOME` 导致容器内会话崩溃；会话重启撞上待审批被判整轮失败；改参审批被无关画布写入误判 409；执行期 `applyCloudAgentResolvedMediaDefaults` 再做字符串比对二次驳回。 |
| 0004 | `0004-dsh-gateway-tool-name-fragments.patch` | DSH 网关每个分片重发完整工具名，按增量拼接后超出 80 字符上限，整步硬失败。 |

## 收敛记录


- 2026-10-16（v1.6.8.3 → v1.6.8.4）：上游 `e30cb340`(#783) 在
  `cloud_agent_media_approval.go` 的 `validateCloudAgentResolvedMediaOptions` 里加了
  图片尺寸容差，而 `0002` 删的正是这个函数，补丁预检因此失败。
  已在 `f951d330` 上重新生成 `0002`：保留「删函数、归一化只记日志」的语义，上游那 4 行
  容差随之失效（其退路 `applyCloudAgentResolvedMediaDefaults` 已接管规格归一化）。
  其余 4 个文件在新基点上 diff 完全不变。
- 2026-10-17（v1.6.8.9）：上游 `ebc85a5a` 重写画布同步恢复并新增 `prepareCanvasForCloudAction`，
  审批前保存失败不再阻断提交、且会回落到云端已保存画布，覆盖了 `0003` 的前端部分；
  上游同时移除了 Agent 新建对话的默认技能安装。已摘除 `0003` 的
  `canvas-cloud-agent-panel.tsx` 与 `agent-approval-connection.test.ts`，
  仅保留 4 个后端文件（`HOME`、会话重启待审批、改参审批依赖基线）。
- 2026-10-18（v1.6.8.10）：上游 `c13aac5d` 重写审批执行边界并新增
  `cloud_agent_media_options_test.go`，该测试直接调用 `validateCloudAgentResolvedMediaOptions`。
  `0002` 不能再删除这个函数，否则上游测试无法编译。已重新生成 `0002`：恢复
  `cloud_agent_approval_settings_test.go`、`cloud_agent_runtime_media.go`、
  `web/src/services/api/agent.ts`、`web/test/agent-api-reliability.test.ts` 四个文件，
  审批期只把「归一化差异」降为日志并回写解析后的契约；执行期在 `0003` 里做同样收敛。
  另修正 `0002` 里重复调用的 `applyCloudAgentResolvedMediaDefaults`。
- 2026-10-16：上游 `557f19f5`(#784) 修了 `0002` 覆盖的审批 400 前端侧（同一条 bug），
  改动 `canvas-agent-*-approval-settings.tsx`、`agent-media-approval.ts`、`agent-media-approval.test.ts`。
  `0002` 摘除这 4 个已被上游覆盖的文件，只保留后端部分。两套机制互补：
  上游在前端窄化（`agentMediaSettings()`），本补丁在后端放宽（`applyCloudAgentMediaDefaults`）。

## 废弃

`superseded/` 下是历史产物，不参与部署，仅留档追溯。

- `superseded/main-deploy-fix.patch`：0001+0002 合并前的单文件版本，已被拆分取代。
