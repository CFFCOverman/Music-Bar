const { spawnSync } = require('child_process');
const { createHash } = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { CLOUDFLARED_SHA256 } = require('../src/main/tunnel.cjs');

const VERSION = '2026.7.3';
const vendorDirectory = path.join(__dirname, '..', 'vendor');
const assets = {
  'win32-x64': { name: 'cloudflared-windows-amd64.exe', destination: 'cloudflared.exe', archive: false },
  'darwin-x64': { name: 'cloudflared-darwin-amd64.tgz', destination: 'cloudflared-x64', archive: true },
  'darwin-arm64': { name: 'cloudflared-darwin-arm64.tgz', destination: 'cloudflared-arm64', archive: true },
};

function requestedPlatformKey(argv = process.argv.slice(2)) {
  const platformIndex = argv.indexOf('--platform');
  const archIndex = argv.indexOf('--arch');
  const platform = platformIndex >= 0 ? argv[platformIndex + 1] : process.platform;
  const arch = archIndex >= 0 ? argv[archIndex + 1] : process.arch;
  return `${platform}-${arch}`;
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function verifySignature(file) {
  const escaped = file.replace(/'/g, "''");
  const windowsRoot = process.env.SystemRoot || 'C:\\Windows';
  const powerShellBase = path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0');
  const powerShell = path.join(powerShellBase, 'powershell.exe');
  const securityModule = path.join(powerShellBase, 'Modules', 'Microsoft.PowerShell.Security', 'Microsoft.PowerShell.Security.psd1').replace(/'/g, "''");
  const command = `Import-Module '${securityModule}' -ErrorAction Stop; `
    + `$signature = Get-AuthenticodeSignature -LiteralPath '${escaped}'; `
    + `if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notlike '*Cloudflare, Inc.*') { `
    + `Write-Error ('status=' + $signature.Status + '; signer=' + $signature.SignerCertificate.Subject); exit 1 }`;
  const result = spawnSync(powerShell, ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const detail = result.error?.message || String(result.stderr || '').trim() || `exit ${result.status}`;
    console.error(`cloudflared 签名验证诊断：${detail}`);
  }
  return result.status === 0;
}

function download(url, file, redirects = 5) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { 'User-Agent': 'Shengjian-Music-Bar-Setup/0.5' },
      timeout: 30000,
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirects <= 0) return reject(new Error('cloudflared 下载重定向次数过多'));
        return download(new URL(response.headers.location, url).toString(), file, redirects - 1).then(resolve, reject);
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`cloudflared 下载失败：HTTP ${response.statusCode}`));
      }
      const output = fs.createWriteStream(file, { flags: 'wx' });
      output.on('error', reject);
      response.on('error', reject);
      output.on('finish', resolve);
      response.pipe(output);
    });
    request.on('timeout', () => request.destroy(new Error('cloudflared 下载超时')));
    request.on('error', reject);
  });
}

async function install(platformKey = requestedPlatformKey()) {
  const asset = assets[platformKey];
  if (!asset) {
    throw new Error(`cloudflared: 不支持 ${platformKey}`);
  }
  const assetUrl = `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/${asset.name}`;
  const destination = path.join(vendorDirectory, asset.destination);
  const temporary = `${destination}.download-${process.pid}`;
  if (process.env.MUSIC_BAR_SKIP_TUNNEL_DOWNLOAD === '1') {
    console.log('cloudflared: 已按环境变量跳过下载。');
    return;
  }
  await fs.promises.mkdir(vendorDirectory, { recursive: true });
  try {
    const hashValid = await hashFile(destination) === CLOUDFLARED_SHA256[platformKey];
    if (hashValid && (process.platform !== 'win32' || verifySignature(destination))) {
      console.log(`cloudflared ${VERSION}: 已安装并通过安全校验。`);
      return;
    }
  } catch {}

  await fs.promises.rm(temporary, { force: true });
  console.log(`cloudflared ${VERSION}: 正在从 Cloudflare 官方仓库下载…`);
  try {
    await download(assetUrl, temporary);
    let installedFile = temporary;
    if (asset.archive) {
      const archive = `${temporary}.tgz`;
      await fs.promises.rename(temporary, archive);
      const extraction = spawnSync('tar', ['-xzf', archive, '-C', vendorDirectory], { encoding: 'utf8' });
      await fs.promises.rm(archive, { force: true });
      if (extraction.status !== 0) throw new Error(`cloudflared 解压失败：${String(extraction.stderr || '').trim()}`);
      installedFile = path.join(vendorDirectory, 'cloudflared');
    }
    const actual = await hashFile(installedFile);
    if (actual !== CLOUDFLARED_SHA256[platformKey]) throw new Error(`SHA-256 校验失败：${actual}`);
    if (process.platform === 'win32' && !verifySignature(installedFile)) throw new Error('Cloudflare Authenticode 数字签名校验失败');
    await fs.promises.rm(destination, { force: true });
    await fs.promises.rename(installedFile, destination);
    if (process.platform === 'darwin') await fs.promises.chmod(destination, 0o755);
    console.log(`cloudflared ${VERSION}: 安装完成。`);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true });
    if (asset.archive) await fs.promises.rm(path.join(vendorDirectory, 'cloudflared'), { force: true });
    throw error;
  }
}

if (require.main === module) install().catch(error => {
  console.error(`cloudflared 安装失败：${error.message}`);
  process.exitCode = 1;
});

module.exports = { assets, install, requestedPlatformKey };
