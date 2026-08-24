'use strict';

const http = require('http');
const os = require('os');
const {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} = require('crypto');
const { TextDecoder } = require('util');
const { WebSocket, WebSocketServer } = require('ws');

const INVITE_PREFIX = 'MB1.';
const MAX_PAYLOAD = 32 * 1024;
// Base64 and the authenticated envelope add overhead inside the 32 KiB WebSocket cap.
const MAX_SECURE_PLAINTEXT = 23 * 1024;
const MAX_INVITE_LENGTH = 4096;
const MAX_ENDPOINTS = 8;
const MAX_ENDPOINT_LENGTH = 512;
const MAX_PLAYLIST_ITEMS = 200;
const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 200;
const MAX_ID_LENGTH = 64;
const MAX_POSITION = 7 * 24 * 60 * 60;
const MAX_SEEN_OPERATIONS = 2048;
const AUTH_TIMEOUT_MS = 5000;
const DEFAULT_ENDPOINT_TIMEOUT_MS = 3500;
const HEARTBEAT_MS = 30000;
const RATE_BURST = 40;
const RATE_PER_SECOND = 20;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const AUTH_PROTOCOL = Buffer.from('music-bar-room-auth-v1\0', 'utf8');
const KDF_PROTOCOL = Buffer.from('music-bar-room-e2e-v1', 'utf8');

class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOnlyKeys(value, allowed, required = []) {
  if (!isPlainObject(value)) return false;
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some(key => !allowedSet.has(key))) return false;
  return required.every(key => own(value, key));
}

function isSafeInteger(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function isFiniteNumber(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isBoundedString(value, min, max) {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function isIdentifier(value) {
  return isBoundedString(value, 1, MAX_ID_LENGTH) && /^[A-Za-z0-9_-]+$/.test(value);
}

function isOperationId(value) {
  return isBoundedString(value, 8, MAX_ID_LENGTH) && /^[A-Za-z0-9_-]+$/.test(value);
}

function decodeCanonicalBase64Url(value, byteLength) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.length !== byteLength || decoded.toString('base64url') !== value) return null;
    return decoded;
  } catch {
    return null;
  }
}

function validateRoomId(value) {
  return isBoundedString(value, 16, MAX_ID_LENGTH) && /^[A-Za-z0-9_-]+$/.test(value);
}

function validateToken(value) {
  return decodeCanonicalBase64Url(value, 32) !== null;
}

function decodeBoundedBase64Url(value, minBytes, maxBytes) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.length < minBytes || decoded.length > maxBytes || decoded.toString('base64url') !== value) return null;
    return decoded;
  } catch {
    return null;
  }
}

function authenticationTranscript(role, roomId, clientNonce, serverNonce) {
  const room = Buffer.from(roomId, 'utf8');
  const roomLength = Buffer.allocUnsafe(2);
  roomLength.writeUInt16BE(room.length);
  return Buffer.concat([
    AUTH_PROTOCOL,
    Buffer.from(role === 'server' ? [1] : [2]),
    roomLength,
    room,
    clientNonce,
    serverNonce,
  ]);
}

function authenticationProof(tokenBytes, role, roomId, clientNonce, serverNonce) {
  return createHmac('sha256', tokenBytes)
    .update(authenticationTranscript(role, roomId, clientNonce, serverNonce))
    .digest();
}

function deriveSession(tokenBytes, roomId, clientNonce, serverNonce) {
  const room = Buffer.from(roomId, 'utf8');
  const transcriptHash = createHash('sha256')
    .update(KDF_PROTOCOL)
    .update(room)
    .update(clientNonce)
    .update(serverNonce)
    .digest();
  const derive = (label, length) => Buffer.from(hkdfSync(
    'sha256',
    tokenBytes,
    transcriptHash,
    Buffer.from(`music-bar:${label}`, 'utf8'),
    length,
  ));
  return {
    sessionId: transcriptHash.subarray(0, 16).toString('base64url'),
    clientToServerKey: derive('client-to-server:key', 32),
    serverToClientKey: derive('server-to-client:key', 32),
    clientToServerNonce: derive('client-to-server:nonce', 4),
    serverToClientNonce: derive('server-to-client:nonce', 4),
  };
}

function makeSecureContext(session, role) {
  const isHost = role === 'host';
  return {
    sessionId: session.sessionId,
    sendKey: isHost ? session.serverToClientKey : session.clientToServerKey,
    receiveKey: isHost ? session.clientToServerKey : session.serverToClientKey,
    sendNoncePrefix: isHost ? session.serverToClientNonce : session.clientToServerNonce,
    receiveNoncePrefix: isHost ? session.clientToServerNonce : session.serverToClientNonce,
    sendDirection: isHost ? 's2c' : 'c2s',
    receiveDirection: isHost ? 'c2s' : 's2c',
    sendCounter: 0,
    receiveCounter: 0,
  };
}

function counterNonce(prefix, counter) {
  const nonce = Buffer.allocUnsafe(12);
  prefix.copy(nonce, 0);
  nonce.writeBigUInt64BE(BigInt(counter), 4);
  return nonce;
}

function secureAad(roomId, sessionId, direction, counter) {
  return Buffer.from(`MB1|${roomId}|${sessionId}|${direction}|${counter}`, 'utf8');
}

function encryptSecureMessage(socket, roomId, value) {
  const secure = socket?.secure;
  if (!secure) throw new ProtocolError('secure_session_required', '安全会话尚未建立');
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  if (plaintext.length > MAX_SECURE_PLAINTEXT) throw new ProtocolError('message_too_large', '加密消息过大');
  const counter = secure.sendCounter + 1;
  if (!Number.isSafeInteger(counter)) throw new ProtocolError('counter_exhausted', '安全消息计数器已达到上限');
  const nonce = counterNonce(secure.sendNoncePrefix, counter);
  const cipher = createCipheriv('aes-256-gcm', secure.sendKey, nonce, { authTagLength: 16 });
  cipher.setAAD(secureAad(roomId, secure.sessionId, secure.sendDirection, counter));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope = {
    type: 'secure',
    counter,
    ciphertext: ciphertext.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  };
  if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > MAX_PAYLOAD) {
    throw new ProtocolError('message_too_large', '加密消息超过传输上限');
  }
  secure.sendCounter = counter;
  return envelope;
}

function decryptSecureMessage(socket, roomId, envelope) {
  const secure = socket?.secure;
  if (!secure || !hasOnlyKeys(envelope, ['type', 'counter', 'ciphertext', 'tag'], ['type', 'counter', 'ciphertext', 'tag']) ||
      envelope.type !== 'secure' || !isSafeInteger(envelope.counter, 1, Number.MAX_SAFE_INTEGER) ||
      envelope.counter !== secure.receiveCounter + 1) {
    throw new ProtocolError('invalid_secure_envelope', '加密消息顺序或格式无效');
  }
  const ciphertext = decodeBoundedBase64Url(envelope.ciphertext, 1, MAX_SECURE_PLAINTEXT + 32);
  const tag = decodeCanonicalBase64Url(envelope.tag, 16);
  if (!ciphertext || !tag) throw new ProtocolError('invalid_secure_envelope', '加密消息编码无效');
  const nonce = counterNonce(secure.receiveNoncePrefix, envelope.counter);
  let plaintext;
  try {
    const decipher = createDecipheriv('aes-256-gcm', secure.receiveKey, nonce, { authTagLength: 16 });
    decipher.setAAD(secureAad(roomId, secure.sessionId, secure.receiveDirection, envelope.counter));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new ProtocolError('authentication_failed', '加密消息认证失败');
  }
  if (plaintext.length > MAX_SECURE_PLAINTEXT) throw new ProtocolError('message_too_large', '解密消息过大');
  let message;
  try { message = JSON.parse(UTF8_DECODER.decode(plaintext)); }
  catch { throw new ProtocolError('invalid_json', '解密消息不是有效 JSON'); }
  if (!isPlainObject(message)) throw new ProtocolError('invalid_message', '解密消息格式无效');
  secure.receiveCounter = envelope.counter;
  return message;
}

function destroySecureContext(socket) {
  const secure = socket?.secure;
  if (!secure) return;
  for (const value of [secure.sendKey, secure.receiveKey, secure.sendNoncePrefix, secure.receiveNoncePrefix]) value?.fill?.(0);
  socket.secure = null;
}

function normalizeMediaUrl(value) {
  if (!isBoundedString(value, 1, MAX_URL_LENGTH)) throw new ProtocolError('invalid_url', '链接格式无效');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ProtocolError('invalid_url', '链接格式无效');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new ProtocolError('invalid_url', '仅支持 http/https 网页链接');
  }
  const normalized = url.toString();
  if (normalized.length > MAX_URL_LENGTH) throw new ProtocolError('invalid_url', '链接过长');
  return normalized;
}

function normalizeTitle(value) {
  if (!isBoundedString(value, 1, MAX_TITLE_LENGTH)) throw new ProtocolError('invalid_title', '标题格式无效');
  const title = value.trim();
  if (!title || title.length > MAX_TITLE_LENGTH) throw new ProtocolError('invalid_title', '标题格式无效');
  return title;
}

function normalizeEndpoint(value, roomId) {
  if (!isBoundedString(value, 1, MAX_ENDPOINT_LENGTH)) throw new Error('邀请地址无效');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('邀请地址无效');
  }
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('邀请地址必须是 ws/wss 地址且不能包含凭据、查询参数或片段');
  }
  const expectedPath = `/room/${roomId}`;
  if (url.pathname === '/' || url.pathname === '') url.pathname = expectedPath;
  if (url.pathname !== expectedPath) throw new Error('邀请地址路径与房间不匹配');
  const normalized = url.toString();
  if (normalized.length > MAX_ENDPOINT_LENGTH) throw new Error('邀请地址过长');
  return normalized;
}

function createInvite({ endpoints, roomId, token }) {
  if (!validateRoomId(roomId)) throw new Error('房间 ID 无效');
  if (!validateToken(token)) throw new Error('房间令牌无效');
  if (!Array.isArray(endpoints) || endpoints.length < 1 || endpoints.length > MAX_ENDPOINTS) {
    throw new Error('邀请地址数量无效');
  }
  const normalizedEndpoints = [...new Set(endpoints.map(endpoint => normalizeEndpoint(endpoint, roomId)))];
  const payload = { v: 1, endpoints: normalizedEndpoints, roomId, token };
  const invite = `${INVITE_PREFIX}${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
  if (invite.length > MAX_INVITE_LENGTH) throw new Error('邀请内容过长');
  return invite;
}

function parseInvite(invite) {
  if (!isBoundedString(invite, INVITE_PREFIX.length + 1, MAX_INVITE_LENGTH) || !invite.startsWith(INVITE_PREFIX)) {
    throw new Error('邀请格式无效');
  }
  const encoded = invite.slice(INVITE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('邀请格式无效');
  let payload;
  try {
    const buffer = Buffer.from(encoded, 'base64url');
    if (buffer.toString('base64url') !== encoded) throw new Error('non-canonical');
    payload = JSON.parse(UTF8_DECODER.decode(buffer));
  } catch {
    throw new Error('邀请内容无效');
  }
  if (!hasOnlyKeys(payload, ['v', 'endpoints', 'roomId', 'token'], ['v', 'endpoints', 'roomId', 'token']) || payload.v !== 1) {
    throw new Error('不支持的邀请版本');
  }
  if (!validateRoomId(payload.roomId) || !validateToken(payload.token)) throw new Error('邀请凭据无效');
  if (!Array.isArray(payload.endpoints) || payload.endpoints.length < 1 || payload.endpoints.length > MAX_ENDPOINTS) {
    throw new Error('邀请地址数量无效');
  }
  const endpoints = [...new Set(payload.endpoints.map(endpoint => normalizeEndpoint(endpoint, payload.roomId)))];
  return Object.freeze({ endpoints: Object.freeze(endpoints), roomId: payload.roomId, token: payload.token });
}

function listHostEndpoints(portOrOptions, maybeHost) {
  const options = typeof portOrOptions === 'object'
    ? portOrOptions
    : { port: portOrOptions, host: maybeHost };
  const port = Number(options?.port);
  const host = options?.host || '0.0.0.0';
  const secure = Boolean(options?.secure);
  if (!isSafeInteger(port, 1, 65535)) throw new Error('监听端口无效');
  const protocol = secure ? 'wss' : 'ws';
  const addresses = [];
  if (!['0.0.0.0', '::', '::0'].includes(host)) {
    addresses.push(host);
  } else {
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries || []) {
        if (entry.family === 'IPv4' && !entry.internal && isUsableAdvertisedIpv4(entry.address)) addresses.push(entry.address);
      }
    }
    if (!addresses.length) addresses.push('127.0.0.1');
  }
  return [...new Set(addresses)].slice(0, MAX_ENDPOINTS).map(address => {
    const formatted = address.includes(':') && !address.startsWith('[') ? `[${address}]` : address;
    return `${protocol}://${formatted}:${port}`;
  });
}

function isUsableAdvertisedIpv4(address) {
  const parts = typeof address === 'string' ? address.split('.').map(Number) : [];
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  if (parts[0] === 0 || parts[0] >= 224) return false;
  if (parts[0] === 169 && parts[1] === 254) return false;
  return true;
}

function validatePlaylistItem(item) {
  if (!hasOnlyKeys(item, ['id', 'title', 'url'], ['id', 'title', 'url']) || !isIdentifier(item.id)) {
    throw new ProtocolError('invalid_item', '歌单条目格式无效');
  }
  return { id: item.id, title: normalizeTitle(item.title), url: normalizeMediaUrl(item.url) };
}

function validatePlayback(playback) {
  if (!hasOnlyKeys(playback, ['playing', 'position', 'changedAt'], ['playing', 'position', 'changedAt']) ||
      typeof playback.playing !== 'boolean' ||
      !isFiniteNumber(playback.position, 0, MAX_POSITION) ||
      !isSafeInteger(playback.changedAt, 0, Number.MAX_SAFE_INTEGER)) {
    throw new ProtocolError('invalid_state', '播放状态格式无效');
  }
  return { playing: playback.playing, position: playback.position, changedAt: playback.changedAt };
}

function validateState(state, expectedRoomId) {
  if (!hasOnlyKeys(state, ['roomId', 'revision', 'playlist', 'selectedId', 'playback'],
    ['roomId', 'revision', 'playlist', 'selectedId', 'playback']) ||
    !validateRoomId(state.roomId) || (expectedRoomId && state.roomId !== expectedRoomId) ||
    !isSafeInteger(state.revision, 0, Number.MAX_SAFE_INTEGER) ||
    !Array.isArray(state.playlist) || state.playlist.length > MAX_PLAYLIST_ITEMS) {
    throw new ProtocolError('invalid_state', '房间状态格式无效');
  }
  const playlist = state.playlist.map(validatePlaylistItem);
  const ids = new Set(playlist.map(item => item.id));
  if (ids.size !== playlist.length ||
      !(state.selectedId === null || (isIdentifier(state.selectedId) && ids.has(state.selectedId)))) {
    throw new ProtocolError('invalid_state', '歌单选择状态无效');
  }
  return {
    roomId: state.roomId,
    revision: state.revision,
    playlist,
    selectedId: state.selectedId,
    playback: validatePlayback(state.playback),
  };
}

function validateOperation(operation) {
  if (!isPlainObject(operation) || typeof operation.type !== 'string') {
    throw new ProtocolError('invalid_operation', '操作格式无效');
  }
  switch (operation.type) {
    case 'playlist.add': {
      if (!hasOnlyKeys(operation, ['type', 'id', 'title', 'url', 'index'], ['type', 'title', 'url'])) {
        throw new ProtocolError('invalid_operation', '添加操作格式无效');
      }
      if (own(operation, 'id') && !isIdentifier(operation.id)) throw new ProtocolError('invalid_operation', '条目 ID 无效');
      if (own(operation, 'index') && !isSafeInteger(operation.index, 0, MAX_PLAYLIST_ITEMS)) {
        throw new ProtocolError('invalid_operation', '歌单位置无效');
      }
      return {
        type: operation.type,
        ...(own(operation, 'id') ? { id: operation.id } : {}),
        title: normalizeTitle(operation.title),
        url: normalizeMediaUrl(operation.url),
        ...(own(operation, 'index') ? { index: operation.index } : {}),
      };
    }
    case 'playlist.update': {
      if (!hasOnlyKeys(operation, ['type', 'itemId', 'title', 'url'], ['type', 'itemId']) || !isIdentifier(operation.itemId) ||
          (!own(operation, 'title') && !own(operation, 'url'))) {
        throw new ProtocolError('invalid_operation', '修改操作格式无效');
      }
      return {
        type: operation.type,
        itemId: operation.itemId,
        ...(own(operation, 'title') ? { title: normalizeTitle(operation.title) } : {}),
        ...(own(operation, 'url') ? { url: normalizeMediaUrl(operation.url) } : {}),
      };
    }
    case 'playlist.delete':
    case 'playlist.select': {
      if (!hasOnlyKeys(operation, ['type', 'itemId'], ['type', 'itemId']) || !isIdentifier(operation.itemId)) {
        throw new ProtocolError('invalid_operation', '歌单操作格式无效');
      }
      return { type: operation.type, itemId: operation.itemId };
    }
    case 'playlist.reorder': {
      if (!hasOnlyKeys(operation, ['type', 'itemId', 'index'], ['type', 'itemId', 'index']) ||
          !isIdentifier(operation.itemId) || !isSafeInteger(operation.index, 0, MAX_PLAYLIST_ITEMS - 1)) {
        throw new ProtocolError('invalid_operation', '排序操作格式无效');
      }
      return { type: operation.type, itemId: operation.itemId, index: operation.index };
    }
    case 'playback.set': {
      if (!hasOnlyKeys(operation, ['type', 'playing', 'position'], ['type']) ||
          (!own(operation, 'playing') && !own(operation, 'position')) ||
          (own(operation, 'playing') && typeof operation.playing !== 'boolean') ||
          (own(operation, 'position') && !isFiniteNumber(operation.position, 0, MAX_POSITION))) {
        throw new ProtocolError('invalid_operation', '播放操作格式无效');
      }
      return {
        type: operation.type,
        ...(own(operation, 'playing') ? { playing: operation.playing } : {}),
        ...(own(operation, 'position') ? { position: operation.position } : {}),
      };
    }
    case 'next':
    case 'previous':
      if (!hasOnlyKeys(operation, ['type'], ['type'])) throw new ProtocolError('invalid_operation', '切歌操作格式无效');
      return { type: operation.type };
    default:
      throw new ProtocolError('invalid_operation', '不支持的房间操作');
  }
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeInitialState(roomId, initialState) {
  const now = Date.now();
  if (initialState === undefined || initialState === null) {
    const state = { roomId, revision: 0, playlist: [], selectedId: null, playback: { playing: false, position: 0, changedAt: now } };
    ensureStateFits(state);
    return state;
  }
  if (!isPlainObject(initialState)) throw new Error('初始房间状态无效');
  const candidate = {
    roomId,
    revision: own(initialState, 'revision') ? initialState.revision : 0,
    playlist: own(initialState, 'playlist') ? initialState.playlist : [],
    selectedId: own(initialState, 'selectedId') ? initialState.selectedId : null,
    playback: own(initialState, 'playback') ? initialState.playback : { playing: false, position: 0, changedAt: now },
  };
  const allowed = ['roomId', 'revision', 'playlist', 'selectedId', 'playback'];
  if (Object.keys(initialState).some(key => !allowed.includes(key))) throw new Error('初始房间状态包含未知字段');
  try {
    const state = validateState(candidate, roomId);
    ensureStateFits(state);
    return state;
  } catch (error) {
    throw new Error(error.message);
  }
}

function currentPosition(playback, now) {
  if (!playback.playing) return playback.position;
  return Math.min(MAX_POSITION, playback.position + Math.max(0, now - playback.changedAt) / 1000);
}

function ensureStateFits(state) {
  const plaintextSize = Buffer.byteLength(JSON.stringify({ type: 'welcome', role: 'guest', state, serverTime: Date.now() }), 'utf8');
  if (plaintextSize > MAX_SECURE_PLAINTEXT) throw new ProtocolError('state_too_large', '房间歌单数据已达到安全消息上限');
}

function applyOperationToState(state, operation) {
  const next = jsonClone(state);
  const now = Date.now();
  if (next.revision >= Number.MAX_SAFE_INTEGER) throw new ProtocolError('revision_exhausted', '房间版本号已达到上限');
  switch (operation.type) {
    case 'playlist.add': {
      if (next.playlist.length >= MAX_PLAYLIST_ITEMS) throw new ProtocolError('playlist_full', '歌单已达到 200 首上限');
      const id = operation.id || randomBytes(12).toString('base64url');
      if (next.playlist.some(item => item.id === id)) throw new ProtocolError('duplicate_item', '歌单条目 ID 已存在');
      const index = own(operation, 'index') ? Math.min(operation.index, next.playlist.length) : next.playlist.length;
      next.playlist.splice(index, 0, { id, title: operation.title, url: operation.url });
      if (next.selectedId === null) next.selectedId = id;
      break;
    }
    case 'playlist.update': {
      const item = next.playlist.find(candidate => candidate.id === operation.itemId);
      if (!item) throw new ProtocolError('item_not_found', '歌曲已不存在');
      if (own(operation, 'title')) item.title = operation.title;
      if (own(operation, 'url')) item.url = operation.url;
      break;
    }
    case 'playlist.delete': {
      const index = next.playlist.findIndex(item => item.id === operation.itemId);
      if (index < 0) throw new ProtocolError('item_not_found', '歌曲已不存在');
      const wasSelected = next.selectedId === operation.itemId;
      next.playlist.splice(index, 1);
      if (wasSelected) {
        next.selectedId = next.playlist.length ? next.playlist[Math.min(index, next.playlist.length - 1)].id : null;
        next.playback = { playing: next.playlist.length ? next.playback.playing : false, position: 0, changedAt: now };
      }
      break;
    }
    case 'playlist.reorder': {
      const index = next.playlist.findIndex(item => item.id === operation.itemId);
      if (index < 0) throw new ProtocolError('item_not_found', '歌曲已不存在');
      const [item] = next.playlist.splice(index, 1);
      next.playlist.splice(Math.min(operation.index, next.playlist.length), 0, item);
      break;
    }
    case 'playlist.select': {
      if (!next.playlist.some(item => item.id === operation.itemId)) throw new ProtocolError('item_not_found', '歌曲已不存在');
      next.selectedId = operation.itemId;
      next.playback = { playing: next.playback.playing, position: 0, changedAt: now };
      break;
    }
    case 'playback.set': {
      const position = own(operation, 'position') ? operation.position : currentPosition(next.playback, now);
      const playing = own(operation, 'playing') ? operation.playing : next.playback.playing;
      next.playback = { playing: Boolean(next.selectedId) && playing, position, changedAt: now };
      break;
    }
    case 'next':
    case 'previous': {
      if (!next.playlist.length) {
        next.selectedId = null;
        next.playback = { playing: false, position: 0, changedAt: now };
        break;
      }
      let index = next.playlist.findIndex(item => item.id === next.selectedId);
      if (operation.type === 'next') index = index < 0 ? 0 : (index + 1) % next.playlist.length;
      else index = index < 0 ? next.playlist.length - 1 : (index - 1 + next.playlist.length) % next.playlist.length;
      next.selectedId = next.playlist[index].id;
      next.playback = { playing: next.playback.playing, position: 0, changedAt: now };
      break;
    }
    default:
      throw new ProtocolError('invalid_operation', '不支持的房间操作');
  }
  next.revision += 1;
  return next;
}

function parseJsonMessage(data, isBinary) {
  if (isBinary) throw new ProtocolError('binary_not_allowed', '不接受二进制消息');
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buffer.length > MAX_PAYLOAD) throw new ProtocolError('message_too_large', '消息过大');
  let value;
  try {
    value = JSON.parse(UTF8_DECODER.decode(buffer));
  } catch {
    throw new ProtocolError('invalid_json', '消息不是有效 JSON');
  }
  if (!isPlainObject(value)) throw new ProtocolError('invalid_message', '消息格式无效');
  return value;
}

function safeCallback(callback, value) {
  if (typeof callback !== 'function') return;
  try { callback(jsonClone(value)); } catch { /* Callers cannot break room serialization. */ }
}

function safeSend(socket, value) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, 'utf8') > MAX_PAYLOAD) return false;
  try { socket.send(text); return true; } catch { return false; }
}

function safeSendSecure(socket, roomId, value) {
  try { return safeSend(socket, encryptSecureMessage(socket, roomId, value)); }
  catch { return false; }
}

function safeClose(socket, code, reason) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  try { socket.close(code, String(reason || '').slice(0, 100)); } catch { try { socket.terminate(); } catch {} }
}

class RoomHost {
  constructor(options = {}) {
    if (!isPlainObject(options)) throw new TypeError('RoomHost 选项无效');
    // Loopback is the safe public-tunnel default. Callers may explicitly opt into LAN binding.
    this.host = options.host || '127.0.0.1';
    this.port = options.port === undefined ? 0 : Number(options.port);
    if (!isBoundedString(this.host, 1, 255) || !isSafeInteger(this.port, 0, 65535)) throw new Error('监听地址或端口无效');
    this.roomId = options.roomId || randomBytes(16).toString('base64url');
    this._token = options.token || randomBytes(32).toString('base64url');
    if (!validateRoomId(this.roomId) || !validateToken(this._token)) throw new Error('房间凭据无效');
    this._tokenBytes = decodeCanonicalBase64Url(this._token, 32);
    this._state = makeInitialState(this.roomId, options.initialState);
    this._onState = options.onState;
    this._onStatus = options.onStatus;
    this._server = null;
    this._wss = null;
    this._guest = null;
    this._pending = new Map();
    this._seenOperations = new Map();
    this._queue = Promise.resolve();
    this._heartbeat = null;
    this._closed = false;
  }

  getState() {
    return jsonClone(this._state);
  }

  get connected() {
    return Boolean(this._guest && this._guest.readyState === WebSocket.OPEN);
  }

  async start() {
    if (this._server) throw new Error('房间服务器已经启动');
    if (this._closed) throw new Error('房间服务器已经关闭');
    this._server = http.createServer((_request, response) => {
      response.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end('WebSocket required');
    });
    this._wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false, clientTracking: true });
    this._server.on('upgrade', (request, socket, head) => this._handleUpgrade(request, socket, head));
    this._server.on('error', error => safeCallback(this._onStatus, { status: 'error', message: error.message }));
    try {
      await new Promise((resolve, reject) => {
      const onError = error => { this._server?.off('listening', onListening); reject(error); };
      const onListening = () => { this._server?.off('error', onError); resolve(); };
      this._server.once('error', onError);
      this._server.once('listening', onListening);
      this._server.listen(this.port, this.host);
      });
    } catch (error) {
      try { this._wss.close(); } catch {}
      try { this._server.close(); } catch {}
      this._wss = null;
      this._server = null;
      throw error;
    }
    const address = this._server.address();
    this.port = typeof address === 'object' && address ? address.port : this.port;
    this._heartbeat = setInterval(() => this._heartbeatGuest(), HEARTBEAT_MS);
    this._heartbeat.unref?.();
    const endpoints = listHostEndpoints({ port: this.port, host: this.host });
    safeCallback(this._onStatus, { status: 'listening', host: this.host, port: this.port, endpoints, roomId: this.roomId });
    return { roomId: this.roomId, host: this.host, port: this.port, endpoints, invite: createInvite({ endpoints, roomId: this.roomId, token: this._token }) };
  }

  createInvite(endpoints) {
    const chosen = endpoints || listHostEndpoints({ port: this.port, host: this.host });
    return createInvite({ endpoints: chosen, roomId: this.roomId, token: this._token });
  }

  async applyOperation(operation, options = {}) {
    const actorId = options.actorId === undefined ? 'host' : options.actorId;
    const opId = options.opId || randomBytes(16).toString('base64url');
    if (actorId !== 'host') throw new Error('本地操作 actorId 必须为 host');
    return this._submitOperation(actorId, opId, operation);
  }

  _handleUpgrade(request, socket, head) {
    if (this._closed || this._pending.size >= 4) return socket.destroy();
    let requestUrl;
    try { requestUrl = new URL(request.url, 'http://localhost'); } catch { return socket.destroy(); }
    if (requestUrl.pathname !== `/room/${this.roomId}` || requestUrl.search || requestUrl.hash) return socket.destroy();
    this._wss.handleUpgrade(request, socket, head, ws => this._acceptSocket(ws));
  }

  _acceptSocket(socket) {
    socket.isAlive = true;
    socket.rate = { tokens: RATE_BURST, updatedAt: Date.now() };
    const timer = setTimeout(() => safeClose(socket, 1008, 'authentication timeout'), AUTH_TIMEOUT_MS);
    timer.unref?.();
    this._pending.set(socket, { timer, stage: 'hello' });
    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('message', (data, isBinary) => this._handleGuestMessage(socket, data, isBinary));
    socket.on('close', () => this._dropSocket(socket));
    socket.on('error', () => {});
  }

  _consumeRate(socket) {
    const now = Date.now();
    const elapsed = Math.max(0, now - socket.rate.updatedAt) / 1000;
    socket.rate.tokens = Math.min(RATE_BURST, socket.rate.tokens + elapsed * RATE_PER_SECOND);
    socket.rate.updatedAt = now;
    if (socket.rate.tokens < 1) return false;
    socket.rate.tokens -= 1;
    return true;
  }

  _handleGuestMessage(socket, data, isBinary) {
    if (!this._consumeRate(socket)) return safeClose(socket, 1008, 'rate limit');
    let message;
    try { message = parseJsonMessage(data, isBinary); }
    catch { return safeClose(socket, 1007, 'invalid message'); }

    const pending = this._pending.get(socket);
    if (pending) {
      if (pending.stage === 'hello') {
        if (!hasOnlyKeys(message, ['type', 'roomId', 'clientNonce'], ['type', 'roomId', 'clientNonce']) ||
            message.type !== 'hello' || !validateRoomId(message.roomId)) {
          return safeClose(socket, 1008, 'authentication failed');
        }
        const clientNonce = decodeCanonicalBase64Url(message.clientNonce, 32);
        if (!clientNonce || message.roomId !== this.roomId || (this._guest && this._guest !== socket)) {
          return safeClose(socket, 1008, this._guest ? 'room full' : 'authentication failed');
        }
        const serverNonce = randomBytes(32);
        const proof = authenticationProof(this._tokenBytes, 'server', this.roomId, clientNonce, serverNonce);
        Object.assign(pending, {
          stage: 'authenticate',
          clientNonce,
          clientNonceText: message.clientNonce,
          serverNonce,
          serverNonceText: serverNonce.toString('base64url'),
        });
        if (!safeSend(socket, {
          type: 'challenge',
          roomId: this.roomId,
          clientNonce: pending.clientNonceText,
          serverNonce: pending.serverNonceText,
          proof: proof.toString('base64url'),
        })) safeClose(socket, 1011, 'challenge failed');
        proof.fill(0);
        return;
      }
      if (pending.stage !== 'authenticate' ||
          !hasOnlyKeys(message, ['type', 'roomId', 'clientNonce', 'serverNonce', 'proof'],
            ['type', 'roomId', 'clientNonce', 'serverNonce', 'proof']) ||
          message.type !== 'authenticate' || message.roomId !== this.roomId ||
          message.clientNonce !== pending.clientNonceText || message.serverNonce !== pending.serverNonceText) {
        return safeClose(socket, 1008, 'authentication failed');
      }
      const suppliedProof = decodeCanonicalBase64Url(message.proof, 32);
      const expectedProof = authenticationProof(this._tokenBytes, 'client', this.roomId, pending.clientNonce, pending.serverNonce);
      const proofMatches = suppliedProof && timingSafeEqual(suppliedProof, expectedProof);
      expectedProof.fill(0);
      if (!proofMatches || (this._guest && this._guest !== socket)) {
        return safeClose(socket, 1008, this._guest ? 'room full' : 'authentication failed');
      }
      socket.secure = makeSecureContext(
        deriveSession(this._tokenBytes, this.roomId, pending.clientNonce, pending.serverNonce),
        'host',
      );
      clearTimeout(pending.timer);
      pending.clientNonce.fill(0);
      pending.serverNonce.fill(0);
      this._pending.delete(socket);
      this._guest = socket;
      if (!safeSendSecure(socket, this.roomId, { type: 'welcome', role: 'guest', state: this._state, serverTime: Date.now() })) {
        return safeClose(socket, 1011, 'welcome failed');
      }
      safeCallback(this._onStatus, { status: 'guest-connected' });
      return;
    }

    if (socket !== this._guest) return safeClose(socket, 1008, 'authentication required');
    try { message = decryptSecureMessage(socket, this.roomId, message); }
    catch { return safeClose(socket, 1008, 'secure message rejected'); }
    if (!hasOnlyKeys(message, ['type', 'opId', 'operation'], ['type', 'opId', 'operation']) ||
        message.type !== 'operation' || !isOperationId(message.opId)) {
      return safeClose(socket, 1008, 'invalid operation envelope');
    }
    this._submitOperation('guest', message.opId, message.operation)
      .then(result => safeSendSecure(socket, this.roomId, { type: 'ack', opId: message.opId, revision: result.revision }))
      .catch(error => safeSendSecure(socket, this.roomId, {
        type: 'error',
        code: error instanceof ProtocolError ? error.code : 'operation_failed',
        message: error instanceof ProtocolError ? error.message : '操作失败',
        opId: message.opId,
      }));
  }

  _submitOperation(actorId, opId, rawOperation) {
    if (!isOperationId(opId)) return Promise.reject(new ProtocolError('invalid_operation_id', '操作 ID 无效'));
    let operation;
    try { operation = validateOperation(rawOperation); }
    catch (error) { return Promise.reject(error); }
    const key = `${actorId}:${opId}`;
    const task = this._queue.then(() => {
      if (this._closed) throw new ProtocolError('room_closed', '房间已经关闭');
      if (this._seenOperations.has(key)) {
        const seen = this._seenOperations.get(key);
        if (seen.ok) return jsonClone(seen.result);
        throw new ProtocolError(seen.code, seen.message);
      }
      let candidate;
      try {
        candidate = applyOperationToState(this._state, operation);
        ensureStateFits(candidate);
      } catch (error) {
        if (error instanceof ProtocolError) {
          this._seenOperations.set(key, { ok: false, code: error.code, message: error.message });
          while (this._seenOperations.size > MAX_SEEN_OPERATIONS) this._seenOperations.delete(this._seenOperations.keys().next().value);
        }
        throw error;
      }
      this._state = candidate;
      const result = { opId, revision: this._state.revision, state: this.getState() };
      this._seenOperations.set(key, { ok: true, result });
      while (this._seenOperations.size > MAX_SEEN_OPERATIONS) this._seenOperations.delete(this._seenOperations.keys().next().value);
      safeCallback(this._onState, this._state);
      this._broadcastState();
      return jsonClone(result);
    });
    this._queue = task.catch(() => {});
    return task;
  }

  _broadcastState() {
    if (this._guest) safeSendSecure(this._guest, this.roomId, { type: 'state', state: this._state, serverTime: Date.now() });
  }

  _heartbeatGuest() {
    const socket = this._guest;
    if (!socket) return;
    if (!socket.isAlive) return socket.terminate();
    socket.isAlive = false;
    try { socket.ping(); } catch { socket.terminate(); }
  }

  _dropSocket(socket) {
    const pending = this._pending.get(socket);
    if (pending) {
      clearTimeout(pending.timer);
      pending.clientNonce?.fill?.(0);
      pending.serverNonce?.fill?.(0);
    }
    this._pending.delete(socket);
    destroySecureContext(socket);
    if (this._guest === socket) {
      this._guest = null;
      if (!this._closed) safeCallback(this._onStatus, { status: 'guest-disconnected' });
    }
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    if (this._heartbeat) clearInterval(this._heartbeat);
    this._heartbeat = null;
    for (const [socket, pending] of this._pending) {
      clearTimeout(pending.timer);
      pending.clientNonce?.fill?.(0);
      pending.serverNonce?.fill?.(0);
      safeClose(socket, 1001, 'room closed');
    }
    this._pending.clear();
    if (this._guest) safeClose(this._guest, 1001, 'room closed');
    const sockets = this._wss ? [...this._wss.clients] : [];
    const forceTimer = setTimeout(() => sockets.forEach(socket => { try { socket.terminate(); } catch {} }), 300);
    forceTimer.unref?.();
    await Promise.all([
      this._wss ? new Promise(resolve => this._wss.close(() => resolve())) : Promise.resolve(),
      this._server ? new Promise(resolve => this._server.close(() => resolve())) : Promise.resolve(),
    ]);
    clearTimeout(forceTimer);
    this._guest = null;
    this._wss = null;
    this._server = null;
    safeCallback(this._onStatus, { status: 'closed' });
  }
}

function validateServerMessage(message, roomId) {
  if (!isPlainObject(message) || typeof message.type !== 'string') throw new ProtocolError('invalid_message', '服务器消息格式无效');
  if (message.type === 'welcome') {
    if (!hasOnlyKeys(message, ['type', 'role', 'state', 'serverTime'], ['type', 'role', 'state', 'serverTime']) ||
        message.role !== 'guest' || !isFiniteNumber(message.serverTime, 0, Number.MAX_SAFE_INTEGER)) {
      throw new ProtocolError('invalid_message', '欢迎消息格式无效');
    }
    return { type: message.type, role: message.role, state: validateState(message.state, roomId), serverTime: message.serverTime };
  }
  if (message.type === 'state') {
    if (!hasOnlyKeys(message, ['type', 'state', 'serverTime'], ['type', 'state', 'serverTime']) ||
        !isFiniteNumber(message.serverTime, 0, Number.MAX_SAFE_INTEGER)) throw new ProtocolError('invalid_message', '状态消息格式无效');
    return { type: message.type, state: validateState(message.state, roomId), serverTime: message.serverTime };
  }
  if (message.type === 'ack') {
    if (!hasOnlyKeys(message, ['type', 'opId', 'revision'], ['type', 'opId', 'revision']) ||
        !isOperationId(message.opId) || !isSafeInteger(message.revision, 0, Number.MAX_SAFE_INTEGER)) {
      throw new ProtocolError('invalid_message', '确认消息格式无效');
    }
    return { type: message.type, opId: message.opId, revision: message.revision };
  }
  if (message.type === 'error') {
    if (!hasOnlyKeys(message, ['type', 'code', 'message', 'opId'], ['type', 'code', 'message']) ||
        !isBoundedString(message.code, 1, 64) || !/^[a-z0-9_]+$/.test(message.code) ||
        !isBoundedString(message.message, 1, 200) || (own(message, 'opId') && !isOperationId(message.opId))) {
      throw new ProtocolError('invalid_message', '错误消息格式无效');
    }
    return { type: message.type, code: message.code, message: message.message, ...(own(message, 'opId') ? { opId: message.opId } : {}) };
  }
  throw new ProtocolError('invalid_message', '未知服务器消息');
}

class RoomClient {
  constructor(options = {}) {
    if (!isPlainObject(options)) throw new TypeError('RoomClient 选项无效');
    this.invite = typeof options.invite === 'string' ? parseInvite(options.invite) : options.invite;
    if (!this.invite || !Array.isArray(this.invite.endpoints)) throw new Error('邀请无效');
    this.invite = parseInvite(createInvite(this.invite));
    this._onState = options.onState;
    this._onStatus = options.onStatus;
    this._socket = null;
    this._candidateSocket = null;
    this._state = null;
    this._pendingOperations = new Map();
    this._connecting = null;
    this._closedByUser = false;
    this._connected = false;
    this._endpointTimeoutMs = isSafeInteger(options.endpointTimeoutMs, 1000, 10000)
      ? options.endpointTimeoutMs
      : DEFAULT_ENDPOINT_TIMEOUT_MS;
  }

  get connected() { return this._connected; }
  getState() { return this._state ? jsonClone(this._state) : null; }

  async connect() {
    if (this._connected) return this.getState();
    if (this._connecting) return this._connecting;
    this._closedByUser = false;
    this._connecting = this._connectSequentially().finally(() => { this._connecting = null; });
    return this._connecting;
  }

  async _connectSequentially() {
    let lastError = new Error('无法连接房主');
    for (const endpoint of this.invite.endpoints) {
      if (this._closedByUser) throw new Error('连接已取消');
      safeCallback(this._onStatus, { status: 'connecting', endpoint });
      try { return await this._tryEndpoint(endpoint); }
      catch (error) {
        lastError = error;
        if (!this._closedByUser) safeCallback(this._onStatus, { status: 'endpoint-failed', endpoint, message: error.message });
      }
    }
    safeCallback(this._onStatus, { status: 'disconnected', message: lastError.message });
    throw lastError;
  }

  _tryEndpoint(endpoint) {
    return new Promise((resolve, reject) => {
      let welcomed = false;
      let settled = false;
      let stage = 'challenge';
      const clientNonce = randomBytes(32);
      const clientNonceText = clientNonce.toString('base64url');
      const socket = new WebSocket(endpoint, {
        maxPayload: MAX_PAYLOAD,
        perMessageDeflate: false,
        handshakeTimeout: this._endpointTimeoutMs,
      });
      this._candidateSocket = socket;
      const welcomeTimer = setTimeout(() => {
        if (!welcomed) { safeClose(socket, 1008, 'welcome timeout'); finishReject(new Error('房主认证超时')); }
      }, this._endpointTimeoutMs);
      welcomeTimer.unref?.();
      const finishReject = error => {
        if (settled) return;
        settled = true;
        clearTimeout(welcomeTimer);
        if (this._candidateSocket === socket) this._candidateSocket = null;
        clientNonce.fill(0);
        reject(error);
      };
      socket.on('open', () => {
        safeSend(socket, { type: 'hello', roomId: this.invite.roomId, clientNonce: clientNonceText });
      });
      socket.on('message', (data, isBinary) => {
        let message;
        try { message = parseJsonMessage(data, isBinary); }
        catch {
          safeClose(socket, 1002, 'invalid server message');
          return finishReject(new Error('房主返回了无效数据'));
        }
        if (!welcomed) {
          if (stage === 'challenge') {
            if (!hasOnlyKeys(message, ['type', 'roomId', 'clientNonce', 'serverNonce', 'proof'],
              ['type', 'roomId', 'clientNonce', 'serverNonce', 'proof']) ||
              message.type !== 'challenge' || message.roomId !== this.invite.roomId ||
              message.clientNonce !== clientNonceText) {
              safeClose(socket, 1008, 'invalid challenge');
              return finishReject(new Error('房主安全挑战无效'));
            }
            const serverNonce = decodeCanonicalBase64Url(message.serverNonce, 32);
            const suppliedProof = decodeCanonicalBase64Url(message.proof, 32);
            const tokenBytes = decodeCanonicalBase64Url(this.invite.token, 32);
            if (!serverNonce || !suppliedProof || !tokenBytes) {
              safeClose(socket, 1008, 'invalid challenge');
              return finishReject(new Error('房主安全挑战无效'));
            }
            const expectedProof = authenticationProof(tokenBytes, 'server', this.invite.roomId, clientNonce, serverNonce);
            const proofMatches = timingSafeEqual(suppliedProof, expectedProof);
            expectedProof.fill(0);
            if (!proofMatches) {
              tokenBytes.fill(0);
              serverNonce.fill(0);
              safeClose(socket, 1008, 'server authentication failed');
              return finishReject(new Error('无法验证房主身份：邀请可能无效'));
            }
            const session = deriveSession(tokenBytes, this.invite.roomId, clientNonce, serverNonce);
            socket.secure = makeSecureContext(session, 'client');
            const proof = authenticationProof(tokenBytes, 'client', this.invite.roomId, clientNonce, serverNonce);
            tokenBytes.fill(0);
            serverNonce.fill(0);
            clientNonce.fill(0);
            stage = 'welcome';
            const sent = safeSend(socket, {
              type: 'authenticate',
              roomId: this.invite.roomId,
              clientNonce: clientNonceText,
              serverNonce: message.serverNonce,
              proof: proof.toString('base64url'),
            });
            proof.fill(0);
            if (!sent) {
              safeClose(socket, 1011, 'authentication send failed');
              return finishReject(new Error('发送安全认证失败'));
            }
            return;
          }
          try { message = validateServerMessage(decryptSecureMessage(socket, this.invite.roomId, message), this.invite.roomId); }
          catch {
            safeClose(socket, 1008, 'secure welcome rejected');
            return finishReject(new Error('房主的加密响应无效'));
          }
          if (message.type !== 'welcome') {
            safeClose(socket, 1002, 'welcome required');
            return finishReject(new Error('房主认证响应无效'));
          }
          welcomed = true;
          if (this._closedByUser) {
            safeClose(socket, 1000, 'client closed');
            return finishReject(new Error('连接已取消'));
          }
          settled = true;
          clearTimeout(welcomeTimer);
          if (this._candidateSocket === socket) this._candidateSocket = null;
          this._socket = socket;
          this._connected = true;
          this._acceptState(message.state, message.serverTime);
          safeCallback(this._onStatus, { status: 'connected', endpoint });
          resolve(this.getState());
          return;
        }
        try { message = validateServerMessage(decryptSecureMessage(socket, this.invite.roomId, message), this.invite.roomId); }
        catch {
          safeClose(socket, 1008, 'secure message rejected');
          return;
        }
        this._handleServerMessage(message);
      });
      socket.on('close', (_code, reason) => {
        clearTimeout(welcomeTimer);
        if (this._candidateSocket === socket) this._candidateSocket = null;
        if (!welcomed) {
          destroySecureContext(socket);
          return finishReject(new Error(reason?.toString() || '连接失败'));
        }
        if (this._socket === socket) {
          this._socket = null;
          this._connected = false;
          this._rejectPending(new Error('与房主的连接已断开'));
          safeCallback(this._onStatus, { status: this._closedByUser ? 'closed' : 'disconnected' });
        }
        destroySecureContext(socket);
      });
      socket.on('error', error => {
        if (!welcomed) {
          try { socket.terminate(); } catch {}
          finishReject(new Error(error.message || '连接失败'));
        }
      });
    });
  }

  _handleServerMessage(message) {
    if (message.type === 'state') return this._acceptState(message.state, message.serverTime);
    if (message.type === 'ack') {
      const pending = this._pendingOperations.get(message.opId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this._pendingOperations.delete(message.opId);
      pending.resolve({ opId: message.opId, revision: message.revision });
      return;
    }
    if (message.type === 'error') {
      if (!message.opId) return safeCallback(this._onStatus, { status: 'error', code: message.code, message: message.message });
      const pending = this._pendingOperations.get(message.opId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this._pendingOperations.delete(message.opId);
      const error = new Error(message.message);
      error.code = message.code;
      pending.reject(error);
      return;
    }
    safeClose(this._socket, 1002, 'unexpected message');
  }

  _acceptState(state, serverTime = Date.now()) {
    if (this._state && state.revision < this._state.revision) return;
    const receivedAt = Date.now();
    const rebased = jsonClone(state);
    if (rebased.playback.playing) rebased.playback.position = currentPosition(rebased.playback, serverTime);
    rebased.playback.changedAt = receivedAt;
    this._state = rebased;
    safeCallback(this._onState, rebased);
  }

  sendOperation(operation, options = {}) {
    if (!this._connected || !this._socket || this._socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('尚未连接房主'));
    }
    let normalized;
    try { normalized = validateOperation(operation); }
    catch (error) { return Promise.reject(error); }
    const opId = options.opId || randomBytes(16).toString('base64url');
    if (!isOperationId(opId)) return Promise.reject(new Error('操作 ID 无效'));
    if (this._pendingOperations.has(opId)) return this._pendingOperations.get(opId).promise;
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
    const timeoutMs = isSafeInteger(options.timeoutMs, 1000, 60000) ? options.timeoutMs : 10000;
    const timer = setTimeout(() => {
      this._pendingOperations.delete(opId);
      rejectPromise(new Error('房间操作确认超时'));
    }, timeoutMs);
    timer.unref?.();
    this._pendingOperations.set(opId, { promise, resolve: resolvePromise, reject: rejectPromise, timer });
    if (!safeSendSecure(this._socket, this.invite.roomId, { type: 'operation', opId, operation: normalized })) {
      clearTimeout(timer);
      this._pendingOperations.delete(opId);
      rejectPromise(new Error('发送房间操作失败'));
    }
    return promise;
  }

  _rejectPending(error) {
    for (const pending of this._pendingOperations.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this._pendingOperations.clear();
  }

  close() {
    const wasClosed = this._closedByUser;
    this._closedByUser = true;
    this._connected = false;
    this._rejectPending(new Error('连接已经关闭'));
    if (this._socket) safeClose(this._socket, 1000, 'client closed');
    if (this._candidateSocket) safeClose(this._candidateSocket, 1000, 'client closed');
    destroySecureContext(this._socket);
    destroySecureContext(this._candidateSocket);
    this._socket = null;
    this._candidateSocket = null;
    if (!wasClosed) safeCallback(this._onStatus, { status: 'closed' });
  }
}

module.exports = {
  RoomHost,
  RoomClient,
  JoinClient: RoomClient,
  createInvite,
  parseInvite,
  listHostEndpoints,
  validateOperation,
  constants: Object.freeze({ MAX_PAYLOAD, MAX_PLAYLIST_ITEMS, MAX_URL_LENGTH }),
};
