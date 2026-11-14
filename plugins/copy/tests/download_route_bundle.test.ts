import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import type sourcePlugin from "../src/index.ts";

const plugin = createRequire(import.meta.url)(
  process.env.BREEZE_COPY_DOWNLOAD_BUNDLE ?? "../dist/breeze-plugin-copy-comic.bundle.cjs",
).default as typeof sourcePlugin;
const chosen = "api.copy4000.com",
  working = "mapi.copy2000.site",
  official = "api.copy202602.com";
const comicId = "fixture-comic",
  chapterId = "fixture-chapter",
  workUuid = "fixture-work-uuid";
const exactPath = `/api/v3/comic/${comicId}/chapter2/${chapterId}`;
const aliasPath = `/api/v3/comic/${comicId}/chapter/${chapterId}`;
const key = (host: string) => `copy:${host}`;
const imageAccept = "image/avif,image/webp,image/apng,image/*,*/*;q=0.8";
const requestDownload = (excluded: string[] = []) => ({
  comicId,
  chapterId,
  downloadRoute: { version: 1, excluded },
});

function json(results: unknown) {
  return new Response(JSON.stringify({ code: 200, results }));
}

function gate(code: number, message: string) {
  return new Response(JSON.stringify({ code, message }), { status: code });
}

function manifest(changes: Record<string, unknown> = {}) {
  return json({
    comic: { path_word: comicId, uuid: workUuid, name: "Work" },
    chapter: {
      uuid: chapterId,
      comic_id: workUuid,
      comic_path_word: comicId,
      name: "Chapter",
      contents: [
        { url: "https://img.example/second/001.webp" },
        { url: "https://img.example/first/001.webp" },
      ],
      words: [1, 0],
      ...changes,
    },
  });
}

function isFailure(kind: string, reason?: string, retryable?: boolean) {
  return (error: unknown) => {
    assert.ok(error instanceof Error);
    const data = JSON.parse(error.message);
    assert.equal(data.type, kind);
    if (reason !== undefined) assert.equal(data.reason, reason);
    if (retryable !== undefined) assert.equal(data.retryable, retryable);
    return true;
  };
}

async function fixture(
  respond: (url: URL, request: Request) => Response | Promise<Response>,
  run: (calls: Request[], cacheReads: string[], config: Record<string, unknown>) => Promise<void>,
  options: { choice?: string; token?: string; credentials?: object; chapterCache?: unknown } = {},
) {
  const oldBridge = globalThis.bridge,
    oldFetch = globalThis.fetch;
  const calls: Request[] = [],
    cacheReads: string[] = [];
  const config: Record<string, unknown> = {
    "api.domain": options.choice ?? "auto",
    "api.platform": "3",
    "network.autoRoute.v1": "大陆Copy4000",
    "auth.token": options.token ?? "",
    "account.credentials": options.credentials ?? null,
  };
  const cache = new Map<string, unknown>();
  if (options.chapterCache)
    cache.set(`copyComic:getChapter:v1:${comicId}:${chapterId}`, options.chapterCache);
  globalThis.bridge = {
    call: async (fn: string, name: string, value: unknown) => {
      if (fn === "load_plugin_config")
        return JSON.stringify({ ok: true, value: config[name] ?? value });
      if (fn === "cache.get") {
        cacheReads.push(name);
        return cache.get(name) ?? value;
      }
      if (fn === "cache.set") {
        cache.set(name, value);
        return true;
      }
      throw new Error(`Unexpected fixture bridge call ${fn}`);
    },
  } as typeof globalThis.bridge;
  globalThis.fetch = async (input) => {
    assert.ok(input instanceof Request);
    calls.push(input);
    return respond(new URL(input.url), input);
  };
  try {
    await run(calls, cacheReads, config);
  } finally {
    globalThis.bridge = oldBridge;
    globalThis.fetch = oldFetch;
  }
}

const hosts = (calls: Request[]) => calls.map((request) => new URL(request.url).hostname);

test("the built download resolves the requested chapter fresh, using the endpoint alias and App profile", () =>
  fixture(
    (url, request) => {
      assert.ok([exactPath, aliasPath].includes(url.pathname));
      assert.equal(url.search, "?platform=1");
      assert.equal(request.headers.get("platform"), "3");
      assert.equal(request.headers.get("authorization"), null);
      if (url.hostname === chosen) return new Response("error");
      assert.equal(url.hostname, working);
      if (url.pathname === exactPath) return new Response("", { status: 404 });
      if (!request.headers.get("user-agent")?.includes("iDOKit"))
        return gate(210, "请到官网更新最新App");
      return manifest();
    },
    async (calls, cacheReads) => {
      const result = await plugin.getChapter(requestDownload());
      const chapter = result.data.chapter;
      assert.equal(chapter.id, chapterId);
      assert.equal(result.data.comic.id, comicId);
      assert.deepEqual(chapter.extern.downloadRoute, {
        version: 1,
        key: key(working),
        apiHost: working,
      });
      assert.deepEqual(
        chapter.pages.map((page) => page.url),
        ["https://img.example/first/001.webp", "https://img.example/second/001.webp"],
      );
      assert.equal(new Set(chapter.pages.map((page) => page.path)).size, 2);
      assert.ok(chapter.pages.every((page) => page.extern?.copyDownloadRouteVersion === 1));
      assert.ok(chapter.pages.every((page) => page.extern?.backgroundDownload === undefined));
      assert.deepEqual(hosts(calls), [chosen, working, working, working]);
      assert.ok(!cacheReads.some((name) => name.includes("getChapter")));
    },
    {
      token: "fixture-token",
      chapterCache: {
        ts: Date.now(),
        chapter: { docs: [{ url: "https://stale.example/old.jpg" }] },
      },
    },
  ));

test("excluded route keys advance the same chapter without touching the selected or failed route", () =>
  fixture(
    () => manifest(),
    async (calls) => {
      const first = await plugin.getChapter(requestDownload());
      const next = await plugin.getChapter(requestDownload([key(chosen)]));
      const last = await plugin.getChapter(requestDownload([key(chosen), key(working)]));
      assert.deepEqual(hosts(calls), [chosen, working, official]);
      assert.deepEqual(
        [first, next, last].map((item) => item.data.chapter.extern.downloadRoute),
        [chosen, working, official].map((host) => ({ version: 1, key: key(host), apiHost: host })),
      );
      await assert.rejects(
        plugin.getChapter(requestDownload(["https://invalid.example/path"])),
        isFailure("comic_detail_error", "invalidResponse", false),
      );
      await assert.rejects(
        plugin.getChapter(requestDownload(["a", "b", "c", "d"])),
        isFailure("comic_detail_error", "invalidResponse", false),
      );
      assert.equal(calls.length, 3);
    },
  ));

test("the exhausted route pass rejects wrong chapter, wrong work, and a manifest with a bad page", () =>
  fixture(
    (url) => {
      if (url.hostname === chosen) return manifest({ uuid: "another-chapter" });
      if (url.hostname === working) return manifest({ comic_id: "another-work-id" });
      return manifest({
        contents: [{ url: "https://img.example/ok.jpg" }, { url: "file:///bad.jpg" }],
      });
    },
    async (calls) => {
      await assert.rejects(
        plugin.getChapter(requestDownload()),
        isFailure("comic_download_route_unavailable"),
      );
      assert.deepEqual(hosts(calls), [chosen, working, official]);
    },
  ));

test("network and gateway exhaustion uses the v1 error while legacy callers retain their errors", async () => {
  for (const respond of [
    () => {
      throw new TypeError("fixture connection failed");
    },
    () => new Response("Unavailable", { status: 503 }),
  ]) {
    await fixture(respond, async (calls) => {
      await assert.rejects(
        plugin.getChapter(requestDownload()),
        isFailure("comic_download_route_unavailable"),
      );
      assert.deepEqual(hosts(calls), [chosen, working, official]);
    });
  }
  for (const manual of [true, false]) {
    await fixture(
      () => new Response("error"),
      async (calls) => {
        await assert.rejects(
          plugin.getChapter(manual ? requestDownload() : { comicId, chapterId }),
          manual
            ? isFailure("comic_download_route_unavailable")
            : isFailure("comic_detail_error", "invalidResponse", true),
        );
        assert.deepEqual(hosts(calls), manual ? [chosen] : [chosen, working, official]);
      },
      { choice: manual ? "大陆Copy4000" : "auto" },
    );
  }
});

test("a route preference change stops the v1 pass with its explicit error", () => {
  let config: Record<string, unknown>;
  return fixture(
    () => {
      config["api.domain"] = "大陆专线2";
      return new Response("error");
    },
    async (calls, _, settings) => {
      config = settings;
      await assert.rejects(
        plugin.getChapter(requestDownload()),
        isFailure("comic_detail_error", "sourceUnavailable", false),
      );
      assert.deepEqual(hosts(calls), [chosen]);
    },
  );
});

test("an unresponsive candidate uses only its part of the chapter deadline", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  try {
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let firstSignal: AbortSignal | undefined;
    await fixture(
      (url, request) => {
        if (url.hostname !== chosen) return manifest();
        firstSignal = request.signal;
        return new Promise<Response>((_, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), {
            once: true,
          });
          enter();
        });
      },
      async (calls) => {
        const pending = plugin.getChapter(requestDownload());
        await entered;
        context.mock.timers.tick(4_001);
        const result = await pending;
        assert.equal(firstSignal?.aborted, true);
        assert.deepEqual(hosts(calls), [chosen, working]);
        assert.equal(result.data.chapter.extern.downloadRoute?.key, key(working));
      },
    );
  } finally {
    context.mock.timers.reset();
  }
});

test("the archived real chapter schema proves the work and returns every actual page", () => {
  const archive = JSON.parse(readFileSync(new URL("../test_result.json", import.meta.url), "utf8"));
  const { chapter } = archive.results;
  return fixture(
    () => json(archive.results),
    async (calls) => {
      const result = await plugin.getChapter({
        comicId: chapter.comic_id,
        chapterId: chapter.uuid,
        downloadRoute: { version: 1, excluded: [] },
      });
      assert.equal(result.data.chapter.id, chapter.uuid);
      assert.equal(result.data.chapter.pages.length, chapter.contents.length);
      for (const page of result.data.chapter.pages) {
        assert.deepEqual(page.extern?.backgroundDownload, {
          version: 1,
          credentialFree: true,
          redirectPolicy: "same-url",
          headers: { Accept: imageAccept },
        });
      }
      assert.equal(calls.length, 1);
      assert.equal(
        new URL(calls[0]!.url).pathname,
        `/api/v3/comic/${chapter.comic_id}/chapter2/${chapter.uuid}`,
      );
    },
  );
});

test("non-public or noncanonical pages retain the plugin fetch path", () => {
  const urls = [
    "https://so.mangafunb.fun/page.jpg?signature=secret",
    "https://so.mangafunb.fun/page.jpg#anchor",
    "http://so.mangafunb.fun/page.jpg",
    "https://so.mangafunb.fun:8443/page.jpg",
    "https://so.mangafunb.fun.example/page.jpg",
    "https://127.0.0.1/page.jpg",
  ];
  return fixture(
    () => manifest({ contents: urls.map((url) => ({ url })) }),
    async () => {
      const result = await plugin.getChapter(requestDownload());
      assert.deepEqual(result.data.chapter.pages.map((page) => page.url), urls);
      assert.ok(result.data.chapter.pages.every((page) => page.extern?.backgroundDownload === undefined));
    },
  );
});

test("only the selected and approved origin receives the existing token after a real login gate", () =>
  fixture(
    (url, request) => {
      assert.equal(url.hostname, chosen);
      if (!request.headers.has("authorization")) return gate(403, "请先登录后查看");
      assert.equal(request.headers.get("authorization"), "Token fixture-token");
      assert.equal(request.credentials, "omit");
      assert.equal(request.redirect, "error");
      return manifest({ contents: [{ url: "https://so.mangafunb.fun/page.jpg" }] });
    },
    async (calls) => {
      const { chapter } = (await plugin.getChapter(requestDownload())).data;
      assert.equal(chapter.id, chapterId);
      assert.deepEqual(chapter.pages[0]?.extern?.backgroundDownload, {
        version: 1,
        credentialFree: true,
        redirectPolicy: "same-url",
        headers: { Accept: imageAccept },
      });
      assert.deepEqual(hosts(calls), [chosen, chosen]);
      assert.equal(calls[0]!.headers.has("authorization"), false);
    },
    { token: "fixture-token" },
  ));

test("login, explicit removal, restrictions and throttling keep their original boundary", async () => {
  for (const [code, message, kind, reason] of [
    [403, "请先登录后查看", "unauthorized", undefined],
    [403, "该章节有地区限制", "comic_detail_error", "sourceUnavailable"],
    [404, "章节不存在", "comic_detail_error", "notFound"],
    [429, "请求频繁", "comic_detail_error", "rateLimited"],
  ] as const) {
    await fixture(
      () => gate(code, message),
      async (calls) => {
        await assert.rejects(
          plugin.getChapter(requestDownload()),
          isFailure(kind, reason, reason && (code === 429)),
        );
        assert.deepEqual(hosts(calls), [chosen]);
      },
    );
  }
  await fixture(
    (url, request) => {
      assert.equal(request.headers.get("authorization"), null);
      return url.hostname === chosen ? new Response("error") : gate(403, "请先登录后查看");
    },
    async (calls) => {
      await assert.rejects(plugin.getChapter(requestDownload()), isFailure("unauthorized"));
      assert.deepEqual(hosts(calls), [chosen, working]);
    },
    { token: "fixture-token" },
  );
});

test("fixed default route declares eligible background pages without trying another host", () =>
  fixture(
    (url) => {
      assert.equal(url.hostname, working);
      if (url.pathname === exactPath) return manifest({ contents: [{ url: "https://so.mangafunb.fun/page.jpg" }] });
      if (url.pathname === `/api/v3/comic2/${comicId}`)
        return json({ comic: { path_word: comicId, uuid: workUuid, name: "Work" }, groups: { default: { path_word: "default", count: 1 } } });
      return json({ list: [{ uuid: chapterId, name: "Chapter" }], total: 1 });
    },
    async (calls) => {
      const { chapter } = (await plugin.getChapter(requestDownload())).data;
      assert.deepEqual(chapter.extern.downloadRoute, { version: 1, key: key(working), apiHost: working, canSwitch: false });
      assert.deepEqual(chapter.pages[0]?.extern?.backgroundDownload, {
        version: 1, credentialFree: true, redirectPolicy: "same-url", headers: { Accept: imageAccept },
      });
      assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [exactPath]);
      await assert.rejects(plugin.getChapter(requestDownload([key(working)])), isFailure("comic_download_route_unavailable"));
      assert.equal(calls.length, 1);
    },
    { choice: "大陆专线2" },
  ));

test("a fixed download discards a response after the platform changes", () => {
  let config: Record<string, unknown>;
  return fixture(
    (url) => {
      assert.equal(url.hostname, official);
      config["api.platform"] = "2";
      return manifest();
    },
    async (calls, _, settings) => {
      config = settings;
      await assert.rejects(
        plugin.getChapter(requestDownload()),
        isFailure("comic_detail_error", "sourceUnavailable", false),
      );
      assert.deepEqual(hosts(calls), [official]);
    },
    { choice: "官方App线路" },
  );
});

test("reading-only routes, numeric fixed tasks and old callers retain catalog resolution", async () => {
  for (const mode of ["readingOnly", "numericFixed", "legacy"] as const) {
    const readingOnly = mode === "readingOnly";
    await fixture(
      (url) => {
        if (url.pathname === `/api/v3/comic2/${comicId}`)
          return json({
            comic: {
              path_word: comicId,
              uuid: workUuid,
              name: "Work",
              last_chapter: { uuid: chapterId, name: "Chapter" },
            },
            groups: { default: { path_word: "default", count: 1 } },
          });
        if (url.pathname.endsWith("/chapters"))
          return json({ list: [{ uuid: chapterId, name: "Chapter" }], total: 1 });
        if (url.pathname === exactPath) {
          return manifest({ contents: [{ url: "https://so.mangafunb.fun/page.jpg" }] });
        }
        return json({});
      },
      async (calls) => {
        const response = await plugin.getChapter(
          readingOnly ? requestDownload([key(chosen)]) : mode === "numericFixed"
            ? { ...requestDownload(), chapterId: "1" }
            : { comicId, chapterId },
        );
        assert.equal(response.data.chapter.id, chapterId);
        assert.equal(response.data.chapter.extern.downloadRoute, undefined);
        assert.ok(response.data.chapter.pages.every((page) => page.extern?.backgroundDownload === undefined));
        assert.ok(calls.length >= 3);
        assert.ok(hosts(calls).every((host) => host === (readingOnly ? "api.copy2000.online" : chosen)));
      },
      { choice: readingOnly ? "国际服1" : mode === "numericFixed" ? "大陆Copy4000" : "auto" },
    );
  }
});

test("the download-only image call makes one credential-free request with its own timeout", () =>
  fixture(
    (url, request) => {
      assert.equal(url.hostname, "img.example");
      assert.equal(request.credentials, "omit");
      assert.equal(request.headers.get("accept"), imageAccept);
      return new Response(null, { status: 503 });
    },
    async (calls) => {
      const oldTimeout = globalThis.setTimeout;
      const delays: number[] = [];
      globalThis.setTimeout = ((handler, delay, ...args) => {
        if (delay !== undefined) delays.push(delay);
        return oldTimeout(handler, delay, ...args);
      }) as typeof oldTimeout;
      try {
        await assert.rejects(
          plugin.fetchImageBytes({
            url: "https://img.example/page.jpg",
            timeoutMs: 30_000,
            extern: { copyDownloadRouteVersion: 1 },
          }),
        );
      } finally {
        globalThis.setTimeout = oldTimeout;
      }
      assert.equal(calls.length, 1);
      assert.ok(delays.includes(12_000), `Expected a 12s page timer, got ${delays}`);
      assert.ok(!delays.includes(30_000));
    },
  ));
