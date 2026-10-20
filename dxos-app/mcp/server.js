#!/usr/bin/env node
/* DX OS 宿主侧连接器：托管包内影策后端，并把前端 /api 请求转发过去。
 *
 * 两种模式：
 *   bundled（默认）—— 拉起包内自带的 Go 后端，端口、数据目录、插件目录全部由本进程管理。
 *   external      —— 设置 YINGCE_BACKEND_URL 时改为直连该地址，不再拉起本地后端。
 *
 * DX OS 解压开发者应用时不保留可执行位，所以后端二进制在启动前需要补 chmod。
 * 所有用户数据写在包外，升级替换整包时不会丢失。
 */
'use strict'
const readline = require('node:readline')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const http = require('node:http')
const crypto = require('node:crypto')
const { Readable } = require('node:stream')

const MCP_DIR = __dirname
const BACKEND_BINARY = path.join(MCP_DIR, 'yingce-backend.exe')
const BUNDLED_PLUGIN_DIR = path.join(MCP_DIR, 'plugins')
const AGENT_RUNTIME_ZIP = path.join(MCP_DIR, 'agent-runtime.zip')
const INSPIRATION_THUMBS_ZIP = path.join(MCP_DIR, 'inspiration-thumbs.zip')
const READY_TIMEOUT_MS = Number(process.env.YINGCE_BACKEND_TIMEOUT_MS) || 120000
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const LOG_TAIL_BYTES = 4000
// <img>/<video>/<audio> 由浏览器原生加载，不经过 fetch/XHR 桥，只能直连后端端口。
// 所以后端端口必须可预测：固定一段端口供前端探测，避免每次启动都换随机端口。
const DEFAULT_BACKEND_PORT = 1724
const BACKEND_PORT_SPAN = 20
// 沙箱 iframe 里 window.location.origin 是字符串 "null"，上游前端据此把每个 http(s)
// 图片都判定成跨源并设置 crossOrigin="anonymous"，浏览器请求会带上 Origin: null。
// 后端在解析 origin 阶段就把 "null" 判成非法来源并直接 403（CANVAS_CORS_ORIGINS 填 *
// 也救不了，校验发生在通配之前），于是这些图一律显示不出来。前端组件又要读画布像素
// （裁剪、放大、作品集缩略图），不能简单去掉 crossOrigin，否则画布会被污染。
// 解法是包内自带一个本地媒体代理：对浏览器放行 opaque 源，再转发给真实后端。
const DEFAULT_MEDIA_PORT = 1744
const MEDIA_PORT_SPAN = 10
// 上传通道：宿主 /api/mcp/call-direct 的 JSON body 上限是 4 MB，base64 走桥传不动稍大的
// 图片。改为让浏览器把原始字节 POST 到媒体代理的上传端点，代理再带 Cookie 转发给后端，
// 这样 FormData/分片 PUT 都能原样通过，也不受 4 MB 限制。
const MAX_UPLOAD_BYTES = 128 * 1024 * 1024
// 上传令牌原来每次启动都重新随机，但前端只在页面首次探测时取一次：连接器被 DX OS
// 重启（重开应用、导入新版本）之后，已经打开的页面仍拿旧令牌发写请求，会被
// /__dxos/upload 统一判 403「上传令牌无效」，看起来像「配置没动却突然什么都存不了」。
// 令牌只是本机回环上的防误触发凭据，不是安全边界，因此落盘复用，重启后页面无需重载。
const UPLOAD_TOKEN_FILE_NAME = 'connector-upload-token'
function uploadTokenFilePath() { return path.join(resolveDataDir(), UPLOAD_TOKEN_FILE_NAME) }
function loadPersistedUploadToken() {
  try {
    const value = fs.readFileSync(uploadTokenFilePath(), 'utf8').trim()
    if (/^[0-9a-f]{48}$/.test(value)) return value
  } catch (_) { /* 首次运行或文件损坏：按下面重新生成 */ }
  const generated = crypto.randomBytes(24).toString('hex')
  try {
    const file = uploadTokenFilePath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, generated, { mode: 0o600 })
    fs.chmodSync(file, 0o600)
  } catch (_) { /* 落盘失败只影响「重启后免重载」，不阻断本次会话 */ }
  return generated
}
const UPLOAD_TOKEN = loadPersistedUploadToken()

// DX OS 升级 APP 时会保留上一版 env 里用户没改过的键：历史 external 配置留下的
// YINGCE_BACKEND_URL 会被带进 bundled 包，把连接器劫持到已失效的地址。
// 因此用显式的 YINGCE_BACKEND_MODE 决定后端来源，URL 只在 external 模式下生效。
const BACKEND_MODE = (process.env.YINGCE_BACKEND_MODE || '').trim().toLowerCase()
const EXTERNAL_BACKEND_URL = (process.env.YINGCE_BACKEND_URL || '').trim().replace(/\/$/, '')
const USE_EXTERNAL_BACKEND = BACKEND_MODE === 'external' || (BACKEND_MODE !== 'bundled' && Boolean(EXTERNAL_BACKEND_URL))
let base = USE_EXTERNAL_BACKEND ? EXTERNAL_BACKEND_URL : ''
// 登录凭据（后端会话 Cookie）原本只活在内存里：连接器一重启（导入新版本、应用重载）
// 就丢，用户每次升级都得重新登录一次。这里把它落到包外的数据目录，下次启动直接恢复；
// 文件权限 600，只有本机当前用户可读，写入失败也不影响本次会话。
const SESSION_FILE_NAME = 'connector-session.json'
function sessionFilePath() { return path.join(resolveDataDir(), SESSION_FILE_NAME) }
function loadPersistedCookie() {
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionFilePath(), 'utf8'))
    return String((parsed && parsed.cookie) || '')
  } catch (_) {
    // 首次运行、文件损坏或权限不足都按“没有登录态”处理，不影响启动。
    return ''
  }
}
function persistCookie(value) {
  try {
    const file = sessionFilePath()
    if (!String(value || '')) {
      try { fs.rmSync(file, { force: true }) } catch (_) { /* 本来就不存在 */ }
      return
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ cookie: value, savedAt: new Date().toISOString() }), { mode: 0o600 })
    fs.chmodSync(file, 0o600)
  } catch (_) { /* 落盘失败只影响“免登录”，不阻断主流程 */ }
}
let cookie = loadPersistedCookie()
let child = null
let backendLogTail = ''
let starting = null

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

function send(message) { process.stdout.write(JSON.stringify(message) + '\n') }
function result(id, value) { send({ jsonrpc: '2.0', id, result: value }) }
function error(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }) }
function content(text, isError = false) { return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) } }

function resolveDataDir() {
  const configured = (process.env.YINGCE_DATA_DIR || '').trim()
  if (configured) return path.resolve(configured)
  return path.join(os.homedir(), 'Library', 'Application Support', 'yingce-dxos')
}

// 显式设置 YINGCE_BACKEND_PORT 时只用那一个端口（排障与自动化测试），
// 否则使用固定端口段，前端才能用同一套规则探到后端。
function candidatePorts() {
  const pinned = Number(process.env.YINGCE_BACKEND_PORT)
  if (Number.isInteger(pinned) && pinned > 0) return { base: pinned, span: 1 }
  return { base: DEFAULT_BACKEND_PORT, span: BACKEND_PORT_SPAN }
}

function probeHealth(port, timeoutMs = 1500) {
  return fetch('http://127.0.0.1:' + port + '/api/health/ready', { signal: AbortSignal.timeout(timeoutMs) })
    .then((response) => (response.ok ? 'http://127.0.0.1:' + port : null))
    .catch(() => null)
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function pickPort() {
  const { base: basePort, span } = candidatePorts()
  for (let offset = 0; offset < span; offset += 1) {
    if (await canListen(basePort + offset)) return basePort + offset
  }
  // 整段端口都被外部程序占用时退回随机端口：后端仍然可用，只是媒体直连要等
  // 前端在端口段里探测失败后回落到 MCP 桥。
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', (e) => reject(new Error('无法分配本地端口：' + String(e?.message || e))))
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address && typeof address === 'object' ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('无法分配本地端口'))))
    })
  })
}

function noteBackendOutput(chunk) {
  backendLogTail = (backendLogTail + String(chunk)).slice(-LOG_TAIL_BYTES)
}

// DX OS 解压开发者应用时只调用 writeFileSync，不写文件模式，可执行位会丢。
// 这里在 spawn 之前补回来；已经可执行时不做多余 chmod。
function ensureExecutable(target) {
  const stats = fs.statSync(target)
  if ((stats.mode & 0o111) === 0) fs.chmodSync(target, 0o755)
  return target
}

// 包内插件以 .zip 后缀存放（DX OS 只允许白名单后缀），运行时还原成
// .yingce-plugin 再交给后端。缺少插件目录时后端会拒绝启动，所以这一步必须成功。
function materializePlugins(dataDir) {
  const target = path.join(dataDir, 'official-plugin-packages')
  fs.mkdirSync(target, { recursive: true })
  if (!fs.existsSync(BUNDLED_PLUGIN_DIR)) return target
  for (const name of fs.readdirSync(BUNDLED_PLUGIN_DIR)) {
    if (!name.toLowerCase().endsWith('.zip')) continue
    const from = path.join(BUNDLED_PLUGIN_DIR, name)
    const to = path.join(target, name.replace(/\.zip$/i, '.yingce-plugin'))
    const source = fs.statSync(from)
    let current = null
    try { current = fs.statSync(to) } catch (_) { current = null }
    if (current && current.size === source.size) continue
    fs.copyFileSync(from, to)
  }
  return target
}

// 后端 Agent 运行时依赖 node_modules（约 9000 个文件），不能直接放进包里：
// DX OS 限制 mcp/ 下的文件后缀和整包条目数。运行时打成一个 zip，首次启动时
// 解压到数据目录；升级后 zip 变化会重新解压。显式设置 CANVAS_PI_RUNTIME_DIR
// 时（外部运行时/开发模式）直接沿用。
function materializeAgentRuntime(dataDir) {
  const explicit = (process.env.CANVAS_PI_RUNTIME_DIR || '').trim()
  if (explicit) return explicit
  const devDir = path.join(MCP_DIR, 'agent-runtime', 'pi')
  if (fs.existsSync(path.join(devDir, 'agent-runtime.mjs'))) return devDir
  if (!fs.existsSync(AGENT_RUNTIME_ZIP)) return ''
  const target = path.join(dataDir, 'agent-runtime', 'pi')
  const zipStat = fs.statSync(AGENT_RUNTIME_ZIP)
  const marker = String(zipStat.size) + ':' + String(Math.floor(zipStat.mtimeMs))
  let stampPath = path.join(dataDir, 'agent-runtime', '.runtime-stamp')
  let current = null
  try { current = fs.readFileSync(stampPath, 'utf8') } catch (_) { current = null }
  if (current === marker && fs.existsSync(path.join(target, 'agent-runtime.mjs'))) return target
  fs.rmSync(path.join(dataDir, 'agent-runtime'), { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true })
  try {
    execFileSync('unzip', ['-oq', AGENT_RUNTIME_ZIP, '-d', target], { stdio: 'ignore' })
    fs.writeFileSync(stampPath, marker)
  } catch (e) {
    noteBackendOutput('\n[yingce] Agent 运行时解压失败：' + String(e?.message || e) + '\n')
    return ''
  }
  return target
}

// 系统代理（Clash/V2Ray 等）经常把模型上游的 TLS 连接直接掐断（EOF，约 5 秒后断开），
// 而影策的中转站地址本来就能直连。默认不让后端继承代理环境变量，避免“配置都对却一直
// 网络异常/鉴权失败”。确实需要走代理时，在连接器环境里设 YINGCE_USE_SYSTEM_PROXY=1。
const BACKEND_PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']
function backendChildEnv() {
  if ((process.env.YINGCE_USE_SYSTEM_PROXY || '').trim() === '1') return {}
  const stripped = {}
  for (const key of BACKEND_PROXY_ENV_KEYS) stripped[key] = undefined
  return stripped
}

// ── 宿主更新器 ──────────────────────────────────────────────────────────
// 「系统更新」页由宿主上的 dxos-updater 提供（重新打包并导入 ZIP 只能它做）。
// token 是密钥，不能随安装包分发，所以运行时从包外 ~/.yingce 读取：
// 宿主更新器写入 dxos-updater-token，包内连接器读取后注入给后端进程。
const UPDATER_DIR = path.join(os.homedir(), '.yingce')
const UPDATER_SOCKET = path.join(UPDATER_DIR, 'dxos-updater.sock')
const UPDATER_TOKEN_FILE = path.join(UPDATER_DIR, 'dxos-updater-token')

function updaterEnvironment() {
  // 显式配置优先（排障时可临时指向其它 socket）。
  const configured = (process.env.CANVAS_UPDATER_TOKEN || '').trim()
  if (configured.length >= 32) return {}
  let token = ''
  try { token = fs.readFileSync(UPDATER_TOKEN_FILE, 'utf8').trim() } catch (_) { return {} }
  if (token.length < 32) return {}
  return {
    CANVAS_UPDATER_TOKEN: token,
    CANVAS_UPDATER_SOCKET: (process.env.CANVAS_UPDATER_SOCKET || '').trim() || UPDATER_SOCKET,
  }
}

function startBackend() {
  if (starting) return starting
  starting = (async () => {
    const dataDir = resolveDataDir()
    fs.mkdirSync(dataDir, { recursive: true })
    const adopted = await adoptRunningBackend(dataDir)
    if (adopted) { base = adopted; return base }
    const pluginDir = materializePlugins(dataDir)
    const agentRuntimeDir = materializeAgentRuntime(dataDir)
    const binary = ensureExecutable(BACKEND_BINARY)
    const port = await pickPort()
    const logDir = path.join(dataDir, 'logs')
    fs.mkdirSync(logDir, { recursive: true })
    const logStream = fs.createWriteStream(path.join(logDir, 'backend.log'), { flags: 'a' })
    const env = { ...process.env, ...backendChildEnv(), ...updaterEnvironment(), CANVAS_BACKEND_ADDR: '127.0.0.1:' + port,
      CANVAS_BACKEND_DATA_DIR: dataDir,
      CANVAS_DATABASE_DRIVER: 'sqlite',
      CANVAS_OFFICIAL_PLUGIN_DIR: pluginDir,
      // Agent 运行时（pi）目录；空字符串时后端会报出明确的缺失错误。
      CANVAS_PI_RUNTIME_DIR: agentRuntimeDir,
      CANVAS_AUTO_MIGRATE: 'true',
      CANVAS_LOG_FORMAT: 'text',
      // debug 级别会把成功 GET（含图片请求）也写进日志，缺图时才能看到真实状态码。
      CANVAS_LOG_LEVEL: 'debug',
      GIN_MODE: 'release',
      // 后端的 Agent 运行时通过 exec.Command("node") 启动；把当前 Node 所在目录
      // 放进 PATH，保证 DX OS 内置 Node 也能被找到。
      PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '')
    }
    child = spawn(binary, [], { cwd: MCP_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (chunk) => { logStream.write(chunk); noteBackendOutput(chunk) })
    child.stderr.on('data', (chunk) => { logStream.write(chunk); noteBackendOutput(chunk) })
    child.on('exit', (code, signal) => {
      noteBackendOutput('\n[yingce] 后端进程退出 code=' + code + ' signal=' + signal + '\n')
      child = null
    })
    // spawn 失败（二进制缺失、架构不符、没有执行权限）只发 error 事件，
    // 不处理的话健康检查会一直空转到超时，错误信息也拿不到。
    child.on('error', (e) => {
      noteBackendOutput('\n[yingce] 无法启动后端进程：' + String(e?.message || e) + '\n')
      child = null
    })
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (!child || child.exitCode !== null) throw new Error('影策后端启动失败：' + (backendLogTail.trim() || '进程已退出'))
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/api/health/ready', { signal: AbortSignal.timeout(2000) })
        if (response.ok) { base = 'http://127.0.0.1:' + port; writeState(dataDir, { port, pid: child ? child.pid : 0 }); return base }
      } catch (_) { /* 后端还没起来，继续等 */ }
      await delay(400)
    }
    throw new Error('影策后端启动超时（' + READY_TIMEOUT_MS + 'ms）')
  })()
  starting.catch(() => { starting = null })
  return starting
}

function stopMediaProxy() {
  const server = mediaServer
  mediaServer = null
  mediaOrigin = ''
  if (server) { try { server.close() } catch (_) { /* 忽略 */ } }
}

function stopBackend() {
  const process_ = child
  child = null
  if (!process_ || process_.exitCode !== null) return
  try { process_.kill('SIGTERM') } catch (_) { /* 忽略 */ }
}

// DX OS 被强制退出时连接器可能来不及回收后端，进程会变成孤儿。把上一轮的
// 端口记在数据目录里，下次启动先探活；还活着就直接接管，不再起第二个。
function statePath(dataDir) { return path.join(dataDir, 'backend.json') }

function readState(dataDir) {
  try { return JSON.parse(fs.readFileSync(statePath(dataDir), 'utf8')) } catch (_) { return null }
}

function writeState(dataDir, value) {
  try { fs.writeFileSync(statePath(dataDir), JSON.stringify(value)) } catch (_) { /* 状态文件不是关键路径 */ }
}

async function adoptRunningBackend(dataDir) {
  const recorded = Number((readState(dataDir) || {}).port)
  if (Number.isInteger(recorded) && recorded > 0 && recorded <= 65535) {
    const adopted = await probeHealth(recorded)
    if (adopted) { writeState(dataDir, { port: recorded, pid: 0 }); return adopted }
  }
  // 状态文件可能被清理，或指向已经释放的端口。端口段里还活着的后端必须接管，
  // 否则会对着同一个 SQLite 库再起一个写进程。
  const { base, span } = candidatePorts()
  for (let offset = 0; offset < span; offset += 1) {
    const port = base + offset
    const adopted = await probeHealth(port)
    if (adopted) { writeState(dataDir, { port, pid: 0 }); return adopted }
  }
  return null
}

// ── 本地媒体代理 ─────────────────────────────────────────────────────────
// 只做一件事：把浏览器的原生媒体请求转发给真实后端，并对请求方回显
// Access-Control-Allow-Origin。这样 opaque 源（Origin: null）的 crossOrigin 图片、
// canvas 取像素、视频 Range 请求都能通过，而后端本身不需要改动。
let mediaServer = null
let mediaOrigin = ''
let mediaStarting = null

async function pickMediaPort() {
  // 与后端端口同一套约定：显式设置 YINGCE_MEDIA_PORT 时只用那一个端口（排障与自动化测试），
  // 这种情况下端口被占用要直接报错，不能悄悄换端口——否则页面拿到的地址与测试预期不符。
  const pinned = Number(process.env.YINGCE_MEDIA_PORT)
  if (Number.isInteger(pinned) && pinned > 0) {
    if (await canListen(pinned)) return pinned
    throw new Error('YINGCE_MEDIA_PORT 指定的端口已被占用：' + pinned)
  }
  for (let offset = 0; offset < MEDIA_PORT_SPAN; offset += 1) {
    const port = DEFAULT_MEDIA_PORT + offset
    if (await canListen(port)) return port
  }
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', (e) => reject(new Error('无法分配媒体代理端口：' + String(e?.message || e))))
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address && typeof address === 'object' ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('无法分配媒体代理端口'))))
    })
  })
}

// 只对本机宿主和 opaque 源回显 CORS。代理不带 Cookie 转发，但仍不该让任意网站
// 通过它读到本地接口响应，所以远端来源一律不给 CORS 头。
const MEDIA_CORS_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/
// 直连通道对前端可见的响应头：Agent 事件流要读 retry-after，画布轮询要读 etag。
const EXPOSED_HEADERS = 'content-type, content-length, content-range, accept-ranges, content-disposition, etag, last-modified, cache-control, retry-after'
// 直连写通道按原样透传请求头，只挡掉必须由代理接管的连接级头。
const UPLOAD_HEADER_DENYLIST = new Set(['host', 'cookie', 'origin', 'referer', 'content-length', 'connection', 'accept-encoding', 'transfer-encoding', 'keep-alive', 'upgrade'])
function mediaCorsHeaders(requestOrigin) {
  if (!requestOrigin) return {}
  if (requestOrigin !== 'null' && !MEDIA_CORS_ORIGIN.test(requestOrigin)) return {}
  return {
    'access-control-allow-origin': requestOrigin,
    'access-control-allow-credentials': 'true',
    'access-control-expose-headers': EXPOSED_HEADERS,
    vary: 'Origin'
  }
}

// 媒体/上传/前端报错都记到同一个日志文件，方便离线排查“图不显示”。
function appendMediaLog(line) {
  try {
    const dir = path.join(resolveDataDir(), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'dxos-media.log')
    try { if (fs.statSync(file).size > 4 * 1024 * 1024) fs.truncateSync(file, 0) } catch (_) { /* 文件还不存在 */ }
    fs.appendFileSync(file, new Date().toISOString() + ' ' + String(line).slice(0, 2000) + '\n')
  } catch (_) { /* 日志失败不影响主流程 */ }
}

// ── 灵感画廊缩略图 ───────────────────────────────────────────────────────
// 355 张 webp 缩略图如果按文件展开，会把 APP 包顶过宿主 2048 条上限，所以打包时
// 收进 mcp/inspiration-thumbs.zip（STORED，无压缩），前端把封面地址写成
// /api/dxos-thumbs/<相对路径>，由这里按偏移切片直接返回，不解压、不落盘。
const THUMBS_API_PREFIX = '/api/dxos-thumbs/'
const THUMBS_MIME = { '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml' }
let thumbsIndex = null
function loadThumbsIndex() {
  if (thumbsIndex) return thumbsIndex
  const empty = { buffer: null, files: new Map() }
  try {
    const buffer = fs.readFileSync(INSPIRATION_THUMBS_ZIP)
    const files = new Map()
    let eocd = -1
    const searchFloor = Math.max(0, buffer.length - 65557)
    for (let i = buffer.length - 22; i >= searchFloor; i--) {
      if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
    }
    if (eocd < 0) throw new Error('EOCD not found')
    const count = buffer.readUInt16LE(eocd + 10)
    let pos = buffer.readUInt32LE(eocd + 16)
    for (let index = 0; index < count; index++) {
      if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== 0x02014b50) throw new Error('central directory damaged')
      const method = buffer.readUInt16LE(pos + 10)
      const size = buffer.readUInt32LE(pos + 24)
      const nameLen = buffer.readUInt16LE(pos + 28)
      const extraLen = buffer.readUInt16LE(pos + 30)
      const commentLen = buffer.readUInt16LE(pos + 32)
      const localOffset = buffer.readUInt32LE(pos + 42)
      const name = buffer.toString('utf8', pos + 46, pos + 46 + nameLen)
      if (method === 0 && !name.endsWith('/') && localOffset + 30 <= buffer.length) {
        const localNameLen = buffer.readUInt16LE(localOffset + 26)
        const localExtraLen = buffer.readUInt16LE(localOffset + 28)
        files.set(name, { offset: localOffset + 30 + localNameLen + localExtraLen, size })
      }
      pos += 46 + nameLen + extraLen + commentLen
    }
    thumbsIndex = { buffer, files }
    appendMediaLog('inspiration thumbs indexed: ' + files.size + ' entries, ' + buffer.length + ' bytes')
  } catch (e) {
    appendMediaLog('inspiration thumbs index failed: ' + (e && e.message ? e.message : e))
    thumbsIndex = empty
  }
  return thumbsIndex
}

function serveInspirationThumb(request, response, cors, target) {
  const raw = target.slice(THUMBS_API_PREFIX.length).split('?')[0].split('#')[0]
  let name = raw
  try { name = decodeURIComponent(raw) } catch (_) { /* 保留原样，交给下面的查表 404 */ }
  const notFound = () => {
    response.writeHead(404, { ...cors, 'content-type': 'text/plain; charset=utf-8' })
    response.end('未收录的灵感缩略图：' + name.slice(0, 200))
  }
  if (!name || name.includes('..') || name.charAt(0) === '/') return notFound()
  const { buffer, files } = loadThumbsIndex()
  const entry = buffer && files.get(name)
  if (!entry) return notFound()
  const headers = {
    ...cors,
    'content-type': THUMBS_MIME[path.extname(name).toLowerCase()] || 'application/octet-stream',
    'content-length': String(entry.size),
    'cache-control': 'public, max-age=86400'
  }
  response.writeHead(200, headers)
  if (request.method === 'HEAD') { response.end(); return }
  response.end(buffer.subarray(entry.offset, entry.offset + entry.size))
}

async function serveMedia(request, response) {
  const cors = mediaCorsHeaders(String(request.headers.origin || ''))
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      ...cors,
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers': String(request.headers['access-control-request-headers'] || 'range, content-type, authorization'),
      'access-control-expose-headers': EXPOSED_HEADERS,
      'access-control-max-age': '86400'
    })
    response.end()
    return
  }
  const target = String(request.url || '')
  if ((request.method !== 'GET' && request.method !== 'HEAD') || target.indexOf('/api/') !== 0 || target.includes('..')) {
    response.writeHead(request.method === 'GET' || request.method === 'HEAD' ? 404 : 405, cors)
    response.end()
    return
  }
  // 包内静态缩略图不走后端：命中前缀直接由连接器按 ZIP 偏移返回。
  if (target.indexOf(THUMBS_API_PREFIX) === 0) {
    serveInspirationThumb(request, response, cors, target)
    return
  }
  let origin
  try { origin = await backendBase() } catch (e) {
    response.writeHead(502, { ...cors, 'content-type': 'text/plain; charset=utf-8' })
    response.end(String(e?.message || e))
    return
  }
  // 这条通道同时是前端的直连读通道：/api 读请求都补齐会话 Cookie 并透传必要头，
  // 后端自身的鉴权仍是最终裁决者。
  const forwarded = {}
  for (const name of ['range', 'if-none-match', 'if-modified-since', 'accept', 'content-type', 'authorization', 'x-canvas-scene', 'x-idempotency-key', 'last-event-id']) {
    if (request.headers[name]) forwarded[name] = request.headers[name]
  }
  // 必须显式声明 identity：Node 的 fetch 会自动带上 accept-encoding 并解压响应体，
  // 但响应头里的 content-length 仍是压缩前的长度。后端对超过 1 KB 的画布 JSON 会做
  // gzip，这条长度一旦原样透传给浏览器，JSON 就被截断成半截，画布页于是报“请求失败”。
  // 让上游不压缩，长度才和实际字节一致。
  forwarded['accept-encoding'] = 'identity'
  if (cookie) forwarded.cookie = cookie
  // 前端断开（切换画布、关闭面板）时必须连带掐断上游，否则后端 SSE 会一直挂着。
  const upstreamAbort = new AbortController()
  response.on('close', () => { if (!response.writableFinished) upstreamAbort.abort() })
  const upstream = await fetch(origin + target, { method: request.method, headers: forwarded, redirect: 'manual', signal: upstreamAbort.signal })
  appendMediaLog(request.method + ' ' + target.slice(0, 300) + ' -> ' + upstream.status + (request.headers.origin ? ' origin=' + String(request.headers.origin).slice(0, 40) : ''))
  const headers = { ...cors }
  // 第二道保险：万一上游仍返回压缩内容（自定义代理忽略 identity），解压后的字节数
  // 已经和 content-length 不符，此时绝不能把压缩长度透传出去，交给 Node 自行分块。
  const upstreamEncoding = String(upstream.headers.get('content-encoding') || '').trim().toLowerCase()
  const bodyWasDecoded = upstreamEncoding !== '' && upstreamEncoding !== 'identity'
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control', 'content-disposition', 'retry-after']) {
    if (name === 'content-length' && bodyWasDecoded) continue
    const value = upstream.headers.get(name)
    if (value) headers[name] = value
  }
  response.writeHead(upstream.status, headers)
  if (request.method === 'HEAD' || !upstream.body) { response.end(); return }
  Readable.fromWeb(upstream.body).pipe(response)
}

function readRequestBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    request.on('data', (chunk) => {
      total += chunk.length
      if (total > limit) {
        reject(new Error('上传内容超过 ' + Math.round(limit / 1024 / 1024) + ' MB 限制'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

// 浏览器上传通道：POST /__dxos/upload?token=<会话令牌>&method=POST&path=/api/resources
// 请求体就是原始字节（FormData 或分片），代理补齐 Cookie 后原样转发给后端。
async function handleUpload(request, response) {
  const cors = mediaCorsHeaders(String(request.headers.origin || ''))
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      ...cors,
      'access-control-allow-methods': 'POST, PUT, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers': String(request.headers['access-control-request-headers'] || 'content-type'),
      'access-control-expose-headers': EXPOSED_HEADERS,
      'access-control-max-age': '86400'
    })
    response.end()
    return
  }
  const fail = (status, message) => {
    response.writeHead(status, { ...cors, 'content-type': 'text/plain; charset=utf-8' })
    response.end(message)
  }
  if (request.method !== 'POST') return fail(405, '上传通道只接受 POST')
  const parsed = new URL(String(request.url || ''), 'http://127.0.0.1')
  if (parsed.searchParams.get('token') !== UPLOAD_TOKEN) return fail(403, '上传令牌无效')
  const targetPath = String(parsed.searchParams.get('path') || '')
  const targetMethod = String(parsed.searchParams.get('method') || 'POST').toUpperCase()
  if (!/^\/api\/[A-Za-z0-9_./?=&%-]+$/.test(targetPath) || targetPath.includes('..')) return fail(400, '上传路径不合法')
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(targetMethod)) return fail(400, '上传方法不合法')
  let body
  try { body = await readRequestBody(request, MAX_UPLOAD_BYTES) } catch (e) { return fail(413, String(e?.message || e)) }
  let origin
  try { origin = await backendBase() } catch (e) { return fail(502, String(e?.message || e)) }
  // 自定义渠道要走 X-Canvas-Upstream-* 与 Authorization，所以这里按原样透传请求头，
  // 只挡掉必须由代理接管的连接级头。
  const headers = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (UPLOAD_HEADER_DENYLIST.has(name.toLowerCase())) continue
    headers[name.toLowerCase()] = String(value)
  }
  if (cookie) headers.cookie = cookie
  const init = { method: targetMethod, headers, redirect: 'manual' }
  if (body.length) init.body = body
  const upstream = await fetch(origin + targetPath, init)
  const setCookie = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : []
  if (setCookie.length) { cookie = setCookie.map((item) => item.split(';', 1)[0]).join('; '); persistCookie(cookie) }
  appendMediaLog(targetMethod + ' ' + targetPath.slice(0, 200) + ' (' + body.length + 'B) -> ' + upstream.status)
  const outHeaders = { ...cors }
  for (const name of ['content-type', 'retry-after', 'etag', 'last-modified', 'content-disposition']) {
    const value = upstream.headers.get(name)
    if (value) outHeaders[name] = value
  }
  const bytes = Buffer.from(await upstream.arrayBuffer())
  response.writeHead(upstream.status, outHeaders)
  response.end(bytes)
}

// 媒体代理必须先于后端就绪：前端一进页面就要改写图片地址，不能等后端冷启动。
function startMediaProxy() {
  if (mediaOrigin) return Promise.resolve(mediaOrigin)
  if (mediaStarting) return mediaStarting
  mediaStarting = (async () => {
    const port = await pickMediaPort()
    const server = http.createServer((request, response) => {
      const handled = String(request.url || '').indexOf('/__dxos/upload') === 0
        ? handleUpload(request, response)
        : serveMedia(request, response)
      handled.catch((e) => {
        try { response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }) } catch (_) { /* 已发头 */ }
        try { response.end(String(e?.message || e)) } catch (_) { /* 已关闭 */ }
      })
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
    mediaServer = server
    mediaOrigin = 'http://127.0.0.1:' + port
    return mediaOrigin
  })()
  mediaStarting.catch(() => { mediaStarting = null })
  return mediaStarting
}

function backendBase() {
  if (base) return Promise.resolve(base)
  if (!fs.existsSync(BACKEND_BINARY)) {
    return Promise.reject(new Error('包内没有影策后端二进制，请改用 YINGCE_BACKEND_URL 连接外部后端'))
  }
  return startBackend()
}

async function request(args) {
  const method = String(args?.method || 'GET').toUpperCase()
  const requestPath = String(args?.path || '')
  if (!/^\/api\/[A-Za-z0-9_./?=&%-]+$/.test(requestPath) || requestPath.includes('..')) throw new Error('仅允许访问影策 /api 相对路径')
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) throw new Error('不支持的 HTTP 方法')
  // <img>/<video> 由浏览器原生加载，不走 fetch 桥，前端必须先知道后端真实地址。
  // 后端可能被接管在固定端口段之外，所以由连接器给出权威地址而不是让前端猜。
  if (requestPath === '/api/__dxos/backend-origin' && method === 'GET') {
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ origin: await startMediaProxy(), uploadToken: UPLOAD_TOKEN }), encoding: 'utf8' }
  }
  // 前端把加载失败的媒体地址回报到这里，离线也能看到真实失败的 URL。
  if (requestPath === '/api/__dxos/diag' && method === 'POST') {
    appendMediaLog('diag ' + String(args?.body || ''))
    return { status: 204, headers: { 'content-type': 'application/json' }, body: '', encoding: 'utf8' }
  }
  const target = await backendBase()
  const headers = { ...(args?.headers && typeof args.headers === 'object' ? args.headers : {}) }
  delete headers.cookie; delete headers.authorization; delete headers.host
  if (cookie) headers.cookie = cookie
  const init = { method, headers, redirect: 'manual' }
  if (!['GET', 'DELETE'].includes(method) && args?.body != null) init.body = String(args.body)
  const response = await fetch(target + requestPath, init)
  const setCookie = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : [])
  if (setCookie.length) { cookie = setCookie.map((item) => item.split(';', 1)[0]).join('; '); persistCookie(cookie) }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > MAX_RESPONSE_BYTES) throw new Error('响应超过 MCP 代理 8 MB 限制，请使用影策项目文件接口')
  const type = response.headers.get('content-type') || 'application/octet-stream'
  const body = type.includes('application/json') ? bytes.toString('utf8') : bytes.toString('base64')
  return { status: response.status, headers: { 'content-type': type }, body, encoding: type.includes('application/json') ? 'utf8' : 'base64' }
}

async function handle(message) {
  const id = message.id
  if (message.method === 'initialize') return result(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'yingce-local', version: '1.0.0' } })
  if (message.method === 'notifications/initialized') return
  if (message.method === 'tools/list') return result(id, { tools: [{ name: 'request', description: 'Call the local Yingce /api JSON backend using a host-side cookie jar.', inputSchema: { type: 'object', properties: { method: { type: 'string' }, path: { type: 'string' }, headers: { type: 'object' }, body: {} }, required: ['path'] } }] })
  if (message.method !== 'tools/call') return error(id, -32601, 'Unsupported MCP method')
  if (String(message.params?.name || '') !== 'request') return error(id, -32602, 'Unknown tool')
  try { return result(id, content(JSON.stringify(await request(message.params?.arguments || {})))) }
  catch (e) { return result(id, content(String(e?.message || e), true)) }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => { if (!line.trim()) return; try { handle(JSON.parse(line)).catch((e) => error(null, -32603, String(e?.message || e))) } catch (e) { error(null, -32700, String(e?.message || e)) } })
// DX OS 关闭连接器时 stdin 会结束，此时必须把托管的后端一起收掉，避免残留进程占端口。
function shutdown() { stopMediaProxy(); stopBackend(); process.exit(0) }
rl.on('close', shutdown)
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, shutdown)
process.on('exit', () => { stopMediaProxy(); stopBackend() })

if (!base) {
  // 后台预热：不阻塞 MCP 握手（DX OS 的连接超时是 60s），失败信息留给首个请求返回。
  backendBase().catch((e) => noteBackendOutput('\n[yingce] 后端预启动失败：' + String(e?.message || e) + '\n'))
}
// 媒体代理同样在连接器启动时就拉起。它原先只在前端探测后端地址时才启动，于是连接器
// 一旦被 DX OS 回收重启，已经打开的应用页面还指着旧地址，图片/视频会一直加载失败。
startMediaProxy().catch((e) => appendMediaLog('media proxy start failed: ' + String(e?.message || e)))
