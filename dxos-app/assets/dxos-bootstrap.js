/* DX OS bridge for the in-process Yingce frontend.
 * The page never opens an external window and never fetches localhost directly.
 * JSON API calls are delegated to the bundled MCP, which owns the local-backend
 * cookie jar on the DX OS host.
 */
(function () {
  'use strict';
  var nativeBridge = window.dx && typeof window.dx.invoke === 'function' ? window.dx : null;
  var serverId = 'yingce-local';
  var permission = 'app.yingce-main.yingce.request';
  var nativeFetch = window.fetch.bind(window);
  var nativeXHR = window.XMLHttpRequest;
  var pending = Object.create(null);
  var requestSequence = 0;
  function invokeViaPostMessage(action, args) {
    var id = 'dxos-' + Date.now().toString(36) + '-' + (++requestSequence).toString(36);
    var timeoutMs = Number(args && args.bridgeTimeoutMs) || 30000;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        delete pending[id];
        reject(new Error('DX OS bridge timeout: ' + action));
      }, Math.min(Math.max(timeoutMs, 1), 3600000));
      pending[id] = { resolve: resolve, reject: reject, timer: timer };
      window.parent.postMessage(Object.assign({}, args || {}, { dxos: 'v1', type: 'request', id: id, action: action }), '*');
    });
  }
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var message = event.data;
    if (message && message.dxos === 'v1' && message.type === 'system.context') hostContextSeen = true;
    if (!message || message.dxos !== 'v1' || typeof message.ok !== 'boolean' || !message.id || !pending[message.id]) return;
    var item = pending[message.id];
    delete pending[message.id];
    clearTimeout(item.timer);
    if (message.ok === false || message.error) item.reject(new Error(String(message.error && (message.error.message || message.error) || 'DX OS bridge request failed')));
    else item.resolve(message.result);
  });
  var bridge = nativeBridge || { invoke: invokeViaPostMessage };
  // 只有真正运行在 DX OS 宿主里时才接管下载。普通浏览器里 postMessage 桥也会
  // 存在，但它背后没有宿主 file.export，拦截锚点反而会把能正常下载的页面弄坏。
  // 宿主在 developer.runtime.ready 后会主动下发 system.context；沙箱 iframe 里
  // 没有 window.dx（缺 allow-same-origin），所以不能拿它当判据。
  var hostContextSeen = Boolean(nativeBridge);
  function memoryStorage() {
    var values = Object.create(null);
    return {
      get length() { return Object.keys(values).length; },
      key: function (index) { return Object.keys(values)[index] || null; },
      getItem: function (key) { return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null; },
      setItem: function (key, value) { values[String(key)] = String(value); },
      removeItem: function (key) { delete values[String(key)]; },
      clear: function () { values = Object.create(null); }
    };
  }
  function ensureStorage(name) {
    try { void window[name].getItem('__dxos_probe__'); return; } catch (_) {}
    try { Object.defineProperty(window, name, { value: memoryStorage(), configurable: true }); } catch (_) {}
  }
  ensureStorage('localStorage');
  ensureStorage('sessionStorage');
  // Web Locks are denied in opaque sandbox frames: LockManager exists but
  // request() throws SecurityError. The app treats a non-null navigator.locks
  // as usable, so replace it with an in-process mutex only when the native
  // implementation is blocked. Real browsers keep native Web Locks.
  function memoryLocks() {
    var queues = Object.create(null);
    function noop() {}
    function request(name, optionsOrCallback, maybeCallback) {
      var callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
      if (typeof callback !== 'function') return Promise.reject(new TypeError('Web Locks shim requires a callback'));
      var prior = queues[name] || Promise.resolve();
      var run = prior.then(function () { return callback(); });
      var tail = run.then(noop, noop);
      queues[name] = tail;
      tail.then(function () { if (queues[name] === tail) delete queues[name]; });
      return run;
    }
    return {
      request: request,
      query: function () { return Promise.resolve({ held: [], pending: [] }); }
    };
  }
  (function ensureLocks() {
    // LockManager is promise-returning: in an opaque sandbox frame request()
    // may reject instead of throwing synchronously, so a try/catch probe is
    // not enough. Install the in-process mutex first and only hand the native
    // implementation back once a probe proves it actually settles.
    var nativeLocks = null;
    try { nativeLocks = navigator.locks || null; } catch (_) { nativeLocks = null; }
    function apply(value) {
      try { Object.defineProperty(navigator, 'locks', { value: value, configurable: true }); } catch (_) {}
      var applied = false;
      try { applied = navigator.locks === value; } catch (_) { applied = false; }
      if (applied) return;
      try { Object.defineProperty(Object.getPrototypeOf(navigator), 'locks', { value: value, configurable: true }); } catch (_) {}
    }
    var shim = memoryLocks();
    apply(shim);
    if (!nativeLocks || typeof nativeLocks.request !== 'function') return;
    var probe;
    try { probe = nativeLocks.request('__dxos_probe__', function () { return Promise.resolve(); }); }
    catch (_) { return; }
    if (!probe || typeof probe.then !== 'function') return;
    probe.then(function () { apply(nativeLocks); }, function () {});
  })();
  // Axios probes document.cookie for XSRF before sending an XHR. Opaque
  // sandbox documents throw here; authentication cookies belong to the MCP.
  // Only replace the blocked accessor, never a working browser cookie jar.
  try { void document.cookie; } catch (error) {
    if (error && error.name === 'SecurityError') {
      Object.defineProperty(document, 'cookie', {
        configurable: true,
        get: function () { return ''; },
        set: function () {}
      });
    } else { throw error; }
  }
  function localPath(url) {
    var value = String(url || '');
    if (value.startsWith('/api/') && !value.startsWith('/api/developer-runtime/')) return value;
    // Relative assets live below DX OS's own /api/developer-runtime/ route.
    // They must never be mistaken for requests to the Yingce backend.
    return '';
  }
  function headersObject(headers) {
    var out = {};
    if (!headers) return out;
    if (typeof headers.forEach === 'function') headers.forEach(function (value, key) { out[key] = value; });
    else Object.keys(headers).forEach(function (key) { out[key] = headers[key]; });
    return out;
  }
  function responseFrom(payload) {
    var status = Number(payload && payload.status) || 500;
    var headers = payload && payload.headers || { 'content-type': 'application/json' };
    // 204/205/304 是无正文状态：带 body 构造 Response 会抛
    // “Response with null body status cannot have body”。画布项目用
    // If-None-Match 轮询，后端回 304，整条桥必须能把这个状态原样交给 axios。
    if (status === 204 || status === 205 || status === 304) return new Response(null, { status: status, headers: headers });
    var body = payload && typeof payload.body === 'string' ? payload.body : JSON.stringify(payload && payload.body == null ? {} : payload.body);
    // 连接器对非 JSON 响应（SSE 事件流、文件下载等）按 base64 过桥。
    // 之前直接把 base64 字符串塞进 Response，Agent 事件流在前端解析不出任何
    // 事件，面板就永远停在“正在连接并校准运行状态”。
    if (payload && payload.encoding === 'base64' && typeof body === 'string' && typeof atob === 'function') {
      try {
        var binary = atob(body);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        body = bytes;
      } catch (error) { /* 解码失败时保留原文，至少不把 200 变成 500。 */ }
    }
    return new Response(body, { status: status, headers: headers });
  }
  function unwrapBridgeResult(result) {
    // DX OS versions return MCP tool output in slightly different envelopes:
    // direct text, MCP content blocks, or {result:{content:[...]}}. Keep the
    // adapter tolerant so a host upgrade does not turn every API call into 500.
    var value = result;
    if (value && value.result !== undefined) value = value.result;
    if (value && Array.isArray(value.content)) {
      var block = value.content.find(function (item) { return item && item.type === 'text'; });
      if (block) value = block.text;
    }
    if (value && typeof value.text === 'string') value = value.text;
    if (typeof value === 'string') {
      try { return JSON.parse(value); } catch (_) { return { status: 502, body: value, headers: { 'content-type': 'text/plain' } }; }
    }
    return value && typeof value === 'object' ? value : { status: 502, body: 'DX OS MCP returned an empty response', headers: { 'content-type': 'text/plain' } };
  }
  // ── 连接器后端地址与上传令牌 ─────────────────────────────────────────
  // 这些状态同时被 fetch/XHR 桥（上方）和媒体直连（下方）使用，所以必须定义在
  // 顶层作用域：严格模式下函数声明在块里是块级作用域，写在 if (bridge) {} 内部
  // 会让 uploadThroughProxy / DxosXHR 拿不到 probeBackendOrigin 和 uploadToken。
  var BACKEND_PORT_BASE = __YINGCE_BACKEND_PORT__;
  var BACKEND_PORT_SPAN = 20;
  var backendOrigin = '';
  var backendProbe = null;
  var uploadToken = '';
  var cssRewriteFlusher = null;
  function probeBackendOrigin() {
    if (backendOrigin) return Promise.resolve(backendOrigin);
    if (backendProbe) return backendProbe;
    // 首选连接器给出的权威地址：后端可能是被接管的孤儿进程，端口不一定在固定段里。
    function fromConnector() {
      return window.fetch('/api/__dxos/backend-origin', { cache: 'no-store' }).then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      }).then(function (payload) {
        var origin = String((payload && payload.origin) || '').replace(/\/+$/, '');
        if (!origin) throw new Error('连接器没有返回后端地址');
        uploadToken = String((payload && payload.uploadToken) || '');
        return origin;
      });
    }
    // 连接器版本较旧时回落到固定端口段探测；no-cors 只判断端口是否活着。
    function fromPortRange() {
      var offset = 0;
      function attempt() {
        if (offset >= BACKEND_PORT_SPAN) return Promise.resolve('');
        var origin = 'http://127.0.0.1:' + (BACKEND_PORT_BASE + offset++);
        return nativeFetch(origin + '/api/health/ready', { mode: 'no-cors', cache: 'no-store' }).then(function () { return origin; }, attempt);
      }
      return attempt();
    }
    backendProbe = fromConnector().catch(fromPortRange).then(function (origin) {
      backendOrigin = origin;
      if (cssRewriteFlusher) cssRewriteFlusher();
      return origin;
    });
    return backendProbe;
  }
  // 连接器重启会让上传令牌、媒体代理端口一起变化，而已打开的页面只探测过一次。
  // 媒体加载和写请求都要在失败时作废缓存重探一次，所以重探逻辑放在顶层共用。
  var backendReprobe = null;
  function reprobeBackendOrigin() {
    // 同一批请求会一起失败，重新探测只发一次，其余等同一个 Promise。
    if (backendReprobe) return backendReprobe;
    backendOrigin = '';
    backendProbe = null;
    backendReprobe = probeBackendOrigin().then(function (origin) {
      backendReprobe = null;
      return origin;
    }, function () {
      backendReprobe = null;
      return '';
    });
    return backendReprobe;
  }
  // 令牌过期时连接器回的是纯文本 403「上传令牌无效」，不是后端的 JSON 信封；
  // 后端的真实 403 会带 code/msg，必须区分开，否则会把权限错误误判成令牌过期。
  var STALE_UPLOAD_TOKEN_MARK = '上传令牌无效';
  function isStaleUploadTokenBody(text) {
    return String(text || '').indexOf(STALE_UPLOAD_TOKEN_MARK) >= 0;
  }
  function staleUploadTokenResponse(response) {
    if (!response || response.status !== 403) return Promise.resolve(false);
    var type = String((response.headers && response.headers.get && response.headers.get('content-type')) || '');
    if (type.indexOf('text/plain') === -1) return Promise.resolve(false);
    return response.clone().text().then(isStaleUploadTokenBody, function () { return false; });
  }
  function isBinaryBody(body) {
    return Boolean(body) && (body instanceof FormData || body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body));
  }
  // 宿主 /api/mcp/call-direct 的 JSON body 上限是 4 MB，base64 过桥传不动图片和视频分片。
  // 改为把原始字节直接 POST 到连接器的上传端点，由连接器补上会话 Cookie 再转发给后端，
  // 这样 FormData（浏览器自己生成 multipart boundary）和裸二进制 PUT 都能原样通过。
  function uploadEndpointURL(targetPath, method) {
    return backendOrigin + '/__dxos/upload?token=' + encodeURIComponent(uploadToken)
      + '&method=' + encodeURIComponent(method) + '&path=' + encodeURIComponent(targetPath);
  }
  function forwardedHeaders(headers, body) {
    var forwarded = {};
    Object.keys(headers || {}).forEach(function (name) {
      var lower = String(name).toLowerCase();
      if (lower === 'host' || lower === 'cookie' || lower === 'origin' || lower === 'referer' || lower === 'content-length') return;
      // FormData 的 multipart boundary 必须交给浏览器生成，手动设置 content-type 会破坏请求体。
      if (lower === 'content-type' && body instanceof FormData) return;
      forwarded[name] = headers[name];
    });
    return forwarded;
  }
  // 直连通道：连接器在本机开的 HTTP 代理（读请求走媒体端点，写请求走上传端点）。
  // DX OS 的 MCP 工具调用是「整体缓冲 + 单次 60s 硬超时」，Agent 事件流这种长连接
  // 一定会在 60s 被宿主掐断（MCP error -32001 Request timed out）。所以优先走直连，
  // 只有直连不可用时才回退 MCP。
  function directRequest(targetPath, method, headers, body, signal) {
    return probeBackendOrigin().then(function (origin) {
      if (!origin || !uploadToken) return null;
      var forwarded = forwardedHeaders(headers, body);
      // 透传调用方的 AbortSignal：切换画布/关闭面板时前端会 abort，
      // 必须连带断掉这条长连接，否则后端 SSE 会一直挂着。
      var init = { headers: forwarded, credentials: 'omit', cache: 'no-store', signal: signal };
      if (method === 'GET' || method === 'HEAD') {
        init.method = method;
        return nativeFetch(origin + targetPath, init);
      }
      init.method = 'POST';
      init.body = body;
      return nativeFetch(uploadEndpointURL(targetPath, method), init).then(function (response) {
        // ReadableStream 请求体只能消费一次，重放会变成空请求，这类请求不重试。
        if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return response;
        return staleUploadTokenResponse(response).then(function (stale) {
          if (!stale) return response;
          return reprobeBackendOrigin().then(function (next) {
            if (!next) return response;
            return nativeFetch(uploadEndpointURL(targetPath, method), init);
          });
        });
      });
    });
  }
  function uploadThroughProxy(targetPath, method, headers, body, signal) {
    return directRequest(targetPath, method, headers, body, signal).then(function (response) {
      if (!response) throw new Error('影策上传通道未就绪，请重启影策应用后重试');
      return response;
    });
  }
  function mcpRequest(path, method, headers, body) {
    return bridge.invoke('mcp.call', { permission: permission, serverId: serverId, tool: 'request', bridgeTimeoutMs: 65000, args: { method: method, path: path, headers: headers, body: body == null ? null : String(body) } }).then(function (result) {
      return responseFrom(unwrapBridgeResult(result));
    });
  }
  var DIRECT_METHODS = { GET: 1, HEAD: 1, POST: 1, PUT: 1, PATCH: 1, DELETE: 1 };
  function bridgeRequest(input, init) {
    if (!bridge) return null;
    var rawUrl = typeof input === 'string' ? input : input && input.url;
    var path = localPath(rawUrl);
    if (!path.startsWith('/api/')) return null;
    var options = init || {};
    var method = String(options.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    var headers = headersObject(options.headers || (typeof input === 'object' && input.headers));
    var body = options.body;
    // 连接器自有路由（后端地址、诊断上报）只存在于 MCP 工具里，直连端点没有这两条。
    if (path.indexOf('/api/__dxos/') === 0) return mcpRequest(path, method, headers, body);
    if (body instanceof URLSearchParams) body = body.toString();
    // 直连端点只认这几种方法（读走媒体端点、写走上传端点），其余一律交回 MCP。
    if (!DIRECT_METHODS[method]) return mcpRequest(path, method, headers, body);
    var payload = body == null || isBinaryBody(body) ? body : String(body);
    return directRequest(path, method, headers, payload, options.signal).then(function (response) {
      return response || mcpRequest(path, method, headers, payload);
    }, function (error) {
      // 调用方主动 abort 时不要再回退 MCP，否则取消会变成一次真实请求。
      if (error && (error.name === 'AbortError' || options.signal && options.signal.aborted)) throw error;
      return mcpRequest(path, method, headers, payload);
    });
  }
  if (bridge) {
    window.fetch = function (input, init) {
      var bridged = bridgeRequest(input, init);
      if (bridged) return bridged;
      // 构建产物把静态数据写成站点根绝对路径（例如 fetch('/inspirations/manifest.json')）。
      // 这类地址既不进桥、也不带 token，直接落到宿主根路径会被 SPA 回退成 index.html，
      // 前端解析 JSON 失败。这里补回 runtime 前缀，让它请求应用自己的目录。
      var rewritten = appStaticRequest(input);
      return rewritten ? nativeFetch(rewritten, init) : nativeFetch(input, init);
    };
    function DxosXHR() {
      this.headers = {}; this.responseHeaders = {}; this.readyState = 0; this.status = 0; this.responseText = ''; this.response = ''; this.responseType = '';
      this.onreadystatechange = null; this.onload = null; this.onerror = null; this.onloadend = null; this.onabort = null;
      // axios 依赖 xhr.upload 才能报上传进度；桥内上传没有真实进度，这里保持空实现。
      this.upload = {
        onprogress: null, onload: null, onerror: null,
        addEventListener: function (type, listener) {
          if (type === 'progress') this.onprogress = listener;
          else if (type === 'load') this.onload = listener;
          else if (type === 'error') this.onerror = listener;
        },
        removeEventListener: function () {}
      };
    }
    DxosXHR.prototype.open = function (method, url) { this.method = String(method || 'GET').toUpperCase(); this.url = url; this.readyState = 1; if (this.onreadystatechange) this.onreadystatechange(); };
    DxosXHR.prototype.setRequestHeader = function (name, value) { this.headers[name] = String(value); };
    DxosXHR.prototype.getAllResponseHeaders = function () { var headers = this.responseHeaders; return Object.keys(headers).map(function (key) { return key + ': ' + headers[key]; }).join('\r\n'); };
    DxosXHR.prototype.getResponseHeader = function (name) { return this.responseHeaders[String(name).toLowerCase()] || null; };
    DxosXHR.prototype.send = function (body) {
      var self = this;
      if (isBinaryBody(body) && localPath(this.url).startsWith('/api/')) {
        var uploadPath = localPath(this.url);
        // 令牌过期时连接器在读取请求体之前就回 403，字节没有真正上传，因此可以安全重放。
        var retried = false;
        var attemptUpload = function (origin) {
          var xhr = self.native = new nativeXHR();
          var stale = false;
          xhr.open('POST', uploadEndpointURL(uploadPath, self.method));
          xhr.responseType = self.responseType;
          Object.keys(self.headers).forEach(function (name) {
            if (String(name).toLowerCase() === 'content-type' && body instanceof FormData) return;
            try { xhr.setRequestHeader(name, self.headers[name]); } catch (_) { /* 非法头名忽略 */ }
          });
          var forward = function (event, name) {
            self.readyState = xhr.readyState; self.status = xhr.status; self.response = xhr.response;
            if (!xhr.responseType || xhr.responseType === 'text') self.responseText = xhr.responseText;
            if (self['on' + name]) self['on' + name](event);
          };
          ['readystatechange', 'load', 'error', 'loadend', 'abort', 'timeout'].forEach(function (name) {
            xhr['on' + name] = function (event) {
              // 本次尝试已判定为令牌过期：压住这只 xhr 的后续事件，只让重放结果到达调用方。
              if (stale) return;
              var isText = !xhr.responseType || xhr.responseType === 'text';
              if (!retried && xhr.readyState === 4 && xhr.status === 403 && isText && isStaleUploadTokenBody(xhr.responseText)) {
                stale = true;
                retried = true;
                reprobeBackendOrigin().then(function (next) {
                  if (next) { attemptUpload(next); return; }
                  stale = false;
                  forward(event, name);
                }, function () { stale = false; forward(event, name); });
                return;
              }
              forward(event, name);
            };
          });
          self.getAllResponseHeaders = xhr.getAllResponseHeaders.bind(xhr);
          self.getResponseHeader = xhr.getResponseHeader.bind(xhr);
          if (xhr.upload) {
            xhr.upload.onprogress = function (event) { if (self.upload.onprogress) self.upload.onprogress(event); };
            xhr.upload.onload = function (event) { if (self.upload.onload) self.upload.onload(event); };
          }
          xhr.send(body);
        };
        probeBackendOrigin().then(function (origin) {
          if (!origin || !uploadToken) throw new Error('影策上传通道未就绪，请重启影策应用后重试');
          attemptUpload(origin);
        }).catch(function (error) {
          self.status = 0; self.readyState = 4;
          if (self.onreadystatechange) self.onreadystatechange();
          if (self.onerror) self.onerror(error);
          if (self.onloadend) self.onloadend();
        });
        return;
      }
      var request = bridgeRequest(this.url, { method: this.method, headers: this.headers, body: body });
      if (!request) {
        var xhr = this.native = new nativeXHR();
        xhr.open(this.method, appStaticRequestURL(this.url) || this.url);
        xhr.responseType = this.responseType;
        Object.keys(this.headers).forEach(function (name) { xhr.setRequestHeader(name, self.headers[name]); });
        ['readystatechange', 'load', 'error', 'loadend', 'abort', 'timeout'].forEach(function (name) {
          xhr['on' + name] = function (event) {
            self.readyState = xhr.readyState; self.status = xhr.status; self.response = xhr.response;
            if (!xhr.responseType || xhr.responseType === 'text') self.responseText = xhr.responseText;
            if (self['on' + name]) self['on' + name](event);
          };
        });
        self.getAllResponseHeaders = xhr.getAllResponseHeaders.bind(xhr);
        self.getResponseHeader = xhr.getResponseHeader.bind(xhr);
        xhr.send(body); return;
      }
      request.then(function (response) { self.status = response.status; self.responseHeaders = {}; response.headers.forEach(function (value, key) { self.responseHeaders[key] = value; }); return response.text(); }).then(function (text) {
        self.responseText = text; self.response = self.responseType === 'json' ? JSON.parse(text) : text; self.readyState = 4; if (self.onreadystatechange) self.onreadystatechange(); if (self.onload) self.onload(); if (self.onloadend) self.onloadend();
      }).catch(function (error) { self.status = 0; self.readyState = 4; if (self.onreadystatechange) self.onreadystatechange(); if (self.onerror) self.onerror(error); if (self.onloadend) self.onloadend(); });
    };
    DxosXHR.prototype.abort = function () { if (this.native) return this.native.abort(); this.readyState = 0; if (this.onabort) this.onabort(); };
    window.XMLHttpRequest = DxosXHR; window.__DXOS_EMBEDDED__ = true;

    // ── 媒体直连 ───────────────────────────────────────────────────────
    // fetch/XHR 走 MCP 桥，但浏览器原生加载的 <img>/<video>/<audio>/<source>
    // 不走 fetch：相对 /api/... 会落到 DX OS 宿主源，宿主没有这条路由，返回 404，
    // 于是"图生成了却显示不出来"。包内后端就在本机固定端口段上，资源地址自带
    // 签名不需要 Cookie，所以把这类地址改写成直连后端的绝对地址。
    var logicalValues = new WeakMap();
    function setLogical(element, key, value) {
      var store = logicalValues.get(element);
      if (!store) { store = Object.create(null); logicalValues.set(element, store); }
      if (value === undefined) delete store[key]; else store[key] = value;
      return store;
    }
    function getLogical(element, key) {
      var store = logicalValues.get(element);
      return store ? store[key] : undefined;
    }
    function backendMediaPath(value) {
      var text = String(value == null ? '' : value);
      if (!text || text.indexOf('blob:') === 0 || text.indexOf('data:') === 0) return '';
      var parsed;
      try { parsed = new URL(text, location.href); } catch (_) { return ''; }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      if (parsed.pathname.indexOf('/api/') !== 0) return '';
      // 应用自身的静态资源挂在宿主的 /api/developer-runtime/ 下，不能改写。
      if (parsed.pathname.indexOf('/api/developer-runtime/') === 0) return '';
      var local = text.indexOf('/api/') === 0
        || parsed.host === location.host
        || parsed.hostname === '127.0.0.1'
        || parsed.hostname === 'localhost';
      return local ? parsed.pathname + parsed.search : '';
    }
    // 应用自身挂在 /api/developer-runtime/<token>/ 下，但构建产物按“站点根目录”写地址，
    // 于是 /short-drama-styles/x.jpg 会落到宿主源 404（页面里的灵感图、风格图全空）。
    // 这里把根绝对路径改成相对路径，让它按文档 base 解析回应用自己的目录；顺带补回
    // new URL('../../x', import.meta.url) 这类计算丢掉的那一段 runtime 前缀。
    var appRuntimePrefix = (function () {
      var match = /^\/api\/developer-runtime\/[^/]+\//.exec(String(location.pathname || ''));
      return match ? match[0] : '';
    })();
    // 根绝对路径的静态数据（/inspirations/*.json 等）必须补回 runtime 前缀，
    // 否则请求打到宿主根路径、被 SPA 回退成 index.html，JSON.parse 直接失败。
    // 只处理同源、非 /api（后端接口走桥、媒体走直连）且尚未带前缀的地址。
    function appStaticRequestURL(value) {
      if (!appRuntimePrefix) return '';
      var text = String(value == null ? '' : value);
      if (!text || text.charAt(0) === '#') return '';
      var parsed;
      try { parsed = new URL(text, location.href); } catch (_) { return ''; }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      if (location.host && parsed.host !== location.host) return '';
      var path = parsed.pathname;
      if (path.charAt(0) !== '/') return '';
      if (path.indexOf('/api/') === 0) return '';
      if (path.indexOf(appRuntimePrefix) === 0) return '';
      return appRuntimePrefix + path.slice(1) + parsed.search;
    }
    function appStaticRequest(input) {
      if (typeof input === 'string' || input instanceof URL) {
        return appStaticRequestURL(input);
      }
      if (typeof Request === 'function' && input instanceof Request) {
        var rewritten = appStaticRequestURL(input.url);
        if (!rewritten) return '';
        try { return new Request(rewritten, input); } catch (_) { return ''; }
      }
      return '';
    }
    function appStaticValue(value) {
      if (!appRuntimePrefix) return '';
      var runtimeMarker = '/api/developer-runtime/';
      var text = String(value == null ? '' : value);
      if (text.charAt(0) === '/') {
        if (text.charAt(1) === '/') return '';
        if (text.indexOf(runtimeMarker) === 0) {
          if (text.indexOf(appRuntimePrefix) === 0) return '';
          return appRuntimePrefix + text.slice(runtimeMarker.length);
        }
        if (text.indexOf('/api/') === 0) return '';
        return text.slice(1);
      }
      // new URL('../../welcome/x.webp', import.meta.url) 会解析成同源绝对地址，
      // 同时把 /api/developer-runtime/<token>/ 这一段算掉，这里补回去。
      var parsed;
      try { parsed = new URL(text, location.href); } catch (_) { return ''; }
      if (parsed.host !== location.host) return '';
      if (parsed.pathname.indexOf(runtimeMarker) !== 0) return '';
      if (parsed.pathname.indexOf(appRuntimePrefix) === 0) return '';
      return parsed.origin + appRuntimePrefix + parsed.pathname.slice(runtimeMarker.length) + parsed.search + parsed.hash;
    }
    function applyMediaURL(element, key, value, assign) {
      var path = backendMediaPath(value);
      if (!path) {
        var fixed = appStaticValue(value);
        setLogical(element, key, fixed ? value : undefined);
        assign(fixed || value);
        return;
      }
      setLogical(element, key, value);
      if (backendOrigin) { assign(backendOrigin + path); return; }
      probeBackendOrigin().then(function (origin) {
        // 探测期间组件可能已经换了地址，过期的回调不能再覆盖。
        if (getLogical(element, key) !== value) return;
        assign(origin ? origin + path : value);
      });
    }
    function installMediaProperty(proto, prop) {
      if (!proto) return;
      var descriptor = Object.getOwnPropertyDescriptor(proto, prop);
      if (!descriptor || typeof descriptor.set !== 'function' || typeof descriptor.get !== 'function') return;
      var nativeGet = descriptor.get;
      var nativeSet = descriptor.set;
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: function () {
          var logical = getLogical(this, prop);
          return logical === undefined ? nativeGet.call(this) : logical;
        },
        set: function (value) {
          var element = this;
          var text = String(value == null ? '' : value);
          if (backendOrigin && text.indexOf(backendOrigin + '/api/') === 0) { nativeSet.call(element, value); return; }
          applyMediaURL(element, prop, value, function (next) { nativeSet.call(element, next); });
        }
      });
    }
    installMediaProperty(window.HTMLImageElement && window.HTMLImageElement.prototype, 'src');
    installMediaProperty(window.HTMLMediaElement && window.HTMLMediaElement.prototype, 'src');
    installMediaProperty(window.HTMLSourceElement && window.HTMLSourceElement.prototype, 'src');
    installMediaProperty(window.HTMLVideoElement && window.HTMLVideoElement.prototype, 'poster');
    // React 对部分属性走 setAttribute 而不是属性赋值，两条路径都要覆盖。
    var nativeSetAttribute = window.Element && window.Element.prototype && window.Element.prototype.setAttribute;
    if (nativeSetAttribute) {
      window.Element.prototype.setAttribute = function (name, value) {
        var key = String(name || '').toLowerCase();
        if (key !== 'src' && key !== 'poster') return nativeSetAttribute.call(this, name, value);
        var element = this;
        var text = String(value == null ? '' : value);
        if (backendOrigin && text.indexOf(backendOrigin + '/api/') === 0) return nativeSetAttribute.call(element, name, value);
        var path = backendMediaPath(text);
        if (!path) {
          var fixed = appStaticValue(text);
          if (!fixed) return nativeSetAttribute.call(element, name, value);
          setLogical(element, key, text);
          return nativeSetAttribute.call(element, name, fixed);
        }
        setLogical(element, key, text);
        if (backendOrigin) return nativeSetAttribute.call(element, name, backendOrigin + path);
        probeBackendOrigin().then(function (origin) {
          if (getLogical(element, key) !== text) return;
          nativeSetAttribute.call(element, name, origin ? origin + path : text);
        });
        return undefined;
      };
    }
    var nativeRemoveAttribute = window.Element && window.Element.prototype && window.Element.prototype.removeAttribute;
    if (nativeRemoveAttribute) {
      window.Element.prototype.removeAttribute = function (name) {
        var key = String(name || '').toLowerCase();
        if (key === 'src' || key === 'poster') setLogical(this, key, undefined);
        return nativeRemoveAttribute.call(this, name);
      };
    }
    // 内联样式里拼出来的 background-image 也由浏览器原生解析，同样会落到宿主源。
    // 远端样式表在 opaque origin 下读不到 CSSOM，但 style 属性是我们能拦住的。
    var CSS_URL_PROPERTIES = ['background', 'backgroundImage', 'borderImage', 'borderImageSource', 'listStyleImage', 'maskImage', 'webkitMaskImage'];
    var pendingCSSRewrites = [];
    var CSS_URL_PATTERN = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
    function rewriteCSSURLs(value) {
      var text = String(value == null ? '' : value);
      if (text.indexOf('url(') === -1) return text;
      return text.replace(CSS_URL_PATTERN, function (match, quote, raw) {
        var path = backendMediaPath(raw);
        if (path) {
          if (!backendOrigin) return match;
          return 'url(' + quote + backendOrigin + path + quote + ')';
        }
        var fixed = appStaticValue(raw);
        return fixed ? 'url(' + quote + fixed + quote + ')' : match;
      });
    }
    function hasRewritableCSSURL(value) {
      var text = String(value == null ? '' : value);
      if (text.indexOf('url(') === -1) return false;
      var found = false;
      text.replace(CSS_URL_PATTERN, function (match, quote, raw) {
        if (backendMediaPath(raw)) found = true;
        return match;
      });
      return found;
    }
    // 静态资源改写不需要等后端地址，单独判断，避免把这类值塞进待探测队列。
    function hasAppStaticCSSURL(value) {
      var text = String(value == null ? '' : value);
      if (text.indexOf('url(') === -1) return false;
      var found = false;
      text.replace(CSS_URL_PATTERN, function (match, quote, raw) {
        if (appStaticValue(raw)) found = true;
        return match;
      });
      return found;
    }
    function flushPendingCSSRewrites() {
      var queue = pendingCSSRewrites;
      pendingCSSRewrites = [];
      for (var index = 0; index < queue.length; index += 1) {
        try { queue[index].assign(rewriteCSSURLs(queue[index].value)) } catch (_) {}
      }
    }
    // 顶层 probeBackendOrigin 探测到后端地址后需要把待改写的 CSS 队列刷掉。
    cssRewriteFlusher = flushPendingCSSRewrites;
    function installCSSProperty(prop) {
      var proto = window.CSSStyleDeclaration && window.CSSStyleDeclaration.prototype;
      if (!proto) return;
      var descriptor = Object.getOwnPropertyDescriptor(proto, prop);
      if (!descriptor || typeof descriptor.set !== 'function' || typeof descriptor.get !== 'function') return;
      var nativeGet = descriptor.get;
      var nativeSet = descriptor.set;
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: function () {
          var logical = getLogical(this, prop);
          return logical === undefined ? nativeGet.call(this) : logical;
        },
        set: function (value) {
          var declaration = this;
          var text = String(value == null ? '' : value);
          var rewritable = hasRewritableCSSURL(text);
          setLogical(declaration, prop, rewritable || hasAppStaticCSSURL(text) ? text : undefined);
          if (rewritable && !backendOrigin) {
            probeBackendOrigin();
            if (pendingCSSRewrites.length < 400) {
              pendingCSSRewrites.push({ value: text, assign: function (next) { nativeSet.call(declaration, next) } });
            }
          }
          nativeSet.call(declaration, rewriteCSSURLs(text));
        }
      });
    }
    for (var cssIndex = 0; cssIndex < CSS_URL_PROPERTIES.length; cssIndex += 1) installCSSProperty(CSS_URL_PROPERTIES[cssIndex]);
    var nativeSetProperty = window.CSSStyleDeclaration && window.CSSStyleDeclaration.prototype && window.CSSStyleDeclaration.prototype.setProperty;
    if (nativeSetProperty) {
      window.CSSStyleDeclaration.prototype.setProperty = function (name, value, priority) {
        var key = String(name || '').toLowerCase();
        if (CSS_URL_PROPERTIES.indexOf(key) === -1 || !(hasRewritableCSSURL(value) || hasAppStaticCSSURL(value))) return nativeSetProperty.call(this, name, value, priority);
        return nativeSetProperty.call(this, name, rewriteCSSURLs(value), priority);
      };
    }
    // 媒体地址只探测一次，而代理活在连接器进程里：DX OS 重启连接器（重开应用、回收
    // 进程）之后，已经打开的页面仍然记着旧代理地址，图片一旦加载失败浏览器不会再自动
    // 重试，画布就永久空白。这里在失败时作废缓存、重新探测一次，再按新地址重试。
    var mediaRetries = new WeakMap();
    function retryMediaElement(element) {
      var path = backendMediaPath(getLogical(element, 'src'));
      if (!path) return;
      var attempt = mediaRetries.get(element);
      var count = attempt && attempt.path === path ? attempt.count : 0;
      if (count >= 2) return;
      mediaRetries.set(element, { path: path, count: count + 1 });
      reprobeBackendOrigin().then(function (origin) {
        if (!origin) return;
        var target = origin + path;
        // 地址没变就不重设，避免同地址反复触发 error。
        if (String(element.getAttribute('src') || '') === target) return;
        nativeSetAttribute.call(element, 'src', target);
      }).catch(function () { /* 重探失败保持现状，等下一次渲染再试 */ });
    }
    // 浏览器侧看不到的失败都回报给连接器：日志在
    // ~/Library/Application Support/yingce-dxos/logs/dxos-media.log，方便离线定位。
    // 沙箱拦掉下载时页面不会留下任何痕迹，不留这条记录就只能靠猜。
    function reportDiagnostic(payload) {
      if (!bridge) return;
      try {
        bridge.invoke('mcp.call', {
          permission: permission, serverId: serverId, tool: 'request', bridgeTimeoutMs: 20000,
          args: {
            method: 'POST', path: '/api/__dxos/diag', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload)
          }
        }).catch(function () {});
      } catch (_) { /* 诊断失败不影响页面 */ }
    }
    var mediaFailureReports = 0;
    function reportMediaFailure(element) {
      if (mediaFailureReports >= 40) return;
      mediaFailureReports += 1;
      reportDiagnostic({
        kind: 'media-error',
        src: String(element.getAttribute('src') || '').slice(0, 300),
        currentSrc: String(element.currentSrc || '').slice(0, 300),
        logical: String(getLogical(element, 'src') || '').slice(0, 300),
        page: String(location.href).slice(0, 200)
      });
    }
    if (document && typeof document.addEventListener === 'function') {
      document.addEventListener('error', function (event) {
        var target = event && event.target;
        if (!target || String(target.tagName || '').toUpperCase() !== 'IMG') return;
        retryMediaElement(target);
        reportMediaFailure(target);
      }, true);
    }
    // ── 下载 ─────────────────────────────────────────────────────────────
    // <a href download> 同样指向 /api/...，但宿主给第三方 APP 的 iframe 只声明
    // allow-scripts/forms/pointer-lock，没有 allow-downloads：点击（含 blob: 地址）
    // 会被沙箱静默拦掉，页面连一条报错都留不下，表现成"点了没反应"。
    // 因此改为取回字节后交给宿主 file.export，由宿主在拥有下载权限的文档里落盘。
    // 该动作要求清单声明 app.yingce-main.file.write（见 dx-app.json 的 permissions）；
    // 只替换 index.html/JS 不会更新宿主的已安装权限索引，必须提高 version/build 后重装。
    // 宿主自己把「Base64 过桥」的容量定在 24 MB（developerApps 的 app.api 校验），
    // 这里沿用同一上限：更大的文件改走宿主 dx.files.upload 二进制通道，不在本次范围。
    var EXPORT_MAX_BYTES = 24 * 1024 * 1024;
    var EXPORT_CHUNK = 32768;
    var EXPORT_FAILURE_REASON = '影策应用未获授权保存文件，请重新安装最新版本';
    var NOTIFY_PERMISSION = 'app.yingce-main.ui.notify';
    var EXPORT_PERMISSION = 'app.yingce-main.file.write';
    function encodeBase64(bytes) {
      var binary = '';
      for (var offset = 0; offset < bytes.length; offset += EXPORT_CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + EXPORT_CHUNK));
      }
      return btoa(binary);
    }
    function fileNameFromPath(path) {
      var segment = String(path || '').split('?')[0].split('/').pop();
      try { segment = decodeURIComponent(segment); } catch (_) { /* 保留原片段 */ }
      return segment || 'download.bin';
    }
    function notifyDownloadFailure(reason) {
      try {
        bridge.invoke('ui.notify', { permission: NOTIFY_PERMISSION, message: reason }).catch(function () {});
      } catch (_) { /* 通知失败不影响主流程，诊断日志已经有了 */ }
    }
    function downloadNameFor(anchor, path) {
      return anchor.getAttribute('download') || fileNameFromPath(path);
    }
    function fetchDownloadBlob(path) {
      return probeBackendOrigin().then(function (origin) {
        if (!origin) throw new Error('影策媒体通道未就绪，请重启影策应用后重试');
        return nativeFetch(origin + path);
      }).then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.blob();
      });
    }
    var downloadFailureReports = 0;
    function reportDownloadFailure(error) {
      var reason = String(error && error.message ? error.message : error);
      // 权限缺失是自身配置问题，且宿主只回一句笼统文案；单独标出来才好定位。
      var denied = reason.indexOf('file.write') >= 0 || reason.indexOf('文件权限') >= 0;
      if (downloadFailureReports < 20) {
        downloadFailureReports += 1;
        reportDiagnostic({ kind: 'download-error', page: String(location.href).slice(0, 200), reason: reason.slice(0, 300), denied: denied });
      }
      notifyDownloadFailure(denied ? EXPORT_FAILURE_REASON : '下载失败：' + reason);
    }
    // 页面自己造的 blob 下载（编辑器导出等）同样逃不出沙箱。记下 createObjectURL 的
    // 产物，点击这类锚点时按同一通道交给宿主；预览用的 object URL 不带 download 属性，
    // 不会被顺手导出。
    // 注册表挂在 URL 上而不是闭包里：适配层在同一页面可能被执行多次（重载、多份脚本），
    // 各实例的闭包互不可见，挂在闭包里会让后加载的实例查不到先注册的 blob。
    var objectURLBlobs = URL && URL.__dxosObjectURLBlobs;
    if (!objectURLBlobs && typeof Map === 'function') objectURLBlobs = new Map();
    if (URL && objectURLBlobs && typeof URL.createObjectURL === 'function' && !URL.__dxosExportPatched) {
      // 包装只能装一次，否则 createObjectURL 层层套娃，记录也随层数一起堆积。
      try { URL.__dxosObjectURLBlobs = objectURLBlobs; URL.__dxosExportPatched = true; } catch (_) { /* 冻结对象时失去防重入保护 */ }
      var nativeCreateObjectURL = URL.createObjectURL.bind(URL);
      var nativeRevokeObjectURL = typeof URL.revokeObjectURL === 'function' ? URL.revokeObjectURL.bind(URL) : null;
      URL.createObjectURL = function (value) {
        var url = nativeCreateObjectURL(value);
        try {
          if (String(url).indexOf('blob:') === 0 && value instanceof Blob) {
            if (objectURLBlobs.size >= 64) objectURLBlobs.clear();
            objectURLBlobs.set(url, value);
          }
        } catch (_) { /* 记账失败只影响下载，不影响预览 */ }
        return url;
      };
      if (nativeRevokeObjectURL) {
        URL.revokeObjectURL = function (url) {
          objectURLBlobs.delete(String(url));
          return nativeRevokeObjectURL(url);
        };
      }
    }
    function anchorHasDownload(anchor) {
      return anchor.hasAttribute ? anchor.hasAttribute('download') : Boolean(anchor.getAttribute('download'));
    }
    function downloadSource(anchor) {
      var href = String(anchor.getAttribute('href') || '');
      var path = backendMediaPath(href);
      if (path) return { path: path, name: downloadNameFor(anchor, path) };
      var tracked = objectURLBlobs.get(href);
      if (!tracked || !anchorHasDownload(anchor)) return null;
      return { blob: tracked, name: String(anchor.getAttribute('download') || 'download.bin') };
    }
    function runDownload(anchor) {
      var source = downloadSource(anchor);
      if (!source) return false;
      // 沙箱 iframe 里没有 window.dx（缺 allow-same-origin），只能用 postMessage 桥。
      // file.export 与 mcp.call 走同一个 request 通道，宿主只额外校验 permission 与
      // app.<id>.file.write 声明，因此这里不能再用 nativeBridge 作为前提；
      // 但必须确认请求来自 DX OS 宿主，否则会把普通浏览器的下载一起拦掉。
      if (!hostContextSeen) return false;
      (source.blob ? Promise.resolve(source.blob) : fetchDownloadBlob(source.path)).then(function (blob) {
        if (blob.size > EXPORT_MAX_BYTES) throw new Error('文件超过 ' + Math.round(EXPORT_MAX_BYTES / 1048576) + ' MB，请改用浏览器版本下载');
        return blob.arrayBuffer().then(function (buffer) {
          return bridge.invoke('file.export', {
            permission: EXPORT_PERMISSION,
            destination: 'download',
            name: source.name, mime: blob.type || 'application/octet-stream',
            content: encodeBase64(new Uint8Array(buffer)),
            bridgeTimeoutMs: 120000
          });
        });
      }).then(function (result) {
        if (result && result.saved === false && !result.cancelled) throw new Error(EXPORT_FAILURE_REASON);
      }).catch(reportDownloadFailure);
      return true;
    }
    if (document && typeof document.addEventListener === 'function') {
      document.addEventListener('click', function (event) {
        var target = event.target;
        var anchor = target && target.closest ? target.closest('a[href]') : null;
        if (!anchor) return;
        if (!runDownload(anchor)) return;
        event.preventDefault();
      }, true);
    }
  }
  if (bridge) window.parent.postMessage({ dxos: 'v1', type: 'request', id: 'initial-context', action: 'system.getContext', args: {} }, '*');
  void nativeXHR;
})();
