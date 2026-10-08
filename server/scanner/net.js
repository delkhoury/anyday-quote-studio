// Bounded, SSRF-safe HTTP fetching for the website scanner.
// - only http(s)
// - every hostname is resolved and every address checked against private/reserved ranges
// - the connection is pinned to the checked address (no DNS rebinding between check and connect)
// - redirects are followed manually and every hop is re-validated
// - time and size limits on every request; gzip bodies are decompressed with an output cap

import dns from 'node:dns/promises';
import net from 'node:net';
import zlib from 'node:zlib';
import { Agent, fetch as ufetch } from 'undici';

export const USER_AGENT = 'AnydayQuoteScanner/1.0 (+https://anyday.inc; website scoping for proposals)';
export const UA_TOKEN = 'anydayquotescanner';

export class ScanError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function ipv4ToInt(ip) { return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0; }
const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4], ['255.255.255.255', 32],
].map(([b, m]) => [ipv4ToInt(b), m]);

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKS.some(([b, m]) => (m === 0 ? true : ((n >>> (32 - m)) === (b >>> (32 - m)))));
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) || x.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(x)) {
      const [, a, b] = x.match(/^::ffff:([0-9a-f]+):([0-9a-f]+)$/);
      const v = (parseInt(a, 16) << 16) + parseInt(b, 16);
      return isPrivateAddress([v >>> 24 & 255, v >>> 16 & 255, v >>> 8 & 255, v & 255].join('.'));
    }
    const first = parseInt(x.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return true;   // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true;   // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return true;   // multicast
    if (x.startsWith('64:ff9b:')) return true;      // NAT64 can reach v4 internals
    if (x.startsWith('2001:db8')) return true;      // documentation
    return false;
  }
  return true;
}

// Test only: SCANNER_ALLOW_PRIVATE_HOSTS="127.0.0.1" lets a local fixture site be scanned while
// every other private destination (including redirect targets) stays blocked.
const testHosts = () => (process.env.SCANNER_ALLOW_PRIVATE_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);

export async function resolvePublic(hostname, { allowPrivate = false } = {}) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (testHosts().includes(host)) allowPrivate = true;
  if (/^localhost$/i.test(host) || /\.localhost$/i.test(host) || /\.local$/i.test(host) || /\.internal$/i.test(host)) {
    if (!allowPrivate) throw new ScanError('private_destination', `Refusing private host ${hostname}`);
  }
  let addrs;
  if (net.isIP(host)) addrs = [{ address: host, family: net.isIPv6(host) ? 6 : 4 }];
  else {
    try { addrs = await dns.lookup(host, { all: true, verbatim: true }); }
    catch (e) { throw new ScanError('dns', `Could not resolve ${hostname}: ${e.code || e.message}`); }
  }
  if (!addrs.length) throw new ScanError('dns', `No addresses for ${hostname}`);
  if (!allowPrivate) {
    const bad = addrs.find(a => isPrivateAddress(a.address));
    if (bad) throw new ScanError('private_destination', `Refusing ${hostname}: resolves to a private or reserved address (${bad.address})`);
  }
  return addrs[0];
}

function pinnedAgent(address, family, timeoutMs) {
  return new Agent({
    connect: {
      timeout: timeoutMs,
      lookup: (_h, _o, cb) => cb(null, [{ address, family }]),
    },
    headersTimeout: timeoutMs, bodyTimeout: timeoutMs,
  });
}

export function validateUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new ScanError('bad_url', `Not a valid URL: ${raw}`); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new ScanError('bad_url', `Only http and https URLs can be scanned (${u.protocol})`);
  if (u.username || u.password) throw new ScanError('bad_url', 'URLs with credentials are not allowed');
  if (u.port && !['80', '443', '8080', '8443'].includes(u.port)) {
    // allow uncommon ports only in private test mode
    if (!process.env.SCANNER_ALLOW_PRIVATE && !testHosts().includes(u.hostname)) throw new ScanError('bad_url', `Port ${u.port} is not allowed`);
  }
  return u;
}

// Fetch with manual, validated redirects. Returns { url, status, headers, body: Buffer, redirects[] }.
export async function safeFetch(rawUrl, { timeoutMs = 15000, maxBytes = 5 * 1024 * 1024, maxRedirects = 5, accept = '*/*', allowPrivate = !!process.env.SCANNER_ALLOW_PRIVATE, signal } = {}) {
  let current = validateUrl(rawUrl);
  const redirects = [];
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const { address, family } = await resolvePublic(current.hostname, { allowPrivate });
    const agent = pinnedAgent(address, family, timeoutMs);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new ScanError('timeout', `Timed out after ${timeoutMs}ms: ${current}`)), timeoutMs);
    const onAbort = () => ctl.abort(new ScanError('cancelled', 'Scan cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });
    let res;
    try {
      res = await ufetch(current.toString(), {
        redirect: 'manual', dispatcher: agent, signal: ctl.signal,
        headers: { 'user-agent': USER_AGENT, accept, 'accept-encoding': 'gzip, deflate, br' },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        const loc = res.headers.get('location');
        await res.body?.cancel().catch(() => {});
        let next;
        try { next = validateUrl(new URL(loc, current).toString()); }
        catch (e) { throw new ScanError('unsafe_redirect', `Unsafe redirect from ${current} to ${loc}: ${e.message}`); }
        redirects.push({ from: current.toString(), to: next.toString(), status: res.status });
        current = next;
        continue; // next hop re-resolves and re-validates the destination
      }
      const body = await readCapped(res, maxBytes);
      return { url: current.toString(), status: res.status, headers: Object.fromEntries(res.headers), body, redirects };
    } catch (e) {
      if (e instanceof ScanError) throw e;
      const reason = ctl.signal.reason instanceof ScanError ? ctl.signal.reason : null;
      if (reason) throw reason;
      throw new ScanError('network', `${e.cause?.code || e.code || e.name}: ${e.cause?.message || e.message}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      agent.close().catch(() => {});
    }
  }
  throw new ScanError('too_many_redirects', `More than ${maxRedirects} redirects for ${rawUrl}`);
}

async function readCapped(res, maxBytes) {
  if (!res.body) return Buffer.alloc(0);
  const len = Number(res.headers.get('content-length') || 0);
  if (len && len > maxBytes) { await res.body.cancel().catch(() => {}); throw new ScanError('too_large', `Response larger than ${maxBytes} bytes`); }
  const chunks = []; let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > maxBytes) { throw new ScanError('too_large', `Response larger than ${maxBytes} bytes`); }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function maybeGunzip(buf, maxOutput = 50 * 1024 * 1024) {
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try { return zlib.gunzipSync(buf, { maxOutputLength: maxOutput }); }
    catch (e) { throw new ScanError('gzip', `Could not decompress gzip sitemap: ${e.code || e.message}`); }
  }
  return buf;
}
