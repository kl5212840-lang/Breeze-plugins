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
    const data = respond ? await respond(record, defaults) : defaults(record.url);
    return new Response(JSON.stringify(data), { status: data.code === 401 ? 401 : 200, headers: { 'content-type': 'application/json' } });
  };
  const entry = pathToFileURL(original ? resolve(core, 'index.ts') : resolve(root, 'src/index.ts'));
  entry.searchParams.set('slice', `${original ? 'original' : 'classic'}-${++graph}`);
  const plugin = (await import(entry.href)).default;
  return { plugin, store, requests, writes, runtime,
    set(field, value) { store.set(key('config', field), value); },
    expireCache() { for (const [name, value] of store) if (name.startsWith(`${runtime}|cache|bikaComic:requestCache:`) && value?.expireAt) store.set(name, { ...value, expireAt: 0 }); },
  };
}
function ownSources(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'source' && typeof item === 'string' && /^[0-9a-f-]{36}$/.test(item)) assert.equal(item, ID);
    ownSources(item);
  }
}

test('source metadata has one category home, minimal host declaration and independent identity', async () => {
  const f = await fixture(); const info = plain(await f.plugin.getInfo());
  assert.deepEqual(info.function.map((x) => x.id), ['home']);
  assert.deepEqual(info.breezeExperience.bikaExperience, { version: 1, appearanceKey: 'ui.experienceStyle', loadingArtwork: 'bikaIos2585', gameListFunction: 'getGameListBundle', gameDetailFunction: 'getGameDetailsBundle', officialHelpFunction: 'getOfficialHelpBundle', registration: { version: 1, submitFunction: 'registerAccount' } });
  assert.equal(info.name, '哔咔漫画'); assert.equal(info.uuid, ID); assert.equal(info.version, '0.1.4');
  assert.equal(info.breezeExperience.legacySources, undefined);
  assert.equal(info.function.some((x) => x.id === 'game' || x.id === 'games'), false);
  ownSources(info); assert.deepEqual(f.requests, []); assert.deepEqual(f.writes, []);
});

test('official help is native local content with only the IPA-proven public contacts', async () => {
  const f = await fixture();
  const info = await f.plugin.getInfo();
  globalThis.bridge = { call() { throw new Error('help must not access accounts or configuration'); } };
  const help = await f.plugin[info.breezeExperience.bikaExperience.officialHelpFunction]();
  assert.equal(help.source, ID); assert.equal(help.data.version, 1);
  const links = help.data.sections.flatMap((section) => section.links);
  assert.deepEqual(links.map((link) => [link.kind, link.value]), [
    ['web', 'https://t.me/PicACG'], ['web', 'https://picacomic.com'],
    ['email', 'picapicacomic@gmail.com'],
  ]);
  assert.ok(help.data.sections.some((section) => section.id === 'free' && section.paragraphs.length));
  assert.ok(help.data.sections.every((section) => section.id && section.title && Array.isArray(section.paragraphs)));
  assert.deepEqual(f.requests, []); assert.deepEqual(f.writes, []);
  assert.equal(f.plugin.register, undefined); assert.equal(f.plugin.forgotPassword, undefined);
});

test('BK registration is a dedicated declared native action, without generic register URL or invented recovery', async () => {
  const f = await fixture();
  const login = await f.plugin.getLoginBundle();
  const capabilities = await f.plugin.getCapabilitiesBundle();
  assert.equal(login.data.registerUrl, undefined);
  assert.equal(f.plugin.register, undefined); assert.equal(f.plugin.forgotPassword, undefined);
  assert.equal(typeof f.plugin.registerAccount, 'function');
  assert.deepEqual(plain((await f.plugin.getInfo()).breezeExperience.bikaExperience.registration),
    { version: 1, submitFunction: 'registerAccount' });
  assert.deepEqual(plain(capabilities.scheme.actions), []);
  assert.deepEqual(f.requests, []); assert.deepEqual(f.writes, []);
});

test('source home calls only categories and keywords, keeps real shortcuts and video deduplication', async () => {
  const f = await fixture(); const page = await f.plugin.getHomeData();
  assert.deepEqual(f.requests.map((x) => x.url.pathname).sort(), ['/categories', '/keywords']);
  assert.ok(f.requests.every((x) => x.method === 'GET' && x.body === ''));
  assert.ok(f.requests.every((x) => Object.keys(x.headers).every((k) => !k.startsWith('__'))));
  assert.deepEqual(page.data.categories.map((x) => x.title), ['全彩', '同人']);
  assert.deepEqual(page.data.keywords.map((x) => x.label), ['离线热词']);
  assert.deepEqual(page.data.shortcuts.map((x) => x.label), ['排行榜', '最近更新', '随机本子']);
  const ranking = page.data.shortcuts[0].action.payload.scene;
  assert.equal(ranking.body.request.fnPath, 'getRankingData');
  assert.equal(ranking.body.params.layout, 'bikaRanking');
  assert.equal(page.data.shortcuts[2].action.payload.extern.url, 'https://picaapi.picacomic.com/comics/random');
  assert.deepEqual(page.scheme.body.children.map((x) => x.key), ['notices', 'keywords', 'shortcuts', 'categories']);
  assert.deepEqual(page.data.notices, []); ownSources(page);
});

test('category shielding and shortcut hiding stay within this plugin', async () => {
  const f = await fixture(); f.set('home.blockedCategories', ['全彩', '随机本子']);
  const page = await f.plugin.getHomeData();
  assert.deepEqual(page.data.categories.map((x) => x.title), ['同人']);
  assert.deepEqual(page.data.shortcuts.map((x) => x.label), ['排行榜', '最近更新']);
  assert.equal(f.writes.length, 0);
});

test('one failed area retains successful content and existing-protocol visible retry', async () => {
  const f = await fixture({ respond(record, defaults) {
    return record.url.pathname === '/keywords' ? { code: 400, message: 'fixture failure' } : defaults(record.url);
  } });
  const page = await f.plugin.getHomeData();
  assert.ok(page.data.categories.length); assert.equal(page.data.sectionStates.keywords.state, 'error');
  assert.match(page.data.notices[0].label, /热词.*失败.*重试/);
  assert.equal(page.data.notices[0].action.type, 'openPluginFunction');
  assert.equal(page.data.notices[0].action.payload.id, 'home'); ownSources(page);
});

test('failed refresh preserves only same-context snapshots; changed shielding cannot reuse them', async () => {
  let fail = false;
  const f = await fixture({ respond(record, defaults) { return fail && record.url.pathname === '/categories' ? { code: 400 } : defaults(record.url); } });
  const first = await f.plugin.getHomeData(); fail = true; f.expireCache();
  const stale = await f.plugin.getHomeData();
  assert.equal(stale.data.sectionStates.categories.state, 'stale');
  assert.deepEqual(stale.data.categories, first.data.categories);
  f.set('home.blockedCategories', ['全彩']);
  const changed = await f.plugin.getHomeData();
  assert.equal(changed.data.sectionStates.categories.state, 'error');
  assert.deepEqual(changed.data.categories, []);
});

test('concurrent home reads coalesce requests; known auth refusal does not await the other area', async () => {
  const pending = deferred(); let entered = deferred();
  const f = await fixture({ async respond(record, defaults) {
    if (record.url.pathname === '/keywords') { entered.resolve(); await pending.promise; }
    if (record.url.pathname === '/categories') return { code: 401, message: 'fixture unauthorized' };
    return defaults(record.url);
  } });
  const first = f.plugin.getHomeData(), second = f.plugin.getHomeData();
  await entered.promise;
  await assert.rejects(first, /unauthorized/); await assert.rejects(second, /unauthorized/);
  pending.resolve(); await new Promise(setImmediate);
  assert.equal(f.requests.filter((x) => x.url.pathname === '/categories').length, 1);
  assert.equal(f.requests.filter((x) => x.url.pathname === '/keywords').length, 1);
});

test('style schema only allows original/follow and reads defaults without writing or network', async () => {
  const f = await fixture();
  for (const [stored, expected] of [[undefined, 'original'], ['follow', 'follow'], ['system', 'original'], ['breeze', 'original'], [{ bad: true }, 'original']]) {
    if (stored !== undefined) f.set('ui.experienceStyle', stored);
    const bundle = await f.plugin.getSettingsBundle();
    const fields = bundle.scheme.sections.flatMap((s) => s.fields);
    const field = fields.find((x) => x.key === 'ui.experienceStyle');
    assert.equal(field.kind, 'select'); assert.equal(field.fnPath, undefined);
    assert.deepEqual(field.options.map((x) => x.value), ['original', 'follow']);
    assert.equal(bundle.data.values['ui.experienceStyle'], expected);
    assert.ok(fields.some((x) => x.key === 'account.slogan')); ownSources(bundle);
  }
  assert.deepEqual(f.writes, []); assert.deepEqual(f.requests, []);
});

test('sibling core remains unchanged and logout keeps style while clearing only own account', async () => {
  const f = await fixture(); f.set('ui.experienceStyle', 'follow'); f.set('auth.authorization', 'fixture');
  f.store.set(`${OLD}|config|ui.experienceStyle`, 'old-value');
  await f.plugin.clearPluginSession();
  assert.equal(f.store.get(`${ID}|config|ui.experienceStyle`), 'follow');
  assert.equal(f.store.get(`${OLD}|config|ui.experienceStyle`), 'old-value');
  assert.ok(f.writes.every((x) => x.startsWith(`${ID}|`)));
  const sibling = await fixture({ original: true }); const bundle = await sibling.plugin.getSettingsBundle();
  assert.equal(bundle.source, OLD);
  assert.ok(!bundle.scheme.sections.flatMap((x) => x.fields).some((x) => x.key === 'ui.experienceStyle'));
});

test('verified empty arrays stay empty, while missing business data is an error with visible retry', async () => {
  const empty = await fixture({ respond() { return { code: 200, data: { categories: [], keywords: [] } }; } });
  const page = await empty.plugin.getHomeData();
  assert.equal(page.data.sectionStates.categories.state, 'empty');
  assert.equal(page.data.sectionStates.keywords.state, 'empty');
  assert.deepEqual(page.data.categories, []); assert.deepEqual(page.data.keywords, []);
  assert.ok(page.data.notices.every((x) => !x.label.includes('失败')));
  const malformed = await fixture({ respond() { return { code: 200, data: {} }; } });
  const broken = await malformed.plugin.getHomeData();
  assert.equal(broken.data.sectionStates.categories.state, 'error');
  assert.equal(broken.data.sectionStates.keywords.state, 'error');
  assert.equal(broken.data.notices.length, 2);
  assert.ok(broken.data.notices.every((x) => x.label.includes('失败')));
  ownSources(broken);
});

test('healthy category and keyword cache remains valid; no additional preview or retry requests', async () => {
  const f = await fixture();
  const first = await f.plugin.getHomeData();
  const second = await f.plugin.getHomeData();
  assert.deepEqual(second.data.categories, first.data.categories);
  assert.equal(f.requests.length, 2);
  const cache = [...f.store].filter(([key]) => key.startsWith(`${ID}|cache|bikaComic:requestCache:`));
  assert.equal(cache.length, 2);
  assert.ok(cache.every(([, value]) => value && value.expireAt > Date.now()));
});

test('invalid captured cache key is cleared once and explicit retry can recover without evicting healthy peer', async () => {
  let fail = true;
  const f = await fixture({ respond(record, defaults) {
    return fail && record.url.pathname === '/categories' ? { code: 400 } : defaults(record.url);
  } });
  const first = await f.plugin.getHomeData();
  assert.equal(first.data.sectionStates.categories.state, 'error');
  assert.equal(first.data.sectionStates.keywords.state, 'fresh');
  assert.equal(f.requests.length, 2);
  fail = false;
  const recovered = await f.plugin.getHomeData();
  assert.equal(recovered.data.sectionStates.categories.state, 'fresh');
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests.filter((x) => x.url.pathname === '/keywords').length, 1);
});

test('CAS cannot erase a concurrent healthy category cache write', async () => {
  let replacement;
  const f = await fixture({
    respond(record, defaults) { return record.url.pathname === '/categories' ? { code: 400 } : defaults(record.url); },
    beforeCacheCompare(key, expected, next, store) {
      replacement = { ...expected, data: { code: 200, data: { categories: [{ title: '并发健康分类', thumb: {} }] } } };
      store.set(key, replacement);
    },
  });
  await f.plugin.getHomeData();
  const next = await f.plugin.getHomeData();
  assert.deepEqual(next.data.categories.map((x) => x.title), ['并发健康分类']);
  assert.equal(f.requests.length, 2);
  assert.ok([...f.store.values()].some((x) => x === replacement));
});

test('late response after account changes cannot publish prior-account categories', async () => {
  const pending = deferred(), entered = deferred();
  const f = await fixture({ async respond(record, defaults) {
    if (record.url.pathname === '/categories') { entered.resolve(); await pending.promise; }
    return defaults(record.url);
  } });
  f.set('auth.authorization', 'first-fixture-account');
  const page = f.plugin.getHomeData(); await entered.promise;
  f.set('auth.authorization', 'next-fixture-account'); pending.resolve();
  await assert.rejects(page, /浏览条件已变化|账号已变化/);
  const next = await f.plugin.getHomeData();
  assert.equal(next.data.sectionStates.categories.state, 'fresh'); ownSources(next);
  assert.equal(f.requests.filter((x) => x.url.pathname === '/categories').length, 2);
});

test('style readback survives a new runtime without copying sibling state or writing defaults', async () => {
  const store = new Map([[`${ID}|config|ui.experienceStyle`, 'follow'], [`${OLD}|config|ui.experienceStyle`, 'original']]);
  const first = await fixture({ store }); const initial = await first.plugin.getSettingsBundle();
  const reopened = await fixture({ store }); const restored = await reopened.plugin.getSettingsBundle();
  assert.equal(initial.data.values['ui.experienceStyle'], 'follow');
  assert.equal(restored.data.values['ui.experienceStyle'], 'follow');
  assert.deepEqual(first.writes, []); assert.deepEqual(reopened.writes, []);
});

// Synthetic values inside the exact envelope/field paths recovered from the
// selected iOS 2.5.85 PicaGame methods. These are not real logged-in API captures.
const gameDoc = () => ({ _id: 'game-fixture', title: '离线游戏样本', icon: { fileServer: 'https://image.example.test', path: 'cover.jpg' }, publisher: '样本发布者', version: 'fixture-v1', adult: true, android: true, ios: false });

test('game reads require this installation session before issuing any request', async () => {
  const f = await fixture();
  await assert.rejects(f.plugin.getGameListBundle(), /unauthorized/);
  assert.deepEqual(f.requests, []); assert.deepEqual(f.writes, []);
});

test('game list and detail use recovered GET paths, real pagination and source-owned envelopes', async () => {
  const f = await fixture({ respond: (r) => {
    if (r.url.pathname === '/games') return { code: 200, data: { games: { docs: [gameDoc()], page: 2, pages: 3 } } };
    assert.equal(r.url.pathname, '/games/game-fixture');
    return { code: 200, data: { game: { ...gameDoc(), description: '离线详情' } } };
  } });
  f.set('auth.authorization', 'fixture-game-session');
  const list = await f.plugin.getGameListBundle({ page: 2 });
  assert.equal(list.source, ID); assert.equal(list.data.page, 2); assert.equal(list.data.pages, 3); assert.equal(list.data.hasMore, true);
  assert.deepEqual(plain(list.data.items[0]), { id: 'game-fixture', title: '离线游戏样本', cover: { url: 'https://image.example.test/static/cover.jpg', path: 'cover.jpg' }, publisher: '样本发布者', version: 'fixture-v1', adult: true, android: true, ios: false });
  const detail = await f.plugin.getGameDetailsBundle({ id: list.data.items[0].id });
  assert.equal(detail.source, ID); assert.equal(detail.data.game.description, '离线详情');
  assert.deepEqual(f.requests.map((r) => [r.method, r.url.pathname + r.url.search, r.body]), [['GET', '/games?page=2', ''], ['GET', '/games/game-fixture', '']]);
  assert.ok(f.requests.every((r) => r.headers.authorization === 'fixture-game-session'));
  assert.deepEqual(f.writes, []);
});

test('game empty end page is distinct from malformed or mismatched data; missing flags remain unknown', async () => {
  const f = await fixture({ respond: (r) => ({ code: 200, data: { games: { docs: [], page: 1, pages: 0 } } }) });
  f.set('auth.authorization', 'fixture-game-session');
  assert.deepEqual(plain((await f.plugin.getGameListBundle()).data), { items: [], page: 1, pages: 0, hasMore: false });
  for (const games of [{ page: 1, pages: 1 }, { docs: [{}], page: 1, pages: 1 }, { docs: [gameDoc()], page: 2, pages: 2 }, { docs: [], page: 1 }]) {
    const invalid = await fixture({ respond: () => ({ code: 200, data: { games } }) });
    invalid.set('auth.authorization', 'fixture-game-session');
    await assert.rejects(invalid.plugin.getGameListBundle(), /游戏列表资料不完整/);
    assert.equal(invalid.requests.length, 1);
  }
  const missing = await fixture({ respond: () => ({ code: 200, data: { games: { docs: [{ _id: 'id', title: '标题' }], page: 1, pages: 1 } } }) });
  missing.set('auth.authorization', 'fixture-game-session');
  const item = (await missing.plugin.getGameListBundle()).data.items[0];
  assert.equal(item.adult, null); assert.equal(item.ios, null); assert.equal(item.android, null);
  assert.deepEqual(plain(item.cover), { url: '', path: '' });
});

test('game authentication refusal and changed-account late responses never publish successful content', async () => {
  const denied = await fixture({ respond: () => ({ code: 401, error: '1005', message: 'unauthorized' }) });
  denied.set('auth.authorization', 'fixture-game-session');
  await assert.rejects(denied.plugin.getGameListBundle(), /unauthorized/);
  assert.equal(denied.requests.length, 1); assert.deepEqual(denied.writes, []);
  const started = deferred(), result = deferred();
  const late = await fixture({ respond: async () => { started.resolve(); return result.promise; } });
  late.set('auth.authorization', 'old-fixture-game-session');
  const read = late.plugin.getGameListBundle();
  await started.promise;
  late.set('auth.authorization', 'new-fixture-game-session');
  result.resolve({ code: 200, data: { games: { docs: [gameDoc()], page: 1, pages: 1 } } });
  await assert.rejects(read, /账号或线路已变化/);
  assert.deepEqual(late.writes, []);
});

test('game invalid requests and mismatched detail identity do not become empty success', async () => {
  const f = await fixture({ respond: () => ({ code: 200, data: { game: gameDoc() } }) });
  f.set('auth.authorization', 'fixture-game-session');
  for (const page of [0, -1, 1.5, '1', Number.NaN]) await assert.rejects(f.plugin.getGameListBundle({ page }), /页码无效/);
  assert.equal(f.requests.length, 0);
  await assert.rejects(f.plugin.getGameDetailsBundle({ id: 'different-fixture' }), /游戏详情暂时无法读取/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.plugin.register, undefined);
  assert.equal(f.plugin.forgotPassword, undefined);
});

test('profile favorites declaration reads account favorite items rather than only a scene', async () => {
  const f = await fixture({ respond: (r) => {
    assert.equal(r.method, 'GET'); assert.equal(r.url.pathname + r.url.search, '/users/favourite?s=dd&page=1');
    return { code: 200, data: { comics: { docs: [{ _id: 'favorite-fixture', title: '账号收藏样本', thumb: {} }], page: 1, pages: 1, total: 1 } } };
  } });
  f.set('auth.authorization', 'fixture-account-session');
  const info = await f.plugin.getInfo();
  const result = await f.plugin[info.breezeExperience.profileCloudFavoriteFunction]({ page: 1 });
  assert.equal(result.source, ID);
  assert.equal(result.data.items.length, 1);
  assert.equal(result.data.items[0].id, 'favorite-fixture');
  assert.equal(f.requests.length, 1); assert.deepEqual(f.writes, []);
});

test('profile favorites missing data is a retryable failure; real empty stays empty and anonymous reads stop locally', async () => {
  const blank = await fixture({ respond: () => ({ code: 200, data: { comics: { docs: [], page: 1, pages: 0, total: 0 } } }) });
  const fn = (await blank.plugin.getInfo()).breezeExperience.profileCloudFavoriteFunction;
  await assert.rejects(blank.plugin[fn](), /unauthorized/);
  assert.equal(blank.requests.length, 0);
  blank.set('auth.authorization', 'fixture-account-session');
  assert.equal((await blank.plugin[fn]()).data.items.length, 0);
  const broken = await fixture({ respond: () => ({ code: 200, data: {} }) });
  broken.set('auth.authorization', 'fixture-account-session');
  await assert.rejects(broken.plugin[fn](), /收藏资料不完整/);
  for (const total of [3, '3']) {
    const contradictory = await fixture({ respond: () => ({ code: 200, data: { comics: { docs: [], page: 1, pages: 1, total } } }) });
    contradictory.set('auth.authorization', 'fixture-account-session');
    await assert.rejects(contradictory.plugin[fn](), /收藏资料不完整/);
  }
});

test('game covers reuse the mature image URL mapper for known storage hosts', async () => {
  const f = await fixture({ respond: () => ({ code: 200, data: { game: {
    ...gameDoc(), icon: { fileServer: 'https://storage1.picacomic.com', path: 'games/fixture.jpg' },
  } } }) });
  f.set('auth.authorization', 'fixture-game-session');
  const detail = await f.plugin.getGameDetailsBundle({ id: 'game-fixture' });
  assert.deepEqual(plain(detail.data.game.cover), { url: 'https://img.picacomic.com/games/fixture.jpg', path: 'games/fixture.jpg' });
  assert.equal(f.requests.length, 1);
});

test('profile favorite late replies remain tied to the account that made the GET', async () => {
  const started = deferred(), response = deferred();
  const f = await fixture({ respond: async () => { started.resolve(); return response.promise; } });
  f.set('auth.authorization', 'old-fixture-account');
  const result = f.plugin.getProfileCloudFavoriteBundle();
  await started.promise; f.set('auth.authorization', 'changed-fixture-account');
  response.resolve({ code: 200, data: { comics: { docs: [], page: 1, pages: 0 } } });
  await assert.rejects(result, /账号已变化/);
  assert.deepEqual(f.writes, []);
});

test('BK full favorites use strict paging and the same proven sort path without changing the shared core', async () => {
  const f = await fixture({ respond: (r) => {
    assert.equal(r.method, 'GET'); assert.equal(r.url.pathname + r.url.search, '/users/favourite?s=da&page=2');
    return { code: 200, data: { comics: { docs: [{ _id: 'full-favorite', title: '完整收藏样本', thumb: {} }], page: 2, pages: 3, total: 9 } } };
  } });
  f.set('auth.authorization', 'fixture-account-session');
  const full = await f.plugin.getFavoriteData({ page: 2, extern: { sort: 'da' } });
  assert.equal(full.source, ID); assert.equal(full.data.items[0].id, 'full-favorite');
  assert.deepEqual(plain(full.data.paging), { page: 2, pages: 3, hasReachedMax: false, total: 9 });
  assert.deepEqual(plain(full.items), plain(full.data.items)); assert.equal(f.requests.length, 1);
  const scene = await f.plugin.getCloudFavoriteSceneBundle();
  assert.equal(scene.data.scene.body.request.fnPath, 'getFavoriteData');
  for (const data of [{}, { comics: {} }, { comics: { docs: [], page: 1, pages: 1, total: 3 } }, { comics: { docs: [], page: 1 } }]) {
    const bad = await fixture({ respond: () => ({ code: 200, data }) });
    bad.set('auth.authorization', 'fixture-account-session');
    await assert.rejects(bad.plugin.getFavoriteData({ page: 1 }), /收藏资料不完整/);
  }
  const end = await fixture({ respond: () => ({ code: 200, data: { comics: { docs: [], page: 2, pages: 1, total: 3 } } }) });
  end.set('auth.authorization', 'fixture-account-session');
  assert.equal((await end.plugin.getFavoriteData({ page: 2 })).data.paging.hasReachedMax, true);
  const original = await fixture({ original: true, respond: () => ({ code: 200, data: {} }) });
  assert.deepEqual(plain((await original.plugin.getFavoriteData()).data.items), []);
});

test('game download destinations come only from the proven platform arrays and remain web links', async () => {
  const f = await fixture({ respond: () => ({ code: 200, data: { game: {
    ...gameDoc(), iosLinks: ['https://download.example.test/ios', 'javascript:fixture', 'https://user:pass@example.test/private'],
    androidLinks: ['https://download.example.test/android', 'https://download.example.test/android'],
    downloadUrl: 'https://unproven.example.test/',
  } } }) });
  f.set('auth.authorization', 'fixture-game-session');
  const result = await f.plugin.getGameDetailsBundle({ id: 'game-fixture' });
  assert.deepEqual(plain(result.data.game.downloadLinks), [
    { platform: 'ios', url: 'https://download.example.test/ios' },
    { platform: 'android', url: 'https://download.example.test/android' },
  ]);
  assert.equal(f.requests.length, 1); assert.deepEqual(f.writes, []);
});

test('source server and channel settings affect the next real transport configuration', async () => {
  const f = await fixture({ respond: () => ({ code: 200, data: { games: { docs: [], page: 1, pages: 0 } } }) });
  f.set('auth.authorization', 'fixture-game-session');
  await f.plugin.saveSettings({ values: { 'network.apiBase': 'https://picaapi.go2778.com/', 'network.proxy': '2' } });
  const settings = await f.plugin.getSettingsBundle();
  assert.equal(settings.data.values['network.apiBase'], 'https://picaapi.go2778.com/');
  assert.equal(settings.data.values['network.proxy'], '2');
  await f.plugin.getGameListBundle();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url.origin, 'https://picaapi.go2778.com');
  assert.equal(f.requests[0].headers['app-channel'], '2');
  assert.ok(f.writes.every((key) => key.startsWith(`${ID}|`)));
});

test('source module checks do not write manifest or CJS bytes', () => {
  generatedFiles.forEach((path, i) => assert.deepEqual(readFileSync(path), originalBytes[i]));
});
