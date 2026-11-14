import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type sourcePlugin from "../src/index.ts";

const plugin = createRequire(import.meta.url)(
  process.env.BREEZE_COPY_DETAIL_BUNDLE ?? "../dist/breeze-plugin-copy-comic.bundle.cjs",
).default as typeof sourcePlugin;
const chosenHost = "api.copy4000.com";
const workingHost = "mapi.copy2000.site";
const appHost = "api.copy202602.com";
const comicId = "fixture-comic";
const chapterId = "chapter-1";
const detailPath = `/api/v3/comic2/${comicId}`;
const groupPath = `/api/v3/comic/${comicId}/group/default/chapters`;
const contentPath = `/api/v3/comic/${comicId}/chapter2/${chapterId}`;

function json(results: unknown) {
  return new Response(JSON.stringify({ code: 200, results }));
}

function comic(pathWord = comicId) {
  return json({
    comic: { path_word: pathWord, uuid: "fixture-uuid", name: "Fixture", last_chapter: { uuid: chapterId, name: "第一话" } },
    groups: { default: { path_word: "default", name: "正文", count: 1 } },
  });
}

async function fixture(
  respond: (url: URL, request: Request) => Response,
  run: (calls: URL[]) => Promise<void>,
  { manual = false, token = "" } = {},
) {
  const formerBridge = globalThis.bridge;
  const formerFetch = globalThis.fetch;
  const calls: URL[] = [];
  const cache = new Map<string, unknown>();
  globalThis.bridge = {
    call: async (fn: string, key: string, value: unknown) => {
      if (fn === "load_plugin_config") {
        const config: Record<string, unknown> = {
          "api.domain": manual ? "大陆Copy4000" : "auto",
          "api.platform": "3", "network.autoRoute.v1": "大陆Copy4000", "auth.token": token,
        };
        return JSON.stringify({ ok: true, value: config[key] ?? value });
      }
      if (fn === "cache.get") return cache.get(key) ?? value;
      if (fn === "cache.set") { cache.set(key, value); return true; }
      throw new Error(`Unexpected bridge write: ${fn}`);
    },
  } as typeof globalThis.bridge;
  globalThis.fetch = async (input) => {
    assert.ok(input instanceof Request);
    const url = new URL(input.url);
    calls.push(url);
    if (url.pathname === `${detailPath}/query`) {
      assert.equal(url.hostname, chosenHost, "the account query keeps its own route");
      assert.equal(input.headers.get("authorization"), `Token ${token}`);
      assert.equal(input.headers.get("platform"), "1");
      return json({});
    }
    assert.equal(input.headers.get("authorization"), null, "public recovery cannot send the account token");
    assert.equal(input.headers.get("platform"), "3");
    return respond(url, input);
  };
  try { await run(calls); }
  finally { globalThis.bridge = formerBridge; globalThis.fetch = formerFetch; }
}

function reason(kind: string, expected: string) {
  return (error: unknown) => {
    assert.ok(error instanceof Error);
    const decoded = JSON.parse(error.message);
    assert.equal(decoded.type, kind);
    if (kind !== "unauthorized") assert.equal(decoded.reason, expected);
    return true;
  };
}

test("built detail and reader recover from Copy4000 plain error on one route without sending credentials to the alternate", () =>
  fixture((url, request) => {
    if (url.hostname === chosenHost && url.pathname === detailPath) return new Response("error");
    assert.equal(url.hostname, workingHost);
    const app = request.headers.get("user-agent")?.includes("iDOKit");
    if (url.pathname === detailPath && !app) return new Response(JSON.stringify({ code: 210, message: "请到官网更新最新App" }), { status: 210 });
    assert.ok(app, "downstream requests should use the app profile proven by detail");
    if (url.pathname === detailPath) return comic();
    if (url.pathname === groupPath) return json({ total: 1, list: [{ uuid: chapterId, name: "第一话" }] });
    if (url.pathname === contentPath) {
      assert.equal(request.credentials, "omit");
      assert.equal(request.redirect, "error");
      return json({ chapter: { name: "第一话", contents: [{ url: "https://cdn.example.invalid/1.jpg" }], words: [0] } });
    }
    if (url.pathname === "/api/v3/comments") return json({ total: 3 });
    throw new Error(`Unexpected offline URL: ${url.pathname}`);
  }, async (calls) => {
    const detail = await plugin.getComicDetail({ comicId });
    assert.equal(detail.data.normal.comicInfo.id, comicId);
    assert.deepEqual(detail.data.normal.eps.map((ep) => ep.id), [chapterId]);
    assert.equal(detail.data.normal.totalComments, 3);
    const read = await plugin.getReadSnapshot({ comicId, chapterId });
    assert.equal(read.data.chapter.id, chapterId);
    assert.equal(read.data.chapter.pages.length, 1);
    assert.ok(calls.filter((url) => url.pathname === groupPath || url.pathname === contentPath)
      .every((url) => url.hostname === workingHost));
  }, { token: "fixture-account-token" }));

test("a successful detail with a malformed chapter list switches the entire read to the same alternate work", () =>
  fixture((url) => {
    if (url.pathname === detailPath) return comic();
    if (url.pathname === groupPath) return url.hostname === chosenHost
      ? new Response("error") : json({ total: 1, list: [{ uuid: chapterId, name: "第一话" }] });
    return json({});
  }, async (calls) => {
    const result = await plugin.getComicDetail({ comicId });
    assert.equal(result.data.normal.eps.length, 1);
    assert.deepEqual(calls.filter((url) => url.pathname === detailPath || url.pathname === groupPath).map((url) => url.hostname),
      [chosenHost, chosenHost, workingHost, workingHost]);
  }));

test("two alternates are bounded and a wrong-work reply cannot become a detail", () =>
  fixture((url) => url.hostname === workingHost ? comic("wrong-work") : new Response("error"), async (calls) => {
    await assert.rejects(plugin.getComicDetail({ comicId }), reason("comic_detail_error", "invalidResponse"));
    assert.deepEqual(calls.map((url) => url.hostname), [chosenHost, workingHost, appHost]);
  }));

test("hand selection stays pinned and definitive access limits do not try another host", async () => {
  await fixture(() => new Response("error"), async (calls) => {
    await assert.rejects(plugin.getComicDetail({ comicId }), reason("comic_detail_error", "invalidResponse"));
    assert.deepEqual(calls.map((url) => url.hostname), [chosenHost]);
  }, { manual: true });
  for (const [message, kind, failure] of [
    ["请先登录后查看", "unauthorized", ""],
    ["该作品有地区限制", "comic_detail_error", "sourceUnavailable"],
  ] as const) {
    await fixture(() => new Response(JSON.stringify({ code: 403, message }), { status: 403 }), async (calls) => {
      await assert.rejects(plugin.getComicDetail({ comicId }), reason(kind, failure));
      assert.deepEqual(calls.map((url) => url.hostname), [chosenHost]);
    });
  }
});
