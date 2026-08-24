// pdfviewer/pdfviewer.js — PDF 渲染 + 划词翻译 + 整篇双语翻译
const pdfjsLib = window.pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');

const $ = (id) => document.getElementById(id);

let pdfDoc = null;
let scale = 1.2;
let currentPage = 1;

// ================= 划词翻译（复用 .at-popup 样式）=================
let popupEl = null;
let lastMouse = { x: 0, y: 0 };
let currentText = '';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

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
  return null;
}

async function translateText(text) {
  const s = await chrome.storage.local.get({ targetLang: '简体中文' });
  const r = await chrome.runtime.sendMessage({ type: 'translate', text });
  if (!r || !r.ok) throw new Error(r && r.error ? r.error : '翻译失败');
  return r.result;
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

function hidePopup() { if (popupEl) { popupEl.remove(); popupEl = null; } }

function positionPopup(rect) {
  if (!popupEl) return;
  const m = 10, pad = 6;
  let x, y;
  if (rect && (rect.width > 0 || rect.height > 0)) { x = rect.left; y = rect.bottom + m; }
  else { x = lastMouse.x; y = lastMouse.y + m; }
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
      '<span class="at-popup-lang">→ ' + escapeHtml(currentLang()) + '</span>' +
      '<span class="at-popup-actions">' +
        '<button class="at-btn at-copy" type="button">复制</button>' +
        '<button class="at-btn at-close" type="button">✕</button>' +
      '</span>' +
    '</div>' +
    '<div class="at-popup-body at-loading">翻译中…</div>';
  document.body.appendChild(popupEl);
  positionPopup(info.rect);

  const bodyEl = popupEl.querySelector('.at-popup-body');
  popupEl.querySelector('.at-close').addEventListener('click', hidePopup);
  popupEl.querySelector('.at-copy').addEventListener('click', () => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(bodyEl.textContent);
    }
  });

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

let cachedLang = '简体中文';
function currentLang() { return cachedLang; }
async function refreshLang() {
  const s = await chrome.storage.local.get({ targetLang: '简体中文' });
  cachedLang = s.targetLang;
}

// ================= 渲染 =================
function multiplyMatrix(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

async function renderPage(num) {
  const page = await pdfDoc.getPage(num);
  const viewport = page.getViewport({ scale });
  const dpr = window.devicePixelRatio || 1;

  const wrapper = document.createElement('div');
  wrapper.className = 'page';
  wrapper.style.width = viewport.width + 'px';
  wrapper.style.height = viewport.height + 'px';

  const canvas = document.createElement('canvas');
  canvas.className = 'page-canvas';
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = viewport.width + 'px';
  canvas.style.height = viewport.height + 'px';
  const ctx = canvas.getContext('2d');

  await page.render({
    canvasContext: ctx,
    viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
  }).promise;

  // 文本层：透明可选中，用于划词
  const textLayer = document.createElement('div');
  textLayer.className = 'text-layer';
  textLayer.style.width = viewport.width + 'px';
  textLayer.style.height = viewport.height + 'px';

  const textContent = await page.getTextContent();
  const vpt = viewport.transform;
  for (const item of textContent.items) {
    if (!item.str) continue;
    const tx = multiplyMatrix(vpt, item.transform);
    const fontHeight = Math.hypot(tx[0], tx[1]);
    if (fontHeight <= 0) continue;
    const angle = Math.atan2(tx[1], tx[0]);
    const span = document.createElement('span');
    span.textContent = item.str;
    span.style.left = tx[4] + 'px';
    span.style.top = (tx[5] - fontHeight) + 'px';
    span.style.fontSize = fontHeight + 'px';
    if (angle !== 0) span.style.transform = 'rotate(' + angle + 'rad)';
    textLayer.appendChild(span);
  }

  wrapper.appendChild(canvas);
  wrapper.appendChild(textLayer);
  return wrapper;
}

async function render() {
  if (!pdfDoc) return;
  $('empty').style.display = 'none';
  $('viewer').querySelectorAll('.page').forEach(el => el.remove());
  $('pageInfo').textContent = '加载中…';
  const pageDiv = await renderPage(currentPage);
  $('viewer').appendChild(pageDiv);
  $('pageInfo').textContent = currentPage + ' / ' + pdfDoc.numPages;
  $('zoomInfo').textContent = Math.round(scale * 100) + '%';
}

// ================= 整篇翻译 =================
function splitChunks(text, maxLen) {
  const chunks = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && (cur.length + line.length + 1) > maxLen) { chunks.push(cur); cur = ''; }
    cur = cur ? cur + '\n' + line : line;
    while (cur.length > maxLen) { chunks.push(cur.slice(0, maxLen)); cur = cur.slice(maxLen); }
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

async function translateAll() {
  if (!pdfDoc) return;
  const pageTexts = [];
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const tc = await page.getTextContent();
    let text = '';
    for (const it of tc.items) {
      if (it.str) {
        text += it.str;
        text += it.hasEOL ? '\n' : ' ';
      }
    }
    if (text.trim()) pageTexts.push({ page: i, text: text.trim() });
  }
  if (!pageTexts.length) {
    $('panel').hidden = false;
    $('panelBody').innerHTML = '<div class="at-error">未提取到文本（可能是扫描版 PDF，需 OCR）。</div>';
    return;
  }

  const chunks = [];
  for (const p of pageTexts) {
    for (const s of splitChunks(p.text, 800)) chunks.push({ page: p.page, text: s });
  }

  $('panel').hidden = false;
  $('panelBody').innerHTML = '<div class="at-loading">翻译中 0/' + chunks.length + '…</div>';

  const results = new Array(chunks.length);
  const texts = chunks.map(c => c.text);
  const BATCH = 40;
  let done = 0;
  for (let start = 0; start < texts.length; start += BATCH) {
    const slice = texts.slice(start, start + BATCH);
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
    done += slice.length;
    $('panelBody').innerHTML = '<div class="at-loading">翻译中 ' + done + '/' + chunks.length + '…</div>';
  }

  // 渲染双语对照
  $('panelBody').innerHTML = '';
  chunks.forEach((c, i) => {
    const entry = document.createElement('div');
    entry.className = 'entry';
    const tag = document.createElement('div');
    tag.className = 'page-tag';
    tag.textContent = '第 ' + c.page + ' 页';
    const src = document.createElement('div');
    src.className = 'src';
    src.textContent = c.text;
    const dst = document.createElement('div');
    dst.className = 'dst';
    const r = results[i];
    dst.textContent = (r && r.error) ? '翻译失败：' + r.error : r;
    entry.appendChild(tag);
    entry.appendChild(src);
    entry.appendChild(dst);
    $('panelBody').appendChild(entry);
  });
}

// ================= 加载 =================
async function loadFromUrl(url) {
  $('empty').style.display = 'block';
  $('empty').innerHTML = '<p>正在加载 PDF…</p>';
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error('无法读取该地址（本地 file:// 文件请点「打开文件」选择）');
  }
  if (!res.ok) throw new Error('无法获取 PDF：HTTP ' + res.status);
  const data = await res.arrayBuffer();
  pdfDoc = await pdfjsLib.getDocument({ data }).promise;
  await render();
}

async function loadFromFile(file) {
  const data = await file.arrayBuffer();
  pdfDoc = await pdfjsLib.getDocument({ data }).promise;
  await render();
}

// ================= 事件 =================
function bind() {
  $('prev').addEventListener('click', () => { if (pdfDoc && currentPage > 1) { currentPage--; render(); } });
  $('next').addEventListener('click', () => { if (pdfDoc && currentPage < pdfDoc.numPages) { currentPage++; render(); } });
  $('zoomIn').addEventListener('click', () => { scale = Math.min(3, scale * 1.25); render(); });
  $('zoomOut').addEventListener('click', () => { scale = Math.max(0.5, scale / 1.25); render(); });
  $('translateAll').addEventListener('click', translateAll);
  $('closePanel').addEventListener('click', () => { $('panel').hidden = true; });
  $('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('openFile').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) loadFromFile(f).catch(err => alert(err.message || err));
  });

  document.addEventListener('mousemove', (e) => { lastMouse = { x: e.clientX, y: e.clientY }; }, true);
  document.addEventListener('mouseup', (e) => {
    lastMouse = { x: e.clientX, y: e.clientY };
    if (e.target && e.target.closest && e.target.closest('[data-at-ui]')) return;
    setTimeout(() => {
      const info = getSelectionInfo();
      if (info && info.text && info.text.length <= 5000) showPopup(info);
    }, 10);
  }, true);
  document.addEventListener('mousedown', (e) => {
    if (popupEl && !popupEl.contains(e.target)) hidePopup();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hidePopup(); }, true);

  // 拖放打开
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFromFile(f).catch(err => alert(err.message || err));
  });
}

async function init() {
  bind();
  await refreshLang();
  const url = new URLSearchParams(location.search).get('url');
  if (url) {
    try { await loadFromUrl(url); }
    catch (e) { $('empty').innerHTML = '<p class="at-error">加载失败：' + escapeHtml(e.message) + '</p>'; }
  }
}

init();
