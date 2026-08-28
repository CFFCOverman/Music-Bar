const { app, BrowserWindow, clipboard, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const { MediaController } = require('./media.cjs');
const { MetadataController } = require('./metadata.cjs');
const { RoomController } = require('./room-controller.cjs');
const { Store, normalizeUrl } = require('./store.cjs');
const { CUSTOM_SCHEME, findJoinInput } = require('./invite-link.cjs');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let barWindow;
let store;
let media;
let metadata;
let room;
let currentHistoryId = null;
let pendingJoinInvite = findJoinInput(process.argv);
let playerState = {
  ready: false,
  playing: false,
  ended: false,
  title: '还没有播放',
  artist: '粘贴一个网页链接开始',
  currentTime: 0,
  duration: 0,
  volume: 1,
  muted: false,
  cover: '',
};

function send(channel, value) {
  if (barWindow && !barWindow.isDestroyed()) barWindow.webContents.send(channel, value);
}

function updatePlayerState(patch) {
  const justEnded = Boolean(patch.ended) && !playerState.ended;
  playerState = { ...playerState, ...patch };
  send('player:state', playerState);
  if (patch.title || patch.artist || patch.cover) {
    store?.scheduleMetadataUpdate(currentHistoryId, playerState);
    room?.updateCurrentMetadata(playerState);
  }
  if (justEnded) room?.onEnded();
}

function createBarWindow() {
  barWindow = new BrowserWindow({
    width: 760,
    height: 92,
    minWidth: 540,
    maxWidth: 1000,
    minHeight: 92,
    maxHeight: 520,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  barWindow.setAlwaysOnTop(true, 'floating');
  barWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  barWindow.webContents.on('did-finish-load', () => {
    const roomSnapshot = room.getSnapshot();
    send('player:state', playerState);
    send('history:changed', store.listHistory());
    send('playlists:changed', store.listPlaylists());
    send('room:status', roomSnapshot.status);
    send('room:state', roomSnapshot.state);
    if (pendingJoinInvite) {
      const invite = pendingJoinInvite;
      pendingJoinInvite = '';
      room.join(invite);
    }
  });
  barWindow.on('closed', () => { barWindow = null; });
}

function acceptJoinLink(value) {
  const invite = findJoinInput([value]);
  if (!invite) return false;
  if (!room) pendingJoinInvite = invite;
  else room.join(invite);
  if (barWindow) {
    if (barWindow.isMinimized()) barWindow.restore();
    barWindow.show();
    barWindow.focus();
  }
  return true;
}

if (process.defaultApp) app.setAsDefaultProtocolClient(CUSTOM_SCHEME.slice(0, -1), process.execPath, [path.resolve(process.argv[1])]);
else app.setAsDefaultProtocolClient(CUSTOM_SCHEME.slice(0, -1));

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
else app.on('second-instance', (_event, argv) => {
  const invite = findJoinInput(argv);
  if (invite) acceptJoinLink(invite);
  else if (barWindow) { barWindow.show(); barWindow.focus(); }
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  acceptJoinLink(url);
});

function registerPlayerIpc() {
  ipcMain.handle('player:load', async (_event, raw) => {
    if (room.active) return room.addAndSelect(raw);
    const url = normalizeUrl(raw);
    if (!url) return { ok: false, message: '请输入有效的网页链接或 BV 号' };
    try {
      const item = await store.upsertHistory(url);
      currentHistoryId = item?.id || null;
      await media.load(url);
      return { ok: true, url };
    } catch (error) { return { ok: false, message: error.message }; }
  });
  ipcMain.handle('player:toggle', async () => {
    const result = await media.toggle();
    room.submitPlaybackState(result);
    return result;
  });
  ipcMain.handle('player:seek', async (_event, time) => {
    const result = await media.seek(time);
    room.submitPlaybackState(result);
    return result;
  });
  ipcMain.handle('player:skip', async (_event, delta) => {
    const result = await media.skip(delta);
    room.submitPlaybackState(result);
    return result;
  });
  ipcMain.handle('player:volume', (_event, volume) => media.volume(volume));
  ipcMain.handle('player:mute', () => media.mute());
  ipcMain.handle('output:list', () => media.listOutputs());
  ipcMain.handle('output:select', (_event, deviceId, label) => media.selectOutput(deviceId, label, true));
}

function registerRoomIpc() {
  ipcMain.handle('room:create', () => room.create());
  ipcMain.handle('room:create-from-playlist', (_event, playlistId) => {
    const playlist = store.getPlaylist(String(playlistId || ''));
    if (!playlist) return { ok: false, message: '歌单已经不存在' };
    if (!playlist.items.length) return { ok: false, message: '请先向歌单添加网页' };
    return room.create(playlist.items);
  });
  ipcMain.handle('room:join', (_event, invite) => room.join(invite));
  ipcMain.handle('room:leave', () => room.leave());
  ipcMain.handle('room:get-state', () => room.getSnapshot());
  ipcMain.handle('room:operate', (_event, type, payload) => room.operate(type, payload));
  ipcMain.handle('clipboard:write', (_event, value) => {
    const text = String(value || '');
    if (!text || text.length > 4096) return { ok: false, message: '复制内容无效' };
    clipboard.writeText(text);
    return { ok: true };
  });
}

function registerHistoryIpc() {
  const offerMetadataLookup = async urls => {
    if (!urls?.length) return false;
    const answer = await dialog.showMessageBox(barWindow, {
      type: 'question',
      title: '是否自动读取网页名称？',
      message: `已导入 ${urls.length} 个网页链接`,
      detail: '读取名称会在独立、无登录状态的静音窗口中访问这些网页。你也可以只导入，不自动访问。',
      buttons: ['读取名称', '只导入'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (answer.response !== 0) return false;
    metadata.enqueueMany(urls);
    return true;
  };
  ipcMain.handle('history:list', () => store.listHistory());
  ipcMain.handle('history:update', async (_event, id, changes) => {
    const result = await store.updateHistory(id, changes);
    if (result.ok) metadata.enqueue(result.item.url);
    return result;
  });
  ipcMain.handle('history:delete', async (_event, id) => {
    if (currentHistoryId === id) currentHistoryId = null;
    return store.deleteHistory(id);
  });
  ipcMain.handle('history:import', async () => {
    const result = await dialog.showOpenDialog(barWindow, {
      title: '导入声笺历史记录',
      properties: ['openFile'],
      filters: [{ name: 'JSON 文件', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    try {
      const imported = await store.importHistory(result.filePaths[0]);
      const metadataStarted = await offerMetadataLookup(imported.urls);
      return { ok: true, count: imported.count, metadataStarted };
    }
    catch (error) { return { ok: false, message: `导入失败：${error.message}` }; }
  });
  ipcMain.handle('history:export', async () => {
    const result = await dialog.showSaveDialog(barWindow, {
      title: '导出声笺历史记录',
      defaultPath: `shengjian-history-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON 文件', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    try { return { ok: true, count: await store.exportHistory(result.filePath) }; }
    catch (error) { return { ok: false, message: `导出失败：${error.message}` }; }
  });

  ipcMain.handle('playlists:list', () => store.listPlaylists());
  ipcMain.handle('playlists:create', (_event, name) => store.createPlaylist(name));
  ipcMain.handle('playlists:rename', (_event, id, name) => store.renamePlaylist(id, name));
  ipcMain.handle('playlists:delete', (_event, id) => store.deletePlaylist(id));
  ipcMain.handle('playlists:add-history', (_event, playlistId, historyId) => store.addHistoryToPlaylist(playlistId, historyId));
  ipcMain.handle('playlists:update-item', async (_event, playlistId, itemId, changes) => {
    const result = await store.updatePlaylistItem(playlistId, itemId, changes);
    if (result.ok) metadata.enqueue(result.item.url);
    return result;
  });
  ipcMain.handle('playlists:remove-item', (_event, playlistId, itemId) => store.removePlaylistItem(playlistId, itemId));
  ipcMain.handle('playlists:reorder-item', (_event, playlistId, itemId, index) => store.reorderPlaylistItem(playlistId, itemId, index));
  ipcMain.handle('playlists:import', async () => {
    const result = await dialog.showOpenDialog(barWindow, {
      title: '导入声笺歌单',
      properties: ['openFile'],
      filters: [{ name: 'JSON 文件', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    try {
      const imported = await store.importPlaylists(result.filePaths[0]);
      const metadataStarted = await offerMetadataLookup(imported.urls);
      return { ok: true, count: imported.count, metadataStarted };
    } catch (error) { return { ok: false, message: `导入失败：${error.message}` }; }
  });
  ipcMain.handle('playlists:export', async (_event, playlistId) => {
    const playlist = playlistId ? store.getPlaylist(String(playlistId)) : null;
    const safeName = String(playlist?.name || 'all').replace(/[<>:"/\\|?*]/g, '-').slice(0, 60);
    const result = await dialog.showSaveDialog(barWindow, {
      title: playlist ? `导出歌单：${playlist.name}` : '导出全部声笺歌单',
      defaultPath: `shengjian-playlist-${safeName}-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON 文件', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    try { return { ok: true, count: await store.exportPlaylists(result.filePath, playlistId || undefined) }; }
    catch (error) { return { ok: false, message: `导出失败：${error.message}` }; }
  });
}

function registerWindowIpc() {
  ipcMain.on('window:height', (_event, requestedHeight) => {
    if (!barWindow) return;
    const [width] = barWindow.getSize();
    barWindow.setSize(width, Math.max(92, Math.min(520, Math.round(Number(requestedHeight) || 92))), true);
  });
  ipcMain.on('window:top', (_event, enabled) => barWindow?.setAlwaysOnTop(Boolean(enabled), 'floating'));
  ipcMain.on('window:minimize', () => barWindow?.minimize());
  ipcMain.on('window:close', () => app.quit());
  ipcMain.on('source:open', () => {
    const url = media.getCurrentUrl();
    if (url) shell.openExternal(url);
  });
  ipcMain.on('state:request', () => send('player:state', playerState));
}

app.whenReady().then(async () => {
  store = new Store(
    app.getPath('userData'),
    history => send('history:changed', history),
    playlists => send('playlists:changed', playlists),
  );
  await store.init();
  metadata = new MetadataController({ onMetadata: (url, value) => store.applyMetadata(url, value) });
  media = new MediaController({
    onState: updatePlayerState,
    getOutputPreference: () => store.getOutputPreference(),
    setOutputPreference: output => store.setOutputPreference(output),
  });
  room = new RoomController({
    media,
    store,
    send,
    getPlayerState: () => playerState,
    setCurrentHistoryId: id => { currentHistoryId = id; },
    setPlayerMessage: updatePlayerState,
  });
  registerPlayerIpc();
  registerRoomIpc();
  registerHistoryIpc();
  registerWindowIpc();
  createBarWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  room?.dispose();
  metadata?.dispose();
  media?.dispose();
  store?.dispose();
});
