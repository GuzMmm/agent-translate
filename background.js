// background.js — Service Worker：配置读取 + API 调用（绕过 CORS）+ 翻译缓存 + 右键菜单

const DEFAULTS = {
  enabled: true,
  targetLang: '简体中文',
  baseUrl: '',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.3,
};

let configCache = null;
const cache = new Map(); // "targetLang::text" -> 译文

// 跟踪每个 tab 的在途请求，页面关闭时中止对应请求
const inFlight = new Map(); // tabId -> Set<AbortController>
function track(tabId, controller) {
  if (tabId == null) return;
  if (!inFlight.has(tabId)) inFlight.set(tabId, new Set());
  inFlight.get(tabId).add(controller);
}
function untrack(tabId, controller) {
  if (tabId == null) return;
  const set = inFlight.get(tabId);
  if (set) { set.delete(controller); if (!set.size) inFlight.delete(tabId); }
}
function abortTab(tabId) {
  const set = inFlight.get(tabId);
  if (set) { for (const c of set) c.abort(); inFlight.delete(tabId); }
}
chrome.tabs.onRemoved.addListener((tabId) => abortTab(tabId));
// 主框架导航离开当前页面时，也中止该 tab 的在途请求
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0) abortTab(details.tabId);
});

async function getConfig() {
  if (!configCache) {
    const s = await chrome.storage.local.get(DEFAULTS);
    configCache = { ...DEFAULTS, ...s };
  }
  return configCache;
}

chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local') configCache = null;
});

// 归一化 Base URL：域名 / 域名/v1 / 完整地址 都能用
function buildUrl(base) {
  const u = (base || '').trim().replace(/\/+$/, '');
  if (!u) throw new Error('请先在设置里填写 API Base URL');
  if (/\/chat\/completions$/i.test(u)) return u;
  if (/\/v\d+$/i.test(u)) return u + '/chat/completions';
  return u + '/v1/chat/completions';
}

function systemPrompt(targetLang) {
  return [
    'You are a professional translation engine.',
    `Translate the following text into ${targetLang}.`,
    'Rules:',
    '- Output ONLY the translation, no explanations, no notes, no surrounding quotes.',
    '- Preserve line breaks, numbers, URLs, code, and placeholders such as {0} or %s exactly.',
    '- The input may contain separator tokens ⟪SEP⟫ and ⟪GRP⟫ marking independent segments.',
    '- Keep every separator token intact, in the same order, and translate each segment independently.',
    '- Auto-detect the source language.',
  ].join('\n');
}

async function requestTranslate(text, config, signal) {
  const url = buildUrl(config.baseUrl);
  const body = {
    model: config.model,
    temperature: config.temperature ?? 0.3,
    messages: [
      { role: 'system', content: systemPrompt(config.targetLang) },
      { role: 'user', content: String(text) },
    ],
  };
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (config.apiKey || ''),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch (_) {}
    throw new Error(`HTTP ${res.status}: ${detail || res.statusText}`);
  }
  const data = await res.json();
  const content =
    data && data.choices && data.choices[0] &&
    data.choices[0].message && data.choices[0].message.content;
  if (!content) throw new Error('API 未返回有效内容');
  return String(content).trim();
}

async function translateWithCache(text, config, signal) {
  const key = `${config.targetLang}::${text}`;
  if (cache.has(key)) return cache.get(key);
  const result = await requestTranslate(text, config, signal);
  cache.set(key, result);
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return result;
}

async function translateBatch(texts, config, signal) {
  const GRP = '⟪GRP⟫';      // 批量分隔符（区别于 content 里的内层 ⟪SEP⟫）
  const CHUNK = 8;         // 每次请求合并的段数
  const CONCURRENCY = 4;   // 并发请求数

  const results = new Array(texts.length);
  const chunks = [];
  for (let i = 0; i < texts.length; i += CHUNK) {
    chunks.push({ start: i, items: texts.slice(i, i + CHUNK) });
  }
  let idx = 0;
  const worker = async () => {
    while (idx < chunks.length) {
      if (signal && signal.aborted) return; // 已取消：停止
      const c = chunks[idx++];
      const joined = c.items.join(GRP);
      try {
        const out = await requestTranslate(joined, config, signal);
        const parts = out.split(GRP).map(s => s.trim());
        if (parts.length === c.items.length) {
          c.items.forEach((_, k) => { results[c.start + k] = parts[k]; });
        } else {
          // 分隔符数量对不上：退化为逐段翻译
          for (let k = 0; k < c.items.length; k++) {
            if (signal && signal.aborted) return;
            try { results[c.start + k] = await translateWithCache(c.items[k], config, signal); }
            catch (e) { if (signal && signal.aborted) return; results[c.start + k] = { error: e.message }; }
          }
        }
      } catch (e) {
        if (signal && signal.aborted) return; // 已取消：停止本 worker
        c.items.forEach((_, k) => { results[c.start + k] = { error: e.message }; });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, () => worker()));
  return results;
}

// ---- 流式翻译（划词：逐字上屏）----
async function streamTranslate(text, config, signal, onDelta) {
  const url = buildUrl(config.baseUrl);
  const body = {
    model: config.model,
    temperature: config.temperature ?? 0.3,
    stream: true,
    messages: [
      { role: 'system', content: systemPrompt(config.targetLang) },
      { role: 'user', content: String(text) },
    ],
  };
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (config.apiKey || ''),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch (_) {}
    throw new Error(`HTTP ${res.status}: ${detail || res.statusText}`);
  }
  if (!res.body) throw new Error('该接口不支持流式响应');
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let gotAny = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
        if (delta) { gotAny = true; onDelta(delta); }
      } catch (_) {}
    }
  }
  if (!gotAny) throw new Error('该接口未返回流式内容（可能不支持 stream）');
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'translate-stream') return;
  const tabId = port.sender && port.sender.tab && port.sender.tab.id;
  const controller = new AbortController();
  track(tabId, controller);
  port.onDisconnect.addListener(() => { controller.abort(); untrack(tabId, controller); });
  port.onMessage.addListener(async (msg) => {
    if (msg.action !== 'translate') return;
    try {
      const config = await getConfig();
      await streamTranslate(msg.text, config, controller.signal, (delta) => {
        try { port.postMessage({ type: 'delta', content: delta }); } catch (_) {}
      });
      try { port.postMessage({ type: 'done' }); } catch (_) {}
    } catch (e) {
      try {
        port.postMessage({
          type: 'error',
          message: (e && e.name === 'AbortError') ? '已取消' : (e.message || String(e)),
        });
      } catch (_) {}
    } finally {
      untrack(tabId, controller);
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;
  (async () => {
    try {
      const config = await getConfig();
      if (msg.type === 'translate' || msg.type === 'translateBatch') {
        const controller = new AbortController();
        track(tabId, controller);
        try {
          if (msg.type === 'translate') {
            const result = await translateWithCache(msg.text, config, controller.signal);
            sendResponse({ ok: true, result });
          } else {
            const results = await translateBatch(msg.texts || [], config, controller.signal);
            sendResponse({ ok: true, results });
          }
        } finally {
          untrack(tabId, controller);
        }
      } else if (msg.type === 'testConfig') {
        const result = await requestTranslate(
          msg.text || 'Hello, world!',
          { ...config, ...(msg.config || {}) }
        );
        sendResponse({ ok: true, result });
      } else if (msg.type === 'getConfig') {
        sendResponse({ ok: true, config });
      } else {
        sendResponse({ ok: false, error: '未知消息类型' });
      }
    } catch (e) {
      sendResponse({
        ok: false,
        error: (e && e.name === 'AbortError') ? '已取消' : (e.message || String(e)),
      });
    }
  })();
  return true; // 异步响应
});

function ensureContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'translate-selection',
      title: '翻译选中内容',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: 'open-pdf-link',
      title: '用翻译阅读器打开 PDF',
      contexts: ['link'],
    });
  });
}
ensureContextMenu();

function openPdfViewer(url) {
  const base = chrome.runtime.getURL('pdfviewer/pdfviewer.html');
  const target = url ? base + '?url=' + encodeURIComponent(url) : base;
  chrome.tabs.create({ url: target });
}

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === 'open-pdf-link') {
    if (info.linkUrl) openPdfViewer(info.linkUrl);
    return;
  }
  if (info.menuItemId !== 'translate-selection') return;
  const text = (info.selectionText || '').trim();
  if (!text) return;
  try {
    const config = await getConfig();
    const result = await translateWithCache(text, config);
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: '翻译结果',
      message: result.slice(0, 500),
    });
  } catch (e) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: '翻译失败',
      message: e.message,
    });
  }
});
