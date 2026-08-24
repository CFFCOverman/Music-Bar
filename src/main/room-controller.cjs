const { randomBytes } = require('crypto');
const { RoomClient, RoomHost } = require('./room.cjs');
const { normalizeUrl } = require('./store.cjs');
const { InternetTunnel } = require('./tunnel.cjs');

const emptyStatus = () => ({ mode: 'none', connected: false, peerConnected: false, invite: '', message: '' });

class RoomController {
  constructor({ media, store, send, getPlayerState, setCurrentHistoryId, setPlayerMessage }) {
    this.media = media;
    this.store = store;
    this.send = send;
    this.getPlayerState = getPlayerState;
    this.setCurrentHistoryId = setCurrentHistoryId;
    this.setPlayerMessage = setPlayerMessage;
    this.session = null;
    this.tunnel = null;
    this.mode = 'none';
    this.invite = '';
    this.status = emptyStatus();
    this.state = null;
    this.loadedTrackKey = '';
    this.lastPlaybackSignature = '';
    this.syncRunning = false;
    this.syncPending = false;
  }

  get active() { return Boolean(this.session); }

  getSnapshot() {
    return { status: { ...this.status }, state: this.toRendererState(this.state) };
  }

  toRendererState(state) {
    return state ? { ...state, currentId: state.selectedId } : null;
  }

  publishStatus(patch = {}) {
    this.status = { ...this.status, ...patch, mode: this.mode, invite: this.invite };
    this.send('room:status', this.status);
  }

  reportError(error) {
    this.publishStatus({ message: error?.message || '房间操作失败' });
  }

  cleanTitle(value, fallback = '网页音频') {
    const title = String(value || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
    return title || fallback;
  }

  defaultTitle(url) {
    try { return new URL(url).hostname.replace(/^www\./i, '') || '网页音频'; }
    catch { return '网页音频'; }
  }

  expectedPosition(playback) {
    const elapsed = playback?.playing ? Math.max(0, Date.now() - Number(playback.changedAt || Date.now())) / 1000 : 0;
    return Math.max(0, Number(playback?.position || 0) + elapsed);
  }

  playbackSignature(state) {
    const playback = state?.playback;
    return `${state?.selectedId || ''}|${Boolean(playback?.playing)}|${Number(playback?.position || 0)}|${Number(playback?.changedAt || 0)}`;
  }

  acceptState(session, state) {
    if (this.session !== session || !state) return;
    this.state = state;
    this.send('room:state', this.toRendererState(state));
    void this.synchronizeMedia();
  }

  async synchronizeMedia() {
    if (this.syncRunning) {
      this.syncPending = true;
      return;
    }
    this.syncRunning = true;
    try {
      do {
        this.syncPending = false;
        const snapshot = this.state;
        const track = snapshot?.playlist?.find(item => item.id === snapshot.selectedId) || null;
        if (!track) {
          if (this.loadedTrackKey) this.media.syncPlayback({ position: 0, playing: false });
          this.loadedTrackKey = '';
          this.lastPlaybackSignature = this.playbackSignature(snapshot);
          continue;
        }

        const trackKey = `${track.id}|${track.url}`;
        if (trackKey !== this.loadedTrackKey) {
          this.loadedTrackKey = trackKey;
          try {
            const item = await this.store.upsertHistory(track.url, {
              title: this.cleanTitle(track.title, this.defaultTitle(track.url)),
            });
            this.setCurrentHistoryId(item?.id || null);
            if (this.media.getCurrentUrl() !== track.url) await this.media.load(track.url);
          } catch (error) {
            if (this.state === snapshot) this.setPlayerMessage({ ready: false, title: '网页加载失败', artist: error.message });
          }
        }

        if (this.state !== snapshot) {
          this.syncPending = true;
          continue;
        }
        const signature = this.playbackSignature(snapshot);
        if (signature !== this.lastPlaybackSignature) {
          this.lastPlaybackSignature = signature;
          this.media.syncPlayback({
            position: this.expectedPosition(snapshot.playback),
            playing: Boolean(snapshot.playback?.playing),
          });
        }
      } while (this.syncPending);
    } finally {
      this.syncRunning = false;
      if (this.syncPending) void this.synchronizeMedia();
    }
  }

  handleHostStatus(session, event) {
    if (this.session !== session) return;
    if (event?.status === 'listening') this.publishStatus({ connected: false, peerConnected: false, message: '本机服务已启动，正在连接互联网…' });
    if (event?.status === 'guest-connected') this.publishStatus({ connected: true, peerConnected: true, message: '朋友已连接' });
    if (event?.status === 'guest-disconnected') this.publishStatus({ connected: true, peerConnected: false, message: '朋友已离开，可继续等待' });
    if (event?.status === 'error') this.publishStatus({ message: event.message || '本机房间服务发生错误' });
  }

  handleGuestStatus(session, event) {
    if (this.session !== session) return;
    if (event?.status === 'connecting') this.publishStatus({ connected: false, peerConnected: false, message: '正在连接房主电脑…' });
    if (event?.status === 'connected') this.publishStatus({ connected: true, peerConnected: true, message: '已连接房主' });
    if (event?.status === 'disconnected') this.publishStatus({ connected: false, peerConnected: false, message: event.message || '与房主的连接已断开' });
    if (event?.status === 'error') this.publishStatus({ message: event.message || '房间连接发生错误' });
  }

  handleTunnelStatus(tunnel, event) {
    if (this.tunnel !== tunnel) return;
    if (event?.status === 'starting') this.publishStatus({ connected: false, peerConnected: false, message: '正在建立加密互联网连接…' });
    if (event?.status === 'address') this.publishStatus({ connected: false, peerConnected: false, message: '公网地址已创建，正在完成连接…' });
    if (event?.status === 'disconnected') {
      this.invite = '';
      this.publishStatus({ connected: false, peerConnected: false, message: '互联网连接已断开，请重新创建房间' });
    }
    if (event?.status === 'error') this.publishStatus({ connected: false, message: event.message || '互联网连接失败' });
  }

  makeInitialState() {
    const url = normalizeUrl(this.media.getCurrentUrl());
    if (!url) return undefined;
    const player = this.getPlayerState();
    const id = randomBytes(12).toString('base64url');
    return {
      playlist: [{ id, title: this.cleanTitle(player.title, this.defaultTitle(url)), url }],
      selectedId: id,
      playback: {
        playing: Boolean(player.playing),
        position: Math.max(0, Number(player.currentTime || 0)),
        changedAt: Date.now(),
      },
    };
  }

  async create() {
    await this.leave();
    this.mode = 'host';
    this.status = { mode: 'host', connected: false, peerConnected: false, invite: '', message: '正在启动本机服务器…' };
    let session;
    session = new RoomHost({
      host: '127.0.0.1',
      initialState: this.makeInitialState(),
      onState: state => this.acceptState(session, state),
      onStatus: event => this.handleHostStatus(session, event),
    });
    this.session = session;
    this.publishStatus();
    try {
      const result = await session.start();
      if (this.session !== session) throw new Error('房间创建已取消');
      this.publishStatus({ connected: false, peerConnected: false, message: '正在建立加密互联网连接…' });
      let tunnel;
      tunnel = new InternetTunnel({ onStatus: event => this.handleTunnelStatus(tunnel, event) });
      this.tunnel = tunnel;
      const internet = await tunnel.start(result.port);
      if (this.session !== session || this.tunnel !== tunnel) throw new Error('房间创建已取消');
      this.invite = session.createInvite([internet.endpoint]);
      this.publishStatus({ connected: true, peerConnected: false, message: '等待朋友通过互联网加入' });
      this.acceptState(session, session.getState());
      return { ok: true, invite: this.invite };
    } catch (error) {
      if (this.session === session) await this.leave();
      return { ok: false, message: error.message };
    }
  }

  async join(invite) {
    await this.leave();
    this.mode = 'guest';
    this.status = { mode: 'guest', connected: false, peerConnected: false, invite: '', message: '正在连接房主电脑…' };
    let session;
    try {
      session = new RoomClient({
        invite: String(invite || '').trim(),
        endpointTimeoutMs: 10000,
        onState: state => this.acceptState(session, state),
        onStatus: event => this.handleGuestStatus(session, event),
      });
    } catch (error) {
      this.mode = 'none';
      this.status = emptyStatus();
      this.send('room:status', this.status);
      return { ok: false, message: error.message };
    }
    this.session = session;
    this.publishStatus();
    try {
      await session.connect();
      return { ok: true };
    } catch (error) {
      if (this.session === session) await this.leave();
      return { ok: false, message: error.message };
    }
  }

  async leave() {
    const session = this.session;
    const tunnel = this.tunnel;
    this.session = null;
    this.tunnel = null;
    this.mode = 'none';
    this.invite = '';
    this.state = null;
    this.loadedTrackKey = '';
    this.lastPlaybackSignature = '';
    this.syncPending = false;
    this.status = emptyStatus();
    this.send('room:state', null);
    this.send('room:status', this.status);
    await Promise.allSettled([
      Promise.resolve().then(() => tunnel?.close()),
      Promise.resolve().then(() => session?.close()),
    ]);
    return { ok: true };
  }

  async apply(operation) {
    if (!this.session || this.mode === 'none') throw new Error('请先创建或加入房间');
    return this.mode === 'host' ? this.session.applyOperation(operation) : this.session.sendOperation(operation);
  }

  toOperation(type, payload = {}) {
    if (type === 'playlist:add') {
      const url = normalizeUrl(payload.url);
      if (!url) throw new Error('请输入有效的网页链接或 BV 号');
      return {
        type: 'playlist.add',
        ...(payload.id ? { id: String(payload.id) } : {}),
        title: this.cleanTitle(payload.title, this.defaultTitle(url)),
        url,
      };
    }
    if (type === 'playlist:update') {
      const url = normalizeUrl(payload.url);
      if (!url) throw new Error('请输入有效的网页链接或 BV 号');
      return { type: 'playlist.update', itemId: String(payload.id || ''), title: this.cleanTitle(payload.title, this.defaultTitle(url)), url };
    }
    if (type === 'playlist:delete') return { type: 'playlist.delete', itemId: String(payload.id || '') };
    if (type === 'playlist:reorder') return { type: 'playlist.reorder', itemId: String(payload.id || ''), index: Number(payload.toIndex) };
    if (type === 'playlist:select') return { type: 'playlist.select', itemId: String(payload.id || '') };
    if (type === 'playback:next') return { type: 'next' };
    if (type === 'playback:previous') return { type: 'previous' };
    throw new Error('不支持的房间操作');
  }

  async operate(type, payload) {
    try {
      const result = await this.apply(this.toOperation(type, payload));
      return { ok: true, revision: result?.revision };
    } catch (error) {
      this.reportError(error);
      return { ok: false, message: error.message };
    }
  }

  async addAndSelect(raw) {
    const url = normalizeUrl(raw);
    if (!url) return { ok: false, message: '请输入有效的网页链接或 BV 号' };
    try {
      const id = randomBytes(12).toString('base64url');
      await this.apply({ type: 'playlist.add', id, title: this.defaultTitle(url), url });
      await this.apply({ type: 'playlist.select', itemId: id });
      return { ok: true, url, room: true };
    } catch (error) {
      this.reportError(error);
      return { ok: false, message: error.message };
    }
  }

  submitPlaybackState(state) {
    if (!this.session || !state) return;
    this.apply({
      type: 'playback.set',
      playing: Boolean(state.playing),
      position: Math.max(0, Number(state.currentTime || 0)),
    }).catch(error => this.reportError(error));
  }

  onEnded() {
    if (this.mode === 'host' && this.session && this.state?.selectedId) {
      this.apply({ type: 'next' }).catch(error => this.reportError(error));
    }
  }

  dispose() {
    const session = this.session;
    const tunnel = this.tunnel;
    this.session = null;
    this.tunnel = null;
    try { Promise.resolve(session?.close()).catch(() => {}); } catch {}
    try { Promise.resolve(tunnel?.close()).catch(() => {}); } catch {}
  }
}

module.exports = { RoomController };
