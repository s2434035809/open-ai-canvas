const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const MCP_SOURCE = path.join(__dirname, 'mcp');

// 每个用例都在临时目录里跑一份 mcp/ 的副本，避免污染仓库、也避免真实后端进程。
function makeRuntime({ backend } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yingce-mcp-'));
  const mcp = path.join(root, 'mcp');
  fs.cpSync(MCP_SOURCE, mcp, { recursive: true });
  fs.mkdirSync(path.join(mcp, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(mcp, 'plugins', 'demo-plugin.zip'), 'PK\u0003\u0004demo-plugin');
  if (backend) {
    // 故意写成 0644：DX OS 解压时不保留可执行位，连接器必须自己补 chmod。
    fs.writeFileSync(path.join(mcp, 'yingce-backend.exe'), backend, { mode: 0o644 });
  }
  return { root, mcp, dataDir: path.join(root, 'data') };
}

// 等待端口开始监听：连接器起来但还没收到任何请求时也要能通过。
function waitForPort(port, timeoutMs) {
  const net = require('node:net');
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error('端口 ' + port + ' 在 ' + timeoutMs + 'ms 内没有开始监听'));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

function startServer(runtime, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(runtime.mcp, 'server.js')], {
    // 默认给一个远离生产端口段的固定端口，避免用例误接管真实运行中的后端。
    env: { ...process.env, YINGCE_DATA_DIR: runtime.dataDir, YINGCE_BACKEND_TIMEOUT_MS: '3000', YINGCE_BACKEND_PORT: '39987', ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const resolve = pending.get(message.id);
      if (resolve) { pending.delete(message.id); resolve(message); }
    }
  });
  let sequence = 0;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.delete(id)) reject(new Error('等待 ' + method + ' 响应超时')); }, 10000).unref();
  });
  return {
    request,
    stop() { try { child.stdin.end(); } catch {} try { child.kill('SIGKILL'); } catch {} },
  };
}

test('MCP 握手不等待后端启动', async (t) => {
  const runtime = makeRuntime({ backend: '#!/bin/sh\nsleep 30\n' });
  const server = startServer(runtime, { YINGCE_BACKEND_TIMEOUT_MS: '20000', YINGCE_BACKEND_PORT: '39990' });
  t.after(() => server.stop());
  const started = Date.now();
  const response = await server.request('initialize', { protocolVersion: '2024-11-05' });
  assert.equal(response.result.serverInfo.name, 'yingce-local');
  // DX OS 的连接超时是 60s；后端冷启动可能要几秒，握手必须先返回。
  assert.ok(Date.now() - started < 5000, 'initialize 不应等待后端就绪');
});

test('tools/list 暴露受限的 request 工具', async (t) => {
  const runtime = makeRuntime();
  const server = startServer(runtime);
  t.after(() => server.stop());
  const response = await server.request('tools/list', {});
  const tool = response.result.tools.find((item) => item.name === 'request');
  assert.ok(tool, '必须暴露 request 工具');
  assert.deepEqual(tool.inputSchema.required, ['path']);
});

test('缺少包内后端二进制时给出可执行的外部后端提示', async (t) => {
  const runtime = makeRuntime();
  const server = startServer(runtime);
  t.after(() => server.stop());
  const response = await server.request('tools/call', { name: 'request', arguments: { path: '/api/health' } });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /YINGCE_BACKEND_URL|后端二进制/);
});

test('后端二进制丢失可执行位时由连接器补回并尝试启动', async (t) => {
  const runtime = makeRuntime({ backend: '#!/bin/sh\necho "fake backend refused" >&2\nexit 3\n' });
  const server = startServer(runtime, { YINGCE_BACKEND_PORT: '39991' });
  t.after(() => server.stop());
  const response = await server.request('tools/call', { name: 'request', arguments: { path: '/api/health' } });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /影策后端启动失败/);
  // 0644 的假二进制能被 spawn，说明 chmod 生效了。
  assert.ok((fs.statSync(path.join(runtime.mcp, 'yingce-backend.exe')).mode & 0o111) !== 0, '可执行位应被补回');
});

test('后端子进程默认不继承系统代理，需要时可用 YINGCE_USE_SYSTEM_PROXY 打开', async (t) => {
  const proxyEnv = { HTTP_PROXY: 'http://127.0.0.1:7897', HTTPS_PROXY: 'http://127.0.0.1:7897', ALL_PROXY: 'socks5://127.0.0.1:7897' };
  const script = 'echo "proxy=[$HTTP_PROXY][$HTTPS_PROXY][$ALL_PROXY]" >&2\nexit 3\n';

  const direct = makeRuntime({ backend: '#!/bin/sh\n' + script });
  const directServer = startServer(direct, { YINGCE_BACKEND_PORT: '39996', ...proxyEnv });
  t.after(() => directServer.stop());
  await directServer.request('tools/call', { name: 'request', arguments: { path: '/api/health' } });
  assert.match(fs.readFileSync(path.join(direct.dataDir, 'logs', 'backend.log'), 'utf8'), /proxy=\[\]\[\]\[\]/);

  const viaProxy = makeRuntime({ backend: '#!/bin/sh\n' + script });
  const proxyServer = startServer(viaProxy, { YINGCE_BACKEND_PORT: '39997', YINGCE_USE_SYSTEM_PROXY: '1', ...proxyEnv });
  t.after(() => proxyServer.stop());
  await proxyServer.request('tools/call', { name: 'request', arguments: { path: '/api/health' } });
  assert.match(fs.readFileSync(path.join(viaProxy.dataDir, 'logs', 'backend.log'), 'utf8'), /proxy=\[http:\/\/127\.0\.0\.1:7897\]/);
});

test('包内 .zip 插件在启动前物化成 .yingce-plugin', async (t) => {
  const runtime = makeRuntime({ backend: '#!/bin/sh\nexit 3\n' });
  const server = startServer(runtime, { YINGCE_BACKEND_PORT: '39992' });
  t.after(() => server.stop());
  await server.request('tools/call', { name: 'request', arguments: { path: '/api/health' } });
  const materialized = path.join(runtime.dataDir, 'official-plugin-packages', 'demo-plugin.yingce-plugin');
  assert.ok(fs.existsSync(materialized), '插件必须还原成 .yingce-plugin 供后端读取');
  assert.match(fs.readFileSync(materialized, 'utf8'), /demo-plugin/);
});

test('Agent 运行时 zip 在启动前解压到数据目录并注入 CANVAS_PI_RUNTIME_DIR', async (t) => {
  const runtime = makeRuntime({ backend: '#!/bin/sh\necho "runtime=$CANVAS_PI_RUNTIME_DIR" >&2\nexit 3\n' });
  // 用系统 zip 打一个最小运行时包，模拟 build.py 产出的 mcp/agent-runtime.zip。
  fs.mkdirSync(path.join(runtime.mcp, 'pi-src'), { recursive: true });
  fs.writeFileSync(path.join(runtime.mcp, 'pi-src', 'agent-runtime.mjs'), 'export {}\n');
  execFileSync('zip', ['-q', '-j', path.join(runtime.mcp, 'agent-runtime.zip'), path.join(runtime.mcp, 'pi-src', 'agent-runtime.mjs')]);
  const server = startServer(runtime, { YINGCE_BACKEND_PORT: '39993' });
  t.after(() => server.stop());
  const response = await server.request('tools/call', { name: 'request', arguments: { path: '/api/health' } });
  assert.equal(response.result.isError, true);
  const expected = path.join(runtime.dataDir, 'agent-runtime', 'pi');
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(response.result.content[0].text, new RegExp('runtime=' + escaped));
  assert.ok(fs.existsSync(path.join(expected, 'agent-runtime.mjs')), '运行时必须解压到数据目录');
  assert.ok(fs.existsSync(path.join(runtime.dataDir, 'agent-runtime', '.runtime-stamp')), '解压后必须写入 zip 指纹，升级时据此重解压');
});

test('显式 CANVAS_PI_RUNTIME_DIR 时直接沿用，不再解压 zip', async (t) => {
  const runtime = makeRuntime({ backend: '#!/bin/sh\necho "runtime=$CANVAS_PI_RUNTIME_DIR" >&2\nexit 3\n' });
  const external = path.join(runtime.root, 'external-runtime');
  fs.mkdirSync(external, { recursive: true });
  fs.writeFileSync(path.join(external, 'agent-runtime.mjs'), 'export {}\n');
  const server = startServer(runtime, { YINGCE_BACKEND_PORT: '39994', CANVAS_PI_RUNTIME_DIR: external });
  t.after(() => server.stop());
  const response = await server.request('tools/call', { name: 'request', arguments: { path: '/api/health' } });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, new RegExp('runtime=' + external.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(!fs.existsSync(path.join(runtime.dataDir, 'agent-runtime')), '外部运行时不应在数据目录里重复解压');
});

test('拒绝非 /api 路径与目录穿越', async (t) => {
  const runtime = makeRuntime();
  const server = startServer(runtime);
  t.after(() => server.stop());
  for (const bad of ['/etc/passwd', '/api/../secret', '/api/x/../../y']) {
    const response = await server.request('tools/call', { name: 'request', arguments: { path: bad } });
    assert.equal(response.result.isError, true, bad + ' 必须被拒绝');
  }
});

test('YINGCE_BACKEND_URL 存在时不拉起包内后端', async (t) => {
  const runtime = makeRuntime({ backend: '#!/bin/sh\nexit 3\n' });
  const server = startServer(runtime, { YINGCE_BACKEND_URL: 'http://127.0.0.1:1' });
  t.after(() => server.stop());
  const response = await server.request('tools/call', { name: 'request', arguments: { path: '/api/health' } });
  assert.equal(response.result.isError, true);
  // 走的是外部地址而不是本地二进制，因此不应该出现「启动失败」这类托管错误。
  assert.doesNotMatch(response.result.content[0].text, /影策后端启动失败|后端二进制/);
});

test('bundled 模式忽略升级时残留的 YINGCE_BACKEND_URL', async (t) => {
  // DX OS 升级 APP 会保留上一版 env 里用户没改过的键，历史 external 地址会跟着进来。
  // 显式 YINGCE_BACKEND_MODE=bundled 必须压过这个残留值，否则包内后端永远不会被拉起。
  const runtime = makeRuntime({ backend: '#!/bin/sh\nexit 3\n' });
  const server = startServer(runtime, { YINGCE_BACKEND_MODE: 'bundled', YINGCE_BACKEND_URL: 'http://127.0.0.1:3003', YINGCE_BACKEND_PORT: '39994' });
  t.after(() => server.stop());
  const response = await server.request('tools/call', { name: 'request', arguments: { path: '/api/health' } });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /影策后端启动失败/);
  assert.ok((fs.statSync(path.join(runtime.mcp, 'yingce-backend.exe')).mode & 0o111) !== 0, '包内二进制应被尝试启动');
});

test('YINGCE_BACKEND_MODE=external 时直连给定地址', async (t) => {
  const runtime = makeRuntime({ backend: '#!/bin/sh\nexit 3\n' });
  const server = startServer(runtime, { YINGCE_BACKEND_MODE: 'external', YINGCE_BACKEND_URL: 'http://127.0.0.1:1' });
  t.after(() => server.stop());
  const response = await server.request('tools/call', { name: 'request', arguments: { path: '/api/health' } });
  assert.equal(response.result.isError, true);
  assert.doesNotMatch(response.result.content[0].text, /影策后端启动失败|后端二进制/);
});

test('上一轮遗留的 backend.json 指向已释放端口时正常重新拉起', async (t) => {
  const runtime = makeRuntime({ backend: '#!/bin/sh\nexit 3\n' });
  fs.mkdirSync(runtime.dataDir, { recursive: true });
  fs.writeFileSync(path.join(runtime.dataDir, 'backend.json'), JSON.stringify({ port: 39998, pid: 999999 }));
  const server = startServer(runtime, { YINGCE_BACKEND_PORT: '39993' });
  t.after(() => server.stop());
  const response = await server.request('tools/call', { name: 'request', arguments: { path: '/api/health' } });
  assert.equal(response.result.isError, true);
  // 探活失败后必须回落到正常启动流程，而不是把残留记录当成可用后端。
  assert.match(response.result.content[0].text, /影策后端启动失败/);
});

test('连接器启动就拉起媒体代理，不等前端探测', async (t) => {
  const runtime = makeRuntime({ backend: '#!/bin/sh\nsleep 30\n' });
  const mediaPort = 39996;
  const server = startServer(runtime, { YINGCE_BACKEND_PORT: '39992', YINGCE_MEDIA_PORT: String(mediaPort), YINGCE_BACKEND_TIMEOUT_MS: '20000' });
  t.after(() => server.stop());
  // 不发任何 MCP 请求：连接器被 DX OS 重启后，已经打开的页面不会重新探测地址，
  // 代理必须自己先起来，端口在听就是页面恢复显示的前提。
  await waitForPort(mediaPort, 8000);
  const response = await fetch('http://127.0.0.1:' + mediaPort + '/api/dxos-thumbs/none/demo.webp');
  assert.equal(response.status, 404, '端口上必须是媒体代理而不是其他进程');
});

test('媒体代理对 opaque 源回显 CORS 头并转发给后端', async (t) => {
  // 沙箱 iframe 的 Origin 是 "null"，后端会直接 403；crossOrigin 图片、canvas 取像素
  // 都必须经由包内媒体代理，所以这里验证代理的 CORS 行为与转发结果。
  const runtime = makeRuntime({ backend: '#!/bin/sh\nexit 3\n' });
  const http = require('node:http');
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data: { path: req.url, origin: req.headers.origin || '' } }));
  });
  await new Promise((resolve) => upstream.listen(39995, '127.0.0.1', resolve));
  t.after(() => upstream.close());
  const server = startServer(runtime, { YINGCE_BACKEND_PORT: '39995' });
  t.after(() => server.stop());

  const address = await server.request('tools/call', { name: 'request', arguments: { path: '/api/__dxos/backend-origin' } });
  const { body } = JSON.parse(address.result.content[0].text);
  const mediaOrigin = JSON.parse(body).origin;
  assert.match(mediaOrigin, /^http:\/\/127\.0\.0\.1:\d+$/, '必须给出媒体代理地址');

  const opaque = await fetch(mediaOrigin + '/api/health/ready', { headers: { origin: 'null' } });
  assert.equal(opaque.status, 200);
  assert.equal(opaque.headers.get('access-control-allow-origin'), 'null');
  const payload = await opaque.json();
  assert.equal(payload.data.path, '/api/health/ready');

  // 普通 <img> 不带 Origin，就不需要也不应该伪造 CORS 头。
  const plain = await fetch(mediaOrigin + '/api/health/ready');
  assert.equal(plain.headers.get('access-control-allow-origin'), null);

  // 远端网站不能借这个代理读到本地接口响应。
  const remote = await fetch(mediaOrigin + '/api/health/ready', { headers: { origin: 'https://evil.example' } });
  assert.equal(remote.headers.get('access-control-allow-origin'), null);

  // DX OS 宿主自己的来源仍然放行，便于宿主页面直接取图。
  const host = await fetch(mediaOrigin + '/api/health/ready', { headers: { origin: 'http://127.0.0.1:5275' } });
  assert.equal(host.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5275');
});

test('媒体代理只转发 /api 路径并支持 Range 与预检', async (t) => {
  const runtime = makeRuntime({ backend: '#!/bin/sh\nexit 3\n' });
  const http = require('node:http');
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ url: req.url, range: req.headers.range || '' });
    if (req.headers.range) {
      res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': 'bytes 0-3/10', 'accept-ranges': 'bytes' });
      res.end('ABCD');
      return;
    }
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end('PNG');
  });
  await new Promise((resolve) => upstream.listen(39994, '127.0.0.1', resolve));
  t.after(() => upstream.close());
  const server = startServer(runtime, { YINGCE_BACKEND_PORT: '39994' });
  t.after(() => server.stop());

  const address = await server.request('tools/call', { name: 'request', arguments: { path: '/api/__dxos/backend-origin' } });
  const mediaOrigin = JSON.parse(JSON.parse(address.result.content[0].text).body).origin;

  const ranged = await fetch(mediaOrigin + '/api/public/resources/x/file', { headers: { range: 'bytes=0-3' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), 'bytes 0-3/10');
  assert.equal(await ranged.text(), 'ABCD');

  const preflight = await fetch(mediaOrigin + '/api/public/resources/x/file', { method: 'OPTIONS', headers: { origin: 'null' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'null');

  const rejected = await fetch(mediaOrigin + '/etc/passwd');
  assert.equal(rejected.status, 404);
  assert.ok(seen.every((entry) => entry.url.startsWith('/api/')), '代理不得转发非 /api 路径');
});

test('端口段里已有健康后端时直接接管，不再拉起第二个进程', async (t) => {
  const runtime = makeRuntime({ backend: '#!/bin/sh\nexit 3\n' });
  const http = require('node:http');
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data: { path: req.url } }));
  });
  await new Promise((resolve) => upstream.listen(39996, '127.0.0.1', resolve));
  t.after(() => upstream.close());
  const server = startServer(runtime, { YINGCE_BACKEND_PORT: '39996' });
  t.after(() => server.stop());
  const response = await server.request('tools/call', { name: 'request', arguments: { path: '/api/health/ready' } });
  assert.equal(response.result.isError, undefined, '应代理到已运行的后端而不是报错');
  const payload = JSON.parse(JSON.parse(response.result.content[0].text).body);
  assert.equal(payload.data.path, '/api/health/ready');
  // 接管而不是启动：假二进制会立刻退出，如果被拉起就会报「影策后端启动失败」。
  assert.doesNotMatch(response.result.content[0].text, /影策后端启动失败/);
});

// 上传通道：浏览器在 opaque 沙箱里没有会话 Cookie，FormData / 分片 PUT 必须由
// 连接器补 Cookie 后原样转发，否则前端只会看到「未收到服务器确认」。
async function uploadHarness(t, port, respond) {
  const runtime = makeRuntime({ backend: '#!/bin/sh\nexit 3\n' });
  const http = require('node:http');
  const seen = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        cookie: req.headers.cookie || '',
        contentType: req.headers['content-type'] || '',
        body: Buffer.concat(chunks).toString('utf8')
      });
      respond(req, res, seen.at(-1));
    });
  });
  await new Promise((resolve) => upstream.listen(port, '127.0.0.1', resolve));
  t.after(() => upstream.close());
  const server = startServer(runtime, { YINGCE_BACKEND_PORT: String(port) });
  t.after(() => server.stop());
  const address = await server.request('tools/call', { name: 'request', arguments: { path: '/api/__dxos/backend-origin' } });
  const payload = JSON.parse(JSON.parse(address.result.content[0].text).body);
  return { server, seen, mediaOrigin: payload.origin, uploadToken: payload.uploadToken };
}

test('上传通道把 FormData 原始字节透传给后端并补上会话 Cookie', async (t) => {
  const { server, seen, mediaOrigin, uploadToken } = await uploadHarness(t, 39998, (req, res, entry) => {
    if (entry.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['sid=abc123; Path=/; HttpOnly'] });
      res.end('{"code":0}');
      return;
    }
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data: { id: 'resource-1' } }));
  });

  // 先走一次普通桥请求，让连接器拿到后端下发的会话 Cookie。
  await server.request('tools/call', { name: 'request', arguments: { path: '/api/health' } });

  const form = new FormData();
  form.append('kind', 'image');
  form.append('file', new Blob([Buffer.from('PNGDATA')], { type: 'image/png' }), 'probe.png');
  const response = await fetch(mediaOrigin + '/__dxos/upload?token=' + uploadToken + '&method=POST&path=' + encodeURIComponent('/api/resources'), {
    method: 'POST',
    body: form
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { code: 0, data: { id: 'resource-1' } });

  const upload = seen.at(-1);
  assert.equal(upload.method, 'POST');
  assert.equal(upload.url, '/api/resources');
  assert.equal(upload.cookie, 'sid=abc123');
  assert.match(upload.contentType, /^multipart\/form-data; boundary=/);
  assert.match(upload.body, /PNGDATA/);
  assert.match(upload.body, /filename="probe\.png"/);
});

test('上传通道透传分片 PUT 的原始 Content-Type', async (t) => {
  const { seen, mediaOrigin, uploadToken } = await uploadHarness(t, 39999, (req, res) => {
    res.writeHead(204);
    res.end();
  });
  const chunk = Buffer.alloc(8, 7);
  const response = await fetch(mediaOrigin + '/__dxos/upload?token=' + uploadToken + '&method=PUT&path=' + encodeURIComponent('/api/resources/uploads/u1/chunks/2'), {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: chunk
  });
  assert.equal(response.status, 204);
  const upload = seen.at(-1);
  assert.equal(upload.method, 'PUT');
  assert.equal(upload.url, '/api/resources/uploads/u1/chunks/2');
  assert.equal(upload.contentType, 'application/octet-stream');
  assert.equal(Buffer.byteLength(upload.body, 'binary'), 8);
});

test('上传通道拒绝错误令牌、非 /api 路径和非法方法', async (t) => {
  const { mediaOrigin, uploadToken } = await uploadHarness(t, 39997, (req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  const url = (query) => mediaOrigin + '/__dxos/upload?' + query;

  const badToken = await fetch(url('token=wrong&method=POST&path=' + encodeURIComponent('/api/resources')), { method: 'POST', body: 'x' });
  assert.equal(badToken.status, 403);

  const badPath = await fetch(url('token=' + uploadToken + '&method=POST&path=' + encodeURIComponent('/etc/passwd')), { method: 'POST', body: 'x' });
  assert.equal(badPath.status, 400);

  const traversal = await fetch(url('token=' + uploadToken + '&method=POST&path=' + encodeURIComponent('/api/../etc/passwd')), { method: 'POST', body: 'x' });
  assert.equal(traversal.status, 400);

  const badMethod = await fetch(url('token=' + uploadToken + '&method=GET&path=' + encodeURIComponent('/api/resources')), { method: 'POST', body: 'x' });
  assert.equal(badMethod.status, 400);

  const notPost = await fetch(url('token=' + uploadToken + '&method=POST&path=' + encodeURIComponent('/api/resources')));
  assert.equal(notPost.status, 405);
});

test('上传令牌落盘复用，连接器重启后已打开的页面仍能写', async (t) => {
  // 令牌原来每次启动重新随机，而页面只在首次探测时取一次：连接器被 DX OS 重启后，
  // 旧页面继续用旧令牌发写请求，会统一收到 403「上传令牌无效」。令牌落盘后重启不变。
  const runtime = makeRuntime();
  const tokenOnce = async () => {
    const server = startServer(runtime);
    const address = await server.request('tools/call', { name: 'request', arguments: { path: '/api/__dxos/backend-origin' } });
    const payload = JSON.parse(JSON.parse(address.result.content[0].text).body);
    server.stop();
    return payload.uploadToken;
  };
  const first = await tokenOnce();
  assert.match(first, /^[0-9a-f]{48}$/);
  assert.equal(await tokenOnce(), first, '连接器重启后上传令牌必须保持不变');
  // 令牌是文件权限 600 的本机凭据，落盘位置在包外数据目录。
  const file = path.join(runtime.dataDir, 'connector-upload-token');
  assert.equal(fs.readFileSync(file, 'utf8').trim(), first);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // 损坏的令牌文件不能把上传通道打死，必须重新生成一个可用的。
  fs.writeFileSync(file, 'not-a-token');
  const regenerated = await tokenOnce();
  assert.match(regenerated, /^[0-9a-f]{48}$/);
  assert.notEqual(regenerated, 'not-a-token');
  assert.equal(fs.readFileSync(file, 'utf8').trim(), regenerated);
});

test('灵感缩略图由 mcp/inspiration-thumbs.zip 直接切片返回，不再占用包内条目', async (t) => {
  // 宿主对 APP 包的 ZIP 条目数上限是 2048，1.6.2 上游新增的 355 张缩略图会把整包顶爆。
  // 打包时把它们收进一个 mcp/ 下的 STORED zip，媒体代理按 /api/dxos-thumbs/<相对路径> 提供。
  const runtime = makeRuntime({ backend: '#!/bin/sh\nexit 3\n' });
  const http = require('node:http');
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data: { path: req.url } }));
  });
  await new Promise((resolve) => upstream.listen(39993, '127.0.0.1', resolve));
  t.after(() => upstream.close());

  const thumbs = Buffer.concat([Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 '), Buffer.alloc(64, 7)]);
  const zip = path.join(runtime.mcp, 'inspiration-thumbs.zip');
  const { execFileSync: run } = require('node:child_process');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'yingce-thumbs-'));
  fs.mkdirSync(path.join(stage, 'haohaoxue'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'haohaoxue', 'demo.webp'), thumbs);
  fs.writeFileSync(path.join(stage, 'haohaoxue', 'other.webp'), Buffer.concat([thumbs, Buffer.from('tail')]));
  run('/usr/bin/zip', ['-0', '-q', '-r', zip, 'haohaoxue'], { cwd: stage });

  const server = startServer(runtime, { YINGCE_BACKEND_PORT: '39993' });
  t.after(() => server.stop());
  const address = await server.request('tools/call', { name: 'request', arguments: { path: '/api/__dxos/backend-origin' } });
  const mediaOrigin = JSON.parse(JSON.parse(address.result.content[0].text).body).origin;

  const thumb = await fetch(mediaOrigin + '/api/dxos-thumbs/haohaoxue/demo.webp');
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers.get('content-type'), 'image/webp');
  assert.equal(thumb.headers.get('content-length'), String(thumbs.length));
  assert.deepEqual(Buffer.from(await thumb.arrayBuffer()), thumbs, '必须返回原始 webp 字节');

  const second = await fetch(mediaOrigin + '/api/dxos-thumbs/haohaoxue/other.webp');
  assert.deepEqual(Buffer.from(await second.arrayBuffer()), Buffer.concat([thumbs, Buffer.from('tail')]));

  const head = await fetch(mediaOrigin + '/api/dxos-thumbs/haohaoxue/demo.webp', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);

  // 未收录的缩略图必须是 404，而且不能落到后端代理上。
  const missing = await fetch(mediaOrigin + '/api/dxos-thumbs/haohaoxue/missing.webp');
  assert.equal(missing.status, 404);
  // fetch 会先把 "/../" 规范化掉，所以目录穿越要直接发原始请求行才测得到。
  const rawStatus = (rawPath) => new Promise((resolve, reject) => {
    const url = new URL(mediaOrigin);
    const request = require('node:http').request({ host: url.hostname, port: url.port, path: rawPath, method: 'GET' }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(await rawStatus('/api/dxos-thumbs/../server.js'), 404);
  assert.equal(await rawStatus('/api/dxos-thumbs/haohaoxue%2F..%2F..%2Fserver.js'), 404);
});
