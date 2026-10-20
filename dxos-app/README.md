# 影策 DX OS 原生窗口 App

这个包把影策放进 DX OS 的隔离窗口运行。打开后不会跳到浏览器：页面内的 `/api/*` 请求由包内 `yingce-local` bundled MCP 在 DX OS 宿主侧转发，并由连接器维护影策登录 Cookie。

页面本身在 DX OS 窗口内运行；Cookie 不写入 ZIP、浏览器存储或项目文件。连接器只代理 JSON/文本 API，单次响应限制 8 MB。

`fetch`/`XMLHttpRequest` 走 MCP 桥，但 `<img>`、`<video>`、`<audio>`、`<source>` 由浏览器原生加载，**不经过任何 JS 拦截**。相对路径 `/api/...` 会落到 DX OS 宿主源，而宿主没有影策的资源路由，只会返回 404 —— 表现就是"图生成成功但显示不出来"。因此连接器固定使用 `1724` 起的 20 个端口，并额外提供 `GET /api/__dxos/backend-origin` 让前端拿到权威地址；启动适配层把媒体地址（`src`、`poster`、`setAttribute`、内联样式的 `background-image`）改写成绝对地址（资源 URL 自带签名，不需要 Cookie）。

地址指向的不是后端本身，而是连接器内置的**本地媒体代理**（`1744` 起 10 个端口）。原因是上游前端用 `url.origin !== window.location.origin` 判断跨源，而沙箱 iframe 的 `window.location.origin` 是字符串 `"null"`，于是每一张 http(s) 图片都被加上 `crossOrigin="anonymous"`，浏览器请求会带 `Origin: null`；后端在解析 origin 阶段就判定 `"null"` 非法并返回 403（`CANVAS_CORS_ORIGINS=*` 也无效，该校验发生在通配判断之前）。裁剪、放大、作品集缩略图还要读画布像素，不能简单去掉 `crossOrigin`，否则画布会被污染。代理只做三件事：转发 `/api/` 的 GET/HEAD（含 `Range`，支持视频拖动）、对 opaque 源和本机宿主回显 `Access-Control-Allow-Origin`、拒绝远端来源的 CORS 放行。

若沙箱读取 `document.cookie` 抛出 SecurityError，启动适配层提供空 Cookie 视图，避免 Axios 的 XSRF 探测阻断登录请求；真实登录 Cookie 仍仅由宿主 MCP 维护。不修改 iframe 的 `allow-same-origin` 权限。

## 权限清单

`dx-app.json` 的 `permissions` 决定宿主放行哪些系统动作。影策当前声明：

| 权限 | 用途 |
|---|---|
| `app.yingce-main.open` | 打开应用 |
| `app.yingce-main.yingce.request` | 经 bundled MCP 调用本机 `/api` |
| `app.yingce-main.project.read` / `.write` / `.delete` | DX OS 项目目录读写（连接器状态、后端二进制、插件包） |
| `app.yingce-main.file.write` | **下载**。宿主 `file.export` 先校验该权限 |
| `app.yingce-main.ui.notify` | 把下载失败原因提示给用户 |

`file.write` 与 `ui.notify` 是新增项：**只替换 `index.html`/JS 不会更新宿主的已安装权限索引**，必须提高 `version`/`build` 后重新导入安装包，否则下载仍会失败。

## 两种后端模式

| 模式 | 说明 | 需要什么 |
|---|---|---|
| `bundled`（默认） | 后端二进制随包分发，由包内连接器拉起、健康检查、退出时回收 | 什么都不用装 |
| `external` | 只打包前端，连接器直连外部后端（例如 Docker 的 `127.0.0.1:3003`） | 外部后端已在运行 |

`bundled` 模式下连接器负责：

1. 在包外准备数据目录（默认 `~/Library/Application Support/yingce-dxos`，可用 `YINGCE_DATA_DIR` 覆盖）
2. 把包内 `mcp/plugins/*.zip` 还原成 `.yingce-plugin`，交给后端做官方插件目录
3. 给后端二进制补可执行位——DX OS 解压开发者应用时只调用 `writeFileSync`，不保留文件模式
4. 在 `1724`–`1743` 这段固定端口里挑一个空闲端口拉起后端（`YINGCE_BACKEND_PORT` 可覆盖）；媒体直连依赖端口可预测，所以不再使用随机端口
4.1. 在 `1744`–`1753` 里另起一个本地媒体代理，前端拿到的媒体地址指向它，由它补上后端不提供的 opaque 源 CORS 放行，并给 `/api/resources/**` 补上连接器持有的会话 Cookie
4.2. 同一代理上开一个上传端点 `POST /__dxos/upload?token=…&method=…&path=…`：浏览器把 FormData / 裸二进制原样 POST 过来，代理补 Cookie 后转发给后端（宿主 `/api/mcp/call-direct` 的 JSON body 上限 4 MB，base64 过桥传不动图片和视频分片）。该令牌存在数据目录的 `connector-upload-token`（0600）并跨重启复用，避免已打开的页面拿着旧令牌写不进去
5. 连接器退出时把后端一起收掉，避免残留进程；DX OS 被强杀留下的孤儿后端会在下次启动时被探活接管（`backend.json` 记录端口，状态文件丢失时再扫端口段），不会对着同一个 SQLite 库起第二个写进程

MCP 握手不等待后端就绪，所以 DX OS 的 60 秒连接超时不会被后端冷启动拖爆。

### 首次登录

`bundled` 模式默认使用全新的空数据库。影策对零用户库会自动放行注册（`backend/internal/auth/auth.go` 的 `PublicAuthSettings`），所以首次打开请直接注册第一个账号，该账号即管理员。

要接着用 Docker 里已有的项目数据，把 `backend-data` 卷里的数据导出到数据目录，或改用 `external` 模式。

## 启动方式（必读）

只从 **`DX OS Portable.app`** 启动。每次更新都会新建一个 `runtime-*` 目录，旧目录里的
`DX OS.app` 与新副本的 Bundle ID 同为 `cn.meross.dxos`；一旦旧副本被注册进
LaunchServices，按应用名唤起或 Spotlight 搜索就可能命中它。旧副本抢不到 `5275`，
API 判定为重复启动后以 0 退出，桌面端就报：

    本地 API 提前退出，退出码 0

这不是影策后端故障。打包脚本（`.local/dxos-build.sh`、`更新到最新上游.command`）会在
开始和结束时调用 `.local/dxos-unregister-stale.sh`：

- 只保留 `.dx-runtime/.active-runtime` 指向的运行时与 `DX OS Portable.app` 的注册
- 把非 active 的 `DX OS.app` 改名为 `DX OS.app.disabled`（可逆，不删文件）
- 清理旧安装版留下的空壳 `~/DX OS` 数据目录（仅 `legacyHadData=false` 时）

排查时按顺序看：

    tail -40 ~/Library/Logs/DX\ OS/desktop.log                  # 被误拉起的安装版
    tail -40 "~/DXOS/DXOS-Portable-0.5.4-mac-arm64/data/logs/desktop.log"
    lsof -nP -iTCP:5275 -sTCP:LISTEN                              # 端口持有者是否 Portable

## 构建与导入

拉取作者最新代码、合并、编译后端、构建前端并打出 ZIP，一条命令：

    dxos-app/更新到最新上游.command        # 双击运行即可

它依次执行 `git fetch upstream --prune` → 显示领先/落后提交数 → `git merge --no-edit upstream/main`（冲突则停下并提示手动解决）→ `build-backend.py` → `rebuild.py --ref HEAD`，最后打印新 ZIP 路径。只重新打包当前检出（不拉上游）用 `dxos-app/重新打包DXOS应用.command`。

手动等价流程：

    git fetch upstream --prune && git merge upstream/main
    python3 dxos-app/build-backend.py            # 编译 macOS arm64 后端（Go 1.25 + cgo）
    python3 dxos-app/rebuild.py --ref HEAD \
        --backend-bin dxos-app/backend-bin/yingce-backend

`build-backend.py` 依次在 `PATH`、`~/.local/toolchains/go/bin/go`、`/opt/homebrew/bin/go`、`/usr/local/bin/go` 里找 Go，缺失时会打印三种安装方式。仓库自带完整的 Go 模块缓存 `.local/cache/go-mod`，模块齐全时无需联网。

上游改了 `web/bun.lock` 时 `rebuild.py` 会自动按新锁文件重装依赖卷 `oc-web-nm`（卷里存 `.bun-lock-sha256` 标记做比对）；也可以显式强制刷新：

    python3 dxos-app/rebuild.py --ref HEAD --refresh-deps \
        --backend-bin dxos-app/backend-bin/yingce-backend

只想用现成的 `web/dist` 重新打 ZIP：

    python3 dxos-app/build.py --dist <dist 目录> --backend bundled \
        --backend-bin dxos-app/backend-bin/yingce-backend

`--backend-bin` 省略时优先取 `dxos-app/backend-bin/yingce-backend`，只有该文件缺失才回退到仓库里的历史二进制 `backend/server`。

`rebuild.py` 把 `--ref`（默认当前检出）导出到独立的 `.local/dxos-builds` 目录，应用 Hash 路由、Axios 禁用 Cookie/XSRF 探测和相对资源路径，然后运行类型检查和 Vite 构建，最后调用 `build.py`。构建在 `oven/bun:1.3.13` 容器里离线执行，依赖来自只读卷 `oc-web-nm`（可用 `--deps-volume` 换卷）。

上游若改动了适配依赖的位置（`web/src/router.tsx` 的 `createBrowserRouter` 出现次数、`web/src/services/api/request.ts` 的 `axios.create` 签名、`web/vite.config.ts` 的 `base`），脚本会主动报错退出，不会产出坏包。看到这类报错说明需要人工核对新的上游代码再更新适配。

`build-backend.py` 需要 Go 1.25+ 与 Xcode 命令行工具（sqlite3 驱动走 cgo）。仓库自带完整的 Go 模块缓存 `.local/cache/go-mod`，模块齐全时无需联网。

包内 `dxos-build-source.json` 记录实际来源提交和适配项；`build.py` 拒绝没有该记录的 dist。导入后关闭影策窗口再重新打开，避免 `keep-alive` 保留旧代码。登录路径应留在包内 `index.html#/login`。

脚本会排除 DX OS 0.5.1 不接受的 mp4、glb、gltf、tflite 可选演示资源，并在生成 ZIP 前检查文件类型、条目数和解压体积。将输出的 `output/dxos-app/*.zip` 导入 DX OS 的开发者 App 安装入口。

## DX OS 打包限制（宿主 `server/developerApps.ts`）

| 限制 | 值 | 处理方式 |
|---|---|---|
| 压缩包大小 | 200 MB（`DX_APP_MAX_PACKAGE_MB` 可调，上限 512） | `build.py` 提前拦截 |
| 解压后总内容 | 500 MB（写死） | `build.py` 提前拦截 |
| 单文件 | 500 MB | — |
| 条目数 | 2048 | `build.py` 提前拦截；1.6.2 实测 1790 条（含 Agent 运行时 zip 与灵感缩略图 zip） |
| 文件类型 | 白名单；原生运行时只允许在 `mcp/` 下 | 后端改名 `.exe`，插件改名 `.zip` |

非支付官方插件只有 0.87 MB；支付插件 84.6 MB，默认不打入，需要时加 `--with-payment-plugins`。

## 已知限制

- **下载必须经宿主 `file.export`，页面内的 `<a download>` / `blob:` 点击在 DX OS 里无效。** 宿主给第三方 APP 的 iframe 沙箱只声明 `allow-scripts allow-forms allow-pointer-lock`（`comfyui`/`canvas` 才额外拿到 `allow-same-origin allow-popups allow-downloads`），所以锚点点击会被静默拦掉——页面既不报错也不下载，用户看到的就是"点了没反应"。适配层现在拦截这类锚点，经媒体代理取回字节后交给 `window.dx.invoke('file.export', { destination: 'download', name, mime, content })`，并在失败时上报 `/api/__dxos/diag`（`kind: 'download-error'`）加 `ui.notify` 提示。Base64 过桥上限 24 MB，超过的媒体改走宿主 `dx.files.upload` 二进制通道（尚未接入）。
- 媒体**展示**与**上传**都已可用：展示经本地媒体代理直连包内后端（含 `crossOrigin` 图与画布取像素），上传经代理的上传端点补齐会话 Cookie（小文件 `POST /api/resources` 走 FormData，大文件走 `/api/resources/uploads` + 每片 8 MB 裸 `PUT`）。SSE/WebSocket 实时流仍需要单独接入 DX OS 的 `project.*`、`file.*` 或任务桥，当前版本不会把这些能力伪装成已支持。
- 应用自身的静态资源（`/short-drama-styles/*`、`/welcome/*` 等根绝对路径）由适配层改写成相对路径，并按 `/api/developer-runtime/<token>/` 补回被 `new URL(..., import.meta.url)` 算丢的 token 段。
- 根绝对路径的**数据文件**（`fetch('/inspirations/manifest.json')` 这类）走的是 `fetch`/XHR，不是元素属性，元素改写拦不到：请求落到宿主根路径会被 SPA 回退成 `index.html`，而且该路由没有 `Access-Control-Allow-Origin`，在 opaque origin 的沙箱 iframe 里直接 `Failed to fetch`。适配层现在在 `fetch`/`XMLHttpRequest` 包装里对「同源、非 `/api/`、尚未带 runtime 前缀」的根绝对地址补回 `/api/developer-runtime/<token>/`；`/api/...`（后端接口、媒体直连）与外部站点一律不动。
- **媒体代理活在连接器进程里，地址会被页面缓存。** 前端加载媒体前只探测一次代理地址（`/api/__dxos/backend-origin`），而代理原先只在那次探测时才启动。DX OS 重启连接器（重开应用、回收进程、`/api/mcp/servers/:id/refresh`）后，已经打开的页面仍然指着上一个代理端口，图片/视频就再也加载不出来——浏览器不会自动重试失败的 `<img>`，表现成「画布上的图又不见了」。现在两侧都补上了：连接器一启动就把代理拉起来（端口立刻在听），页面侧在媒体加载失败时作废缓存重新探测一次并按新地址重试（每个元素最多 2 次，批量失败共用同一次探测）。
- **写请求同样不能用页面缓存的地址与令牌。** 上传令牌原先每次启动重新随机，而页面只在首次探测时取一次：连接器被 DX OS 重启后，已打开的页面继续用旧令牌发 `POST/PATCH/PUT/DELETE`，一律收到连接器回的**纯文本 403「上传令牌无效」**（不是后端的 JSON 信封），页面只能显示 Axios 的默认文案 `Request failed with status code 403` —— 看起来像「什么都没改却突然存不了」，且在 `backend.log` / `dxos-media.log` 里都查不到（403 发生在令牌校验处，先于请求体读取与日志记录）。两侧都已修：令牌落盘复用（重启不变），且直连写通道（`fetch` 与 XHR 两条）在识别到该纯文本 403 时作废缓存重新探测一次并重放；后端自身带 JSON 信封的 403 不会被误判，`ReadableStream` 请求体不重放（只能消费一次）。
- 排查媒体与上传问题看 `~/Library/Application Support/yingce-dxos/logs/dxos-media.log`：代理会逐条记录状态码，前端 `<img>` 加载失败也会回报到这里。
- 媒体直连走的是后端签名地址，签名有效期由后台存储配置决定；地址过期时前端会按访问接口重新签发。
- Agent 运行时（`backend/agent-runtime/pi`）已随包分发：打包时精简（剔除 `.ts` 源码、`.map`、文档与测试目录）后压成单个 `mcp/agent-runtime.zip`（宿主条目/后缀限制放行），连接器在拉起后端前把它解压到数据目录并注入 `CANVAS_PI_RUNTIME_DIR`；zip 变化（升级）时自动重新解压。显式设置 `CANVAS_PI_RUNTIME_DIR` 时直接沿用，不再解压。
- `CANVAS_PUBLIC_BASE_URL` 默认留空，依赖它签发短时链接的功能（Agent 看图、参考图）需要显式配置。
- **Agent 看图必须先在后台声明模型能力。** 上游从 v1.5.5 起把文本模型的图片输入设成「默认关闭、管理员显式开启」：`backend/internal/app/cloud_agent_vision.go` 的 `cloudAgentVisionEnabled` 要求该渠道模型的 `text.references.maxImages > 0`，否则 `cloud_agent_tools.go` 根本不注册 `canvas_inspect_image`，模型只能拿到图片节点的元数据（文件名、尺寸、字节数），再凭标题猜画面。当前库里 10 个文本模型的 `capability_config_json` 全是模板默认值 `maxImages: 0`，已在 影策后台 → 渠道模型 → 能力配置 → 图片 把 `agnes-3.0-flash` 改成 4 张 / 10 MB。**换用其它文本模型要重复这一步**；从旧安装重新导入渠道配置也可能把它覆盖回 0。
- 视频 H.265→H.264 转码依赖 ffmpeg，未随包分发。
- 灵感画廊的 355 张本地缩略图（`web/public/inspiration-thumbs/`）不再展开成文件：1.6.2 上游新增这批图后，整包会从 1738 条涨到 2144 条、越过宿主的 2048 条上限。`build.py` 现在把它们收进 `mcp/inspiration-thumbs.zip`（STORED，不解压），并把 `web/public/inspirations/*.json` 里的封面地址改写成 `/api/dxos-thumbs/<相对路径>`；连接器的媒体代理命中该前缀时按 ZIP 偏移切片直接返回，不经过后端。

## 验证记录

媒体恢复包（`output/dxos-app/yingce-main-v1.6.2-b1791534502.zip`，124,741,741 B / 1790 条，来源 `dev@1b9af81f`）与上一包只差 3 个文件（`dx-app.json` 的 build 号、`dxos-bootstrap.js`、`mcp/server.js`），已实测：

- 连接器重启后立刻自建媒体代理：`POST /api/mcp/servers/yingce-local/refresh` 只发这一个请求，新连接器进程（`node server.js`, pid 变化）在 20 秒内就让 `127.0.0.1:1744` 处于 LISTEN，无需任何页面请求触发。
- 页面侧自愈（无头 Chrome + `sandbox` opaque-origin iframe + 安装目录里真实的 `dxos-bootstrap.js`，父页面第一次回答一个没人监听的代理地址 `1759`、第二次回答真实代理 `1744`）：探针次数 2、首次加载 `error` 1 次、最终 `naturalWidth=675`、`img.src` 仍返回逻辑地址 `/api/resources/<id>/file`。复跑脚本：`node /tmp/verify-media-retry.cjs <安装目录> http://127.0.0.1:1744 <资源ID>`。
- `node --test dxos-app/bootstrap.test.cjs dxos-app/mcp-server.test.cjs` 共 54 项通过（新增 3 项：媒体失败后重探并按新地址重试、重试次数封顶、连接器启动即拉起媒体代理）。
- Agent 看图端到端实测（2026-10-09 16:47，`agnes-3.0-flash` / `CHANNEL_000001` 的 `maxImages` 由 0 改为 4 之后）：经 DX OS 桥 `POST /api/mcp/call-direct` → `POST /api/agent/runs`（`permissionMode=read_only`，指向画布 `L0ER1x_aM5M9ebmwaZM-F` 的图片节点 `upload-1791478442322-wints`）创建 run `ag453fdf6f028e3ebecf18bab14b9a90ee`。转录（`cloud_agent_message_records`）显示模型先调 `canvas_inspect_image`、拿到 37642 B / 675×1200 的真实 JPEG，再输出「剪影风格的两只黑猫、橙红背景、右下角浅色标记」——即真的读到了画面，而不是照抄节点标题。改配置前同一条消息只会走 `image_text_detect`（返回 `ready_for_visual_detection` 占位），模型看不到任何画面。
- 连接器新增 `YINGCE_MEDIA_PORT` 环境变量：显式指定时只用该端口，被占用直接报错，便于自动化测试与排障。

上一包（`output/dxos-app/yingce-main-v1.6.2-b1791528299.zip`，119.0 MB / 1790 条 / 解压 220.8 MB，来源 `dev@1b9af81f`）已实测：

- 按宿主 `server/developerApps.ts` 的 `readZip()` 逐条复刻校验：EOCD 条目数 1790 ≤ 2048、中央目录 1790 条签名完整、解压总量 220.8 MB ≤ 500 MB、无白名单外后缀（`.exe`/`.zip` 仅出现在 `mcp/` 下）。
- 灵感缩略图链路：用包内真实的 `mcp/` 起连接器，按 `web/public/inspirations/*.json` 引用的 355 个封面地址逐个请求 `/api/dxos-thumbs/...`，全部 200 / `image/webp` / 字节与源文件一致；未收录路径返回 404 且不落到后端。
- 灵感广场在**真实 DX OS**里的端到端验收（无头 Chrome，`sandbox="allow-scripts"` 的 opaque-origin iframe 加载 `http://127.0.0.1:5275/api/developer-runtime/<token>/index.html`）：

  | 探针 | 旧包（修复前） | 新包（修复后） |
  |---|---|---|
  | `fetch('/inspirations/seedance.json')` | `Failed to fetch`（根路径 SPA 回退 + 无 CORS 头） | 200 `application/json`，解析出 767 条 |
  | `fetch('/inspirations/gallery-pool.json')` | `Failed to fetch` | 200 `application/json`，657 KB |
  | `<img src="/short-drama-styles/three-d-cartoon.jpg">` | 已可用（元素属性改写） | 已可用，`naturalWidth=660` |
  | `<img src="/api/dxos-thumbs/seedance/....webp">` | — | 已可用，`naturalWidth=560`（经连接器媒体代理 1744 返回） |

  复跑脚本：`node /tmp/verify-inspiration-fix.cjs --dxos <runtimeToken>`（`--source <安装目录>` 可用本地服务器按同样的 DX OS 规则复现）。

1.6.1 包（`yingce-main-v1.6.1-b1791459577.zip`，80.6 MB / 1737 条 / 来源 `dev@268c1c0d`）此前已实测：

- 后端二进制单独启动：迁移通过、官方插件 97 个、`/api/health/ready` 200、`/api/auth/settings` 首用户可注册、注册后该账号为管理员、登录 200。
- 整包解压后按 DX OS 的方式运行连接器（先把可执行位改回 0644 模拟宿主解压）：连接器自动补回 0755、还原 97 个插件包、写出 `backend.json`，`initialize` / `tools/list` / `tools/call` 全链路正常，`/api/plugins` 返回 102 项、`/api/skills` 返回 20 项。
- 关闭连接器 stdin 后，托管后端被一起回收，无残留进程。
- 升级路径：模拟 DX OS 保留上一版 env 的历史 `YINGCE_BACKEND_URL=http://127.0.0.1:3003`，包内 `YINGCE_BACKEND_MODE=bundled` 压过残留值，仍然拉起包内后端。

- 媒体显示：`<img>` 走的是原生加载而不是 `fetch`，宿主 `http://127.0.0.1:5275/api/public/resources/<id>/file` 返回 404，而包内后端同路径返回 200 / `image/png` / 2.5 MB。启动适配层会把 `/api/...` 媒体地址改写成后端绝对地址，普通图片由此上屏。
- 带 `crossOrigin="anonymous"` 的图片：这类图由上游的跨源判断触发（沙箱里 `location.origin` 是 `"null"`，所有 http(s) 图片都被判定为跨源）。直连后端时后端对 `Origin: null` 返回 403，图片依旧不显示。用无头 Chromium 在 `sandbox` + opaque origin 的 iframe 里实测：直连后端时 `plain=1024 / cors=失败 / bg=1024`，经本地媒体代理后 `plain=1024 / cors=1024 / bg=1024`，且 `ctx.getImageData()` 取像素返回 `ok`（说明 CORS 校验真的通过，画布没有被污染）。

- 静态资源路径错位：应用挂在 `/api/developer-runtime/<token>/` 下，但构建产物按站点根目录写地址，`/short-drama-styles/*.jpg`、`/welcome/*.webp` 全落到宿主源 404（页面里灵感图、风格图全空）。适配层改写后在无头 Chromium 的 `sandbox` iframe 里实测 `nw=1200`；`new URL('../../welcome/...', import.meta.url)` 算丢 token 段的地址也能补回。
- 未签名资源地址：`/api/resources/<id>/file` 在浏览器侧没有 Cookie，直连后端返回 401（实测 `ERR_BLOCKED_BY_ORB`）。媒体代理对这条前缀补 Cookie 后返回 200 / `image/png`。
- 参考图上传：`FormData POST /api/resources` 与分片 `PUT /api/resources/uploads/<id>/chunks/<n>`（裸 8 MB Blob）在沙箱里实测分别返回 201（带 `data.resource.id`）与 204，后端收到的 Cookie 为会话值、multipart boundary 由浏览器生成未被覆盖。此前这两条路径会被适配层直接拒绝，前端只显示「未收到服务端确认」。
- 画布 304 轮询：画布同步带 `If-None-Match` 重新拉取项目，后端回 304；适配层此前把它当普通响应带 body 构造 `Response`，触发浏览器规范错误「Response with null body status cannot have body」，画布编辑器整页进错误边界（用户看到的正是这句话）。现在无正文状态构造不带 body 的 Response，实测同一条请求返回 304、正文为空。

`node --test dxos-app/bootstrap.test.cjs dxos-app/mcp-server.test.cjs` 当轮 51 项通过（含 Agent 运行时解压与环境变量注入、以及根绝对静态数据补回 runtime 前缀的 fetch/XHR 三个用例）。

- Agent 运行时链路（包 `yingce-main-v1.6.1-b1791473753.zip`）：包内 `mcp/agent-runtime.zip` 31.6 MB，解压后 9057 个文件 / 约 100 MB；在该目录直接 `node agent-runtime.mjs`（空 stdin）返回结构化 `runtime_error`（等待 bridge/session/model 配置），证明整条依赖链可加载。真实后端二进制带 `CANVAS_PI_RUNTIME_DIR` 启动后注册、登录、建画布、发起 Agent run，日志中不再出现「Agent runtime files are missing」。

- 本机媒体库脏记录（包 `yingce-main-v1.6.2-b1791539148.zip`，来源 `dev@c11f08ad`）：`File` 是 Blob 的子类，但 `Object.prototype.toString` 给它的标签是 `[object File]`，而 localforage 的序列化器只还原 `[object Blob]`。上传直传失败退回本机时写进 `yingce/image_files` 的 `File` 因此落到 `JSON.stringify` 分支被拍平成 `{}`，取回来 `type` 是 `undefined`、内容也不在。此后每一轮云端数据同步读到这条媒体都会在 `blob.type.startsWith(...)` 抛 `Cannot read properties of undefined (reading 'startsWith')`，于是画布保存和 Agent 提交都被一条脏记录整批卡死；后端日志表现为约 1.2 秒一轮的 `GET /api/agent/capabilities` → 13 个 `GET /api/assets/<幽灵ID> 404` → 没有 `POST /api/agent/runs`，前端面板显示「未收到服务端确认」加一句裸 JS 异常。现在所有本地媒体写入口先经 `toStorableBlob` 收敛成普通 Blob；同步侧遇到内容不可用（被拍平或已被清空）只跳过这一条并 `console.warn`，保留原引用，不再让整批用户数据失败——DX OS 规范本来就只允许把 localStorage/IndexedDB 当可丢失的缓存，本机媒体库不是主数据源。

  验证：`oven/bun:1.3.13` 容器内 `bun test test/local-media-store-blob.test.ts test/local-media-sync-missing.test.ts test/user-data-sync-message.test.ts test/canvas-media-performance.test.ts test/agent-canvas-sync.test.ts`（88 项）与 `bun run typecheck` 全过；渲染侧用无头 Chromium + 安装目录里真实的 `dxos-bootstrap.js` 在 `sandbox` opaque-origin iframe 里启动真实产物，75 个 chunk 全部加载、0 异常（复跑脚本：`node /private/tmp/ycdiag/boot-smoke.cjs <安装目录> <画布ID>`）。浏览器里 localforage 的 `File`/`Blob` 行为用 `/private/tmp/probe-file.cjs` 单独钉住过：`Blob` 读回仍是 `Blob`（`type: image/png`），`File` 读回是 `{}`。

### 为什么 manifest 里要有 `YINGCE_BACKEND_MODE`

DX OS 的 `appManagedValues()`（`server/mcp.ts`）在升级 APP 时会保留上一版 `env` 里用户没改过的键，而空字符串会被当成「等待用户配置」的占位值继续沿用。只按「有没有 `YINGCE_BACKEND_URL`」判断模式，会让上一版 external 配置的地址劫持新的 bundled 包，表现成包内后端永不启动。两种模式都写死 `YINGCE_BACKEND_MODE`，连接器以它为准。

DX OS 会给 MCP 子进程的 `PATH` 前置自带 Node 目录（`…/runtime/node-runtime`），所以 `mcp.json` 里的 `command: "node"` 由 DX OS 自带 Node 22 解析，不依赖用户系统 PATH；后端里 `exec.Command("node")` 同理。

## 上游同步

作者更新后，双击 `dxos-app/更新到最新上游.command` 即可。它会合并 `upstream/main`、编译后端、重新构建前端并打出新的 ZIP。然后在 DX OS 里导入这个 ZIP 覆盖安装，**Cmd+Q 完全退出 DX OS 再重开**（manifest 是 `backgroundMode: keep-alive`，不彻底退出会继续跑旧代码），最后用原账号登录。

几点值得记住：

- **数据和代码分离。** 数据库、插件、Skill 都在包外数据目录 `~/Library/Application Support/yingce-dxos`，导入新包不会清空。但 `CANVAS_AUTO_MIGRATE=true` 会在启动时对这份数据库执行新版迁移，所以升级前建议先备份该目录（迁移脚本自己也会写一份 `backups/` 快照）。
- **build 号自动递增。** `build.py` 的 `next_build()` 取 `max(time(), previous + 1)`，不用手改版本号。
- **升级前确认端口段可用。** 媒体直连依赖后端端口段 `1724`–`1743` 与媒体代理端口段 `1744`–`1753`；如果这两段被别的程序占满，连接器会退回随机端口，此时图片等媒体仍会显示失败（JSON 接口不受影响）。
- **换机器构建时**，先确认 DX OS 里已装包的 build 号，确保新包 build 更高。正式发布需把 `--channel stable` 与版本号、发布说明一起管理；同版本发新包必须提高 build。
- 需要支付插件时加 `--with-payment-plugins`（约 +85 MB）。

## 后台在线更新（`tools/dxos-updater`）

上面的「导入 ZIP 覆盖安装」是手工流程；现在也可以在影策后台点「系统更新」自动完成：

```
影策后台「系统更新」
  → 包内 backend /api/admin/system-update
  → ~/.yingce/dxos-updater.sock（仅当前用户可连）
  → tools/dxos-updater（宿主常驻）：git archive 导出 dev → 编译后端 → bun 构建前端 → 打 ZIP
  → DXOS 本地导入接口 → 等新后端健康 → 校验运行中的 commit
```

```bash
bash tools/dxos-updater/scripts/start.sh   # 启动/重启（幂等）
bash tools/dxos-updater/scripts/stop.sh    # 停止
```

- **不碰工作区**：构建在临时目录用 `git archive` 导出目标提交，不切分支、不改当前检出。
- **密钥不落包**：token 在 `~/.yingce/dxos-updater-token`（0600），由 `mcp/server.js`
  在拉起后端时读取并注入 `CANVAS_UPDATER_TOKEN` / `CANVAS_UPDATER_SOCKET`。
- **验证看运行态**：除包内 `dxos-build-source.json` 外，还要求
  `127.0.0.1:1724/api/health/ready` 报告的 commit 一致；否则自动重连连接器。
- **失败自动回退**：先停后端再恢复数据目录（避免 SQLite `-wal/-shm` 覆盖），
  再回退 DXOS 历史版本；备份保留最近 3 份（每份约 630 MB）。
- 市场发布通道上限 100 MB，而影策包约 122 MB，因此只能走本地导入接口（上限 200 MB）。
