import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type sourcePlugin from "../src/index.ts";

const plugin = createRequire(import.meta.url)("../dist/breeze-plugin-copy-comic.bundle.cjs")
  .default as typeof sourcePlugin;

async function withSearchResponse(
  response: unknown,
  run: () => Promise<void>,
  expectedPaths = ["/api/v3/search/comic"],
) {
  const oldFetch = globalThis.fetch;
  const oldBridge = globalThis.bridge;
  globalThis.bridge = {
    call: async (fn: string, _key: string, fallback: unknown) => {
      if (fn === "load_plugin_config") return JSON.stringify({ ok: true, value: fallback });
      if (fn === "cache.get") return fallback;
      return null;
    },
  } as typeof globalThis.bridge;
  globalThis.fetch = async (input) => {
    const request = input as Request;
    assert.equal(request.method, "GET");
    assert.ok(expectedPaths.includes(new URL(request.url).pathname));
    return new Response(JSON.stringify(typeof response === "function" ? response(new URL(request.url)) : response), {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await run();
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.bridge = oldBridge;
  }
}

test("built search rejects successful business envelopes without a valid list", async () => {
  for (const results of [undefined, null, [], "error page", {}, { list: null }, { list: {} }]) {
    await withSearchResponse({ code: 200, results }, async () => {
      await assert.rejects(plugin.searchComic({ keyword: "fixture" }), /搜索结果格式错误/);
    });
  }
});

test("built search rejects malformed rows rather than silently dropping them", async () => {
  for (const invalid of [null, "error page", [], {}, { name: "missing identity" }]) {
    for (const list of [[invalid], [{ path_word: "valid", name: "Valid" }, invalid]]) {
      await withSearchResponse({ code: 200, results: { list } }, async () => {
        await assert.rejects(plugin.searchComic({ keyword: "fixture" }), /搜索结果格式错误/);
      });
    }
  }
});

test("built search preserves legitimate empty and legacy wrapped comic rows", async () => {
  for (const list of [
    [],
    [{ path_word: "flat", name: "Flat" }],
    [{ comic: { path_word: "comic", name: "Comic" } }],
    [{ book: { path_word: "book", name: "Book" } }],
  ]) {
    await withSearchResponse({ code: 200, results: { list, total: list.length } }, async () => {
      const result = await plugin.searchComic({ keyword: "fixture" });
      assert.equal(result.data.items.length, list.length);
      assert.deepEqual(result.items, result.data.items);
      assert.deepEqual(result.paging, result.data.paging);
      assert.equal(result.data.paging.total, list.length);
      if (list.length) assert.ok(result.data.items[0].id);
    });
  }
});

test("built search keeps non-success business responses as failures", async () => {
  await withSearchResponse(
    { code: 503, message: "fixture failure", results: { list: [] } },
    async () => {
      await assert.rejects(plugin.searchComic({ keyword: "fixture" }), /fixture failure/);
    },
  );
});

test("built topic lookup and explicit topic search use the site taxonomy and paged comics directory", async () => {
  const paths: string[] = [];
  const extern = { copySearchTopic: true, copySearchVariants: ["競技"] };
  await withSearchResponse((url: URL) => {
    paths.push(url.pathname);
    if (url.pathname.endsWith("/theme/comic/count")) {
      return { code: 200, results: { total: 1, list: [{ name: "競技", path_word: "jingji" }] } };
    }
    assert.equal(url.searchParams.get("theme"), "jingji");
    assert.equal(url.searchParams.get("q"), null);
    assert.equal(url.searchParams.get("q_type"), null);
    assert.equal(url.searchParams.get("limit"), "20");
    const offset = Number(url.searchParams.get("offset"));
    return { code: 200, results: {
      total: 21, limit: 20, offset,
      list: Array.from({ length: offset === 0 ? 20 : 1 }, (_, index) => ({
        name: "Fixture", path_word: `topic-${offset + index}`, theme: [],
      })),
    } };
  }, async () => {
    assert.deepEqual(
      (await plugin.resolveSearchTopic({ keyword: "竞技", variants: ["競技"] })).topic,
      { label: "競技", value: "jingji" },
    );
    const first = await plugin.searchComic({ keyword: "竞技", extern });
    assert.equal(first.data.items[0]?.id, "topic-0");
    assert.equal(first.data.paging.total, 21);
    assert.equal(first.data.paging.hasReachedMax, false);
    const next = await plugin.searchComic({ page: 2, extern: { copySearchTopic: "jingji" } });
    assert.deepEqual(next.data.items.map((item) => item.id), ["topic-20"]);
    assert.equal(next.data.paging.total, 21);
    assert.equal(next.data.paging.hasReachedMax, true);
    const unknown = await plugin.searchComic({ keyword: "競", extern: { copySearchTopic: true } });
    assert.deepEqual(unknown.data.items, []);
    assert.equal(unknown.data.paging.total, 0);
    assert.equal(unknown.data.paging.hasReachedMax, true);
    const invalid = await plugin.searchComic({ extern: { copySearchTopic: "../search" } });
    assert.deepEqual(invalid.data.items, []);
  }, ["/api/v3/theme/comic/count", "/api/v3/comics"]);
  assert.equal(paths.filter((path) => path === "/api/v3/comics").length, 2);
});

test("directory functions distinguish a real empty list from a broken response", async () => {
  const routes = [
    [plugin.getHomeRecommend, ["/api/v3/recs"]],
    [plugin.getHomeNewest, ["/api/v3/update/newest", "/api/v3/comics"]],
    [plugin.getHomeDiscover, ["/api/v3/comics"]],
    [plugin.getHomeRank, ["/api/v3/ranks"]],
  ] as const;
  for (const [read, paths] of routes) {
    for (const results of [{}, { list: [null, { name: "missing identity" }] }]) {
      await withSearchResponse({ code: 200, results }, async () => {
        await assert.rejects(read(), /目录响应不完整/);
      }, [...paths]);
    }
    for (const list of [[], [{ comic: { path_word: "valid", name: "Valid" } }]]) {
      await withSearchResponse({ code: 200, results: { list } }, async () => {
        assert.equal((await read()).data.items.length, list.length);
      }, [...paths]);
    }
  }
});
