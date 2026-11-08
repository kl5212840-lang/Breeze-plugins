import assert from "node:assert/strict";
import * as nodeCrypto from "node:crypto";
import { after, beforeEach, test } from "node:test";
import type { AxiosAdapter, InternalAxiosRequestConfig } from "axios";
import client, { DEFAULT_API_BASE } from "../src/client";
import { bikaRequest } from "../src/bika-request";
import { getChapter } from "../src/bika-comic-detail";
import { buildBikaImageUrl } from "../src/bika-image";
import { getSettingsBundle, saveSettings } from "../src/bika-settings";
import {
  IMAGE_QUALITIES,
  IMAGE_QUALITY_SETTING_KEY,
  BikaImageQualityChangedError,
  loadBikaImageQuality,
} from "../src/bika-image-quality";

const config = new Map<string, unknown>();
const cache = new Map<string, unknown>();
const writes: string[] = [];
const requests: { quality: string; url: string }[] = [];
let onRequest: ((request: InternalAxiosRequestConfig) => void) | undefined;
let onCacheRead: (() => void) | undefined;
let responseData: ((request: InternalAxiosRequestConfig) => unknown) | undefined;
Object.assign(globalThis, {
  nodeCryptoCompat: nodeCrypto,
  uuidv4: nodeCrypto.randomUUID,
  bridge: {
    async call(name: string, ...args: unknown[]) {
      const key = String(args[0]);
      switch (name) {
        case "load_plugin_config":
          return { ok: true, value: config.has(key) ? config.get(key) : JSON.parse(String(args[1])) };
        case "save_plugin_config":
          writes.push(key);
          config.set(key, JSON.parse(String(args[1])));
          return { ok: true };
        case "cache.get": {
          const value = cache.has(key) ? cache.get(key) : args[1];
          onCacheRead?.();
          return value;
        }
        case "cache.set":
          cache.set(key, args[1]);
          return;
        case "cache.delete":
          cache.delete(key);
          return;
        case "dart.getAppVersion":
          return "3.0.37";
        default:
          throw new Error(`Unexpected isolated bridge operation ${name}`);
      }
    },
  },
});
const originalAdapter = client.defaults.adapter;
const adapter: AxiosAdapter = async (request) => {
  requests.push({ quality: String(request.headers.get("image-quality")), url: String(request.url) });
  onRequest?.(request);
  return {
    data: responseData?.(request) ?? { code: 200, request: requests.length },
    status: 200,
    statusText: "OK",
    headers: {},
    config: request,
  };
};
beforeEach(() => {
  config.clear();
  cache.clear();
  writes.length = 0;
  requests.length = 0;
  onRequest = undefined;
  onCacheRead = undefined;
  responseData = undefined;
  client.defaults.adapter = adapter;
});
after(() => { client.defaults.adapter = originalAdapter; });

const load = () => bikaRequest({ url: `${DEFAULT_API_BASE}comics/fixture/order/1/pages?page=1`, cache: true });

test("quality schema exposes the four network choices and keeps existing original default", async () => {
  const bundle = await getSettingsBundle();
  const field = bundle.scheme.sections.flatMap((section) => section.fields)
    .find((item) => item.key === IMAGE_QUALITY_SETTING_KEY);
  assert.equal(field?.kind, "select");
  assert.equal(field?.label, "图片质量");
  assert.equal(field?.fnPath, "saveSettings");
  assert.deepEqual(field?.options, [
    { label: "原图", value: "original" },
    { label: "高清", value: "high" },
    { label: "推荐", value: "medium" },
    { label: "极度压缩", value: "low" },
  ]);
  assert.equal(bundle.data.values[IMAGE_QUALITY_SETTING_KEY], "original");
  assert.deepEqual(writes, []);
  assert.deepEqual(requests, []);
});

for (const quality of IMAGE_QUALITIES) {
  test(`${quality} save and restored config reach the wire without changing sampling or downloads`, async () => {
    const unchanged = {
      "network.apiBase": DEFAULT_API_BASE,
      "network.proxy": "2",
      "auth.authorization": "fixture-token",
      "ui.imageFilterQuality": "none",
      "download.slow": true,
      "download.fixture": { localPath: "existing-file", bytes: 120 },
    };
    for (const [key, value] of Object.entries(unchanged)) config.set(key, value);
    await saveSettings({ values: { [IMAGE_QUALITY_SETTING_KEY]: quality } });
    assert.deepEqual(writes, [IMAGE_QUALITY_SETTING_KEY]);
    for (const [key, value] of Object.entries(unchanged)) assert.deepEqual(config.get(key), value);
    assert.equal((await getSettingsBundle()).data.values[IMAGE_QUALITY_SETTING_KEY], quality);
    await load();
    assert.equal(requests[0]?.quality, quality);
    // A cloud/config restore has the same read path, without a UI-only shadow value.
    config.set(IMAGE_QUALITY_SETTING_KEY, quality);
    assert.equal(await loadBikaImageQuality(), quality);
    assert.deepEqual(writes, [IMAGE_QUALITY_SETTING_KEY]);
  });
}

test("invalid quality rejects the entire settings write before another valid field changes", async () => {
  config.set("network.proxy", "3");
  config.set(IMAGE_QUALITY_SETTING_KEY, "original");
  for (const quality of ["none", "auto", "ORIGINAL", "", 0, null, {}, " medium "]) {
    await assert.rejects(saveSettings({ values: {
      "network.proxy": "1", [IMAGE_QUALITY_SETTING_KEY]: quality,
    } }), /图片质量/);
  }
  assert.equal(config.get("network.proxy"), "3");
  assert.equal(config.get(IMAGE_QUALITY_SETTING_KEY), "original");
  assert.deepEqual(writes, []);
});

test("unknown restored quality falls back to original without rewriting the restored value", async () => {
  config.set(IMAGE_QUALITY_SETTING_KEY, "future-quality");
  assert.equal(await loadBikaImageQuality(), "original");
  assert.equal((await getSettingsBundle()).data.values[IMAGE_QUALITY_SETTING_KEY], "original");
  await load();
  assert.equal(requests[0]?.quality, "original");
  assert.equal(config.get(IMAGE_QUALITY_SETTING_KEY), "future-quality");
  assert.deepEqual(writes, []);
});

test("cache partitions follow the actual selected wire quality and reuse only matching data", async () => {
  const results = new Map<string, unknown>();
  for (const quality of IMAGE_QUALITIES) {
    config.set(IMAGE_QUALITY_SETTING_KEY, quality);
    results.set(quality, await load());
    assert.deepEqual(await load(), results.get(quality));
  }
  assert.deepEqual(requests.map((request) => request.quality), [...IMAGE_QUALITIES]);
  assert.equal(new Set([...results.values()].map((item) => JSON.stringify(item))).size, 4);
  for (const quality of [...IMAGE_QUALITIES].reverse()) {
    config.set(IMAGE_QUALITY_SETTING_KEY, quality);
    assert.deepEqual(await load(), results.get(quality));
  }
  assert.equal(requests.length, 4);
});

test("a setting change during a GET rejects its old response before it enters cache", async () => {
  onRequest = () => { config.set(IMAGE_QUALITY_SETTING_KEY, "high"); };
  await assert.rejects(load(), BikaImageQualityChangedError);
  assert.equal(requests[0]?.quality, "original");
  assert.equal([...cache.keys()].filter((key) => key.includes("requestCache")).length, 0);
  onRequest = undefined;
  await load();
  assert.equal(requests[1]?.quality, "high");
});

test("a restore during cache lookup cannot return an old-quality cached response", async () => {
  await load();
  onCacheRead = () => { config.set(IMAGE_QUALITY_SETTING_KEY, "low"); };
  await assert.rejects(load(), BikaImageQualityChangedError);
  assert.equal(requests.length, 1);
  onCacheRead = undefined;
  await load();
  assert.equal(requests[1]?.quality, "low");
});

test("a successful mutation is not reported failed when image quality changes in flight", async () => {
  onRequest = () => { config.set(IMAGE_QUALITY_SETTING_KEY, "medium"); };
  assert.deepEqual(await bikaRequest({ url: `${DEFAULT_API_BASE}users/profile`, method: "PUT", body: { slogan: "fixture" } }),
    { code: 200, request: 1 });
  assert.equal(requests[0]?.quality, "original");
});

test("non-original chapter URLs use returned server/path without invented quality rewrites", async () => {
  for (const quality of ["low", "medium", "high"] as const) {
    config.set(IMAGE_QUALITY_SETTING_KEY, quality);
    assert.equal(await buildBikaImageUrl("https://storage1.picacomic.com", "tobeimg/server-choice.webp", "comic"),
      "https://storage1.picacomic.com/tobeimg/server-choice.webp");
    assert.equal(await buildBikaImageUrl("https://storage-b.picacomic.com/", "/tobs/server-choice.jpg", "comic"),
      "https://storage-b.picacomic.com/tobs/server-choice.jpg");
    assert.equal(await buildBikaImageUrl("https://returned-cdn.example", "folder/image.webp?server=1", "comic"),
      "https://returned-cdn.example/folder/image.webp?server=1");
  }
  config.set(IMAGE_QUALITY_SETTING_KEY, "original");
  config.set("network.proxy", "1");
  assert.equal(await buildBikaImageUrl("https://storage1.picacomic.com", "folder/image.jpg", "comic"),
    "https://storage.diwodiwo.xyz/folder/image.jpg");
});

test("chapter flow carries selected quality through wire, cached metadata and returned image URLs", async () => {
  responseData = (request) => ({
    code: 200,
    data: {
      ep: { id: "ep-fixture", title: "Chapter" },
      pages: { pages: 1, docs: [{ id: "page-1", media: {
        fileServer: `https://returned-${request.headers.get("image-quality")}.example`,
        path: "folder/image.webp", originalName: "page.webp",
      } }] },
    },
  });
  for (const quality of IMAGE_QUALITIES) {
    config.set(IMAGE_QUALITY_SETTING_KEY, quality);
    const result = await getChapter({ comicId: "fixture", chapterId: 1 });
    assert.equal(result.data.chapter.pages[0]?.url, `https://returned-${quality}.example/folder/image.webp`);
    assert.equal(requests[requests.length - 1]?.quality, quality);
  }
  config.set(IMAGE_QUALITY_SETTING_KEY, "high");
  const cached = await getChapter({ comicId: "fixture", chapterId: 1 });
  assert.equal(cached.data.chapter.pages[0]?.url, "https://returned-high.example/folder/image.webp");
  assert.equal(requests.length, 4);
});
