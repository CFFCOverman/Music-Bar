const $ = id => document.getElementById(id);
const shell = $('shell');
const title = $('title');
const artist = $('artist');
const play = $('play');
const progress = $('progress');
const elapsed = $('elapsed');
const duration = $('duration');
const volume = $('volume');
const mute = $('mute');
const cover = $('cover');
const urlInput = $('url');
const historyList = $('historyList');
const historyEmpty = $('historyEmpty');
const outputList = $('outputList');
const outputEmpty = $('outputEmpty');
let state = {};
let seeking = false;
let inputOpen = false;
let historyOpen = false;
let outputOpen = false;
let roomOpen = false;
let roomStatus = { mode: 'none', connected: false };
let roomState = null;
let historyItems = [];
let playlists = [];
let activePlaylistId = null;
let playlistEditorMode = 'create';
let pinned = true;
let volumeFrame = null;
let lastSeek = { value: -1, at: 0 };

const format = value => {
  if (!Number.isFinite(value) || value < 0) return '0:00';
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value % 3600 / 60);
  const seconds = Math.floor(value % 60).toString().padStart(2, '0');
  return hours ? `${hours}:${minutes.toString().padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
};

function setMessage(primary, secondary) {
  title.textContent = primary;
  artist.textContent = secondary;
}

function render(next) {
  state = next;
  shell.classList.toggle('playing', Boolean(next.playing));
  play.classList.toggle('is-playing', Boolean(next.playing));
  play.textContent = next.playing ? 'Ⅱ' : '▶';
  title.textContent = next.title || '网页音频';
  artist.textContent = next.artist || '正在读取信息…';
  elapsed.textContent = format(next.currentTime);
  duration.textContent = format(next.duration);
  if (!seeking) progress.value = next.duration ? String(next.currentTime / next.duration * 1000) : '0';
  volume.value = String(next.volume ?? 1);
  mute.textContent = next.muted || next.volume === 0 ? '×' : '♪';
  if (next.cover) cover.style.backgroundImage = `linear-gradient(#0001,#0001),url("${String(next.cover).replace(/"/g, '')}")`;
}

function syncPanels() {
  shell.classList.toggle('expanded', inputOpen);
  shell.classList.toggle('history-open', historyOpen);
  shell.classList.toggle('output-open', outputOpen);
  shell.classList.toggle('room-open', roomOpen);
  $('historyToggle').setAttribute('aria-expanded', String(historyOpen));
  $('historyPanel').setAttribute('aria-hidden', String(!historyOpen));
  $('outputToggle').setAttribute('aria-expanded', String(outputOpen));
  $('outputPanel').setAttribute('aria-hidden', String(!outputOpen));
  $('roomToggle').setAttribute('aria-expanded', String(roomOpen));
  $('roomPanel').setAttribute('aria-hidden', String(!roomOpen));
  const height = roomOpen ? 520 : (outputOpen ? 370 : (historyOpen ? 520 : (inputOpen ? 154 : 92)));
  window.musicBar.setHeight(height);
  if (inputOpen) setTimeout(() => urlInput.focus(), 120);
}

async function loadUrl(value, collapseInput = true) {
  const raw = String(value || '').trim();
  if (!raw) return;
  setMessage('正在打开网页…', '正在连接媒体');
  play.classList.add('is-loading');
  const result = await window.musicBar.load(raw);
  play.classList.remove('is-loading');
  if (!result.ok) {
    setMessage('无法载入', result.message || '请检查链接后重试');
    return;
  }
  urlInput.value = '';
  if (collapseInput) inputOpen = false;
  syncPanels();
}

function closePlaylistEditor() {
  $('playlistEditor').hidden = true;
  $('playlistName').value = '';
}

function openPlaylistEditor(mode = 'create') {
  playlistEditorMode = mode;
  const playlist = playlists.find(item => item.id === activePlaylistId);
  $('playlistName').value = mode === 'rename' ? playlist?.name || '' : '';
  $('playlistName').placeholder = mode === 'rename' ? '新的歌单名称' : '输入歌单名称';
  $('playlistEditor').hidden = false;
  setTimeout(() => $('playlistName').focus(), 20);
}

function playlistPicker(row, historyItem) {
  if (!playlists.length) {
    setMessage('先创建一个歌单', '创建后即可把历史网页加入歌单');
    openPlaylistEditor('create');
    return;
  }
  if (row.querySelector('.playlist-picker')) return;
  row.classList.add('is-picking');
  const form = document.createElement('form');
  form.className = 'playlist-picker';
  const select = document.createElement('select');
  select.setAttribute('aria-label', '选择歌单');
  for (const playlist of playlists) {
    const option = document.createElement('option');
    option.value = playlist.id;
    option.textContent = `${playlist.name} · ${playlist.items.length}`;
    select.append(option);
  }
  const save = Object.assign(document.createElement('button'), { type: 'submit', textContent: '加入', className: 'history-save' });
  const cancel = Object.assign(document.createElement('button'), { type: 'button', textContent: '取消', className: 'history-cancel' });
  form.append(select, save, cancel);
  row.append(form);
  cancel.addEventListener('click', () => { row.classList.remove('is-picking'); form.remove(); });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    save.disabled = true;
    const result = await window.musicBar.playlists.addHistory(select.value, historyItem.id);
    if (result.ok) {
      setMessage('已加入歌单', playlists.find(item => item.id === select.value)?.name || '歌单');
      row.classList.remove('is-picking');
      form.remove();
    } else {
      save.disabled = false;
      select.setCustomValidity(result.message || '加入失败');
      select.reportValidity();
    }
  });
}

function historyItemView(item) {
  const row = document.createElement('article');
  row.className = 'history-item';
  row.dataset.id = item.id;

  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'history-main';
  const itemTitle = document.createElement('strong');
  itemTitle.textContent = item.title || '未命名网页';
  const itemUrl = document.createElement('span');
  itemUrl.textContent = item.artist || item.url;
  main.append(itemTitle, itemUrl);
  main.addEventListener('click', () => loadUrl(item.url, false));

  const actions = document.createElement('div');
  actions.className = 'history-actions';
  const collect = document.createElement('button');
  collect.type = 'button';
  collect.className = 'history-playlist';
  collect.textContent = '歌单';
  collect.title = '加入歌单';
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'history-edit';
  edit.textContent = '编辑';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'history-delete';
  remove.textContent = '删除';
  actions.append(collect, edit, remove);
  row.append(main, actions);

  collect.addEventListener('click', () => playlistPicker(row, item));

  edit.addEventListener('click', () => {
    if (row.querySelector('.history-editor')) return;
    row.classList.add('is-editing');
    const editor = document.createElement('form');
    editor.className = 'history-editor';
    const name = document.createElement('input');
    name.value = item.title || '';
    name.placeholder = '显示名称';
    name.maxLength = 300;
    const link = document.createElement('input');
    link.value = item.url;
    link.placeholder = '网页链接';
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'history-save';
    save.textContent = '保存';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'history-cancel';
    cancel.textContent = '取消';
    editor.append(name, link, save, cancel);
    row.append(editor);
    name.focus();
    cancel.addEventListener('click', () => { row.classList.remove('is-editing'); editor.remove(); });
    editor.addEventListener('submit', async event => {
      event.preventDefault();
      save.disabled = true;
      const result = await window.musicBar.history.update(item.id, { title: name.value, url: link.value });
      if (!result.ok) {
        save.disabled = false;
        link.setCustomValidity(result.message || '保存失败');
        link.reportValidity();
      }
    });
  });

  let deleteTimer;
  remove.addEventListener('click', async () => {
    if (!remove.classList.contains('confirm')) {
      remove.classList.add('confirm');
      remove.textContent = '确认删除';
      clearTimeout(deleteTimer);
      deleteTimer = setTimeout(() => { remove.classList.remove('confirm'); remove.textContent = '删除'; }, 2600);
      return;
    }
    remove.disabled = true;
    await window.musicBar.history.delete(item.id);
  });
  return row;
}

function renderHistory(items) {
  historyItems = Array.isArray(items) ? items : [];
  renderLibrary();
}

function playlistItemView(item, index, playlist) {
  const row = document.createElement('article');
  row.className = 'history-item playlist-item';
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'history-main';
  const name = document.createElement('strong');
  name.textContent = item.title || '未命名网页';
  const detail = document.createElement('span');
  detail.textContent = item.artist || item.url;
  main.append(name, detail);
  main.addEventListener('click', () => loadUrl(item.url, false));

  const actions = document.createElement('div');
  actions.className = 'history-actions';
  const up = Object.assign(document.createElement('button'), { type: 'button', textContent: '↑', title: '上移', className: 'playlist-order' });
  const down = Object.assign(document.createElement('button'), { type: 'button', textContent: '↓', title: '下移', className: 'playlist-order' });
  const edit = Object.assign(document.createElement('button'), { type: 'button', textContent: '编辑', className: 'history-edit' });
  const remove = Object.assign(document.createElement('button'), { type: 'button', textContent: '×', title: '从歌单移除', className: 'history-delete' });
  up.disabled = index === 0;
  down.disabled = index === playlist.items.length - 1;
  up.addEventListener('click', () => window.musicBar.playlists.reorderItem(playlist.id, item.id, index - 1));
  down.addEventListener('click', () => window.musicBar.playlists.reorderItem(playlist.id, item.id, index + 1));
  remove.addEventListener('click', () => window.musicBar.playlists.removeItem(playlist.id, item.id));
  actions.append(up, down, edit, remove);
  row.append(main, actions);

  edit.addEventListener('click', () => {
    if (row.querySelector('.history-editor')) return;
    row.classList.add('is-editing');
    const editor = document.createElement('form');
    editor.className = 'history-editor';
    const titleInput = Object.assign(document.createElement('input'), { value: item.title || '', placeholder: '显示名称', maxLength: 300 });
    const urlInput = Object.assign(document.createElement('input'), { value: item.url, placeholder: '网页链接' });
    const save = Object.assign(document.createElement('button'), { type: 'submit', textContent: '保存', className: 'history-save' });
    const cancel = Object.assign(document.createElement('button'), { type: 'button', textContent: '取消', className: 'history-cancel' });
    editor.append(titleInput, urlInput, save, cancel);
    row.append(editor);
    titleInput.focus();
    cancel.addEventListener('click', () => { row.classList.remove('is-editing'); editor.remove(); });
    editor.addEventListener('submit', async event => {
      event.preventDefault();
      save.disabled = true;
      const result = await window.musicBar.playlists.updateItem(playlist.id, item.id, { title: titleInput.value, url: urlInput.value });
      if (!result.ok) {
        save.disabled = false;
        urlInput.setCustomValidity(result.message || '保存失败');
        urlInput.reportValidity();
      }
    });
  });
  return row;
}

function renderPlaylists(items) {
  playlists = Array.isArray(items) ? items : [];
  if (activePlaylistId && !playlists.some(item => item.id === activePlaylistId)) activePlaylistId = null;
  renderLibrary();
}

function renderLibrary() {
  const active = playlists.find(item => item.id === activePlaylistId) || null;
  $('historyTab').classList.toggle('active', !active);
  $('playlistTabs').replaceChildren(...playlists.map(playlist => {
    const button = document.createElement('button');
    button.type = 'button';
    button.classList.toggle('active', playlist.id === active?.id);
    button.textContent = `${playlist.name} · ${playlist.items.length}`;
    button.title = playlist.name;
    button.addEventListener('click', () => { activePlaylistId = playlist.id; closePlaylistEditor(); renderLibrary(); });
    return button;
  }));

  $('renamePlaylist').hidden = !active;
  $('sharePlaylist').hidden = !active;
  $('deletePlaylist').hidden = !active;
  $('importLibrary').textContent = active ? '导入歌单' : '导入历史';
  $('exportLibrary').textContent = active ? '导出歌单' : '导出历史';
  $('libraryViewStatus').textContent = active ? `${active.name} · ${active.items.length} 首` : `最近网页 · ${historyItems.length} 条`;
  const items = active?.items || historyItems;
  historyList.replaceChildren(...(active
    ? items.map((item, index) => playlistItemView(item, index, active))
    : items.map(historyItemView)));
  historyEmpty.hidden = items.length > 0;
  $('libraryEmptyTitle').textContent = active ? '这个歌单还是空的' : '还没有播放记录';
  $('libraryEmptyText').textContent = active ? '回到最近网页，点击“歌单”即可收藏' : '添加网页后会自动保存在这里';
}

function renderRoomStatus(next) {
  roomStatus = { ...roomStatus, ...next };
  const active = roomStatus.mode === 'host' || roomStatus.mode === 'guest';
  $('roomSetup').hidden = active;
  $('roomActive').hidden = !active;
  $('leaveRoom').hidden = !active;
  $('roomToggle').classList.toggle('connected', active && roomStatus.connected !== false);
  $('roomRole').textContent = roomStatus.mode === 'host' ? '房主 · 可编辑与拖动进度' : '受邀者 · 可编辑与拖动进度';
  $('roomPeer').textContent = roomStatus.message || (roomStatus.mode === 'host'
    ? (roomStatus.peerConnected ? '朋友已连接' : '等待朋友加入')
    : (roomStatus.connected ? '已连接房主' : '连接已断开'));
  $('roomStatusText').textContent = active ? $('roomPeer').textContent : '通过互联网连接房主电脑';
  $('roomInvite').value = roomStatus.invite || '';
  $('copyInvite').hidden = !roomStatus.invite;
  document.querySelector('.room-dot')?.classList.toggle('waiting', !roomStatus.peerConnected && roomStatus.mode === 'host');
}

function roomTrackView(track, index, currentId, total) {
  const row = document.createElement('article');
  row.className = 'room-track';
  row.classList.toggle('current', track.id === currentId);
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'room-track-main';
  const name = document.createElement('strong');
  name.textContent = track.title || '未命名网页';
  const detail = document.createElement('span');
  detail.textContent = track.artist || track.url;
  main.append(name, detail);
  main.addEventListener('click', () => window.musicBar.room.operate('playlist:select', { id: track.id }));

  const actions = document.createElement('div');
  actions.className = 'room-track-actions';
  const up = Object.assign(document.createElement('button'), { type: 'button', textContent: '↑', title: '上移' });
  const down = Object.assign(document.createElement('button'), { type: 'button', textContent: '↓', title: '下移' });
  const edit = Object.assign(document.createElement('button'), { type: 'button', textContent: '编辑' });
  const remove = Object.assign(document.createElement('button'), { type: 'button', textContent: '×', title: '删除' });
  remove.className = 'danger';
  up.disabled = index === 0;
  down.disabled = index === total - 1;
  up.addEventListener('click', () => window.musicBar.room.operate('playlist:reorder', { id: track.id, toIndex: index - 1 }));
  down.addEventListener('click', () => window.musicBar.room.operate('playlist:reorder', { id: track.id, toIndex: index + 1 }));
  remove.addEventListener('click', () => window.musicBar.room.operate('playlist:delete', { id: track.id }));
  actions.append(up, down, edit, remove);
  row.append(main, actions);

  edit.addEventListener('click', () => {
    if (row.querySelector('.room-track-editor')) return;
    row.classList.add('is-editing');
    const form = document.createElement('form');
    form.className = 'room-track-editor';
    const titleInput = Object.assign(document.createElement('input'), { value: track.title || '', placeholder: '名称', maxLength: 200 });
    const urlInput = Object.assign(document.createElement('input'), { value: track.url, placeholder: '网页链接' });
    const save = Object.assign(document.createElement('button'), { type: 'submit', textContent: '保存', className: 'save' });
    const cancel = Object.assign(document.createElement('button'), { type: 'button', textContent: '取消' });
    form.append(titleInput, urlInput, save, cancel);
    row.append(form);
    titleInput.focus();
    cancel.addEventListener('click', () => { row.classList.remove('is-editing'); form.remove(); });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const result = await window.musicBar.room.operate('playlist:update', { id: track.id, title: titleInput.value, url: urlInput.value });
      if (!result.ok) {
        urlInput.setCustomValidity(result.message || '保存失败');
        urlInput.reportValidity();
      }
    });
  });
  return row;
}

function renderRoomState(next) {
  roomState = next || null;
  const playlist = Array.isArray(next?.playlist) ? next.playlist : [];
  const currentId = next?.currentId || next?.selectedId || null;
  $('roomPlaylist').replaceChildren(...playlist.map((track, index) => roomTrackView(track, index, currentId, playlist.length)));
  $('roomEmpty').hidden = playlist.length > 0;
  const current = playlist.find(track => track.id === currentId);
  $('roomNowPlaying').textContent = current ? `正在播放：${current.title || current.url}` : '歌单暂时为空';
}

function deviceView(device, selectedDeviceId) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'output-device';
  button.classList.toggle('selected', device.deviceId === selectedDeviceId);
  const icon = document.createElement('span');
  icon.className = 'device-icon';
  icon.textContent = /head|耳机|bluetooth|蓝牙/i.test(device.label) ? '⌁' : '◖';
  const name = document.createElement('strong');
  name.textContent = device.label || '音频设备';
  const check = document.createElement('span');
  check.className = 'device-check';
  check.textContent = '✓';
  button.append(icon, name, check);
  button.addEventListener('click', async () => {
    button.disabled = true;
    setMessage('正在切换输出…', device.label);
    const result = await window.musicBar.output.select(device.deviceId, device.label);
    button.disabled = false;
    if (!result.ok) {
      setMessage('无法切换输出', result.message || '请重试');
      return;
    }
    outputList.querySelectorAll('.output-device').forEach(item => item.classList.remove('selected'));
    button.classList.add('selected');
    setMessage('输出设备已切换', device.label);
    setTimeout(() => { outputOpen = false; syncPanels(); }, 450);
  });
  return button;
}

async function refreshOutputs() {
  outputList.replaceChildren();
  outputEmpty.hidden = false;
  outputEmpty.querySelector('strong').textContent = '正在查找输出设备…';
  outputEmpty.querySelector('small').textContent = '请稍候';
  const result = await window.musicBar.output.list();
  if (!result.ok || !result.devices.length) {
    outputEmpty.querySelector('strong').textContent = result.message || '没有找到输出设备';
    outputEmpty.querySelector('small').textContent = '请检查设备连接，或先载入一个网页';
    return;
  }
  outputEmpty.hidden = true;
  outputList.replaceChildren(...result.devices.map(device => deviceView(device, result.selectedDeviceId)));
}

window.musicBar.onState(render);
window.musicBar.history.onChanged(renderHistory);
window.musicBar.playlists.onChanged(renderPlaylists);
window.musicBar.room.onState(renderRoomState);
window.musicBar.room.onStatus(renderRoomStatus);
window.musicBar.requestState();
window.musicBar.history.list().then(renderHistory);
window.musicBar.playlists.list().then(renderPlaylists);
window.musicBar.room.getState().then(result => {
  if (result?.status) renderRoomStatus(result.status);
  if (result?.state) renderRoomState(result.state);
});

play.addEventListener('click', () => {
  const optimistic = !state.playing;
  state = { ...state, playing: optimistic };
  shell.classList.toggle('playing', optimistic);
  play.textContent = optimistic ? 'Ⅱ' : '▶';
  window.musicBar.toggle();
});
document.querySelectorAll('[data-skip]').forEach(button => button.addEventListener('click', () => window.musicBar.skip(Number(button.dataset.skip))));
function commitSeek() {
  const target = (state.duration || 0) * Number(progress.value) / 1000;
  const now = Date.now();
  seeking = false;
  if (!state.duration || Math.abs(target - lastSeek.value) < .05 && now - lastSeek.at < 350) return;
  lastSeek = { value: target, at: now };
  window.musicBar.seek(target);
}
progress.addEventListener('pointerdown', () => { seeking = true; });
progress.addEventListener('input', () => { seeking = true; elapsed.textContent = format((state.duration || 0) * Number(progress.value) / 1000); });
progress.addEventListener('change', commitSeek);
progress.addEventListener('pointerup', commitSeek);
progress.addEventListener('pointercancel', () => { seeking = false; });
volume.addEventListener('input', () => {
  cancelAnimationFrame(volumeFrame);
  volumeFrame = requestAnimationFrame(() => window.musicBar.volume(volume.value));
});
mute.addEventListener('click', () => window.musicBar.mute());

$('add').addEventListener('click', () => { inputOpen = !inputOpen; historyOpen = false; outputOpen = false; roomOpen = false; syncPanels(); });
$('historyToggle').addEventListener('click', () => { historyOpen = !historyOpen; inputOpen = false; outputOpen = false; roomOpen = false; syncPanels(); });
$('outputToggle').addEventListener('click', () => {
  outputOpen = !outputOpen;
  inputOpen = false;
  historyOpen = false;
  roomOpen = false;
  syncPanels();
  if (outputOpen) refreshOutputs();
});
$('roomToggle').addEventListener('click', () => {
  roomOpen = !roomOpen;
  inputOpen = false;
  historyOpen = false;
  outputOpen = false;
  syncPanels();
});
$('refreshOutputs').addEventListener('click', refreshOutputs);
$('createRoom').addEventListener('click', async () => {
  const button = $('createRoom');
  if (button.disabled) return;
  button.disabled = true;
  setMessage('正在创建房间…', '本机将作为房间服务器');
  const result = await window.musicBar.room.create();
  button.disabled = false;
  if (!result.ok) setMessage('创建失败', result.message || '请重试');
});
$('joinRoomForm').addEventListener('submit', async event => {
  event.preventDefault();
  const invite = $('roomInviteInput').value.trim();
  if (!invite) return;
  const button = $('joinRoomForm').querySelector('button[type="submit"]');
  if (button.disabled) return;
  button.disabled = true;
  setMessage('正在加入房间…', '正在连接房主电脑');
  const result = await window.musicBar.room.join(invite);
  button.disabled = false;
  if (!result.ok) setMessage('加入失败', result.message || '请检查邀请内容');
});
$('leaveRoom').addEventListener('click', () => window.musicBar.room.leave());
$('copyInvite').addEventListener('click', async () => {
  if (!roomStatus.invite) return;
  await window.musicBar.room.copy(roomStatus.invite);
  const original = $('copyInvite').textContent;
  $('copyInvite').textContent = '已复制';
  setTimeout(() => { $('copyInvite').textContent = original; }, 1000);
});
$('roomAddForm').addEventListener('submit', async event => {
  event.preventDefault();
  const input = $('roomUrl');
  if (!input.value.trim()) return;
  const result = await window.musicBar.room.operate('playlist:add', { url: input.value.trim() });
  if (result.ok) input.value = '';
  else {
    input.setCustomValidity(result.message || '无法添加');
    input.reportValidity();
  }
});
$('roomPrevious').addEventListener('click', () => window.musicBar.room.operate('playback:previous'));
$('roomNext').addEventListener('click', () => window.musicBar.room.operate('playback:next'));
$('pin').addEventListener('click', () => {
  pinned = !pinned;
  $('pin').classList.toggle('active', pinned);
  $('pin').title = pinned ? '取消置顶' : '保持置顶';
  window.musicBar.alwaysOnTop(pinned);
});
$('min').addEventListener('click', () => window.musicBar.minimize());
$('close').addEventListener('click', () => window.musicBar.close());
$('source').addEventListener('click', () => window.musicBar.openSource());

async function importPlaylists() {
  const result = await window.musicBar.playlists.import();
  if (result.ok) setMessage('歌单导入完成', result.metadataStarted
    ? `已导入 ${result.count} 个歌单，正在安全读取网页名称`
    : `已导入 ${result.count} 个歌单，未访问其中的网页`);
  else if (!result.canceled) setMessage('导入失败', result.message);
}

$('historyTab').addEventListener('click', () => { activePlaylistId = null; closePlaylistEditor(); renderLibrary(); });
$('newPlaylist').addEventListener('click', () => openPlaylistEditor('create'));
$('cancelPlaylistEditor').addEventListener('click', closePlaylistEditor);
$('playlistEditor').addEventListener('submit', async event => {
  event.preventDefault();
  const input = $('playlistName');
  const button = $('playlistEditor').querySelector('.save');
  if (!input.value.trim() || button.disabled) return;
  button.disabled = true;
  const result = playlistEditorMode === 'rename'
    ? await window.musicBar.playlists.rename(activePlaylistId, input.value)
    : await window.musicBar.playlists.create(input.value);
  button.disabled = false;
  if (!result.ok) {
    input.setCustomValidity(result.message || '保存失败');
    input.reportValidity();
    return;
  }
  if (playlistEditorMode === 'create') activePlaylistId = result.playlist.id;
  closePlaylistEditor();
  renderLibrary();
});
$('renamePlaylist').addEventListener('click', () => openPlaylistEditor('rename'));
$('importPlaylistsTop').addEventListener('click', importPlaylists);
$('importLibrary').addEventListener('click', async () => {
  if (activePlaylistId) return importPlaylists();
  const result = await window.musicBar.history.import();
  if (result.ok) setMessage('历史导入完成', result.metadataStarted
    ? `已导入或更新 ${result.count} 条记录，正在安全读取网页名称`
    : `已导入或更新 ${result.count} 条记录，未访问其中的网页`);
  else if (!result.canceled) setMessage('导入失败', result.message);
});
$('exportLibrary').addEventListener('click', async () => {
  const result = activePlaylistId
    ? await window.musicBar.playlists.export(activePlaylistId)
    : await window.musicBar.history.export();
  if (result.ok) setMessage('导出完成', activePlaylistId ? '歌单名称、网页信息与顺序均已保存' : `已导出 ${result.count} 条记录`);
  else if (!result.canceled) setMessage('导出失败', result.message);
});
$('sharePlaylist').addEventListener('click', async () => {
  const playlist = playlists.find(item => item.id === activePlaylistId);
  if (!playlist || !playlist.items.length) {
    setMessage('歌单还是空的', '请先从最近网页加入内容');
    return;
  }
  const button = $('sharePlaylist');
  button.disabled = true;
  setMessage('正在分享歌单…', '本机将创建加密互联网房间');
  const result = await window.musicBar.room.createFromPlaylist(playlist.id);
  button.disabled = false;
  if (!result.ok) {
    setMessage('分享失败', result.message || '请重试');
    return;
  }
  historyOpen = false;
  roomOpen = true;
  syncPanels();
  setMessage('歌单已进入一起听', '复制邀请发给朋友即可');
});
let deletePlaylistTimer;
$('deletePlaylist').addEventListener('click', async () => {
  const button = $('deletePlaylist');
  if (!button.classList.contains('confirm')) {
    button.classList.add('confirm');
    button.textContent = '确认删除';
    clearTimeout(deletePlaylistTimer);
    deletePlaylistTimer = setTimeout(() => { button.classList.remove('confirm'); button.textContent = '删除'; }, 2600);
    return;
  }
  button.disabled = true;
  const result = await window.musicBar.playlists.delete(activePlaylistId);
  button.disabled = false;
  button.classList.remove('confirm');
  button.textContent = '删除';
  if (!result.ok) setMessage('删除失败', result.message || '请重试');
});

$('form').addEventListener('submit', event => { event.preventDefault(); loadUrl(urlInput.value); });
document.addEventListener('keydown', event => {
  if (event.target.matches('input, textarea, select, button')) return;
  if (event.code === 'Space') { event.preventDefault(); play.click(); }
  if (event.code === 'ArrowLeft') window.musicBar.skip(-10);
  if (event.code === 'ArrowRight') window.musicBar.skip(10);
  if (event.code === 'Escape' && (inputOpen || historyOpen || outputOpen || roomOpen)) { inputOpen = false; historyOpen = false; outputOpen = false; roomOpen = false; syncPanels(); }
});
