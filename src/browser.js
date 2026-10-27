// Built into a self-contained snippet. Authentication stays in this closure.
(() => {
  'use strict';
  if (location.origin !== 'https://anyview.gdut.edu.cn') throw Error('请只在 AnyView 官方学生页面运行');
  if (!location.pathname.startsWith('/student/')) throw Error('请先打开学生端');
  if (window.AnyViewAutomation) { window.AnyViewAutomation.show(); return; }
  const bank = __BANK__;
  const STORE = 'anyview-automation:v1';
  const LOCK = `${STORE}:lease`;
  const id = crypto.randomUUID();
  let token = ''; let course = null; let runner = null; let heartbeat = null; let connected = false;
  const originalSet = XMLHttpRequest.prototype.setRequestHeader;
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalFetch = window.fetch;
  const xhrUrls = new WeakMap();
  const sameApi = value => { try { const u = new URL(value, location.href);
    return u.origin === location.origin && u.pathname.startsWith('/api/'); } catch { return false; } };
  function acceptToken(value) {
    if (typeof value !== 'string' || !value) return;
    if (token && token !== value && runner?.running) {
      runner.stop(); token = ''; connected = false;
      render('检测到登录会话变更，批次已请求停止；请重新读取目录。'); return;
    }
    token = value; connected = true; render('已连接当前会话；可读取目录。');
  }
  function opened(method, url, ...rest) { xhrUrls.set(this, String(url)); return originalOpen.call(this, method, url, ...rest); }
  function setHeader(name, value) {
    if (sameApi(xhrUrls.get(this)) && String(name).toLowerCase() === 'token') acceptToken(String(value));
    return originalSet.call(this, name, value);
  }
  async function interceptedFetch(input, options) {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    if (sameApi(url)) {
      const h = new Headers(options?.headers || (input instanceof Request ? input.headers : undefined));
      if (h.has('token')) acceptToken(h.get('token'));
    }
    return originalFetch.call(this, input, options);
  }
  XMLHttpRequest.prototype.open = opened;
  XMLHttpRequest.prototype.setRequestHeader = setHeader;
  window.fetch = interceptedFetch;
  async function request(path, { fields, eid } = {}) {
    if (!token) throw new Halt('need_session', '请在原页面点击一次返回、课程或章节，让页面发出正常请求');
    const headers = { token }; if (eid != null) headers.eid = String(eid);
    const options = { headers, credentials: 'same-origin', signal: AbortSignal.timeout(120000) };
    if (fields) {
      options.method = 'POST'; options.body = new FormData();
      for (const [key, value] of Object.entries(fields)) options.body.append(key, String(value));
    }
    const response = await originalFetch.call(window, path, options);
    if ([401, 403].includes(response.status)) throw new Halt('need_session', '会话失效，请在网站正常登录');
    if (!response.ok) throw new Halt(fields ? 'uncertain' : 'network_error', '网站请求失败');
    const json = await response.json();
    if (json.code !== 200 || json.data == null)
      throw new Halt(fields ? 'uncertain' : 'protocol_error', '网站返回异常或会话失效');
    return json.data;
  }
  const b64 = text => { const bytes = new TextEncoder().encode(text); let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); };
  const api = {
    async catalog() {
      if (!course) throw new Halt('need_course', '请先读取并选择课程');
      return request(`/api/scheme-service/catalog/list?schemeId=${encodeURIComponent(course.id)}&classId=${encodeURIComponent(course.classId)}`);
    },
    detail: eid => request(`/api/scheme-service/scheme/list/student/${encodeURIComponent(eid)}`, { eid }),
    compile: (p, d, code) => request('/api/gdb-service/code/compile', { eid: p.eid, fields: {
      'questionRes.questionFullName': d.questionFullName, eID: p.eid, stuCode: b64(code), isTeacher: false, isDebug: false } }),
    judge: (p, d, code) => request('/api/gdb-service/code/runGroup', { eid: p.eid, fields: {
      questionFullName: p.pname, eID: p.eid, stuCode: b64(code), isTeacher: false, kind: d.kind, language: d.language } })
  };
  // Course-scoped journal survives re-login. Server state always overrides local success.
  // Uncertain writes remain blocked even after a browser restart or login refresh.
  let key = null;
  async function storageKey() {
    return `${STORE}:${course.id}:${course.classId}`;
  }
  function lease() {
    const existing = JSON.parse(localStorage.getItem(LOCK) || 'null');
    if (existing && existing.id !== id && existing.until > Date.now()) throw new Halt('busy', '另一个标签页正在运行');
    localStorage.setItem(LOCK, JSON.stringify({ id, until: Date.now() + 300000 }));
  }
  function release() { clearInterval(heartbeat); heartbeat = null;
    const lock = JSON.parse(localStorage.getItem(LOCK) || 'null');
    if (lock?.id === id) localStorage.removeItem(LOCK); }
  const panel = document.createElement('dialog');
  panel.setAttribute('aria-label', 'AnyView 自动过题');
  // Browser default controls; no external scripts, styles, analytics, or services.
  panel.innerHTML = '<h3>AnyView 自动过题 · 第1—5章</h3><p data-message>已准备好。请在原页面点击一次返回、课程或章节以连接会话。</p><button data-load>读取课程与目录</button> <select aria-label="选择课程"></select><p data-plan></p><button data-one>先验证 DC01PE21</button> <button data-run>开始第一至第五章</button> <button data-stop>停止</button> <button data-export>导出结果</button> <button data-close>收起</button><pre data-progress></pre>';
  document.body.append(panel); panel.show();
  const $ = selector => panel.querySelector(selector);
  const states = { idle:'就绪',running:'运行中',completed:'已完成并复核',failed:'未通过，已暂停',
    compile_failed:'编译失败，已暂停',uncertain:'结果不明确，已暂停',stopped:'已停止' };
  function render(message) {
    if (message) $('[data-message]').textContent = message;
    $('[data-one]').disabled = !course || !!runner?.running;
    $('[data-run]').disabled = !course || !!runner?.running;
    $('[data-load]').disabled = !!runner?.running;
    $('select').disabled = !!runner?.running;
    $('[data-progress]').textContent = runner ?
      `${states[runner.state] || runner.state} · ${runner.current || ''}\n` +
      runner.records.map(r => `${r.pname}: ${r.status}`).join('\n') : (connected ? '会话已连接，凭据仅在本页内存中。' : '等待当前页面的正常 API 请求。');
  }
  function error(e) { render(e instanceof Halt ? e.message : '操作失败；请检查会话或网站状态。'); }
  async function chooseCourse() {
    if (runner?.running) return;
    course = courses.find(c => String(c.id) === $('select').value); key = await storageKey();
    const stored = JSON.parse(localStorage.getItem(key) || 'null');
    runner = new Runner({ api, bank, previous: stored?.records || [],
      save: async state => localStorage.setItem(key, JSON.stringify(state)), onChange: () => render() });
    const plan = await runner.plan();
    const pending = plan.filter(p => p.status === 'pending').length;
    $('[data-plan]').textContent = `范围内 ${plan.length} 题；已通过 ${plan.filter(p => p.status === 'already_passed').length}；待做 ${pending}；缺题解 ${plan.filter(p => p.status === 'no_bank').length}。`;
    render('目录已读取；开始后将向学校服务器提交题解，并逐题复核通过状态。');
  }
  let courses = [];
  $('[data-load]').onclick = async () => { try {
    const list = await request('/api/scheme-service/scheme/list/student');
    if (!Array.isArray(list)) throw new Halt('protocol_error', '课程列表格式异常');
    courses = list.filter(c => c.questionType === 1 && c.id != null && c.classId != null);
    $('select').replaceChildren(...courses.map(c => { const option = document.createElement('option');
      option.value = String(c.id); option.textContent = `${c.name || '编程课'} (${c.id})`; return option; }));
    if (!courses.length) throw new Halt('need_course', '没有找到编程课程');
    await chooseCourse();
  } catch(e) { error(e); } };
  $('select').onchange = () => chooseCourse().catch(error);
  async function start(only) { try {
    if (!runner || runner.running) return;
    // Web Locks prevents races across tabs. Refuse to run where unavailable.
    if (!navigator.locks) throw new Halt('busy', '浏览器不支持跨标签页互斥锁');
    await navigator.locks.request(LOCK, { ifAvailable: true }, async lock => {
      if (!lock) throw new Halt('busy', '另一个标签页正在运行');
      lease(); heartbeat = setInterval(() => { try { lease(); } catch { runner.stop(); } }, 15000);
      try { await runner.start({ only }); render(runner.message || '运行结束，请查看逐题结果。'); }
      finally { release(); }
    });
  } catch(e) { error(e); } }
  $('[data-one]').onclick = () => start('DC01PE21');
  $('[data-run]').onclick = () => start(null);
  $('[data-stop]').onclick = () => { runner?.stop(); render('停止已请求；会先记录正在处理的请求结果。'); };
  $('[data-close]').onclick = () => panel.close();
  $('[data-export]').onclick = () => {
    const report = runner ? runner.snapshot() : { state: 'not_started', records: [] };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = 'anyview-results.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  window.addEventListener('beforeunload', event => { if (runner?.running) { event.preventDefault(); event.returnValue = ''; } });
  window.AnyViewAutomation = Object.freeze({ show: () => { if (!panel.open) panel.show(); }, stop: () => runner?.stop(),
    report: () => runner?.snapshot() || { state: 'not_started', records: [] } });
  render();
})();
