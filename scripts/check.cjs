const { spawnSync } = require('child_process');
const path = require('path');

const files = [
  'src/main/index.cjs',
  'src/main/media.cjs',
  'src/main/metadata.cjs',
  'src/main/room-controller.cjs',
  'src/main/room.cjs',
  'src/main/store.cjs',
  'src/main/tunnel.cjs',
  'src/preload.cjs',
  'src/renderer/app.js',
  'scripts/setup-cloudflared.cjs',
  'test/store.test.cjs',
];

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.join(__dirname, '..', file)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`语法检查通过：${files.length} 个文件。`);
