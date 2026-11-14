import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type sourcePlugin from "../src/index.ts";

const plugin = createRequire(import.meta.url)("../dist/breeze-plugin-copy-comic.bundle.cjs")
  .default as typeof sourcePlugin;
const requestPayload = { comicId: "fixture-comic", extern: { comicFollow: true } };
const detailPath = "/api/v3/comic2/fixture-comic";
const selectedHost = "mapi.copy2000.site";
const alternateHost = "api.copy202602.com";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function detail(groups: unknown, latest: unknown = { uuid: "latest", name: "第3话" }) {
  return {
    code: 200,
    results: {
      comic: { path_word: "fixture-comic", name: "Fixture", last_chapter: latest },
      groups,
    },
  };
}

async function withFetch(
  respond: (request: Request, url: URL) => Response,
  run: (calls: URL[]) => Promise<void>,
  { auto = false, token = "" } = {},
) {
  const previousFetch = globalThis.fetch;
  const previousBridge = globalThis.bridge;
  const calls: URL[] = [];
  const configReads: string[] = [];
  const bridgeWrites: string[] = [];
  globalThis.bridge = {
    call: async (fn: string, key: string, fallback: unknown) => {
      if (fn === "load_plugin_config") {
        configReads.push(key);
        const values: Record<string, unknown> = {
          "api.domain": auto ? "auto" : "大陆专线2",
          "api.platform": "3",
          "auth.token": token,
        };
        return JSON.stringify({ ok: true, value: values[key] ?? fallback });
      }
      if (fn === "cache.get") return fallback;
      bridgeWrites.push(fn);
      return null;
    },
  } as typeof globalThis.bridge;
  globalThis.fetch = async (request) => {
    assert.ok(request instanceof Request);
    const url = new URL(request.url);
    calls.push(url);
    return respond(request, url);
  };
  try {
    await run(calls);
    assert.ok(!configReads.some((key) => key.startsWith("auth.") || key.startsWith("account.")));
    assert.deepEqual(bridgeWrites, []);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.bridge = previousBridge;
  }
}

function expectedError(reason: string, retryable?: false) {
  return (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(JSON.parse(error.message).type, "comic_follow_error");
    assert.equal(JSON.parse(error.message).reason, reason);
    if (retryable === false) assert.equal(JSON.parse(error.message).retryable, false);
    return true;
  };
}

test("public follow uses only fresh anonymous detail, even if chapters would return raw error", async () => {
  for (const token of ["", "fixture-stored-token"]) {
    let publicRequest: Request | undefined;
    await withFetch((request, url) => {
      if (url.pathname !== detailPath) return new Response("error");
      publicRequest = request;
      return json(detail({
        default: { path_word: "default", count: 2 },
        extras: { path_word: "extras", count: "1" },
      }));
    }, async (calls) => {
      const result = await plugin.getComicDetail(requestPayload);
      assert.equal(result.data.normal.comicInfo.id, requestPayload.comicId);
      assert.deepEqual(result.data.normal.extern?.comicFollow, {
        chapterCount: 3, latestChapterTitle: "第3话", latestChapterId: "latest",
      });
      assert.deepEqual(calls.map((url) => url.pathname), [detailPath]);
      assert.equal(publicRequest?.method, "GET");
      assert.equal(publicRequest?.headers.get("platform"), "3");
      assert.equal(publicRequest?.headers.has("authorization"), false);
      assert.equal(publicRequest?.credentials, "omit");
      assert.equal(publicRequest?.redirect, "manual");
    }, { token });
  }
});

test("plain-text HTTP 200 and HTML route errors have different structured failures", async () => {
  for (const [body, status, reason] of [
    ["error", 200, "invalidResponse"],
    ["<html>gateway</html>", 404, "sourceUnavailable"],
    ["<html>gateway</html>", 403, "sourceUnavailable"],
    ["", 302, "sourceUnavailable"],
  ] as const) {
    await withFetch(() => new Response(body, { status }), async (calls) => {
      await assert.rejects(plugin.getComicDetail(requestPayload), expectedError(reason));
      assert.deepEqual(calls.map((url) => url.hostname), [selectedHost]);
    });
  }
});

test("auto recovers from a directory-working route with invalid public metadata", async () => {
  await withFetch((request, url) => {
    assert.equal(request.headers.has("authorization"), false);
    if (url.hostname === selectedHost) return new Response("error");
    assert.equal(url.hostname, alternateHost);
    return json(detail([{ path_word: "default", count: 3 }]));
  }, async (calls) => {
    const result = await plugin.getComicDetail(requestPayload);
    const follow = result.data.normal.extern?.comicFollow as { chapterCount: number } | undefined;
    assert.equal(follow?.chapterCount, 3);
    assert.deepEqual(calls.map((url) => url.hostname), [selectedHost, alternateHost]);
    assert.ok(calls.every((url) => url.pathname === detailPath));
  }, { auto: true, token: "fixture-stored-token" });
});

test("auto respects explicit removal, sign-in, and throttling responses", async () => {
  for (const [status, code, message, reason] of [
    [210, 210, "該作品已下架或已合并入其他同系列作品", "notFound"],
    [403, 403, "请先登录后查看", "signInRequired"],
    [429, 429, "Too many requests", "sourceUnavailable"],
  ] as const) {
    await withFetch(() => json({ code, message }, status), async (calls) => {
      await assert.rejects(plugin.getComicDetail(requestPayload), expectedError(reason, false));
      assert.deepEqual(calls.map((url) => url.hostname), [selectedHost]);
    }, { auto: true });
  }
});

test("an alternate route's sign-in policy does not replace the selected route error", async () => {
  await withFetch((_request, url) => url.hostname === selectedHost
    ? new Response("error")
    : json({ code: 403, message: "请先登录后查看" }, 403), async (calls) => {
    await assert.rejects(plugin.getComicDetail(requestPayload), expectedError("invalidResponse"));
    assert.deepEqual(calls.map((url) => url.hostname), [selectedHost, alternateHost]);
  }, { auto: true });
});

test("a recognized app gate retries once with matching platform on the same route", async () => {
  await withFetch((request) => {
    assert.equal(request.headers.get("platform"), "3");
    return request.headers.get("user-agent")?.includes("iDOKit")
      ? json(detail([{ path_word: "default", count: 3 }]))
      : json({ code: 400, message: "请到官网更新最新App" });
  }, async (calls) => {
    const result = await plugin.getComicDetail(requestPayload);
    assert.ok(result.data.normal.extern?.comicFollow);
    assert.deepEqual(calls.map((url) => url.hostname), [selectedHost, selectedHost]);
  });
});

test("public follow refuses the wrong work and incomplete counts", async () => {
  for (const body of [
    { code: 200, results: { comic: { path_word: "other" }, groups: [] } },
    detail([{ path_word: "default", count: 1 }, { path_word: "default", count: 2 }]),
    detail([{ path_word: "default" }]),
    detail([{ path_word: "default", count: 0 }]),
    detail([{ path_word: "default", count: 3 }], { name: "no chapter ID" }),
    detail([{ path_word: "default", count: 3 }], { uuid: "latest", name: {} }),
  ]) {
    await withFetch(() => json(body), async (calls) => {
      await assert.rejects(plugin.getComicDetail(requestPayload), expectedError("invalidResponse"));
      assert.equal(calls.length, 1);
    });
  }
});

test("network rejection from the selected route stays distinct from sign-in or invalid data", async () => {
  await withFetch(() => { throw new TypeError("fetch failed"); }, async (calls) => {
    await assert.rejects(plugin.getComicDetail(requestPayload), expectedError("network"));
    assert.equal(calls.length, 1);
  });
});
