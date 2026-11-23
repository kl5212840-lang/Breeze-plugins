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

test("chapter image responses stay on the selected route and authenticated images are never reused", async () => {
  const previousBridge = globalThis.bridge;
  const previousFetch = globalThis.fetch;
  const cache = new Map<string, unknown>();
  const chapterRequests: Array<[string, string]> = [];
  let route = "大陆Copy4000";
  let token = "protected-fixture";
  globalThis.bridge = {
    async call(fn: string, key: string, value: unknown) {
      if (fn === "load_plugin_config") {
        const config: Record<string, unknown> = {
          "api.domain": route, "api.platform": "3", "auth.token": token,
        };
        return JSON.stringify({ok: true, value: config[key] ?? value});
      }
      if (fn === "cache.get") return cache.get(key) ?? value;
      if (fn === "cache.set") { cache.set(key, value); return true; }
      if (fn === "cache.response_generation") return 0;
      throw new Error(`Unexpected bridge request: ${fn}`);
    },
  } as typeof globalThis.bridge;
  globalThis.fetch = async (input) => {
    assert.ok(input instanceof Request);
    const url = new URL(input.url);
    if (url.pathname === detailPath) return comic();
    if (url.pathname === groupPath) return json({total: 1, list: [{uuid: chapterId, name: "第一话"}]});
    if (url.pathname === contentPath) {
      const auth = input.headers.get("authorization") ?? "";
      chapterRequests.push([url.hostname, auth]);
      const filename = auth ? "protected" : url.hostname;
      return json({chapter: {name: "第一话", contents: [{url: `https://cdn.example.invalid/${filename}.jpg`}], words: [0]}});
    }
    return json({});
  };
  try {
    const read = () => plugin.getReadSnapshot({comicId, chapterId});
    assert.equal((await read()).data.chapter.pages[0]?.url, "https://cdn.example.invalid/protected.jpg");
    token = "";
    assert.equal((await read()).data.chapter.pages[0]?.url, `https://cdn.example.invalid/${chosenHost}.jpg`);
    await read();
    route = "大陆专线2";
    assert.equal((await read()).data.chapter.pages[0]?.url, `https://cdn.example.invalid/${workingHost}.jpg`);
    assert.deepEqual(chapterRequests, [[chosenHost, "Token protected-fixture"], [chosenHost, ""], [workingHost, ""]]);
  } finally {
    globalThis.bridge = previousBridge;
    globalThis.fetch = previousFetch;
  }
});

test("speed-first reader uses the public winner anonymously and the fastest compatible route for a signed-in chapter", async () => {
  const previousBridge = globalThis.bridge;
  const previousFetch = globalThis.fetch;
  const hotHost = "mapi.hotmangasd.com";
  const chapterRequests: Array<[string, string | null]> = [];
  const hosts: string[] = [];
  let token = "";
  let tokenReads = 0;
  globalThis.bridge = {
    async call(fn: string, key: string, value: unknown) {
      if (fn === "load_plugin_config") {
        if (key === "auth.token") tokenReads++;
        const config: Record<string, unknown> = {
          "api.domain": "auto-speed", "api.platform": "3", "auth.token": token,
          "network.autoRoute.v1": "热辣漫画线路1",
          "network.speed.v1": {
            version: 1, probeVersion: 4, revision: "reader", measuredAt: Date.now(),
            context: { choice: "auto-speed", platform: "3" },
            results: [
              { choice: "热辣漫画线路1", host: hotHost, ok: true, ms: 10, status: 200 },
              { choice: "大陆Copy4000", host: chosenHost, ok: true, ms: 100, status: 200 },
            ],
          },
        };
        return JSON.stringify({ ok: true, value: config[key] ?? value });
      }
      if (fn === "cache.get") return value;
      if (fn === "cache.set") return true;
      throw new Error(`Unexpected bridge request: ${fn}`);
    },
  } as typeof globalThis.bridge;
  globalThis.fetch = async (input) => {
    assert.ok(input instanceof Request);
    const url = new URL(input.url);
    hosts.push(url.hostname);
    const auth = input.headers.get("authorization");
    if (url.hostname === hotHost) assert.equal(auth, null);
    if (url.pathname === detailPath) return comic();
    if (url.pathname === groupPath) return json({ total: 1, list: [{ uuid: chapterId, name: "第一话" }] });
    if (url.pathname === (url.hostname === hotHost
      ? contentPath.replace("/chapter2/", "/chapter/") : contentPath)) {
      chapterRequests.push([url.hostname, auth]);
      return json({ chapter: { name: "第一话", contents: [{ url: "https://cdn.example.invalid/1.jpg" }], words: [0] } });
    }
    return json({ collect: null });
  };
  try {
    const read = () => plugin.getReadSnapshot({ comicId, chapterId });
    assert.equal((await read()).data.chapter.pages.length, 1);
    token = "reader-token";
    assert.equal((await read()).data.chapter.pages.length, 1);
    assert.deepEqual(chapterRequests, [[hotHost, null], [chosenHost, "Token reader-token"]]);

    hosts.length = 0;
    const previousTokenReads = tokenReads;
    const follow = await plugin.getComicDetail({ comicId, extern: { comicFollow: true } });
    assert.equal(follow.data.normal.extern?.comicFollow?.latestChapterId, chapterId);
    assert.deepEqual(hosts, [hotHost]);
    assert.equal(tokenReads, previousTokenReads);
  } finally {
    globalThis.bridge = previousBridge;
    globalThis.fetch = previousFetch;
  }
});

test("two alternates are bounded and a wrong-work reply cannot become a detail", () =>
  fixture((url) => url.hostname === workingHost ? comic("wrong-work") : new Response("error"), async (calls) => {
    await assert.rejects(plugin.getComicDetail({ comicId }), reason("comic_detail_error", "invalidResponse"));
    assert.deepEqual(calls.map((url) => url.hostname), [chosenHost, workingHost, appHost]);
  }));

async function verifiedMirrorFixture(
  respond: (url: URL, request: Request) => Response | Promise<Response>,
  verify: (state: { calls: URL[]; settings: Map<string, unknown> }) => Promise<void>,
  { expired = false }: { expired?: boolean } = {},
) {
  const formerBridge = globalThis.bridge, formerFetch = globalThis.fetch;
  const mirror = "mapi.hotmangasd.com";
  const settings = new Map<string, unknown>([
    ["api.domain", "auto-speed"], ["api.platform", "3"], ["auth.token", "fixture-token"],
    ["network.autoRoute.v1", "热辣漫画线路1"],
    ["network.speed.v1", {
      version: 1, probeVersion: 4, revision: "reader-mirror", measuredAt: Date.now() - (expired ? 21 * 60_000 : 0),
      context: { choice: "auto-speed", platform: "3" },
      results: [
        { choice: "热辣漫画线路1", host: mirror, ok: true, ms: 15, status: 200 },
        { choice: "大陆Copy4000", host: chosenHost, ok: true, ms: 100, status: 200 },
      ],
    }],
  ]);
  const calls: URL[] = [];
  globalThis.bridge = {
    async call(fn: string, key: string, value: unknown) {
      if (fn === "load_plugin_config") return JSON.stringify({ ok: true, value: settings.get(key) ?? value });
      if (fn === "save_plugin_config") { settings.set(key, JSON.parse(String(value))); return '{"ok":true}'; }
      if (fn === "cache.get") return value;
      if (fn === "cache.set") return true;
      throw new Error(`Unexpected bridge request: ${fn}`);
    },
  } as typeof globalThis.bridge;
  globalThis.fetch = async (input) => {
    assert.ok(input instanceof Request);
    const url = new URL(input.url);
    calls.push(url);
    if (url.hostname === mirror) {
      assert.equal(input.headers.get("authorization"), null);
      assert.equal(input.credentials, "omit");
    }
    return respond(url, input);
  };
  try {
    await verify({ calls, settings });
  } finally {
    globalThis.bridge = formerBridge;
    globalThis.fetch = formerFetch;
  }
}

const mirrorHost = "mapi.hotmangasd.com";
const mirrorChapterPath = contentPath.replace("/chapter2/", "/chapter/");
const routeUnavailable = () => new Response("Unavailable", { status: 503 });
const publicChapter = (id = chapterId) => json({
  comic: { path_word: comicId, name: "Fixture" },
  chapter: { uuid: id, comic_path_word: comicId, name: "第一话", contents: [{ url: "https://cdn.example.invalid/mirror.jpg" }], words: [0] },
});

test("speed-first signed-in normal detail falls back only to the verified public mirror on a temporary outage", () =>
  verifiedMirrorFixture((url) => {
    if (url.hostname !== mirrorHost) return routeUnavailable();
    if (url.pathname === detailPath) return comic();
    if (url.pathname === groupPath) return json({ total: 1, list: [{ uuid: chapterId, name: "第一话" }] });
    return json({ total: 0 });
  }, async ({ calls, settings }) => {
    const result = await plugin.getComicDetail({ comicId });
    assert.equal(result.data.normal.eps[0]?.id, chapterId);
    assert.deepEqual(calls.filter((url) => url.pathname === detailPath).map((url) => url.hostname), [chosenHost, mirrorHost]);
    assert.equal(settings.get("api.domain"), "auto-speed");
    assert.equal(settings.get("network.autoRoute.v1"), "热辣漫画线路1");
  }));

test("speed-first reader recovers from chapter transport failure and proves the requested work/episode anonymously", async () => {
  for (const returnedId of [chapterId, "wrong-chapter"]) {
    await verifiedMirrorFixture((url, request) => {
      if (url.pathname === detailPath) return comic();
      if (url.pathname === groupPath) return json({ total: 1, list: [{ uuid: chapterId, name: "第一话" }] });
      if (url.hostname === chosenHost && url.pathname === contentPath) {
        assert.equal(request.headers.has("authorization"), true);
        return routeUnavailable();
      }
      if (url.hostname === mirrorHost && url.pathname === mirrorChapterPath) return publicChapter(returnedId);
      return json({ total: 0 });
    }, async ({ calls }) => {
      const pending = plugin.getReadSnapshot({ comicId, chapterId });
      if (returnedId === chapterId) {
        assert.equal((await pending).data.chapter.pages[0]?.url, "https://cdn.example.invalid/mirror.jpg");
      } else {
        await assert.rejects(pending, reason("comic_detail_error", "invalidResponse"));
      }
      assert.deepEqual(calls.filter((url) => /\/chapter2?\//.test(url.pathname)).map((url) => url.hostname), [chosenHost, mirrorHost]);
    });
  }
});

test("speed-first mirror recovery observes access limits, stale speed results and a later manual pin", async () => {
  for (const [status, message] of [[401, "请先登录后查看"], [451, "地区限制"], [429, "请求过多"], [404, "作品已下架"]] as const) {
    await verifiedMirrorFixture(() => Response.json({ code: status, message }, { status }), async ({ calls }) => {
      await assert.rejects(plugin.getComicDetail({ comicId }));
      assert.equal(calls.some((url) => url.hostname === mirrorHost), false);
    });
  }
  await verifiedMirrorFixture(routeUnavailable, async ({ calls }) => {
    await assert.rejects(plugin.getComicDetail({ comicId }));
    assert.equal(calls.some((url) => url.hostname === mirrorHost), false);
  }, { expired: true });

  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((done) => { entered = done; });
  const held = new Promise<void>((done) => { release = done; });
  await verifiedMirrorFixture(async (url) => {
    if (url.hostname !== mirrorHost) return routeUnavailable();
    entered();
    await held;
    return comic();
  }, async ({ calls, settings }) => {
    const pending = plugin.getComicDetail({ comicId });
    await started;
    await plugin.saveSettings({ key: "api.domain", value: "官方App线路" });
    release();
    await assert.rejects(pending);
    assert.equal(settings.get("api.domain"), "官方App线路");
    assert.equal(calls.filter((url) => url.hostname === mirrorHost).length, 1);
  });
});

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
