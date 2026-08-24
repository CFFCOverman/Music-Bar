const assert = require('assert/strict');
const { randomBytes } = require('crypto');
const test = require('node:test');
const { MediaController } = require('../src/main/media.cjs');
const { RoomController } = require('../src/main/room-controller.cjs');
const { RoomClient, RoomHost, createInvite, parseInvite } = require('../src/main/room.cjs');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const waitFor = async predicate => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error('等待房间状态同步超时');
};

test('房主和受邀者可共同编辑并同步播放状态', async () => {
  const host = new RoomHost({ host: '127.0.0.1' });
  let client;
  try {
    const started = await host.start();
    client = new RoomClient({ invite: started.invite, endpointTimeoutMs: 2000 });
    await client.connect();
    await client.sendOperation({ type: 'playlist.add', id: 'track_a', title: 'A', url: 'https://example.com/a' });
    await client.sendOperation({ type: 'playlist.add', id: 'track_b', title: 'B', url: 'https://example.com/b' });
    await client.sendOperation({ type: 'playlist.update', itemId: 'track_b', title: 'B edited' });
    await client.sendOperation({ type: 'playlist.reorder', itemId: 'track_b', index: 0 });
    await client.sendOperation({ type: 'playlist.select', itemId: 'track_b' });
    await client.sendOperation({ type: 'playback.set', playing: true, position: 24 });
    await waitFor(() => host.getState().playback.position === 24);
    assert.equal(host.getState().playback.position, 24, '受邀者拖动进度应同步到房主');
    await host.applyOperation({ type: 'playback.set', playing: true, position: 62 });
    await waitFor(() => Math.abs((client.getState()?.playback.position || 0) - 62) < .25);
    assert.ok(Math.abs(client.getState().playback.position - 62) < .25, '房主拖动进度应同步到受邀者');
    await client.sendOperation({ type: 'playback.set', playing: true, position: 87 });
    await waitFor(() => host.getState().playback.position === 87);
    assert.equal(host.getState().playback.position, 87, '受邀者可以再次覆盖房主进度');
    await host.applyOperation({ type: 'next' });
    await waitFor(() => client.getState()?.revision === host.getState().revision);

    assert.deepEqual(client.getState().playlist, host.getState().playlist);
    assert.equal(client.getState().selectedId, host.getState().selectedId);
    assert.deepEqual(host.getState().playlist.map(item => item.id), ['track_b', 'track_a']);
    assert.equal(host.getState().selectedId, 'track_a');
    assert.equal(host.getState().playback.playing, true);
  } finally {
    client?.close();
    await host.close();
  }
});

test('受邀者会把房主时间基准换算成本机时间，避免系统时钟偏差影响进度', () => {
  const client = Object.create(RoomClient.prototype);
  client._state = null;
  client._onState = () => {};
  const originalNow = Date.now;
  try {
    Date.now = () => 900000;
    client._acceptState({
      roomId: 'clock_test_room_1234',
      revision: 1,
      playlist: [],
      selectedId: null,
      playback: { playing: true, position: 12, changedAt: 1000 },
    }, 4000);
  } finally {
    Date.now = originalNow;
  }
  assert.equal(client.getState().playback.position, 15);
  assert.equal(client.getState().playback.changedAt, 900000);
});

test('错误令牌无法加入房间', async () => {
  const host = new RoomHost({ host: '127.0.0.1' });
  let client;
  try {
    const started = await host.start();
    const parsed = parseInvite(started.invite);
    const wrongInvite = createInvite({
      endpoints: parsed.endpoints,
      roomId: parsed.roomId,
      token: randomBytes(32).toString('base64url'),
    });
    client = new RoomClient({ invite: wrongInvite, endpointTimeoutMs: 1500 });
    await assert.rejects(client.connect());
    assert.equal(host.getState().revision, 0);
  } finally {
    client?.close();
    await host.close();
  }
});

test('危险协议链接会在发送前被拒绝', async () => {
  const host = new RoomHost({ host: '127.0.0.1' });
  let client;
  try {
    const started = await host.start();
    client = new RoomClient({ invite: started.invite, endpointTimeoutMs: 2000 });
    await client.connect();
    await assert.rejects(
      client.sendOperation({ type: 'playlist.add', title: 'bad', url: 'file:///secret' }),
      /http\/https/,
    );
    assert.equal(host.getState().revision, 0);
  } finally {
    client?.close();
    await host.close();
  }
});

test('过大的本地歌单会友好拒绝且不会让控制器卡在房主状态', async () => {
  const controller = new RoomController({
    media: { getCurrentUrl: () => '' },
    store: {},
    send: () => {},
    getPlayerState: () => ({}),
    setCurrentHistoryId: () => {},
    setPlayerMessage: () => {},
  });
  const oversized = Array.from({ length: 200 }, (_, index) => ({
    title: `第 ${index + 1} 首 ${'很长的名称'.repeat(40)}`,
    url: `https://example.com/music/${index}`,
  }));
  const result = await controller.create(oversized);
  assert.equal(result.ok, false);
  assert.match(result.message, /内容过多/);
  assert.equal(controller.mode, 'none');
  assert.equal(controller.active, false);
});

test('手动拖动会取消旧的远端同步重试', async () => {
  const media = new MediaController({ onState: () => {}, getOutputPreference: () => ({}), setOutputPreference: () => {} });
  media.action = async () => ({ currentTime: 42, playing: true });
  media.syncPlayback({ position: 10, playing: true });
  assert.equal(media.syncTimers.length, 3);
  await media.seek(42);
  assert.equal(media.syncTimers.length, 0);
  media.dispose();
});

test('新网页加载失败时不会把新进度应用到上一首媒体', async () => {
  let syncCalls = 0;
  const media = {
    getCurrentUrl: () => 'https://example.com/old',
    load: async () => { throw new Error('load failed'); },
    syncPlayback: () => { syncCalls += 1; },
    cancelSyncPlayback: () => {},
  };
  const controller = new RoomController({
    media,
    store: { upsertHistory: async () => ({ id: 'history-new' }) },
    send: () => {},
    getPlayerState: () => ({}),
    setCurrentHistoryId: () => {},
    setPlayerMessage: () => {},
  });
  controller.session = { close: () => {} };
  controller.mode = 'host';
  controller.state = {
    revision: 1,
    playlist: [{ id: 'new-track', title: 'New', url: 'https://example.com/new' }],
    selectedId: 'new-track',
    playback: { playing: true, position: 50, changedAt: Date.now() },
  };
  await controller.synchronizeMedia();
  assert.equal(syncCalls, 0);
  assert.equal(controller.loadedTrackKey, '');
  await controller.leave();
});
