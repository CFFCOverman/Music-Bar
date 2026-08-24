const { BrowserWindow } = require('electron');
const { isIP } = require('net');
const { normalizeUrl } = require('./store.cjs');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function safeAutomaticUrl(raw) {
  const normalized = normalizeUrl(raw);
  if (!normalized) return null;
  const url = new URL(normalized);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return null;
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return null;
  const parts = host.split('.').map(Number);
  if (parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255)) {
    if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || parts[0] === 169 && parts[1] === 254 ||
        parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 || parts[0] === 192 && parts[1] === 168) return null;
  }
  return normalized;
}

function isPrivateIpAddress(raw) {
  const address = String(raw || '').toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 0 || b === 168) ||
      a === 198 && (b === 18 || b === 19 || b === 51) || a === 203 && b === 0;
  }
  if (isIP(address) !== 6) return true;
  if (address === '::' || address === '::1' || address.startsWith('64:ff9b:')) return true;
  const mapped = address.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    return isPrivateIpAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  const first = Number.parseInt(address.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 ||
    (first & 0xff00) === 0xff00 || address.startsWith('2001:db8:');
}

class MetadataController {
  constructor({ onMetadata }) {
    this.onMetadata = onMetadata;
    this.window = null;
    this.queue = [];
    this.queued = new Set();
    this.running = false;
    this.disposed = false;
    this.maxQueue = 500;
    this.currentOrigin = '';
  }

  ensureWindow() {
    if (this.window && !this.window.isDestroyed()) return this.window;
    this.window = new BrowserWindow({
      show: false,
      width: 900,
      height: 650,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        partition: 'metadata-reader',
      },
    });
    this.window.webContents.setAudioMuted(true);
    this.window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    this.window.webContents.session.on('will-download', event => event.preventDefault());
    this.window.webContents.session.webRequest.onBeforeRequest(
      { urls: ['<all_urls>', 'ws://*/*', 'wss://*/*'] },
      (details, callback) => {
        let origin = '';
        try { origin = new URL(details.url).origin; } catch {}
        if (details.resourceType !== 'mainFrame' && (!origin || origin !== this.currentOrigin)) {
          callback({ cancel: true });
          return;
        }
        this.isPublicNetworkUrl(details.url, this.window?.webContents.session)
          .then(safe => {
            if (safe && details.resourceType === 'mainFrame') this.currentOrigin = origin;
            callback({ cancel: !safe });
          })
          .catch(() => callback({ cancel: true }));
      },
    );
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', (event, target) => {
      if (!safeAutomaticUrl(target)) event.preventDefault();
    });
    this.window.webContents.on('will-redirect', (event, target) => {
      if (!safeAutomaticUrl(target)) event.preventDefault();
    });
    this.window.on('closed', () => { this.window = null; });
    return this.window;
  }

  async isPublicNetworkUrl(raw, session) {
    const normalized = safeAutomaticUrl(raw);
    if (!normalized || !session) return false;
    const host = new URL(normalized).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (isIP(host)) return !isPrivateIpAddress(host);
    let proxy = '';
    try { proxy = await session.resolveProxy(normalized); } catch { return false; }
    if (String(proxy).trim().toUpperCase() !== 'DIRECT') return false;
    const lookups = await Promise.allSettled([
      session.resolveHost(host, { queryType: 'A', cacheUsage: 'disallowed' }),
      session.resolveHost(host, { queryType: 'AAAA', cacheUsage: 'disallowed' }),
    ]);
    const addresses = lookups.flatMap(result => result.status === 'fulfilled'
      ? (result.value?.endpoints || []).map(endpoint => endpoint.address)
      : []);
    return addresses.length > 0 && addresses.every(address => !isPrivateIpAddress(address));
  }

  enqueue(rawUrl) {
    const url = safeAutomaticUrl(rawUrl);
    if (!url || this.disposed || this.queued.has(url) || this.queued.size >= this.maxQueue) return false;
    this.queued.add(url);
    this.queue.push(url);
    void this.drain();
    return true;
  }

  enqueueMany(urls) {
    for (const url of Array.isArray(urls) ? urls : []) this.enqueue(url);
  }

  async loadWithTimeout(window, url) {
    let timer;
    try {
      await Promise.race([
        window.loadURL(url),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('读取网页名称超时')), 15000);
        }),
      ]);
      await delay(900);
    } finally {
      clearTimeout(timer);
    }
  }

  async readMetadata(url) {
    const window = this.ensureWindow();
    this.currentOrigin = new URL(url).origin;
    try {
      await this.loadWithTimeout(window, url);
      return await window.webContents.executeJavaScript(`(() => {
        const text = value => String(value || '').replace(/[\\u0000-\\u001f]/g, ' ').replace(/\\s+/g, ' ').trim();
        const cleanTitle = value => text(value)
          .replace(/(?:_|-|\\s)*哔哩哔哩(?:_|-|\\s)*bilibili\\s*$/i, '')
          .replace(/\\s*[-|_]\\s*(?:YouTube|哔哩哔哩|bilibili)\\s*$/i, '')
          .trim();
        const meta = name => document.querySelector('meta[property="' + name + '"],meta[name="' + name + '"]')?.content || '';
        let structured = {};
        for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
          try {
            const value = JSON.parse(node.textContent || '{}');
            const entries = Array.isArray(value) ? value : [value];
            structured = entries.find(entry => entry && (entry.name || entry.headline)) || structured;
            if (structured.name || structured.headline) break;
          } catch {}
        }
        const bili = globalThis.__INITIAL_STATE__?.videoData || {};
        const rawKeywords = bili.tname || meta('keywords') || structured.keywords || '';
        const keywords = (Array.isArray(rawKeywords) ? rawKeywords : String(rawKeywords).split(/[,，|]/))
          .map(text)
          .filter(value => value && !/^(?:bilibili|哔哩哔哩|B站|视频)$/i.test(value))
          .slice(0, 12);
        const title = cleanTitle(
          bili.title || document.querySelector('h1.video-title, h1[title], h1')?.getAttribute('title') ||
          document.querySelector('h1.video-title, h1')?.textContent || meta('og:title') || meta('twitter:title') ||
          structured.name || structured.headline || document.title
        ) || keywords.slice(0, 3).join(' · ');
        let cover = text(bili.pic || meta('og:image') || meta('twitter:image') || structured.thumbnailUrl || '');
        if (cover.startsWith('//')) cover = 'https:' + cover;
        return {
          title: title.slice(0, 300),
          artist: text(bili.owner?.name || document.querySelector('.up-name, .up-info-container .name, [class*="author"]')?.textContent || meta('author') || structured.author?.name || '').slice(0, 300),
          cover: cover.slice(0, 300),
          keywords
        };
      })()`, true);
    } catch (error) {
      if (!this.disposed) console.warn(`Could not resolve metadata for ${new URL(url).hostname}:`, error.message);
      try { window.webContents.stop(); } catch {}
      return null;
    }
  }

  async drain() {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      while (this.queue.length && !this.disposed) {
        const url = this.queue.shift();
        try {
          const metadata = await this.readMetadata(url);
          if (metadata?.title || metadata?.artist || metadata?.cover || metadata?.keywords?.length) {
            await this.onMetadata?.(url, metadata);
          }
        } catch (error) {
          console.warn('Metadata update failed:', error.message);
        } finally {
          this.queued.delete(url);
        }
      }
    } finally {
      this.running = false;
    }
  }

  dispose() {
    this.disposed = true;
    this.queue = [];
    this.queued.clear();
    this.currentOrigin = '';
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}

module.exports = { MetadataController, isPrivateIpAddress, safeAutomaticUrl };
