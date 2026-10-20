const i18n = {
  'zh-CN': {
    title: '影策', subtitle: '影视创作工作台', workspace: '工作台', headline: '继续创作',
    description: '在浏览器中打开本机运行的影策工作台。', address: '本地地址',
    open: '打开影策', footer: '由本机影策服务提供内容', source: '源码', opening: '正在打开…',
    failed: '无法打开影策。请确认 DX OS 已授权外部链接，并检查本机服务。'
  },
  'en-US': {
    title: 'Yingce', subtitle: 'Film production workspace', workspace: 'Workspace', headline: 'Continue creating',
    description: 'Open the locally hosted Yingce workspace in your browser.', address: 'Local address',
    open: 'Open Yingce', footer: 'Content is served by your local Yingce instance', source: 'Source', opening: 'Opening…',
    failed: 'Could not open Yingce. Check external-link permission and the local service.'
  }
};
let system = { appearance: 'light', interfaceLocale: 'zh-CN', direction: 'ltr', displayScale: 1 };
let busy = false;
const config = window.YINGCE_DXOS_CONFIG;
const button = document.getElementById('open-button');
const feedback = document.getElementById('feedback');

function renderText() {
  const words = i18n[system.interfaceLocale] || i18n['en-US'];
  document.querySelectorAll('[data-i18n]').forEach((element) => {
    element.textContent = words[element.dataset.i18n];
  });
  button.textContent = words[busy ? 'opening' : 'open'];
  feedback.textContent = feedback.dataset.error === 'true' ? words.failed : '';
}

function applySystemContext(context = {}) {
  system = { ...system, ...context };
  const root = document.documentElement;
  root.dataset.theme = system.appearance === 'dark' ? 'dark' : 'light';
  root.lang = system.interfaceLocale || 'zh-CN';
  root.dir = system.direction || 'ltr';
  root.style.colorScheme = system.appearance === 'dark' ? 'dark' : 'light';
  root.style.setProperty('--dx-display-scale', String(system.displayScale || 1));
  renderText();
}

addEventListener('message', (event) => {
  const message = event.data;
  if (message?.dxos === 'v1' && message.type === 'system.context') applySystemContext(message.context);
  if (message?.dxos === 'v1' && message.id === 'initial-context' && message.ok) applySystemContext(message.result);
});

document.getElementById('address').textContent = config.url;
document.getElementById('version').textContent = 'v' + config.version;
document.getElementById('commit').textContent = config.commit.slice(0, 8);
button.addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  button.disabled = true;
  feedback.dataset.error = 'false';
  renderText();
  try {
    if (!window.dx?.invoke) throw new Error('DX OS bridge unavailable');
    await window.dx.invoke('ui.openExternal', { url: config.url });
  } catch (error) {
    feedback.dataset.error = 'true';
    console.error('Yingce open failed', error);
  } finally {
    busy = false;
    button.disabled = false;
    renderText();
  }
});

applySystemContext();
parent.postMessage({ dxos: 'v1', type: 'request', id: 'initial-context', action: 'system.getContext' }, '*');
