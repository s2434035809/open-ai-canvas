#!/usr/bin/env node
/**
 * 直连通道验收脚本（不需要 DX OS）。
 *
 * 复现用户遇到的 `MCP error -32001: Request timed out` 场景：DX OS 对每次 MCP 工具
 * 调用有 60s 硬超时，而 Agent 事件流 / 图片生成这类请求本身就会跑几十秒到几分钟。
 * 本脚本起一个真实连接器 + 桩后端，验证：
 *   1. GET /api/agent/runs/<id>/events 的 SSE 能持续超过 60s 并正常收完；
 *   2. POST /api/ai/custom 这类同步长生成请求超过 60s 也能拿到响应；
 *   3. 上传通道把自定义渠道头（Authorization / X-Canvas-Upstream-*）原样带给后端。
 *
 * 用法：node dxos-app/direct-channel-smoke.cjs [--seconds 75]
 */
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { spawn } = require('node:child_process')

const args = process.argv.slice(2)
const secondsIndex = args.indexOf('--seconds')
const STREAM_SECONDS = secondsIndex >= 0 ? Number(args[secondsIndex + 1]) : 75
const SMOKE_LONG_MS = Math.max(5000, Math.round(STREAM_SECONDS * 1000))
// 只有跑满一分钟以上，才是在验证「跨过 MCP 60s 硬超时」；短跑只做通道连通性回归。
const CROSSES_MCP_TIMEOUT = SMOKE_LONG_MS > 65000

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server.address().port))
  })
}

function startStubBackend() {
  const seen = { headers: [], long: 0 }
  const server = http.createServer((req, res) => {
    seen.headers.push({ url: req.url, method: req.method, authorization: req.headers.authorization, upstream: req.headers['x-canvas-upstream-url'] })
    if (req.url.startsWith('/api/health/ready')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"status":"ok"}')
      return
    }
    if (req.url.startsWith('/api/agent/runs/')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const startedAt = Date.now()
      let seq = 0
      const timer = setInterval(() => {
        seq += 1
        res.write(`event: agent_event\ndata: {"runId":"long","seq":${seq},"type":"heartbeat","elapsedMs":${Date.now() - startedAt}}\n\n`)
        if (Date.now() - startedAt >= SMOKE_LONG_MS) {
          clearInterval(timer)
          res.write(`event: agent_event\ndata: {"runId":"long","seq":${seq + 1},"type":"run_finished"}\n\n`)
          res.end()
        }
      }, 5000)
      req.on('close', () => clearInterval(timer))
      return
    }
    if (req.url.startsWith('/api/ai/custom')) {
      seen.long += 1
      // 模拟一次真实的同步长生成：超过 60s 才回包。
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 0, data: { url: 'https://example.invalid/generated.png' } }))
      }, SMOKE_LONG_MS)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"code":404}')
  })
  return { server, seen }
}

function startConnector(backendOrigin, dataDir) {
  const child = spawn(process.execPath, [path.join(__dirname, 'mcp', 'server.js')], {
    env: { ...process.env, YINGCE_BACKEND_MODE: 'external', YINGCE_BACKEND_URL: backendOrigin, YINGCE_DATA_DIR: dataDir },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const pending = new Map()
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch (_) { continue }
      const item = pending.get(message.id)
      if (item) { pending.delete(message.id); item(message) }
    }
  })
  let seq = 0
  function call(method, params) {
    const id = ++seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接器没有响应：' + method)), 30000)
      pending.set(id, (message) => { clearTimeout(timer); resolve(message) })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  return { child, call }
}

async function main() {
  const { server, seen } = startStubBackend()
  const backendPort = await listen(server)
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yingce-smoke-'))
  const connector = startConnector('http://127.0.0.1:' + backendPort, dataDir)
  const results = []
  const cleanup = () => { try { connector.child.kill('SIGKILL') } catch (_) {} server.close(); try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch (_) {} }
  try {
    await connector.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } })
    const originReply = await connector.call('tools/call', { name: 'request', arguments: { method: 'GET', path: '/api/__dxos/backend-origin' } })
    const payload = JSON.parse(originReply.result.content[0].text)
    const { origin, uploadToken } = JSON.parse(payload.body)
    console.log('直连代理：' + origin)

    // 0) CORS 预检：沙箱 iframe 是 opaque 源（Origin: null），带自定义头的
    //    fetch 会先发 OPTIONS。预检不过，直连通道在真实宿主里根本用不起来。
    const ssePreflight = await fetch(origin + '/api/agent/runs/long/events', {
      method: 'OPTIONS',
      headers: { origin: 'null', 'access-control-request-method': 'GET', 'access-control-request-headers': 'accept,last-event-id' }
    })
    if (ssePreflight.status !== 204 || ssePreflight.headers.get('access-control-allow-origin') !== 'null') throw new Error('读通道预检失败：' + ssePreflight.status + ' / ' + ssePreflight.headers.get('access-control-allow-origin'))
    if (!String(ssePreflight.headers.get('access-control-allow-headers') || '').includes('last-event-id')) throw new Error('读通道预检没有放行 Last-Event-ID')
    const uploadPreflight = await fetch(`${origin}/__dxos/upload?token=${encodeURIComponent(uploadToken)}&method=POST&path=${encodeURIComponent('/api/ai/custom')}`, {
      method: 'OPTIONS',
      headers: { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,authorization,x-canvas-upstream-url' }
    })
    if (uploadPreflight.status !== 204 || uploadPreflight.headers.get('access-control-allow-origin') !== 'null') throw new Error('写通道预检失败：' + uploadPreflight.status)
    if (!String(uploadPreflight.headers.get('access-control-allow-methods') || '').includes('POST')) throw new Error('写通道预检没有放行 POST')
    results.push('opaque 源（Origin: null）的读写通道 CORS 预检均通过')

    // 1) SSE 长连接：必须活过 60s，并且分片是边到边读，不是攒完一次性给。
    const startedAt = Date.now()
    const response = await fetch(origin + '/api/agent/runs/long/events', { headers: { origin: 'null', accept: 'text/event-stream' } })
    if (!response.ok) throw new Error('SSE 直连失败：HTTP ' + response.status)
    if (!String(response.headers.get('content-type') || '').includes('text/event-stream')) throw new Error('直连没有转发 content-type：' + response.headers.get('content-type'))
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const arrival = []
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      const piece = decoder.decode(value, { stream: true })
      text += piece
      arrival.push({ atMs: Date.now() - startedAt, bytes: piece.length })
    }
    const lastAt = arrival.length ? arrival[arrival.length - 1].atMs : 0
    if (CROSSES_MCP_TIMEOUT && lastAt < 60000) throw new Error(`SSE 只活了 ${lastAt}ms，没有跨过 MCP 的 60s 超时线`)
    if (!text.includes('run_finished')) throw new Error('SSE 没有收到收尾事件')
    // 增量送达：第一个分片必须远早于最后一个，否则说明中间被整体缓冲。
    if (arrival.length < 2 || arrival[0].atMs > lastAt - 1000) throw new Error('SSE 被整体缓冲后一次性返回，分片=' + JSON.stringify(arrival))
    results.push(`SSE 直连存活 ${Math.round(lastAt / 1000)}s，分 ${arrival.length} 片增量送达（首个分片 ${arrival[0].atMs}ms）`)

    // 2) 同步长生成：超过 60s 的 POST 也必须能拿到响应。
    const postStartedAt = Date.now()
    const post = await fetch(`${origin}/__dxos/upload?token=${encodeURIComponent(uploadToken)}&method=POST&path=${encodeURIComponent('/api/ai/custom')}`, {
      method: 'POST',
      headers: { origin: 'null', 'content-type': 'application/json', authorization: 'Bearer smoke-token', 'x-canvas-upstream-url': 'https://up.example/v1/images/generations' },
      body: JSON.stringify({ prompt: 'smoke' })
    })
    const postMs = Date.now() - postStartedAt
    const body = await post.json()
    if (post.status !== 200 || body.code !== 0) throw new Error('长 POST 失败：HTTP ' + post.status)
    if (CROSSES_MCP_TIMEOUT && postMs < 60000) throw new Error('长 POST 提前返回，桩后端没有真的跑满 60s')
    results.push(`长 POST /api/ai/custom 在 ${Math.round(postMs / 1000)}s 后正常返回 200`)

    // 3) 自定义渠道头必须原样到达后端。
    const forwarded = seen.headers.find((item) => item.url.startsWith('/api/ai/custom'))
    if (!forwarded || forwarded.authorization !== 'Bearer smoke-token') throw new Error('Authorization 没有透传到后端')
    if (forwarded.upstream !== 'https://up.example/v1/images/generations') throw new Error('X-Canvas-Upstream-URL 没有透传到后端')
    results.push('自定义渠道头 Authorization / X-Canvas-Upstream-URL 原样透传')

    console.log('PASS')
    for (const line of results) console.log('  - ' + line)
    cleanup()
    process.exit(0)
  } catch (error) {
    console.error('FAIL: ' + (error && error.message || error))
    cleanup()
    process.exit(1)
  }
}

main()
