const assert = require('assert/strict');
const test = require('node:test');
const { assets, requestedPlatformKey } = require('../scripts/setup-cloudflared.cjs');
const { CLOUDFLARED_SHA256 } = require('../src/main/tunnel.cjs');
const packageJson = require('../package.json');

test('安装环境会自动匹配 Windows、Intel Mac 和 Apple Silicon Mac', () => {
  assert.equal(requestedPlatformKey([]), `${process.platform}-${process.arch}`);
  assert.equal(requestedPlatformKey(['--platform', 'darwin', '--arch', 'x64']), 'darwin-x64');
  assert.equal(requestedPlatformKey(['--platform', 'darwin', '--arch', 'arm64']), 'darwin-arm64');
  for (const key of ['win32-x64', 'darwin-x64', 'darwin-arm64']) {
    assert.ok(assets[key]);
    assert.match(CLOUDFLARED_SHA256[key], /^[a-f0-9]{64}$/);
  }
});

test('不支持的环境不会误装其他平台组件', () => {
  assert.equal(assets['win32-arm64'], undefined);
  assert.equal(assets['linux-x64'], undefined);
});

test('桌面安装包会注册共听协议，macOS 双架构各带正确组件', () => {
  assert.deepEqual(packageJson.build.protocols[0].schemes, ['shengjian']);
  assert.match(packageJson.scripts['desktop:pack:mac'], /setup:tunnel:mac/);
  const macTunnel = packageJson.build.mac.extraResources.find(item => item.to === 'cloudflared');
  assert.equal(macTunnel.from, 'vendor/cloudflared-${arch}');
  assert.deepEqual(packageJson.build.win.target[0].arch, ['x64']);
});
