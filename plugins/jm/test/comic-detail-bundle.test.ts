import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as crypto from "node:crypto";
import vm from "node:vm";
import { test } from "node:test";

const bundle = readFileSync(new URL("../dist/breeze-plugin-jm-comic.bundle.cjs", import.meta.url), "utf8");
function fixture(payload: unknown) {
  const requests: string[] = [], settings = new Map(), cache = new Map();
  const context = vm.createContext({
    module: { exports: {} }, exports: {}, URL, URLSearchParams, Request, Response, Headers,
    FormData, Blob, AbortController, TextEncoder, TextDecoder, structuredClone,
    setTimeout, clearTimeout, ArrayBuffer, Uint8Array, DataView,
    nodeCryptoCompat: crypto, uuidv4: crypto.randomUUID,
    console: { info() {}, warn() {}, log() {}, error() {} },
    async fetch(input: Request | string, init?: RequestInit) {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(new URL(request.url).pathname);
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
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
  return { plugin: context.module.exports.default, requests };
}

test("compiled 0.3.9 album normalizes only the detail envelope and preserves public metadata", async () => {
  const f = fixture({ code: 200, data: { id: 51, name: "fixture", description: "summary", tags: ["tag"], total_views: "7", likes: "0" } });
  assert.equal((await f.plugin.getInfo()).version, "0.3.9");
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
