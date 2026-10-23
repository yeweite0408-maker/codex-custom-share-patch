/* Native settings panel content. User-selected files remain on this device. */
(() => {
  'use strict';
  if (customElements.get('codex-wallpaper-settings')) return;
  const ranges = [
    {key: 'brightness', label: '壁纸亮度', min: 20, max: 150, scale: 100, suffix: '%'},
    {key: 'overlay', label: '背景遮罩', min: 0, max: 90, scale: 100, suffix: '%'},
    {key: 'mediaOpacity', label: '壁纸不透明度', min: 5, max: 100, scale: 100, suffix: '%'},
    {key: 'composerOpacity', label: '输入框透明度', min: 0, max: 90, scale: 100, inverse: true, suffix: '%'},
    {key: 'composerBlur', label: '毛玻璃模糊', min: 0, max: 40, scale: 1, suffix: ' px'},
  ];
  class WallpaperSettings extends HTMLElement {
    connectedCallback() {
      if (this.initialized) return;
      this.initialized = true; this.controls = new Map(); this.saveGeneration = 0;
      const api = globalThis.CodexWallpaperSettings;
      this.api = api;
      const header = document.createElement('h3'); header.textContent = '动态背景';
      const summary = document.createElement('p'); summary.className = 'wallpaper-description'; summary.textContent = '选择本地图片或视频，调整后立即保存。背景文件只保存在此设备。';
      this.error = document.createElement('p'); this.error.className = 'wallpaper-error'; this.error.setAttribute('role', 'alert'); this.error.hidden = true;
      this.status = document.createElement('p'); this.status.className = 'wallpaper-status'; this.status.setAttribute('role', 'status');
      const enabledRow = document.createElement('label'); enabledRow.className = 'wallpaper-setting-row';
      const enabledLabel = document.createElement('span'); enabledLabel.textContent = '启用动态背景';
      this.enabled = document.createElement('input'); this.enabled.type = 'checkbox'; this.enabled.setAttribute('aria-label', '启用动态背景');
      this.enabled.addEventListener('change', () => { void this.save({enabled: this.enabled.checked}); });
      enabledRow.append(enabledLabel, this.enabled);
      const pickerRow = document.createElement('div'); pickerRow.className = 'wallpaper-picker-row';
      this.file = document.createElement('input'); this.file.type = 'file'; this.file.accept = 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm'; this.file.hidden = true; this.file.setAttribute('aria-label', '选择图片或视频');
      this.choose = document.createElement('button'); this.choose.type = 'button'; this.choose.textContent = '选择图片或视频'; this.choose.addEventListener('click', () => this.file.click());
      this.resetButton = document.createElement('button'); this.resetButton.type = 'button'; this.resetButton.textContent = '恢复默认'; this.resetButton.addEventListener('click', () => { void this.reset(); });
      this.file.addEventListener('change', () => { const selected = this.file.files?.[0]; this.file.value = ''; if (selected) void this.import(selected); });
      pickerRow.append(this.choose, this.resetButton, this.file);
      this.current = document.createElement('p'); this.current.className = 'wallpaper-current';
      const support = document.createElement('p'); support.className = 'wallpaper-description'; support.textContent = '支持 JPEG、PNG、WebP、GIF、MP4、WebM，单个文件最大 150 MB。视频静音循环播放。';
      const fields = document.createElement('div'); fields.className = 'wallpaper-fields';
      for (const field of ranges) {
        const label = document.createElement('label'); label.className = 'wallpaper-range-row';
        const name = document.createElement('span'); name.textContent = field.label;
        const input = document.createElement('input'); input.type = 'range'; input.min = String(field.min); input.max = String(field.max); input.step = '1'; input.setAttribute('aria-label', field.label);
        const output = document.createElement('output'); output.className = 'wallpaper-range-value';
        input.addEventListener('input', () => {
          const displayed = Number(input.value); output.textContent = `${displayed}${field.suffix}`;
          const value = field.inverse ? 1 - displayed / field.scale : displayed / field.scale;
          void this.save({[field.key]: value});
        });
        label.append(name, input, output); fields.append(label); this.controls.set(field.key, {field, input, output});
      }
      this.append(header, summary, enabledRow, pickerRow, this.current, support, fields, this.error, this.status);
      if (!api) {
        this.showError(new Error('动态背景设置尚未加载，请重新打开 Codex。')); this.setBusy(true); this.enabled.disabled = true;
        for (const {input} of this.controls.values()) input.disabled = true;
        return;
      }
      this.unsubscribe = api.subscribe(config => this.render(config));
      this.render(api.getConfig());
      api.ready.then(config => { if (this.isConnected) this.render(config); }).catch(error => this.showError(error));
    }
    disconnectedCallback() { this.unsubscribe?.(); this.initialized = false; this.replaceChildren(); }
    setBusy(value) { this.busy = value; this.choose.disabled = value; this.resetButton.disabled = value; this.setAttribute('aria-busy', String(value)); }
    showError(error) { this.error.textContent = error?.message || '保存失败，请重试。'; this.error.hidden = false; this.status.textContent = ''; }
    clearError() { this.error.hidden = true; this.error.textContent = ''; }
    render(config) {
      this.enabled.checked = config.enabled;
      this.current.textContent = `当前文件：${config.source === 'custom' ? config.fileName || '本地背景' : '默认背景'}`;
      for (const {field, input, output} of this.controls.values()) {
        const value = Math.round((field.inverse ? 1 - config[field.key] : config[field.key]) * field.scale);
        if (document.activeElement !== input) input.value = String(value);
        output.textContent = `${document.activeElement === input ? input.value : value}${field.suffix}`;
      }
    }
    async save(patch) {
      const generation = ++this.saveGeneration;
      this.clearError(); this.status.textContent = '正在保存…';
      try { await this.api.setConfig(patch); if (generation === this.saveGeneration) this.status.textContent = '已保存'; }
      catch (error) { if (generation === this.saveGeneration) { this.render(this.api.getConfig()); this.showError(error); } }
    }
    async import(file) {
      this.clearError(); this.setBusy(true); this.status.textContent = '正在读取并保存背景…';
      try { await this.api.importFile(file); this.status.textContent = '背景已保存'; }
      catch (error) { this.showError(error); }
      finally { this.setBusy(false); this.render(this.api.getConfig()); }
    }
    async reset() {
      this.clearError(); this.setBusy(true); this.status.textContent = '正在恢复默认…';
      try { await this.api.reset(); this.status.textContent = '已恢复默认'; }
      catch (error) { this.showError(error); }
      finally { this.setBusy(false); this.render(this.api.getConfig()); }
    }
  }
  customElements.define('codex-wallpaper-settings', WallpaperSettings);
})();
