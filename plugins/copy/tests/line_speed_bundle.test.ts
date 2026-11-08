import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type sourcePlugin from "../src/index.ts";
import { COPY_SPEED_KEY } from "../src/line-speed.ts";
const plugin = createRequire(import.meta.url)("../dist/breeze-plugin-copy-comic.bundle.cjs")
  .default as typeof sourcePlugin;
const success = () =>
  new Response(
    JSON.stringify({
      code: 200,
      results: { total: 1, list: [{ path_word: "public-comic", name: "Public comic" }] },
    }),
    { headers: { "content-type": "application/json" } },
  );
const official = new Set([
  "api.mangacopy.com",
  "api.copy2000.online",
  "api.copy3000.com",
  "mapi.copy20.com",
  "mapi.copy2000.site",
  "api.2025copy.com",
  "api.2026copy.com",
]);
const allDeclared = new Set([...official, "mapi.hotmangasd.com", "api.manga2025.com",
  "mapi.hotmangasf.com", "mapi.hotmangasg.com", "mapi.elfgjfghkk.club",
  "mapi.fgjfghkk.club", "mapi.fgjfghkkcenter.club"]);
async function fixture(
  run: (state: {
    values: Map<string, unknown>;
    cache: Map<string, unknown>;
    writes: string[];
    requests: Request[];
  }) => Promise<void>,
) {
  const previousBridge = globalThis.bridge,
    previousFetch = globalThis.fetch;
  const values = new Map<string, unknown>([
    ["api.domain", "大陆专线3"],
    ["api.platform", "1"],
    ["auth.token", "PRIVATE_FIXTURE_NOT_FOR_PROBES"],
  ]);
  const cache = new Map<string, unknown>([
    ["copyComic:apiBase:v1", "https://api.2025copy.com/api/v3"],
    ["copyComic:platform:v1", "1"],
  ]);
  const writes: string[] = [],
    requests: Request[] = [];
  globalThis.bridge = {
    call: async (fn: string, key: string, value: unknown) => {
      if (fn === "load_plugin_config") {
        assert.equal(
          key.startsWith("auth."),
          false,
          "public speed tests must not even load account data",
        );
        return JSON.stringify({ ok: true, value: values.get(key) ?? value });
      }
      if (fn === "save_plugin_config") {
        writes.push(key);
        let parsed: unknown = value;
        try {
          parsed = JSON.parse(String(value));
        } catch {}
        values.set(key, parsed);
        return '{"ok":true}';
      }
      if (fn === "cache.get") return cache.get(key) ?? value;
      if (fn === "cache.set") {
        cache.set(key, value);
        return true;
      }
      throw new Error(`Unexpected bridge capability ${fn}`);
    },
  } as typeof globalThis.bridge;
  globalThis.fetch = async (input) => {
    const request = input as Request;
    requests.push(request.clone());
    assert.equal(request.method, "GET");
    assert.equal(request.credentials, "omit");
    assert.equal(request.redirect, "error");
    assert.equal(request.headers.get("authorization"), null);
    assert.equal(request.headers.get("cookie"), null);
    assert.equal(request.body, null);
    const url = new URL(request.url);
    assert.equal(url.pathname, "/api/v3/comics");
    assert.equal(url.searchParams.get("limit"), "1");
    assert.equal(allDeclared.has(url.hostname), true);
    if (url.hostname === "api.copy2000.online")
      return new Response(JSON.stringify({ code: 210, message: "update client" }));
    return success();
  };
  try {
    await run({ values, cache, writes, requests });
  } finally {
    globalThis.bridge = previousBridge;
    globalThis.fetch = previousFetch;
  }
}
test("distributable exposes pure speed action, validates all fourteen public routes and leaves choice/auth untouched", () =>
  fixture(async ({ values, cache, writes, requests }) => {
    const capability = await plugin.getCapabilitiesBundle();
    assert.deepEqual(
      capability.scheme.actions.map((action) => [action.key, action.fnPath]),
      [["line-speed", "testLineSpeeds"]],
    );
    const pending = plugin.testLineSpeeds(),
      second = plugin.testLineSpeeds();
    const [first, duplicate] = await Promise.all([pending, second]);
    assert.equal(first.data.measuredAt, duplicate.data.measuredAt);
    assert.equal(requests.length, 14);
    assert.deepEqual(new Set(requests.map((request) => new URL(request.url).hostname)), allDeclared);
    assert.equal(first.data.results.filter((row) => row.ok).length, 13);
    assert.deepEqual(writes, [COPY_SPEED_KEY]);
    assert.equal(values.get("api.domain"), "大陆专线3");
    assert.equal(cache.get("copyComic:apiBase:v1"), "https://api.2025copy.com/api/v3");
    assert.equal(values.get("auth.token"), "PRIVATE_FIXTURE_NOT_FOR_PROBES");
    const saved = JSON.stringify(values.get(COPY_SPEED_KEY));
    assert.equal(saved.includes("PRIVATE_"), false);
    assert.equal(saved.includes("/api/v3"), false);
    assert.equal(saved.includes("public-comic"), false);
    const settings = await plugin.getSettingsBundle();
    const field = settings.scheme.sections[0]!.fields.find((field) => field.key === "api.domain")!;
    assert.equal(field.kind, "select");
    if (field.kind !== "select") throw Error("Expected select");
    assert.equal(field.options.length, 14);
    const network = settings.scheme.sections[0] as unknown as { headerAction: { key: string; title: string; fnPath: string } };
    assert.deepEqual(network.headerAction, { key: "line-speed", title: "测速", fnPath: "testLineSpeeds" });
    assert.equal(field.options.every((option) => option.label.length <= 20), true);
    assert.equal(field.options.find((option) => option.value === "热辣漫画线路7")!.label.includes("ms"), true);
    assert.equal(field.options.some((option) => option.label.includes("验证")), false);
    assert.equal(
      field.options.some(
        (option) => String(option.value) === "auto" || option.label.includes("自动"),
      ),
      false,
    );
    assert.equal(
      field.options.find((option) => option.value === "大陆专线3")!.label.includes("ms"),
      true,
    );
    assert.equal(
      field.options.find((option) => option.value === "国际服1")!.label.includes("失败"),
      true,
    );
    assert.equal(
      JSON.stringify((settings.scheme.sections[0] as unknown as { footer: string }).footer).includes("上次测速"),
      true,
    );
    await plugin.saveSettings({ values: { "api.domain": "国际服" } });
    const stale = await plugin.getSettingsBundle();
    const options = stale.scheme.sections[0]!.fields.find((field) => field.key === "api.domain")!;
    if (options.kind !== "select") throw Error("Expected select");
    assert.equal(
      options.options.some((option) => option.label.endsWith("·旧")),
      true,
    );
    assert.equal(values.get("api.domain"), "国际服");
  }));
test("hand selection during a bundled test fences its saved results without changing the user's new route", () =>
  fixture(async ({ values, cache, writes }) => {
    const originalFetch = globalThis.fetch;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((done) => {
        release = done;
      }),
      ready = new Promise<void>((done) => {
        entered = done;
      });
    globalThis.fetch = async (input, init) => {
      entered();
      await gate;
      return originalFetch(input, init);
    };
    const pending = plugin.testLineSpeeds();
    await ready;
    await plugin.saveSettings({ values: { "api.domain": "大陆专线1" } });
    release();
    const result = await pending;
    assert.equal(result.data.stale, true);
    assert.equal(writes.includes(COPY_SPEED_KEY), false);
    assert.equal(values.get("api.domain"), "大陆专线1");
    assert.equal(cache.get("copyComic:apiBase:v1"), "https://mapi.copy20.com/api/v3");
  }));
test("all failed routes never select a fallback, and only the already selected Hot line is probed", () =>
  fixture(async ({ values, cache, writes, requests }) => {
    values.set("api.domain", "热辣漫画线路2");
    cache.set("copyComic:apiBase:v1", "https://api.manga2025.com/api/v3");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      await originalFetch(input, init);
      return new Response("<html>unavailable</html>");
    };
    const result = await plugin.testLineSpeeds();
    assert.equal(result.data.anyAvailable, false);
    assert.equal(result.message.includes("0 条可用"), true);
    assert.equal(requests.length, 14);
    const hot = requests.find((request) => new URL(request.url).hostname === "api.manga2025.com")!;
    assert.equal(hot.headers.get("Origin"), "https://m.relamanhua.org");
    assert.equal(hot.headers.get("version"), "2025.02.12");
    assert.equal(values.get("api.domain"), "热辣漫画线路2");
    assert.equal(cache.get("copyComic:apiBase:v1"), "https://api.manga2025.com/api/v3");
    assert.deepEqual(writes, [COPY_SPEED_KEY]);
  }));
