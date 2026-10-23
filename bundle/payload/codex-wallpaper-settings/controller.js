/* Local wallpaper preferences. Media stays in IndexedDB, never in settings JSON. */
(function(root, factory) {
  const library = factory();
  if (typeof module === 'object' && module.exports) module.exports = library;
  else if (!root.CodexWallpaperSettings) root.CodexWallpaperSettings = library.createWallpaperSettings(root);
})(globalThis, function() {
  'use strict';
  const CACHE_KEY = 'codex-wallpaper-settings:v1';
  const CHANNEL = 'codex-wallpaper-settings:v1';
  const DATABASE = 'codex-wallpaper-settings';
  const MAX_BYTES = 150 * 1024 * 1024;
  const DEFAULTS = Object.freeze({enabled: true, source: 'builtin', fileName: null,
    brightness: 1, overlay: 0.64, mediaOpacity: 1, composerOpacity: 0.52, composerBlur: 22});
  const RANGES = Object.freeze({brightness: [0.2, 1.5], overlay: [0, 0.9], mediaOpacity: [0.05, 1], composerOpacity: [0.1, 1], composerBlur: [0, 40]});
  const MIME = Object.freeze({'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image', 'image/gif': 'image', 'video/mp4': 'video', 'video/webm': 'video'});
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  function sanitizeConfig(input, base = DEFAULTS) {
    const result = {...base};
    if (!input || typeof input !== 'object') return result;
    if (typeof input.enabled === 'boolean') result.enabled = input.enabled;
    if (input.source === 'builtin' || input.source === 'custom') result.source = input.source;
    if (typeof input.fileName === 'string') result.fileName = input.fileName.replace(/[\u0000-\u001f]/g, '').slice(0, 255) || null;
    else if (input.fileName === null) result.fileName = null;
    for (const [name, [min, max]] of Object.entries(RANGES)) if (finite(input[name])) result[name] = Math.min(max, Math.max(min, input[name]));
    if (result.source === 'builtin') result.fileName = null;
    return result;
  }
  function editablePatch(input) {
    const patch = {};
    if (!input || typeof input !== 'object') return patch;
    if (typeof input.enabled === 'boolean') patch.enabled = input.enabled;
    for (const name of Object.keys(RANGES)) if (finite(input[name])) patch[name] = input[name];
    return patch;
  }
  function friendlyError(error) {
    if (error?.name === 'QuotaExceededError') return new Error('本地存储空间不足，请选择更小的图片或视频。');
    if (error?.name === 'SecurityError' || error?.name === 'InvalidStateError') return new Error('当前窗口无法使用本地背景存储，请重新打开 Codex 后重试。');
    return error instanceof Error ? error : new Error('背景保存失败，请重试。');
  }
  async function inspectFile(file, maxBytes = MAX_BYTES) {
    if (!file || typeof file.slice !== 'function' || !finite(file.size) || file.size <= 0) throw new Error('请选择有效的图片或视频文件。');
    if (file.size > maxBytes) throw new Error('背景文件不能超过 150 MB，请选择更小的文件。');
    const declared = (file.type || '').toLowerCase();
    if (declared && !MIME[declared]) throw new Error('仅支持 JPEG、PNG、WebP、GIF 图片和 MP4、WebM 视频。');
    const bytes = new Uint8Array(await file.slice(0, 64).arrayBuffer());
    const text = (start, end) => String.fromCharCode(...bytes.slice(start, end));
    let mime = null;
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) mime = 'image/jpeg';
    else if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)) mime = 'image/png';
    else if (['GIF87a', 'GIF89a'].includes(text(0, 6))) mime = 'image/gif';
    else if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') mime = 'image/webp';
    else if (text(4, 8) === 'ftyp') mime = 'video/mp4';
    else if ([0x1a, 0x45, 0xdf, 0xa3].every((n, i) => bytes[i] === n)) mime = 'video/webm';
    if (!mime || (declared && declared !== mime)) throw new Error('文件内容与图片或视频格式不符，未更换原背景。');
    return {kind: MIME[mime], mime};
  }
  function validateMedia(env, blob, kind) {
    return new Promise((resolve, reject) => {
      let url, element, timer, finished = false;
      const finish = error => {
        if (finished) return; finished = true;
        if (timer) env.clearTimeout(timer);
        if (element) {
          element.onload = element.onerror = element.onloadeddata = null;
          if (kind === 'video') { element.pause(); element.removeAttribute('src'); element.load(); }
        }
        if (url) env.URL.revokeObjectURL(url);
        error ? reject(error) : resolve();
      };
      try {
        url = env.URL.createObjectURL(blob);
        element = env.document.createElement(kind === 'video' ? 'video' : 'img');
        element.onerror = () => finish(new Error('Codex 无法解码此文件，请改用受支持的图片或 H.264 MP4 / WebM 视频。'));
        timer = env.setTimeout(() => finish(new Error('读取背景文件超时，原背景保持不变。')), 15000);
        if (kind === 'video') {
          element.muted = true; element.preload = 'auto';
          element.onloadeddata = () => finish(element.videoWidth > 0 && element.videoHeight > 0 ? null : new Error('视频没有可显示的画面。'));
          element.src = url; element.load();
        } else {
          element.onload = () => finish(element.naturalWidth > 0 && element.naturalHeight > 0 ? null : new Error('图片内容无效。'));
          element.src = url;
        }
      } catch (error) { finish(friendlyError(error)); }
    });
  }
  function createIndexedStore(indexedDB, randomId) {
    let database;
    const open = () => database || (database = new Promise((resolve, reject) => {
      if (!indexedDB) { reject(new Error('当前窗口不支持本地背景存储。')); return; }
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('kv')) request.result.createObjectStore('kv'); };
      request.onerror = () => { database = null; reject(request.error); };
      request.onblocked = () => { database = null; reject(new Error('背景存储正在被旧窗口占用，请关闭旧窗口后重试。')); };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); database = null; };
        resolve(db);
      };
    }));
    async function readState() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readonly'), store = tx.objectStore('kv');
        let record = null, media = null;
        const configRequest = store.get('settings'), mediaRequest = store.get('active');
        configRequest.onsuccess = () => { record = configRequest.result; };
        mediaRequest.onsuccess = () => { media = mediaRequest.result; };
        tx.oncomplete = () => {
          const config = sanitizeConfig(record?.config);
          const usable = media?.blob && ['image', 'video'].includes(media.kind) && media.id === record?.mediaId;
          if (config.source === 'custom' && !usable) { config.source = 'builtin'; config.fileName = null; }
          resolve({config, mediaId: usable && config.source === 'custom' ? media.id : null});
        };
        tx.onabort = tx.onerror = () => reject(tx.error || new Error('无法读取背景设置。'));
      });
    }
    async function readMedia(expectedId) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readonly'), request = tx.objectStore('kv').get('active');
        let value;
        request.onsuccess = () => { value = request.result; };
        tx.oncomplete = () => resolve(value?.id === expectedId && value?.blob ? {blob: value.blob, kind: value.kind} : null);
        tx.onabort = tx.onerror = () => reject(tx.error || new Error('无法读取背景文件。'));
      });
    }
    async function write(operation, value) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite'), store = tx.objectStore('kv'), read = store.get('settings');
        let result;
        read.onsuccess = () => {
          try {
            const previous = read.result, config = operation === 'reset' ? {...DEFAULTS} : sanitizeConfig(previous?.config);
            let mediaId = previous?.mediaId ?? null;
            if (operation === 'config') Object.assign(config, sanitizeConfig(value, config));
            else if (operation === 'media') {
              mediaId = randomId();
              config.enabled = true; config.source = 'custom'; config.fileName = value.fileName;
              store.put({id: mediaId, blob: value.blob, kind: value.kind}, 'active');
            } else if (operation === 'reset') { mediaId = null; store.delete('active'); }
            result = {config, mediaId}; store.put(result, 'settings');
          } catch (error) { tx.abort(); reject(error); }
        };
        tx.oncomplete = () => resolve(result);
        tx.onabort = tx.onerror = () => reject(tx.error || new Error('背景设置保存失败，原背景保持不变。'));
      });
    }
    return {readState, readMedia, updateConfig: patch => write('config', patch), replaceMedia: media => write('media', media), reset: () => write('reset')};
  }
  function createWallpaperSettings(env = globalThis, options = {}) {
    const randomId = () => env.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const store = options.store || createIndexedStore(env.indexedDB, randomId);
    const subscribers = new Set();
    let current = {...DEFAULTS}, mediaId = null, serial = Promise.resolve(), disposed = false, refreshSerial = 0;
    let channel = null;
    try {
      const cached = JSON.parse(env.localStorage?.getItem(CACHE_KEY) || 'null');
      if (cached?.version === 1) current = sanitizeConfig(cached.config);
    } catch {}
    const getConfig = () => Object.freeze({...current});
    function accept(state, notify = true) {
      const previousMedia = mediaId;
      current = sanitizeConfig(state?.config); mediaId = state?.mediaId || null;
      if (current.source === 'custom' && !mediaId) { current.source = 'builtin'; current.fileName = null; }
      if (notify) for (const listener of subscribers) { try { listener(getConfig(), previousMedia !== mediaId); } catch {} }
      return getConfig();
    }
    function announce(state) {
      accept(state);
      const cache = {version: 1, config: getConfig(), revision: randomId()};
      try { env.localStorage?.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* IndexedDB already committed. */ }
      try { channel?.postMessage({version: 1, revision: cache.revision}); } catch {}
      return getConfig();
    }
    const ready = Promise.resolve().then(() => store.readState()).then(state => accept(state)).catch(error => { throw friendlyError(error); });
    ready.catch(() => {});
    const enqueue = operation => {
      const result = serial.then(() => ready).then(() => { if (disposed) throw new Error('背景设置窗口已关闭。'); return operation(); }).catch(error => { throw friendlyError(error); });
      serial = result.catch(() => {}); return result;
    };
    async function refresh() {
      const sequence = ++refreshSerial;
      try { await serial; const state = await store.readState(); if (!disposed && sequence === refreshSerial) accept(state); } catch {}
    }
    const storageListener = event => { if (event.key === CACHE_KEY || event.key === null) void refresh(); };
    try { channel = new env.BroadcastChannel(CHANNEL); channel.onmessage = event => { if (event.data?.version === 1) void refresh(); }; } catch {}
    env.addEventListener?.('storage', storageListener);
    env.addEventListener?.('focus', refresh);
    const api = {
      ready, getConfig,
      getMedia: async () => { await ready; if (current.source !== 'custom' || !mediaId) return null; return store.readMedia(mediaId); },
      subscribe(listener) { if (typeof listener !== 'function') throw new TypeError('subscribe requires a function'); subscribers.add(listener); return () => subscribers.delete(listener); },
      setConfig: patch => enqueue(async () => announce(await store.updateConfig(editablePatch(patch)))),
      importFile: file => enqueue(async () => {
        const info = await inspectFile(file, options.maxBytes || MAX_BYTES);
        await (options.validateMedia || ((blob, kind) => validateMedia(env, blob, kind)))(file, info.kind);
        const fileName = typeof file.name === 'string' ? file.name.replace(/[\u0000-\u001f]/g, '').slice(0, 255) : info.kind === 'video' ? '本地视频' : '本地图片';
        return announce(await store.replaceMedia({blob: file, kind: info.kind, fileName}));
      }),
      reset: () => enqueue(async () => announce(await store.reset())),
      dispose() { disposed = true; subscribers.clear(); channel?.close(); env.removeEventListener?.('storage', storageListener); env.removeEventListener?.('focus', refresh); },
    };
    return Object.freeze(api);
  }
  return Object.freeze({createWallpaperSettings, createIndexedStore, sanitizeConfig, inspectFile, DEFAULTS, RANGES, MAX_BYTES, CACHE_KEY});
});
