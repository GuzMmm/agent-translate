// content/content.js — 划词翻译 + 整页翻译
// 覆盖：普通选区 / input、textarea 选区 / contenteditable / Shadow DOM /
//       跨域 iframe（all_frames）/ Chrome 内置 PDF 阅读器（匹配其固定 ID）
(() => {
  if (window.__agentTranslateLoaded) return;
  window.__agentTranslateLoaded = true;

  const DEFAULTS = { enabled: true, targetLang: '简体中文' };
  const SEP = '⟪SEP⟫';

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'BUTTON',
    'SVG', 'MATH', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT', 'EMBED',
    'CODE', 'PRE', 'KBD', 'SAMP', 'VAR',
  ]);
  const INLINE_TAGS = new Set([
    'A', 'ABBR', 'B', 'BDI', 'BDO', 'BIG', 'CITE', 'DEL', 'DFN', 'EM', 'FONT', 'I', 'INS',
    'KBD', 'LABEL', 'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRIKE', 'STRONG', 'SUB',
    'SUP', 'TIME', 'TT', 'U', 'VAR', 'WBR', 'RUBY', 'RT', 'RP',
  ]);

  let config = { ...DEFAULTS };
  let popupEl = null;
  let progressEl = null;
  let lastMouse = { x: 0, y: 0 };
  let pageTranslated = false;
  let currentText = '';
  const originals = new WeakMap(); // Text 节点 -> 原文（用于还原）

  // ---------- 配置 ----------
  async function refreshConfig() {
    try {
      const s = await chrome.storage.local.get(null);
      config = { ...DEFAULTS, ...s };
    } catch (_) {}
  }
  refreshConfig();
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local') refreshConfig();
    });
  }

  // ---------- 工具 ----------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).catch(() => fallbackCopy(t));
    } else fallbackCopy(t);
  }
  function fallbackCopy(t) {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (_) {}
    ta.remove();
  }

  // ---------- 划词翻译 ----------
  function getSelectionInfo() {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) {
      const text = sel.toString().trim();
      if (text) {
        let rect = null;
        if (sel.rangeCount > 0) {
          try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch (_) {}
        }
        return { text, rect };
      }
    }
    // input / textarea 内部的选区不会出现在 window.getSelection()
    const el = document.activeElement;
    if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) {
      const start = el.selectionStart, end = el.selectionEnd;
      if (typeof start === 'number' && typeof end === 'number' && end > start) {
        const text = el.value.slice(start, end).trim();
        if (text) return { text, rect: el.getBoundingClientRect() };
      }
    }
    return null;
  }

  function streamTranslateText(text, onDelta, onDone, onError) {
    let port;
    try { port = chrome.runtime.connect({ name: 'translate-stream' }); }
    catch (e) { onError(e); return; }
    port.onMessage.addListener((msg) => {
      if (msg.type === 'delta') onDelta(msg.content);
      else if (msg.type === 'done') { try { port.disconnect(); } catch (_) {} onDone(); }
      else if (msg.type === 'error') { try { port.disconnect(); } catch (_) {} onError(new Error(msg.message)); }
    });
    port.postMessage({ action: 'translate', text });
  }

  function showPopup(info) {
    if (!info || !info.text) return;
    if (info.text === currentText && popupEl) return;
    hidePopup();
    currentText = info.text;

    popupEl = document.createElement('div');
    popupEl.className = 'at-popup';
    popupEl.setAttribute('data-at-ui', '1');
    popupEl.innerHTML =
      '<div class="at-popup-head">' +
        '<span class="at-popup-lang">→ ' + escapeHtml(config.targetLang) + '</span>' +
        '<span class="at-popup-actions">' +
          '<button class="at-btn at-copy" type="button">复制</button>' +
          '<button class="at-btn at-close" type="button">✕</button>' +
        '</span>' +
      '</div>' +
      '<div class="at-popup-body at-loading">翻译中…</div>';

    (document.body || document.documentElement).appendChild(popupEl);
    positionPopup(info.rect);

    const bodyEl = popupEl.querySelector('.at-popup-body');
    popupEl.querySelector('.at-close').addEventListener('click', hidePopup);
    popupEl.querySelector('.at-copy').addEventListener('click', () => copyText(bodyEl.textContent));

    let first = true;
    streamTranslateText(
      info.text,
      (delta) => {
        if (!popupEl) return;
        if (first) { bodyEl.textContent = ''; bodyEl.classList.remove('at-loading'); first = false; }
        bodyEl.textContent += delta;
      },
      () => { if (popupEl) bodyEl.classList.remove('at-loading'); },
      (e) => {
        if (!popupEl) return;
        bodyEl.classList.remove('at-loading');
        bodyEl.textContent = (bodyEl.textContent ? bodyEl.textContent + '\n' : '') + '翻译失败：' + (e.message || e);
        bodyEl.classList.add('at-error');
      }
    );
  }

  function hidePopup() {
    if (popupEl) { popupEl.remove(); popupEl = null; }
  }

  function positionPopup(rect) {
    if (!popupEl) return;
    const m = 10, pad = 6;
    let x, y;
    if (rect && (rect.width > 0 || rect.height > 0)) {
      x = rect.left;
      y = rect.bottom + m;
    } else {
      x = lastMouse.x;
      y = lastMouse.y + m;
    }
    const w = popupEl.offsetWidth || 280;
    const h = popupEl.offsetHeight || 80;
    const vw = window.innerWidth, vh = window.innerHeight;
    if (x + w > vw - pad) x = Math.max(pad, vw - w - pad);
    if (x < pad) x = pad;
    if (y + h > vh - pad) {
      if (rect && rect.top > h + m) y = rect.top - h - m;
      else y = vh - h - pad;
    }
    if (y < pad) y = pad;
    popupEl.style.left = x + 'px';
    popupEl.style.top = y + 'px';
  }

  // ---------- 整页翻译 ----------
  function shouldSkip(node) {
    let el = node.parentElement;
    while (el) {
      if (SKIP_TAGS.has(el.tagName)) return true;
      if (el.hasAttribute && el.hasAttribute('data-at-ui')) return true;
      if (el.translate === false) return true;      // 尊重 translate="no"
      if (el.isContentEditable) return true;
      el = el.parentElement;
    }
    return false;
  }

  function collectTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (!n.nodeValue || n.nodeValue.trim() === '') continue;
      if (originals.has(n)) continue; // 已翻译过的跳过
      if (shouldSkip(n)) continue;
      nodes.push(n);
    }
    return nodes;
  }

  // 找到最近的“非内联”祖先作为分组键，把同一段内的内联文本合并成完整句子
  function groupKey(node) {
    let el = node.parentElement;
    while (el && INLINE_TAGS.has(el.tagName)) el = el.parentElement;
    return el;
  }

  function groupTextNodes(nodes) {
    const groups = [];
    let cur = null;
    for (const n of nodes) {
      const key = groupKey(n);
      if (cur && cur.key === key) cur.nodes.push(n);
      else { cur = { key, nodes: [n] }; groups.push(cur); }
    }
    return groups;
  }

  function setNodeText(node, text) {
    if (!originals.has(node)) originals.set(node, node.nodeValue);
    node.nodeValue = text;
  }

  function applyGroupRange(groups, results, start, end) {
    for (let gi = start; gi < end; gi++) {
      const g = groups[gi];
      const r = results[gi];
      if (r && typeof r === 'object' && r.error) continue;
      if (typeof r !== 'string') continue;
      if (g.nodes.length === 1) {
        setNodeText(g.nodes[0], r.trim());
        continue;
      }
      const parts = r.split(SEP).map(s => s.trim());
      if (parts.length === g.nodes.length) {
        g.nodes.forEach((n, i) => setNodeText(n, parts[i]));
      }
      // 分隔符数量不匹配时跳过该组，保留原文（罕见，模型改了占位符才会发生）
    }
  }

  async function translatePage() {
    if (pageTranslated) return;
    const nodes = collectTextNodes(document.body);
    if (!nodes.length) return;
    const groups = groupTextNodes(nodes);
    const segments = groups.map(g => g.nodes.map(n => n.nodeValue).join(SEP));

    const results = new Array(segments.length);
    const BATCH = 24; // 每批段数：批越小，页面上字越早开始出现（流式感）
    showProgress(0, segments.length);
    for (let start = 0; start < segments.length; start += BATCH) {
      const end = Math.min(start + BATCH, segments.length);
      const slice = segments.slice(start, end);
      try {
        const r = await chrome.runtime.sendMessage({ type: 'translateBatch', texts: slice });
        if (r && r.ok && Array.isArray(r.results)) {
          r.results.forEach((res, k) => { results[start + k] = res; });
        } else {
          throw new Error(r && r.error ? r.error : '翻译失败');
        }
      } catch (e) {
        for (let k = 0; k < slice.length; k++) results[start + k] = { error: e.message };
      }
      // 这一批一拿到就写回页面，实现“边翻边出”
      applyGroupRange(groups, results, start, end);
      updateProgress(end, segments.length);
    }

    hideProgress();
    pageTranslated = true;
  }

  function restorePage() {
    const nodes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
      if (originals.has(n)) n.nodeValue = originals.get(n);
    }
    pageTranslated = false;
  }

  // ---------- 进度提示 ----------
  function showProgress(done, total) {
    hideProgress();
    progressEl = document.createElement('div');
    progressEl.className = 'at-progress';
    progressEl.setAttribute('data-at-ui', '1');
    progressEl.textContent = `翻译中 0/${total}`;
    (document.body || document.documentElement).appendChild(progressEl);
  }
  function updateProgress(done, total) {
    if (progressEl) progressEl.textContent = `翻译中 ${done}/${total}`;
  }
  function hideProgress() {
    if (progressEl) { progressEl.remove(); progressEl = null; }
  }

  // ---------- 事件 ----------
  document.addEventListener('mousemove', (e) => { lastMouse = { x: e.clientX, y: e.clientY }; }, true);
  document.addEventListener('mouseup', (e) => {
    lastMouse = { x: e.clientX, y: e.clientY };
    if (!config.enabled) return;
    if (e.target && e.target.closest && e.target.closest('[data-at-ui]')) return;
    setTimeout(() => {
      const info = getSelectionInfo();
      if (info && info.text && info.text.length <= 5000) showPopup(info);
    }, 10);
  }, true);
  document.addEventListener('keyup', (e) => {
    if (!config.enabled) return;
    const info = getSelectionInfo();
    if (info && info.text && info.text.length <= 5000) showPopup(info);
  }, true);
  document.addEventListener('mousedown', (e) => {
    if (popupEl && !popupEl.contains(e.target)) hidePopup();
  }, true);
  document.addEventListener('scroll', () => { hidePopup(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hidePopup(); }, true);

  // ---------- 消息 ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'translatePage') {
      translatePage();
      sendResponse({ ok: true });
    } else if (msg.type === 'restorePage') {
      restorePage();
      sendResponse({ ok: true });
    } else if (msg.type === 'getState') {
      sendResponse({ ok: true, pageTranslated });
    }
  });
})();
