const assert = require('assert/strict');
const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { CLOUDFLARED_SHA256 } = require('../src/main/tunnel.cjs');

test('Windows 安装包含经过固定哈希校验的 cloudflared', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, () => {
  const file = path.join(__dirname, '..', 'vendor', 'cloudflared.exe');
  const actual = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(actual, CLOUDFLARED_SHA256);
});
