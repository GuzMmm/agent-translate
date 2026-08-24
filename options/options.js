// options.js — 设置页：API 配置 + 翻译设置 + 连接测试
const $ = (id) => document.getElementById(id);

async function init() {
  const s = await chrome.storage.local.get({
    enabled: true,
    targetLang: DEFAULT_TARGET,
    baseUrl: '',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.3,
  });
  $('baseUrl').value = s.baseUrl || '';
  $('apiKey').value = s.apiKey || '';
  $('model').value = s.model || '';
  $('temperature').value = s.temperature;
  $('enable').checked = !!s.enabled;

  const sel = $('targetLang');
  LANGUAGES.forEach(([v, label]) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    sel.appendChild(o);
  });
  sel.value = s.targetLang;

  bind();
}

function collectForm() {
  return {
    baseUrl: $('baseUrl').value.trim(),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim() || 'gpt-4o-mini',
    targetLang: $('targetLang').value,
    temperature: parseFloat($('temperature').value) || 0,
    enabled: $('enable').checked,
  };
}

function setStatus(msg, kind) {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status ' + (kind || '');
}

function bind() {
  $('save').addEventListener('click', async () => {
    await chrome.storage.local.set(collectForm());
    setStatus('已保存 ✓', 'ok');
  });
  $('test').addEventListener('click', async () => {
    setStatus('测试中…', 'info');
    try {
      const r = await chrome.runtime.sendMessage({
        type: 'testConfig',
        text: 'Hello, world!',
        config: collectForm(),
      });
      if (r && r.ok) setStatus('连接成功：' + r.result, 'ok');
      else setStatus('失败：' + (r && r.error ? r.error : '未知错误'), 'err');
    } catch (e) {
      setStatus('失败：' + e.message, 'err');
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
