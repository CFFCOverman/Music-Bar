const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { MetadataController, isPrivateIpAddress, safeAutomaticUrl } = require('../src/main/metadata.cjs');
const { Store } = require('../src/main/store.cjs');

test('后台名称读取会拒绝本机、私网与 IPv4-mapped IPv6 地址', () => {
  assert.equal(safeAutomaticUrl('http://localhost:8080/admin'), null);
  assert.equal(isPrivateIpAddress('127.0.0.1'), true);
  assert.equal(isPrivateIpAddress('192.168.1.20'), true);
  assert.equal(isPrivateIpAddress('::ffff:7f00:1'), true);
  assert.equal(isPrivateIpAddress('::ffff:c0a8:101'), true);
  assert.equal(isPrivateIpAddress('fec0::1'), true);
  assert.equal(isPrivateIpAddress('2606:4700:4700::1111'), false);
  assert.equal(isPrivateIpAddress('1.1.1.1'), false);
});

test('后台名称读取使用同一隔离会话解析并拒绝代理或私网 DNS 结果', async () => {
  const metadata = new MetadataController({ onMetadata: () => {} });
  const directPublic = {
    resolveProxy: async () => 'DIRECT',
    resolveHost: async (_host, options) => ({ endpoints: [{ address: options.queryType === 'A' ? '1.1.1.1' : '2606:4700:4700::1111' }] }),
  };
  assert.equal(await metadata.isPublicNetworkUrl('https://example.com/video', directPublic), true);
  const privateDns = {
    ...directPublic,
    resolveHost: async (_host, options) => ({ endpoints: [{ address: options.queryType === 'A' ? '127.0.0.1' : '2606:4700:4700::1111' }] }),
  };
  assert.equal(await metadata.isPublicNetworkUrl('https://example.com/video', privateDns), false);
  assert.equal(await metadata.isPublicNetworkUrl('https://example.com/video', { ...directPublic, resolveProxy: async () => 'PROXY 127.0.0.1:8080' }), false);
});

test('历史网页可加入歌单，元数据、顺序和导入导出会保留', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'music-bar-store-'));
  try {
    const store = new Store(directory);
    await store.init();
    const first = await store.upsertHistory('https://www.bilibili.com/video/BV1xx411c7mD');
    const second = await store.upsertHistory('https://example.com/music');
    const created = await store.createPlaylist('夜间歌单');
    assert.equal(created.ok, true);
    const playlistId = created.playlist.id;
    assert.equal((await store.addHistoryToPlaylist(playlistId, first.id)).ok, true);
    assert.equal((await store.addHistoryToPlaylist(playlistId, second.id)).ok, true);

    await store.applyMetadata(first.url, {
      title: '自动识别的视频名称',
      artist: '视频作者',
      cover: 'https://example.com/cover.jpg',
      keywords: ['音乐', '现场'],
    });
    let playlist = store.getPlaylist(playlistId);
    assert.equal(playlist.items[0].title, '自动识别的视频名称');
    assert.equal(playlist.items[0].artist, '视频作者');
    assert.deepEqual(playlist.items[0].keywords, ['音乐', '现场']);

    await store.reorderPlaylistItem(playlistId, second.id, 0);
    playlist = store.getPlaylist(playlistId);
    assert.equal(playlist.items[0].url, second.url);
    await store.deleteHistory(first.id);
    assert.equal(store.getPlaylist(playlistId).items.length, 2, '删除历史不应删除歌单副本');

    const exported = path.join(directory, 'playlist.json');
    assert.equal(await store.exportPlaylists(exported, playlistId), 1);
    const importedDirectory = path.join(directory, 'imported');
    const importedStore = new Store(importedDirectory);
    await importedStore.init();
    const result = await importedStore.importPlaylists(exported);
    assert.equal(result.count, 1);
    assert.equal(importedStore.listPlaylists()[0].name, '夜间歌单');
    assert.equal(importedStore.listPlaylists()[0].items[1].title, '自动识别的视频名称');
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test('手动命名不会被自动网页名称覆盖', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'music-bar-title-'));
  try {
    const store = new Store(directory);
    await store.init();
    const item = await store.upsertHistory('https://example.com/video', { title: '我自己的名字' });
    await store.applyMetadata(item.url, { title: '网页自动名称', artist: '作者' });
    assert.equal(store.listHistory()[0].title, '我自己的名字');
    assert.equal(store.listHistory()[0].artist, '作者');
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});
