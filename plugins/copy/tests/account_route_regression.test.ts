import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../src/index.ts";

const main = "mapi.copy20.com";
const official = "api.copy202602.com";
const hot = "mapi.hotmangasd.com";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const content = { code: 200, results: { total: "1", list: [{ comic: { path_word: "sample", name: "Sample" } }] } };
const challenge = { code: 401, message: "请先登录" };
const member = { code: 200, results: { user_id: "fixture-id", username: "fixture-user" } };

async function withCopy(
  initial: Record<string, unknown>,
  fetch: (request: Request) => Promise<Response>,
  run: (settings: Map<string, unknown>) => Promise<void>,
) {
  const oldBridge = globalThis.bridge;
  const oldFetch = globalThis.fetch;
  const settings = new Map(Object.entries(initial));
  globalThis.bridge = {
    async call(name, key, value) {
      if (name === "load_plugin_config")
        return JSON.stringify({ ok: true, value: settings.get(key) ?? value });
      if (name === "save_plugin_config") {
        let parsed = value;
        try { parsed = JSON.parse(String(value)); } catch {}
        settings.set(key, parsed);
        return '{"ok":true}';
      }
      if (name === "cache.get") return value;
      if (name === "cache.set") return true;
      throw Error(name);
    },
  } as typeof globalThis.bridge;
  globalThis.fetch = (input) => fetch(input as Request);
  try { await run(settings); }
  finally { globalThis.bridge = oldBridge; globalThis.fetch = oldFetch; }
}

test("Auto ranks the real Copy content path; Hot and malformed catalog responses cannot win", () =>
  withCopy(
    { "api.domain": "auto", "network.autoRoute.v1": "热辣漫画线路1" },
    async (request) => {
      assert.equal(request.headers.get("authorization"), null);
      assert.equal(request.method, "GET");
      const url = new URL(request.url);
      if (url.pathname.endsWith("/member/info"))
        return url.hostname === main ? json(challenge, 401) : json({}, 404);
      if (url.hostname === main && url.pathname.endsWith("/update/newest")) return json(content);
      if (url.hostname === main || url.hostname === hot) {
        const comicId = url.hostname === main ? "sample" : "hot";
        if (url.pathname.endsWith(`/comic2/${comicId}`)) return json({ code: 200, results: {
          comic: { path_word: comicId, name: "Public work", last_chapter: { uuid: "chapter", name: "第1话" } },
          groups: { default: { path_word: "default", count: 1 } },
        } });
        if (url.pathname.endsWith(`/comic/${comicId}/group/default/chapters`)) return json({
          code: 200, results: { total: 1, list: [{ uuid: "chapter", comic_path_word: comicId }] },
        });
      }
      if (url.hostname === hot) return json({ code: 200, results: { total: 1, list: [{ path_word: "hot", name: "Hot" }] } });
      return json({ code: 200, results: { list: [{}] } });
    },
    async (settings) => {
      const measurement = await plugin.testLineSpeeds();
      assert.equal(measurement.data.effectiveHost, main);
      assert.equal(settings.get("api.domain"), "auto");
      assert.equal(measurement.data.results.find((row) => row.host === main)?.ok, true);
      assert.equal(measurement.data.results.find((row) => row.host === hot)?.ok, true);
    },
  ));

test("Auto keeps member reads on the trusted successful login host and never sends tokens to Hot", () => {
  const signed: string[] = [];
  return withCopy(
    {
      "api.domain": "auto", "network.autoRoute.v1": "热辣漫画线路1",
      "auth.token": "fixture-token", "auth.username": "fixture-user",
      "account.credentials": {
        version: 1, account: "fixture-user", password: "fixture-secret",
        origin: "https://" + main, updatedAt: 1, deleted: false,
      },
    },
    async (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/member/info")) {
        signed.push(url.hostname);
        return url.hostname === main ? json(member) : json(challenge, 401);
      }
      return json({}, 404);
    },
    async () => {
      assert.equal((await plugin.getUserInfoBundle()).data.extern?.userId, "fixture-id");
      assert.deepEqual(signed, [main]);
    },
  );
});

test("Auto verifies first-party account reachability, then submits the password once", () => {
  const posts: string[] = [];
  return withCopy(
    { "api.domain": "auto", "network.autoRoute.v1": "热辣漫画线路1" },
    async (request) => {
      const url = new URL(request.url);
      if (request.method === "POST") {
        posts.push(url.hostname);
        assert.equal(request.credentials, "omit");
        assert.equal(request.redirect, "error");
        return json({ code: 200, results: { token: "fixture-token" } });
      }
      assert.equal(request.headers.get("authorization"), null);
      assert.equal(request.headers.get("cookie"), null);
      if (url.pathname.endsWith("/login")) {
        assert.equal(request.method, "OPTIONS");
        return url.hostname === official
          ? new Response("{}", { headers: { allow: "POST, OPTIONS" } })
          : json({}, 403);
      }
      return url.hostname === official || url.hostname === main ? json(challenge, 401) : json({}, 503);
    },
    async (settings) => {
      await plugin.loginWithPassword({ values: { username: "fixture-user", password: "fixture-secret" } });
      assert.deepEqual(posts, [official]);
      assert.equal((settings.get("account.credentials") as { origin: string }).origin, "https://" + official);
    },
  );
});


test("manual Copy account login uses the chosen route even when old directory metrics failed", () =>
  withCopy(
    { "api.domain": "大陆专线1" },
    async (request) => {
      assert.equal(new URL(request.url).hostname, main);
      assert.equal(request.method, "POST");
      return json({ code: 200, results: { token: "manual-token" } });
    },
    async (settings) => {
      await plugin.loginWithPassword({ values: { username: "fixture-user", password: "fixture-secret" } });
      assert.equal(settings.get("auth.token"), "manual-token");
    },
  ));

test("saved credentials issued by Hot are kept locally and never replayed on a Copy origin", () =>
  withCopy(
    {
      "api.domain": "auto",
      "auth.token": "hot-fixture-token", "auth.username": "fixture-user",
      "account.credentials": {
        version: 1, account: "fixture-user", password: "fixture-secret",
        origin: "https://" + hot, updatedAt: 1, deleted: false,
      },
    },
    async () => { throw new Error("No network requests are permitted for these credentials"); },
    async (settings) => {
      const form = await plugin.getLoginBundle();
      assert.equal(form.data.values?.password, "");
      await assert.rejects(plugin.getUserInfoBundle(), /unauthorized/);
      await assert.rejects(plugin.loginWithPassword({
        values: { username: "fixture-user", password: "fixture-secret" },
        savedCredentialOrigin: "https://" + hot,
      } as Parameters<typeof plugin.loginWithPassword>[0]), /重新输入拷贝漫画账号/);
      assert.equal(settings.get("auth.token"), "hot-fixture-token");
    },
  ));
