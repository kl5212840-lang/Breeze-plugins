import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as crypto from "node:crypto";
import vm from "node:vm";
import { test } from "node:test";

const bundle = readFileSync(new URL("../dist/breeze-plugin-jm-comic.bundle.cjs", import.meta.url), "utf8");
function fixture(
  payload: unknown,
  options: {
    savedJwt?: string;
    apiBases?: string[];
    pin?: string;
    respond?: (request: Request) => { status: number; data: unknown } |
      Promise<{ status: number; data: unknown }>;
  } = {},
) {
  const requests: string[] = [], settings = new Map(), cache = new Map();
  const transport: Array<{ authorization: string | null; credentials: string; redirect: string }> = [];
  if (options.savedJwt) settings.set("auth.jwt", options.savedJwt);
  if (options.pin) settings.set("network.apiBase", options.pin);
  if (options.apiBases) {
    cache.set("JmComic::runtime:endpoints", {
      apiBaseUrl: options.apiBases[0],
      hostPool: options.apiBases,
      imageBaseUrl: "https://images.fixture.invalid",
      imageBaseUrls: ["https://images.fixture.invalid"],
      updatedAt: Date.now(),
    });
  }
  const context = vm.createContext({
    module: { exports: {} }, exports: {}, URL, URLSearchParams, Request, Response, Headers,
    FormData, Blob, AbortController, TextEncoder, TextDecoder, structuredClone,
    setTimeout, clearTimeout, ArrayBuffer, Uint8Array, DataView,
    nodeCryptoCompat: crypto, uuidv4: crypto.randomUUID,
    console: { info() {}, warn() {}, log() {}, error() {} },
    async fetch(input: Request | string, init?: RequestInit) {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(new URL(request.url).pathname);
      transport.push({
        authorization: request.headers.get("authorization"),
        credentials: request.credentials,
        redirect: request.redirect,
      });
      const reply = await options.respond?.(request) ?? { status: 200, data: payload };
      return new Response(JSON.stringify(reply.data), { status: reply.status, headers: { "content-type": "application/json" } });
    },
    bridge: { async call(name: string, key: any, value: unknown) {
      if (name === "cache.get") return cache.get(key) ?? value ?? null;
      if (name === "cache.set") { cache.set(key, value); return true; }
      if (name === "cache.delete") { cache.delete(key); return true; }
      if (name === "load_plugin_config") return JSON.stringify({ ok: true, value: settings.get(key) ?? JSON.parse(String(value)) });
      if (name === "save_plugin_config") { settings.set(key, JSON.parse(String(value))); return true; }
      if (name.includes("md5")) return crypto.createHash("md5").update(String(key)).digest("hex");
      if (name === "opencc.convert") return key.text;
      throw Error(`Unexpected compiled detail fixture bridge call ${name}`);
    } },
  });
  vm.runInContext(bundle, context, { filename: "jm-compiled-detail-fixture.cjs" });
  return { plugin: context.module.exports.default, requests, transport };
}

test("compiled JM album normalizes only the detail envelope and preserves public metadata", async () => {
  const f = fixture({ code: 200, data: { id: 51, name: "fixture", description: "summary", tags: ["tag"], total_views: "7", likes: "0" } });
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  const info = await f.plugin.getInfo();
  assert.equal(info.version, manifest.version);
  assert.equal(info.breezeExperience.comicFollow, 1);
  assert.equal(manifest.breezeExperience.comicFollow, 1);
  const normal = (await f.plugin.getComicDetail({ comicId: "51" })).data.normal;
  assert.deepEqual(f.requests, ["/album"]);
  assert.equal(normal.comicInfo.id, "51");
  assert.equal(normal.comicInfo.description, "summary");
  assert.equal(normal.comicInfo.metadata.find((item: any) => item.type === "tags").value[0].name, "tag");
  assert.deepEqual(JSON.parse(JSON.stringify(normal.extern.metricAvailability)), { totalViews: true, totalLikes: true, totalComments: false });
  assert.equal(normal.totalLikes, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(normal.extern.fieldsMissing)), []);
});

test("compiled invalid identity/title fail, while absent optional content remains valid and unknown", async () => {
  for (const payload of [{ id: 52, name: "wrong" }, { id: 51, name: " " }, { code: 500, data: { id: 51, name: "error envelope" } }, { code: 500, id: 51, name: "logical error" }]) {
    const f = fixture(payload);
    await assert.rejects(f.plugin.getComicDetail({ comicId: "51" }), /作品详情/);
  }
  const f = fixture({ id: 51, name: "valid sparse album" });
  const normal = (await f.plugin.getComicDetail({ comicId: "51" })).data.normal;
  assert.equal(normal.comicInfo.description, "");
  assert.equal(normal.comicInfo.metadata.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(normal.extern.fieldsMissing)), ["description", "tags"]);
  assert.deepEqual(JSON.parse(JSON.stringify(normal.extern.metricAvailability)), { totalViews: false, totalLikes: false, totalComments: false });
  assert.equal(normal.comicInfo.titleMeta.some((item: any) => item.name.startsWith("浏览：")), false);
});

test("compiled mixed-level album metadata is not falsely reported missing", async () => {
  const f = fixture({ code: 200, description: "root summary", tags: ["root tag"], total_views: "0", data: { id: 51, name: "fixture" } });
  const normal = (await f.plugin.getComicDetail({ comicId: "51" })).data.normal;
  assert.equal(normal.comicInfo.description, "root summary");
  assert.equal(normal.comicInfo.metadata.find((item: any) => item.type === "tags").value[0].name, "root tag");
  assert.deepEqual(JSON.parse(JSON.stringify(normal.extern.fieldsMissing)), []);
  assert.equal(normal.extern.metricAvailability.totalViews, true);
});

test("compiled follow sends a saved token only after a membership gate and prevents redirects", async () => {
  const f = fixture(null, {
    savedJwt: "fixture-token",
    respond: (request) => request.headers.has("authorization")
      ? { status: 200, data: { id: 51, name: "fixture", series: [], total_photos: 6 } }
      : { status: 401, data: { msg: "請先登入會員" } },
  });
  const { data: { normal } } = await f.plugin.getComicDetail({
    comicId: "00051",
    extern: { comicFollow: true },
  });
  assert.deepEqual(f.requests, ["/album", "/album"]);
  assert.deepEqual(f.transport, [
    { authorization: null, credentials: "omit", redirect: "follow" },
    { authorization: "Bearer fixture-token", credentials: "omit", redirect: "error" },
  ]);
  assert.equal(normal.comicInfo.id, "00051");
  assert.equal(normal.eps[0].id, "51");
});

test("compiled JM like reconciles a lost fetch receipt on the same album and session", async () => {
  const f = fixture(null, {
    savedJwt: "fixture-token",
    respond: (request) => {
      if (request.method === "POST") throw new TypeError("Failed to fetch");
      assert.equal(new URL(request.url).searchParams.get("id"), "51");
      return { status: 200, data: { id: 51, liked: true, likes: "14" } };
    },
  });
  const result = await f.plugin.toggleLike({ comicId: "51", currentLiked: false });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { liked: true, verified: true, totalLikes: 14 });
  assert.deepEqual(f.requests, ["/like", "/album"]);
  assert.deepEqual(f.transport.map(({ authorization, redirect }) => [authorization, redirect]), [
    ["Bearer fixture-token", "manual"],
    ["Bearer fixture-token", "manual"],
  ]);
});

test("compiled JM like keeps a redirect status and makes no second request", async () => {
  const f = fixture(null, {
    savedJwt: "fixture-token",
    respond: () => ({ status: 307, data: null }),
  });
  await assert.rejects(f.plugin.toggleLike({ comicId: "51", currentLiked: false }), /307/);
  assert.deepEqual(f.requests, ["/like"]);
  assert.equal(f.transport[0]?.redirect, "manual");
});

const mainApi = "https://main.fixture.invalid";
const backupApi = "https://backup.fixture.invalid";
const thirdApi = "https://third.fixture.invalid";
const queuedAlbum = { id: 51, name: "fixture", series: [{ id: 151, name: "First", sort: 1 }] };
const downloadDetail = { comicId: "51", extern: { comicDownload: true, chapterId: "151" } };

test("compiled download escapes a broken first album, then fetches the exact chapter without account data", async () => {
  const origins: string[] = [];
  const f = fixture(null, {
    apiBases: [mainApi, backupApi],
    savedJwt: "fixture-session",
    respond: (request) => {
      const url = new URL(request.url);
      origins.push(url.origin);
      assert.equal(request.method, "GET");
      assert.equal(request.headers.get("cookie"), null);
      if (url.origin === mainApi) return { status: 503, data: "gateway" };
      assert.equal(url.origin, backupApi);
      if (url.pathname === "/album") {
        assert.equal(url.searchParams.get("id"), "51");
        return { status: 200, data: queuedAlbum };
      }
      assert.equal(url.pathname, "/chapter");
      assert.equal(url.searchParams.get("id"), "151");
      return { status: 200, data: { id: 151, images: ["001.jpg"] } };
    },
  });
  await f.plugin.init();
  const { data: { normal } } = await f.plugin.getComicDetail(downloadDetail);
  assert.equal(normal.comicInfo.id, "51");
  assert.equal(normal.eps[0].id, "151");
  const { data: { chapter } } = await f.plugin.getChapter({
    comicId: "51", chapterId: "151", downloadRoute: { version: 1, excluded: [] },
  });
  assert.equal(chapter.id, "151");
  assert.equal(chapter.extern.downloadRoute.apiHost, "backup.fixture.invalid");
  assert.deepEqual(origins, [mainApi, backupApi, mainApi, backupApi]);
  assert.deepEqual(f.requests, ["/album", "/album", "/chapter", "/chapter"]);
  assert.deepEqual(f.transport, Array.from({ length: 4 }, () => ({
    authorization: null, credentials: "omit", redirect: "error",
  })));
  const settings = await f.plugin.getSettingsBundle();
  const fields = settings.scheme.sections.find((section: any) => section.id === "network").fields;
  const api = fields.find((field: any) => field.key === "network.apiBase");
  assert.equal(api.options.find((item: any) => item.routeOption?.inUse).value, mainApi);
});

test("compiled ordinary and API-pinned download details stay on their current line", async () => {
  for (const pin of [undefined, mainApi]) {
    const origins: string[] = [];
    const f = fixture(null, {
      apiBases: [mainApi, backupApi], pin, savedJwt: "fixture-session",
      respond: (request) => {
        origins.push(new URL(request.url).origin);
        assert.equal(request.headers.get("authorization"), "Bearer fixture-session");
        return { status: 503, data: "gateway" };
      },
    });
    await f.plugin.init();
    const input = pin ? downloadDetail : { comicId: "51" };
    await assert.rejects(f.plugin.getComicDetail(input), /503/);
    assert.deepEqual(origins, [mainApi]);
  }
});

test("compiled fallback rejects a mismatched album and one missing the queued chapter, with a bounded pass", async () => {
  const origins: string[] = [];
  const f = fixture(null, {
    apiBases: [mainApi, backupApi, thirdApi, "https://fourth.fixture.invalid"],
    respond: (request) => {
      const { origin } = new URL(request.url);
      origins.push(origin);
      if (origin === mainApi) return { status: 503, data: "gateway" };
      if (origin === backupApi) return { status: 200, data: { ...queuedAlbum, id: 52 } };
      return { status: 200, data: { ...queuedAlbum, series: [{ id: 152, sort: 1 }] } };
    },
  });
  await f.plugin.init();
  await assert.rejects(f.plugin.getComicDetail(downloadDetail), /comic_download_route_unavailable/);
  assert.deepEqual(origins, [mainApi, backupApi, thirdApi]);
});

test("compiled download uses only the saved session on the current member route", async () => {
  for (const savedJwt of [undefined, "fixture-session"]) {
    const f = fixture(null, {
      apiBases: [mainApi, backupApi], savedJwt,
      respond: (request) => {
        assert.equal(new URL(request.url).origin, mainApi);
        assert.equal(request.credentials, "omit");
        assert.equal(request.redirect, "error");
        return request.headers.has("authorization")
          ? { status: 200, data: queuedAlbum }
          : { status: 401, data: { msg: "請先登入會員" } };
      },
    });
    await f.plugin.init();
    if (savedJwt) {
      await f.plugin.getComicDetail(downloadDetail);
      assert.deepEqual(f.transport.map((item) => item.authorization), [null, "Bearer fixture-session"]);
    } else {
      await assert.rejects(f.plugin.getComicDetail(downloadDetail), /unauthorized/);
      assert.deepEqual(f.transport.map((item) => item.authorization), [null]);
    }
  }
});

test("compiled download does not switch after an explicit current restriction, removal or rate limit", async () => {
  for (const [status, reason] of [[403, "sourceUnavailable"], [404, "notFound"], [429, "rateLimited"]] as const) {
    const f = fixture(null, {
      apiBases: [mainApi, backupApi], savedJwt: "fixture-session",
      respond: (request) => {
        assert.equal(new URL(request.url).origin, mainApi);
        assert.equal(request.headers.get("authorization"), null);
        return { status, data: { code: status } };
      },
    });
    await f.plugin.init();
    await assert.rejects(f.plugin.getComicDetail(downloadDetail), new RegExp(reason));
    assert.deepEqual(f.requests, ["/album"]);
  }
});

test("an in-flight first-save request cannot switch to a backup after the user fixes the API line", async () => {
  let requestStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { requestStarted = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const f = fixture(null, {
    apiBases: [mainApi, backupApi],
    respond: async (request) => {
      assert.equal(new URL(request.url).origin, mainApi);
      requestStarted();
      await pending;
      return { status: 503, data: "gateway" };
    },
  });
  await f.plugin.init();
  const detail = assert.rejects(f.plugin.getComicDetail(downloadDetail), /comic_download_route_unavailable/);
  await started;
  await f.plugin.onNetworkChanged({ key: "network.apiBase", value: mainApi });
  release();
  await detail;
  assert.deepEqual(f.requests, ["/album"]);
});
