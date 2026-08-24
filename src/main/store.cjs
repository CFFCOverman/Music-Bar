const fs = require('fs');
const path = require('path');

const cleanText = (value, fallback = '') => String(value || fallback)
  .replace(/[\u0000-\u001f]/g, ' ')
  .trim()
  .slice(0, 300);

function normalizeUrl(raw) {
  const value = String(raw || '').trim();
  const bv = value.match(/BV[0-9A-Za-z]{10}/i)?.[0];
  if (bv && !/^https?:\/\//i.test(value)) return `https://www.bilibili.com/video/${bv}`;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

class Store {
  constructor(userDataPath, onHistoryChanged) {
    this.userDataPath = userDataPath;
    this.onHistoryChanged = onHistoryChanged;
    this.history = [];
    this.output = { label: '系统默认', deviceId: 'default' };
    this.metadataTimer = null;
  }

  get historyFile() { return path.join(this.userDataPath, 'history.json'); }
  get settingsFile() { return path.join(this.userDataPath, 'settings.json'); }

  async init() {
    await Promise.all([this.readHistory(), this.readSettings()]);
  }

  toHistoryItem(value) {
    const url = normalizeUrl(typeof value === 'string' ? value : value?.url);
    if (!url) return null;
    const now = new Date().toISOString();
    return {
      id: cleanText(value?.id) || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      url,
      title: cleanText(value?.title, new URL(url).hostname),
      artist: cleanText(value?.artist),
      cover: cleanText(value?.cover),
      createdAt: value?.createdAt || now,
      updatedAt: value?.updatedAt || now,
      lastPlayedAt: value?.lastPlayedAt || now,
    };
  }

  async readHistory() {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.historyFile, 'utf8'));
      const source = Array.isArray(parsed) ? parsed : parsed.items;
      this.history = (Array.isArray(source) ? source : []).map(value => this.toHistoryItem(value)).filter(Boolean).slice(0, 200);
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('Could not read history:', error.message);
      this.history = [];
    }
  }

  async readSettings() {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.settingsFile, 'utf8'));
      this.output = {
        label: cleanText(parsed?.output?.label, '系统默认'),
        deviceId: cleanText(parsed?.output?.deviceId, 'default'),
      };
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('Could not read settings:', error.message);
    }
  }

  async write(file, value) {
    await fs.promises.mkdir(this.userDataPath, { recursive: true });
    await fs.promises.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
  }

  async saveHistory() {
    await this.write(this.historyFile, { version: 1, items: this.history });
  }

  listHistory() {
    return [...this.history].sort((a, b) => String(b.lastPlayedAt).localeCompare(String(a.lastPlayedAt)));
  }

  emitHistory() {
    this.onHistoryChanged?.(this.listHistory());
  }

  async upsertHistory(rawUrl, patch = {}) {
    const url = normalizeUrl(rawUrl);
    if (!url) return null;
    const now = new Date().toISOString();
    let item = this.history.find(entry => entry.url === url);
    if (!item) {
      item = this.toHistoryItem({ url, ...patch, lastPlayedAt: now });
      this.history.unshift(item);
    } else {
      Object.assign(item, patch, { updatedAt: now, lastPlayedAt: now });
    }
    this.history = this.history.slice(0, 200);
    await this.saveHistory();
    this.emitHistory();
    return item;
  }

  async updateHistory(id, changes) {
    const item = this.history.find(entry => entry.id === id);
    if (!item) return { ok: false, message: '这条记录已经不存在' };
    const url = normalizeUrl(changes?.url);
    if (!url) return { ok: false, message: '链接格式不正确' };
    if (this.history.some(entry => entry.id !== id && entry.url === url)) return { ok: false, message: '这个链接已经在历史中' };
    Object.assign(item, {
      url,
      title: cleanText(changes?.title, new URL(url).hostname),
      updatedAt: new Date().toISOString(),
    });
    await this.saveHistory();
    this.emitHistory();
    return { ok: true, item };
  }

  async deleteHistory(id) {
    const before = this.history.length;
    this.history = this.history.filter(entry => entry.id !== id);
    if (this.history.length === before) return { ok: false };
    await this.saveHistory();
    this.emitHistory();
    return { ok: true };
  }

  scheduleMetadataUpdate(id, state) {
    if (!id) return;
    clearTimeout(this.metadataTimer);
    this.metadataTimer = setTimeout(async () => {
      const item = this.history.find(entry => entry.id === id);
      if (!item) return;
      const title = cleanText(state.title);
      const artist = cleanText(state.artist);
      const cover = cleanText(state.cover);
      if (!title || ['正在打开网页…', '网页音频'].includes(title)) return;
      if (item.title === title && item.artist === artist && item.cover === cover) return;
      Object.assign(item, { title, artist, cover, updatedAt: new Date().toISOString() });
      await this.saveHistory();
      this.emitHistory();
    }, 700);
  }

  getOutputPreference() { return { ...this.output }; }

  async setOutputPreference(output) {
    this.output = {
      deviceId: cleanText(output?.deviceId, 'default'),
      label: cleanText(output?.label, '系统默认'),
    };
    await this.write(this.settingsFile, { version: 1, output: this.output });
  }

  async importHistory(file) {
    const parsed = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    const incoming = Array.isArray(parsed) ? parsed : parsed.items;
    if (!Array.isArray(incoming)) throw new Error('文件中没有历史记录列表');
    let count = 0;
    for (const value of incoming) {
      const candidate = this.toHistoryItem(value);
      if (!candidate) continue;
      const existing = this.history.find(entry => entry.url === candidate.url);
      if (existing) {
        const id = existing.id;
        Object.assign(existing, candidate, { id });
      } else this.history.push(candidate);
      count += 1;
    }
    this.history = this.listHistory().slice(0, 200);
    await this.saveHistory();
    this.emitHistory();
    return count;
  }

  async exportHistory(file) {
    await this.write(file, { version: 1, exportedAt: new Date().toISOString(), items: this.listHistory() });
    return this.history.length;
  }

  dispose() { clearTimeout(this.metadataTimer); }
}

module.exports = { Store, normalizeUrl };
