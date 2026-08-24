const assert = require('assert/strict');
const { randomBytes } = require('crypto');
const test = require('node:test');
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
    await host.applyOperation({ type: 'next' });
    await waitFor(() => client.getState()?.revision === host.getState().revision);

    assert.deepEqual(client.getState(), host.getState());
    assert.deepEqual(host.getState().playlist.map(item => item.id), ['track_b', 'track_a']);
    assert.equal(host.getState().selectedId, 'track_a');
    assert.equal(host.getState().playback.playing, true);
  } finally {
    client?.close();
    await host.close();
  }
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
