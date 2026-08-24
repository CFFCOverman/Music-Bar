const fs = require('fs');
const path = require('path');

const MAX_HISTORY = 200;
const MAX_PLAYLISTS = 100;
const MAX_PLAYLIST_ITEMS = 200;
const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
const PLACEHOLDER_TITLES = new Set(['', '正在打开网页…', '网页音频', '未命名网页', '正在读取信息…']);

const cleanText = (value, fallback = '') => String(value || fallback)
  .replace(/[\u0000-\u001f]/g, ' ')
  .trim()
  .slice(0, 300);

const makeId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const cleanId = value => {
  const id = String(value || '').trim();
  return id.length <= 64 && /^[A-Za-z0-9_-]+$/.test(id) ? id : makeId();
};

function ensureUniqueIds(items) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) item.id = makeId();
    seen.add(item.id);
  }
  return items;
}

function normalizeUrl(raw) {
  const value = String(raw || '').trim();
  if (!value || value.length > 2048) return null;
  const bv = value.match(/BV[0-9A-Za-z]{10}/i)?.[0];
  if (bv && !/^https?:\/\//i.test(value)) return `https://www.bilibili.com/video/${bv}`;
  try {
    const url = new URL(value);
    const normalized = url.href;
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && normalized.length <= 2048
      ? normalized
      : null;
  } catch { return null; }
}

function defaultTitle(url) {
  try { return new URL(url).hostname.replace(/^www\./i, '') || '网页音频'; }
  catch { return '网页音频'; }
}

function cleanKeywords(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[,，|]/);
  return [...new Set(source.map(item => cleanText(item)).filter(Boolean))].slice(0, 12);
}

function isAutomaticTitle(title, url) {
  const value = cleanText(title);
  if (PLACEHOLDER_TITLES.has(value)) return true;
  try {
    const hostname = new URL(url).hostname;
    return value.toLowerCase() === hostname.toLowerCase()
      || value.toLowerCase() === hostname.replace(/^www\./i, '').toLowerCase();
  } catch { return false; }
}

async function readImportJson(file) {
  const stat = await fs.promises.stat(file);
  if (!stat.isFile() || stat.size > MAX_IMPORT_BYTES) throw new Error('导入文件过大（上限 8 MB）');
  return JSON.parse(await fs.promises.readFile(file, 'utf8'));
}

class Store {
  constructor(userDataPath, onHistoryChanged, onPlaylistsChanged) {
    this.userDataPath = userDataPath;
    this.onHistoryChanged = onHistoryChanged;
    this.onPlaylistsChanged = onPlaylistsChanged;
    this.history = [];
    this.playlists = [];
    this.output = { label: '系统默认', deviceId: 'default' };
    this.metadataTimer = null;
  }

  get historyFile() { return path.join(this.userDataPath, 'history.json'); }
  get playlistsFile() { return path.join(this.userDataPath, 'playlists.json'); }
  get settingsFile() { return path.join(this.userDataPath, 'settings.json'); }

  async init() {
    await Promise.all([this.readHistory(), this.readPlaylists(), this.readSettings()]);
  }

  toHistoryItem(value) {
    const url = normalizeUrl(typeof value === 'string' ? value : value?.url);
    if (!url) return null;
    const now = new Date().toISOString();
    return {
      id: cleanId(value?.id),
      url,
      title: cleanText(value?.title, defaultTitle(url)),
      artist: cleanText(value?.artist),
      cover: cleanText(value?.cover),
      keywords: cleanKeywords(value?.keywords),
      createdAt: cleanText(value?.createdAt, now),
      updatedAt: cleanText(value?.updatedAt, now),
      lastPlayedAt: cleanText(value?.lastPlayedAt, now),
    };
  }

  toPlaylistItem(value) {
    const url = normalizeUrl(typeof value === 'string' ? value : value?.url);
    if (!url) return null;
    return {
      id: cleanId(value?.id),
      url,
      title: cleanText(value?.title, defaultTitle(url)),
      artist: cleanText(value?.artist),
      cover: cleanText(value?.cover),
      keywords: cleanKeywords(value?.keywords),
    };
  }

  toPlaylist(value, fallbackName = '') {
    if (!value || typeof value !== 'object') return null;
    const source = Array.isArray(value.items) ? value.items : Array.isArray(value.playlist) ? value.playlist : [];
    const now = new Date().toISOString();
    const seenUrls = new Set();
    const items = ensureUniqueIds(source.slice(0, MAX_PLAYLIST_ITEMS)
      .map(item => this.toPlaylistItem(item))
      .filter(item => {
        if (!item || seenUrls.has(item.url)) return false;
        seenUrls.add(item.url);
        return true;
      }));
    return {
      id: cleanId(value.id),
      name: cleanText(value.name, fallbackName || `歌单 ${this.playlists.length + 1}`),
      items,
      createdAt: cleanText(value.createdAt, now),
      updatedAt: cleanText(value.updatedAt, now),
    };
  }

  async readHistory() {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.historyFile, 'utf8'));
      const source = Array.isArray(parsed) ? parsed : parsed.items;
      this.history = ensureUniqueIds((Array.isArray(source) ? source : []).slice(0, MAX_HISTORY).map(value => this.toHistoryItem(value)).filter(Boolean));
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('Could not read history:', error.message);
      this.history = [];
    }
  }

  async readPlaylists() {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.playlistsFile, 'utf8'));
      const source = Array.isArray(parsed) ? parsed : parsed.playlists;
      this.playlists = (Array.isArray(source) ? source : []).slice(0, MAX_PLAYLISTS)
        .map((value, index) => this.toPlaylist(value, `歌单 ${index + 1}`))
        .filter(Boolean);
      ensureUniqueIds(this.playlists);
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('Could not read playlists:', error.message);
      this.playlists = [];
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
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
  }

  async saveHistory() { await this.write(this.historyFile, { version: 2, items: this.history }); }
  async savePlaylists() { await this.write(this.playlistsFile, { version: 1, playlists: this.playlists }); }

  listHistory() {
    return [...this.history].sort((a, b) => String(b.lastPlayedAt).localeCompare(String(a.lastPlayedAt)));
  }

  listPlaylists() {
    return this.playlists.map(playlist => ({ ...playlist, items: playlist.items.map(item => ({ ...item })) }));
  }

  getPlaylist(id) {
    const playlist = this.playlists.find(entry => entry.id === id);
    return playlist ? { ...playlist, items: playlist.items.map(item => ({ ...item })) } : null;
  }

  emitHistory() { this.onHistoryChanged?.(this.listHistory()); }
  emitPlaylists() { this.onPlaylistsChanged?.(this.listPlaylists()); }

  async upsertHistory(rawUrl, patch = {}) {
    const url = normalizeUrl(rawUrl);
    if (!url) return null;
    const now = new Date().toISOString();
    let item = this.history.find(entry => entry.url === url);
    if (!item) {
      item = this.toHistoryItem({ url, ...patch, lastPlayedAt: now });
      this.history.unshift(item);
    } else {
      const safePatch = { ...patch };
      if (safePatch.title !== undefined) safePatch.title = cleanText(safePatch.title, item.title);
      Object.assign(item, safePatch, { updatedAt: now, lastPlayedAt: now });
    }
    this.history = this.history.slice(0, MAX_HISTORY);
    await this.saveHistory();
    this.emitHistory();
    return { ...item };
  }

  async updateHistory(id, changes) {
    const item = this.history.find(entry => entry.id === id);
    if (!item) return { ok: false, message: '这条记录已经不存在' };
    const url = normalizeUrl(changes?.url);
    if (!url) return { ok: false, message: '链接格式不正确' };
    if (this.history.some(entry => entry.id !== id && entry.url === url)) return { ok: false, message: '这个链接已经在历史中' };
    Object.assign(item, { url, title: cleanText(changes?.title, defaultTitle(url)), updatedAt: new Date().toISOString() });
    await this.saveHistory();
    this.emitHistory();
    return { ok: true, item: { ...item } };
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
    this.metadataTimer = setTimeout(() => {
      const item = this.history.find(entry => entry.id === id);
      if (item) void this.applyMetadata(item.url, state);
    }, 700);
  }

  async applyMetadata(rawUrl, metadata = {}) {
    const url = normalizeUrl(rawUrl);
    if (!url) return false;
    const title = cleanText(metadata.title);
    const artist = cleanText(metadata.artist);
    const cover = cleanText(metadata.cover);
    const keywords = cleanKeywords(metadata.keywords);
    if (!title && !artist && !cover && !keywords.length) return false;
    const now = new Date().toISOString();
    let historyChanged = false;
    let playlistsChanged = false;
    const apply = item => {
      let changed = false;
      if (title && !PLACEHOLDER_TITLES.has(title) && isAutomaticTitle(item.title, item.url) && item.title !== title) { item.title = title; changed = true; }
      if (artist && item.artist !== artist) { item.artist = artist; changed = true; }
      if (cover && item.cover !== cover) { item.cover = cover; changed = true; }
      if (keywords.length && JSON.stringify(item.keywords || []) !== JSON.stringify(keywords)) { item.keywords = keywords; changed = true; }
      return changed;
    };
    for (const item of this.history) {
      if (item.url === url && apply(item)) { item.updatedAt = now; historyChanged = true; }
    }
    for (const playlist of this.playlists) {
      let playlistChanged = false;
      for (const item of playlist.items) if (item.url === url && apply(item)) playlistChanged = true;
      if (playlistChanged) { playlist.updatedAt = now; playlistsChanged = true; }
    }
    await Promise.all([
      historyChanged ? this.saveHistory() : Promise.resolve(),
      playlistsChanged ? this.savePlaylists() : Promise.resolve(),
    ]);
    if (historyChanged) this.emitHistory();
    if (playlistsChanged) this.emitPlaylists();
    return historyChanged || playlistsChanged;
  }

  getUnresolvedUrls() {
    const urls = [];
    for (const item of this.history) if (isAutomaticTitle(item.title, item.url)) urls.push(item.url);
    for (const playlist of this.playlists) for (const item of playlist.items) if (isAutomaticTitle(item.title, item.url)) urls.push(item.url);
    return [...new Set(urls)];
  }

  async createPlaylist(name) {
    if (this.playlists.length >= MAX_PLAYLISTS) return { ok: false, message: '歌单已达到 100 个上限' };
    const playlist = this.toPlaylist({ name: cleanText(name, `歌单 ${this.playlists.length + 1}`), items: [] });
    this.playlists.unshift(playlist);
    await this.savePlaylists();
    this.emitPlaylists();
    return { ok: true, playlist: this.getPlaylist(playlist.id) };
  }

  async renamePlaylist(id, name) {
    const playlist = this.playlists.find(entry => entry.id === id);
    if (!playlist) return { ok: false, message: '歌单已经不存在' };
    const nextName = cleanText(name);
    if (!nextName) return { ok: false, message: '请输入歌单名称' };
    playlist.name = nextName;
    playlist.updatedAt = new Date().toISOString();
    await this.savePlaylists();
    this.emitPlaylists();
    return { ok: true, playlist: this.getPlaylist(id) };
  }

  async deletePlaylist(id) {
    const before = this.playlists.length;
    this.playlists = this.playlists.filter(entry => entry.id !== id);
    if (before === this.playlists.length) return { ok: false, message: '歌单已经不存在' };
    await this.savePlaylists();
    this.emitPlaylists();
    return { ok: true };
  }

  async addHistoryToPlaylist(playlistId, historyId) {
    const playlist = this.playlists.find(entry => entry.id === playlistId);
    const historyItem = this.history.find(entry => entry.id === historyId);
    if (!playlist || !historyItem) return { ok: false, message: '歌单或历史记录已经不存在' };
    if (playlist.items.some(item => item.url === historyItem.url)) return { ok: false, message: '这首已经在歌单中' };
    if (playlist.items.length >= MAX_PLAYLIST_ITEMS) return { ok: false, message: '歌单已达到 200 首上限' };
    playlist.items.push(this.toPlaylistItem(historyItem));
    playlist.updatedAt = new Date().toISOString();
    await this.savePlaylists();
    this.emitPlaylists();
    return { ok: true, playlist: this.getPlaylist(playlistId) };
  }

  async updatePlaylistItem(playlistId, itemId, changes) {
    const playlist = this.playlists.find(entry => entry.id === playlistId);
    const item = playlist?.items.find(entry => entry.id === itemId);
    if (!playlist || !item) return { ok: false, message: '歌单条目已经不存在' };
    const url = normalizeUrl(changes?.url);
    if (!url) return { ok: false, message: '链接格式不正确' };
    if (playlist.items.some(entry => entry.id !== itemId && entry.url === url)) return { ok: false, message: '这个链接已经在歌单中' };
    item.url = url;
    item.title = cleanText(changes?.title, defaultTitle(url));
    playlist.updatedAt = new Date().toISOString();
    await this.savePlaylists();
    this.emitPlaylists();
    return { ok: true, item: { ...item } };
  }

  async removePlaylistItem(playlistId, itemId) {
    const playlist = this.playlists.find(entry => entry.id === playlistId);
    if (!playlist) return { ok: false, message: '歌单已经不存在' };
    const before = playlist.items.length;
    playlist.items = playlist.items.filter(item => item.id !== itemId);
    if (before === playlist.items.length) return { ok: false, message: '歌单条目已经不存在' };
    playlist.updatedAt = new Date().toISOString();
    await this.savePlaylists();
    this.emitPlaylists();
    return { ok: true };
  }

  async reorderPlaylistItem(playlistId, itemId, toIndex) {
    const playlist = this.playlists.find(entry => entry.id === playlistId);
    const fromIndex = playlist?.items.findIndex(item => item.id === itemId) ?? -1;
    if (!playlist || fromIndex < 0) return { ok: false, message: '歌单条目已经不存在' };
    const index = Math.max(0, Math.min(playlist.items.length - 1, Math.round(Number(toIndex) || 0)));
    const [item] = playlist.items.splice(fromIndex, 1);
    playlist.items.splice(index, 0, item);
    playlist.updatedAt = new Date().toISOString();
    await this.savePlaylists();
    this.emitPlaylists();
    return { ok: true };
  }

  getOutputPreference() { return { ...this.output }; }

  async setOutputPreference(output) {
    this.output = { deviceId: cleanText(output?.deviceId, 'default'), label: cleanText(output?.label, '系统默认') };
    await this.write(this.settingsFile, { version: 1, output: this.output });
  }

  async importHistory(file) {
    const parsed = await readImportJson(file);
    const incoming = Array.isArray(parsed) ? parsed : parsed.items;
    if (!Array.isArray(incoming)) throw new Error('文件中没有历史记录列表');
    let count = 0;
    const urls = [];
    for (const value of incoming.slice(0, MAX_HISTORY)) {
      const candidate = this.toHistoryItem(value);
      if (!candidate) continue;
      const existing = this.history.find(entry => entry.url === candidate.url);
      if (existing) { const id = existing.id; Object.assign(existing, candidate, { id }); }
      else {
        if (this.history.some(entry => entry.id === candidate.id)) candidate.id = makeId();
        this.history.push(candidate);
      }
      urls.push(candidate.url);
      count += 1;
    }
    this.history = this.listHistory().slice(0, MAX_HISTORY);
    const retainedUrls = new Set(this.history.map(item => item.url));
    await this.saveHistory();
    this.emitHistory();
    return { count, urls: [...new Set(urls)].filter(url => retainedUrls.has(url)) };
  }

  async exportHistory(file) {
    await this.write(file, { kind: 'shengjian-history', version: 2, exportedAt: new Date().toISOString(), items: this.listHistory() });
    return this.history.length;
  }

  async importPlaylists(file) {
    const parsed = await readImportJson(file);
    let incoming = Array.isArray(parsed) ? parsed : parsed.playlists;
    if (!Array.isArray(incoming) && parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) incoming = [parsed];
    if (!Array.isArray(incoming)) throw new Error('文件中没有歌单列表');
    let count = 0;
    const urls = [];
    const available = Math.max(0, MAX_PLAYLISTS - this.playlists.length);
    for (const value of incoming.slice(0, available)) {
      const candidate = this.toPlaylist(value, `导入歌单 ${count + 1}`);
      if (!candidate) continue;
      if (this.playlists.some(entry => entry.id === candidate.id)) candidate.id = makeId();
      this.playlists.push(candidate);
      urls.push(...candidate.items.map(item => item.url));
      count += 1;
    }
    await this.savePlaylists();
    this.emitPlaylists();
    return { count, urls: [...new Set(urls)] };
  }

  async exportPlaylists(file, playlistId) {
    const source = playlistId ? this.playlists.filter(playlist => playlist.id === playlistId) : this.playlists;
    if (playlistId && !source.length) throw new Error('歌单已经不存在');
    const playlists = source.map(playlist => ({ ...playlist, items: playlist.items.map(item => ({ ...item })) }));
    await this.write(file, { kind: 'shengjian-playlists', version: 1, exportedAt: new Date().toISOString(), playlists });
    return playlists.length;
  }

  dispose() { clearTimeout(this.metadataTimer); }
}

module.exports = { Store, defaultTitle, isAutomaticTitle, normalizeUrl };
