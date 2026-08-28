const { spawn } = require('child_process');
const { createHash } = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

const CLOUDFLARED_SHA256 = Object.freeze({
  'win32-x64': '8635da433b6df8194746e88ed9d2589566c20e38bfc2a80e431a348b7c765841',
  'darwin-x64': 'e88fe5874d42a94f49a7ea59cabc3722d2962d0449232b0f3b1a426a712e275c',
  'darwin-arm64': 'f35c50089cd25f77a4cb5a2152036bc26db15aa31fbe11f7995d2e42a4ed6257',
});
const PUBLIC_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

function defaultExecutablePath() {
  const filename = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  if (process.resourcesPath && !process.defaultApp) return path.join(process.resourcesPath, filename);
  const developmentName = process.platform === 'win32' ? filename : `cloudflared-${process.arch}`;
  return path.join(__dirname, '..', '..', 'vendor', developmentName);
}

function fileSha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function publicProbe(url) {
  return new Promise(resolve => {
    const request = https.get(`${url}/__music_bar_ready__`, {
      headers: { 'Cache-Control': 'no-store', 'User-Agent': 'Shengjian-Music-Bar/0.5' },
      timeout: 3000,
    }, response => {
      response.resume();
      resolve(response.statusCode === 426);
    });
    request.on('timeout', () => { request.destroy(); resolve(false); });
    request.on('error', () => resolve(false));
  });
}

async function waitForPublicRoute(url, deadline) {
  while (Date.now() < deadline) {
    if (await publicProbe(url)) return true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

class InternetTunnel {
  constructor({ executablePath = defaultExecutablePath(), onStatus, startTimeoutMs = 45000 } = {}) {
    this.executablePath = executablePath;
    this.onStatus = onStatus;
    this.startTimeoutMs = Math.max(10000, Math.min(90000, Number(startTimeoutMs) || 45000));
    this.process = null;
    this.publicUrl = '';
    this.closing = false;
    this.starting = null;
    this.outputTail = '';
  }

  emit(value) {
    try { this.onStatus?.({ ...value }); } catch {}
  }

  async verifyExecutable() {
    let stats;
    try { stats = await fs.promises.stat(this.executablePath); }
    catch { throw new Error('缺少互联网隧道组件，请重新安装应用'); }
    if (!stats.isFile() || stats.size < 10 * 1024 * 1024) throw new Error('互联网隧道组件无效');
    const actual = await fileSha256(this.executablePath);
    const expected = CLOUDFLARED_SHA256[`${process.platform}-${process.arch}`];
    if (!expected || actual !== expected) throw new Error('互联网隧道组件安全校验失败');
  }

  async start(port) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('本机房间端口无效');
    if (this.process && this.publicUrl) return { publicUrl: this.publicUrl, endpoint: this.toEndpoint(this.publicUrl) };
    if (this.starting) return this.starting;
    this.starting = this.startInternal(port).finally(() => { this.starting = null; });
    return this.starting;
  }

  async startInternal(port) {
    await this.verifyExecutable();
    this.closing = false;
    this.publicUrl = '';
    this.outputTail = '';
    this.emit({ status: 'starting' });

    const child = spawn(this.executablePath, [
      'tunnel',
      '--config', process.platform === 'win32' ? 'NUL' : '/dev/null',
      '--no-autoupdate',
      '--url', `http://127.0.0.1:${port}`,
      '--loglevel', 'info',
      '--transport-loglevel', 'warn',
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    this.process = child;

    return new Promise((resolve, reject) => {
      let settled = false;
      let startedSuccessfully = false;
      let registered = false;
      let probing = false;
      const deadline = Date.now() + this.startTimeoutMs;
      const timer = setTimeout(() => finish(new Error('建立互联网房间超时，请检查网络后重试')), this.startTimeoutMs);
      timer.unref?.();

      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          this.stopChild(child);
          if (this.process === child) this.process = null;
          this.emit({ status: 'error', message: error.message });
          reject(error);
          return;
        }
        startedSuccessfully = true;
        const result = { publicUrl: this.publicUrl, endpoint: this.toEndpoint(this.publicUrl) };
        this.emit({ status: 'ready', ...result });
        resolve(result);
      };

      const inspect = chunk => {
        const text = String(chunk || '');
        this.outputTail = `${this.outputTail}${text}`.slice(-12000);
        const match = this.outputTail.match(PUBLIC_URL_PATTERN);
        if (match && !this.publicUrl) {
          this.publicUrl = match[0].toLowerCase();
          this.emit({ status: 'address', publicUrl: this.publicUrl });
        }
        if (/Registered tunnel connection/i.test(this.outputTail)) registered = true;
        if (this.publicUrl && registered && !probing) {
          probing = true;
          waitForPublicRoute(this.publicUrl, deadline)
            .then(ready => finish(ready ? null : new Error('公网房间地址尚未生效，请重试')))
            .catch(error => finish(error));
        }
      };

      child.stdout.on('data', inspect);
      child.stderr.on('data', inspect);
      child.once('error', error => finish(new Error(`无法启动互联网连接：${error.message}`)));
      child.once('exit', code => {
        clearTimeout(timer);
        if (this.process === child) this.process = null;
        if (!settled) {
          const detail = /ERR\s+([^\r\n]+)/i.exec(this.outputTail)?.[1];
          finish(new Error(detail ? `互联网连接失败：${detail}` : `互联网连接进程已退出（${code ?? '未知'}）`));
        } else if (startedSuccessfully && !this.closing) {
          this.publicUrl = '';
          this.emit({ status: 'disconnected', message: '互联网隧道已断开' });
        }
      });
    });
  }

  toEndpoint(publicUrl) {
    const url = new URL(publicUrl);
    url.protocol = 'wss:';
    return url.toString();
  }

  stopChild(child) {
    if (!child || child.exitCode !== null || child.killed) return;
    try { child.kill(); } catch {}
  }

  async close() {
    this.closing = true;
    this.publicUrl = '';
    const child = this.process;
    this.process = null;
    if (!child || child.exitCode !== null) {
      this.emit({ status: 'closed' });
      return;
    }
    this.stopChild(child);
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 2000)),
    ]);
    if (child.exitCode === null) {
      try { child.kill('SIGKILL'); } catch {}
    }
    this.emit({ status: 'closed' });
  }
}

module.exports = { InternetTunnel, CLOUDFLARED_SHA256 };
