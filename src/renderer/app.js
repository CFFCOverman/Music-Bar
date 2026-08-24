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
let pinned = true;
let volumeFrame = null;

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
  const height = roomOpen ? 520 : (outputOpen ? 370 : (historyOpen ? (inputOpen ? 490 : 430) : (inputOpen ? 154 : 92)));
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
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'history-edit';
  edit.textContent = '编辑';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'history-delete';
  remove.textContent = '删除';
  actions.append(edit, remove);
  row.append(main, actions);

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
  historyList.replaceChildren(...items.map(historyItemView));
  historyEmpty.hidden = items.length > 0;
}

function renderRoomStatus(next) {
  roomStatus = { ...roomStatus, ...next };
  const active = roomStatus.mode === 'host' || roomStatus.mode === 'guest';
  $('roomSetup').hidden = active;
  $('roomActive').hidden = !active;
  $('leaveRoom').hidden = !active;
  $('roomToggle').classList.toggle('connected', active && roomStatus.connected !== false);
  $('roomRole').textContent = roomStatus.mode === 'host' ? '房主 · 互联网房间' : '受邀者 · 可编辑';
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
window.musicBar.room.onState(renderRoomState);
window.musicBar.room.onStatus(renderRoomStatus);
window.musicBar.requestState();
window.musicBar.history.list().then(renderHistory);
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
progress.addEventListener('input', () => { seeking = true; elapsed.textContent = format((state.duration || 0) * Number(progress.value) / 1000); });
progress.addEventListener('change', () => { window.musicBar.seek((state.duration || 0) * Number(progress.value) / 1000); seeking = false; });
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
$('importHistory').addEventListener('click', async () => {
  const result = await window.musicBar.history.import();
  if (result.ok) setMessage('导入完成', `已导入或更新 ${result.count} 条记录`);
  else if (!result.canceled) setMessage('导入失败', result.message);
});
$('exportHistory').addEventListener('click', async () => {
  const result = await window.musicBar.history.export();
  if (result.ok) setMessage('导出完成', `已导出 ${result.count} 条记录`);
  else if (!result.canceled) setMessage('导出失败', result.message);
});

$('form').addEventListener('submit', event => { event.preventDefault(); loadUrl(urlInput.value); });
document.addEventListener('keydown', event => {
  if (event.target.matches('input, textarea')) return;
  if (event.code === 'Space') { event.preventDefault(); play.click(); }
  if (event.code === 'ArrowLeft') window.musicBar.skip(-10);
  if (event.code === 'ArrowRight') window.musicBar.skip(10);
  if (event.code === 'Escape' && (inputOpen || historyOpen || outputOpen || roomOpen)) { inputOpen = false; historyOpen = false; outputOpen = false; roomOpen = false; syncPanels(); }
});
