import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import axios, { type InternalAxiosRequestConfig } from "axios";

// All storage, authentication and favorite operations use in-memory fixtures.
// The adapter never opens a socket or reads the user's plugin configuration.
let cached = new Map<string, unknown>();
let settings = new Map<string, unknown>();
let requests: InternalAxiosRequestConfig[] = [];
let storageGate: ((name: string, key: string, value: unknown) => Promise<void>) | null = null;
let respond: (config: InternalAxiosRequestConfig) => Promise<{ status: number; data: unknown }>;

(globalThis as any).bridge = {
  call: async (name: string, key: string, value: unknown) => {
    if (storageGate) await storageGate(name, key, value);
    switch (name) {
      case "cache.get": return cached.get(key) ?? value ?? null;
      case "cache.set": cached.set(key, value); return true;
      case "cache.delete": cached.delete(key); return true;
      case "load_plugin_config": return JSON.stringify({ ok: true, value: settings.get(key) ?? JSON.parse(value as string) });
      case "save_plugin_config": settings.set(key, JSON.parse(value as string)); return true;
    }
    if (name.includes("md5")) return "fixture-hash";
    return true;
  },
};

axios.defaults.adapter = async (config) => {
  requests.push(config);
  const result = await respond(config);
  return { ...result, statusText: "fixture", headers: {}, config };
};

const { default: plugin, runJmAuthAndCheckInLoop } = await import("../src/index");
const state = await import("../src/state");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const loginPayload = { account: "fixture-account", password: "fixture-password" };
const loginData = { uid: "fixture-user", username: "fixture-account", jwttoken: "fixture-token" };
function storedCredentials() {
  settings.set("auth.account", loginPayload.account);
  settings.set("auth.password", loginPayload.password);
}

beforeEach(async () => {
  storageGate = null;
  await plugin.clearPluginSession();
  settings = new Map();
  cached = new Map();
  requests = [];
  respond = async () => ({ status: 200, data: {} });
});

test("empty and legacy sentinel cache entries never become device, UA or JWT values", async () => {
  for (const sentinel of [null, undefined, "null", "undefined", 42]) {
    cached.set("JmComic::device", sentinel);
    cached.set("JmComic::ua", sentinel);
    cached.set("JmComic::jwt", sentinel);
    const id = await state.getDeviceId();
    assert.match(id, /^[a-z0-9]{9}$/);
    assert.match(await state.getUserAgent(), /^Mozilla\/5\.0 /);
    assert.equal(await state.getJwtToken(), "");
  }
  await plugin.jmRequest({ path: "https://fixture.invalid/list" });
  assert.equal(requests[0]!.headers.Authorization, undefined);
  assert.match(String(requests[0]!.headers["user-agent"]), /^Mozilla\/5\.0 /);
  for (const sentinel of ["null", "undefined"]) {
    settings.set("auth.jwt", sentinel);
    await plugin.jmRequest({ path: "https://fixture.invalid/list" });
    assert.equal(requests[requests.length - 1]!.headers.Authorization, undefined);
  }
});

test("clear session removes settings, cached and in-memory JWT without rotating the device", async () => {
  const id = await state.getDeviceId();
  const ua = await state.getUserAgent();
  await state.setJwtToken("fixture-old-token");
  settings.set("auth.jwt", "fixture-old-token");
  await plugin.clearPluginSession();
  assert.equal(await state.getJwtToken(), "");
  assert.equal(cached.has("JmComic::jwt"), false);
  assert.equal(settings.get("auth.jwt"), "");
  assert.deepEqual(settings.get("auth.userInfo"), {});
  assert.equal(await state.getDeviceId(), id);
  assert.equal(await state.getUserAgent(), ua);
});

test("a late login response cannot restore a cleared account or cached JWT", async () => {
  const response = deferred<{ status: number; data: unknown }>();
  respond = () => response.promise;
  const login = plugin.loginWithPassword(loginPayload).catch((error) => error);
  await setImmediate();
  assert.equal(requests.length, 1);
  await plugin.clearPluginSession();
  response.resolve({ status: 200, data: loginData });
  const outcome = await login;
  assert.equal(settings.get("auth.account"), "", "late login must not restore the old account");
  assert.equal(settings.get("auth.jwt"), "");
  assert.equal(await state.getJwtToken(), "");
  assert.ok(outcome instanceof state.SessionChangedError);
});

test("a late ordinary response cannot refresh JWT after session clearing", async () => {
  const response = deferred<{ status: number; data: unknown }>();
  respond = () => response.promise;
  const request = plugin.jmRequest({ path: "https://fixture.invalid/list" }).catch((error) => error);
  await setImmediate();
  await plugin.clearPluginSession();
  response.resolve({ status: 200, data: { jwttoken: "fixture-late-token" } });
  assert.ok(await request instanceof state.SessionChangedError);
  assert.equal(await state.getJwtToken(), "");
});

test("clearing wins over a storage write that has already started", async () => {
  const writing = deferred<void>();
  const release = deferred<void>();
  storageGate = async (name, key, value) => {
    if (name === "save_plugin_config" && key === "auth.account" && value === JSON.stringify(loginPayload.account)) {
      writing.resolve();
      await release.promise;
    }
  };
  respond = async () => ({ status: 200, data: loginData });
  const login = plugin.loginWithPassword(loginPayload).catch((error) => error);
  await writing.promise;
  const clear = plugin.clearPluginSession();
  release.resolve();
  await clear;
  assert.ok(await login instanceof state.SessionChangedError);
  assert.equal(settings.get("auth.account"), "");
  assert.equal(settings.get("auth.password"), "");
  assert.equal(settings.get("auth.jwt"), "");
  assert.equal(await state.getJwtToken(), "");
});

test("new requests wait for clearing rather than reading an old persisted JWT", async () => {
  settings.set("auth.jwt", "fixture-old-token");
  const release = deferred<void>();
  storageGate = async (name) => {
    if (name === "cache.delete") await release.promise;
  };
  const clear = plugin.clearPluginSession();
  const request = plugin.jmRequest({ path: "https://fixture.invalid/list" });
  await setImmediate();
  assert.equal(requests.length, 0);
  release.resolve();
  await clear;
  await request;
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.headers.Authorization, undefined);
});

test("full favorites fail without claiming selection or opening a folder step", async () => {
  respond = async () => ({ status: 200, data: { msg: "收藏已满" } });
  await assert.rejects(plugin.toggleFavorite({ comicId: "fixture-id", currentFavorite: false }), /收藏数已达上限/);
  assert.equal(requests.length, 1);
});

test("traditional and nested favorite refusals keep the original selection", async () => {
  for (const data of [{ msg: "收藏已滿" }, { data: { msg: "收藏已滿" } }, { status: false, msg: "收藏失敗" }]) {
    respond = async () => ({ status: 200, data });
    await assert.rejects(plugin.toggleFavorite({ comicId: "fixture-id", currentFavorite: false }), /收藏/);
  }
});

test("successful favorite and removal retain their existing next-step contract", async () => {
  respond = async () => ({ status: 200, data: { status: "ok" } });
  assert.deepEqual(await plugin.toggleFavorite({ comicId: "fixture-id", currentFavorite: false }), {
    favorited: true, nextStep: "selectFolder",
  });
  assert.deepEqual(await plugin.toggleFavorite({ comicId: "fixture-id", currentFavorite: true }), {
    favorited: false, nextStep: "none",
  });
});

for (const status of [200, 401, 403]) {
  test(`invalid credentials stop automatic login after one request (HTTP ${status})`, async () => {
    storedCredentials();
    respond = async () => ({ status, data: { msg: "账号或密码错误" } });
    await runJmAuthAndCheckInLoop();
    assert.equal(requests.length, 1);
    assert.equal(settings.has("auth.jwt"), false);
    assert.equal(await state.getJwtToken(), "");
  });
}

for (const failure of [429, 503, "ECONNABORTED"]) {
  test(`temporary login failures have exactly three attempts (${failure})`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    storedCredentials();
    respond = async () => {
      if (typeof failure === "string") throw Object.assign(new Error("fixture timeout"), { code: failure });
      return { status: failure, data: {} };
    };
    const flow = runJmAuthAndCheckInLoop();
    await setImmediate();
    assert.equal(requests.length, 1);
    context.mock.timers.tick(1000);
    await setImmediate();
    assert.equal(requests.length, 2);
    context.mock.timers.tick(2000);
    await flow;
    assert.equal(requests.length, 3);
    context.mock.timers.tick(600_000);
    await setImmediate();
    assert.equal(requests.length, 3);
  });
}

test("a temporary login error can recover without retrying completed login during check-in", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  storedCredentials();
  let logins = 0;
  let checkins = 0;
  respond = async (config) => {
    if (config.url?.endsWith("/login")) {
      logins++;
      return { status: logins === 1 ? 503 : 200, data: loginData };
    }
    checkins++;
    return { status: 200, data: { list: [] } };
  };
  const flow = runJmAuthAndCheckInLoop();
  await setImmediate();
  context.mock.timers.tick(1000);
  await flow;
  assert.equal(logins, 2);
  assert.equal(checkins, 1);
  assert.equal(await state.getJwtToken(), loginData.jwttoken);
});

test("check-in retries are bounded and do not restart login", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  storedCredentials();
  let logins = 0;
  let checkins = 0;
  respond = async (config) => {
    if (config.url?.endsWith("/login")) {
      logins++;
      return { status: 200, data: loginData };
    }
    checkins++;
    return { status: 503, data: {} };
  };
  const flow = runJmAuthAndCheckInLoop();
  await setImmediate();
  context.mock.timers.tick(1000);
  await setImmediate();
  context.mock.timers.tick(2000);
  await flow;
  assert.equal(logins, 1);
  assert.equal(checkins, 3);
});

test("clearing a session stops a pending retry from starting another login", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  storedCredentials();
  respond = async () => ({ status: 503, data: {} });
  const flow = runJmAuthAndCheckInLoop();
  await setImmediate();
  await plugin.clearPluginSession();
  context.mock.timers.tick(1000);
  await flow;
  assert.equal(requests.length, 1);
  assert.equal(await state.getJwtToken(), "");
});
