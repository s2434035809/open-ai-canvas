# 作品集导出实现方案（第一轮：PNG / HTML）

> 状态：**待确认**（未开始编码）
> 分支：`feature/AI-Portfolio`
> 本轮范围：当前页 PNG、整册长图 PNG、自包含 HTML 单文件
> 明确不做：PDF、SVG、AI、PSD（留到下一轮）

## 1. 目标

作品集目前只能存进系统，**拿不出去**——闭环缺了最后一环。本轮打通「做完能交付」：

| 导出物 | 用途 | 形态 |
|---|---|---|
| 当前页 PNG | 快速预览、贴进聊天/文档 | 单张位图，尺寸 = 页面尺寸 × 倍率 |
| 整册长图 PNG | 一图看全、提案、发社交媒体 | 多页纵向拼接的长条位图 |
| 自包含 HTML | 分享、自托管个人站点 | 单个 `.html`，图片内联，双击即开 |

## 2. 现状盘点

### 2.1 画布渲染管线

- 引擎 `leafer-ui@2.2.7`；`PortfolioCanvas` 内 `new Leafer({ view: host, pixelRatio })`
- 图片元素 = `Rect` + `fill: { type: "image", url, mode: "fit" | "stretch" | "cover" }`
- 文字元素 = `Text` + `textWrap: "break"`、`lineHeight`、`letterSpacing`、`verticalAlign: "top"`
- 元素定位：`origin: "top-left"`（左上角定位）+ `around: "center"`（**绕中心旋转**）
- 选中框 / 缩放手柄 / 吸附参考线是 **DOM 叠层**，不是文档内容 —— **导出必须排除**

### 2.2 文档模型（`lib/portfolio/contracts.ts`）

```
PortfolioDocument { schemaVersion, title, description, coverUrl, pages[] }
PortfolioPage     { id, name, width, height, background, elements[] }   // 默认 1600×1000
元素公共字段        x y width height rotation zIndex locked opacity
图片额外字段        assetId src fit naturalWidth naturalHeight caption tags
文字额外字段        text fontSize fontFamily fontWeight color align lineHeight letterSpacing
```

**契约注释里已经预留了导出语义**（说明原作者本来就打算这么做）：

- `caption` —「图注，导出 HTML/PDF 时作为图下文字」
- `tags` —「Agent 分类结果，用于分组、筛选与**导出分组**」
- 文件头 —「图片只保存资源引用或可访问 URL，不内联二进制……**导出时再按需把图片解析出来**」

### 2.3 可直接复用的纯函数

| 来源 | 函数 | 用途 |
|---|---|---|
| `lib/portfolio/document.ts` | `sortByZIndex` | 导出绘制顺序 |
| `lib/portfolio/geometry.ts` | `elementCenter`、`elementCorners` | 旋转中心与边界 |
| `lib/portfolio/image-import.ts` | `measureImage` | 图片尺寸兜底 |
| `lib/portfolio/contracts.ts` | `isPortfolioDocument` | 导出前数据校验 |

## 3. 技术选型

### 3.1 为什么不用 leafer 自带的导出

- leafer 2.x 的图片导出在**独立插件** `@leafer-in/export`，当前**未安装**（容器内 `node_modules/@leafer-in/` 下只有 `interface`）
- `leafer-ui` 核心里的 `toCanvasData` 是**路径序列化工具**（`Path#getPath` 转 canvas 指令），**不是**「把实例导出为图片」
- 加依赖的代价很高：web 容器启动命令是
  `bun install --frozen-lockfile && bun run dev`，**一旦 package.json 与 bun.lock 不同步，容器直接启动失败**；本轮网络代理不稳定（多次 502），装包有额外风险

### 3.2 采用方案：独立导出渲染器 + 零新增依赖

导出**不复用画布实例**，而是离屏重绘。理由：

1. 画布实例**绑定视口**（zoom / pan），导出必须按页面原始尺寸出图，不受视口影响
2. 一次要出**多页**，而画布只渲染当前页
3. HTML 导出无论如何都要自己生成 DOM/HTML
4. 自写渲染器可同时服务未来的 PDF

现成依赖已够用：`file-saver`（触发下载）、`fflate`（zip 打包）。

## 4. 架构

```
PortfolioDocument（纯数据，已落盘）
        │
        ▼
  assets.ts：解析图片引用 ──► Map<src, HTMLImageElement | null>
        │                     （data URL / 同源 URL / 跨域 URL 统一处理）
        ├──────────────┬──────────────┐
        ▼              ▼              ▼
 render-canvas.ts  render-html.ts   （未来）render-pdf.ts
   Canvas 2D           DOM/CSS 字符串
        │              │
        ▼              ▼
   PNG 位图        自包含 .html
        │              │
        └──────┬───────┘
               ▼
          download.ts（file-saver / fflate）
```

### 文件规划（全部新增，不改动上游既有逻辑）

```
web/src/lib/portfolio/export/
  ├── types.ts           导出选项、进度、结果类型
  ├── assets.ts          图片引用 → 可绘制图片源（缓存 + 并发限制 + 超时）
  ├── render-canvas.ts   页面 → Canvas（支持单页 / 整册长图）
  ├── render-html.ts     文档 → 自包含 HTML 字符串
  ├── download.ts        保存 Blob / 文本
  └── index.ts           对外入口：exportPagePng / exportDocumentPng / exportDocumentHtml
web/src/components/portfolio/portfolio-export-menu.tsx   导出下拉菜单
web/test/portfolio-export.test.ts                        纯函数单测
```

**改动既有文件（仅两处接线）**

- `components/portfolio/portfolio-toolbar.tsx` — 在右侧插入导出菜单
- `pages/portfolio/index.tsx` — 传入当前文档、当前页与进度提示回调

## 5. 核心算法

### 5.1 图片 fit（cover / contain / fill）

以 `naturalWidth × naturalHeight` 为源图尺寸、`width × height` 为框，计算 `drawImage` 的 9 参数裁剪区：

| fit | 源矩形 | 说明 |
|---|---|---|
| `fill` | 整图 → 拉伸到框 | 目标框直接用 |
| `contain` | 整图，等比缩放至**完整放入** | 目标框内居中留白 |
| `cover` | 等比缩放至**铺满**，超出部分裁掉 | 源矩形按框比例取中心区 |

`naturalWidth / naturalHeight` 为 0 时（历史数据缺失）用已加载图片的 `naturalWidth` 兜底。

### 5.2 文字断行（复刻 leafer 的 `textWrap: "break"`）

leafer 的 `break` 是**按字符**断行（中英文一视同仁），不是按词。复刻要点：

1. `ctx.font = \`${fontWeight} ${fontSize}px ${fontFamily}\``
2. 逐字符累加 `ctx.measureText(prefix + ch).width + letterSpacing * 已输出字符数`，超过 `width` 就换行
3. 显式 `\n` 强制换行
4. 行高 = `fontSize * lineHeight`，首行基线 = `fontSize * 0.8`（与 leafer 的 `verticalAlign: top` 对齐）
5. 超出高度的行直接截断（与画布可见范围一致）

> 断行算法写成**纯函数**（输入文字+样式+宽度，输出行数组），便于单测，也便于 HTML 导出复用同一套换行结果。

### 5.3 旋转与透明度

```
ctx.save();
ctx.globalAlpha = element.opacity;
ctx.translate(cx, cy);          // cx/cy = 元素中心
ctx.rotate(rotation * Math.PI / 180);
ctx.translate(-cx, -cy);
... 绘制 ...
ctx.restore();
```

### 5.4 长图拼接

- 画布尺寸 = `页面宽 × 倍率` 与 `所有页高度之和 × 倍率`
- 依次 `drawImage(页 canvas, 0, 累计 y)`；页间距 = 0（可选加 24px 分隔）
- **上限保护**：浏览器 canvas 有面积/边长限制（Chrome 单边 65535、Safari 面积 ≤ 16777216）。超限时**自动降级**为「多页 zip」并提示

## 6. 图片解析与跨域

导出最容易被卡住的环节。统一走 `assets.ts`：

| 图片 `src` 形态 | 处理 |
|---|---|
| `data:image/...` | 直接 `new Image()`（无跨域问题） |
| 同源（`/api/resources/{id}/file`，默认 `apiBaseURL = "/api"`） | `fetch` → `blob` → `URL.createObjectURL`，**避免 canvas 被污染** |
| 跨域绝对地址 | 先 `fetch`（带 `crossOrigin` 尝试）；失败则**跳过该图并在结果里报告**，不阻断整册导出 |

其他要点：

- **缓存**：同一 `src` 只解析一次（同一张图可能在多页重复出现）
- **并发限制**：同时最多 4 个，避免打满连接
- **超时**：单图 15 秒，超时按失败处理并记录
- **进度回调**：`(done, total)` 驱动 UI 进度条
- **收尾**：导出结束后 `URL.revokeObjectURL` 释放

> 注意：若部署时把 `VITE_CANVAS_BACKEND_URL` 配成外域，同源优势消失，此时依赖第 3 行的兜底路径。

## 7. UI 改动

工具栏右侧新增「导出」下拉（antd `Dropdown`，与现有按钮风格一致）：

```
导出 ▾
 ├─ 导出当前页 PNG
 ├─ 导出整册长图 PNG
 ├─ 导出 HTML（自包含单文件）
 ├─ ──────────────
 ├─ 倍率：1x / 2x（默认 2x）
 └─ ☐ 导出时包含图注与标签分组
```

- 图片解析期间显示进度（复用现有 `classifying` 那套底部浮动提示样式）
- 失败图片在结果里汇总提示，例如「2 张图片无法读取，已跳过」
- 所有按钮沿用现有约定：**禁用而不隐藏**

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 跨域图片污染 canvas，`toBlob` 抛安全错误 | 统一走 `fetch → blob → objectURL`；失败跳过并报告，不阻断 |
| `bun install --frozen-lockfile` 卡住新依赖 | **本轮零新增依赖** |
| 字体未加载完成，文字度量不准 | 导出前 `await document.fonts.ready`；字体回退栈与画布保持一致 |
| 文字断行与画布有视觉差异 | 断行算法抽成纯函数单测；验收时用截图和画布对比 |
| 大文档内存与 canvas 上限 | `toBlob`（不存 base64）、逐页释放、长图超限自动降级为多页 zip |
| 上游同步后 `contracts.ts` 字段变动 | 导出层只读文档模型，不写；字段缺失走兜底默认值 |
| 导出耗时让页面卡死 | 逐页 `await` 让出主线程，配合进度提示；必要时 `requestIdleCallback` 分片 |

## 9. 验收标准

1. **当前页 PNG**：尺寸 = `page.width × scale`，内容与画布一致；图片、文字、旋转、透明度、层叠顺序全部正确
2. **整册长图 PNG**：高度 = 各页高度之和 × scale；页序正确；超限时给出降级提示
3. **自包含 HTML**：**断网**双击打开仍完整显示（图片已内联）；版式与画布基本一致
4. **异常路径**：图片 404 / 跨域被拒时，导出仍产出结果并明确列出失败图片
5. **单测通过**：断行算法、图片 fit 计算、HTML 生成、长图尺寸计算
6. **不回归**：现有画布编辑、Agent 分类配文、保存/加载功能不受影响

## 10. 实施步骤

| # | 内容 | 产出 |
|---|---|---|
| 1 | `types.ts` + `assets.ts`：图片解析与缓存 | 单测：data URL / 同源 / 失败路径 |
| 2 | `render-canvas.ts`：单页渲染（图片/文字/旋转/透明度/层叠） | 单测 + 开发栈肉眼比对 |
| 3 | 长图拼接 + canvas 上限降级 | 单测：尺寸计算与降级判定 |
| 4 | `render-html.ts`：自包含 HTML | 单测 + 浏览器断网验证 |
| 5 | `download.ts` + `index.ts` 编排 | 手动验收 |
| 6 | 导出菜单 UI + 进度与错误提示 | 开发栈端到端验收 |
| 7 | 收尾：`tsc --noEmit`、`bun test`、上游改动回归 | 全绿 |

## 11. 待确认的决策点

1. **HTML 导出的语义**
   - **A 版式还原**：像素级复刻画布（每页一个绝对定位的版面），适合提案交付
   - **B 语义作品集**：图片 + 图注 + 按 `tags` 分组，响应式、可被搜索引擎读，适合发布个人站点
   - 建议：**先做 A**（与画布一致，验收标准明确），B 作为第二个模式在选择项里预留

2. **多页是「长图」还是「每页一张 zip」**
   - 建议：长图为主（用户已选定），zip 作为超限时的自动降级

3. **默认倍率**
   - 建议 2x（1600×1000 → 3200×2000），清晰度与体积平衡

4. **图注与标签是否默认进导出**
   - 建议：PNG 默认不带（保持版式干净），HTML 默认带（`caption` 作为 `alt`/图下文字），可开关
