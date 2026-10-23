(() => {
  'use strict';
  if (globalThis.__codexAutoResume || !globalThis.CodexAutoResumeEngine) return;
  const elements = new Set();
  const intentPrefix = 'codex-auto-resume:intent:v1:';
  const attached = new WeakMap(), claims = new Map(), known = new Map();
  const pair = (host, thread) => JSON.stringify([host, thread]);
  function readIntent(host, thread) {
    try {
      const value = JSON.parse(localStorage.getItem(intentPrefix + pair(host, thread)) || 'null');
      return value && typeof value.enabled === 'boolean' && typeof value.nonce === 'string' ? value : null;
    } catch { return null; }
  }
  const engine = CodexAutoResumeEngine.createAutoResume({storage: {
    getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value),
    keys: () => Array.from({length: localStorage.length}, (_, index) => localStorage.key(index)).filter(Boolean),
  }, onChange: () => { for (const element of elements) element.render(); }});
  async function enable(host, thread, value) {
    const next = {enabled: value, nonce: crypto.randomUUID()};
    try { localStorage.setItem(intentPrefix + pair(host, thread), JSON.stringify(next)); }
    catch { await engine.setEnabled(host, thread, false); return; }
    known.set(pair(host, thread), next.nonce);
    await engine.setEnabled(host, thread, value);
  }
  const labels = {off: 'Off', armed: 'On', running: 'On', waiting: 'Waiting', checking: 'Checking',
    'waiting-task': 'Waiting', blocked: 'Blocked', 'waiting-reset': 'Waiting', sending: 'Resuming', paused: 'Paused', 'storage-error': 'Error'};
  const reasons = {'quota-exhausted': '等待账号额度恢复', 'quota-unavailable': '暂时无法读取额度，稍后重试',
    'quota-blocked': '账号额度仍不可用', 'task-unavailable': '等待此任务加载', 'approval-required': '任务忙碌或正在等待审批',
    'already-attempted-window': '此额度窗口已尝试续做，等待下次额度窗口', 'unconfirmed-delivery': '发送结果不确定，已暂停，避免重复执行',
    'account-changed': '账号状态变化，已暂停；请关闭再开启以重新授权', 'storage-unavailable': '无法保存状态，已停止自动续做',
    'manual-stop': '任务已手动停止', 'other-error': '任务遇到非额度错误', resumed: '已发送续做请求'};
  let lastTick = 0;
  function tick(force = false) {
    if (!force && Date.now() - lastTick < 15000) return;
    lastTick = Date.now(); void engine.tick();
  }
  class AutoResumeToggle extends HTMLElement {
    static observedAttributes = ['host-id', 'thread-id'];
    connectedCallback() {
      elements.add(this);
      this.button = document.createElement('button'); this.button.type = 'button';
      this.button.className = 'codex-auto-resume-button'; this.button.setAttribute('role', 'switch');
      this.button.addEventListener('click', async event => {
        event.stopPropagation();
        const host = this.getAttribute('host-id') || 'local', thread = this.getAttribute('thread-id');
        await enable(host, thread, !(readIntent(host, thread)?.enabled === true));
        this.render(); tick(true);
      });
      this.replaceChildren(this.button); this.render(); tick();
    }
    disconnectedCallback() { elements.delete(this); }
    attributeChangedCallback() { if (this.isConnected && this.button) this.render(); }
    render() {
      if (!this.button) return;
      const host = this.getAttribute('host-id') || 'local', thread = this.getAttribute('thread-id');
      this.hidden = !thread;
      let state = engine.get(host, thread);
      if (!readIntent(host, thread)?.enabled) state = {...state, enabled: false, status: 'off'};
      this.button.dataset.enabled = String(state.enabled);
      this.button.dataset.state = state.status;
      this.button.setAttribute('aria-checked', String(state.enabled));
      this.button.setAttribute('aria-label', `Auto-resume: ${labels[state.status] || 'On'}`);
      this.button.title = `额度恢复后续做当前任务：${state.enabled ? '已开启' : '已关闭'}。${reasons[state.reason] || ''}\n仅处理明确的额度错误；Codex 需保持运行。关闭开关可取消待发送的续做请求。`;
      const label = document.createElement('span'); label.textContent = 'Auto-resume';
      const track = document.createElement('span'); track.className = 'codex-auto-resume-track'; track.setAttribute('aria-hidden', 'true');
      const dot = document.createElement('span'); dot.className = 'codex-auto-resume-dot'; track.append(dot);
      const status = document.createElement('span'); status.className = 'codex-auto-resume-status'; status.textContent = labels[state.status] || 'On';
      this.button.replaceChildren(label, track, status);
    }
  }
  globalThis.__codexAutoResume = Object.freeze({
    attach: (host, adapter) => {
      let wrapped = attached.get(adapter);
      if (!wrapped) {
        wrapped = {...adapter, resume: async (thread, failedTurn) => {
          const intent = readIntent(host, thread), key = pair(host, thread);
          if (!intent?.enabled) throw new Error('Auto-resume switch is off');
          claims.set(key, intent.nonce);
          try { return await adapter.resume(thread, failedTurn); }
          finally { claims.delete(key); }
        }};
        attached.set(adapter, wrapped);
      }
      return engine.attach(host, wrapped);
    },
    notify: (host, method, params) => { engine.notify(host, method, params); if (method === 'account/rateLimits/updated') tick(); },
    canResume: (host, thread, turn) => {
      const intent = readIntent(host, thread);
      if (intent?.enabled !== true || claims.get(pair(host, thread)) !== intent.nonce || !engine.canResume(host, thread, turn)) return false;
      try {
        const row = JSON.parse(localStorage.getItem(CodexAutoResumeEngine.ROW_PREFIX + pair(host, thread)) || 'null');
        return row?.version === 1 && row.host === host && row.thread === thread && row.enabled === true && row.status === 'sending' && row.pending?.turnId === turn && row.lastAttemptAt === engine.get(host, thread).lastAttemptAt;
      } catch { return false; }
    },
  });
  customElements.define('codex-auto-resume-toggle', AutoResumeToggle);
  setInterval(() => tick(), 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  addEventListener('storage', event => {
    if (event.key === null) {
      for (const key of known.keys()) { const [host, thread] = JSON.parse(key); void engine.setEnabled(host, thread, false); }
    } else if (event.key.startsWith(intentPrefix)) {
      try {
        const [host, thread] = JSON.parse(event.key.slice(intentPrefix.length));
        const intent = readIntent(host, thread), key = pair(host, thread);
        if (known.get(key) === intent?.nonce) return;
        known.set(key, intent?.nonce);
        // A remote off is immediate. A remote on needs its own fresh task inspection.
        void engine.setEnabled(host, thread, intent?.enabled === true).then(() => tick());
      } catch {}
    }
    for (const element of elements) element.render();
  });
  addEventListener('pagehide', () => engine.dispose(), {once: true});
})();
