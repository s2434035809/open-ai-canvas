const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const rawSource = fs.readFileSync(__dirname + '/assets/dxos-bootstrap.js', 'utf8');
// 打包时 build.py 会把端口占位符替换成固定端口，测试里用同一个端口跑。
const source = rawSource.replace(/__YINGCE_BACKEND_PORT__/g, '1724');
function setup(document = {}, navigator = {}, dom = {}, options = {}) {
  const listeners = [], sent = [];
  const originReply = options.originReply === undefined ? 'http://127.0.0.1:1724' : options.originReply;
  const uploadToken = options.uploadToken === undefined ? 'test-upload-token' : options.uploadToken;
  const nativeCalls = [];
  const parent = {
    postMessage(message) {
      sent.push(message);
      // 连接器会在真实运行环境里回答后端地址；测试里按需自动回一条。
      if (!message || !message.args || message.args.path !== '/api/__dxos/backend-origin') return;
      // originReply 传函数时可以按第几次探测返回不同地址（模拟连接器重启后换了端口）。
      const answer = typeof originReply === 'function' ? originReply(message) : originReply;
      if (!answer) return;
      // 'error' 用来模拟旧版连接器：桥调用失败后必须回落到端口段探测。
      const reply = answer === 'error'
        ? { dxos: 'v1', id: message.id, ok: false, error: 'HTTP 404' }
        : { dxos: 'v1', id: message.id, ok: true, result: { content: [{ type: 'text', text: JSON.stringify({ status: 200, body: JSON.stringify({ origin: answer, uploadToken }), headers: { 'content-type': 'application/json' } }) }] } };
      queueMicrotask(() => listeners.forEach((listener) => listener({ source: parent, data: reply })));
    }
  };
  const nativeFetch = options.nativeFetch || (async (input, init) => { nativeCalls.push({ input: String(input), init }); return new Response('native'); });
  const window = { parent, fetch: nativeFetch, XMLHttpRequest: function () {}, addEventListener(type, listener) { if (type === 'message') listeners.push(listener); }, ...dom };
  const location = { href: 'http://localhost/api/developer-runtime/package/index.html', pathname: '/api/developer-runtime/package/index.html', host: 'localhost', hostname: 'localhost', protocol: 'http:' };
  const context = { window, document, navigator, location, URL, URLSearchParams, FormData, Blob, ArrayBuffer, Response, WeakMap, setTimeout, clearTimeout, atob: globalThis.atob, btoa: globalThis.btoa };
  vm.runInNewContext(source, context);
  return { window, sent, nativeCalls, respond(message, source = parent) { listeners.forEach(listener => listener({ source, data: message })); } };
}

// 最小 DOM 替身：只需要媒体元素原型上的 src/poster 访问器和 Element.setAttribute。
function mediaDom() {
  const attribute = (prop, parent) => {
    const proto = Object.create(parent);
    Object.defineProperty(proto, prop, {
      configurable: true,
      get() { return this.__attrs ? this.__attrs[prop] : undefined; },
      set(value) { (this.__attrs = this.__attrs || {})[prop] = String(value); }
    });
    return proto;
  };
  const construct = (proto) => { const ctor = function () {}; ctor.prototype = proto; return ctor; };
  const elementProto = {
    setAttribute(name, value) { (this.__attrs = this.__attrs || {})[name] = String(value); },
    getAttribute(name) { return (this.__attrs || {})[name]; },
    removeAttribute(name) { if (this.__attrs) delete this.__attrs[name]; }
  };
  const Element = construct(elementProto);
  const mediaProto = attribute('src', elementProto);
  // 内联样式的替身：只需要 CSSStyleDeclaration 上的属性访问器和 setProperty。
  const styleProto = {};
  for (const prop of ['background', 'backgroundImage']) {
    Object.defineProperty(styleProto, prop, {
      configurable: true,
      get() { return (this.__style || {})[prop]; },
      set(value) { (this.__style = this.__style || {})[prop] = String(value); }
    });
  }
  styleProto.setProperty = function (name, value) { (this.__style = this.__style || {})[name] = String(value); };
  return {
    Element,
    HTMLImageElement: construct(attribute('src', elementProto)),
    HTMLMediaElement: construct(mediaProto),
    HTMLSourceElement: construct(attribute('src', elementProto)),
    HTMLVideoElement: construct(attribute('poster', mediaProto)),
    CSSStyleDeclaration: construct(styleProto)
  };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
// 模拟「直连通道不可用」（旧版连接器、或宿主禁止 iframe 直连本机端口）：
// 后端地址探测失败，于是所有 /api 请求都必须回退到 MCP 桥。
const directUnavailableFetch = async (input) => {
  if (String(input).indexOf('/api/health/ready') >= 0) throw new Error('direct channel unavailable');
  return new Response('native');
};
const mcpOnly = () => ({ originReply: 'error', nativeFetch: directUnavailableFetch });
// 直连探测是异步的，MCP 请求会在若干 tick 之后才出现，所以按路径等待而不是取最后一条。
async function waitForMcp(env, path) {
  for (let index = 0; index < 500; index += 1) {
    const found = env.sent.filter((message) => message && message.args && message.args.path === path).at(-1);
    if (found) return found;
    await tick();
  }
  throw new Error('未观察到 MCP 请求：' + path);
}
test('直连不可用时回退 MCP 桥，并按 DX OS 扁平契约收发', async () => {
  const env = setup({}, {}, {}, mcpOnly());
  const request = env.window.fetch('/api/health');
  const message = await waitForMcp(env, '/api/health');
  assert.equal(message.action, 'mcp.call');
  assert.equal(message.serverId, 'yingce-local');
  assert.equal(message.tool, 'request');
  assert.equal(message.args.path, '/api/health');
  const reply = { dxos: 'v1', id: message.id, ok: true, result: { content: [{ type: 'text', text: JSON.stringify({ status: 200, body: '{"code":0}', headers: { 'content-type': 'application/json' } }) }] } };
  env.respond({ ...reply, result: { status: 403 } }, {});
  env.respond(reply);
  assert.deepEqual(await (await request).json(), { code: 0 });
});
test('宿主错误向上抛出，非 /api 请求仍走原生传输', async () => {
  const env = setup({}, {}, {}, mcpOnly());
  const request = env.window.fetch('/api/auth/session');
  const message = await waitForMcp(env, '/api/auth/session');
  env.respond({ dxos: 'v1', id: message.id, ok: false, error: 'permission denied' });
  await assert.rejects(request, /permission denied/);
  assert.equal(await (await env.window.fetch('./image.png')).text(), 'native');
});
test('/api 读请求优先走连接器直连代理，不再占用 MCP 工具调用', async () => {
  const env = setup();
  const response = await env.window.fetch('/api/agent/capabilities');
  assert.equal(await response.text(), 'native');
  const direct = env.nativeCalls.map((item) => String(item.input)).find((url) => url.indexOf('/api/agent/capabilities') >= 0);
  assert.equal(direct, 'http://127.0.0.1:1724/api/agent/capabilities');
  assert.equal(env.sent.filter((message) => message.args && message.args.path === '/api/agent/capabilities').length, 0);
});
test('Agent 事件流直连流式读取，不再被 MCP 单次 60s 硬超时掐断', async () => {
  const chunks = ['event: agent_event\ndata: {"runId":"r1","seq":1,"type":"message_start"}\n\n', 'event: agent_event\ndata: {"runId":"r1","seq":2,"type":"message_end"}\n\n'];
  const seen = [];
  const env = setup({}, {}, {}, {
    nativeFetch: async (input, init) => {
      seen.push({ input: String(input), init });
      const body = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        }
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
  });
  const response = await env.window.fetch('/api/agent/runs/r1/events', { headers: { Accept: 'text/event-stream' } });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  // 流式：两个分片按原样读回，没有被整体缓冲或 base64 往返破坏。
  assert.equal(await response.text(), chunks.join(''));
  const direct = seen.find((item) => item.input.indexOf('/api/agent/runs/r1/events') >= 0);
  assert.ok(direct, 'Agent 事件流必须走直连');
  assert.equal(direct.init.method, 'GET');
  assert.equal(direct.init.credentials, 'omit');
  assert.equal(env.sent.filter((message) => message.args && String(message.args.path).indexOf('/api/agent/runs/') === 0).length, 0);
});
test('/api 写请求走直连上传端点，自定义渠道头原样透传', async () => {
  const env = setup();
  await env.window.fetch('/api/ai/custom', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Canvas-Upstream-URL': 'https://up.example/v1/images/generations' },
    body: '{"prompt":"x"}'
  });
  const direct = env.nativeCalls.find((item) => String(item.input).indexOf('/__dxos/upload') >= 0);
  assert.ok(direct, '写请求必须走直连上传端点');
  assert.match(direct.input, /method=POST/);
  assert.match(direct.input, /path=%2Fapi%2Fai%2Fcustom/);
  assert.equal(direct.init.headers['X-Canvas-Upstream-URL'], 'https://up.example/v1/images/generations');
  assert.equal(direct.init.credentials, 'omit');
  assert.equal(env.sent.filter((message) => message.args && message.args.path === '/api/ai/custom').length, 0);
});
test('直连端点不支持的方法（OPTIONS）交回 MCP', async () => {
  const env = setup();
  const request = env.window.fetch('/api/agent/runs/r3/events', { method: 'OPTIONS' });
  const message = await waitForMcp(env, '/api/agent/runs/r3/events');
  env.respond({ dxos: 'v1', id: message.id, ok: true, result: { text: JSON.stringify({ status: 204, body: '', headers: {} }) } });
  assert.equal((await request).status, 204);
  assert.equal(env.nativeCalls.length, 0);
});
test('调用方 abort 时直连长连接被取消，且不再回退 MCP', async () => {
  const controller = new AbortController();
  const env = setup({}, {}, {}, {
    nativeFetch: async (input, init) => {
      assert.equal(init.signal, controller.signal);
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
  });
  const pending = env.window.fetch('/api/agent/runs/r2/events', { signal: controller.signal });
  await tick();
  controller.abort();
  await assert.rejects(pending, /aborted/);
  assert.equal(env.sent.filter((message) => message.args && String(message.args.path).indexOf('/api/agent/runs/') === 0).length, 0);
});
test('/api/__dxos/* 是连接器自有路由，必须留在 MCP 桥内', async () => {
  const env = setup();
  const request = env.window.fetch('/api/__dxos/backend-origin');
  const message = await waitForMcp(env, '/api/__dxos/backend-origin');
  env.respond({ dxos: 'v1', id: message.id, ok: true, result: { text: JSON.stringify({ status: 200, body: '{"origin":"http://127.0.0.1:1724"}', headers: { 'content-type': 'application/json' } }) } });
  assert.equal((await request).status, 200);
});
test('304/204 无正文状态不再抛 Response 构造错误', async () => {
  const env = setup({}, {}, {}, mcpOnly());
  // 画布同步带 If-None-Match 轮询，后端回 304；带 body 构造 Response 会炸掉整个画布页。
  const notModified = env.window.fetch('/api/canvas-projects/p1', { headers: { 'If-None-Match': '"canvas-1"' } });
  const poll = await waitForMcp(env, '/api/canvas-projects/p1');
  env.respond({ dxos: 'v1', id: poll.id, ok: true, result: { content: [{ type: 'text', text: JSON.stringify({ status: 304, body: '', headers: { etag: '"canvas-1"' } }) }] } });
  const response = await notModified;
  assert.equal(response.status, 304);
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('etag'), '"canvas-1"');

  const noContent = env.window.fetch('/api/resources/uploads/u1/complete', { method: 'POST' });
  const complete = await waitForMcp(env, '/api/resources/uploads/u1/complete');
  env.respond({ dxos: 'v1', id: complete.id, ok: true, result: { content: [{ type: 'text', text: JSON.stringify({ status: 204, body: '' }) }] } });
  assert.equal((await noContent).status, 204);
});

test('MCP 回退时 base64 响应体被还原成字节（Agent SSE 与文件下载）', async () => {
  const env = setup({}, {}, {}, mcpOnly());
  // 连接器对非 JSON 响应按 base64 过桥；不解码的话前端拿到的是乱码，
  // 事件流解析不出 agent_event，面板永远停在“正在连接并校准运行状态”。
  const sse = 'event: agent_event\ndata: {"runId":"r1","seq":1,"type":"message_start"}\n\n';
  const encoded = Buffer.from(sse, 'utf8').toString('base64');
  const pending = env.window.fetch('/api/agent/runs/r1/events', { headers: { Accept: 'text/event-stream' } });
  const sseRequest = await waitForMcp(env, '/api/agent/runs/r1/events');
  env.respond({ dxos: 'v1', id: sseRequest.id, ok: true, result: { content: [{ type: 'text', text: JSON.stringify({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: encoded, encoding: 'base64' }) }] } });
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(await response.text(), sse);
});

test('XHR response headers use CRLF', () => {
  const env = setup();
  const xhr = new env.window.XMLHttpRequest();
  xhr.responseHeaders = { a: '1', b: '2' };
  assert.equal(xhr.getAllResponseHeaders(), 'a: 1\r\nb: 2');
});
test('sandbox cookie access no longer prevents login XHR and session requests', async () => {
  const document = {};
  Object.defineProperty(document, 'cookie', { configurable: true, get() {
    throw new DOMException('The document is sandboxed', 'SecurityError');
  } });
  const env = setup(document, {}, {}, mcpOnly());
  assert.equal(document.cookie, '');
  document.cookie = 'ignored=value';
  assert.equal(document.cookie, '');
  for (const [method, path, body] of [['POST', '/api/auth/login', '{"username":"test","password":"fixture"}'], ['GET', '/api/auth/session', null]]) {
    const xhr = new env.window.XMLHttpRequest();
    xhr.open(method, path);
    const completed = new Promise((resolve, reject) => { xhr.onloadend = resolve; xhr.onerror = reject; });
    xhr.send(body);
    const message = await waitForMcp(env, path);
    assert.equal(message.args.path, path);
    assert.equal(message.args.body, body);
    env.respond({ dxos: 'v1', id: message.id, ok: true, result: { text: JSON.stringify({ status: 200, body: '{"code":0,"data":{}}' }) } });
    await completed;
    assert.equal(xhr.status, 200);
    assert.equal(JSON.parse(xhr.responseText).code, 0);
  }
});
test('working browser cookie accessor is preserved', () => {
  const document = { cookie: 'existing=value' };
  setup(document);
  assert.equal(document.cookie, 'existing=value');
  document.cookie = 'updated=value';
  assert.equal(document.cookie, 'updated=value');
});

test('blocked Web Locks are replaced by an in-process mutex', async () => {
  const blocked = { request() { throw new DOMException('Access to the Locks API is denied in this context.', 'SecurityError'); } };
  const nav = { locks: blocked };
  setup({}, nav);
  const locks = nav.locks;
  assert.notEqual(locks, blocked);
  assert.equal(typeof locks.request, 'function');
  let active = 0;
  let max = 0;
  const job = () => locks.request('infinite-canvas:lock', async () => {
    active++; max = Math.max(max, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
  });
  await Promise.all([job(), job(), job()]);
  assert.equal(max, 1);
  await assert.rejects(locks.request('infinite-canvas:lock', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await locks.request('infinite-canvas:lock', async () => 'after-failure'), 'after-failure');
});
test('Web Locks that reject asynchronously are also replaced', async () => {
  const blocked = { request() { return Promise.reject(new DOMException('Access to the Locks API is denied in this context.', 'SecurityError')); } };
  const nav = { locks: blocked };
  setup({}, nav);
  assert.notEqual(nav.locks, blocked);
  assert.equal(await nav.locks.request('infinite-canvas:lock', async () => 'ok'), 'ok');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.notEqual(nav.locks, blocked);
  assert.equal(await nav.locks.request('infinite-canvas:lock', async () => 'still-ok'), 'still-ok');
});
test('working native Web Locks are restored after the probe settles', async () => {
  const native = { request: async (name, callback) => callback() };
  const nav = { locks: native };
  setup({}, nav);
  assert.notEqual(nav.locks, native);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(nav.locks, native);
});

test('相对 /api 媒体地址改写成直连包内后端的绝对地址', async () => {
  const dom = mediaDom();
  setup({}, {}, dom);
  const image = new dom.HTMLImageElement();
  image.src = '/api/public/resources/abc/file?expires=1&signature=s';
  await tick();
  assert.equal(image.__attrs.src, 'http://127.0.0.1:1724/api/public/resources/abc/file?expires=1&signature=s');
  // 逻辑值保持不变：组件读回自己写入的地址时不应看到探测出来的端口。
  assert.equal(image.src, '/api/public/resources/abc/file?expires=1&signature=s');
});

test('React 走 setAttribute 的媒体地址同样被改写', async () => {
  const dom = mediaDom();
  setup({}, {}, dom);
  const image = new dom.HTMLImageElement();
  image.setAttribute('src', '/api/public/resources/abc/file?expires=2&signature=t');
  await tick();
  assert.equal(image.__attrs.src, 'http://127.0.0.1:1724/api/public/resources/abc/file?expires=2&signature=t');
  const video = new dom.HTMLVideoElement();
  video.setAttribute('poster', '/api/public/resources/poster/file');
  await tick();
  assert.equal(video.__attrs.poster, 'http://127.0.0.1:1724/api/public/resources/poster/file');
});

test('非后端地址、已带 runtime 前缀的地址与外部站点都不被改写', async () => {
  const dom = mediaDom();
  setup({}, {}, dom);
  const image = new dom.HTMLImageElement();
  image.src = './assets/logo.png';
  image.src = '/api/developer-runtime/package/assets/index.js';
  image.src = 'https://example.com/api/thing.png';
  image.src = 'data:image/png;base64,AAAA';
  await tick();
  assert.equal(image.__attrs.src, 'data:image/png;base64,AAAA');
});

test('根绝对静态资源改写成相对路径，回到应用自己的目录', async () => {
  const dom = mediaDom();
  setup({}, {}, dom);
  const image = new dom.HTMLImageElement();
  image.src = '/short-drama-styles/cyberpunk-neon.jpg';
  await tick();
  // 相对文档 base（/api/developer-runtime/package/）解析，不再落到宿主源 404。
  assert.equal(image.__attrs.src, 'short-drama-styles/cyberpunk-neon.jpg');
  // 逻辑值仍是组件写入的原值。
  assert.equal(image.src, '/short-drama-styles/cyberpunk-neon.jpg');

  const style = new dom.CSSStyleDeclaration();
  style.backgroundImage = 'url("/welcome/wing-it/barn.webp")';
  await tick();
  assert.equal(style.__style.backgroundImage, 'url("welcome/wing-it/barn.webp")');

  const viaAttribute = new dom.HTMLImageElement();
  viaAttribute.setAttribute('src', '/images/cover.png');
  await tick();
  assert.equal(viaAttribute.__attrs.src, 'images/cover.png');
});

test('计算丢掉 runtime 前缀的地址会补回 token 段', async () => {
  const dom = mediaDom();
  setup({}, {}, dom);
  const image = new dom.HTMLImageElement();
  image.src = 'http://localhost/api/developer-runtime/welcome/wing-it/barn.webp';
  await tick();
  assert.equal(image.__attrs.src, 'http://localhost/api/developer-runtime/package/welcome/wing-it/barn.webp');
});

test('根绝对静态数据的 fetch 补回 runtime 前缀，不再被宿主 SPA 回退成 HTML', async () => {
  const env = setup();
  const response = await env.window.fetch('/inspirations/manifest.json', { headers: { Accept: 'application/json' } });
  assert.equal(await response.text(), 'native');
  const rewritten = env.nativeCalls.map((item) => String(item.input)).find((url) => url.indexOf('inspirations/manifest.json') >= 0);
  // 补回 token 段后请求才落到应用自己的目录，拿到真正的 JSON。
  assert.equal(rewritten, '/api/developer-runtime/package/inspirations/manifest.json');
  // 静态数据不是后端接口，不能占用 MCP 工具调用。
  assert.equal(env.sent.filter((message) => message.args && message.args.path).length, 0);
});

test('已带 runtime 前缀与外部站点的地址都不被静态改写', async () => {
  const env = setup();
  await env.window.fetch('/api/developer-runtime/package/inspirations/manifest.json');
  await env.window.fetch('http://example.com/inspirations/manifest.json');
  const urls = env.nativeCalls.map((item) => String(item.input));
  assert.ok(urls.includes('/api/developer-runtime/package/inspirations/manifest.json'), urls.join(','));
  assert.ok(urls.includes('http://example.com/inspirations/manifest.json'), urls.join(','));
  assert.ok(!urls.some((url) => url.indexOf('/api/developer-runtime/package/inspirations/manifest.json/inspirations') >= 0));
});

test('XHR 请求根绝对静态数据同样补回 runtime 前缀', async () => {
  const opened = [];
  function FakeXHR() { this.headers = {}; }
  FakeXHR.prototype.open = function (method, url) { opened.push({ method, url }); };
  FakeXHR.prototype.setRequestHeader = function () {};
  FakeXHR.prototype.getAllResponseHeaders = function () { return ''; };
  FakeXHR.prototype.getResponseHeader = function () { return null; };
  FakeXHR.prototype.send = function () {};
  const env = setup({}, {}, { XMLHttpRequest: FakeXHR });
  const xhr = new env.window.XMLHttpRequest();
  xhr.open('GET', '/inspirations/seedance.json');
  xhr.send();
  assert.deepEqual(opened, [{ method: 'GET', url: '/api/developer-runtime/package/inspirations/seedance.json' }]);
});

test('FormData 上传改走连接器上传端点，不再直接拒绝', async () => {
  const dom = mediaDom();
  const env = setup({}, {}, dom);
  const form = new FormData();
  form.append('kind', 'image');
  form.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'probe.png');
  const response = await env.window.fetch('/api/resources', { method: 'POST', body: form });
  assert.equal(response.status, 200);
  const call = env.nativeCalls.at(-1);
  assert.ok(call, '必须落到原生 fetch 上传端点');
  assert.match(call.input, /^http:\/\/127\.0\.0\.1:1724\/__dxos\/upload\?/);
  assert.match(call.input, /token=test-upload-token/);
  assert.match(call.input, /method=POST/);
  assert.match(call.input, new RegExp('path=' + encodeURIComponent('/api/resources')));
  assert.equal(call.init.body, form, '原始 FormData 必须原样交给浏览器编码');
  // FormData 的 multipart boundary 由浏览器生成，不能手写 content-type。
  assert.equal(call.init.headers['content-type'], undefined);
});

test('二进制 PUT 上传带上原始 Content-Type 并透传方法', async () => {
  const dom = mediaDom();
  const env = setup({}, {}, dom);
  const blob = new Blob([new Uint8Array([9, 9])], { type: 'application/octet-stream' });
  await env.window.fetch('/api/resources/uploads/up-1/chunks/0', { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: blob });
  const call = env.nativeCalls.at(-1);
  assert.match(call.input, /method=PUT/);
  assert.match(call.input, new RegExp('path=' + encodeURIComponent('/api/resources/uploads/up-1/chunks/0')));
  assert.equal(call.init.headers['Content-Type'], 'application/octet-stream');
});

test('上传令牌过期时重新探测并按新地址重放，调用方拿到成功响应', async () => {
  // 连接器被 DX OS 重启后换了令牌和端口，旧页面继续用旧令牌发写请求会被判 403。
  // 这不是业务失败，必须自动重探一次重放，否则用户看到的是「什么都没动却突然存不了」。
  const origins = ['http://127.0.0.1:1744', 'http://127.0.0.1:1745'];
  let probes = 0;
  const writes = [];
  const env = setup({}, {}, {}, {
    originReply: () => origins[Math.min(probes++, origins.length - 1)],
    nativeFetch: async (input) => {
      if (String(input).indexOf('/__dxos/upload') >= 0) {
        writes.push(String(input));
        // 连接器的令牌校验发生在读取请求体之前，回的是纯文本 403 而不是后端信封。
        if (writes.length === 1) return new Response('上传令牌无效', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } });
        return new Response('{"code":0,"data":{"ok":true}}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('native');
    }
  });
  const response = await env.window.fetch('/api/resources', { method: 'POST', body: '{"kind":"image"}' });
  assert.equal(response.status, 200);
  assert.equal(writes.length, 2, '令牌过期必须恰好重放一次');
  assert.match(writes[0], /127\.0\.0\.1:1744/);
  assert.match(writes[1], /127\.0\.0\.1:1745/, '重放必须用重新探测到的地址');
  assert.match(writes[1], new RegExp('path=' + encodeURIComponent('/api/resources')));
});

test('后端自身的 403 不会被误判成令牌过期，不做重放', async () => {
  // 后端拒绝也是 403，但带 JSON 信封；误判会掩盖真实权限错误并多发一次请求。
  let writes = 0;
  const env = setup({}, {}, {}, {
    nativeFetch: async (input) => {
      if (String(input).indexOf('/__dxos/upload') >= 0) {
        writes += 1;
        return new Response('{"code":403,"msg":"没有该文件的权限"}', { status: 403, headers: { 'content-type': 'application/json' } });
      }
      return new Response('native');
    }
  });
  const response = await env.window.fetch('/api/resources', { method: 'POST', body: '{"kind":"image"}' });
  assert.equal(response.status, 403);
  assert.equal(writes, 1, '后端 403 不得触发重放');
  assert.equal((await response.json()).code, 403);
});

test('XHR 二进制上传同样在令牌过期后重探重放（axios 走的就是这条路径）', async () => {
  // 前端大文件与 FormData 走 DxosXHR；截图里的报错正是 axios 从这条路径拿到的 403。
  const origins = ['http://127.0.0.1:1744', 'http://127.0.0.1:1745'];
  let probes = 0;
  const opened = [];
  function FakeXHR() { this.headers = {}; this.upload = { onprogress: null, onload: null }; }
  FakeXHR.prototype.open = function (method, url) { this.method = method; this.url = url; opened.push(url); };
  FakeXHR.prototype.setRequestHeader = function (name, value) { this.headers[name] = value; };
  FakeXHR.prototype.getAllResponseHeaders = function () { return ''; };
  FakeXHR.prototype.getResponseHeader = function () { return null; };
  FakeXHR.prototype.send = function () {
    const first = opened.length === 1;
    // 连接器在读取请求体之前就校验令牌，过期时回纯文本 403。
    this.status = first ? 403 : 200;
    this.responseText = first ? '上传令牌无效' : '{"code":0,"data":{"ok":true}}';
    this.response = this.responseText;
    this.readyState = 4;
    if (this.onreadystatechange) this.onreadystatechange();
    if (this.onload) this.onload();
    if (this.onloadend) this.onloadend();
  };
  const env = setup({}, {}, { XMLHttpRequest: FakeXHR }, { originReply: () => origins[Math.min(probes++, origins.length - 1)] });
  const xhr = new env.window.XMLHttpRequest();
  xhr.open('POST', '/api/resources/uploads/up-1/chunks/0');
  xhr.send(new Blob([new Uint8Array([1, 2, 3])], { type: 'application/octet-stream' }));
  await tick(); await tick(); await tick();
  assert.equal(opened.length, 2, '令牌过期必须恰好重放一次');
  assert.match(opened[0], /127\.0\.0\.1:1744/);
  assert.match(opened[1], /127\.0\.0\.1:1745/, '重放必须用重新探测到的地址');
  // 重放成功后，调用方只应看到最终结果，不能先收到中间那次 403。
  assert.equal(xhr.status, 200);
  assert.equal(xhr.responseText, '{"code":0,"data":{"ok":true}}');
});

test('内联样式里的 /api 背景图同样改写成直连后端的绝对地址', async () => {
  const dom = mediaDom();
  setup({}, {}, dom);
  const style = new dom.CSSStyleDeclaration();
  style.backgroundImage = 'url("/api/public/resources/abc/file?expires=5&signature=w")';
  await tick();
  assert.equal(style.__style.backgroundImage, 'url("http://127.0.0.1:1724/api/public/resources/abc/file?expires=5&signature=w")');
  // 逻辑值保持组件写入的原值，组件读回时不应看到探测出来的端口。
  assert.equal(style.backgroundImage, 'url("/api/public/resources/abc/file?expires=5&signature=w")');
});

test('内联样式里的非后端地址与渐变不被改写', async () => {
  const dom = mediaDom();
  setup({}, {}, dom);
  const style = new dom.CSSStyleDeclaration();
  style.background = 'linear-gradient(to top, rgba(0,0,0,0.78), rgba(0,0,0,0.08))';
  style.setProperty('background-image', 'url("./assets/cover.png")');
  await tick();
  assert.equal(style.__style.background, 'linear-gradient(to top, rgba(0,0,0,0.78), rgba(0,0,0,0.08))');
  assert.equal(style.__style['background-image'], 'url("./assets/cover.png")');
});

test('端口占位符、连接器默认端口与打包脚本保持一致', () => {
  const server = fs.readFileSync(__dirname + '/mcp/server.js', 'utf8');
  const build = fs.readFileSync(__dirname + '/build.py', 'utf8');
  assert.match(rawSource, /__YINGCE_BACKEND_PORT__/);
  const serverPort = Number(server.match(/DEFAULT_BACKEND_PORT\s*=\s*(\d+)/)[1]);
  const buildPort = Number(build.match(/^BACKEND_PORT\s*=\s*(\d+)/m)[1]);
  assert.equal(serverPort, buildPort);
  assert.equal(server.match(/BACKEND_PORT_SPAN\s*=\s*(\d+)/)[1], source.match(/BACKEND_PORT_SPAN\s*=\s*(\d+)/)[1]);
  // 媒体代理必须落在后端端口段之外，否则两个监听会互相抢占。
  const mediaPort = Number(server.match(/DEFAULT_MEDIA_PORT\s*=\s*(\d+)/)[1]);
  const mediaSpan = Number(server.match(/MEDIA_PORT_SPAN\s*=\s*(\d+)/)[1]);
  const backendEnd = serverPort + Number(server.match(/BACKEND_PORT_SPAN\s*=\s*(\d+)/)[1]) - 1;
  assert.ok(mediaPort > backendEnd, '媒体代理端口段必须排在后端端口段之后');
  assert.ok(mediaSpan > 0);
});

test('下载离开沙箱：file.export 权限与调用都在位', () => {
  const build = fs.readFileSync(__dirname + '/build.py', 'utf8');
  const manifest = JSON.parse(fs.readFileSync(__dirname + '/dx-app.json', 'utf8'));
  // 宿主 file.export 会先校验 app.<id>.file.write（DeveloperAppHost 的 nt("write")），
  // 少这一条时下载会静默失败；ui.notify 用于把失败原因告诉用户。
  for (const permission of ['app.yingce-main.file.write', 'app.yingce-main.ui.notify']) {
    assert.match(build, new RegExp(permission.replace(/\./g, '\\.')), '打包脚本必须声明 ' + permission);
    assert.ok(manifest.permissions.includes(permission), 'dx-app.json 必须声明 ' + permission);
  }
  // 适配层只能走宿主导出：page 侧 blob 锚点在 allow-downloads 缺失时会被静默拦掉。
  // 沙箱 iframe 里没有 window.dx，导出必须走通用的 bridge（postMessage）通道。
  assert.match(rawSource, /bridge\.invoke\('file\.export'/);
  assert.match(rawSource, /permission: EXPORT_PERMISSION/);
  assert.match(rawSource, /app\.yingce-main\.file\.write/);
  assert.doesNotMatch(rawSource, /link\.click\(\)/, '不得再依赖页面内的 blob 锚点点击');
  // 页面自建 blob（编辑器导出）也逃不出沙箱，必须同样交给宿主导出。
  assert.match(rawSource, /objectURLBlobs/);
});

test('旧版连接器不认后端地址接口时回落到固定端口段探测', async () => {
  const dom = mediaDom();
  setup({}, {}, dom, { originReply: 'error' });
  const image = new dom.HTMLImageElement();
  image.src = '/api/public/resources/abc/file?expires=3&signature=u';
  await tick();
  // setup 的 nativeFetch 一律成功，端口段探测会命中第一个候选端口。
  assert.equal(image.__attrs.src, 'http://127.0.0.1:1724/api/public/resources/abc/file?expires=3&signature=u');
});

test('图片加载失败后重新探测媒体地址并按新地址重试', async () => {
  const replies = ['http://127.0.0.1:1744', 'http://127.0.0.1:1745'];
  let probes = 0;
  const dom = mediaDom();
  const listeners = [];
  const document = { addEventListener(type, listener) { if (type === 'error') listeners.push(listener); } };
  setup(document, {}, dom, { originReply: () => replies[Math.min(probes++, replies.length - 1)] });
  const image = new dom.HTMLImageElement();
  image.tagName = 'IMG';
  image.src = '/api/public/resources/abc/file?expires=9&signature=z';
  await tick();
  assert.equal(image.__attrs.src, 'http://127.0.0.1:1744/api/public/resources/abc/file?expires=9&signature=z');
  assert.equal(listeners.length, 1, '必须监听媒体元素加载失败');
  // 连接器重启：媒体代理换到另一个端口，旧地址已经没人监听。
  listeners.forEach((listener) => listener({ target: image }));
  await tick();
  assert.equal(image.__attrs.src, 'http://127.0.0.1:1745/api/public/resources/abc/file?expires=9&signature=z');
  // 逻辑地址保持组件写入的原值，重试不能污染组件状态。
  assert.equal(image.src, '/api/public/resources/abc/file?expires=9&signature=z');
});

test('媒体加载失败的重试有上限，坏地址不会无限重试', async () => {
  const dom = mediaDom();
  const listeners = [];
  const document = { addEventListener(type, listener) { if (type === 'error') listeners.push(listener); } };
  const env = setup(document, {}, dom);
  const image = new dom.HTMLImageElement();
  image.tagName = 'IMG';
  image.src = '/api/public/resources/gone/file';
  await tick();
  for (let round = 0; round < 5; round += 1) {
    listeners.forEach((listener) => listener({ target: image }));
    await tick();
  }
  const probes = env.sent.filter((message) => message.args && message.args.path === '/api/__dxos/backend-origin');
  assert.ok(probes.length <= 4, '失败重试必须封顶，实际探测 ' + probes.length + ' 次');
  assert.equal(image.__attrs.src, 'http://127.0.0.1:1724/api/public/resources/gone/file');
});

test('removeAttribute 会清掉逻辑地址，不再返回过期值', async () => {
  const dom = mediaDom();
  setup({}, {}, dom);
  const image = new dom.HTMLImageElement();
  image.src = '/api/public/resources/abc/file?expires=4&signature=v';
  await tick();
  assert.equal(image.src, '/api/public/resources/abc/file?expires=4&signature=v');
  image.removeAttribute('src');
  assert.equal(image.src, undefined);
  assert.equal(image.__attrs.src, undefined);
});

// 宿主给第三方 APP 的 iframe 没有 allow-downloads，页面里的 <a download> / blob: 点击
// 会被沙箱静默拦掉，用户看到的是"点了没反应"。下载因此必须交给宿主 file.export。
function downloadEnv(options = {}) {
  const dom = mediaDom();
  const clicks = [], nativeCalls = [], bridgeCalls = [];
  const document = {
    addEventListener(type, listener) { if (type === 'click') clicks.push(listener); },
    createElement() { throw new Error('沙箱内不应再自己构造下载锚点'); }
  };
  const settings = {
    nativeFetch: async (input) => {
      nativeCalls.push(String(input));
      if (String(input).indexOf('/api/public/resources/') >= 0) {
        return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'image/png' } });
      }
      return new Response('native');
    },
    ...options
  };
  const env = setup(document, {}, { ...dom, dx: { invoke(action, args) { bridgeCalls.push({ action, args }); return Promise.resolve({ saved: true }); } } }, settings);
  const anchor = {
    getAttribute(name) { return name === 'href' ? '/api/public/resources/abc/file?expires=1&signature=s' : name === 'download' ? '镜头01.png' : null; }
  };
  const events = [];
  const fire = () => clicks.forEach((listener) => listener({ target: { closest: () => anchor }, preventDefault() { events.push('prevented'); } }));
  return { env, clicks: clicks, anchor, nativeCalls, bridgeCalls, events, fire };
}

test('下载交给宿主 file.export，不再依赖被沙箱拦掉的 blob 点击', async () => {
  const harness = downloadEnv();
  harness.fire();
  await tick(); await tick(); await tick(); await tick();
  const exported = harness.bridgeCalls.filter((call) => call.action === 'file.export');
  assert.equal(exported.length, 1, '必须调用一次宿主 file.export');
  assert.equal(exported[0].args.name, '镜头01.png');
  assert.equal(exported[0].args.mime, 'image/png');
  assert.equal(exported[0].args.destination, 'download');
  assert.equal(Buffer.from(exported[0].args.content, 'base64').toString('hex'), '01020304', '导出字节必须与后端返回一致');
  // 直连取字节，不经 8 MB 限制的 MCP 代理。
  assert.ok(harness.nativeCalls.some((url) => url.indexOf('http://127.0.0.1:1724/api/public/resources/abc/file') === 0));
});

test('宿主拒绝导出时上报诊断并提示，不再静默吞掉', async () => {
  const env = downloadEnv({
    nativeFetch: (input) => Promise.resolve(String(input).indexOf('/api/public/resources/') >= 0
      ? new Response(new Uint8Array([7]), { status: 200, headers: { 'content-type': 'image/png' } })
      : new Response('native'))
  });
  env.env.window.dx.invoke = (action, args) => {
    env.bridgeCalls.push({ action, args });
    if (action === 'file.export') return Promise.reject(new Error('APP 未声明系统文件权限：app.yingce-main.file.write'));
    return Promise.resolve({});
  };
  env.fire();
  await tick(); await tick(); await tick(); await tick();
  const notify = env.bridgeCalls.filter((call) => call.action === 'ui.notify');
  assert.equal(notify.length, 1, '失败必须告知用户，不能只留日志');
  assert.match(String(notify[0].args.message), /file\.write|重新安装/);
  const diag = env.bridgeCalls.filter((call) => call.action === 'mcp.call' && call.args && call.args.args && call.args.args.path === '/api/__dxos/diag');
  assert.ok(diag.length >= 1, '失败必须写进连接器诊断日志');
  assert.match(String(diag.at(-1).args.args.body), /download-error/);
});

test('页面自建 blob 的下载锚点同样交给宿主导出', async () => {
  const dom = mediaDom();
  const clicks = [];
  const created = [];
  const document = {
    addEventListener(type, listener) { if (type === 'click') clicks.push(listener); },
    createElement(tag) { created.push(tag); return { click() {}, remove() {} }; },
    body: { appendChild() {} }
  };
  const bridgeCalls = [];
  const env = setup(document, {}, { ...dom, dx: {
    invoke(action, args) { bridgeCalls.push({ action, args }); return Promise.resolve({ saved: true }); }
  } });
  const blob = new Blob([new Uint8Array([5, 6])], { type: 'video/mp4' });
  // setup 把 Node 的 URL 原样注入 vm 上下文，适配层的包装作用在同一个对象上。
  const objectUrl = URL.createObjectURL(blob);
  // 预览用的 object URL 没有 download 属性，不能被当成导出。
  const preview = { getAttribute: (name) => (name === 'href' ? objectUrl : null), hasAttribute: () => false };
  clicks.forEach((listener) => listener({ target: { closest: () => preview }, preventDefault() {} }));
  await tick();
  assert.equal(bridgeCalls.filter((call) => call.action === 'file.export').length, 0, '预览不该触发导出');
  const anchor = { getAttribute: (name) => (name === 'href' ? objectUrl : name === 'download' ? '时间线.mp4' : null), hasAttribute: (name) => name === 'download' };
  clicks.forEach((listener) => listener({ target: { closest: () => anchor }, preventDefault() {} }));
  await tick(); await tick(); await tick();
  const exported = bridgeCalls.filter((call) => call.action === 'file.export');
  assert.equal(exported.length, 1);
  assert.equal(exported[0].args.name, '时间线.mp4');
  assert.equal(Buffer.from(exported[0].args.content, 'base64').toString('hex'), '0506');
});

test('沙箱 iframe 里没有 window.dx 时，下载仍经 postMessage 桥交给宿主 file.export', async () => {
  const dom = mediaDom();
  const clicks = [];
  const document = { addEventListener(type, listener) { if (type === 'click') clicks.push(listener); } };
  const env = setup(document, {}, dom);
  // 宿主在 developer.runtime.ready 之后主动下发 system.context；沙箱里没有 window.dx。
  env.respond({ dxos: 'v1', type: 'system.context', context: { locale: 'zh-CN' } });
  let prevented = false;
  const anchor = {
    getAttribute(name) { return name === 'href' ? '/api/public/resources/abc/file?expires=1&signature=s' : null; }
  };
  clicks.forEach((listener) => listener({ target: { closest: () => anchor }, preventDefault() { prevented = true; } }));
  await tick(); await tick(); await tick();
  assert.equal(prevented, true, 'DXOS 宿主里必须接管下载');
  const exported = env.sent.filter((message) => message && message.action === 'file.export');
  assert.equal(exported.length, 1, '必须通过 postMessage 桥调用 file.export');
  assert.equal(exported[0].permission, 'app.yingce-main.file.write');
  assert.equal(exported[0].destination, 'download');
});

test('非 DXOS 环境不拦截下载锚点，交回浏览器处理', async () => {
  const dom = mediaDom();
  const clicks = [];
  const document = { addEventListener(type, listener) { if (type === 'click') clicks.push(listener); } };
  setup(document, {}, dom);
  let prevented = false;
  const anchor = {
    getAttribute(name) { return name === 'href' ? '/api/public/resources/abc/file?expires=1&signature=s' : null; }
  };
  clicks.forEach((listener) => listener({ target: { closest: () => anchor } }, { preventDefault() { prevented = true; } }));
  await tick();
  assert.equal(prevented, false, '没有宿主桥时必须让浏览器自己处理下载');
});
