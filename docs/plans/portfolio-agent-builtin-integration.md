# 作品集接入影策内置云 Agent — 实施方案

> 目标：作品集的 AI 能力不再由插件自建，改为调用影策**内置云 Agent**（`/api/agent/*`），
> 产物仍写回作品集文档。不新增 Agent 服务、不新增容器、不新增独立模型通道。

## 1. 现状

| 侧 | 位置 | 形态 |
| --- | --- | --- |
| 作品集 Agent（自建） | `web/src/pages/portfolio/index.tsx:177-222` → `web/src/lib/portfolio/agent.ts` → `web/src/services/plugin-host.ts` → `web/src/services/api/image.ts` | 一次性 `requestToolResponse` 文本调用；无会话、无工具循环、无审批、无技能 |
| 内置云 Agent | `backend/internal/handler/agent.go:118` → `backend/internal/app/cloud_agent.go:342`；工具全在 Go：`cloud_agent_tools.go:417`；Node 只透传：`backend/agent-runtime/pi/agent-runtime.mjs:176` | 会话 + 工具循环 + 审批 + 技能 + 事件流 + 计费预算 |

Node 运行时有两条路（`backend/internal/app/cloud_agent_pi_runtime.go:42-56`）：
`YINGCE_AGENT_URL` 非空 → `yingce-agent/` 容器；为空 → **后端本进程内 `exec node`**（`backend/internal/agent/runtime/runtime.go:92`）。

## 2. 三条硬约束（决定方案形状）

1. **`canvasId` 是 run 的租户主键，不改契约。**
   必填 + 存在性 + 归属校验：`cloud_agent.go:119`（`validateCloudAgentID`）、`:349`
   （`repo.CanvasProjectForUser`，`repository.go:1202`），未命中直接 404。
   后续 `canvas_get_state`、`generate_media`、`task_get`、缓存键 `cloudAgentPromptCacheKeyForCanvas`、
   幂等指纹都挂在它上面。放宽必填 = 波及整条 Agent 链路 + 大量测试，改动量 L、风险高。
2. **作品集文档不是画布，模型也不认识它。**
   所以需要：一个"身份壳"满足租户校验 + 一组作品集领域工具让 Agent 真正读写作品集。
3. **开发栈现在跑不了内置 Agent**（见 §5 P0），这是联调的前置阻塞项。

## 3. 推荐方案：壳画布 + 作品集领域工具（路径 A+）

### 3.1 身份壳（不镜像内容，避免双写真相源）

- 一篇作品集文档 ↔ 一张**作品集壳画布**，ID 由作品集文档 ID 派生：`pf-<portfolioDocumentId>`
  （画布 ID 由客户端指定，见 `backend/internal/handler/user_data.go:612` `UpsertUserCanvasProject`）。
- 壳画布的 payload 只放**标记**（如 `{"portfolioShell":{"documentId":"..."}}`），**不镜像页面与图片**。
  作品集文档始终是唯一真相源。
- 好处：不需要新增表/列/迁移，不需要往返投影，没有漂移风险。
- 代价：壳画布会出现在画布列表里（`GET /canvas-projects`，`handler/user_data.go:507`）→
  需在前端画布列表按 `pf-` 前缀过滤（小改动）。

### 3.2 作品集领域工具（Go 侧新增）

在 `cloud_agent_tools.go:417` `compileCloudAgentTools` 注册（**仅当 `canvasId` 带 `pf-` 前缀**），
复用 `backend/internal/app/portfolio.go:64/99`（`GetPortfolioDocument` / `SavePortfolioDocument`）：

| 工具 | 类型 | 说明 |
| --- | --- | --- |
| `portfolio_read_document` | 只读 | 读当前作品集的页面目录；传 `pageId` 时展开该页元素（图片元素给出 `caption` / `tags` / 是否已存入账号资源）。走 `cloudAgentReadTool`（`cloud_agent_tools.go:868`）与只读名单 `cloudAgentReadToolReadOnly` |
| `portfolio_inspect_image` | 只读（附真实图片） | 校验元素是账号资源（`repo.ResourceForUser` + `ready` + `image/*`），把 `resource:<assetId>` 交给既有的看图通道；仅在 `VisionEnabled` 时注册，并与画布看图共用每轮预算与"同一张图最多附送 2 次"的保护 |
| `portfolio_propose_annotations` | 只登记建议 | **不写文档**。校验元素存在、去重、截断 `caption`/`tags` 后，把建议写进 `portfolio_annotations_proposed` 事件；`cloudAgentWrite` 不含它，因此任何权限模式都不进审批链 |

结果通知：`portfolio_annotations_proposed` 带 `documentId` + `revision` + `items`，
前端收到后弹确认框，用户勾选才写入作品集文档（提议制）。
**不要**往 `cloud_agent_pi_canvas_tools_registry.go` 加工具（遗留注册表，生产路径不构造）。

### 3.3 前端接入（已落地）

- `pages/portfolio/index.tsx` 的 `classify` 改为 `runAgent`，实际逻辑在
  `web/src/lib/portfolio/agent-run.ts`：`createAgentRun({ canvasId: "pf-<docId>", prompt, contextScope: [], permissionMode: "auto", budget, idempotencyKey })`
  → `subscribeAgentEvents`（`web/src/services/api/agent.ts:186`）→ 收集建议 → 确认弹窗 → `applyElementPatches`。
- **触发前的顺序不能换**：先把缺 `assetId` 的图片补传成账号资源（`uploadImageSource`），再保存文档，
  最后才发运行请求。Agent 读的是服务端那份文档，先保存后补传会让它读到没有 `assetId` 的旧快照。
- 停止按钮走 `cancelAgentRun`（服务端取消），而不是只断开事件流——断开不会停掉后台计费。
- 画布列表按 `pf-` 前缀过滤壳画布（`pages/canvas/index.tsx`），并抵扣总计数。
- 已删除插件自建实现 `web/src/lib/portfolio/agent.ts`（决策 4 取"直接删"）。

### 3.4 工具作用域隔离

作品集运行**不声明画布上下文**（`contextScope: []`）：`compileCloudAgentTools` 里画布工具、媒体生成、
导演台、`image_annotation_render` 全部挂在 `len(req.ContextScope) > 0` 上，因此这些工具根本不注册。
壳画布是空的，放开画布工具只会让模型对着空画布空转，甚至把节点写进那张没人看的壳里。
`TestPortfolioAgentToolsFollowShellCanvas` 守着这条边界。

## 4. 不采用的路径

| 路径 | 为什么不做 |
| --- | --- |
| 放宽 `canvasId` 必填 / 新增 `portfolioId` 并列上下文 | 改动量 L；`canvasId` 是 run 的 `ProjectID`、缓存键与幂等指纹的一部分，波及全部读工具与审批 |
| 壳画布镜像作品集内容 + 消费 `canvas_updated` 的 `canvasPatch` 回写 | 双写真相源易漂移；仍要处理画布列表泄漏与图片上传前置，且要写一层 canvas→portfolio 投影适配 |
| 把 Node 运行时替换/自己写一个 agent loop | 与"不要另开"的目标相反 |

## 5. 分阶段与状态

### P0 解锁开发栈 —— 已完成（Node 运行时部分）

1. ✅ `backend/Dockerfile.dev` 加 `nodejs` + `npm`（Node 24.18.1，满足 `agent-runtime/pi` 的 `engines` ≥ 22.19）；
   `docker-compose.dev.yml` 用 **host bind mount** `./.local/cache/pi-node-modules` 持久化依赖并在启动时 `npm ci`。
   注意：命名卷在容器 user 1000 下不可写（EACCES），必须用 bind mount（与 `go-build`/`go-mod` 一致）。
2. ⏳ **未完成（P0b，唯一阻塞项）**：dev 库 `model_channels = 0`，而内置 Agent 只接受后端受管模型
   （`logicalModelId` 或 `channelId+channelModelKey`，拒绝浏览器密钥，`cloud_agent.go:180-188`）。
   3003 部署栈有 20 条通道，但密钥用该实例的 `.settings-key` 加密，不能直接搬行——需要在 dev 重新录入。
   看图配文依赖声明了 `text.references.maxImages > 0` 的**文本**渠道模型
   （`cloudAgentVisionReferences` 只认 `channelId + channelModelKey`；`logicalModelId` 形式拿不到能力声明）。
3. ✅ 已用真实登录态做接口级验证：`POST /agent/runs` 提交 `canvasId=pf-<真实文档ID>` + `contextScope=[]`
   → 壳画布按需创建成功；无效渠道在准入阶段被拒。完整模型往返仍需 P0b。

### P1 后端：壳画布 + 作品集工具 —— 已完成

- ✅ 画布 ID 派生 `pf-<docId>` 与壳画布惰性创建（`ensureCloudAgentPortfolioShell` → `UpsertUserCanvasProject`）。
- ✅ 三个工具 + `portfolio_annotations_proposed` 事件 + 6 项单测；工具表守卫
  （`TestCloudAgentToolTableMatchesRuntimeDispatch`）通过。

### P2 前端：接入与确认 —— 已完成

- ✅ `agent-run.ts` + 确认弹窗 + 画布列表过滤壳画布 + 删除 `lib/portfolio/agent.ts`。
- ✅ `tsc --noEmit` / `eslint src test` / `prettier --check` 通过；新增 8 项前端契约测试。

### P3 文档 —— 已完成

- ✅ `docs/content/docs/overview/features.mdx` 增加功能小节；
  `progress/pending-test.mdx` 增加待测小节（含 P0b 阻塞项与手工验收步骤）；
  `backend/code-map.mdx` 增加作品集工作台入口行。

### P4 端到端与提交 —— 待 P0b

- ⏳ 真实登录 → 作品集 → 触发 Agent → 确认建议 → 文档被写入 → 导出一致。
- ⏳ 内置「作品集编辑」技能（分类词表、命名规范、图注风格）放在 `backend/internal/skills/seed/`，
  run 时传 `skillIds`。技能只是 prompt/数据，**不新增可调用工具**（副作用必须走 3.2 的工具）。
- ⏳ 提交（`feat(portfolio): ...` 风格）。

## 6. 已决策

1. **身份壳**：按 §3.1 用 `pf-<docId>` 派生，不新增表/迁移。✅
2. **落地方式**：取**提议制**——新增只产建议、不改文档的工具，Agent 通过事件把建议送回，
   前端确认后再写入。这样作品集文档没有"Agent 静默改过"的中间态，
   也不必把作品集写进画布审批流（`request_approval` 会让 run 停在 `waiting_approval`，
   需要一整套审批 UI，而这里要确认的东西本来就是"建议"而不是"写操作"）。✅
3. **P0 现在做**：是。Node 运行时已打通；模型通道需你提供可用渠道。⏳
4. **旧的一次性实现**：直接删掉 `lib/portfolio/agent.ts`，不保留降级——
   留着它等于"两套 Agent"，而用户的目标正是"不要另开"。✅

## 7. 风险与处置

- ~~壳画布出现在画布列表~~：已在 `pages/canvas/index.tsx` 按前缀过滤并抵扣总计数。⚠️ 其它按
  `canvas_projects` 计数的入口（配额、统计）未逐一排查，壳画布会占用一条画布配额。
- ~~Agent 误用 `canvas_apply_ops` 写壳画布~~：已通过 `contextScope: []` 让画布工具根本不注册。
- **纯文本模型看不见图**：`portfolio_inspect_image` 只在渠道模型声明 `maxImages > 0` 时注册；
  没声明时模型只能基于已有 `caption`/`tags` 归类，配文质量下降但不报错。
- ~~审批模式打断流程~~：提议制不产生审批，运行不会被挂在 `waiting_approval`。
- **成本**：`maxCredits` 必填（`cloud_agent.go:210-213`），作品集侧固定 200；
  单批最多 8 张图，看图预算与画布共用 `cloudAgentMaxImageInspectionCallsPerRun = 16`。
- **壳画布是空画布**：如果用户手动打开它会看到空白（已在列表隐藏，但直链仍可打开）。

