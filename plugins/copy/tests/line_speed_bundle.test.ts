import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type sourcePlugin from "../src/index.ts";
import { COPY_SPEED_KEY } from "../src/line-speed.ts";
const plugin = createRequire(import.meta.url)(process.env.BREEZE_COPY_SPEED_BUNDLE ?? "../dist/breeze-plugin-copy-comic.bundle.cjs")
  .default as typeof sourcePlugin;
const routeOption = (option: object) =>
  (option as { routeOption?: {
    title: string;
    domain: string;
    inUse: boolean;
    status: "unknown" | "available" | "unavailable";
    latencyMs: number | null;
    readOnly: boolean;
  } }).routeOption;
const success = (url?: URL) =>
  new Response(
    JSON.stringify({
      code: 200,
      results: url?.pathname.includes("/comic2/") ? {
        comic: { path_word: "public-comic", name: "Public comic", last_chapter: { uuid: "chapter", name: "第1话" } },
        groups: { default: { path_word: "default", count: 1 } },
      } : url?.pathname.endsWith("/chapters") ? {
        total: 1, list: [{ uuid: "chapter", comic_path_word: "public-comic" }],
      } : { total: 1, list: [{ path_word: "public-comic", name: "Public comic" }] },
    }),
    { headers: { "content-type": "application/json" } },
  );
const official = new Set([
  "api.copy202602.com",
  "mapi.mangacopy.com",
  "api.mangacopy.com",
  "api.copy3000.com",
  "mapi.copy20.com",
  "mapi.copy2000.site",
  "api.2025copy.com",
  "api.2026copy.com",
  "api.copy4000.com",
]);
const allDeclared = new Set([...official, "api.copy2000.online", "mapi.hotmangasd.com", "api.manga2025.com",
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
    assert.equal(request.headers.get("authorization"), null);
    assert.equal(request.headers.get("cookie"), null);
    assert.equal(request.body, null);
    const url = new URL(request.url);
    assert.equal(allDeclared.has(url.hostname), true);
    if (url.pathname === "/api/v3/member/info") {
      assert.equal(request.redirect, "error");
      assert.equal(official.has(url.hostname), true);
      return new Response(JSON.stringify({ code: 401 }), { status: 401 });
    }
    assert.equal(request.redirect, "manual");
    if (["/api/v3/comics", "/api/v3/update/newest"].includes(url.pathname)) {
      assert.equal(url.searchParams.get("limit"), "2");
    } else if (url.pathname === "/api/v3/comic2/public-comic") {
      assert.equal(url.searchParams.get("platform"), "1");
    } else {
      assert.equal(url.pathname, "/api/v3/comic/public-comic/group/default/chapters");
      assert.equal(url.searchParams.get("limit"), "1");
    }
    if (url.hostname === "api.copy2000.online")
      return new Response(JSON.stringify({ code: 210, message: "update client" }));
    return success(url);
  };
  try {
    await run({ values, cache, writes, requests });
  } finally {
    globalThis.bridge = previousBridge;
    globalThis.fetch = previousFetch;
  }
}
test("distributable exposes pure speed action, validates every configured public route and tests accounts only on Copy and leaves choice/auth untouched", () =>
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
    assert.equal(requests.length, (allDeclared.size - 1) * 3 + 1 + official.size);
    assert.deepEqual(new Set(requests.map((request) => new URL(request.url).hostname)), allDeclared);
    assert.equal(first.data.results.filter((row) => row.ok).length, allDeclared.size - 1);
    assert.equal(first.data.results.filter((row) => row.account?.ok).length, official.size);
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
    assert.equal(field.options.length, allDeclared.size + 2);
    const network = settings.scheme.sections[0] as unknown as { headerAction: { key: string; title: string; fnPath: string } };
    assert.deepEqual(network.headerAction, { key: "line-speed", title: "测速", fnPath: "testLineSpeeds" });
    const routes = field.options.slice(2);
    assert.equal(routes.every((option) => [...allDeclared].some((host) => option.label.includes(host))), true);
    assert.equal(field.options.find((option) => option.value === "热辣漫画线路7")!.label.includes("ms"), true);
    assert.equal(field.options.some((option) => option.label.includes("验证")), false);
    assert.deepEqual(field.options[0], { label: "自动（可用优先）", value: "auto" });
    assert.equal(field.options.some((option) => option.label.includes("使用中")), false);
    assert.deepEqual(new Set(routes.map((option) => routeOption(option)?.domain)), allDeclared);
    assert.equal(routes.every((option) => {
      const metadata = routeOption(option);
      return metadata && !metadata.inUse && !metadata.title.includes(metadata.domain);
    }), true);
    assert.equal(
      field.options.find((option) => option.value === "大陆专线3")!.label.includes("ms"),
      true,
    );
    const unavailable = field.options.find((option) => option.value === "国际服1")!;
    assert.match(unavailable.label, /暂不可用/);
    assert.equal(routeOption(unavailable)?.status, "unavailable");
    assert.equal(routeOption(unavailable)?.latencyMs, null);
    assert.equal(routeOption(unavailable)?.readOnly, true);
    const available = field.options.find((option) => option.value === "大陆专线3")!;
    assert.equal(routeOption(available)?.status, "available");
    assert.equal(typeof routeOption(available)?.latencyMs, "number");
    assert.equal(routeOption(available)?.readOnly, false);
    assert.equal(
      JSON.stringify((settings.scheme.sections[0] as unknown as { footer: string }).footer).includes("上次测速"),
      true,
    );
    await plugin.saveSettings({ values: { "api.domain": "国际服" } });
    const stale = await plugin.getSettingsBundle();
    const options = stale.scheme.sections[0]!.fields.find((field) => field.key === "api.domain")!;
    if (options.kind !== "select") throw Error("Expected select");
    assert.equal(
      options.options.some((option) => option.label.includes("（旧）")),
      false,
    );
    assert.equal(values.get("api.domain"), "国际服");
  }));
test("catalog and line settings use the persisted choice and request identifier when old caches disagree", () =>
  fixture(async ({ values, cache, writes }) => {
    values.set("api.domain", "热辣漫画线路2");
    values.set("api.platform", "");
    cache.set("copyComic:apiBase:v1", "https://api.2025copy.com/api/v3");
    cache.set("copyComic:platform:v1", "1");
    const settings = await plugin.getSettingsBundle();
    assert.equal(settings.data.values["api.domain"], "热辣漫画线路2");
    assert.equal(settings.data.values["api.platform"], "");
    globalThis.fetch = async (input) => {
      const request = input as Request;
      const url = new URL(request.url);
      assert.equal(url.hostname, "api.manga2025.com");
      assert.equal(url.searchParams.get("platform"), "");
      assert.equal(request.headers.get("platform"), null);
      assert.equal(request.headers.get("origin"), "https://m.relamanhua.org");
      return success();
    };
    assert.equal((await plugin.getTagAuthorList()).data.items.length, 1);
    assert.deepEqual(writes, []);
  }));
test("a previous declared cached route is used when persisted choice is absent", () =>
  fixture(async ({ values, cache }) => {
    values.delete("api.domain");
    values.set("api.platform", 3);
    cache.set("copyComic:apiBase:v1", "https://mapi.copy20.com/api/v3");
    const settings = await plugin.getSettingsBundle();
    assert.equal(settings.data.values["api.domain"], "大陆专线1");
    assert.equal(settings.data.values["api.platform"], "3");
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
test("all failed routes retain a hand selection; Hot is measured for reading only", () =>
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
    assert.equal(result.message, "暂未找到可用线路");
    assert.equal(requests.filter((request) => new URL(request.url).pathname.endsWith("/comics")).length, allDeclared.size);
    const hot = requests.find((request) => new URL(request.url).hostname === "api.manga2025.com")!;
    assert.equal(hot.headers.get("Origin"), "https://m.relamanhua.org");
    assert.equal(hot.headers.get("version"), "2025.02.12");
    assert.equal(values.get("api.domain"), "热辣漫画线路2");
    assert.equal(cache.get("copyComic:apiBase:v1"), "https://api.manga2025.com/api/v3");
    assert.deepEqual(writes, [COPY_SPEED_KEY]);
  }));

test("automatic selection keeps its preference, routes real catalog calls, and preserves its last winner when all probes fail", () =>
  fixture(async ({ values, writes, requests }) => {
    const anonymous = globalThis.fetch;
    const firstWinner = "mapi.copy20.com";
    const secondWinner = "api.copy202602.com";
    const passed = new Set([firstWinner, secondWinner, "mapi.hotmangasd.com", "api.copy4000.com"]);
    globalThis.fetch = async (input, init) => {
      const response = await anonymous(input, init);
      const url = new URL((input as Request).url);
      const host = url.hostname;
      if (host === "api.copy4000.com" && url.pathname.includes("/comic2/")) return new Response("error");
      if (host === firstWinner && url.pathname.endsWith("/update/newest")) {
        await new Promise((resolve) => setTimeout(resolve, 130));
      }
      if (host === secondWinner && url.pathname.includes("/comic2/")) {
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      return passed.has(host) ? response : new Response("<html>invalid directory</html>");
    };

    const enabled = await plugin.saveSettings({ key: "api.domain", value: "auto" });
    assert.equal(enabled.data.effectiveRouteChanged, true);
    assert.equal(enabled.data.effectiveHost, firstWinner);
    assert.equal(values.get("api.domain"), "auto");
    assert.deepEqual(new Set(requests.map((request) => new URL(request.url).hostname)), allDeclared);
    const automaticSettings = await plugin.getSettingsBundle();
    assert.equal(automaticSettings.data.values["api.domain"], "auto");
    const automaticNetwork = automaticSettings.scheme.sections[0] as unknown as { footer: string };
    assert.match(automaticNetwork.footer, /^上次测速 /);
    const automaticField = automaticSettings.scheme.sections[0]!.fields[0]!;
    if (automaticField.kind !== "select") throw Error("Expected select");
    assert.deepEqual(automaticField.options.filter((option) => routeOption(option)?.inUse).map((option) => option.value), ["大陆专线1"]);
    assert.equal(automaticField.options.some((option) => option.label.includes("使用中")), false);
    assert.equal(values.get("auth.token"), "PRIVATE_FIXTURE_NOT_FOR_PROBES");
    const currentRoute = automaticField.options.find((option) => routeOption(option)?.inUse);
    assert.equal(currentRoute && routeOption(currentRoute)?.domain, firstWinner);
    assert.equal(automaticField.description, "可用优先在账号线路不可用时，会为公开阅读使用已测通的线路。");
    assert.match(automaticField.options.find((option) => option.value === "大陆Copy4000")!.label, /暂不可用/);

    passed.clear();
    const failed = await plugin.testLineSpeeds();
    assert.equal(failed.data.anyAvailable, false);
    assert.equal(failed.data.effectiveRouteChanged, false);
    assert.equal(failed.data.effectiveHost, firstWinner);
    assert.equal(values.get("api.domain"), "auto");
    const unavailableField = (await plugin.getSettingsBundle()).scheme.sections[0]!.fields[0]!;
    if (unavailableField.kind !== "select") throw Error("Expected select");
    assert.equal(unavailableField.options.some((option) => routeOption(option)?.inUse), false);

    passed.add(secondWinner);
    const rematched = await plugin.testLineSpeeds();
    assert.equal(rematched.data.effectiveRouteChanged, true);
    assert.equal(rematched.data.effectiveHost, secondWinner);
    assert.equal(values.get("api.domain"), "auto");

    globalThis.fetch = async (input) => {
      assert.equal(new URL((input as Request).url).hostname, secondWinner);
      return success();
    };
    assert.equal((await plugin.getTagAuthorList()).data.items.length, 1);
    assert.equal(writes.filter((key) => key === "api.domain").length, 1);
  }));

for (const automatic of ["auto", "auto-speed"]) {
  test(`a delayed ${automatic} selection cannot overwrite a newer manual route or request platform`, () =>
  fixture(async ({ values, writes }) => {
    const anonymous = globalThis.fetch;
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    const ready = new Promise<void>((done) => { entered = done; });
    globalThis.fetch = async (input, init) => {
      entered();
      await gate;
      return anonymous(input, init);
    };
    const pending = plugin.saveSettings({ key: "api.domain", value: automatic });
    await ready;
    const manual = await plugin.saveSettings({ key: "api.domain", value: "大陆专线1" });
    await plugin.saveSettings({ key: "api.platform", value: " " });
    assert.equal(manual.data.effectiveHost, "mapi.copy20.com");
    release();
    assert.equal((await pending).data.effectiveRouteChanged, false);
    const state = await plugin.getSettingsBundle();
    assert.equal(state.data.values["api.domain"], "大陆专线1");
    assert.equal(state.data.values["api.platform"], " ");
    assert.equal(values.get("api.domain"), "大陆专线1");
    assert.equal(writes.includes(COPY_SPEED_KEY), false);
  }));
}

test("legacy Auto Hot winners are discarded without altering the Auto preference", () =>
  fixture(async ({ values, writes, requests }) => {
    values.set("api.domain", "auto");
    values.set("network.autoRoute.v1", "热辣漫画线路4");
    const settings = await plugin.getSettingsBundle();
    assert.equal(settings.data.values["api.domain"], "auto");
    const field = settings.scheme.sections[0]!.fields[0]!;
    assert.equal(field.kind, "select");
    if (field.kind !== "select") throw Error("Expected select");
    const active = field.options.find((option) => routeOption(option)?.inUse)!;
    assert.equal(routeOption(active)?.domain, "mapi.copy2000.site");
    assert.equal(routeOption(active)?.status, "unknown");
    assert.equal(requests.length, 0);
    assert.deepEqual(writes, []);
  }));

test("availability-first applies a verified reading mirror from an existing partial result", () =>
  fixture(async ({ values, writes, requests }) => {
    values.set("api.domain", "auto");
    values.set("network.autoRoute.v1", "大陆专线1");
    values.set(COPY_SPEED_KEY, {
      version: 1,
      probeVersion: 4,
      revision: "reading-only",
      measuredAt: Date.now(),
      context: { choice: "auto", platform: "1" },
      results: [
        { choice: "大陆专线1", host: "mapi.copy20.com", ok: false, ms: null, status: 503 },
        { choice: "热辣漫画线路1", host: "mapi.hotmangasd.com", ok: true, ms: 90, status: 200 },
        { choice: "热辣漫画线路2", host: "api.manga2025.com", ok: true, ms: 75, status: 200 },
      ],
    });
    const setting = (await plugin.getSettingsBundle()).scheme.sections[0]!.fields[0]!;
    if (setting.kind !== "select") throw Error("Expected select");
    assert.deepEqual(setting.options.filter((option) => routeOption(option)?.inUse).map((option) => option.value),
      ["热辣漫画线路2"]);
    assert.deepEqual(requests, []);
    globalThis.fetch = async (input) => {
      const request = input as Request;
      assert.equal(new URL(request.url).hostname, "api.manga2025.com");
      assert.equal(request.headers.get("authorization"), null);
      return success();
    };
    assert.equal((await plugin.getTagAuthorList()).data.items.length, 1);
    assert.equal(values.get("api.domain"), "auto");
    assert.equal(values.get("network.autoRoute.v1"), "大陆专线1");
    assert.deepEqual(writes, []);
  }));

test("speed-first mode uses the fastest verified reading line and reuses measurements between automatic modes", () =>
  fixture(async ({ values, requests }) => {
    values.set("api.domain", "auto");
    values.set("network.autoRoute.v1", "大陆专线1");
    values.set(COPY_SPEED_KEY, {
      version: 1,
      probeVersion: 4,
      revision: "verified-routes",
      measuredAt: Date.now(),
      context: { choice: "auto", platform: "1" },
      results: [
        { choice: "国际服1", host: "api.copy2000.online", ok: false, ms: null, status: 200 },
        { choice: "热辣漫画线路1", host: "mapi.hotmangasd.com", ok: true, ms: 30, status: 200 },
        { choice: "大陆专线1", host: "mapi.copy20.com", ok: true, ms: 300, status: 200 },
      ],
    });
    const speed = await plugin.saveSettings({ key: "api.domain", value: "auto-speed" });
    assert.equal(speed.data.effectiveHost, "mapi.hotmangasd.com");
    assert.equal(speed.data.effectiveRouteChanged, true);
    assert.equal(values.get("api.domain"), "auto-speed");
    assert.equal(values.get("network.autoRoute.v1"), "热辣漫画线路1");
    const field = (await plugin.getSettingsBundle()).scheme.sections[0]!.fields[0]!;
    if (field.kind !== "select") throw Error("Expected select");
    assert.deepEqual(field.options.slice(0, 2), [
      { value: "auto", label: "自动（可用优先）" },
      { value: "auto-speed", label: "自动（速度优先）" },
    ]);
    assert.equal(field.options.find((option) => routeOption(option)?.inUse)?.value, "热辣漫画线路1");
    assert.deepEqual(requests, []);

    globalThis.fetch = async (input) => {
      assert.equal(new URL((input as Request).url).hostname, "mapi.hotmangasd.com");
      assert.equal((input as Request).headers.get("authorization"), null);
      return success();
    };
    assert.equal((await plugin.getTagAuthorList()).data.items.length, 1);

    const available = await plugin.saveSettings({ key: "api.domain", value: "auto" });
    assert.equal(available.data.effectiveHost, "mapi.copy20.com");
    assert.equal(values.get("api.domain"), "auto");
    assert.equal(values.get("network.autoRoute.v1"), "大陆专线1");

    await plugin.saveSettings({ key: "api.domain", value: "auto-speed" });
    globalThis.fetch = async () => new Response("unavailable");
    const failed = await plugin.testLineSpeeds();
    assert.equal(failed.data.anyAvailable, false);
    assert.equal(failed.data.effectiveHost, "mapi.hotmangasd.com");
    assert.equal(failed.data.effectiveRouteChanged, false);
    assert.equal(values.get("api.domain"), "auto-speed");
  }));
