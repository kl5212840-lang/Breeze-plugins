import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const bundle = readFileSync(new URL("../dist/breeze-plugin-jm-comic.bundle.cjs", import.meta.url), "utf8");
const md5 = (text: string) => crypto.createHash("md5").update(text).digest("hex");
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json" },
});
const album = (id = 51) => json({
  code: 200, data: { id, name: "fixture", series: [{ id: id + 100, sort: 1, name: "Chapter 1" }] },
});
const speedCacheKey = "JmComic::runtime:speed:v3";

function fixture(handle: (request: Request) => Response | Promise<Response>, timerMs = (ms: number) => ms) {
  const settings = new Map<string, unknown>();
  const cache = new Map<string, unknown>();
  const requests: Request[] = [];
  const reads: string[] = [];
  const context = vm.createContext({
    module: { exports: {} }, exports: {}, URL, URLSearchParams, Request, Response, Headers,
    FormData, Blob, AbortController, TextEncoder, TextDecoder, structuredClone,
    setTimeout: (callback: () => void, ms = 0) => setTimeout(callback, timerMs(ms)),
    clearTimeout, ArrayBuffer, Uint8Array, DataView,
    nodeCryptoCompat: crypto, uuidv4: crypto.randomUUID,
    console: { info() {}, warn() {}, log() {}, error() {} },
    async fetch(input: Request | string, init?: RequestInit) {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(request);
      return handle(request);
    },
    bridge: { async call(name: string, key: string, value: unknown) {
      if (name === "load_plugin_config") {
        reads.push(key);
        return JSON.stringify({ ok: true, value: settings.get(key) ?? (value ? JSON.parse(String(value)) : value) });
      }
      if (name === "save_plugin_config") { settings.set(key, JSON.parse(String(value))); return true; }
      if (name.includes("md5")) return md5(String(key));
      if (name === "cache.get") return cache.get(key) ?? value;
      if (name === "cache.set") { cache.set(key, value); return true; }
      throw Error(`Unexpected line fixture bridge call ${name}`);
    } },
  });
  vm.runInContext(bundle, context, { filename: "jm-line-fixture.cjs" });
  return { plugin: context.module.exports.default, settings, cache, requests, reads };
}

test("a category child scopes its filter and requests without changing global rankings", async () => {
  const f = fixture(() => json({ code: 200, data: { content: [], total: 0 } }));
  const root = await f.plugin.getFunctionPage({ id: "categories" });
  const single = root.data.categories.find((entry: any) => entry.title === "单本").action.payload.scene;
  assert.equal(single.list.extern.categoryScope, "single");
  const filter = await f.plugin.getRankingFilterBundle({ extern: single.filter.extern });
  assert.equal(filter.scheme.optionLayout, "wrap");
  assert.deepEqual(Array.from(filter.scheme.fields[0].options, (option: any) => option.value),
    ["single", "single_chinese", "single_japanese", "single_youth"]);
  const global = await f.plugin.getRankingFilterBundle({ extern: { type: "single" } });
  assert.ok(global.scheme.fields[0].options.some((option: any) => option.value === "doujin"));
  const noChildren = await f.plugin.getRankingFilterBundle({ extern: { categoryScope: "another_3d", type: "another_3d" } });
  assert.deepEqual(Array.from(noChildren.scheme.fields, (field: any) => field.key), ["order"]);
  for (const [requested, expected] of [["doujin", "single"], ["single_japanese", "single_japanese"]]) {
    await f.plugin.getRankingData({ extern: { ...single.list.extern, type: requested, order: "tf" } });
    const url = new URL(f.requests[f.requests.length - 1]!.url);
    assert.equal(url.searchParams.get("c"), expected);
    assert.equal(url.searchParams.get("o"), "tf");
  }
});

test("JM catalog emits dates from update_at without inferring a date from work IDs", async () => {
  const f = fixture(() => json({ code: 200, data: JSON.stringify({
    content: [
      { id: "52", update_at: 1794534613 },
      { id: "53", update_at: "1794534613" },
      { id: "54", update_at: "2026-11-13T09:50:13+08:00" },
      { id: "1794534613" },
      { id: "55", update_at: "1234" },
      { id: "56", update_at: "2026-02-30" },
    ],
    total: 6,
  }) }));
  const { data } = await f.plugin.getRankingData();
  assert.deepEqual(Array.from(data.items, (item: any) => item.updatedAt), [
    "2026-11-13T01:50:13.000Z", "2026-11-13T01:50:13.000Z",
    "2026-11-13T09:50:13+08:00", "", "", "",
  ]);
});

test("JM measures signed public catalog and real cover bytes and selects the passing image route", async () => {
  const validImage = "cdn-msp.jmapiproxy1.cc";
  const htmlImage = "cdn-msp.jmapiproxy2.cc";
  const f = fixture((request) => {
    const url = new URL(request.url);
    assert.equal(request.credentials, "omit");
    assert.equal(request.redirect, "error");
    assert.equal(request.headers.get("authorization"), null);
    assert.equal(request.headers.get("cookie"), null);
    if (url.pathname === "/latest" || url.pathname === "/album") {
      const [ts, version] = request.headers.get("tokenparam")!.split(",");
      assert.equal(request.headers.get("token"), md5(ts + version));
      if (url.pathname === "/album") {
        assert.equal(url.searchParams.get("id"), "51");
        return album();
      }
      assert.equal(url.searchParams.get("page"), "1");
      return json({ code: 200, data: { list: [{ id: "51", name: "fixture" }] } });
    }
    assert.equal(url.pathname, "/media/albums/51_3x4.jpg");
    assert.equal(request.headers.get("range"), "bytes=0-63");
    if (url.hostname === validImage) {
      return new Response(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0), { status: 206 });
    }
    if (url.hostname === htmlImage) return new Response("<html>gateway</html>");
    return new Response("denied", { status: 403 });
  });
  const result = (await f.plugin.measureEndpointSpeeds()).data;
  assert.equal(result.api.length, 1);
  assert.equal(result.api[0].ok, true);
  assert.equal(result.outcome, "partial");
  assert.equal(result.image.length, 7);
  assert.equal(result.image.filter((row: any) => row.ok).length, 1);
  assert.equal(result.image.find((row: any) => row.url.includes(htmlImage)).status, 200);
  assert.equal(f.requests.length, 9);
  assert.equal(f.reads.some((key) => key.startsWith("auth.")), false);
  assert.equal(f.settings.size, 0);
  assert.equal(f.cache.has(speedCacheKey), true);
  assert.equal(JSON.stringify(f.cache.get(speedCacheKey)).includes("51_3x4.jpg"), false);
  const settings = await f.plugin.getSettingsBundle();
  const network = settings.scheme.sections.find((row: any) => row.id === "network");
  const image = network.fields.find((row: any) => row.key === "network.imageBase");
  assert.equal(network.headerAction.fnPath, "measureEndpointSpeeds");
  assert.match(image.options.find((row: any) => row.value.includes(htmlImage)).label, /无法加载封面/);
  assert.equal(image.options[0].label, "自动（可用优先）");
  assert.equal(image.options.find((row: any) => row.routeOption?.inUse).value, `https://${validImage}`);
});

test("a logical API error leaves images untested and no legacy root-probe result is reused", async () => {
  const f = fixture(() => json({ code: 403, data: { list: [{ id: 51, name: "fixture" }] } }));
  f.settings.set("network.speed", { measuredAt: Date.now(), image: [
    { url: "https://cdn-msp.jmapiproxy1.cc/", ok: true, ms: 1, status: 403 },
  ], api: [] });
  const result = (await f.plugin.measureEndpointSpeeds()).data;
  assert.equal(result.api[0].ok, false);
  assert.equal(result.api[0].status, 200);
  assert.equal(result.image.length, 0);
  assert.equal(result.outcome, "failure");
  assert.match(result.message, /作品未能打开，暂未测试/);
  assert.equal(f.requests.length, 1);
  const settings = await f.plugin.getSettingsBundle();
  const network = settings.scheme.sections.find((row: any) => row.id === "network");
  const image = network.fields.find((row: any) => row.key === "network.imageBase");
  assert.match(image.options.find((row: any) => row.value.includes("cdn-msp.jmapiproxy1.cc")).label, /未测/);
});

test("a missing latest response tries one public ranking on the same line before validating a work and cover", async () => {
  const api = "https://www.cdnhjk.net";
  const f = fixture((request) => {
    const url = new URL(request.url);
    assert.equal(request.credentials, "omit");
    assert.equal(request.headers.get("authorization"), null);
    if (url.pathname === "/latest") throw new TypeError("Failed to fetch");
    if (url.pathname === "/categories/filter") {
      assert.equal(url.origin, api);
      assert.equal(url.searchParams.get("page"), "0");
      assert.equal(url.searchParams.get("o"), "tf");
      return json({ code: 200, data: { content: [{ id: "51", name: "fixture" }] } });
    }
    if (url.pathname === "/album") {
      assert.equal(url.origin, api);
      assert.equal(url.searchParams.get("id"), "51");
      return album();
    }
    assert.equal(url.pathname, "/media/albums/51_3x4.jpg");
    return new Response(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0), { status: 206 });
  });
  const result = (await f.plugin.measureEndpointSpeeds()).data;
  assert.equal(result.outcome, "success");
  assert.equal(result.api[0].ok, true);
  assert.equal(result.image.every((row: any) => row.ok), true);
  assert.equal(result.effectiveRouteChanged, false);
  const paths = f.requests.map((request) => new URL(request.url).pathname);
  assert.deepEqual(paths.slice(0, 3), ["/latest", "/categories/filter", "/album"]);
  assert.equal(paths.filter((path) => path === "/categories/filter").length, 1);
});

test("a missing latest response and unusable ranking do not measure covers or change routes", async () => {
  const f = fixture((request) => {
    const url = new URL(request.url);
    if (url.pathname === "/latest") throw new TypeError("Failed to fetch");
    assert.equal(url.pathname, "/categories/filter");
    return json({ code: 200, data: { content: [{ id: "51" }] } });
  });
  const result = (await f.plugin.measureEndpointSpeeds()).data;
  assert.equal(result.outcome, "failure");
  assert.equal(result.api[0].failedAt, "catalog");
  assert.equal(result.api[0].status, 200);
  assert.equal(result.image.length, 0);
  assert.equal(result.effectiveRouteChanged, false);
  assert.equal(f.requests.length, 2);
});

test("clearing manual pins applies recent winners without another measurement", async () => {
  const automaticApi = "https://www.cdnbtd.cc";
  const manualApi = "https://www.cdngwc.club";
  const automaticImage = "https://cdn-msp.jmapiproxy1.cc";
  const manualImage = "https://cdn-msp2.jmapiproxy2.cc";
  const f = fixture(() => { throw Error("a fresh discovery cache requires no network"); });
  f.cache.set("JmComic::runtime:endpoints", {
    apiBaseUrl: manualApi, hostPool: [automaticApi, manualApi],
    imageBaseUrl: manualImage, imageBaseUrls: [automaticImage, manualImage], updatedAt: Date.now(),
  });
  f.settings.set("network.apiBase", manualApi);
  f.settings.set("network.imageBase", manualImage);
  const measuredAt = Date.now();
  f.cache.set(speedCacheKey, {
    measuredAt,
    api: [{ url: automaticApi, ok: true, ms: 5, status: 200, checkedAt: measuredAt }],
    image: [{ url: automaticImage, ok: true, ms: 5, status: 206, checkedAt: measuredAt }],
  });
  const init = (await f.plugin.init()).data;
  assert.equal(init.fastestApiBase, manualApi);
  assert.equal(init.runtimeImageBaseUrl, manualImage);
  const readFields = async () =>
    (await f.plugin.getSettingsBundle()).scheme.sections.find((row: any) => row.id === "network").fields;
  for (const field of await readFields()) {
    assert.equal(field.options.some((option: any) => option.routeOption?.inUse), false);
  }
  const apiChange = await f.plugin.onNetworkChanged({ key: "network.apiBase", value: "" });
  const imageChange = await f.plugin.onNetworkChanged({ key: "network.imageBase", value: "" });
  assert.equal(apiChange.data.effectiveRouteChanged, true);
  assert.equal(imageChange.data.effectiveRouteChanged, false);
  const settings = await f.plugin.getSettingsBundle();
  const fields = settings.scheme.sections.find((row: any) => row.id === "network").fields;
  assert.match(fields.find((row: any) => row.key === "network.apiBase").description, /www\.cdnbtd\.cc/);
  assert.match(fields.find((row: any) => row.key === "network.imageBase").description, /cdn-msp\.jmapiproxy1\.cc/);
  for (const [key, current] of [["network.apiBase", automaticApi], ["network.imageBase", automaticImage]]) {
    const field = fields.find((row: any) => row.key === key);
    assert.equal(settings.data.values[key], "");
    assert.equal(field.options.some((option: any) => option.label.includes("使用中")), false);
    assert.equal(field.options.slice(1).every((option: any) =>
      option.routeOption.domain === new URL(option.value).hostname &&
      !option.routeOption.title.includes("使用中")), true);
    assert.equal(field.options[0].value, "");
    assert.deepEqual(Array.from(field.options.filter((option: any) => option.routeOption?.inUse), (option: any) => option.value), [current]);
  }
  assert.equal(f.requests.length, 0);
});

test("JM chooses the lowest passing latency for both Auto fields and reuses it on initialization", async () => {
  const slowApi = "https://slow.fixture.invalid";
  const fastApi = "https://fast.fixture.invalid";
  const badApi = "https://bad.fixture.invalid";
  const slowImage = "https://cdn-msp.jmapiproxy1.cc";
  const fastImage = "https://cdn-msp.jmapiproxy2.cc";
  const cache = {
    apiBaseUrl: slowApi, hostPool: [slowApi, badApi, fastApi],
    imageBaseUrl: slowImage, imageBaseUrls: [slowImage, fastImage], updatedAt: Date.now(),
  };
  const f = fixture(async (request) => {
    const url = new URL(request.url);
    if (url.origin === slowImage ||
        (url.pathname === "/album" && url.origin === slowApi) ||
        (url.pathname === "/latest" && url.origin === fastApi)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (url.pathname === "/latest") {
      const id = url.origin === slowApi ? 51 : 91;
      return json({ code: 200, data: { list: [{ id, name: "fixture" }] } });
    }
    if (url.pathname === "/album") {
      assert.equal(url.searchParams.get("id"), "51");
      return album(url.origin === badApi ? 91 : 51);
    }
    if (url.origin === fastImage || url.origin === slowImage) {
      return new Response(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0), { status: 206 });
    }
    return new Response("denied", { status: 403 });
  });
  f.cache.set("JmComic::runtime:endpoints", cache);
  await f.plugin.init();
  const result = await f.plugin.measureEndpointSpeeds();
  assert.equal(result.data.effectiveRouteChanged, true);
  assert.equal(result.data.api.find((row: any) => row.url === badApi).ok, false);
  assert.equal(result.data.api.find((row: any) => row.url === badApi).failedAt, "album");
  assert.ok(result.data.api.find((row: any) => row.url === fastApi).ms <
    result.data.api.find((row: any) => row.url === slowApi).ms);
  const settings = await f.plugin.getSettingsBundle();
  const fields = settings.scheme.sections.find((row: any) => row.id === "network").fields;
  for (const [key, winner] of [["network.apiBase", fastApi], ["network.imageBase", fastImage]]) {
    const field = fields.find((row: any) => row.key === key);
    assert.equal(field.options[0].label, "自动（可用优先）");
    assert.equal(settings.data.values[key], "");
    assert.equal(field.options.find((row: any) => row.routeOption?.inUse).value, winner);
  }
  await f.plugin.fetchImageBytes({ url: `${slowImage}/media/albums/51_3x4.jpg` });
  assert.equal(new URL(f.requests[f.requests.length - 1]!.url).origin, fastImage);

  const relaunched = fixture(() => { throw Error("recent results require no probe"); });
  relaunched.cache.set("JmComic::runtime:endpoints", cache);
  relaunched.cache.set(speedCacheKey, f.cache.get(speedCacheKey));
  const init = await relaunched.plugin.init();
  assert.equal(init.data.fastestApiBase, fastApi);
  assert.equal(init.data.runtimeImageBaseUrl, fastImage);
  assert.equal(relaunched.requests.length, 0);
});

test("an in-flight JM speed test respects a new manual pin and an all-failed test keeps the current route", async () => {
  const first = "https://slow.fixture.invalid";
  const winner = "https://fast.fixture.invalid";
  let unblock = () => {};
  const running = new Promise<void>((resolve) => { unblock = resolve; });
  let success = true;
  const f = fixture(async (request) => {
    const url = new URL(request.url);
    await running;
    if (success && url.origin === winner) {
      if (url.pathname === "/latest") {
        return json({ code: 200, data: { list: [{ id: 51, name: "fixture" }] } });
      }
      if (url.pathname === "/album") return album();
    }
    return json({ code: 503 }, 503);
  });
  f.cache.set("JmComic::runtime:endpoints", {
    apiBaseUrl: first,
    hostPool: [first, winner],
    imageBaseUrl: "https://cdn-msp.jmapiproxy1.cc",
    imageBaseUrls: [],
    updatedAt: Date.now(),
  });
  await f.plugin.init();
  const measurement = f.plugin.measureEndpointSpeeds();
  await f.plugin.onNetworkChanged({ key: "network.apiBase", value: first });
  unblock();
  assert.equal((await measurement).data.effectiveRouteChanged, false);
  assert.equal((await f.plugin.init()).data.fastestApiBase, first);
  await f.plugin.onNetworkChanged({ key: "network.apiBase", value: "" });
  assert.equal((await f.plugin.init()).data.fastestApiBase, winner);
  success = false;
  assert.equal((await f.plugin.measureEndpointSpeeds()).data.effectiveRouteChanged, false);
  assert.equal((await f.plugin.init()).data.fastestApiBase, winner);
});

test("returning images to Auto can report a different effective API after fresh measurements", async () => {
  const previous = "https://previous.fixture.invalid";
  const winner = "https://winner.fixture.invalid";
  const fixedImage = "https://cdn-msp.jmapiproxy1.cc";
  const f = fixture((request) => {
    const url = new URL(request.url);
    assert.equal(request.headers.get("authorization"), null);
    if (url.origin === winner && url.pathname === "/latest") {
      return json({ list: [{ id: 51, name: "fixture" }] });
    }
    if (url.origin === winner && url.pathname === "/album") return album();
    return json({ code: 503 }, 503);
  });
  f.cache.set("JmComic::runtime:endpoints", {
    apiBaseUrl: previous, hostPool: [previous, winner],
    imageBaseUrl: fixedImage, imageBaseUrls: [fixedImage], updatedAt: Date.now(),
  });
  f.settings.set("network.imageBase", fixedImage);
  await f.plugin.init();
  const changed = await f.plugin.onNetworkChanged({ key: "network.imageBase", value: "" });
  assert.equal(changed.data.effectiveRouteChanged, true);
  assert.equal((await f.plugin.init()).data.fastestApiBase, winner);
  assert.equal(f.settings.get("network.apiBase"), undefined);
});

const chapterApi = "https://chapter.fixture.invalid";
const backupApi = "https://backup.fixture.invalid";
const primaryImage = "https://cdn-msp.jmapiproxy1.cc";
const backupImage = "https://cdn-msp.jmapiproxy2.cc";
const downloadInput = { comicId: "51", chapterId: "151", downloadRoute: { version: 1, excluded: [] } };
const chapterReply = (id = 151, images = ["00001.webp", "00002.webp"]) =>
  ({ id, name: "Chapter fixture", images });

async function initDownloadRoutes(f: ReturnType<typeof fixture>, api = [chapterApi, backupApi]) {
  f.cache.set("JmComic::runtime:endpoints", {
    apiBaseUrl: api[0], hostPool: api, imageBaseUrl: primaryImage,
    imageBaseUrls: [primaryImage, backupImage], updatedAt: Date.now(),
  });
  await f.plugin.init();
}

test("a JM download locks the selected image host and rotates only its automatic axis", async () => {
  const f = fixture((request) => {
    const url = new URL(request.url);
    assert.equal(request.credentials, "omit");
    assert.equal(request.redirect, "error");
    assert.equal(request.headers.get("authorization"), null);
    if (url.pathname === "/chapter") {
      assert.equal(url.origin, chapterApi);
      assert.equal(url.searchParams.get("id"), "151");
      return json({ code: 200, data: chapterReply() });
    }
    assert.equal(request.headers.get("referer"), chapterApi);
    assert.equal(url.pathname, "/media/photos/151/00001.webp");
    return url.origin === primaryImage
      ? new Response("unavailable", { status: 503 })
      : new Response(Uint8Array.of(1, 2, 3));
  });
  f.settings.set("network.apiBase", chapterApi);
  await initDownloadRoutes(f);
  const requestPage = (page: any) => f.plugin.fetchImageBytes({ url: page.url, extern: page.extern });
  const first = (await f.plugin.getChapter(downloadInput)).data.chapter;
  assert.equal(first.id, "151");
  assert.deepEqual(JSON.parse(JSON.stringify(first.extern.downloadRoute)), {
    version: 1, key: "jm|chapter.fixture.invalid|cdn-msp.jmapiproxy1.cc",
    apiHost: "chapter.fixture.invalid", imageHost: "cdn-msp.jmapiproxy1.cc",
  });
  const background = JSON.parse(JSON.stringify(first.pages[0].extern.backgroundDownload));
  assert.deepEqual(background, {
    version: 1,
    credentialFree: true,
    redirectPolicy: "same-url",
    headers: {
      Referer: chapterApi,
      "X-Requested-With": "com.JMComic3.app",
      Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });
  assert.equal(f.requests.length, 1);
  await assert.rejects(requestPage(first.pages[0]), /503/);
  for (const [name, value] of Object.entries(background.headers)) {
    assert.equal(f.requests[1]?.headers.get(name), value);
  }
  assert.deepEqual(f.requests.map((request) => new URL(request.url).origin), [chapterApi, primaryImage]);
  await assert.rejects(requestPage({ ...first.pages[0], url: `${backupImage}/media/photos/151/00001.webp` }), /线路不匹配/);
  assert.equal(f.requests.length, 2);

  const second = (await f.plugin.getChapter({ ...downloadInput,
    downloadRoute: { version: 1, excluded: [first.extern.downloadRoute.key] },
  })).data.chapter;
  assert.equal(second.extern.downloadRoute.apiHost, first.extern.downloadRoute.apiHost);
  assert.notEqual(second.extern.downloadRoute.key, first.extern.downloadRoute.key);
  assert.equal(second.pages.every((page: any) => new URL(page.url).origin === backupImage), true);
  assert.deepEqual(JSON.parse(JSON.stringify(second.pages[0].extern.backgroundDownload)), background);
  assert.deepEqual(Array.from(await requestPage(second.pages[0])), [1, 2, 3]);
  assert.equal((await f.plugin.init()).data.runtimeImageBaseUrl, primaryImage);
});

test("a fixed image route survives invalid chapter replies and excludes the previous API pair", async () => {
  const validApi = "https://valid.fixture.invalid";
  const f = fixture((request) => {
    const url = new URL(request.url);
    assert.equal(request.headers.get("authorization"), null);
    assert.equal(url.pathname, "/chapter");
    assert.equal(url.searchParams.get("id"), "151");
    if (url.origin === chapterApi) return json({ code: 200, data: chapterReply(152) });
    if (url.origin === backupApi) return json({ code: 200, data: chapterReply(151, ["../00001.webp"]) });
    return json({ code: 200, data: chapterReply() });
  });
  f.settings.set("network.imageBase", backupImage);
  await initDownloadRoutes(f, [chapterApi, backupApi, validApi]);
  const candidate = (await f.plugin.getChapter(downloadInput)).data.chapter;
  assert.equal(candidate.extern.downloadRoute.apiHost, new URL(validApi).host);
  assert.equal(candidate.pages.every((page: any) => new URL(page.url).origin === backupImage), true);
  assert.equal(f.requests.length, 3);
  f.requests.length = 0;
  await assert.rejects(f.plugin.getChapter({ ...downloadInput,
    downloadRoute: { version: 1, excluded: [candidate.extern.downloadRoute.key] },
  }), { message: '{"type":"comic_download_route_unavailable","retryable":false,"reason":"unverified"}' });
  assert.deepEqual(f.requests.map((request) => new URL(request.url).origin), [chapterApi, backupApi]);
});

test("JM only submits saved credentials after a site member gate on the active API origin", async () => {
  const f = fixture((request) => {
    const url = new URL(request.url);
    const token = request.headers.get("authorization");
    assert.equal(request.redirect, "error");
    assert.equal(request.credentials, "omit");
    if (url.origin === chapterApi && !token) return json({ code: 403, msg: "請先登入會員" }, 403);
    if (url.origin === chapterApi) {
      assert.equal(token, "Bearer fixture-jwt");
      return json({ code: 503, jwttoken: "untrusted-replacement" }, 503);
    }
    assert.equal(token, null);
    return json(chapterReply());
  });
  f.settings.set("auth.jwt", "fixture-jwt");
  await initDownloadRoutes(f);
  const result = (await f.plugin.getChapter(downloadInput)).data.chapter;
  assert.equal(result.extern.downloadRoute.apiHost, new URL(backupApi).host);
  assert.deepEqual(f.requests.map((request) => [new URL(request.url).origin, request.headers.get("authorization")]), [
    [chapterApi, null], [chapterApi, "Bearer fixture-jwt"], [backupApi, null],
  ]);
  assert.equal(f.settings.get("auth.jwt"), "fixture-jwt");
  assert.equal(f.cache.has("JmComic::jwt"), false);
});

test("JM keeps a confirmed membership gate separate from exhausted download routes", async () => {
  const f = fixture(() => json({ code: 403, msg: "請先登入會員" }, 403));
  await initDownloadRoutes(f, [chapterApi]);
  await assert.rejects(f.plugin.getChapter(downloadInput), /"type":"unauthorized"/);
  assert.equal(f.requests.length, 1);
});

test("JM keeps member credentials out of image declarations and excludes unknown CDNs", async () => {
  const f = fixture((request) => request.headers.has("authorization")
    ? json(chapterReply())
    : json({ code: 403, msg: "請先登入會員" }, 403));
  f.settings.set("auth.jwt", "fixture-jwt");
  await initDownloadRoutes(f, [chapterApi]);
  const { chapter } = (await f.plugin.getChapter(downloadInput)).data;
  assert.deepEqual(Object.keys(chapter.pages[0].extern.backgroundDownload.headers).sort(), [
    "Accept", "Accept-Language", "Referer", "X-Requested-With",
  ]);
  assert.equal(new URL(chapter.pages[0].url).origin, primaryImage);

  const other = fixture(() => json(chapterReply()));
  const customImage = "https://unverified.fixture.invalid";
  other.cache.set("JmComic::runtime:endpoints", {
    apiBaseUrl: chapterApi, hostPool: [chapterApi], imageBaseUrl: customImage,
    imageBaseUrls: [customImage], updatedAt: Date.now(),
  });
  await other.plugin.init();
  const custom = (await other.plugin.getChapter(downloadInput)).data.chapter;
  assert.equal(new URL(custom.pages[0].url).origin, customImage);
  assert.equal(custom.pages[0].extern.backgroundDownload, undefined);
});

test("JM reports retryable chapter transport failures and preserves terminal HTTP failures", async () => {
  for (const status of [429, 503, 401, 404]) {
    const f = fixture(() => new Response("", { status }));
    await initDownloadRoutes(f);
    await assert.rejects(f.plugin.getChapter(downloadInput), (error: unknown) => {
      const detail = JSON.parse((error as { message: string }).message);
      assert.equal(detail.type, "comic_download_route_unavailable");
      assert.equal(detail.retryable, status === 429 || status === 503);
      if (detail.retryable) assert.equal(detail.httpStatus, status);
      return true;
    });
    assert.equal(f.requests.length, status === 503 ? 2 : 1);
  }
});

test("JM keeps regular reading and two fixed axes on the existing chapter path", async () => {
  const f = fixture(() => json(chapterReply()));
  await initDownloadRoutes(f);
  const legacy = (await f.plugin.getChapter({ ...downloadInput, downloadRoute: undefined })).data.chapter;
  assert.deepEqual(JSON.parse(JSON.stringify(legacy.extern)), {});
  assert.deepEqual(JSON.parse(JSON.stringify(legacy.pages[0].extern)), {});
  assert.equal(f.requests[0]?.redirect, "follow");
  await f.plugin.onNetworkChanged({ key: "network.apiBase", value: chapterApi });
  await f.plugin.onNetworkChanged({ key: "network.imageBase", value: backupImage });
  const manual = (await f.plugin.getChapter(downloadInput)).data.chapter;
  assert.equal(manual.extern.downloadRoute, undefined);
  assert.equal(manual.pages[0].extern.backgroundDownload, undefined);
  assert.equal(new URL(manual.pages[0].url).origin, backupImage);
  assert.equal(f.requests[1]?.redirect, "follow");
});

test("JM aborts a slow chapter request and caps a locked page's transport time", async () => {
  const aborted: string[] = [];
  const timers: number[] = [];
  const f = fixture((request) => {
    const { origin } = new URL(request.url);
    if (origin === backupApi) return json(chapterReply());
    return new Promise<Response>((_, reject) => {
      request.signal.addEventListener("abort", () => {
        aborted.push(origin);
        reject(request.signal.reason);
      }, { once: true });
    });
  }, (ms) => {
    timers.push(ms);
    return ms === 5000 || ms === 12000 || ms === 30000 ? 5 : ms;
  });
  await initDownloadRoutes(f);
  const { pages, extern } = (await f.plugin.getChapter(downloadInput)).data.chapter;
  assert.deepEqual(aborted, [chapterApi]);
  assert.equal(extern.downloadRoute.apiHost, new URL(backupApi).host);
  await assert.rejects(f.plugin.fetchImageBytes({
    url: pages[0].url, extern: pages[0].extern, timeoutMs: 120000,
  }), /timeout|timed out|超时/i);
  assert.deepEqual(aborted, [chapterApi, primaryImage]);
  assert.equal(f.requests.length, 3);
  assert.ok(timers.includes(5000) && timers.includes(12000) && !timers.includes(30000) && !timers.includes(120000));
});

test("JM rejects malformed v1 exclusions without contacting a chapter endpoint", async () => {
  const f = fixture(() => { throw Error("invalid inputs must not reach fetch"); });
  await initDownloadRoutes(f);
  for (const excluded of [["https://chapter.fixture.invalid/chapter"], ["a", "b", "c", "d"]]) {
    await assert.rejects(f.plugin.getChapter({ ...downloadInput,
      downloadRoute: { version: 1, excluded },
    }), /线路请求无效/);
  }
  assert.equal(f.requests.length, 0);
});


test("compiled route menus shorten long hostnames while retaining exact copy domains", async () => {
  const first = "https://catalog-alpha-region-long.fixture.invalid";
  const second = "https://catalog-delta-region-long.fixture.invalid";
  const f = fixture(() => { throw Error("cached routes require no network"); });
  f.cache.set("JmComic::runtime:endpoints", {
    apiBaseUrl: first, hostPool: [first, second],
    imageBaseUrl: "https://cdn-msp.jmapiproxy1.cc", updatedAt: Date.now(),
  });
  await f.plugin.init();
  const settings = await f.plugin.getSettingsBundle();
  const network = settings.scheme.sections.find((row: any) => row.id === "network");
  const field = network.fields.find((row: any) => row.key === "network.apiBase");
  const options = [first, second].map((base) =>
    field.options.find((option: any) => option.value === base).routeOption);
  assert.equal(options[0].domain, new URL(first).hostname);
  assert.equal(options[1].domain, new URL(second).hostname);
  assert.match(options[0].title, /catalog-alpha…/);
  assert.match(options[1].title, /catalog-delta…/);
  assert.equal(options[0].inUse, true);
  assert.equal(options[1].inUse, false);
  assert.equal(f.requests.length, 0);
});
