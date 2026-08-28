const CUSTOM_SCHEME = 'shengjian:';
const DEFAULT_JOIN_BASE = 'shengjian://join';
const MAX_JOIN_INPUT_LENGTH = 4096;

function extractInvite(value) {
  const input = String(value || '').trim();
  if (!input || input.length > MAX_JOIN_INPUT_LENGTH) throw new Error('邀请链接无效');
  if (input.startsWith('MB1.')) return input;

  let url;
  try { url = new URL(input); }
  catch { throw new Error('请粘贴 MB1. 邀请或共听链接'); }

  const isCustomJoin = url.protocol === CUSTOM_SCHEME && url.hostname === 'join';
  const isWebJoin = ['http:', 'https:'].includes(url.protocol) && url.pathname.replace(/\/+$/, '') === '/join';
  if (!isCustomJoin && !isWebJoin) throw new Error('不是有效的共听链接');

  const fragment = decodeURIComponent(url.hash.replace(/^#/, ''));
  if (!fragment.startsWith('MB1.')) throw new Error('共听链接缺少邀请内容');
  return fragment;
}

function createJoinLink(invite, base = DEFAULT_JOIN_BASE) {
  const normalized = extractInvite(invite);
  const url = new URL(base);
  if (url.protocol !== CUSTOM_SCHEME && !['https:'].includes(url.protocol)) {
    throw new Error('共听链接必须使用 shengjian 或 HTTPS');
  }
  url.hash = normalized;
  return url.toString();
}

function findJoinInput(values) {
  for (const value of values || []) {
    try { return extractInvite(value); } catch {}
  }
  return '';
}

module.exports = { CUSTOM_SCHEME, DEFAULT_JOIN_BASE, createJoinLink, extractInvite, findJoinInput };
