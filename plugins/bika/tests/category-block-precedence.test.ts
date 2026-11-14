import assert from "node:assert/strict";
import * as nodeCrypto from "node:crypto";
import { after, beforeEach, test } from "node:test";
import client from "../src/client";
import { searchComic } from "../src/bika-comic-library";
import { getAdvancedSearchScheme } from "../src/bika-comic-scenes";
import { buildHomeAction } from "../src/bika-comic-shared";
import { getSettingsBundle } from "../src/bika-settings";

const config = new Map<string, unknown>();
const writes: string[] = [];
const cache = new Map<string, unknown>();
Object.assign(globalThis, {
  nodeCryptoCompat: nodeCrypto, uuidv4: nodeCrypto.randomUUID,
  bridge: { async call(name: string, ...args: unknown[]) {
    const key = String(args[0]);
    switch (name) {
      case "load_plugin_config": return { ok: true, value: config.has(key) ? config.get(key) : JSON.parse(String(args[1])) };
      case "save_plugin_config": writes.push(key); config.set(key, JSON.parse(String(args[1]))); return { ok: true };
      case "dart.getAppVersion": return "3.0.41";
      case "cache.get": return cache.has(key) ? cache.get(key) : args[1];
      case "cache.set": cache.set(key, args[1]); return;
      case "cache.delete": cache.delete(key); return;
      default: throw new Error(`Unexpected fixture bridge call ${name}`);
    }
  } },
});
const original = client.defaults.adapter;
let comicsOverride: unknown;
let requestedUrl = "";
const requestedMethods: string[] = [];
client.defaults.adapter = async request => {
  requestedUrl = String(request.url);
  requestedMethods.push(String(request.method).toUpperCase());
  return ({
  data: { code: 200, data: { comics: comicsOverride ?? {
    docs: [
      { _id: "setting", title: "setting", categories: ["短篇"], thumb: {} },
      { _id: "local", title: "local", categories: ["全彩"], thumb: {} },
      { _id: "visible", title: "visible", categories: ["长篇"], thumb: {} },
    ], page: 1, pages: 3, total: 60,
  } } }, status: 200, statusText: "OK", headers: {}, config: request,
}); };
beforeEach(() => {
  config.clear();
  writes.length = 0;
  requestedMethods.length = 0;
  cache.clear();
  comicsOverride = undefined;
  config.set("search.blockedCategories", ["短篇"]);
});
after(() => { client.defaults.adapter = original; });

test("page-only exclusions add to settings without rewriting the source settings", async () => {
  const response = await searchComic({ keyword: "query", extern: { blockedCategories: ["全彩"] } });
  assert.deepEqual(response.items.map(item => item.id), ["visible"]);
  assert.deepEqual(config.get("search.blockedCategories"), ["短篇"]);
  assert.ok(!writes.includes("search.blockedCategories"));
  assert.deepEqual(response.extern?.blockedCategories, { "全彩": true });
  assert.equal(response.paging?.pages, 3);
  assert.equal(response.paging?.total, 60);
});

test("clearing a page block cannot unblock settings, and settings removal really takes effect", async () => {
  let response = await searchComic({ keyword: "query", extern: { blockedCategories: [] } });
  assert.deepEqual(response.items.map(item => item.id), ["local", "visible"]);
  config.set("search.blockedCategories", []);
  response = await searchComic({ keyword: "query", extern: { blockedCategories: [] } });
  assert.deepEqual(response.items.map(item => item.id), ["setting", "local", "visible"]);
  assert.deepEqual((await getSettingsBundle()).data.values["search.blockedCategories"], []);
});

test("search distinguishes a malformed list from a genuine empty page", async () => {
  for (const comics of [{ message: "fixture" }, { docs: "invalid" }]) {
    comicsOverride = comics;
    await assert.rejects(searchComic({ keyword: "query" }), /搜索结果格式错误/);
  }
  for (const comics of [[], { docs: [], page: 1, pages: 1, total: 0 }]) {
    comicsOverride = comics;
    const result = await searchComic({ keyword: "query" });
    assert.deepEqual(result.items, []);
    assert.equal(result.paging?.total, 0);
  }
});


test("scoped Bika discovery keeps category and applies page and sort", async () => {
  for (const category of ["大家都在看", "大濕推薦", "那年今天", "官方都在看"]) {
    const action = await buildHomeAction({ title: category });
    const extern = (action as { payload: { extern: Record<string, unknown> } }).payload.extern;
    const schema = await getAdvancedSearchScheme({ extern });
    assert.deepEqual(schema.scheme.fields.map(field => field.key), ["sortBy", "blockedCategories"]);
    for (const [page, sortBy, sort] of [[1, 1, "dd"], [2, 3, "ld"], [1, 3, "ld"], [1, 1, "dd"]] as const) {
      await searchComic({ page, extern: { ...extern, sortBy } });
      const actual = new URL(requestedUrl);
      assert.equal(actual.searchParams.get("c"), category);
      assert.equal(actual.searchParams.get("page"), String(page));
      assert.equal(actual.searchParams.get("s"), sort);
    }
  }
});

test("random has no server sort or category controls", async () => {
  const action = await buildHomeAction({ title: "随机本子" });
  const extern = (action as { payload: { extern: Record<string, unknown> } }).payload.extern;
  const schema = await getAdvancedSearchScheme({ extern });
  assert.deepEqual(schema.scheme.fields.map(field => field.key), ["blockedCategories"]);
  await searchComic({ page: 2, extern });
  assert.match(requestedUrl, /\/comics\/random$/);
});


test("creator scope preserves entry sort and validates the outbound endpoint", async () => {
  const scope = { url: "https://picaapi.picacomic.com/comics?ca=writer&page=1&s=ld" };
  assert.equal((await getAdvancedSearchScheme({ extern: scope })).data.values.sortBy, 3);
  await searchComic({ page: 2, extern: scope });
  const actual = new URL(requestedUrl);
  assert.equal(actual.searchParams.get("ca"), "writer");
  assert.equal(actual.searchParams.get("page"), "2");
  assert.equal(actual.searchParams.get("s"), "ld");
  for (const url of [
    "https://unrelated.example/comics?ca=writer",
    "https://picaapi.picacomic.com/users/profile",
  ]) {
    const previous = requestedUrl;
    await assert.rejects(searchComic({ extern: { url } }), /无法识别此搜索入口/);
    assert.equal(requestedUrl, previous);
  }
  const standard = await getAdvancedSearchScheme();
  assert.deepEqual(standard.scheme.fields.map(field => field.key), ["sortBy", "categories", "blockedCategories"]);
});

test("explicit author, tag and team search use their own field with normal pagination and blocks", async () => {
  const keyword = "分 组 & t=other";
  for (const [field, parameter] of [["author", "a"], ["tag", "t"], ["team", "ct"]] as const) {
    const extern = { bikaSearchField: field, sortBy: 3, blockedCategories: ["全彩"] };
    const schema = await getAdvancedSearchScheme({ extern });
    assert.deepEqual(schema.scheme.fields.map(item => item.key), ["sortBy", "blockedCategories"]);
    comicsOverride = {
      docs: [
        { _id: "setting", title: "setting", categories: ["短篇"], thumb: {} },
        { _id: "local", title: "local", categories: ["全彩"], thumb: {} },
        { _id: "visible", title: "visible", categories: ["长篇"], thumb: {} },
      ], page: 2, pages: 3, total: 60,
    };
    const result = await searchComic({ keyword, page: 2, extern });
    const actual = new URL(requestedUrl);
    assert.equal(actual.pathname, "/comics");
    assert.deepEqual(Object.fromEntries(actual.searchParams), { [parameter]: keyword, s: "ld", page: "2" });
    assert.deepEqual(result.items.map(item => item.id), ["visible"]);
    assert.deepEqual(result.paging, { page: 2, pages: 3, total: 60, hasReachedMax: false });
    assert.equal(result.extern?.bikaSearchField, field);
  }
  assert.deepEqual(requestedMethods, ["GET", "GET", "GET"]);
  assert.deepEqual(writes, []);
});

test("invalid field scopes fail before any request and valid scoped failures do not use keyword search", async () => {
  await assert.rejects(searchComic({ keyword: "query", extern: { bikaSearchField: "constructor" } }), /搜索范围/);
  await assert.rejects(searchComic({ keyword: " ", extern: { bikaSearchField: "author" } }), /关键词/);
  assert.deepEqual(requestedMethods, []);
  comicsOverride = { docs: "malformed" };
  await assert.rejects(searchComic({ keyword: "query", extern: { bikaSearchField: "author" } }), /搜索结果格式错误/);
  assert.deepEqual(requestedMethods, ["GET"]);
});
