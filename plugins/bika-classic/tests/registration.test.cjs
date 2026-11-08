// Runs real TypeScript modules with Node's in-memory type transformation. No bundle, manifest
// or generated CJS is written; the identity substitutions mirror build.mjs.
const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { registerHooks, createRequire } = require('node:module');
const { existsSync, readFileSync } = require('node:fs');
const { resolve, dirname } = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
const root = resolve(__dirname, '..');
const core = resolve(root, '../bika/src');
const coreRequire = createRequire(resolve(root, '../bika/package.json'));
const ID = '97b8ebb1-9f1f-423c-9847-acd7b0ccd31f';
const OLD = 'e9f18928-3ba8-4d86-a12e-b53a62f47933';
const originalFetch = globalThis.fetch;
const originalBridge = globalThis.bridge;
let graph = 0;
registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL ? new URL(context.parentURL) : null;
    const tag = parent?.searchParams.get('slice');
    let url;
    if (tag && parent.protocol === 'file:') {
      const parentFile = fileURLToPath(parent);
      if (tag.startsWith('classic-') && dirname(parentFile) === core &&
          ['./info', './bika-identity'].includes(specifier)) {
        url = pathToFileURL(resolve(root, 'src', specifier === './info' ? 'info.ts' : 'identity.ts')).href;
      } else if (specifier === 'breeze-plugin-kit') {
        url = pathToFileURL(coreRequire.resolve(specifier)).href;
      } else if (specifier === 'axios') {
        url = pathToFileURL(coreRequire.resolve('axios').replace('/dist/node/axios.cjs', '/dist/esm/axios.js')).href;
      } else if (specifier.startsWith('.')) {
        const local = new URL(specifier, parent);
        local.search = '';
        if (existsSync(fileURLToPath(local) + '.ts')) url = local.href + '.ts';
      }
    }
    const result = url ? { url, shortCircuit: true } : next(specifier, context);
    if (tag && result.url.startsWith('file:')) {
      const target = new URL(result.url);
      target.searchParams.set('slice', tag);
      return { ...result, url: target.href };
    }
    return result;
  },
});
after(() => { globalThis.fetch = originalFetch; globalThis.bridge = originalBridge; });
const plain = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const generatedFiles = [resolve(root, 'manifest.json'), resolve(root, 'dist/breeze-plugin-bika-classic.bundle.cjs')];
const originalBytes = generatedFiles.map((path) => readFileSync(path));

async function fixture({ store = new Map(), respond, original = false, beforeCacheCompare } = {}) {
  const runtime = original ? OLD : ID;
  const requests = [], writes = [];
  const key = (kind, field) => `${runtime}|${kind}|${field}`;
  globalThis.nodeCryptoCompat = crypto;
  globalThis.uuidv4 = crypto.randomUUID;
  globalThis.bridge = { async call(name, ...args) {
    const scoped = key(name.startsWith('cache.') ? 'cache' : 'config', String(args[0]));
    if (name === 'load_plugin_config') return { ok: true, value: store.has(scoped) ? store.get(scoped) : JSON.parse(String(args[1])) };
    if (name === 'save_plugin_config') { writes.push(scoped); store.set(scoped, JSON.parse(String(args[1]))); return { ok: true }; }
    if (name === 'cache.get') return store.has(scoped) ? store.get(scoped) : args[1];
    if (name === 'cache.set') { store.set(scoped, args[1]); return; }
    if (name === 'cache.delete') { store.delete(scoped); return; }
    if (name === 'cache.compare_and_set') { await beforeCacheCompare?.(scoped, args[1], args[2], store); if (JSON.stringify(store.get(scoped)) !== JSON.stringify(args[1])) return false; store.set(scoped, args[2]); return true; }
    if (name === 'dart.getAppVersion') return '3.0.37';
    throw new Error(`Unmocked fixture bridge: ${name}`);
  } };
  const defaults = (url) => {
    if (url.pathname === '/categories') return { code: 200, data: { categories: [
      { title: '全彩', thumb: {} }, { title: '同人', thumb: {} },
      { title: '小電影', isWeb: true, link: 'https://adult-movie.bidobido.xyz/', thumb: {} },
    ] } };
    if (url.pathname === '/keywords') return { code: 200, data: { keywords: ['离线热词'] } };
    throw new Error(`Unmocked fixture endpoint: ${url.pathname}`);
  };
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const record = { url: new URL(request.url), method: request.method, body: await request.text(), headers: Object.fromEntries(request.headers) };
    requests.push(record);
    const reply = await respond(record);
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  };
  const entry = pathToFileURL(original ? resolve(core, 'index.ts') : resolve(root, 'src/registration.ts'));
  entry.searchParams.set('slice', `${original ? 'original' : 'classic'}-${++graph}`);
  const plugin = await import(entry.href);
  return { plugin, store, requests, writes, runtime,
    set(field, value) { store.set(key('config', field), value); },
    expireCache() { for (const [name, value] of store) if (name.startsWith(`${runtime}|cache|bikaComic:requestCache:`) && value?.expireAt) store.set(name, { ...value, expireAt: 0 }); },
  };
}

const valid = () => ({ name: 'fixture nickname', email: 'FixtureAccount', password: 'private-password',
  question1: 'private-question-1', question2: 'private-question-2', question3: 'private-question-3',
  answer1: 'private-answer-1', answer2: 'private-answer-2', answer3: 'private-answer-3',
  birthday: '1990-11-04', gender: 'bot' });
const status = (response) => response.data.status;
const reason = (response) => response.data.reason;

test('registration sends only the recovered 11 fields with mature signed POST, returns account only', async () => {
  const f = await fixture({ respond: async () => ({ status: 200, body: { code: 200, message: 'success', token: 'must-not-be-session' } }) });
  const input = valid();
  const response = await f.plugin.registerAccount({ ...input, extern: { password: 'ignored' }, authorization: 'ignored' });
  assert.equal(status(response), 'success'); assert.equal(response.source, ID);
  assert.deepEqual(plain(response.data), { version: 1, status: 'success', account: input.email });
  assert.equal(f.requests.length, 1); const request = f.requests[0];
  assert.equal(request.url.pathname, '/auth/register'); assert.equal(request.method, 'POST');
  assert.deepEqual(JSON.parse(request.body), input);
  for (const key of ['signature', 'nonce', 'time', 'api-key']) assert.ok(request.headers[key]);
  assert.match(request.headers['content-type'], /^application\/json/);
  assert.deepEqual(f.writes, []);
  assert.ok([...f.store.keys()].every((key) => !key.includes('requestCache')));
  assert.equal(JSON.stringify(response).includes(input.password), false);
});

test('static success branch is HTTP200 plus success message, code alone never succeeds', async () => {
  for (const [body, expected] of [[{ message: 'success' }, 'success'], [{ code: 200 }, 'failed'],
    [{ code: 200, message: 'private-answer-1' }, 'failed']]) {
    const f = await fixture({ respond: async () => ({ status: 200, body }) });
    assert.equal(status(await f.plugin.registerAccount(valid())), expected);
    assert.equal(f.requests.length, 1);
  }
});

test('duplicate identity, rejected authorization, rate and server failures are local controlled results', async () => {
  for (const [httpStatus, error, expected] of [[400, '1008', 'duplicateIdentity'], [400, '1009', 'duplicateIdentity'],
    [401, '1005', 'unauthorized'], [429, '', 'rateLimited'], [503, '', 'unavailable'], [400, 'other', 'rejected']]) {
    const secret = Object.values(valid()).join(' ');
    const f = await fixture({ respond: async () => ({ status: httpStatus, body: { error, message: secret, errorMsg: secret } }) });
    f.set('auth.authorization', 'existing-session');
    const response = await f.plugin.registerAccount(valid());
    assert.equal(reason(response), expected); assert.equal(status(response), 'failed');
    assert.equal(f.requests.length, 1); assert.deepEqual(f.writes, []);
    assert.ok([...f.store.values()].includes('existing-session'));
    assert.equal(JSON.stringify(response).includes('private-'), false);
    assert.equal(JSON.stringify(response).includes('existing-session'), false);
    assert.equal(response.error, undefined);
  }
});

test('network exception containing all input secrets never escapes and is not retried', async () => {
  const input = valid(), logs = [], original = console.error;
  console.error = (...args) => logs.push(args.join(' '));
  try {
    const f = await fixture({ respond: async () => { throw new Error(JSON.stringify(input)); } });
    const response = await f.plugin.registerAccount(input);
    assert.equal(reason(response), 'uncertain'); assert.equal(f.requests.length, 1);
    assert.equal(JSON.stringify(response).includes('private-'), false);
    assert.deepEqual(f.writes, []); assert.deepEqual(logs, []);
  } finally { console.error = original; }
});

test('one pending registration blocks duplicates; failure permits a new explicit submit', async () => {
  const pending = deferred();
  const f = await fixture({ respond: async () => { await pending.promise; return { status: 400, body: { error: '1008' } }; } });
  const first = f.plugin.registerAccount(valid());
  const second = await f.plugin.registerAccount(valid());
  assert.equal(reason(second), 'busy');
  pending.resolve(); assert.equal(reason(await first), 'duplicateIdentity');
  assert.equal(f.requests.length, 1);
  assert.equal(reason(await f.plugin.registerAccount(valid())), 'duplicateIdentity');
  assert.equal(f.requests.length, 2);
});

test('all local validation failures prevent requests and never echo rejected values', async () => {
  const f = await fixture({ respond: () => { throw new Error('must not request'); } });
  for (const [key, value] of [['name', 'x'], ['name', 'x'.repeat(51)], ['email', 'mail@example.test'],
    ['email', ''], ['password', '1234567'], ['question1', ''], ['question2', ''], ['question3', ''],
    ['answer1', ''], ['answer2', ''], ['answer3', ''], ['birthday', '2001-02-29'],
    ['birthday', '2099-01-01'], ['birthday', '1990-1-01'], ['gender', 'unknown']]) {
    const response = await f.plugin.registerAccount({ ...valid(), [key]: value });
    assert.equal(reason(response), 'invalidInput'); assert.equal(response.data.field, key);
    assert.equal(response.data.value, undefined);
  }
  assert.deepEqual(f.requests, []); assert.deepEqual(f.writes, []);
});

test('birthday age boundary and exact gender enum agree with recovered local rules', async () => {
  const f = await fixture(); const now = new Date(2026, 10, 4);
  assert.equal(f.plugin.invalidRegistrationField({ ...valid(), birthday: '2008-11-04' }, now), null);
  assert.equal(f.plugin.invalidRegistrationField({ ...valid(), birthday: '2008-11-05' }, now), 'birthday');
  assert.equal(f.plugin.invalidRegistrationField({ ...valid(), birthday: '2008-02-29' }, now), null);
  for (const gender of ['m', 'f', 'bot']) assert.equal(f.plugin.invalidRegistrationField({ ...valid(), gender }, now), null);
});

test('no generated plugin artifact is written by the registration fixture', () => {
  generatedFiles.forEach((path, index) => assert.deepEqual(readFileSync(path), originalBytes[index]));
});
