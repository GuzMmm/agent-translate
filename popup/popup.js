// popup.js — 工具栏弹窗：开关、目标语言、翻译本页 / 还原、打开设置
const $ = (id) => document.getElementById(id);

async function init() {
  const stored = await chrome.storage.local.get({ enabled: true, targetLang: DEFAULT_TARGET });
  $('enable').checked = !!stored.enabled;

  const sel = $('targetLang');
  LANGUAGES.forEach(([v, label]) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    sel.appendChild(o);
  });
  sel.value = stored.targetLang;

  bind();
}

function bind() {
  $('enable').addEventListener('change', (e) => {
    chrome.storage.local.set({ enabled: e.target.checked });
  });
  $('targetLang').addEventListener('change', (e) => {
    chrome.storage.local.set({ targetLang: e.target.value });
  });
  $('translatePage').addEventListener('click', () => sendToTab('translatePage'));
  $('restorePage').addEventListener('click', () => sendToTab('restorePage'));
  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('openPdf').addEventListener('click', openPdf);
}

async function openPdf() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab && tab.url;
  const isPdf = url && /\.pdf(\?|#|$)/i.test(url);
  const base = chrome.runtime.getURL('pdfviewer/pdfviewer.html');
  const target = isPdf ? base + '?url=' + encodeURIComponent(url) : base;
  await chrome.tabs.create({ url: target });
  window.close();
}

async function sendToTab(type) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id == null) throw new Error('无活动标签页');
    const r = await chrome.tabs.sendMessage(tab.id, { type });
    if (r && r.ok === false) throw new Error(r.error || '执行失败');
    window.close();
  } catch (e) {
    toast('无法在此页面执行：' + (e.message || e));
  }
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

document.addEventListener('DOMContentLoaded', init);
