import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type sourcePlugin from "../src/index.ts";

const plugin = createRequire(import.meta.url)(
  process.env.BREEZE_COPY_TEST_BUNDLE ?? "../dist/breeze-plugin-copy-comic.bundle.cjs",
).default as typeof sourcePlugin;

for (const totalComments of [0, 27]) {
  test(`built detail marks unavailable views/likes without hiding ${totalComments} real comments`, async () => {
    const oldFetch = globalThis.fetch;
    const oldBridge = globalThis.bridge;
    const calls: URL[] = [];
    globalThis.bridge = {
      call: async (fn: string, key: string, fallback: unknown) => {
        if (fn === "load_plugin_config")
          return JSON.stringify({ ok: true, value: key === "auth.token" ? "" : fallback });
        if (fn === "cache.get") return fallback;
        return null;
      },
    } as typeof globalThis.bridge;
    globalThis.fetch = async (input) => {
      const request = input as Request;
      assert.equal(request.method, "GET");
      const url = new URL(request.url);
      calls.push(url);
      let results: unknown;
      if (url.pathname === "/api/v3/comic2/fixture-comic") {
        results = {
          comic: { uuid: "fixture-uuid", name: "Fixture comic", popular: 123 },
          groups: [],
        };
      } else if (url.pathname === "/api/v3/comments") {
        assert.equal(url.searchParams.get("comic_id"), "fixture-uuid");
        results = { list: [], total: totalComments, limit: 1, offset: 0 };
      } else {
        throw new Error(`Unexpected offline fixture URL: ${url.pathname}`);
      }
      return new Response(JSON.stringify({ code: 200, results }), {
        headers: { "content-type": "application/json" },
      });
    };
    try {
      const detail = await plugin.getComicDetail({ comicId: "fixture-comic" });
      const normal = detail.data.normal;
      assert.deepEqual(normal.extern?.metricAvailability, {
        totalViews: false,
        totalLikes: false,
        totalComments: true,
      });
      assert.equal(normal.totalViews, 0);
      assert.equal(normal.totalLikes, 0);
      assert.equal(normal.totalComments, totalComments);
      assert.equal(calls.filter((url) => url.pathname.endsWith("/comments")).length, 1);
    } finally {
      globalThis.fetch = oldFetch;
      globalThis.bridge = oldBridge;
    }
  });
}


for (const [name, count, status, comicPopularity, topPopularity, expectedHeat] of [
  ["network failure", 0, 503, undefined, undefined, undefined],
  ["missing field", undefined, 200, false, " ", undefined],
  ["malformed field", -1, 200, "17", 0, 0],
  ["blank field", "", 200, 17, null, 17],
  ["wrong type", false, 200, "0", undefined, 0],
] as const) {
  test(`built detail marks a comment count unknown after ${name} and preserves real heat`, async () => {
    const oldFetch = globalThis.fetch;
    const oldBridge = globalThis.bridge;
    const requested: string[] = [];
    globalThis.bridge = {
      call: async (fn: string, key: string, fallback: unknown) => {
        if (fn === "load_plugin_config")
          return JSON.stringify({ ok: true, value: key === "auth.token" ? "" : fallback });
        if (fn === "cache.get") return fallback;
        return null;
      },
    } as typeof globalThis.bridge;
    globalThis.fetch = async (input) => {
      const request = input as Request;
      const url = new URL(request.url);
      requested.push(url.pathname);
      assert.equal(request.method, "GET");
      const results = url.pathname === "/api/v3/comic2/fixture-comic"
        ? { comic: { uuid: "fixture-uuid", name: "Fixture comic", popular: comicPopularity }, groups: [], popular: topPopularity }
        : { total: count };
      const code = url.pathname === "/api/v3/comments" ? status : 200;
      return new Response(JSON.stringify({ code, results }), {
        status: code,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      const normal = (await plugin.getComicDetail({ comicId: "fixture-comic" })).data.normal;
      assert.equal(normal.totalComments, 0);
      assert.equal(normal.extern?.metricAvailability?.totalComments, false);
      assert.deepEqual(normal.comicInfo.titleMeta.filter((chip) => chip.name.startsWith("热度：")).map((chip) => chip.name),
        expectedHeat === undefined ? [] : [`热度：${expectedHeat}`]);
      assert.deepEqual(requested, ["/api/v3/comic2/fixture-comic", "/api/v3/comments"]);
    } finally {
      globalThis.fetch = oldFetch;
      globalThis.bridge = oldBridge;
    }
  });
}
