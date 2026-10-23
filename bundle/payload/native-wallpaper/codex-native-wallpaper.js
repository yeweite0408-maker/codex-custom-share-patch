/* One local image/video layer for the whole Codex application window. */
(() => {
  "use strict";
  const id = "codex-native-wallpaper";
  const marker = "data-codex-native-wallpaper";
  if (document.getElementById(id)) return;
  const root = document.documentElement;
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const layer = document.createElement("div");
  layer.id = id;
  layer.setAttribute("aria-hidden", "true");
  layer.inert = true;
  const settings = globalThis.CodexWallpaperSettings;
  let config = {enabled:true, source:'builtin', brightness:1, overlay:.64, mediaOpacity:1, composerOpacity:.52, composerBlur:22};
  let media = null, mediaKind = null, mediaUrl = null, candidate = null, generation = 0;
  let ready = false;
  let scheduled = false;
  let playPending = false;
  const isActive = () => ready && config.enabled && !(motion.matches && mediaKind === 'video');
  const clearWindowPaint = () => {
    if (!isActive()) return;
    // Clear only large layout paint behind the UI. Menus, dialogs, editors and
    // message content retain their native surfaces, regardless of theme tokens.
    const protectedSelector = 'button,input,textarea,select,pre,code,[contenteditable="true"],[role="dialog"],[role="menu"],[aria-modal="true"],.monaco-editor,[data-codex-composer-root],[class*="_ComposerLayoutRoot_"]';
    const points = [[.03,.5],[.18,.5],[.5,.35],[.85,.35],[.5,.85]];
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      const candidates = new Set();
      for (const [x,y] of points)
        for (const element of document.elementsFromPoint(innerWidth*x,innerHeight*y)) candidates.add(element);
      for (const element of candidates) {
        if (element === root || element === document.body || layer.contains(element) ||
            element.hasAttribute('data-codex-wallpaper-surface') || element.closest(protectedSelector)) continue;
        const thread = element.closest('.thread-scroll-container');
        if (thread && thread !== element) continue;
        const rect = element.getBoundingClientRect();
        const large = rect.width*rect.height > innerWidth*innerHeight*.5 ||
          (rect.height > innerHeight*.8 && rect.width > 40 && rect.width < innerWidth*.4);
        if (!large) continue;
        const style = getComputedStyle(element);
        if (style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.backgroundImage === 'none') continue;
        element.setAttribute('data-codex-wallpaper-surface','clear');
        changed = true;
      }
      if (!changed) break;
    }
  };
  const markComposerGlass = () => {
    for (const bar of document.querySelectorAll('[data-composer-utility-bar-scroll-area]')) {
      if (bar.closest('[role="dialog"],[role="menu"]')) continue;
      const barRect = bar.getBoundingClientRect();
      if (!barRect.width || !barRect.height) continue;
      let panel = bar;
      for (let depth = 0; panel && depth < 6; depth++, panel = panel.parentElement) {
        if (panel.matches('[data-codex-composer-root]')) break;
        const rect = panel.getBoundingClientRect();
        if (rect.height > Math.max(96, barRect.height * 2.2)) continue;
        const style = getComputedStyle(panel);
        const painted = style.backgroundColor !== 'rgba(0, 0, 0, 0)' || style.backgroundImage !== 'none';
        if (painted && rect.width >= barRect.width * .9) {
          panel.setAttribute('data-codex-composer-glass','utility');
          break;
        }
      }
    }
  };
  const report = (state, message = '') => dispatchEvent(new CustomEvent('codex-wallpaper-player-status', {detail:{state, message}}));
  const pause = element => { if (element?.tagName === 'VIDEO') element.pause(); };
  const revoke = url => { if (url?.startsWith('blob:')) URL.revokeObjectURL(url); };
  const restore = () => { root.removeAttribute(marker); pause(media); };
  const changeMedia = async () => {
    const token = ++generation;
    if (candidate) { pause(candidate.element); candidate.element.removeAttribute('src'); revoke(candidate.url); candidate = null; }
    let kind = 'video', url;
    try {
      if (config.source === 'custom') {
        const stored = await settings?.getMedia();
        if (token !== generation) return;
        if (!stored?.blob || !['image','video'].includes(stored.kind)) throw new Error('已保存的背景文件不可用，请重新选择。');
        kind = stored.kind; url = URL.createObjectURL(stored.blob);
      } else {
        if (root.getAttribute('data-codex-wallpaper-builtin') === 'false') {
          pause(media); revoke(mediaUrl); media = null; mediaUrl = null; mediaKind = null; ready = false;
          layer.replaceChildren(); root.removeAttribute('data-codex-wallpaper-kind'); restore(); report('empty'); return;
        }
        url = new URL('./assets/codex-native-wallpaper.mp4', document.baseURI).href;
      }
      const next = document.createElement(kind === 'image' ? 'img' : 'video');
      next.setAttribute('aria-hidden','true'); next.tabIndex = -1;
      if (kind === 'video') {
        Object.assign(next, {muted:true,defaultMuted:true,volume:0,autoplay:false,loop:true,playsInline:true,
          preload:'auto',disablePictureInPicture:true,disableRemotePlayback:true});
        next.setAttribute('muted',''); next.setAttribute('playsinline','');
      } else { next.alt = ''; next.decoding = 'async'; }
      candidate = {element:next, url};
      next.addEventListener(kind === 'image' ? 'load' : 'loadeddata', () => {
        if (token !== generation) { pause(next); revoke(url); return; }
        pause(media); const oldUrl = mediaUrl;
        media = next; mediaKind = kind; mediaUrl = url; candidate = null; ready = true;
        layer.replaceChildren(next); revoke(oldUrl); root.setAttribute('data-codex-wallpaper-kind',kind);
        report('ready'); schedule();
      }, {once:true});
      next.addEventListener('error', () => {
        if (token !== generation) return;
        if (media === next) { ready = false; restore(); }
        else { revoke(url); candidate = null; }
        report('error','背景加载失败，请选择浏览器支持的图片或视频。');
      });
      next.src = url;
    } catch (error) {
      if (token === generation) report('error',error.message || '无法读取背景文件。');
    }
  };
  const updateConfig = (next, mediaChanged = false) => {
    const changed = next.source !== config.source;
    config = {...config,...next};
    root.style.setProperty('--codex-wallpaper-brightness',String(config.brightness));
    root.style.setProperty('--codex-wallpaper-overlay',`${config.overlay * 100}%`);
    root.style.setProperty('--codex-wallpaper-opacity',String(config.mediaOpacity));
    root.style.setProperty('--codex-user-composer-opacity',`${config.composerOpacity * 100}%`);
    root.style.setProperty('--codex-user-toolbar-opacity',`${Math.max(.1,config.composerOpacity - .12) * 100}%`);
    root.style.setProperty('--codex-user-composer-blur',`${config.composerBlur}px`);
    if (changed || mediaChanged || (!media && !candidate)) void changeMedia();
    schedule();
  };
  const reconcile = () => {
    scheduled = false;
    if (!document.body) return;
    // Outside the React root, so navigation cannot destroy or resize the player.
    if (layer.parentElement !== document.body) document.body.prepend(layer);
    if (!isActive()) { restore(); return; }
    root.setAttribute(marker, "ready"); clearWindowPaint(); markComposerGlass();
    if (document.hidden) pause(media);
    else if (mediaKind === 'video' && media.paused && !playPending) {
      playPending = true;
      const current = media, attempt = current.play();
      if (attempt) attempt.catch(error => {
        if (error.name !== 'AbortError' && current === media && !document.hidden && !motion.matches) {
          ready = false; restore(); report('error','视频无法播放，请重新选择背景。');
        }
      }).finally(() => { playPending = false; if (current !== media) schedule(); });
      else playPending = false;
    }
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(reconcile);
  };
  const observer = new MutationObserver(records => {
    if (layer.parentElement !== document.body) { schedule(); return; }
    // Ignore streaming text. Rescan only when a new native layout is mounted.
    const layout = 'main,aside,nav,[role="main"],[data-app-shell-frame],[data-app-shell-main-surface],[class*="_Workspace"],[class*="_PageSurface"],[class*="bg-token-bg-primary"],[data-codex-composer-root],[data-composer-utility-bar-scroll-area]';
    for (const record of records) for (const node of record.addedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE && !layer.contains(node) &&
          (node.matches(layout) || node.querySelector(layout))) { schedule(); return; }
    }
  });
  const initialize = () => {
    observer.observe(document.body, { childList: true, subtree: true });
    if (settings) {
      settings.subscribe(updateConfig);
      settings.ready.then(() => updateConfig(settings.getConfig(),true)).catch(() => updateConfig(config,true));
    } else updateConfig(config,true);
    schedule();
  };
  document.addEventListener("visibilitychange", schedule);
  motion.addEventListener("change", schedule);
  if (document.body) initialize();
  else document.addEventListener("DOMContentLoaded", initialize, { once: true });
})();
