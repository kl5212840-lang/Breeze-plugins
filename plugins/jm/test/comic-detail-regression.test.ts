import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import axios from "axios";

let response: unknown;
const settings = new Map<string, unknown>();
const cache = new Map<string, unknown>();
(globalThis as any).bridge = {
  call: async (name: string, key: any, value: unknown) => {
    if (name === "cache.get") return cache.get(key) ?? value ?? null;
    if (name === "cache.set") { cache.set(key, value); return true; }
    if (name === "cache.delete") { cache.delete(key); return true; }
    if (name === "load_plugin_config") return JSON.stringify({ ok: true, value: settings.get(key) ?? JSON.parse(String(value)) });
    if (name === "save_plugin_config") { settings.set(key, JSON.parse(String(value))); return true; }
    if (name.includes("md5")) return "fixture-hash";
    if (name === "opencc.convert") return key.text;
    throw Error(`Unexpected offline fixture bridge call ${name}`);
  },
};
axios.defaults.adapter = async (config) => ({ status: 200, data: response, statusText: "fixture", headers: {}, config });
const { default: plugin } = await import("../src/index");
const { decodeResponsePayload } = await import("../src/codec");
const full = { id: 51, name: "fixture title", description: "fixture summary", tags: ["fixture tag"], total_views: "123", likes: "8", comment_total: "3" };
beforeEach(() => { response = { ...full }; settings.clear(); cache.clear(); });

test("album object-data envelope retains description, tags and explicit counts", async () => {
  response = { code: 200, data: full };
  const result = await plugin.getComicDetail({ comicId: "51" });
  const normal = result.data.normal;
  assert.equal(normal.comicInfo.id, "51");
  assert.equal(normal.comicInfo.description, full.description);
  assert.equal(normal.comicInfo.metadata.find((item) => item.type === "tags")?.value[0]?.name, "fixture tag");
  assert.equal(normal.totalViews, 123);
  assert.equal(normal.totalComments, 3);
});

test("missing or invalid optional metrics stay unknown; explicit zero remains known", async () => {
  response = { id: 51, name: "fixture title", likes: "0", total_views: "", comment_total: "bad" };
  const normal = (await plugin.getComicDetail({ comicId: "51" })).data.normal;
  assert.deepEqual(normal.extern.metricAvailability, { totalViews: false, totalLikes: true, totalComments: false });
  assert.equal(normal.totalLikes, 0);
  assert.equal(normal.comicInfo.titleMeta.some((item) => item.name.startsWith("浏览：")), false);
  assert.equal(normal.comicInfo.description, "");
  assert.equal(normal.comicInfo.metadata.length, 0);
});

for (const [name, value] of [
  ["wrong identity", { ...full, id: 52 }],
  ["empty title", { ...full, name: " " }],
  ["error document", { code: 200, msg: "fixture error" }],
  ["logical error", { ...full, code: 500 }],
] as const) {
  test(`album rejects ${name} instead of showing a successful empty detail`, async () => {
    response = value;
    await assert.rejects(plugin.getComicDetail({ comicId: "51" }), /作品资料|详情/);
  });
}

test("generic object-data decoding remains unchanged for account and mutation contracts", async () => {
  for (const payload of [
    { code: 200, data: { uid: "fixture-user", nickname: "fixture name" } },
    { code: 200, data: { status: "ok", msg: "fixture result" } },
    { code: 200, data: { list: [], total: 0 } },
  ]) {
    assert.deepEqual(await decodeResponsePayload(payload, "1"), payload);
  }
});

test("missing optional fields are distinct from legitimate empty values and invalid fragments", async () => {
  for (const [input, expected] of [
    [{ id: 51, name: "fixture" }, ["description", "tags"]],
    [{ id: 51, name: "fixture", description: "", tags: [] }, []],
    [{ id: 51, name: "fixture", description: null, tags: "bad" }, ["description", "tags"]],
    [{ id: 51, name: "fixture", description: "valid", tags: ["valid", {}] }, ["tags"]],
  ] as const) {
    response = input;
    const normal = (await plugin.getComicDetail({ comicId: "51" })).data.normal;
    assert.deepEqual(normal.extern.fieldsMissing, expected);
    assert.equal(normal.comicInfo.description.includes("[object Object]"), false);
    assert.equal(normal.comicInfo.metadata.some((item) => item.value.some((value) => value.name.includes("[object Object]"))), false);
  }
});

test("album metadata in the wrapper fills only absent nested fields, with explicit nested emptiness authoritative", async () => {
  response = { code: 200, description: "root summary", tags: ["root tag"], total_views: "7",
    data: { id: 51, name: "fixture", likes: "0", comment_total: "0" } };
  let normal = (await plugin.getComicDetail({ comicId: "51" })).data.normal;
  assert.equal(normal.comicInfo.description, "root summary");
  assert.equal(normal.comicInfo.metadata.find((item) => item.type === "tags")?.value[0]?.name, "root tag");
  assert.deepEqual(normal.extern.fieldsMissing, []);
  assert.deepEqual(normal.extern.metricAvailability, { totalViews: true, totalLikes: true, totalComments: true });
  response = { code: 200, description: "root summary", tags: ["root tag"], total_views: "7",
    data: { id: 51, name: "fixture", description: "", tags: [], total_views: null } };
  normal = (await plugin.getComicDetail({ comicId: "51" })).data.normal;
  assert.equal(normal.comicInfo.description, "");
  assert.equal(normal.comicInfo.metadata.length, 0);
  assert.deepEqual(normal.extern.fieldsMissing, []);
  assert.equal((normal.extern.metricAvailability as any).totalViews, false);
});
