/* Pure quota-recovery state machine. No timer, network client, or model credential. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CodexAutoResumeEngine = api;
})(globalThis, function () {
  'use strict';
  const STORAGE_KEY = 'codex-auto-resume:v1';
  const ROW_PREFIX = 'codex-auto-resume:row:v1:';
  const MAX_ROWS = 500;
  const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value);
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const normalizedCode = value => typeof value === 'string' ? value.replace(/[_\s-]/g, '').toLowerCase() : '';
  function isUsageLimitError(error) {
    if (!error || typeof error !== 'object') return false;
    const info = error.codexErrorInfo ?? error.codex_error_info;
    if (normalizedCode(info) === 'usagelimitexceeded') return true;
    if (!info || typeof info !== 'object' || Array.isArray(info)) return false;
    if (normalizedCode(info.type) === 'usagelimitexceeded') return true;
    return Object.keys(info).some(name => normalizedCode(name) === 'usagelimitexceeded');
  }
  function quotaState(response) {
    if (!response || typeof response !== 'object') return {ready: false, reason: 'quota-unavailable'};
    const buckets = response.rateLimitsByLimitId;
    const bucket = buckets && typeof buckets === 'object' && Object.keys(buckets).length
      ? buckets.codex : response.rateLimits;
    if (!bucket || typeof bucket !== 'object') return {ready: false, reason: 'quota-unavailable'};
    for (const source of [response, bucket]) {
      if (source.ordinaryUsageAllowed === false || source.spendControlReached === true)
        return {ready: false, reason: 'quota-blocked'};
      const reached = source.rateLimitReachedType;
      if (reached != null && reached !== false && reached !== '' && reached !== 'none')
        return {ready: false, reason: 'quota-blocked'};
    }
    const windows = [bucket.primary];
    if (bucket.secondary != null) windows.push(bucket.secondary);
    for (const window of windows) {
      if (!window || !finite(window.usedPercent) || window.usedPercent < 0 ||
          !finite(window.resetsAt) || window.resetsAt <= 0 ||
          !finite(window.windowDurationMins) || window.windowDurationMins <= 0)
        return {ready: false, reason: 'quota-unavailable'};
      if (window.usedPercent >= 100) return {ready: false, reason: 'quota-exhausted'};
    }
    return {ready: true, fingerprint: JSON.stringify([
      bucket.limitId || 'codex', bucket.primary.resetsAt, bucket.primary.windowDurationMins,
      bucket.secondary?.resetsAt ?? null, bucket.secondary?.windowDurationMins ?? null,
    ])};
  }
  function createAutoResume({storage, now = Date.now, onChange = () => {}} = {}) {
    const rows = new Map(), hosts = new Map();
    let storageHealthy = true, disposed = false, tickPromise = null;
    const pair = (host, thread) => JSON.stringify([host, thread]);
    const validPair = (host, thread) => validId(host) && validId(thread);
    const timestamp = () => {
      const value = now();
      return finite(value) && value >= 0 ? value : 0;
    };
    const defaultRow = (host, thread) => ({host, thread, enabled: false, pending: null,
      status: 'off', reason: '', epoch: 0, at: timestamp(), attempts: [], lastAttemptAt: null,
      uncertainTurn: null, attemptTurn: null});
    function snapshot(row) {
      return Object.freeze({enabled: row.enabled, status: row.status, reason: row.reason,
        pending: row.pending ? Object.freeze({turnId: row.pending.turnId}) : null,
        pendingTurnId: row.pending?.turnId ?? null, pendingSince: row.pending?.at ?? null,
        lastAttemptAt: row.lastAttemptAt});
    }
    function emit(row) {
      try { onChange(row.host, row.thread, snapshot(row)); } catch { /* UI failures cannot initiate a task. */ }
    }
    function serialize(row) {
      return {host: row.host, thread: row.thread, enabled: row.enabled === true,
        pending: row.pending && validId(row.pending.turnId) && finite(row.pending.at) ? {turnId: row.pending.turnId, at: row.pending.at} : null,
        status: typeof row.status === 'string' ? row.status : 'off', reason: typeof row.reason === 'string' ? row.reason : '',
        at: finite(row.at) ? row.at : timestamp(),
        attempts: Array.isArray(row.attempts) ? row.attempts.filter(value => typeof value === 'string' && value.length < 1024).slice(-16) : [],
        lastAttemptAt: finite(row.lastAttemptAt) ? row.lastAttemptAt : null,
        uncertainTurn: validId(row.uncertainTurn) ? row.uncertainTurn : null,
        attemptTurn: validId(row.attemptTurn) ? row.attemptTurn : null};
    }
    function persist(row) {
      try {
        if (!storage || typeof storage.setItem !== 'function') throw new Error('No durable storage');
        const data = serialize(row), identity = pair(row.host, row.thread);
        // The independent row is authoritative. A different window updating a
        // different task can never overwrite this task's delivery journal.
        storage.setItem(ROW_PREFIX + identity, JSON.stringify({version: 1, ...data}));
        const index = new Map();
        try {
          const saved = JSON.parse(storage.getItem(STORAGE_KEY) || 'null');
          if (saved?.version === 1 && Array.isArray(saved.rows)) for (const item of saved.rows) {
            if (item && validPair(item.host, item.thread)) index.set(pair(item.host, item.thread), serialize(item));
          }
        } catch { /* Independent row keys also support discovery if an index was damaged. */ }
        index.set(identity, data);
        const entries = [...index.values()].sort((a, b) => b.at - a.at).slice(0, MAX_ROWS);
        storage.setItem(STORAGE_KEY, JSON.stringify({version: 1, rows: entries}));
        storageHealthy = true;
        return true;
      } catch {
        storageHealthy = false;
        return false;
      }
    }
    function changed(row, save = true) {
      row.at = timestamp();
      if (save && !persist(row)) { row.status = 'storage-error'; row.reason = 'storage-unavailable'; }
      try { hosts.get(row.host)?.watch?.(row.thread, row.enabled && storageHealthy); } catch {}
      emit(row);
    }
    function clear(row, status, reason = '') {
      row.pending = null; row.epoch++; row.status = row.enabled ? status : 'off'; row.reason = reason;
      changed(row);
    }
    try {
      if (!storage || typeof storage.getItem !== 'function') throw new Error('No durable storage');
      const candidates = new Map(), raw = storage.getItem(STORAGE_KEY);
      let indexInvalid = false;
      if (raw != null && raw !== '') {
        try {
          if (raw.length > 2 * 1024 * 1024) throw new Error('Oversized storage');
          const state = JSON.parse(raw);
          if (state.version !== 1 || !Array.isArray(state.rows)) throw new Error('Unknown storage schema');
          for (const data of state.rows) if (data && validPair(data.host, data.thread)) candidates.set(pair(data.host, data.thread), data);
        } catch { indexInvalid = true; }
      }
      // A shared index can lose an entry under concurrent read/modify/write.
      // Enumerating independent keys recovers those rows without sharing state.
      if (typeof storage.keys === 'function') {
        for (const key of storage.keys()) {
          if (typeof key !== 'string' || !key.startsWith(ROW_PREFIX)) continue;
          try {
            const identity = JSON.parse(key.slice(ROW_PREFIX.length));
            if (Array.isArray(identity) && identity.length === 2 && validPair(...identity) && !candidates.has(pair(...identity)))
              candidates.set(pair(...identity), {host: identity[0], thread: identity[1]});
          } catch { /* Ignore unrelated malformed namespace keys. */ }
        }
      } else if (indexInvalid) throw new Error('Unknown storage schema');
      const authoritative = [];
      for (const [identity, indexed] of candidates) {
        const rowRaw = storage.getItem(ROW_PREFIX + identity);
        let data = indexed;
        if (rowRaw != null) {
          if (rowRaw.length > 64 * 1024) throw new Error('Oversized row journal');
          const journal = JSON.parse(rowRaw);
          if (journal?.version !== 1 || !validPair(journal.host, journal.thread) || pair(journal.host, journal.thread) !== identity)
            throw new Error('Invalid row journal');
          data = journal;
        }
        authoritative.push(data);
      }
      for (const data of authoritative.sort((a, b) => (finite(b.at) ? b.at : 0) - (finite(a.at) ? a.at : 0)).slice(0, MAX_ROWS)) {
          if (!data || !validPair(data.host, data.thread)) continue;
          const row = defaultRow(data.host, data.thread);
          row.enabled = data.enabled === true;
          row.at = finite(data.at) && data.at >= 0 ? data.at : timestamp();
          row.lastAttemptAt = finite(data.lastAttemptAt) && data.lastAttemptAt >= 0 ? data.lastAttemptAt : null;
          row.attempts = Array.isArray(data.attempts) ? data.attempts.filter(value => typeof value === 'string' && value.length < 1024).slice(-16) : [];
          row.uncertainTurn = validId(data.uncertainTurn) ? data.uncertainTurn : null;
          row.attemptTurn = validId(data.attemptTurn) ? data.attemptTurn : null;
          if (row.enabled && data.pending && validId(data.pending.turnId) && finite(data.pending.at) && data.pending.at >= 0)
            row.pending = {turnId: data.pending.turnId, at: data.pending.at};
          row.status = row.enabled ? row.pending ? 'waiting' : 'armed' : 'off';
          if (row.enabled && (data.status === 'sending' || row.uncertainTurn)) {
            row.pending = null; row.status = 'paused'; row.reason = 'unconfirmed-delivery';
            row.uncertainTurn ||= row.attemptTurn;
          }
          rows.set(pair(row.host, row.thread), row);
      }
    } catch { storageHealthy = false; }
    function rowFor(host, thread) {
      const key = pair(host, thread);
      if (!rows.has(key)) rows.set(key, defaultRow(host, thread));
      return rows.get(key);
    }
    function get(host, thread) {
      if (!validPair(host, thread)) return snapshot(defaultRow('', ''));
      return snapshot(rows.get(pair(host, thread)) || defaultRow(host, thread));
    }
    function attach(host, adapter) {
      if (disposed || !validId(host)) return false;
      if (!adapter || !['readLimits', 'inspect', 'resume'].every(name => typeof adapter[name] === 'function'))
        throw new TypeError('Auto-resume adapter requires readLimits, inspect, resume');
      if (hosts.get(host) === adapter) return true;
      const previous = hosts.get(host);
      for (const row of rows.values()) if (row.host === host) {
        try { previous?.watch?.(row.thread, false); } catch {}
      }
      hosts.set(host, adapter);
      for (const row of rows.values()) if (row.host === host) {
        try { adapter.watch?.(row.thread, row.enabled && storageHealthy); } catch {}
      }
      return true;
    }
    function enqueue(row, turnId) {
      if (!row.enabled || !validId(turnId) || row.uncertainTurn === turnId) return;
      if (row.pending?.turnId === turnId) return;
      // New native turns clear the previous pending entry through turn/started.
      // A delayed terminal notification cannot replace another pending turn.
      if (row.pending) return;
      row.epoch++; row.pending = {turnId, at: timestamp()}; row.status = 'waiting'; row.reason = 'quota-exhausted';
      changed(row);
    }
    async function setEnabled(host, thread, enabled) {
      if (disposed || !validPair(host, thread)) return false;
      const row = rowFor(host, thread);
      row.enabled = enabled === true; row.epoch++; row.pending = null;
      row.status = row.enabled ? 'armed' : 'off'; row.reason = ''; row.uncertainTurn = null;
      changed(row);
      if (!row.enabled || !storageHealthy) return !row.enabled;
      const adapter = hosts.get(host), epoch = row.epoch;
      if (!adapter) return true;
      try {
        const info = await adapter.inspect(thread);
        if (disposed || !row.enabled || row.epoch !== epoch || hosts.get(host) !== adapter) return false;
        if (info?.archived) { row.enabled = false; clear(row, 'off', 'archived'); return false; }
        if (info?.loaded && info.status === 'failed' && isUsageLimitError(info.error)) enqueue(row, info.turnId);
      } catch { /* A later live event or tick can recover a temporarily unloaded task. */ }
      return true;
    }
    function notify(host, method, params) {
      if (disposed || !validId(host) || !params || typeof params !== 'object') return;
      if (method === 'account/updated') {
        // Account identity is not available in this protocol notification. Clear
        // pending work instead of sending a prior account's task under a new one.
        for (const row of rows.values()) if (row.host === host && row.enabled && row.pending)
          clear(row, 'paused', 'account-changed');
        return;
      }
      const thread = params.threadId;
      if (!validId(thread)) return;
      const row = rows.get(pair(host, thread));
      if (!row) return;
      if (method === 'thread/archived' || method === 'thread/deleted') {
        row.enabled = false; clear(row, 'off', 'archived'); return;
      }
      if (!row.enabled) return;
      if (method === 'turn/started') {
        row.uncertainTurn = null;
        clear(row, 'running');
      } else if (method === 'turn/completed') {
        const turn = params.turn;
        if (!turn || !validId(turn.id)) return;
        if (turn.status === 'failed' && isUsageLimitError(turn.error)) enqueue(row, turn.id);
        else if (!row.pending || row.pending.turnId === turn.id)
          clear(row, turn.status === 'failed' ? 'paused' : 'armed', turn.status === 'interrupted' ? 'manual-stop' : turn.status === 'failed' ? 'other-error' : '');
      } else if (method === 'error' && validId(params.turnId)) {
        if (isUsageLimitError(params.error)) enqueue(row, params.turnId);
        else if (row.pending?.turnId === params.turnId) clear(row, 'paused', 'other-error');
      }
    }
    function stillCurrent(row, epoch, turnId, adapter) {
      return !disposed && storageHealthy && row.enabled && row.epoch === epoch &&
        row.pending?.turnId === turnId && hosts.get(row.host) === adapter;
    }
    function inspectVerdict(row, info, turnId) {
      if (!info || info.loaded !== true) return 'unloaded';
      if (info.archived) { row.enabled = false; clear(row, 'off', 'archived'); return 'cancelled'; }
      if (info.turnId !== turnId) { clear(row, 'armed', 'task-changed'); return 'cancelled'; }
      if (info.status !== 'failed') {
        clear(row, info.status === 'inProgress' ? 'running' : 'armed', info.status === 'interrupted' ? 'manual-stop' : 'task-changed');
        return 'cancelled';
      }
      if (!isUsageLimitError(info.error)) { clear(row, 'paused', 'other-error'); return 'cancelled'; }
      return info.blocked === true ? 'blocked' : 'ready';
    }
    async function process(row) {
      const adapter = hosts.get(row.host), epoch = row.epoch, turnId = row.pending?.turnId;
      if (!adapter || !turnId || !row.enabled || !storageHealthy) return;
      let first;
      try { first = await adapter.inspect(row.thread); }
      catch { if (stillCurrent(row, epoch, turnId, adapter)) { row.status = 'waiting-task'; row.reason = 'task-unavailable'; changed(row); } return; }
      if (!stillCurrent(row, epoch, turnId, adapter)) return;
      let verdict = inspectVerdict(row, first, turnId);
      if (verdict !== 'ready') {
        if (verdict === 'unloaded' || verdict === 'blocked') { row.status = verdict === 'blocked' ? 'blocked' : 'waiting-task'; row.reason = verdict === 'blocked' ? 'approval-required' : 'task-unavailable'; changed(row); }
        return;
      }
      row.status = 'checking'; row.reason = ''; changed(row);
      if (!stillCurrent(row, epoch, turnId, adapter)) return;
      let quota;
      try { quota = quotaState(await adapter.readLimits()); }
      catch { quota = {ready: false, reason: 'quota-unavailable'}; }
      if (!stillCurrent(row, epoch, turnId, adapter)) return;
      if (!quota.ready) { row.status = 'waiting'; row.reason = quota.reason; changed(row); return; }
      if (row.attempts.includes(quota.fingerprint)) {
        row.status = 'waiting-reset'; row.reason = 'already-attempted-window'; changed(row); return;
      }
      let finalInfo;
      try { finalInfo = await adapter.inspect(row.thread); }
      catch { if (stillCurrent(row, epoch, turnId, adapter)) { row.status = 'waiting-task'; row.reason = 'task-unavailable'; changed(row); } return; }
      if (!stillCurrent(row, epoch, turnId, adapter)) return;
      verdict = inspectVerdict(row, finalInfo, turnId);
      if (verdict !== 'ready') {
        if (verdict === 'unloaded' || verdict === 'blocked') { row.status = verdict === 'blocked' ? 'blocked' : 'waiting-task'; row.reason = verdict === 'blocked' ? 'approval-required' : 'task-unavailable'; changed(row); }
        return;
      }
      row.attempts.push(quota.fingerprint); row.attempts = row.attempts.slice(-16);
      row.attemptTurn = turnId; row.status = 'sending'; row.reason = ''; row.lastAttemptAt = timestamp();
      // This write is the delivery journal. Never call the transport before it succeeds.
      changed(row);
      if (!stillCurrent(row, epoch, turnId, adapter)) return;
      let accepted = false;
      try {
        const result = await adapter.resume(row.thread, turnId);
        accepted = result === true || result?.status === 'accepted';
      } catch { /* Even a connection error may follow an accepted turn. Do not retry blindly. */ }
      if (disposed || row.epoch !== epoch || !row.enabled) return;
      row.pending = null;
      if (accepted) { row.status = 'armed'; row.reason = 'resumed'; row.uncertainTurn = null; }
      else { row.status = 'paused'; row.reason = 'unconfirmed-delivery'; row.uncertainTurn = turnId; }
      changed(row);
    }
    async function runTick() {
      if (disposed || !storageHealthy) return;
      // Sequential submission makes each task re-read quota after the previous
      // task was accepted, rather than starting every pending task in a burst.
      for (const row of rows.values()) {
        if (disposed || !storageHealthy) break;
        if (row.enabled && row.pending && row.status !== 'sending') await process(row);
      }
    }
    function tick() {
      if (tickPromise) return tickPromise;
      tickPromise = runTick().finally(() => { tickPromise = null; });
      return tickPromise;
    }
    function dispose() {
      disposed = true;
      for (const row of rows.values()) { try { hosts.get(row.host)?.watch?.(row.thread, false); } catch {} }
      hosts.clear();
    }
    function canResume(host, thread, turnId) {
      const row = validPair(host, thread) ? rows.get(pair(host, thread)) : null;
      return !disposed && storageHealthy && !!row?.enabled && row.status === 'sending' && row.pending?.turnId === turnId;
    }
    return Object.freeze({attach, setEnabled, get, notify, tick, canResume, dispose});
  }
  return Object.freeze({createAutoResume, isUsageLimitError, quotaState, STORAGE_KEY, ROW_PREFIX});
});
