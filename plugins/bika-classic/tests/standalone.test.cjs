const assert = require("node:assert/strict");
const { test } = require("node:test");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

const ID = "97b8ebb1-9f1f-423c-9847-acd7b0ccd31f";
const OLD = "e9f18928-3ba8-4d86-a12e-b53a62f47933";
const bundle = readFileSync(
  resolve(__dirname, "../dist/breeze-plugin-bika-classic.bundle.cjs"),
  "utf8",
);
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function expireFixtureRequestCache(f) {
  // Simulate expiry only in the synthetic bridge, without changing production
  // TTLs or disabling a healthy ranking cache to manufacture network failures.
  for (const [key, value] of f.store) {
    if (
      key.startsWith(`${ID}|cache|bikaComic:requestCache:`) &&
      value &&
      typeof value.expireAt === "number"
    )
      f.store.set(key, { ...value, expireAt: 0 });
  }
}

// Synthetic, runtime-scoped bridge matching the host's config/cache boundary.
// No installed app, actual account, network socket or user store is accessed.
function fixture({
  store = new Map(),
  runtime = ID,
  respond,
  code = bundle,
  beforeCacheCompare,
} = {}) {
  const requests = [],
    writes = [],
    timers = [];
  const scoped = (kind, key) => `${runtime}|${kind}|${key}`;
  const get = (kind, key, fallback) =>
    store.has(scoped(kind, key)) ? store.get(scoped(kind, key)) : fallback;
  const row = (number) => ({
    _id: `comic-${number}`,
    title: `Comic ${number}`,
    author: "Fixture",
    categories: ["全彩"],
    thumb: { fileServer: "https://img.picacomic.com", path: `cover-${number}.jpg` },
  });
  const defaults = (url) => {
    if (url.pathname === "/auth/sign-in")
      return { code: 200, data: { token: "new-fixture-token" } };
    if (url.pathname === "/users/profile")
      return {
        code: 200,
        data: { user: { _id: "fixture-user", name: "Fixture", isPunched: false } },
      };
    if (url.pathname === "/comics/advanced-search")
      return {
        code: 200,
        data: {
          comics: {
            docs: Array.from({ length: 18 }, (_, i) => row(i)),
            page: 1,
            pages: 3,
            total: 50,
          },
        },
      };
    if (url.pathname === "/comics/leaderboard")
      return { code: 200, data: { comics: Array.from({ length: 18 }, (_, i) => row(i + 100)) } };
    if (url.pathname === "/categories")
      return {
        code: 200,
        data: {
          categories: [
            { title: "全彩", thumb: {} },
            { title: "小電影", isWeb: true, link: "https://adult-movie.bidobido.xyz/", thumb: {} },
          ],
        },
      };
    if (url.pathname === "/keywords") return { code: 200, data: { keywords: ["Fixture"] } };
    if (url.pathname === "/comics/fixture-comic")
      return { code: 200, data: { comic: { ...row(1), _id: "fixture-comic", epsCount: 1 } } };
    if (url.pathname === "/comics/fixture-comic/eps")
      return {
        code: 200,
        data: { eps: { page: 1, pages: 1, docs: [{ _id: "ep-1", title: "Chapter 1", order: 1 }] } },
      };
    if (url.pathname === "/comics/fixture-comic/recommendation")
      return { code: 200, data: { comics: [row(2)] } };
    if (url.pathname === "/comics/fixture-comic/order/1/pages")
      return {
        code: 200,
        data: {
          ep: { _id: "ep-1", title: "Chapter 1" },
          pages: {
            pages: 1,
            docs: [
              {
                id: "page-1",
                media: { fileServer: "https://img.picacomic.com", path: "page-1.jpg" },
              },
            ],
          },
        },
      };
    if (
      url.pathname === "/comics/fixture-comic/comments" ||
      url.pathname === "/comments/comment-1/childrens"
    )
      return {
        code: 200,
        data: {
          comments: {
            page: 1,
            pages: 1,
            docs: [{ _id: "comment-1", content: "Fixture", _user: { name: "Fixture" } }],
          },
        },
      };
    if (url.pathname === "/users/favourite")
      return { code: 200, data: { comics: { docs: [row(900)], page: 1, pages: 1, total: 1 } } };
    if (url.pathname === "/api/list")
      return {
        code: 0,
        list: [{ hid: "fixture-video", name: "Video", pic_b: "https://image.example/cover.jpg" }],
        productTotal: 1,
        pageTotal: 1,
      };
    if (url.pathname === "/api/getVideoUrl")
      return { code: 0, url_hls: "https://media.example/video.m3u8" };
    throw new Error(`Unmocked fixture URL ${url.origin}${url.pathname}`);
  };
  const context = vm.createContext({
    module: { exports: {} },
    exports: {},
    URL,
    URLSearchParams,
    Request,
    Response,
    Headers,
    FormData,
    Blob,
    AbortController,
    TextEncoder,
    TextDecoder,
    structuredClone,
    nodeCryptoCompat: crypto,
    uuidv4: crypto.randomUUID,
    console: { info() {}, warn() {}, error() {}, log() {} },
    setTimeout(fn, delay) {
      timers.push(delay);
      return setTimeout(fn, delay);
    },
    clearTimeout,
    async fetch(input, init) {
      const request = input instanceof Request ? input : new Request(input, init);
      const record = {
        url: new URL(request.url),
        headers: Object.fromEntries(request.headers),
        method: request.method,
        body: await request.text(),
      };
      requests.push(record);
      const result = respond ? await respond(record, defaults) : defaults(record.url);
      return new Response(JSON.stringify(result), {
        status: result.code === 401 ? 401 : 200,
        headers: { "content-type": "application/json" },
      });
    },
    bridge: {
      async call(name, ...args) {
        const key = String(args[0]);
        if (name === "load_plugin_config")
          return { ok: true, value: get("config", key, JSON.parse(String(args[1]))) };
        if (name === "save_plugin_config") {
          writes.push(scoped("config", key));
          store.set(scoped("config", key), JSON.parse(String(args[1])));
          return { ok: true };
        }
        if (name === "cache.get") return get("cache", key, args[1]);
        if (name === "cache.set") {
          store.set(scoped("cache", key), args[1]);
          return;
        }
        if (name === "cache.delete") {
          store.delete(scoped("cache", key));
          return;
        }
        if (name === "cache.compare_and_set") {
          await beforeCacheCompare?.(scoped("cache", key), args[1], args[2], store);
          if (JSON.stringify(store.get(scoped("cache", key))) !== JSON.stringify(args[1]))
            return false;
          store.set(scoped("cache", key), args[2]);
          return true;
        }
        if (name === "dart.getAppVersion") return "3.0.37";
        throw new Error(`Unmocked bridge operation ${name}`);
      },
    },
  });
  vm.runInContext(code, context, { filename: "standalone-bika-fixture.cjs" });
  return { plugin: context.module.exports.default, store, requests, writes, timers };
}

function assertOwnSources(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "source" && typeof child === "string" && /^[0-9a-f-]{36}$/.test(child))
      assert.equal(child, ID);
    assertOwnSources(child);
  }
}

test("actual bundle and manifest use only their own identity; no automatic record import or old update channel", async () => {
  const { plugin } = fixture();
  const info = plain(await plugin.getInfo());
  assert.deepEqual(info, JSON.parse(readFileSync(resolve(__dirname, "../manifest.json"))));
  assert.equal(info.uuid, ID);
  assert.equal(info.name, "哔咔漫画");
  assert.equal(info.version, "0.1.0");
  assert.doesNotMatch(JSON.stringify(info), /原版体验/);
  assert.equal(info.breezeExperience.legacySources, undefined);
  assert.equal(info.breezeExperience.profileKind, "bika");
  assert.equal(info.breezeExperience.videoBrowseOnly, true);
  assert.equal(info.breezeExperience.profileVideoRecords, true);
  assert.equal(info.breezeExperience.communityAdaptation.localRecords, "standalone");
  assert.equal(info.breezeExperience.communityAdaptation.recordImport, "unavailable");
  assert.equal(info.breezeExperience.communityAdaptation.officialRelease, false);
  assert.equal(info.updateUrl, "https://raw.githubusercontent.com/kl5212840-lang/Breeze-plugins/main/updates/v1/bika-classic.json");
  assert.deepEqual(
    info.function.map((item) => item.id),
    ["home"],
  );
  assertOwnSources(info);
  assert.ok(!bundle.includes(OLD));
  assert.ok(!bundle.includes("0a0e5858-a467-4702-994a-79e608a4589d"));
});

test("cold init neither reads another installation nor starts login/checkin/retry work", async () => {
  const store = new Map([
    [`${OLD}|config|auth.account`, "old@example.test"],
    [`${OLD}|config|auth.password`, "old-fixture-password"],
    [`${OLD}|config|auth.authorization`, "old-fixture-token"],
    [`${OLD}|config|network.apiBase`, "https://picaapi.go2778.com/"],
  ]);
  const before = plain([...store]);
  const f = fixture({ store });
  const result = await f.plugin.init();
  assert.equal(result.source, ID);
  assert.equal(result.data.apiBase, "https://picaapi.picacomic.com/");
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.timers, []);
  assert.deepEqual(plain([...store].filter(([key]) => key.startsWith(OLD))), before);
  const login = await f.plugin.getLoginBundle();
  assert.equal(login.source, ID);
  assert.ok(!JSON.stringify(login).includes("old-fixture"));
});

test("both compiled plugins coexist with distinct metadata and video callback identities", async () => {
  const originalCode = readFileSync(
    resolve(__dirname, "../../bika/dist/breeze-plugin-bika-comic.bundle.cjs"),
    "utf8",
  );
  const original = fixture({ runtime: OLD, code: originalCode }).plugin;
  const standalone = fixture().plugin;
  assert.equal((await original.getInfo()).uuid, OLD);
  assert.equal((await original.getInfo()).name, "哔咔漫画+");
  assert.equal((await standalone.getInfo()).uuid, ID);
  const args = {
    home: "https://adult-movie.bidobido.xyz/",
    id: "movie:fixture-video",
    snapshot: {
      id: "movie:fixture-video",
      title: "Fixture",
      detailUrl: "https://adult-movie.bidobido.xyz/videos/fixture-video",
    },
  };
  assert.equal((await original.getBikaVideoDetail(args)).source, OLD);
  assert.equal((await standalone.getBikaVideoDetail(args)).source, ID);
});

test("login, config save and logout write only this installation and do not change its sibling", async () => {
  const store = new Map([[`${OLD}|config|auth.authorization`, "old-fixture-token"]]);
  const f = fixture({ store });
  const login = await f.plugin.loginWithPassword({
    account: "new@example.test",
    password: "new-fixture-password",
  });
  assert.equal(login.source, ID);
  assert.equal(store.get(`${ID}|config|auth.authorization`), "new-fixture-token");
  assert.equal(store.get(`${OLD}|config|auth.authorization`), "old-fixture-token");
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url.origin, "https://picaapi.picacomic.com");
  assert.equal(f.requests[0].headers.authorization, undefined);
  assert.equal((await f.plugin.getSettingsBundle()).source, ID);
  assert.equal((await f.plugin.getUserInfoBundle()).source, ID);
  assert.equal((await f.plugin.getCheckinStatus()).source, ID);
  assert.equal((await f.plugin.getCloudFavoriteSceneBundle()).source, ID);
  assert.equal((await f.plugin.getFavoriteData()).source, ID);
  assert.equal((await f.plugin.clearPluginSession()).source, ID);
  assert.equal(store.get(`${ID}|config|auth.authorization`), "");
  assert.equal(store.get(`${OLD}|config|auth.authorization`), "old-fixture-token");
  assert.ok(f.writes.every((key) => key.startsWith(`${ID}|`)));
});

test("runtime reconstruction retains only its own config and session logout leaves its own display preferences intact", async () => {
  const store = new Map([[`${OLD}|config|auth.account`, "old@example.test"]]);
  const first = fixture({ store });
  await first.plugin.loginWithPassword({
    account: "new@example.test",
    password: "fixture-password",
  });
  await first.plugin.saveSettings({
    values: { "network.proxy": "2", "network.apiBase": "https://picaapi.go2778.com/" },
  });
  const second = fixture({ store });
  assert.equal((await second.plugin.init()).data.apiBase, "https://picaapi.go2778.com/");
  const login = await second.plugin.getLoginBundle();
  assert.ok(JSON.stringify(login).includes("new@example.test"));
  assert.ok(!JSON.stringify(login).includes("old@example.test"));
  assert.equal(second.requests.length, 0);
  assert.equal(second.timers.length, 0);
  await second.plugin.clearPluginSession();
  assert.equal(store.get(`${ID}|config|network.proxy`), "2");
  assert.equal(store.get(`${ID}|config|network.apiBase`), "https://picaapi.go2778.com/");
  assert.equal(store.get(`${OLD}|config|auth.account`), "old@example.test");
});

test("public video catalog/detail/playback and metadata callbacks carry the standalone source without comic authorization", async () => {
  const f = fixture({
    store: new Map([[`${ID}|config|auth.authorization`, "private-fixture-token"]]),
  });
  const home = "https://adult-movie.bidobido.xyz/";
  const catalog = await f.plugin.getBikaVideoCatalog({ home });
  const snapshot = catalog.data.items[0];
  const detail = await f.plugin.getBikaVideoDetail({ home, id: snapshot.id, snapshot });
  const playback = await f.plugin.getBikaVideoPlayback({ home, id: snapshot.id, snapshot });
  for (const result of [catalog, detail, playback]) {
    assert.equal(result.source, ID);
    assertOwnSources(result);
  }
  for (const request of f.requests) assert.equal(request.headers.authorization, undefined);
});

test("detail, recommendations, reading pages and comment feeds retain standalone identity through every nested action", async () => {
  const f = fixture();
  const detail = await f.plugin.getComicDetail({ comicId: "fixture-comic" });
  const read = await f.plugin.getReadSnapshot({ comicId: "fixture-comic", chapterId: "ep-1" });
  const comments = await f.plugin.getCommentFeed({ comicId: "fixture-comic" });
  const replies = await f.plugin.loadCommentReplies({ commentId: "comment-1" });
  for (const result of [detail, read, comments, replies]) {
    assert.equal(result.source, ID);
    assertOwnSources(result);
  }
  assert.equal(read.data.comic.source, ID);
  assert.equal(read.data.chapter.pages.length, 1);
  assert.equal(read.data.chapter.pages[0].id, "page-1");
  assert.equal(comments.data.items[0].content, "Fixture");
});


test('built category home and hot words reach actual search and ranking callbacks without preview requests', async () => {
  const f = fixture();
  const page = await f.plugin.getHomeData();
  assert.deepEqual(f.requests.map(x => x.url.pathname).sort(), ['/categories', '/keywords']);
  assert.deepEqual(plain(page.data.categories.map(x => x.title)), ['全彩']);
  assert.deepEqual(plain(page.data.keywords.map(x => x.label)), ['Fixture']);
  assert.deepEqual(plain(page.data.shortcuts.map(x => x.label)), ['排行榜', '最近更新', '随机本子']);
  assert.deepEqual(plain(page.scheme.body.children.map(x => x.key)), ['notices', 'keywords', 'shortcuts', 'categories']);
  for (const item of [page.data.categories[0], page.data.keywords[0], page.data.shortcuts[1]]) {
    assert.equal(item.action.type, 'openSearch');
    const result = await f.plugin.searchComic({ ...item.action.payload, page: 1 });
    assert.equal(result.source, ID); assert.equal(result.items.length, 18); assertOwnSources(result);
  }
  const categorySearch = f.requests.find(x => x.url.pathname === '/comics/advanced-search');
  assert.deepEqual(JSON.parse(categorySearch.body).categories, ['全彩']);
  const scene = page.data.shortcuts[0].action.payload.scene;
  assert.equal(scene.body.params.layout, 'bikaRanking');
  assert.equal(scene.body.request.fnPath, 'getRankingData');
  const ranking = await f.plugin.getRankingData(scene.body.request.core);
  assert.equal(ranking.data.items.length, 18); assertOwnSources(ranking);
  assertOwnSources(page);
});

test('built home keeps successful peer on business failure; explicit retry restores only invalid cached area', async () => {
  let failing = true;
  const f = fixture({ respond(request, defaults) {
    return failing && request.url.pathname === '/keywords' ? { code: 400, data: {} } : defaults(request.url);
  } });
  const failed = await f.plugin.getHomeData();
  assert.equal(failed.data.sectionStates.categories.state, 'fresh');
  assert.equal(failed.data.sectionStates.keywords.state, 'error');
  assert.equal(failed.data.categories.length, 1); assert.match(failed.data.notices[0].label, /热词.*失败.*重试/);
  failing = false;
  const recovered = await f.plugin.getFunctionPage(failed.data.notices[0].action.payload);
  assert.equal(recovered.data.sectionStates.keywords.state, 'fresh');
  assert.deepEqual(plain(recovered.data.notices), []);
  assert.equal(f.requests.filter(x => x.url.pathname === '/categories').length, 1);
  assert.equal(f.requests.filter(x => x.url.pathname === '/keywords').length, 2);
  assert.deepEqual(f.writes, []); assertOwnSources(recovered);
});

test('built same-context failed update retains content and does not fabricate fresh or zero data', async () => {
  let failing = false;
  const f = fixture({ respond(request, defaults) {
    return failing ? { code: 500, data: {} } : defaults(request.url);
  } });
  const first = await f.plugin.getHomeData();
  failing = true; expireFixtureRequestCache(f);
  const stale = await f.plugin.getHomeData();
  assert.deepEqual(plain(stale.data.categories), plain(first.data.categories));
  assert.equal(stale.data.sectionStates.categories.state, 'stale');
  assert.equal(stale.data.sectionStates.keywords.state, 'stale');
  assert.ok(stale.data.notices.every(x => /更新失败/.test(x.label)));
  f.store.set(`${ID}|config|auth.authorization`, 'another-fixture-account');
  const changed = await f.plugin.getHomeData();
  assert.deepEqual(plain(changed.data.categories), []);
  assert.equal(changed.data.sectionStates.categories.state, 'error');
});

test('built healthy category cache stays ten minutes and explicit refresh adds no preview work', async () => {
  const f = fixture(); await f.plugin.getHomeData(); await f.plugin.getHomeData();
  assert.equal(f.requests.length, 2);
  const cache = [...f.store].filter(([k]) => k.startsWith(`${ID}|cache|bikaComic:requestCache:`));
  assert.equal(cache.length, 2);
  assert.ok(cache.every(([, v]) => v.expireAt - Date.now() > 590000 && v.expireAt - Date.now() <= 600000));
  for (const r of f.requests) assert.doesNotMatch(r.url.href + r.body + JSON.stringify(r.headers), /__cacheKey|__bikaChannel|__useCache|__bikaAuthorization|__bikaAssertAuthorization/);
});

test('built original/follow schema is source-owned, has no network or default writes and survives logout/runtime reopen', async () => {
  const store = new Map([[`${OLD}|config|ui.experienceStyle`, 'old-value']]);
  const f = fixture({ store });
  const first = await f.plugin.getSettingsBundle();
  const field = first.scheme.sections.flatMap(x => x.fields).find(x => x.key === 'ui.experienceStyle');
  assert.deepEqual(plain(field.options.map(x => x.value)), ['original', 'follow']);
  assert.equal(field.fnPath, undefined); assert.equal(first.data.values['ui.experienceStyle'], 'original');
  assert.deepEqual(f.writes, []); assert.deepEqual(f.requests, []);
  store.set(`${ID}|config|ui.experienceStyle`, 'follow');
  await f.plugin.clearPluginSession();
  const reopened = fixture({ store });
  assert.equal((await reopened.plugin.getSettingsBundle()).data.values['ui.experienceStyle'], 'follow');
  assert.equal(store.get(`${OLD}|config|ui.experienceStyle`), 'old-value');
  assert.ok(f.writes.every(k => k.startsWith(`${ID}|`)));
  assertOwnSources(first);
});

test('built manual login and profile edits use proven JSON protocols and only the standalone session', async () => {
  const f = fixture(); const login = await f.plugin.getLoginBundle();
  assert.equal(login.source, ID);
  await f.plugin.loginWithPassword({ values: { account: 'fixture@example.test', password: 'fixture-password' } });
  const signIn = f.requests.find(x => x.url.pathname === '/auth/sign-in');
  assert.deepEqual(JSON.parse(signIn.body), { email: 'fixture@example.test', password: 'fixture-password' });
  assert.match(signIn.headers['content-type'], /application\/json/);
  await f.plugin.updateProfile({ value: 'Fixture bio' });
  const profile = f.requests.find(x => x.url.pathname === '/users/profile' && x.method === 'PUT');
  assert.deepEqual(JSON.parse(profile.body), { slogan: 'Fixture bio' });
  assert.equal(profile.headers.authorization, 'new-fixture-token');
  assert.equal(f.plugin.register, undefined); assert.equal(f.plugin.getGames, undefined);
  assert.ok(f.writes.every(k => k.startsWith(`${ID}|`)));
});

test('built authentication failure is a login requirement without polling or automatic session writes', async () => {
  const f = fixture({ respond: () => ({ code: 401, error: '1005', message: 'unauthorized' }) });
  await assert.rejects(f.plugin.getHomeData(), e => JSON.parse(e.message).source === ID);
  assert.ok(f.timers.every(delay => Number(delay ?? 0) < 20000));
  assert.deepEqual(f.writes, []);
});
