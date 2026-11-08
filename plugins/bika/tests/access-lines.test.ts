import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import * as crypto from "node:crypto";
import type { AxiosAdapter } from "axios";
import client, { BikaAccessLineChangedError } from "../src/client";
import { bikaRequest } from "../src/bika-request";
import { init, getSettingsBundle } from "../src/bika-settings";
import { checkBikaAccessLines, cancelBikaAccessLineCheck, getBikaAccessLineState,
  selectBikaAccessLine } from "../src/bika-access-lines";
import { DEFAULT_API_BASE, BACKUP_API_BASE, API_BASE_CACHE_KEY,
  LINE_CONFIRMATION_KEY, decodeLineText, lineBase, publicLineDomain } from "../src/bika-access-line-policy";

const config = new Map<string, unknown>();
const cache = new Map<string, unknown>();
const writes: string[] = [];
const wire: { url: string; options: RequestInit }[] = [];
const originalFetch = globalThis.fetch;
const originalAdapter = client.defaults.adapter;
let read: (url: string, options: RequestInit) => Promise<Response>;
Object.assign(globalThis, { nodeCryptoCompat: crypto, uuidv4: crypto.randomUUID,
  bridge: { async call(name: string, ...args: unknown[]) {
    const key = String(args[0]);
    switch (name) {
      case "load_plugin_config": return { ok: true, value: config.has(key) ? config.get(key) : JSON.parse(String(args[1])) };
      case "save_plugin_config": writes.push(key); config.set(key, JSON.parse(String(args[1]))); return { ok: true };
      case "cache.get": return cache.has(key) ? cache.get(key) : args[1];
      case "cache.set": cache.set(key, args[1]); return;
      case "cache.delete": cache.delete(key); return;
      case "dart.getAppVersion": return "3.0.37";
      default: throw new Error(`Unexpected bridge ${name}`);
    }
  } },
});
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}
function encoded(domain: string) {
  return 'v_' + btoa(domain.replace(/\./g, '@').split('').reverse().join('')).split('').reverse().join('');
}
beforeEach(() => {
  config.clear(); cache.clear(); writes.length = wire.length = 0;
  read = async (url) => response(url.includes('/dns-query?') ? { Status: 3 } : url.includes('/dns/') ? [] : {});
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input); wire.push({ url, options }); return read(url, options);
  };
});
after(() => { globalThis.fetch = originalFetch; client.defaults.adapter = originalAdapter; });

test('domain decoder reproduces static double reverse/Base64/@ mapping without accepting URLs or private literals', () => {
  assert.equal(decodeLineText(encoded('go2778.com')), 'go2778.com');
  assert.equal(decodeLineText('"' + encoded('go2778.com') + '"'), 'go2778.com');
  for (const value of ['', '_', 'x_bad*', encoded('127.0.0.1'), encoded('localhost'), encoded('https://evil.com/')])
    assert.equal(decodeLineText(value), null);
  for (const value of ['localhost', 'a.local', 'a.internal', '127.0.0.1', '[::1]', 'user@host.com', 'host.com/path', '-a.com'])
    assert.equal(publicLineDomain(value), null);
  for (const value of ['http://picaapi.go2778.com/', 'https://picaapi.127.0.0.1/', 'https://picaapi.a.local/',
    'https://u:p@picaapi.go2778.com/', 'https://picaapi.go2778.com:8080/', 'https://picaapi.go2778.com/path'])
    assert.equal(lineBase(value), null);
});

test('NXDOMAIN retains the two static candidates; checks omit credentials/redirects and never write selection', async () => {
  const result = await checkBikaAccessLines({ runId: 'bootstrap' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.lines.map(l => l.base).sort(), [DEFAULT_API_BASE, BACKUP_API_BASE].sort());
  for (const line of result.lines) assert.ok(Number.isInteger(line.elapsedMs) && line.elapsedMs >= 0);
  for (const { options } of wire) {
    assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    assert.deepEqual(Object.keys(options.headers ?? {}), ['accept']);
  }
  assert.deepEqual(writes, []);
  assert.equal((await getBikaAccessLineState()).selected, false);
});

test('only validated official answers expand candidates and concurrency is bounded to two', async () => {
  let active = 0, peak = 0;
  read = async (url) => {
    if (url.includes('/dns-query?')) return response({ Answer: [
      { type: 16, data: encoded('fixture-public.net') }, { type: 16, data: encoded('127.0.0.1') },
      { type: 16, data: encoded('fixture-public.net') }, { type: 1, data: encoded('ignored.net') },
    ] });
    if (url.includes('/dns/')) return response([]);
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 15)); active--;
    return response({});
  };
  const result = await checkBikaAccessLines({ runId: 'dynamic' });
  assert.equal(result.lines.length, 3); assert.equal(peak, 2);
  assert.ok(result.lines.every(l => l.elapsedMs >= 10), 'elapsed time must come from actual completion');
  assert.ok(wire.some(w => w.url === 'https://picaapi.fixture-public.net/'));
  assert.ok(wire.every(w => !w.url.includes('127.0.0.1') && !w.url.includes('ignored.net')));
});

test('explicit selection commits same API setting, cache mirror and confirmation; stale/unverified selections do not write', async () => {
  const result = await checkBikaAccessLines({ runId: 'select' });
  assert.equal((await selectBikaAccessLine({ runId: 'select', snapshot: result.snapshot,
    base: 'https://picaapi.unchecked.net/' })).ok, false);
  assert.deepEqual(writes, []);
  const selected = await selectBikaAccessLine({ runId: 'select', snapshot: result.snapshot, base: BACKUP_API_BASE });
  assert.equal(selected.ok, true); assert.equal(config.get('network.apiBase'), BACKUP_API_BASE);
  assert.equal(cache.get(API_BASE_CACHE_KEY), BACKUP_API_BASE);
  assert.equal((await getBikaAccessLineState()).selected, true);
  const before = [...config.entries()];
  assert.equal((await selectBikaAccessLine({ runId: 'select', snapshot: result.snapshot, base: DEFAULT_API_BASE })).ok, false);
  assert.deepEqual([...config.entries()], before);
});

test('cancel aborts I/O, suppresses completion and prevents writes; subsequent explicit retry remains usable', async () => {
  let aborts = 0;
  read = (_url, options) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => { aborts++; reject(new Error('aborted')); }, { once: true });
  });
  const pending = checkBikaAccessLines({ runId: 'cancel' });
  while (!wire.length) await new Promise(resolve => setImmediate(resolve));
  await cancelBikaAccessLineCheck({ runId: 'cancel' });
  assert.equal((await pending).cancelled, true); assert.ok(aborts > 0); assert.deepEqual(writes, []);
  assert.equal((await selectBikaAccessLine({ runId: 'cancel', snapshot: '', base: DEFAULT_API_BASE })).ok, false);
});

test('persisted revision rejects a late account response and prevents request-cache pollution', async () => {
  let finish!: () => void;
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const adapter: AxiosAdapter = async request => {
    started(); await new Promise<void>(resolve => { finish = resolve; });
    return { data: { code: 200 }, status: 200, statusText: 'OK', headers: {}, config: request };
  };
  client.defaults.adapter = adapter;
  const pending = bikaRequest({ url: DEFAULT_API_BASE + 'categories', cache: true });
  await began;
  config.set(LINE_CONFIRMATION_KEY, { base: BACKUP_API_BASE, revision: 'next' });
  finish(); await assert.rejects(pending, BikaAccessLineChangedError);
  assert.ok([...cache.keys()].every(k => !k.startsWith('bikaComic:requestCache:')));
});

test('first runtime init does not issue automatic account requests before a line is confirmed', async () => {
  config.set('auth.account', 'fixture-account'); config.set('auth.password', 'fixture-password');
  let calls = 0;
  client.defaults.adapter = async request => { calls++; throw new Error('must not send'); };
  await init(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0); assert.equal((await getBikaAccessLineState()).selected, false);
});

test('Plus exposes one access-line workflow while Classic keeps its original API field', async () => {
  const plus = await getSettingsBundle();
  const classic = await getSettingsBundle({ retainApiChoice: true });
  assert.ok(!plus.scheme.sections.flatMap(s => s.fields).some(f => f.key === 'network.apiBase'));
  assert.ok(plus.scheme.sections.flatMap(s => s.fields).some(f => f.key === 'network.proxy'));
  assert.ok(classic.scheme.sections.flatMap(s => s.fields).some(f => f.key === 'network.apiBase'));
});

test('an externally changed line invalidates the entire pending selection before its first write', async () => {
  const result = await checkBikaAccessLines({ runId: 'stale' });
  config.set('network.apiBase', BACKUP_API_BASE);
  const outcome = await selectBikaAccessLine({ runId: 'stale', snapshot: result.snapshot, base: DEFAULT_API_BASE });
  assert.equal(outcome.ok, false); assert.equal(outcome.reason, 'changed'); assert.deepEqual(writes, []);
});

test('after selection, stale absolute API URLs cannot send account headers to the previous origin', async () => {
  config.set('network.apiBase', BACKUP_API_BASE);
  config.set(LINE_CONFIRMATION_KEY, { base: BACKUP_API_BASE, revision: 'selected' });
  config.set('auth.authorization', 'fixture-token');
  let sent = 0;
  client.defaults.adapter = async request => { sent++; throw new Error('must not send'); };
  await assert.rejects(bikaRequest({ url: DEFAULT_API_BASE + 'categories' }), BikaAccessLineChangedError);
  assert.equal(sent, 0);
});

test('restored confirmed dynamic origin is the same actual API setting and init never resets it to bootstrap', async () => {
  const base = 'https://picaapi.fixture-public.net/';
  config.set('network.apiBase', base);
  config.set(LINE_CONFIRMATION_KEY, { base, revision: 'restored' });
  await init();
  assert.equal((await getBikaAccessLineState()).base, base);
  assert.equal((await getBikaAccessLineState()).selected, true);
  assert.equal(cache.get(API_BASE_CACHE_KEY), base);
  assert.equal(config.has('auth.authorization'), false);
});

test('unrecognized non-200 root responses never become available or alter remembered choice', async () => {
  config.set('network.apiBase', BACKUP_API_BASE);
  config.set(LINE_CONFIRMATION_KEY, { base: BACKUP_API_BASE, revision: 'remembered' });
  read = async url => response(url.includes('/dns-query?') ? { Status: 3 } : [],
    url.includes('picaapi.') ? 403 : 200);
  const result = await checkBikaAccessLines({ runId: 'unavailable' });
  assert.deepEqual(result.lines, []); assert.deepEqual(writes, []);
  assert.equal((await getBikaAccessLineState()).base, BACKUP_API_BASE);
  assert.equal((await getBikaAccessLineState()).selected, true);
});

test('existing Plus credentials are retained but do not fabricate an explicit health confirmation', async () => {
  config.set('auth.authorization', 'fixture-existing-session');
  const active = await getBikaAccessLineState();
  assert.equal(active.selected, false); assert.equal(active.retained, true); assert.equal(active.confirmation, null);
  config.clear(); config.set('network.apiBase', BACKUP_API_BASE);
  const explicit = await getBikaAccessLineState();
  assert.equal(explicit.selected, false); assert.equal(explicit.retained, true);
  assert.deepEqual(writes, []); assert.equal(config.has(LINE_CONFIRMATION_KEY), false);
});


test('anonymous probe uses the actual API media type and distinguishes a structured login challenge', async () => {
  read = async (url, options) => {
    if (url.includes('/dns-query?')) return response({ Status: 3 });
    if (url.includes('/dns/')) return response([]);
    assert.equal((options.headers as Record<string, string>).accept, 'application/vnd.picacomic.com.v1+json');
    return response({ code: 401, error: '1005', message: 'unauthorized' }, 401);
  };
  const result = await checkBikaAccessLines({ runId: 'known-api-challenge' });
  assert.equal(result.lines.length, 2);
  assert.ok(result.lines.every(line => line.requiresAuthentication));
  assert.equal((await getBikaAccessLineState()).selected, false);
  assert.deepEqual(writes, []);
});

test('discovery and probe diagnostics distinguish parsing, HTTP and connection failure without accepting generic 401', async () => {
  read = async url => {
    if (url.includes('/dns-query?')) return new Response('not-json', { status: 200 });
    if (url.includes('/dns/')) throw new TypeError('connection failed');
    return response({ message: 'unauthorized' }, 401);
  };
  const result = await checkBikaAccessLines({ runId: 'diagnostic-boundaries' });
  assert.deepEqual(result.lines, []);
  assert.equal(result.diagnostics.candidateCount, 2);
  assert.ok(result.diagnostics.discovery.some(row => row.kind === 'parse'));
  assert.ok(result.diagnostics.discovery.some(row => row.kind === 'transport'));
  assert.ok(result.diagnostics.probes.every(row => row.kind === 'http' && row.status === 401));
});

test('legacy account or default API preference does not impersonate an explicit first selection', async () => {
  config.set('auth.authorization', 'fixture-existing-session');
  config.set('network.apiBase', BACKUP_API_BASE);
  const state = await getBikaAccessLineState();
  assert.equal(state.selected, false);
  assert.equal(state.base, BACKUP_API_BASE);
  assert.equal(config.get('auth.authorization'), 'fixture-existing-session');
  assert.deepEqual(writes, []);
});

test('a remembered dynamic origin remains a candidate when live discovery has no answer', async () => {
  const base = 'https://picaapi.fixture-public.net/';
  config.set('network.apiBase', base);
  config.set(LINE_CONFIRMATION_KEY, { base, revision: 'already-selected' });
  const result = await checkBikaAccessLines({ runId: 'remembered-candidate' });
  assert.ok(result.lines.some(line => line.base === base));
  assert.ok(wire.some(row => row.url === base));
});


test('retained credentials cannot trigger account requests before the first explicit line selection', async () => {
  config.set('auth.account', 'fixture-account'); config.set('auth.password', 'fixture-password');
  config.set('auth.authorization', 'fixture-existing-session');
  let calls = 0;
  client.defaults.adapter = async () => { calls++; throw new Error('must not send'); };
  await init(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
  assert.equal((await getBikaAccessLineState()).selected, false);
});
