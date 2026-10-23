/* Numeric usage only. Runs inside Codex; no file watcher or external service. */
(() => {
  'use strict';
  if (globalThis.__codexUsage) return;
  const storageKey = 'codex-usage-footer:v1';
  const turns = new Map(), threads = new Map(), hosts = new Map(), footers = new Set();
  const fields = ['totalTokens', 'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'];
  const number = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
  const id = value => typeof value === 'string' && value.length < 256 ? value : '';
  const threadId = value => id(value).replace(/^local:/, '');
  const hostId = value => id(value) || 'local';
  const key = (host, thread, turn) => JSON.stringify([hostId(host), threadId(thread), id(turn)]);
  const threadKey = (host, thread) => key(host, thread, '');
  const counts = data => data && Object.fromEntries(fields.map(field => [field, number(data[field])]));
  const usage = data => data && ({total: counts(data.total), last: counts(data.last), modelContextWindow: number(data.modelContextWindow)});
  const context = data => {
    const used = number(data?.last?.totalTokens), window = number(data?.modelContextWindow);
    return used === null || !window ? null : {used: Math.min(used, window), window};
  };
  const difference = (total, baseline) => {
    if (total?.totalTokens == null || baseline?.totalTokens == null || total.totalTokens < baseline.totalTokens) return null;
    return Object.fromEntries(fields.map(field => [field, total[field] == null || baseline[field] == null ? null : Math.max(0, total[field] - baseline[field])]));
  };
  const cleanWindow = data => data && ({usedPercent: number(data.usedPercent), windowDurationMins: number(data.windowDurationMins), resetsAt: number(data.resetsAt)});
  const limits = data => {
    const selected = data?.rateLimitsByLimitId?.codex ?? data?.rateLimits;
    return selected ? {primary: cleanWindow(selected.primary), secondary: cleanWindow(selected.secondary)} : null;
  };
  let saveTimer = null;
  const save = () => {
    if (saveTimer !== null) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        const rows = [...turns.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, 500);
        localStorage.setItem(storageKey, JSON.stringify({version: 1, rows}));
        for (const [rowKey] of turns) if (!rows.some(([saved]) => saved === rowKey)) turns.delete(rowKey);
      } catch { /* A full or disabled local cache never affects the conversation. */ }
    }, 300);
  };
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (saved?.version === 1 && Array.isArray(saved.rows)) for (const [rowKey, row] of saved.rows.slice(0, 500)) {
      if (typeof rowKey !== 'string' || !row || number(row.at) === null) continue;
      const parts = JSON.parse(rowKey);
      if (!Array.isArray(parts) || parts.length !== 3 || parts.some(part => !id(part))) continue;
      turns.set(key(...parts), {at: row.at, baseline: counts(row.baseline), tokens: counts(row.tokens),
        context: number(row.context?.used) !== null && number(row.context?.window) > 0 ? {used: row.context.used, window: row.context.window} : null,
        status: row.status === 'inProgress' ? 'interrupted' : 'completed', snapshot: limits({rateLimits: row.snapshot})});
    }
  } catch { /* Ignore incompatible or damaged local cache. */ }
  const update = () => { for (const footer of footers) footer.render(); };
  const stateForHost = host => {
    const normalized = hostId(host);
    if (!hosts.has(normalized)) hosts.set(normalized, {limits: null, fetchedAt: 0, epoch: 0, pending: false, read: null});
    return hosts.get(normalized);
  };
  const refresh = async (host, force = false) => {
    const state = stateForHost(host);
    if (!state.read || state.pending || (!force && Date.now() - state.fetchedAt < 30000)) return;
    state.pending = true;
    const epoch = state.epoch;
    try {
      const data = await state.read();
      if (epoch !== state.epoch) return;
      state.limits = limits(data); state.fetchedAt = Date.now();
    } catch {
      if (epoch === state.epoch) { state.limits = null; state.fetchedAt = Date.now(); }
    } finally { state.pending = false; update(); }
  };
  const connect = (host, read) => {
    const state = stateForHost(host);
    const initial = !state.read;
    state.read = read;
    if (initial) queueMicrotask(() => { void refresh(host); });
  };
  const notification = (method, params, host, before) => {
    if (!params || typeof params !== 'object') return;
    const state = stateForHost(host);
    if (method === 'account/updated') {
      state.epoch++; state.limits = null; state.fetchedAt = 0;
      if (params.authMode) void refresh(host, true);
      update(); return;
    }
    if (method === 'account/rateLimits/updated') {
      state.limits = limits(params); state.fetchedAt = Date.now(); update(); return;
    }
    const thread = threadId(params.threadId);
    if (!thread) return;
    const tk = threadKey(host, thread), current = threads.get(tk) || {latest: null, active: null, latestTurn: null};
    if (method === 'turn/started') {
      const turn = id(params.turn?.id);
      if (!turn) return;
      const rowKey = key(host, thread, turn);
      if (!turns.has(rowKey)) turns.set(rowKey, {baseline: counts(before?.total ?? current.latest?.total), tokens: null, context: context(before), at: Date.now(), status: 'inProgress', observedStart: true, snapshot: null});
      current.active = turn; current.latestTurn = turn;
      if (before) current.latest = usage(before);
    } else if (method === 'thread/tokenUsage/updated') {
      const incoming = usage(params.tokenUsage);
      if (!incoming?.total || !incoming.last) return;
      const turn = id(params.turnId) || current.active;
      if (turn) {
        const rowKey = key(host, thread, turn);
        const row = turns.get(rowKey) || {baseline: null, tokens: null, at: Date.now(), status: 'inProgress', observedStart: false};
        // A witnessed start plus the first request's exact counters establishes
        // a baseline even when the native resumed-thread snapshot was empty.
        if (!row.baseline && row.observedStart) row.baseline = difference(incoming.total, incoming.last);
        row.tokens = difference(incoming.total, row.baseline);
        row.context = context(incoming); row.at = Date.now();
        turns.set(rowKey, row); current.latestTurn = turn;
      }
      current.latest = incoming;
    } else if (method === 'turn/completed') {
      const turn = id(params.turn?.id);
      if (!turn) return;
      const row = turns.get(key(host, thread, turn));
      if (row) { row.status = params.turn.status || 'completed'; row.at = Date.now(); row.snapshot = state.limits; }
      if (current.active === turn) current.active = null;
      current.latestTurn = turn; void refresh(host);
    } else return;
    threads.set(tk, current); save(); update();
  };
  const format = n => number(n) === null ? '--' : Math.round(n).toLocaleString('en-US');
  const percent = n => `${Math.max(0, Math.min(100, n)).toFixed(1).replace(/\.0$/, '')}%`;
  const windowLabel = (window, fallback) => {
    const minutes = window?.windowDurationMins;
    if (minutes === 300) return '5-hours';
    if (minutes === 10080) return 'Weekly';
    if (minutes > 0) return minutes % 60 === 0 ? `${minutes / 60}-hours` : `${minutes}-minutes`;
    return fallback;
  };
  class CodexUsageFooter extends HTMLElement {
    static observedAttributes = ['host-id', 'thread-id', 'turn-id', 'latest'];
    connectedCallback() { footers.add(this); this.render(); void refresh(this.getAttribute('host-id')); }
    disconnectedCallback() { footers.delete(this); }
    attributeChangedCallback() { if (this.isConnected) this.render(); }
    render() {
      const host = this.getAttribute('host-id'), thread = this.getAttribute('thread-id'), turn = this.getAttribute('turn-id');
      if (!thread || !turn) { this.hidden = true; return; }
      const row = turns.get(key(host, thread, turn)), current = threads.get(threadKey(host, thread));
      const latest = this.getAttribute('latest') === 'true';
      const material = latest ? context(current?.latest) || row?.context : row?.context;
      const hostState = stateForHost(host);
      const quota = latest && Date.now() - hostState.fetchedAt < 180000 ? hostState.limits : row?.snapshot;
      this.hidden = false;
      const entries = [
        ['Tokens', format(row?.tokens?.totalTokens), row?.tokens ? `Input: ${format(row.tokens.inputTokens)}; Cached input: ${format(row.tokens.cachedInputTokens)}; Output: ${format(row.tokens.outputTokens)}; Reasoning (included in output): ${format(row.tokens.reasoningOutputTokens)}. This turn only; separate subagent threads are excluded.` : 'No complete token record for this turn.'],
        ['Context left', material ? percent((1 - material.used / material.window) * 100) : '--', material ? `${format(material.window - material.used)} / ${format(material.window)} tokens remaining; updated from the last model request.` : 'Context usage is unavailable.'],
        ...[['primary', '5-hours'], ['secondary', 'Weekly']].map(([slot, fallback]) => {
          const window = quota?.[slot];
          return [windowLabel(window, fallback), number(window?.usedPercent) === null ? '--' : percent(100 - window.usedPercent), window?.resetsAt ? `Resets: ${new Date(window.resetsAt * 1000).toLocaleString()}` : 'Subscription quota is unavailable.'];
        }),
      ];
      const signature = JSON.stringify(entries);
      if (signature === this.signature) return;
      this.signature = signature;
      const fragment = document.createDocumentFragment();
      for (const [label, value, title] of entries) {
        const item = document.createElement('span'); item.className = 'codex-usage-item'; item.title = title;
        const name = document.createElement('span'); name.className = 'codex-usage-label'; name.textContent = `${label}: `;
        const number = document.createElement('span'); number.textContent = value;
        item.append(name, number); fragment.append(item);
      }
      this.replaceChildren(fragment);
      this.setAttribute('aria-label', entries.map(([label, value]) => `${label}: ${value}`).join('; '));
    }
  }
  globalThis.__codexUsage = Object.freeze({connect, notification});
  customElements.define('codex-usage-footer', CodexUsageFooter);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) for (const host of hosts.keys()) void refresh(host); });
  setInterval(() => { if (!document.hidden && footers.size) for (const host of hosts.keys()) void refresh(host); }, 60000);
})();
