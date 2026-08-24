const { BrowserWindow } = require('electron');

const clean = (value, fallback = '') => String(value || fallback).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300);

class MediaController {
  constructor({ onState, getOutputPreference, setOutputPreference }) {
    this.onState = onState;
    this.getOutputPreference = getOutputPreference;
    this.setOutputPreference = setOutputPreference;
    this.window = null;
    this.pollTimer = null;
    this.outputRetryTimers = [];
    this.syncTimers = [];
    this.activeOutputDeviceId = 'default';
  }

  ensureWindow() {
    if (this.window && !this.window.isDestroyed()) return this.window;
    this.window = new BrowserWindow({
      show: false,
      width: 1000,
      height: 700,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.window.webContents.setAudioMuted(false);
    this.window.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(webContents === this.window?.webContents && permission === 'speaker-selection');
    });
    this.window.webContents.on('did-start-loading', () => this.onState({ ready: false, playing: false, ended: false, title: '正在打开网页…', artist: '请稍候' }));
    this.window.webContents.on('did-fail-load', (_event, code, description) => {
      if (code !== -3) this.onState({ ready: false, title: '网页加载失败', artist: description });
    });
    this.window.on('closed', () => { this.window = null; this.stopPolling(); });
    return this.window;
  }

  mediaScript(action = '') {
    return `(() => {
      const media = [...document.querySelectorAll('video, audio')].find(el => Number.isFinite(el.duration) && el.duration > 0) || document.querySelector('video, audio');
      ${action}
      if (!media) return null;
      const meta = name => document.querySelector('meta[property="' + name + '"],meta[name="' + name + '"]')?.getAttribute('content') || '';
      const clean = value => String(value || '').replace(/_哔哩哔哩_bilibili$/i, '').trim();
      let cover = meta('og:image');
      if (cover.startsWith('//')) cover = 'https:' + cover;
      return {
        ready: media.readyState > 0,
        playing: !media.paused && !media.ended,
        ended: Boolean(media.ended),
        currentTime: Number(media.currentTime) || 0,
        duration: Number(media.duration) || 0,
        volume: Number(media.volume),
        muted: Boolean(media.muted),
        sinkId: typeof media.sinkId === 'string' ? media.sinkId : '',
        title: clean(document.querySelector('h1.video-title, h1')?.textContent) || clean(meta('og:title')) || clean(document.title) || '网页音频',
        artist: clean(document.querySelector('.up-name, .up-info-container .name, [class*="author"]')?.textContent) || clean(meta('author')) || location.hostname,
        cover
      };
    })()`;
  }

  async run(action = '') {
    if (!this.window || this.window.isDestroyed()) return null;
    try { return await this.window.webContents.executeJavaScript(this.mediaScript(action), true); }
    catch { return null; }
  }

  async action(code) {
    const state = await this.run(code);
    if (state) this.onState(state);
    return state;
  }

  startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(async () => {
      const state = await this.run();
      if (state) this.onState(state);
    }, 500);
  }

  stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async load(url) {
    await this.ensureWindow().loadURL(url);
    this.startPolling();
    this.applyPreferredOutput();
  }

  toggle() { this.cancelSyncPlayback(); return this.action(`if (media) { if (media.paused) media.play().catch(() => {}); else media.pause(); }`); }
  seek(time) { this.cancelSyncPlayback(); return this.action(`if (media) media.currentTime = Math.max(0, Math.min(media.duration || 0, ${Number(time) || 0}));`); }
  skip(delta) { this.cancelSyncPlayback(); return this.action(`if (media) media.currentTime = Math.max(0, Math.min(media.duration || 0, media.currentTime + ${Number(delta) || 0}));`); }
  volume(value) { return this.action(`if (media) { media.volume = ${Math.max(0, Math.min(1, Number(value) || 0))}; media.muted = false; }`); }
  mute() { return this.action(`if (media) media.muted = !media.muted;`); }

  syncPlayback({ position = 0, playing = false }) {
    this.cancelSyncPlayback();
    const code = `if (media) {
      media.currentTime = Math.max(0, Math.min(media.duration || ${Number(position) || 0}, ${Number(position) || 0}));
      if (${Boolean(playing)}) media.play().catch(() => {}); else media.pause();
    }`;
    const apply = () => this.action(code);
    apply();
    this.syncTimers = [650, 1600, 3200].map(delay => setTimeout(apply, delay));
  }

  cancelSyncPlayback() {
    this.syncTimers.forEach(clearTimeout);
    this.syncTimers = [];
  }

  getCurrentUrl() { return this.window?.webContents.getURL() || ''; }

  async listOutputs() {
    if (!this.window || this.window.isDestroyed() || !this.getCurrentUrl().startsWith('http')) {
      return { ok: false, message: '请先载入一个网页', devices: [] };
    }
    try {
      const devices = await this.window.webContents.executeJavaScript(`(async () => {
        if (!navigator.mediaDevices?.enumerateDevices) return [];
        const all = await navigator.mediaDevices.enumerateDevices();
        return all.filter(device => device.kind === 'audiooutput').map((device, index) => ({
          deviceId: device.deviceId,
          groupId: device.groupId,
          label: device.label || (device.deviceId === 'default' ? '系统默认' : '音频设备 ' + (index + 1))
        }));
      })()`, true);
      const unique = [];
      const seen = new Set();
      for (const device of devices) {
        if (!device?.deviceId || seen.has(device.deviceId)) continue;
        seen.add(device.deviceId);
        unique.push(device);
      }
      if (!unique.some(device => device.deviceId === 'default')) unique.unshift({ deviceId: 'default', groupId: '', label: '系统默认' });
      return { ok: true, devices: unique, selectedDeviceId: this.activeOutputDeviceId };
    } catch (error) {
      return { ok: false, message: `无法读取输出设备：${error.message}`, devices: [] };
    }
  }

  async selectOutput(deviceId, label, remember = true) {
    if (!this.window || this.window.isDestroyed()) return { ok: false, message: '请先载入一个网页' };
    const sinkId = clean(deviceId, 'default');
    try {
      const result = await this.window.webContents.executeJavaScript(`(async () => {
        const elements = [...document.querySelectorAll('video, audio')];
        if (!elements.length) return { ok: false, waiting: true, message: '媒体仍在载入' };
        if (typeof elements[0].setSinkId !== 'function') return { ok: false, unsupported: true, message: '这个网页不支持应用内切换输出设备' };
        await Promise.all(elements.map(element => element.setSinkId(${JSON.stringify(sinkId)})));
        return { ok: true };
      })()`, true);
      if (result.ok || result.waiting) {
        this.activeOutputDeviceId = sinkId;
        if (remember) await this.setOutputPreference({ deviceId: sinkId, label: clean(label, sinkId === 'default' ? '系统默认' : '音频设备') });
        if (result.waiting && remember) this.scheduleOutputRetries(sinkId, label);
      }
      return result.waiting ? { ...result, ok: true, pending: true } : result;
    } catch (error) {
      return { ok: false, message: `切换失败：${error.message}` };
    }
  }

  scheduleOutputRetries(deviceId, label) {
    this.outputRetryTimers.forEach(clearTimeout);
    this.outputRetryTimers = [700, 1800, 4000].map(delay => setTimeout(() => this.selectOutput(deviceId, label, false), delay));
  }

  async applyPreferredOutput() {
    const listed = await this.listOutputs();
    if (!listed.ok) return listed;
    const preference = this.getOutputPreference();
    const preferred = listed.devices.find(device => device.deviceId === preference.deviceId)
      || listed.devices.find(device => preference.label && device.label === preference.label)
      || listed.devices.find(device => device.deviceId === 'default')
      || listed.devices[0];
    if (!preferred) return { ok: false, message: '没有可用的输出设备' };
    this.activeOutputDeviceId = preferred.deviceId;
    const result = await this.selectOutput(preferred.deviceId, preferred.label, false);
    if (result.waiting) this.scheduleOutputRetries(preferred.deviceId, preferred.label);
    return result;
  }

  dispose() {
    this.stopPolling();
    this.outputRetryTimers.forEach(clearTimeout);
    this.cancelSyncPlayback();
  }
}

module.exports = { MediaController };
