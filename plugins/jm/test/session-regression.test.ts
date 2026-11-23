import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import axios, { type InternalAxiosRequestConfig } from "axios";

// All storage, authentication and favorite operations use in-memory fixtures.
// The adapter never opens a socket or reads the user's plugin configuration.
let cached = new Map<string, unknown>();
let settings = new Map<string, unknown>();
let requests: InternalAxiosRequestConfig[] = [];
let checkinNotices: unknown[] = [];
let storageGate: ((name: string, key: string, value: unknown) => Promise<void>) | null = null;
let malformedSetting: string | null = null;
let respond: (config: InternalAxiosRequestConfig) => Promise<{
  status: number; data: unknown; headers?: Record<string, string>;
}>;

(globalThis as any).uuidv4 = randomUUID;

(globalThis as any).bridge = {
  call: async (name: string, key: string, value: unknown) => {
    if (storageGate) await storageGate(name, key, value);
    switch (name) {
      case "breeze.checkin.completed": checkinNotices.push(JSON.parse(key)); return true;
      case "opencc.convert": return (key as any).text;
      case "cache.get": return cached.get(key) ?? value ?? null;
      case "cache.set": cached.set(key, value); return true;
      case "cache.delete": cached.delete(key); return true;
      case "load_plugin_config": return key === malformedSetting
        ? JSON.stringify({ ok: true })
        : JSON.stringify({ ok: true, value: settings.get(key) ?? JSON.parse(value as string) });
      case "save_plugin_config": settings.set(key, JSON.parse(value as string)); return true;
    }
    if (name.includes("md5")) return "fixture-hash";
    return true;
  },
};

axios.defaults.adapter = async (config) => {
  requests.push(config);
  const result = await respond(config);
  return { ...result, statusText: "fixture", headers: result.headers ?? {}, config };
};

const { default: plugin, runJmAuthAndCheckInLoop } = await import("../src/index");
const state = await import("../src/state");
const { Config } = await import("../src/constants");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function favoriteFolderForm(request: InternalAxiosRequestConfig): FormData {
  assert.ok(request.data instanceof FormData, "folder writes match the official multipart form");
  return request.data;
}

const loginPayload = { account: "fixture-account", password: "fixture-password" };
const loginData = { uid: "fixture-user", username: "fixture-account", jwttoken: "fixture-token" };
function storedCredentials() {
  settings.set("auth.account", loginPayload.account);
  settings.set("auth.password", loginPayload.password);
}

beforeEach(async () => {
  storageGate = null;
  malformedSetting = null;
  await plugin.clearPluginSession();
  settings = new Map();
  cached = new Map();
  requests = [];
  checkinNotices = [];
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

test("a rejected account write cannot let a delayed persisted JWT cross session clearing", async () => {
  const writing = deferred<void>(), release = deferred<void>();
  storageGate = async (name, key, value) => {
    if (name !== "save_plugin_config") return;
    if (key === "auth.account" && value === JSON.stringify(loginPayload.account))
      throw new Error("fixture account persistence failed");
    if (key === "auth.jwt" && value === JSON.stringify(loginData.jwttoken)) {
      writing.resolve(); await release.promise;
    }
  };
  respond = async () => ({ status: 200, data: loginData });
  const login = plugin.loginWithPassword(loginPayload).catch((error) => error);
  await writing.promise;
  const clearing = plugin.clearPluginSession();
  await setImmediate();
  release.resolve();
  await Promise.all([login, clearing]);
  assert.equal(settings.get("auth.account"), "");
  assert.equal(settings.get("auth.password"), "");
  assert.equal(settings.get("auth.jwt"), "");
  assert.equal(await state.getJwtToken(), "");
});

test("a rejected clear operation waits for its delayed blank JWT before a new login can persist", async () => {
  const writing = deferred<void>(), release = deferred<void>();
  storageGate = async (name, key, value) => {
    if (name === "cache.delete") throw new Error("fixture cache deletion failed");
    if (name === "save_plugin_config" && key === "auth.jwt" && value === JSON.stringify("")) {
      writing.resolve(); await release.promise;
    }
  };
  respond = async () => ({ status: 200, data: loginData });
  const clearing = plugin.clearPluginSession().catch((error) => error);
  await writing.promise;
  const login = plugin.loginWithPassword(loginPayload);
  await setImmediate();
  release.resolve();
  await Promise.all([clearing, login]);
  assert.equal(settings.get("auth.account"), loginPayload.account);
  assert.equal(settings.get("auth.jwt"), loginData.jwttoken);
  assert.equal(await state.getJwtToken(), loginData.jwttoken);
});

test("full favorites fail without claiming selection or opening a folder step", async () => {
  settings.set("auth.jwt", "fixture-token");
  respond = async () => ({ status: 200, data: { msg: "收藏已满" } });
  await assert.rejects(plugin.toggleFavorite({ comicId: "fixture-id", currentFavorite: false }), /收藏数已达上限/);
  assert.equal(requests.length, 1);
});

test("traditional and nested favorite refusals keep the original selection", async () => {
  settings.set("auth.jwt", "fixture-token");
  for (const data of [{ msg: "收藏已滿" }, { data: { msg: "收藏已滿" } }, { status: false, msg: "收藏失敗" }]) {
    respond = async () => ({ status: 200, data });
    await assert.rejects(plugin.toggleFavorite({ comicId: "fixture-id", currentFavorite: false }), /收藏/);
  }
});

test("successful favorite and removal retain their existing next-step contract", async () => {
  settings.set("auth.jwt", "fixture-token");
  respond = async () => ({ status: 200, data: { status: "ok", type: "add" } });
  assert.deepEqual(await plugin.toggleFavorite({ comicId: "fixture-id", currentFavorite: true }), {
    favorited: true, nextStep: "selectFolder",
  });
  respond = async () => ({ status: 200, data: { status: "ok", type: "remove" } });
  assert.deepEqual(await plugin.toggleFavorite({ comicId: "fixture-id", currentFavorite: false }), {
    favorited: false, nextStep: "none",
  });
});

test("favorite rejects a missing action, or an outer rejection hiding inner success", async () => {
  settings.set("auth.jwt", "fixture-token");
  for (const data of [
    {}, { status: "ok" }, { status: "ok", type: "other" },
    { code: 403, data: JSON.stringify({ status: "ok", type: "add" }) },
    { status: false, data: { status: "ok", type: "add" } },
  ]) {
    respond = async () => ({ status: 200, data });
    await assert.rejects(plugin.toggleFavorite({ comicId: "123", currentFavorite: false }), /未确认收藏/);
  }
  assert.equal(requests.length, 5);
  assert.ok(requests.every((request) => request.method === "post"));
});

test("favorite refuses to commit after the account changes while its receipt is in flight", async () => {
  settings.set("auth.jwt", "fixture-token");
  const started = deferred<void>();
  const receipt = deferred<{ status: number; data: unknown }>();
  respond = async () => { started.resolve(); return receipt.promise; };
  const result = plugin.toggleFavorite({ comicId: "123", currentFavorite: false });
  const rejected = assert.rejects(result, state.SessionChangedError);
  await started.promise;
  await plugin.clearPluginSession();
  receipt.resolve({ status: 200, data: { status: "ok", type: "add", jwttoken: "stale-token" } });
  await rejected;
  assert.equal(requests.length, 1);
  assert.equal(await state.getJwtToken(), "");
});

test("move confirms the exact target work on a bounded target-folder read with one pinned JWT", async () => {
  settings.set("auth.jwt", "fixture-token");
  respond = async (request) => ({ status: 200, data: request.method === "post"
    ? { jwttoken: "unexpected-token" }
    : request.params.page === 1
      ? { total: "21", list: Array.from({ length: 20 }, (_, index) => ({ id: String(index + 1000) })) }
      : { total: "21", list: [{ id: 123 }], jwttoken: "other-token" },
  });
  assert.deepEqual(await plugin.moveFavoriteToFolder({ comicId: "123", folderId: "9" }), { ok: true });
  assert.equal(requests.length, 3);
  assert.ok(requests[0]!.url?.endsWith("/favorite_folder"));
  assert.equal(requests[0]!.method, "post");
  assert.equal(requests[0]!.fetchOptions?.redirect, "error");
  assert.deepEqual(requests.slice(1).map((request) => request.params), [
    { page: 1, folder_id: "9", o: "mr" }, { page: 2, folder_id: "9", o: "mr" },
  ]);
  assert.ok(requests.every((request) => request.headers.Authorization === "Bearer fixture-token"));
  assert.equal(await state.getJwtToken(), "");
  assert.equal(settings.get("auth.jwt"), "fixture-token");
});

test("an unreadable or refused folder move never reports success or repeats its write", async () => {
  settings.set("auth.jwt", "fixture-token");
  respond = async (request) => ({ status: 200, data: request.method === "post" ? {} : { list: [], total: 0 } });
  await assert.rejects(plugin.moveFavoriteToFolder({ comicId: "123", folderId: "9" }), /无法确认已移入/);
  assert.deepEqual(requests.map((request) => request.method), ["post", "get"]);

  requests.length = 0;
  respond = async () => ({ status: 200, data: { code: 403, data: JSON.stringify({ status: "ok" }) } });
  await assert.rejects(plugin.moveFavoriteToFolder({ comicId: "123", folderId: "9" }), /未确认收藏操作/);
  assert.deepEqual(requests.map((request) => request.method), ["post"]);

  requests.length = 0;
  respond = async () => { throw new axios.CanceledError("fixture cancelled"); };
  await assert.rejects(plugin.moveFavoriteToFolder({ comicId: "123", folderId: "9" }), /fixture cancelled/);
  assert.deepEqual(requests.map((request) => request.method), ["post"]);
});

test("account collections start with a persisted session, keep the token scoped, and never refresh it", async () => {
  settings.set("auth.userInfo", { uid: "fixture-user" });
  settings.set("auth.jwt", "fixture-token");
  respond = async (config) => {
    assert.equal(config.headers.get("Authorization"), "Bearer fixture-token");
    assert.equal(config.withCredentials, false);
    assert.equal(config.maxRedirects, 0);
    assert.equal(new URL(config.url!).pathname, "/tags_favorite");
    return { status: 200, data: { list: [{ tag: "指定标签" }], jwttoken: "unexpected-token" } };
  };

  const result = await plugin.getJmAccountCollection({ collection: "tags", accountId: "fixture-user" });
  assert.deepEqual(result.data, { tags: ["指定标签"], accountId: "fixture-user" });
  assert.equal(settings.get("auth.jwt"), "fixture-token");
  assert.equal(await state.getJwtToken(), "");
  await assert.rejects(plugin.getJmAccountCollection({ collection: "tags", accountId: "other-user" }), /unauthorized/);
  assert.equal(requests.length, 1);
});

test("account collections stop before readback when the account is replaced during a write", async () => {
  settings.set("auth.userInfo", { uid: "fixture-user" });
  settings.set("auth.jwt", "fixture-token");
  respond = async (config) => {
    if (config.method === "post") {
      settings.set("auth.userInfo", { uid: "other-user" });
      settings.set("auth.jwt", "other-token");
    }
    return { status: 200, data: { code: 200, data: false } };
  };

  await assert.rejects(plugin.setJmAccountCollection({
    collection: "follows", accountId: "fixture-user", comicId: "123", enabled: true,
  }), state.SessionChangedError);
  assert.deepEqual(requests.map(({ method }) => method), ["get", "post"]);
  assert.ok(requests.every(({ headers }) => headers.get("Authorization") === "Bearer fixture-token"));
});

test("site watch history only reads authenticated pages and returns account-scoped comic rows", async () => {
  settings.set("auth.userInfo", { ...loginData, s: "fixture-cookie" });
  settings.set("auth.jwt", "fixture-token");
  assert.equal(Reflect.get(await plugin.getInfo(), "breezeExperience").jmSiteWatchHistory, true);
  respond = async (config) => {
    assert.equal(config.method, "get");
    assert.equal(config.maxRedirects, 0);
    assert.equal(config.headers.get("Authorization"), "Bearer fixture-token");
    assert.equal(config.headers.get("Cookie"), "AVS=fixture-cookie");
    assert.equal(new URL(config.url!).origin, new URL(Config.baseUrl).origin);
    assert.equal(new URL(config.url!).pathname, "/watch_list");
    assert.deepEqual(config.params, { page: 2 });
    return { status: 200, data: { code: 200, data: {
      list: [{ id: "123", name: "站点记录", author: "作者" }], total: "21",
      jwttoken: "unexpected-token",
    } } };
  };

  const { data } = await plugin.getSiteWatchHistory({ page: 2, accountId: loginData.uid });
  assert.equal(data.accountId, loginData.uid);
  assert.equal(data.page, 2);
  assert.equal(data.total, 21);
  assert.equal(data.hasReachedMax, true);
  assert.equal(data.items[0]?.title, "站点记录");
  assert.deepEqual(data.items[0]?.metadata[0]?.value, ["作者"]);
  assert.equal(settings.get("auth.jwt"), "fixture-token");
  assert.equal(await state.getJwtToken(), "");

  await assert.rejects(plugin.getSiteWatchHistory({ accountId: "other-account" }), /unauthorized/);
  assert.equal(requests.length, 1);
});

test("site watch history distinguishes empty from malformed and discards a replaced account response", async () => {
  settings.set("auth.userInfo", loginData);
  settings.set("auth.jwt", "fixture-token");
  const payload = { accountId: loginData.uid };
  respond = async () => ({ status: 200, data: { list: [], total: 0 } });
  assert.deepEqual((await plugin.getSiteWatchHistory(payload)).data.items, []);
  respond = async () => ({ status: 200, data: { list: [], total: 4 } });
  await assert.rejects(plugin.getSiteWatchHistory(payload), /记录读取不完整/);
  respond = async () => {
    settings.set("auth.userInfo", { ...loginData, uid: "other-account" });
    return { status: 200, data: { list: [{ id: "5", name: "旧记录" }], total: 1 } };
  };
  await assert.rejects(plugin.getSiteWatchHistory(payload), state.SessionChangedError);
});

test("account collection reads retry transport once, preserving account and a short terminal history page", async () => {
  settings.set("auth.userInfo", loginData);
  settings.set("auth.jwt", "fixture-token");
  let attempts = 0;
  respond = async () => {
    if (attempts++ === 0) throw new axios.AxiosError("connection reset", "ECONNRESET");
    return { status: 200, data: { list: [{ id: "5", name: "短页记录" }], total: 41 } };
  };
  const { data } = await plugin.getSiteWatchHistory({ page: 3, accountId: loginData.uid });
  assert.equal(data.hasReachedMax, true);
  assert.equal(data.total, 41);
  assert.equal(data.items[0]?.id, "5");
  assert.deepEqual(requests.map(({ method }) => method), ["get", "get"]);
  assert.ok(requests.every(({ headers }) => headers.get("Authorization") === "Bearer fixture-token"));

  requests.length = 0;
  respond = async () => ({ status: 429, data: {} });
  await assert.rejects(plugin.getSiteWatchHistory({ page: 1, accountId: loginData.uid }), /429/);
  assert.equal(requests.length, 1);

  requests.length = 0;
  respond = async () => { throw new axios.AxiosError("timeout of 10000ms exceeded", "ETIMEDOUT"); };
  await assert.rejects(plugin.getSiteWatchHistory({ accountId: loginData.uid }), /timeout/);
  assert.equal(requests.length, 1);
});

test("a switched account cannot continue waiting collection read retries", async () => {
  settings.set("auth.userInfo", loginData);
  settings.set("auth.jwt", "fixture-token");
  const started = deferred<void>();
  respond = async () => {
    started.resolve();
    throw new axios.AxiosError("connection reset", "ECONNRESET");
  };
  const pending = plugin.getJmAccountCollection({ accountId: loginData.uid, collection: "follows" });
  const rejected = assert.rejects(pending, state.SessionChangedError);
  await started.promise;
  await plugin.clearPluginSession();
  await rejected;
  assert.equal(requests.length, 1);
});

test("cloud favorite advertises folder management and reads the authenticated folder list", async () => {
  settings.set("auth.jwt", "fixture-token");
  const bundle = await plugin.getCloudFavoriteSceneBundle();
  assert.equal((bundle.data.scene as { cloudFavoriteFolderManagement?: boolean }).cloudFavoriteFolderManagement, true);
  respond = async () => ({ status: 200, data: { code: 200, data: {
    folder_list: [{ FID: 9, name: "收藏资料夹" }],
  } } });
  assert.deepEqual(await plugin.listFavoriteFolders(), { items: [{ id: "9", name: "收藏资料夹" }] });
  const bundleFilter = await plugin.getCloudFavoriteFilterBundle();
  const scheme = bundleFilter.scheme as { fields: Array<{ options: Array<{ value: string }> }> };
  assert.deepEqual(scheme.fields[0]!.options.map((option) => option.value), ["", "9"]);
  assert.ok(requests.every((request) => request.headers.Authorization === "Bearer fixture-token"));
  respond = async () => ({ status: 200, data: {} });
  await assert.rejects(plugin.listFavoriteFolders(), /收藏夹资料读取不完整/);
});

test("favorite feeds can omit custom folders or return a reserved default row", async () => {
  settings.set("auth.jwt", "fixture-token");
  for (const { data, omitted } of [
    { data: { list: [{ id: "123" }], total: "267" }, omitted: true },
    { data: { code: 200, data: { list: [{ id: "123" }], total: "267", folder_list: null } } },
    { data: { code: 200, data: JSON.stringify({ list: [], total: 0, folder_list: null }) } },
    { data: { list: [{ id: "123" }], folder_list: [{ FID: "0" }] } },
  ]) {
    respond = async () => ({ status: 200, data });
    assert.deepEqual(await plugin.listFavoriteFolders(), {
      items: [], ...(omitted ? { folderListVerified: false } : {}),
    });
    const filter = await plugin.getCloudFavoriteFilterBundle();
    const scheme = filter.scheme as { fields: Array<{ options: Array<{ value: string }> }> };
    assert.deepEqual(scheme.fields[0]!.options.map((option) => option.value), [""]);
    assert.equal(filter.data.folderListVerified, omitted ? false : undefined);
  }

  const folder_list = [{ FID: 0 }, { FID: "9", name: "实际收藏夹" }];
  for (const data of [
    { list: [], total: 0, data: { folder_list } },
    { folder_list, data: { list: [], total: 0 } },
    { code: 200, data: { list: [], total: 0, folder_list } },
  ]) {
    respond = async () => ({ status: 200, data });
    assert.deepEqual(await plugin.listFavoriteFolders(), { items: [{ id: "9", name: "实际收藏夹" }] });
  }
});

test("an invalid folder snapshot never becomes the default-only filter", async () => {
  settings.set("auth.jwt", "fixture-token");
  for (const data of [
    { folder_list: null }, { list: [{}], total: 1, folder_list: null },
    { list: [], total: 267 }, { list: [], total: 0, folder_list: {} },
    { folder_id: "9", folder_list: [] },
    { folder_list: [{ FID: 9 }] },
    { folder_list: [{ FID: 9, name: "甲" }, { FID: "9", name: "乙" }] },
    { code: 403, data: JSON.stringify({ list: [], total: 0 }) },
  ]) {
    respond = async () => ({ status: 200, data });
    await assert.rejects(plugin.getCloudFavoriteFilterBundle(), "code" in data ? /HTTP 403/ : /收藏/);
  }
});

test("creating a folder sends selected IDs once and separately verifies the new folder and membership", async () => {
  settings.set("auth.jwt", "fixture-token");
  settings.set("auth.userInfo", { ...loginData, s: "fixture-avs" });
  for (const membership of [true, false]) {
    let created = false;
    requests.length = 0;
    respond = async (request) => {
      if (request.method === "post") {
        created = true;
        return { status: 200, data: { code: 200, data: { status: "ok" } } };
      }
      if (request.params.folder_id === "9") {
        const list = membership ? [{ id: 123 }, { id: "456" }] : [{ id: 123 }];
        return { status: 200, data: { total: list.length, list } };
      }
      return { status: 200, data: created
        ? { folder_list: [{ FID: "9", name: "收藏夹甲" }] }
        : { list: [{ id: "123" }], total: "267", folder_list: null } };
    };
    assert.deepEqual(await plugin.createFavoriteFolder({
      folderName: " 收藏夹甲 ", comicIds: ["123", "456", "0123"],
    }), {
      ok: true, folder: { id: "9", name: "收藏夹甲" },
      folders: [{ id: "9", name: "收藏夹甲" }], membershipVerified: membership,
    });
    assert.deepEqual(requests.map((request) => request.method), ["get", "post", "get", "get"]);
    const wire = new Request("https://fixture.invalid/favorite_folder", {
      method: "POST", body: favoriteFolderForm(requests[1]!),
    });
    assert.match(wire.headers.get("content-type") ?? "", /^multipart\/form-data; boundary=/);
    assert.deepEqual(Object.fromEntries(await wire.formData()), {
      type: "add", folder_id: "", folder_name: "收藏夹甲", aid: "123,456",
    });
    assert.ok(requests.every((request) => request.headers.Authorization === "Bearer fixture-token"));
    assert.ok(requests.every((request) => request.headers.Cookie === "AVS=fixture-avs"));
  }
});

test("an equivalent existing or in-flight folder name never causes a duplicate creation", async () => {
  settings.set("auth.jwt", "fixture-token");
  const reading = deferred<void>();
  const existing = deferred<{ status: number; data: unknown }>();
  respond = async () => { reading.resolve(); return existing.promise; };
  const create = plugin.createFavoriteFolder({ folderName: "Café" });
  const refused = assert.rejects(create, /已存在同名收藏夹/);
  await reading.promise;
  await assert.rejects(plugin.createFavoriteFolder({ folderName: "Café" }), /正在更新收藏夹/);
  existing.resolve({ status: 200, data: { folder_list: [{ FID: "7", name: "Cafe\u0301" }] } });
  await refused;
  assert.deepEqual(requests.map((request) => request.method), ["get"]);
});

test("batch move sends one official request and requires every selected comic in the destination", async () => {
  settings.set("auth.jwt", "fixture-token");
  for (const confirmed of [false, true]) {
    requests.length = 0;
    respond = async (request) => ({ status: 200, data: request.method === "post"
      ? { code: 200, data: { status: "ok" } }
      : { list: confirmed ? [{ id: "123" }, { id: 456 }] : [{ id: "123" }] },
    });
    const move = plugin.moveFavoriteToFolder({ folderId: "9", folderName: "收藏夹甲", comicIds: ["123", "456"] });
    if (confirmed) assert.deepEqual(await move, { ok: true });
    else await assert.rejects(move, /无法确认已移入/);
    assert.deepEqual(requests.map((request) => request.method), ["post", "get"]);
    assert.deepEqual(Object.fromEntries(favoriteFolderForm(requests[0]!)), {
      type: "move", folder_id: "9", folder_name: "收藏夹甲", aid: "123,456",
    });
  }
});

test("batch move finds older favorites past page two and never accepts an explicit default-scope page", async () => {
  settings.set("auth.jwt", "fixture-token");
  for (const scope of ["9", "0"]) {
    requests.length = 0;
    respond = async (request) => {
      if (request.method === "post") return { status: 200, data: { code: 200, data: { status: "ok" } } };
      const page = request.params.page;
      const list = page < 4 ? Array.from({ length: 20 }, (_, index) => ({ id: 1000 + page * 20 + index })) :
        [{ id: 123 }, { id: 456 }];
      return { status: 200, data: { folder_id: page < 4 ? "9" : scope, total: 62, list } };
    };
    const move = plugin.moveFavoriteToFolder({ folderId: "9", comicIds: ["123", "456"] });
    if (scope === "9") assert.deepEqual(await move, { ok: true });
    else await assert.rejects(move, /无法确认已移入/);
    assert.deepEqual(requests.map((request) => request.method), ["post", "get", "get", "get", "get"]);
    assert.deepEqual(requests.slice(1).map((request) => request.params.page), [1, 2, 3, 4]);
  }
});

test("a batch crossing a page boundary still sends only one write", async () => {
  settings.set("auth.jwt", "fixture-token");
  const ids = Array.from({ length: 27 }, (_, index) => String(index + 101));
  respond = async (request) => {
    if (request.method === "post") {
      assert.equal(favoriteFolderForm(request).get("aid"), ids.join(","));
      return { status: 200, data: { status: "ok" } };
    }
    const offset = (request.params.page - 1) * 20;
    return { status: 200, data: { total: 27, list: ids.slice(offset, offset + 20).map((id) => ({ id })) } };
  };
  assert.deepEqual(await plugin.moveFavoriteToFolder({ folderId: "9", comicIds: ids }), { ok: true });
  assert.deepEqual(requests.map((request) => request.method), ["post", "get", "get"]);
});

test("an in-flight folder move excludes duplicate moves and simultaneous metadata writes", async () => {
  settings.set("auth.jwt", "fixture-token");
  const posted = deferred<void>();
  const reply = deferred<{ status: number; data: unknown }>();
  respond = async (request) => {
    if (request.method === "post") { posted.resolve(); return reply.promise; }
    return { status: 200, data: { total: 1, list: [{ id: 123 }] } };
  };
  const payload = { folderId: "9", comicIds: ["123"] };
  const move = plugin.moveFavoriteToFolder(payload);
  await posted.promise;
  await assert.rejects(plugin.moveFavoriteToFolder(payload), /正在更新收藏夹/);
  await assert.rejects(plugin.createFavoriteFolder({ folderName: "另一个收藏夹" }), /正在更新收藏夹/);
  reply.resolve({ status: 200, data: { status: "ok" } });
  assert.deepEqual(await move, { ok: true });
  assert.deepEqual(requests.map((request) => request.method), ["post", "get"]);
});

test("a lost folder mutation receipt triggers exact readback without resending the write", async () => {
  settings.set("auth.jwt", "fixture-token");
  let posted = false;
  respond = async (request) => {
    if (request.method === "post") {
      posted = true;
      throw new axios.AxiosError("fixture missing receipt", "ECONNABORTED");
    }
    return { status: 200, data: { folder_list: posted ? [{ FID: 9, name: "新增收藏夹" }] : [] } };
  };
  assert.deepEqual(await plugin.createFavoriteFolder({ folderName: "新增收藏夹" }), {
    ok: true, folder: { id: "9", name: "新增收藏夹" }, folders: [{ id: "9", name: "新增收藏夹" }],
  });
  assert.deepEqual(requests.map((request) => request.method), ["get", "post", "get"]);
});

test("folder saves confirm a late directory update without posting again", async () => {
  settings.set("auth.jwt", "fixture-token");
  for (const type of ["edit", "add"]) {
    requests.length = 0;
    const oldFolder = { FID: 9, name: "原收藏夹" };
    const newFolder = { FID: type === "edit" ? 9 : 10, name: "新收藏夹" };
    let readAfterWrite = 0;
    let writes = 0;
    respond = async (request) => {
      if (request.method === "post") {
        writes++;
        assert.equal(favoriteFolderForm(request).get("type"), type);
        return { status: 200, data: type === "edit" ? { status: "ok" } : {} };
      }
      const committed = writes > 0 && ++readAfterWrite > 1;
      const folders = committed ? type === "edit" ? [newFolder] : [oldFolder, newFolder] : [oldFolder];
      return { status: 200, data: { folder_list: folders } };
    };
    const result = type === "edit"
      ? await plugin.renameFavoriteFolder({ folderId: "9", folderName: newFolder.name })
      : await plugin.createFavoriteFolder({ folderName: newFolder.name });
    assert.deepEqual(result.folder, { id: String(newFolder.FID), name: newFolder.name });
    assert.deepEqual(requests.map((request) => request.method), ["get", "post", "get", "get"]);
    assert.ok(requests.slice(2).every((request) => request.headers.get("cache-control") === "no-cache"));
  }
});

test("folder readback can recover from a transient error but respects Retry-After and account changes", async () => {
  settings.set("auth.jwt", "fixture-token");
  for (const failure of [503, 429, "account"]) {
    requests.length = 0;
    let posted = false;
    let readsAfterWrite = 0;
    respond = async (request) => {
      if (request.method === "post") {
        posted = true;
        return { status: 200, data: { status: "ok" } };
      }
      if (!posted) return { status: 200, data: { folder_list: [] } };
      assert.ok(request.timeout !== undefined && request.timeout > 0 && request.timeout <= 3500);
      if (++readsAfterWrite === 1 && failure === "account") {
        settings.set("auth.jwt", "different-fixture-account");
      } else if (readsAfterWrite === 1) {
        const headers: Record<string, string> = failure === 429 ? { "retry-after": "120" } : {};
        return { status: Number(failure), data: {}, headers };
      }
      return { status: 200, data: { folder_list: [{ FID: 9, name: "新收藏夹" }] } };
    };
    const mutation = plugin.createFavoriteFolder({ folderName: "新收藏夹" });
    if (failure === 503) {
      assert.equal((await mutation).folder?.id, "9");
      assert.deepEqual(requests.map((request) => request.method), ["get", "post", "get", "get"]);
    } else {
      await assert.rejects(mutation, failure === 429 ? /HTTP 429 Retry-After: 120/ : state.SessionChangedError);
      assert.deepEqual(requests.map((request) => request.method), ["get", "post", "get"]);
    }
  }
});

test("rename and delete use the official form and verify the original folder ID", async () => {
  settings.set("auth.jwt", "fixture-token");
  let folders = [{ FID: "9", name: "原收藏夹" }, { FID: "10", name: "其他" }];
  respond = async (request) => {
    if (request.method === "get") return { status: 200, data: { folder_list: folders } };
    const form = Object.fromEntries(favoriteFolderForm(request));
    if (form.type === "edit") {
      assert.deepEqual(form, { type: "edit", folder_id: "9", folder_name: "新收藏夹", aid: "" });
      folders = [{ FID: "9", name: "新收藏夹" }, folders[1]!];
    } else {
      assert.deepEqual(form, { type: "del", folder_id: "9", folder_name: "新收藏夹", aid: "" });
      folders = [folders[1]!];
    }
    return { status: 200, data: { code: 200, data: { status: "ok" } } };
  };
  assert.deepEqual(await plugin.renameFavoriteFolder({ folderId: "9", folderName: "新收藏夹" }),
    { ok: true, folder: { id: "9", name: "新收藏夹" },
      folders: [{ id: "9", name: "新收藏夹" }, { id: "10", name: "其他" }] });
  assert.deepEqual(await plugin.deleteFavoriteFolder({ folderId: "9", folderName: "旧缓存名" }),
    { ok: true, folders: [{ id: "10", name: "其他" }] });
  assert.deepEqual(requests.map((request) => request.method), ["get", "post", "get", "get", "post", "get"]);
});

test("prepared rename and create each move the preflight out of the save path and still verify the write", async () => {
  settings.set("auth.jwt", "fixture-token");
  const folders = [{ FID: "9", name: "原收藏夹" }];
  respond = async (request) => {
    if (request.method === "get") return { status: 200, data: { folder_list: [...folders] } };
    const form = favoriteFolderForm(request);
    if (form.get("type") === "edit") folders[0] = { FID: "9", name: String(form.get("folder_name")) };
    else folders.push({ FID: "10", name: String(form.get("folder_name")) });
    return { status: 200, data: { status: "ok" } };
  };

  for (const folderId of ["9", undefined]) {
    requests.length = 0;
    const { preflightId } = await plugin.prepareJmFavoriteFolderChange({ folderId });
    assert.deepEqual(requests.map((request) => request.method), ["get"]);
    requests.length = 0;
    const renamed = { folderId, folderName: "新名字", preflightId };
    const result = folderId === undefined
      ? await plugin.createFavoriteFolder({ ...renamed, folderName: "新增" })
      : await plugin.renameFavoriteFolder(renamed);
    assert.equal(result.folder?.id, folderId ?? "10");
    assert.deepEqual(requests.map((request) => request.method), ["post", "get"]);

    requests.length = 0;
    if (folderId === undefined) {
      await assert.rejects(plugin.createFavoriteFolder({ ...renamed, folderName: "新增" }), /已存在同名收藏夹/);
    } else {
      await plugin.renameFavoriteFolder(renamed);
    }
    assert.deepEqual(requests.map((request) => request.method), ["get"]);
  }
});

test("an expired preparation rechecks the current directory, and changing accounts prevents its use", async () => {
  settings.set("auth.jwt", "fixture-token");
  let folders = [{ FID: "9", name: "原收藏夹" }];
  respond = async (request) => {
    assert.equal(request.method, "get");
    return { status: 200, data: { folder_list: folders } };
  };
  const stale = await plugin.prepareJmFavoriteFolderChange({ folderId: "9" });
  const now = Date.now;
  try {
    Date.now = () => now() + 6000;
    folders = [...folders, { FID: "10", name: "其他客户端新增" }];
    await assert.rejects(plugin.renameFavoriteFolder({ ...stale, folderId: "9", folderName: "其他客户端新增" }),
      /已存在同名收藏夹/);
  } finally {
    Date.now = now;
  }
  requests.length = 0;
  const active = await plugin.prepareJmFavoriteFolderChange({ folderId: "9" });
  settings.set("auth.jwt", "other-fixture-session");
  await assert.rejects(plugin.renameFavoriteFolder({ ...active, folderId: "9", folderName: "新名字" }),
    state.SessionChangedError);
  assert.deepEqual(requests.map((request) => request.method), ["get"]);
});

test("a verified folder directory skips the extra pre-save read and never replaces the confirmation read", async () => {
  settings.set("auth.jwt", "fixture-token");
  let rows = [{ FID: "9", name: "原收藏夹" }];
  respond = async (request) => {
    if (request.method === "post") {
      rows = [{ FID: "9", name: "新名字" }];
      return { status: 200, data: { status: "ok" } };
    }
    return { status: 200, data: { folder_list: rows } };
  };

  await plugin.listFavoriteFolders();
  const preparation = await plugin.prepareJmFavoriteFolderChange({ folderId: "9" });
  assert.deepEqual(requests.map((request) => request.method), ["get"]);
  const result = await plugin.renameFavoriteFolder({
    folderId: "9", folderName: "新名字", reportFolderFailure: true, ...preparation,
  });
  assert.equal(result.folder?.name, "新名字");
  assert.deepEqual(requests.map((request) => request.method), ["get", "post", "get"]);
});

test("saving during an in-flight folder preparation joins its read without a second preflight", async () => {
  settings.set("auth.jwt", "fixture-token");
  const started = deferred<void>();
  const release = deferred<void>();
  let created = false;
  respond = async (request) => {
    if (requests.length === 1) {
      started.resolve();
      await release.promise;
      return { status: 200, data: { folder_list: [] } };
    }
    if (request.method === "post") {
      created = true;
      return { status: 200, data: { status: "ok" } };
    }
    assert.equal(created, true);
    return { status: 200, data: { folder_list: [{ FID: "9", name: "新增" }] } };
  };
  const preparation = plugin.prepareJmFavoriteFolderChange().catch(() => undefined);
  await started.promise;
  const save = plugin.createFavoriteFolder({ folderName: "新增", reportFolderFailure: true });
  release.resolve();
  await preparation;
  assert.equal((await save).folder?.id, "9");
  assert.deepEqual(requests.map((request) => request.method), ["get", "post", "get"]);
});

test("a preparation completing after another folder write cannot become the next write's preflight", async () => {
  settings.set("auth.jwt", "fixture-token");
  const preparing = deferred<void>();
  const releasePreparation = deferred<void>();
  let folders: { FID: string; name: string }[] = [];
  respond = async (request) => {
    if (requests.length === 1) {
      const before = folders;
      preparing.resolve();
      await releasePreparation.promise;
      return { status: 200, data: { folder_list: before } };
    }
    if (request.method === "post") {
      folders = [{ FID: "9", name: "另一次新建" }];
      return { status: 200, data: { status: "ok" } };
    }
    return { status: 200, data: { folder_list: folders } };
  };
  const preparation = plugin.prepareJmFavoriteFolderChange();
  await preparing.promise;
  const refused = assert.rejects(preparation, /收藏夹资料读取不完整/);
  await plugin.createFavoriteFolder({ folderName: "另一次新建" });
  releasePreparation.resolve();
  await refused;
  assert.deepEqual(requests.map((request) => request.method), ["get", "get", "post", "get"]);
});

test("folder failures identify before-write failure, explicit folder limit, and unconfirmed readback", async () => {
  settings.set("auth.jwt", "fixture-token");
  const payload = { folderName: "新增", reportFolderFailure: true };
  const checkFailure = (phase: string, reason: string, folderCount?: number) => (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.deepEqual(JSON.parse(error.message), {
      type: "jm_folder_change", phase, reason, ...(folderCount === undefined ? {} : { folderCount }),
    });
    return true;
  };
  respond = async () => ({ status: 503, data: {} });
  await assert.rejects(plugin.createFavoriteFolder(payload), checkFailure("notSubmitted", "unavailable"));
  assert.deepEqual(requests.map((request) => request.method), ["get"]);

  requests.length = 0;
  respond = async (request) => request.method === "post"
    ? { status: 200, data: { code: 400, msg: "資料夾數量已達上限" } }
    : { status: 200, data: { folder_list: [{ FID: 1, name: "现有" }, { FID: 2, name: "另一个" }] } };
  await assert.rejects(plugin.createFavoriteFolder(payload), checkFailure("rejected", "limit", 2));
  assert.deepEqual(requests.map((request) => request.method), ["get", "post"]);

  requests.length = 0;
  respond = async (request) => request.method === "post"
    ? { status: 200, data: { code: 400, msg: "請求次數已達上限" } }
    : { status: 200, data: { folder_list: [] } };
  await assert.rejects(plugin.createFavoriteFolder(payload), checkFailure("unconfirmed", "unavailable"));
  assert.deepEqual(requests.map((request) => request.method), ["get", "post"]);

  requests.length = 0;
  respond = async (request) => request.method === "post"
    ? { status: 200, data: { status: "ok" } }
    : { status: 200, data: { folder_list: [] } };
  await assert.rejects(plugin.createFavoriteFolder(payload), checkFailure("unconfirmed", "unavailable"));
  assert.deepEqual(requests.map((request) => request.method), ["get", "post", "get", "get", "get"]);
});

test("folder management rejects missing proof, target substitutions, and missing deletion proof", async () => {
  settings.set("auth.jwt", "fixture-token");
  const existing = [{ FID: "9", name: "旧收藏夹" }];
  let after = false;
  let receipt: unknown = {};
  let readback = existing;
  respond = async (request) => {
    if (request.method === "get") return { status: 200, data: { folder_list: after ? readback : existing } };
    after = true;
    return { status: 200, data: receipt };
  };
  await assert.rejects(plugin.createFavoriteFolder({ folderName: "新收藏夹" }), /无法确认收藏夹更新/);
  assert.deepEqual(requests.map((request) => request.method), ["get", "post", "get", "get", "get"]);

  after = false;
  requests.length = 0;
  receipt = { code: 200, data: { status: "ok" } };
  readback = [{ FID: "10", name: "新收藏夹" }];
  await assert.rejects(plugin.renameFavoriteFolder({ folderId: "9", folderName: "新收藏夹" }), /无法确认收藏夹更新/);
  assert.deepEqual(requests.map((request) => request.method), ["get", "post", "get"]);

  after = false;
  requests.length = 0;
  readback = existing;
  await assert.rejects(plugin.deleteFavoriteFolder({ folderId: "9" }), /无法确认收藏夹更新/);
  assert.deepEqual(requests.map((request) => request.method), ["get", "post", "get"]);
});

test("delete accepts explicit null for the last folder only with an authentic acknowledgement", async () => {
  settings.set("auth.jwt", "fixture-token");
  for (const { after, succeeds, others, lost } of [
    { after: {}, succeeds: false },
    { after: { folder_list: null }, succeeds: false, others: true },
    { after: { folder_list: null }, succeeds: false, lost: true },
    { after: { folder_list: null }, succeeds: true },
    { after: { folder_list: [] }, succeeds: true },
    { after: { folder_list: [{ FID: 0 }] }, succeeds: true },
  ]) {
    let posted = false;
    requests.length = 0;
    respond = async (request) => {
      if (request.method === "post") {
        posted = true;
        if (lost) throw new axios.AxiosError("fixture missing receipt", "ECONNABORTED");
        return { status: 200, data: { code: 200, data: { status: "ok" } } };
      }
      return { status: 200, data: posted ? { list: [{ id: "123" }], total: "267", ...after } :
        { folder_list: [{ FID: 9, name: "旧收藏夹" }, ...(others ? [{ FID: 10, name: "另一个" }] : [])] } };
    };
    const deletion = plugin.deleteFavoriteFolder({ folderId: "9" });
    if (succeeds) assert.deepEqual(await deletion, { ok: true, folders: [] });
    else await assert.rejects(deletion, /无法确认收藏夹更新/);
    assert.deepEqual(requests.map((request) => request.method), ["get", "post", "get"]);
  }
});

test("folder writes detect replacement of a saved account before committing on the same revision", async () => {
  settings.set("auth.jwt", "fixture-token");
  respond = async () => {
    settings.set("auth.jwt", "other-fixture-session");
    return { status: 200, data: { folder_list: [] } };
  };
  await assert.rejects(plugin.createFavoriteFolder({ folderName: "新收藏夹" }), state.SessionChangedError);
  assert.deepEqual(requests.map((request) => request.method), ["get"]);
});

test("refreshing folders after a line change uses the new line and rejects the old response", async () => {
  settings.set("auth.jwt", "fixture-token");
  settings.set("auth.userInfo", { ...loginData, s: "fixture-avs" });
  const saved = { bases: Config.baseUrls, index: Config.baseUrlIndex };
  const former = Config.baseUrl;
  const selected = "https://new-line.fixture.invalid";
  const started = deferred<void>();
  const finishFormer = deferred<void>();
  try {
    Config.baseUrls = [former, selected];
    Config.baseUrlIndex = 0;
    respond = async (request) => {
      assert.equal(request.method, "get");
      assert.equal(request.headers.Authorization, "Bearer fixture-token");
      assert.equal(request.headers.Cookie, "AVS=fixture-avs");
      if (request.url === `${former}/favorite`) {
        started.resolve();
        await finishFormer.promise;
        return { status: 200, data: { folder_list: [{ FID: 9, name: "原名称" }] } };
      }
      assert.equal(request.url, `${selected}/favorite`);
      assert.equal(request.headers.get("cache-control"), "no-cache");
      assert.deepEqual((request as InternalAxiosRequestConfig & { fetchOptions?: unknown }).fetchOptions, {
        redirect: "error", breezeReadScope: "folder-refresh-fixture",
      });
      return { status: 200, data: { folder_list: [{ FID: 9, name: "新名称" }] } };
    };
    const formerRead = assert.rejects(plugin.listFavoriteFolders(), /接口线路已变更/);
    await started.promise;
    Config.baseUrlIndex = 1;
    try {
      assert.deepEqual(await plugin.listFavoriteFolders({
        refresh: true, __breezeReadScope: "folder-refresh-fixture",
      }), { items: [{ id: "9", name: "新名称" }] });
    } finally {
      finishFormer.resolve();
      await formerRead;
    }
    assert.deepEqual(requests.map((request) => request.url), [`${former}/favorite`, `${selected}/favorite`]);
  } finally {
    Config.baseUrls = saved.bases;
    Config.baseUrlIndex = saved.index;
  }
});

test("folder writes stop before dispatch when the effective line changes during header preparation", async () => {
  settings.set("auth.jwt", "fixture-token");
  const before = { bases: Config.baseUrls, index: Config.baseUrlIndex };
  const hashing = deferred<void>();
  const resume = deferred<void>();
  storageGate = async (name) => {
    if (!name.includes("md5")) return;
    hashing.resolve();
    await resume.promise;
  };
  try {
    Config.baseUrls = [Config.baseUrl, "https://new-line.fixture.invalid"];
    Config.baseUrlIndex = 0;
    const move = plugin.moveFavoriteToFolder({ folderId: "9", comicIds: ["123"] });
    const refusal = assert.rejects(move, /接口线路已变更/);
    await hashing.promise;
    Config.baseUrlIndex = 1;
    resume.resolve();
    await refusal;
    assert.equal(requests.length, 0);
  } finally {
    Config.baseUrls = before.bases;
    Config.baseUrlIndex = before.index;
  }
});

test("folder creation stops when the originating account changes before membership verification", async () => {
  settings.set("auth.jwt", "fixture-token");
  const started = deferred<void>();
  const membership = deferred<{ status: number; data: unknown }>();
  let created = false;
  respond = async (request) => {
    if (request.method === "post") {
      created = true;
      return { status: 200, data: { code: 200, data: { status: "ok" } } };
    }
    if (request.params.folder_id === "9") {
      started.resolve();
      return membership.promise;
    }
    return { status: 200, data: { folder_list: created ? [{ FID: "9", name: "收藏夹甲" }] : [] } };
  };
  const creation = plugin.createFavoriteFolder({ folderName: "收藏夹甲", comicIds: ["123"] });
  const refused = assert.rejects(creation, state.SessionChangedError);
  await started.promise;
  await plugin.clearPluginSession();
  membership.resolve({ status: 200, data: { list: [{ id: "123" }] } });
  await refused;
  assert.deepEqual(requests.map((request) => request.method), ["get", "post", "get", "get"]);
});

test("cloud favorite reads accept real zero and preserve a known nonzero count", async () => {
  settings.set("auth.jwt", "fixture-token");
  respond = async () => ({ status: 200, data: { list: [], total: "0" } });
  const empty = await plugin.getCloudFavoriteData();
  assert.equal(empty.data.total, 0);
  assert.equal(empty.data.hasReachedMax, true);
  assert.deepEqual(empty.data.items, []);

  respond = async () => ({ status: 200, data: { code: 200, data: {
    list: Array.from({ length: 20 }, (_, index) => ({ id: String(123 + index), name: "fixture-work" })), total: "21",
  } } });
  const populated = await plugin.getCloudFavoriteData();
  assert.equal(populated.data.total, 21);
  assert.equal(populated.data.hasReachedMax, false);
  assert.equal(populated.data.items.length, 20);
  assert.equal(populated.data.items[0]?.id, "123");
  respond = async () => ({ status: 200, data: {
    list: [{ id: "123", name: "fixture-work" }], total: "21",
  } });
  await assert.rejects(plugin.getCloudFavoriteData(), /收藏资料读取不完整/);

  respond = async () => ({ status: 200, data: { list: [{ id: "123", name: "fixture-work" }] } });
  const unknown = await plugin.getCloudFavoriteData();
  assert.equal("total" in unknown.data, false);
  assert.equal(unknown.data.hasReachedMax, false);
  assert.deepEqual(unknown.data.items.map((item) => item.id), ["123"]);
});

test("legacy default filter scope reads the aggregate feed and custom scopes reject an explicit mismatch", async () => {
  settings.set("auth.jwt", "fixture-token");
  respond = async () => ({ status: 200, data: { folder_id: 0, list: [], total: 0 } });
  assert.deepEqual((await plugin.getCloudFavoriteData({ folderId: "0" })).data.items, []);
  assert.deepEqual(requests[0]!.params, { page: 1, folder_id: "", o: "mr" });
  await assert.rejects(plugin.getCloudFavoriteData({ folderId: "9", order: "mp" }), /收藏资料读取不完整/);
  assert.deepEqual(requests[1]!.params, { page: 1, folder_id: "9", o: "mp" });
  await assert.rejects(plugin.moveFavoriteToFolder({ folderId: "0", comicIds: ["123"] }), /收藏夹编号无效/);
  assert.equal(requests.length, 2);
});

test("favorite read failures carry status evidence without weakening write confirmation", async () => {
  settings.set("auth.jwt", "fixture-token");
  for (const [http, code, expected, retryable] of [
    [503, undefined, 503, true],
    [200, 429, 429, true],
    [403, undefined, 403, false],
  ] as const) {
    respond = async () => ({ status: http, data: { code, message: "internal diagnostic" } });
    await assert.rejects(plugin.getCloudFavoriteData(), {
      message: `HTTP ${expected}`,
      retryable,
    });
  }

  respond = async () => ({ status: 503, data: {} });
  await assert.rejects(plugin.toggleFavorite({ comicId: "123" }), /未确认收藏操作/);
  assert.deepEqual(requests.map((request) => request.method), ["get", "get", "get", "get", "post"]);
});

test("a transient favorite page error retries only that page on the same account and line", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  settings.set("auth.jwt", "fixture-token");
  respond = async () => requests.length === 1
    ? { status: 500, data: {} }
    : { status: 200, data: { total: 21, list: [{ id: "123", name: "fixture-work" }] } };
  const pending = plugin.getCloudFavoriteData({ page: 2, order: "mr" });
  await setImmediate();
  assert.equal(requests.length, 1);
  context.mock.timers.tick(600);
  const result = await pending;
  assert.deepEqual(result.data.items.map((work) => work.id), ["123"]);
  assert.equal(result.data.total, 21);
  assert.deepEqual(requests.map((request) => request.params), [
    { page: 2, folder_id: "", o: "mr" },
    { page: 2, folder_id: "", o: "mr" },
  ]);
  assert.equal(requests[0]!.url, requests[1]!.url);
});

test("cloud favorite reads reject malformed or failed replies rather than replacing the collection", async () => {
  settings.set("auth.jwt", "fixture-token");
  for (const data of [
    {}, { list: [] }, { total: 0 }, { list: [], total: null }, { list: [], total: true },
    { list: [], total: 1 }, { list: [{ id: "123" }], total: 0 }, { list: [{}], total: 1 },
    { code: 403, data: JSON.stringify({ list: [], total: 0 }) },
  ]) {
    respond = async () => ({ status: 200, data });
    await assert.rejects(plugin.getCloudFavoriteData(), "code" in data ? /HTTP 403/ : /收藏/);
  }
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

for (const failure of [503, "ECONNABORTED"]) {
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

test("a rate limit keeps its own Retry-After value and automatic login does not immediately retry", async () => {
  storedCredentials();
  respond = async () => ({ status: 429, data: { message: "fixture-body" }, headers: { "retry-after": "120" } });
  await assert.rejects(plugin.loginWithPassword(loginPayload), { message: "HTTP 429 Retry-After: 120" });
  await runJmAuthAndCheckInLoop();
  assert.equal(requests.length, 2);
});

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


for (const [message, shouldNotify] of [
  ["签到成功", true], ["Jcoin:10 EXP:10", true],
  ["今天已经签到过了", false], ["今天已經簽到過了", false],
  ["签到失败", false],
] as const) {
  test(`automatic check-in only notifies for a new completion (${message})`, async () => {
    storedCredentials();
    respond = async (request) => {
      const path = new URL(request.url!).pathname;
      if (path === "/login") return { status: 200, data: loginData };
      if (path === "/daily_list/filter") return { status: 200, data: { list: [{ id: "fixture-day" }] } };
      assert.equal(path, "/daily_chk");
      return { status: 200, data: { msg: message } };
    };
    await runJmAuthAndCheckInLoop();
    const firstRequestPaths = requests.map(request => new URL(request.url!).pathname);
    assert.deepEqual(firstRequestPaths, ["/login", "/daily_list/filter", "/daily_chk"]);
    if (shouldNotify) await runJmAuthAndCheckInLoop();
    assert.deepEqual(checkinNotices, shouldNotify ? [{
      accountId: loginData.uid,
      date: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
    }] : []);
  });
}

test("a manual caller sharing the automatic check-in owns the feedback", async () => {
  storedCredentials();
  const checkinStarted = deferred<void>();
  const finishCheckin = deferred<void>();
  respond = async (request) => {
    const path = new URL(request.url!).pathname;
    if (path === "/login") return { status: 200, data: loginData };
    if (path === "/daily_list/filter") return { status: 200, data: { list: [{ id: "fixture-day" }] } };
    assert.equal(path, "/daily_chk");
    checkinStarted.resolve();
    await finishCheckin.promise;
    return { status: 200, data: { msg: "签到成功" } };
  };
  const automatic = runJmAuthAndCheckInLoop();
  await checkinStarted.promise;
  const manual = plugin.checkInToday();
  await setImmediate();
  finishCheckin.resolve();
  await automatic;
  assert.equal((await manual).data.ok, true);
  assert.equal(requests.filter(request => request.url?.endsWith("/daily_chk")).length, 1);
  assert.deepEqual(checkinNotices, []);
});

for (const message of ["签到成功", "今天已经签到过了", "今天已經簽到過了", "Jcoin:10 EXP:10", "Jcoin:40 EXP:40"]) {
  test(`confirmed check-in receipt survives profile refresh (${message})`, async () => {
    settings.set("auth.userInfo", loginData);
    respond = async (config) => ({ status: 200, data:
      config.url?.includes("daily_list") ? { list: [{ id: "fixture-day" }] } : { msg: message },
    });
    const result = await plugin.checkInToday();
    assert.equal(result.data.ok, true);
    assert.equal(result.data.checkedIn, true);
    assert.equal(result.data.accountId, loginData.uid);
    assert.match(result.data.checkedInDate!, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal((await plugin.getUserInfoBundle()).data.extern?.checkedIn, true);
    await plugin.checkInToday();
    assert.equal(requests.length, 2);
    assert.deepEqual(checkinNotices, []);
    settings.set("auth.userInfo", { ...loginData, uid: "another-account" });
    assert.equal((await plugin.getUserInfoBundle()).data.extern?.checkedIn, null);
    await plugin.clearPluginSession();
    assert.deepEqual(settings.get("auth.checkin"), {});
  });
}

for (const reply of [{ msg: "Jcoin:10 EXP:10 签到失败" }, { code: 500, msg: "签到成功" }, {}, { status: false, msg: "签到成功" }, { msg: "签到失败" }, { msg: "今日签到已完成，请稍后重试" }]) {
  test(`unconfirmed check-in creates no receipt (${JSON.stringify(reply)})`, async () => {
    settings.set("auth.userInfo", loginData);
    respond = async (config) => ({ status: 200, data:
      config.url?.includes("daily_list") ? { list: [{ id: "fixture-day" }] } : reply,
    });
    const result = await plugin.checkInToday();
    assert.equal(result.data.ok, false);
    assert.equal(result.data.checkedIn, null);
    assert.equal(settings.has("auth.checkin"), false);
  });
}

test("empty daily list is unknown, not a completed check-in", async () => {
  settings.set("auth.userInfo", loginData);
  respond = async () => ({ status: 200, data: { list: [] } });
  assert.equal((await plugin.checkInToday()).data.ok, false);
});

test("concurrent check-ins share requests and clearing blocks late receipt", async () => {
  settings.set("auth.userInfo", loginData);
  const response = deferred<{ status: number; data: unknown }>();
  respond = async (config) => config.url?.includes("daily_list")
    ? { status: 200, data: { list: [{ id: "fixture-day" }] } } : response.promise;
  const first = plugin.checkInToday().catch((error) => error);
  const second = plugin.checkInToday().catch((error) => error);
  await setImmediate();
  assert.equal(requests.length, 2);
  await plugin.clearPluginSession();
  response.resolve({ status: 200, data: { msg: "签到成功" } });
  assert.ok(await first instanceof state.SessionChangedError);
  assert.ok(await second instanceof state.SessionChangedError);
  assert.deepEqual(settings.get("auth.checkin"), {});
});


test("a previous-day receipt is unknown and a failed retry preserves the receipt", async () => {
  settings.set("auth.userInfo", loginData);
  const receipt = { accountId: loginData.uid, checkedInDate: "2000-01-01" };
  settings.set("auth.checkin", receipt);
  assert.equal((await plugin.getUserInfoBundle()).data.extern?.checkedIn, null);
  respond = async () => ({ status: 200, data: { list: [] } });
  assert.equal((await plugin.checkInToday()).data.checkedIn, null);
  assert.deepEqual(settings.get("auth.checkin"), receipt);
});


test("check-in receipts use UTC+8 and stop matching at midnight", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 1, 15, 59, 59) });
  settings.set("auth.userInfo", loginData);
  respond = async (config) => ({ status: 200, data:
    config.url?.includes("daily_list") ? { list: [{ id: "fixture-day" }] } : { msg: "今天已经签到过了" },
  });
  assert.equal((await plugin.checkInToday()).data.checkedInDate, "2026-11-01");
  context.mock.timers.tick(1000);
  assert.equal((await plugin.getUserInfoBundle()).data.extern?.checkedIn, null);
  assert.equal((await plugin.checkInToday()).data.checkedInDate, "2026-11-02");
});

test("a response crossing UTC+8 midnight cannot sign the new day", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 1, 15, 59, 59) });
  settings.set("auth.userInfo", loginData);
  respond = async (config) => {
    if (config.url?.includes("daily_list")) return { status: 200, data: { list: [{ id: "fixture-day" }] } };
    context.mock.timers.tick(1000);
    return { status: 200, data: { msg: "签到成功" } };
  };
  assert.equal((await plugin.checkInToday()).data.checkedIn, null);
  assert.equal(settings.has("auth.checkin"), false);
});

for (const failure of ["ERR_NETWORK", "ECONNABORTED"]) {
  test(`network failure never becomes already-signed (${failure})`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    settings.set("auth.userInfo", loginData);
    respond = async () => { throw Object.assign(new Error("fixture failure"), { code: failure }); };
    const flow = plugin.checkInToday();
    await setImmediate();
    context.mock.timers.tick(1000);
    await setImmediate();
    context.mock.timers.tick(2000);
    const result = await flow;
    assert.equal(result.data.ok, false);
    assert.equal(result.data.checkedIn, null);
    assert.equal(settings.has("auth.checkin"), false);
  });
}

function dailyRecord(signed: unknown, date = "01") {
  return { daily_id: 72, record: [[{ date, signed, bonus: false }]] };
}

test("cold profile reports typed sign-out without exposing partial credentials", async () => {
  for (const partial of [{}, { "auth.account": "private-fixture-account" },
    { "auth.password": "private-fixture-password" }]) {
    settings = new Map(Object.entries(partial));
    await assert.rejects(plugin.getUserInfoBundle(), (error: Error) => {
      const payload = JSON.parse(error.message);
      assert.deepEqual(Object.keys(payload).sort(), ["message", "source", "type"]);
      assert.equal(payload.source, "6886291b-f524-441c-844b-c2efae9899a9");
      assert.equal(payload.type, "unauthorized");
      assert.doesNotMatch(error.message, /private-fixture/);
      return true;
    });
  }
  assert.equal(requests.length, 0);
});

test("cold profile with usable saved credentials restores its existing session", async () => {
  storedCredentials();
  respond = async (config) => ({ status: 200,
    data: new URL(config.url!).pathname === "/login" ? loginData : dailyRecord(false) });
  const profile = await plugin.getUserInfoBundle();
  assert.equal(profile.data.avatar?.id, loginData.uid);
  assert.equal(settings.get("auth.jwt"), loginData.jwttoken);
  assert.deepEqual(requests.map((request) => [request.method, new URL(request.url!).pathname]),
    [["post", "/login"], ["get", "/daily"]]);
});

test("cold profile preserves retry for incomplete receipts, malformed restore and transport", async () => {
  const retry = { name: "JmRequestError", retryable: true };
  settings.set("auth.userInfo", { uid: loginData.uid });
  await assert.rejects(plugin.getUserInfoBundle(), retry);
  settings.delete("auth.userInfo");
  settings.set("auth.jwt", loginData.jwttoken);
  await assert.rejects(plugin.getUserInfoBundle(), retry);
  settings.delete("auth.jwt");
  await state.setJwtToken(loginData.jwttoken);
  await assert.rejects(plugin.getUserInfoBundle(), retry);
  assert.equal(requests.length, 0);

  storedCredentials();
  await assert.rejects(plugin.getUserInfoBundle(), retry);
  respond = async () => ({ status: 200, data: null });
  await assert.rejects(plugin.getUserInfoBundle(), retry);
  respond = async () => { throw new Error("fixture transport unavailable"); };
  await assert.rejects(plugin.getUserInfoBundle(), /fixture transport unavailable/);
  assert.equal(requests.length, 3);
});

test("cold profile does not infer sign-out from a malformed configuration response", async () => {
  malformedSetting = "auth.userInfo";
  await assert.rejects(plugin.getUserInfoBundle(), { name: "JmRequestError", retryable: true });
  assert.equal(requests.length, 0);
});

test("profile reads today's server record without posting a check-in", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 1, 4) });
  settings.set("auth.userInfo", loginData);
  respond = async () => ({ status: 200, data: dailyRecord(true) });
  const result = await plugin.getUserInfoBundle();
  assert.equal(result.data.extern?.checkedIn, true);
  assert.equal(result.data.extern?.checkedInDate, "2026-11-01");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.method, "get");
  assert.equal(new URL(requests[0]!.url!).pathname, "/daily");
  assert.equal(requests[0]!.params.user_id, loginData.uid);
  assert.equal((await plugin.checkInToday()).data.ok, true);
  assert.equal(requests.length, 1);
});

for (const data of [dailyRecord(false), dailyRecord(null), dailyRecord("true"), dailyRecord(true, "02"), { ...dailyRecord(true), code: 500 }, { data: { ...dailyRecord(true), code: 500 } }, { record: dailyRecord(true).record }, { ...dailyRecord(true), record: [dailyRecord(true).record[0], dailyRecord(false).record[0]] }, {}, { error: "finished" }]) {
  test(`unknown server daily status establishes no receipt (${JSON.stringify(data)})`, async (context) => {
    context.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 1, 4) });
    settings.set("auth.userInfo", loginData);
    respond = async () => ({ status: 200, data });
    assert.equal((await plugin.getUserInfoBundle()).data.extern?.checkedIn, null);
    assert.equal(settings.has("auth.checkin"), false);
  });
}

test("daily read failure preserves a known receipt but never invents one", async () => {
  settings.set("auth.userInfo", loginData);
  respond = async () => { throw Object.assign(new Error("fixture failure"), { code: "ERR_NETWORK" }); };
  assert.equal((await plugin.getUserInfoBundle()).data.extern?.checkedIn, null);
  const checkedInDate = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  settings.set("auth.checkin", { accountId: loginData.uid, checkedInDate });
  assert.equal((await plugin.getUserInfoBundle()).data.extern?.checkedIn, true);
});

test("a calendar response crossing UTC+8 midnight establishes no receipt", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 1, 15, 59, 59) });
  settings.set("auth.userInfo", loginData);
  respond = async () => {
    context.mock.timers.tick(1000);
    return { status: 200, data: dailyRecord(true) };
  };
  assert.equal((await plugin.getUserInfoBundle()).data.extern?.checkedIn, null);
  assert.equal(settings.has("auth.checkin"), false);
});

test("clearing the account blocks a late signed calendar response", async () => {
  settings.set("auth.userInfo", loginData);
  const response = deferred<{ status: number; data: unknown }>();
  respond = () => response.promise;
  const profile = plugin.getUserInfoBundle().catch((error) => error);
  await setImmediate();
  await plugin.clearPluginSession();
  const day = new Date(Date.now() + 8 * 3600000).toISOString().slice(8, 10);
  response.resolve({ status: 200, data: dailyRecord(true, day) });
  assert.ok(await profile instanceof state.SessionChangedError);
  assert.deepEqual(settings.get("auth.checkin"), {});
});

test("another account cannot inherit a known receipt when calendar loading fails", async () => {
  const checkedInDate = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  settings.set("auth.checkin", { accountId: loginData.uid, checkedInDate });
  settings.set("auth.userInfo", { ...loginData, uid: "second-fixture" });
  respond = async () => { throw new Error("fixture failure"); };
  assert.equal((await plugin.getUserInfoBundle()).data.extern?.checkedIn, null);
});


test("a missing account id never matches a receipt or opens a calendar request", async () => {
  settings.set("auth.userInfo", { username: "fixture" });
  const checkedInDate = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  settings.set("auth.checkin", { accountId: "", checkedInDate });
  assert.equal((await plugin.getUserInfoBundle()).data.extern?.checkedIn, null);
  assert.equal(requests.length, 0);
});

test("check-in url aliases reach Axios with the exact POST paths and form fields", async () => {
  settings.set("auth.userInfo", loginData);
  respond = async (config) => {
    const path = new URL(config.url!).pathname;
    if (path === "/daily_list/filter") {
      return { status: 200, data: { list: [{ id: "fixture-event" }] } };
    }
    assert.equal(path, "/daily_chk", "unexpected check-in request path");
    return { status: 200, data: { msg: "今天已经签到过了" } };
  };
  assert.equal((await plugin.checkInToday()).data.ok, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((request) => [request.method, new URL(request.url!).pathname]), [
    ["post", "/daily_list/filter"],
    ["post", "/daily_chk"],
  ]);
  assert.equal(String(requests[0]!.headers["Content-Type"]), "application/x-www-form-urlencoded");
  assert.equal(String(requests[1]!.headers["Content-Type"]), "application/x-www-form-urlencoded");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(String(requests[0]!.data))), {
    data: String(new Date().getFullYear()),
  });
  assert.deepEqual(Object.fromEntries(new URLSearchParams(String(requests[1]!.data))), {
    user_id: loginData.uid, daily_id: "fixture-event",
  });
});

// Notification fixtures exercise the real JM request adapter without accounts,
// sockets, marking calls, or interpreting a missing response as an empty inbox.
test("notifications retain official payment text and nested total without opening its link", async () => {
  settings.set("auth.userInfo", loginData);
  respond = async () => ({ status: 200, data: { data: { total: 7, list: [
    { id: "notice-1", title: "<b>官方通知</b>", content: "查看 /payment?type=fixture<br>详情", read: 0, type: "site_notice" },
  ] } } });
  const result = await plugin.getNotifications();
  assert.equal(result.data.items.length, 1);
  assert.equal(result.data.items[0]!.title, "官方通知");
  assert.match(result.data.items[0]!.content, /\/payment\?type=fixture\n详情/);
  assert.equal(result.data.total, 7);
  assert.equal(result.data.totalKnown, true);
  assert.equal(result.data.complete, false);
  assert.equal(result.data.accountId, loginData.uid);
  assert.deepEqual(requests.map((request) => [request.method, new URL(request.url!).pathname]), [
    ["get", "/notifications"], ["get", "/notifications/unreadCount"],
  ]);
  assert.deepEqual(result.data.unreadSummary, { countsKnown: false, error: "unavailable" });
});

for (const data of [{}, { code: 500, msg: "fixture failure" }, { status: false, list: [] }, { data: { ok: false, list: [] } }]) {
  test(`notification refusal or unknown shape is never an empty inbox (${JSON.stringify(data)})`, async () => {
    respond = async () => ({ status: 200, data });
    await assert.rejects(plugin.getNotifications(), /消息/);
  });
}

test("notification read values distinguish true, false and unknown without guessing unread counts", async () => {
  respond = async () => ({ status: 200, data: { total: 5, list: [
    { id: "one", read: true }, { id: "two", read: "0" }, { id: "three", read: false },
    { id: "four" }, { id: "five", read: "unexpected" },
  ] } });
  const result = await plugin.getNotifications();
  assert.deepEqual(result.data.items.map((item) => [item.read, item.readKnown]), [
    [true, true], [false, true], [false, true], [null, false], [null, false],
  ]);
  assert.equal(result.data.knownUnreadCount, 2);
  assert.equal(result.data.unknownReadCount, 2);
  assert.equal(result.data.complete, true);
});

test("a legitimate empty notification list remains empty and list failures propagate", async () => {
  respond = async () => ({ status: 200, data: [] });
  assert.deepEqual((await plugin.getNotifications()).data.items, []);
  respond = async () => { throw Object.assign(new Error("fixture network unavailable"), { code: "ERR_NETWORK" }); };
  await assert.rejects(plugin.getNotifications(), /fixture network unavailable/);
});

test("a late notification list cannot cross an account change", async () => {
  settings.set("auth.userInfo", loginData);
  const response = deferred<{ status: number; data: unknown }>();
  respond = () => response.promise;
  const loading = plugin.getNotifications().catch((error) => error);
  await setImmediate();
  await plugin.clearPluginSession();
  settings.set("auth.userInfo", { ...loginData, uid: "second-fixture" });
  response.resolve({ status: 200, data: { total: 1, list: [{ id: "old-fixture", read: false }] } });
  assert.ok(await loading instanceof state.SessionChangedError);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.method, "get");
});

test("malformed notification rows never become a successful empty-looking inbox", async () => {
  respond = async () => ({ status: 200, data: { total: 1, list: [null] } });
  await assert.rejects(plugin.getNotifications(), /消息格式/);
});

test("capabilities never offer a session clearing action", async () => {
  const result = await plugin.getCapabilitiesBundle();
  assert.deepEqual(result.data.actions, ["speedtest"]);
  assert.deepEqual(result.scheme.actions.map((action) => action.fnPath), ["measureEndpointSpeeds"]);
});

test("official unread counters remain account-scoped and independent from loaded list size", async () => {
  settings.set("auth.userInfo", loginData);
  respond = async (config) => ({ status: 200, data: config.url!.endsWith("/unreadCount")
    ? { comic_follow: 0, site_notice: 2 } : [{ id: "fixture", read: true }] });
  const result = await plugin.getNotifications();
  assert.equal(result.data.items.length, 1);
  assert.equal(result.data.knownUnreadCount, 0);
  assert.equal(result.data.unreadSummary.total, 2);
  assert.equal(result.data.unreadSummary.comicFollow, 0);
  assert.equal(result.data.unreadSummary.siteNotice, 2);
  assert.equal(result.data.unreadSummary.countsKnown, true);
  assert.equal(result.data.unreadSummary.accountId, loginData.uid);
  assert.ok(requests.every((request) => request.method === "get"));
});

for (const data of [{}, { comic_follow: "0", site_notice: 2 }, { comic_follow: -1, site_notice: 2 },
  { comic_follow: 0, site_notice: null }, { comic_follow: 0, site_notice: 2, status: false }]) {
  test(`unknown unread counters fail rather than showing zero (${JSON.stringify(data)})`, async () => {
    settings.set("auth.userInfo", loginData);
    respond = async () => ({ status: 200, data });
    await assert.rejects(plugin.getNotificationUnreadCount(), /未读消息数量/);
  });
}

test("counter network failure leaves the message list usable without inventing a count", async () => {
  settings.set("auth.userInfo", loginData);
  respond = async (config) => {
    if (config.url!.endsWith("/unreadCount")) throw new Error("fixture unavailable");
    return { status: 200, data: [{ id: "fixture", read: false }] };
  };
  const result = await plugin.getNotifications();
  assert.equal(result.data.items.length, 1);
  assert.deepEqual(result.data.unreadSummary, { countsKnown: false, error: "unavailable" });
});

test("a late unread count cannot cross an account change", async () => {
  settings.set("auth.userInfo", loginData);
  const response = deferred<{ status: number; data: unknown }>();
  respond = () => response.promise;
  const loading = plugin.getNotificationUnreadCount().catch((error) => error);
  await setImmediate();
  await plugin.clearPluginSession();
  response.resolve({ status: 200, data: { comic_follow: 0, site_notice: 2 } });
  assert.ok(await loading instanceof state.SessionChangedError);
});

test("check-in recheck bypasses a current receipt using only GET and does not rewrite it", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 2, 4) });
  settings.set("auth.userInfo", loginData);
  const receipt = { accountId: loginData.uid, checkedInDate: "2026-11-02" };
  settings.set("auth.checkin", receipt);
  respond = async () => ({ status: 200, data: dailyRecord(true, "02") });
  const result = await plugin.getCheckinStatus();
  assert.equal(result.data.verification.status, "confirmed");
  assert.equal(result.data.checkinProof?.source, "serverCalendar");
  assert.equal(result.data.checkinProof?.verifiedThisRequest, true);
  assert.equal(result.data.checkinProof?.date, "2026-11-02");
  assert.deepEqual(settings.get("auth.checkin"), receipt);
  assert.deepEqual(requests.map((request) => [request.method, new URL(request.url!).pathname]), [["get", "/daily"]]);
  assert.equal(requests[0]!.params.user_id, loginData.uid);
  const profile = await plugin.getUserInfoBundle();
  assert.equal(profile.data.extern?.profileDataSource, "storedSession");
  assert.equal((profile.data.extern?.checkinProof as any).source, "savedReceipt");
  assert.equal((profile.data.extern?.checkinProof as any).confirmedAt, null);
  assert.equal((profile.data.extern?.checkinProof as any).verifiedThisRequest, false);
  assert.equal(requests.length, 1);
});

test("failed or conflicting calendar recheck never erases confirmed receipt or fabricates a live proof", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 2, 4) });
  settings.set("auth.userInfo", loginData);
  const receipt = { accountId: loginData.uid, checkedInDate: "2026-11-02", confirmedAt: "2026-11-02T01:00:00Z", evidenceSource: "dailyCheckin" };
  settings.set("auth.checkin", receipt);
  respond = async () => { throw new Error("fixture unavailable"); };
  const failed = await plugin.getCheckinStatus();
  assert.equal(failed.data.checkedIn, true);
  assert.equal(failed.data.verification.status, "failed");
  assert.equal(failed.data.checkinProof?.verifiedThisRequest, false);
  respond = async () => ({ status: 200, data: dailyRecord(false, "02") });
  const conflicting = await plugin.getCheckinStatus();
  assert.equal(conflicting.data.verification.status, "notSigned");
  assert.equal(conflicting.data.verification.signed, false);
  assert.equal(conflicting.data.checkinProof?.source, "savedReceipt");
  assert.deepEqual(settings.get("auth.checkin"), receipt);
});

test("profile verification requires a persisted JWT and keeps invalid storage distinct from rejection", async () => {
  settings.set("auth.userInfo", loginData);
  storedCredentials();
  respond = async () => ({ status: 200, data: { nickName: "fixture nickname", aboutMe: "" } });
  await state.setJwtToken("synthetic-stale-cache-token");
  await assert.rejects(plugin.getUserProfileDetails(), (error: Error) => {
    assert.deepEqual(Object.keys(JSON.parse(error.message)).sort(), ["message", "source", "type"]);
    assert.equal(JSON.parse(error.message).type, "unauthorized");
    return true;
  });
  assert.equal(requests.length, 0);

  settings.set("auth.jwt", loginData.jwttoken);
  for (const key of ["auth.userInfo", "auth.jwt"]) {
    malformedSetting = key;
    await assert.rejects(plugin.getUserProfileDetails(), /账号资料读取失败/);
  }
  malformedSetting = null;
  settings.set("auth.userInfo", { uid: {} });
  await assert.rejects(plugin.getUserProfileDetails(), /账号资料读取失败/);
  assert.equal(requests.length, 0);
});

test("unauthorized profile responses expose no login data, and login returns only its public result", async () => {
  settings.set("auth.userInfo", loginData);
  settings.set("auth.jwt", loginData.jwttoken);
  storedCredentials();
  respond = async () => ({ status: 401, data: { message: "expired fixture" } });
  await assert.rejects(plugin.getUserProfileDetails(), (error: Error) => {
    const payload = JSON.parse(error.message);
    assert.deepEqual(Object.keys(payload).sort(), ["message", "source", "type"]);
    assert.equal(payload.type, "unauthorized");
    return true;
  });

  respond = async () => ({ status: 200, data: loginData });
  const result = await plugin.loginWithPassword(loginPayload);
  assert.deepEqual(result, { source: "6886291b-f524-441c-844b-c2efae9899a9",
    data: { account: loginPayload.account } });
  assert.equal(settings.get("auth.jwt"), loginData.jwttoken);
  assert.equal(settings.get("auth.password"), loginPayload.password);
  assert.deepEqual(settings.get("auth.userInfo"), loginData);
});

test("explicit profile completion returns only public nickname/aboutMe and no cached balance claims", async () => {
  settings.set("auth.userInfo", loginData);
  settings.set("auth.jwt", loginData.jwttoken);
  storageGate = async (name, key) => {
    if (name === "cache.get" && key === "JmComic::ua") {
      cached.set("JmComic::jwt", "synthetic-concurrent-cache-token");
    }
  };
  respond = async () => ({ status: 200, data: { nickName: "fixture nickname", aboutMe: "fixture about",
    password: "private-fixture", password_confirm: "private-fixture", birthday: "private-fixture", coin: 99, photo: "private-fixture" } });
  const result = await plugin.getUserProfileDetails();
  assert.deepEqual(Object.keys(result.data).sort(), ["aboutMe", "accountId", "checkedAt", "nickname", "profileDataSource"]);
  assert.equal(result.data.nickname, "fixture nickname");
  assert.equal(result.data.profileDataSource, "serverUserEdit");
  assert.equal(requests[0]!.headers.Authorization, `Bearer ${loginData.jwttoken}`);
  assert.deepEqual(requests.map((request) => [request.method, new URL(request.url!).pathname]), [["get", `/useredit/${loginData.uid}`]]);
  assert.deepEqual(settings.get("auth.userInfo"), loginData);
});

test("read-only account probes never log in from stored credentials when user info is absent", async () => {
  storedCredentials();
  await assert.rejects(plugin.getCheckinStatus());
  await assert.rejects(plugin.getUserProfileDetails());
  await assert.rejects(plugin.getNotificationUnreadCount());
  assert.equal(requests.length, 0);
});

test("a late public profile read cannot cross an account change", async () => {
  settings.set("auth.userInfo", loginData);
  settings.set("auth.jwt", loginData.jwttoken);
  const response = deferred<{ status: number; data: unknown }>();
  respond = () => response.promise;
  const loading = plugin.getUserProfileDetails().catch((error) => error);
  await setImmediate();
  await plugin.clearPluginSession();
  response.resolve({ status: 200, data: { nickName: "old fixture", aboutMe: "old fixture" } });
  assert.ok(await loading instanceof state.SessionChangedError);
});

test("a late explicit calendar recheck cannot cross an account change", async () => {
  settings.set("auth.userInfo", loginData);
  const response = deferred<{ status: number; data: unknown }>();
  respond = () => response.promise;
  const loading = plugin.getCheckinStatus().catch((error) => error);
  await setImmediate();
  await plugin.clearPluginSession();
  response.resolve({ status: 200, data: dailyRecord(true) });
  assert.ok(await loading instanceof state.SessionChangedError);
});

test("a fresh calendar proof is returned without creating a receipt in the read-only probe", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 2, 4) });
  settings.set("auth.userInfo", loginData);
  respond = async () => ({ status: 200, data: dailyRecord(true, "02") });
  const result = await plugin.getCheckinStatus();
  assert.equal(result.data.checkedIn, true);
  assert.equal(result.data.checkinProof?.verifiedThisRequest, true);
  assert.equal(result.data.verification.signed, true);
  assert.equal(settings.has("auth.checkin"), false);
  await plugin.getCheckinStatus();
  assert.equal(requests.length, 2, "each explicit probe must reach the calendar");
});

test("an explicit calendar probe crossing midnight never verifies either day", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 1, 15, 59, 59) });
  settings.set("auth.userInfo", loginData);
  respond = async () => {
    context.mock.timers.tick(1000);
    return { status: 200, data: dailyRecord(true) };
  };
  const result = await plugin.getCheckinStatus();
  assert.equal(result.data.checkedIn, null);
  assert.equal(result.data.checkinProof, null);
  assert.equal(result.data.verification.status, "unknown");
  assert.equal(settings.has("auth.checkin"), false);
});

test("an old-day confirmed receipt expires during an explicit calendar read across midnight", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 1, 15, 59, 59) });
  settings.set("auth.userInfo", loginData);
  const receipt = { accountId: loginData.uid, checkedInDate: "2026-11-01" };
  settings.set("auth.checkin", receipt);
  respond = async () => {
    context.mock.timers.tick(1000);
    return { status: 200, data: dailyRecord(true) };
  };
  const result = await plugin.getCheckinStatus();
  assert.equal(result.data.checkedIn, null);
  assert.equal(result.data.checkedInDate, null);
  assert.equal(result.data.checkinProof, null);
  assert.equal(result.data.verification.status, "unknown");
  assert.deepEqual(settings.get("auth.checkin"), receipt);
});

test("official zero unread counts are known while failed public profile reads preserve cached account data", async () => {
  settings.set("auth.userInfo", loginData);
  settings.set("auth.jwt", loginData.jwttoken);
  respond = async () => ({ status: 200, data: { comic_follow: 0, site_notice: 0 } });
  const count = await plugin.getNotificationUnreadCount();
  assert.equal(count.data.total, 0);
  assert.equal(count.data.countsKnown, true);
  respond = async () => { throw new Error("fixture unavailable"); };
  await assert.rejects(plugin.getUserProfileDetails(), /fixture unavailable/);
  assert.deepEqual(settings.get("auth.userInfo"), loginData);
  assert.ok(requests.every((request) => request.method === "get"));
});

test("settings account summary reads stored official fields and receipt with no login or network", async () => {
  storedCredentials();
  const missing = await plugin.getSettingsUserInfoBundle();
  assert.equal(missing.data.available, false);
  assert.deepEqual(missing.data.lines, []);
  assert.equal(requests.length, 0);
  settings.set("auth.userInfo", { ...loginData, photo: "fixture.jpg", level: 4, coin: "20", exp: "100", nextLevelExp: "200" });
  const checkedInDate = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  settings.set("auth.checkin", { accountId: loginData.uid, checkedInDate });
  const result = await plugin.getSettingsUserInfoBundle();
  assert.equal(result.data.available, true);
  assert.ok("avatar" in result.data);
  assert.ok(result.data.lines.some((line) => line.includes("Lv.4")));
  assert.equal(result.data.extern?.profileDataSource, "storedSession");
  assert.equal(result.data.extern?.checkedIn, true);
  assert.equal((result.data.extern?.checkinProof as any).verifiedThisRequest, false);
  assert.ok(result.data.avatar?.url.includes("fixture.jpg"));
  assert.equal(requests.length, 0);
  assert.equal(JSON.stringify(result).includes("fixture-token"), false);
  assert.equal(JSON.stringify(result).includes("fixture-password"), false);
});

test("partial cached account data never invents level zero", async () => {
  settings.set("auth.userInfo", loginData);
  const result = await plugin.getSettingsUserInfoBundle();
  assert.ok("avatar" in result.data);
  assert.equal(result.data.extern?.level, null);
  assert.ok(result.data.lines.every((line) => !line.includes("Lv.0")));
  assert.equal(requests.length, 0);
});

test("explicit loaded-list read action posts each known unread ID serially and verifies exact IDs", async () => {
  settings.set("auth.userInfo", loginData);
  const notices = [{ id: "one", read: false }, { id: "two", read: false }, { id: "already", read: true }];
  respond = async (config) => {
    if (config.method === "post") {
      assert.equal(new URL(config.url!).pathname, "/notifications");
      const form = Object.fromEntries(new URLSearchParams(String(config.data)));
      assert.equal(form.read, "1");
      notices.find((item) => item.id === form.id)!.read = true;
      return { status: 200, data: {} };
    }
    return { status: 200, data: config.url!.endsWith("/unreadCount")
      ? { comic_follow: 0, site_notice: 0 } : notices.map((item) => ({ ...item })) };
  };
  const result = await plugin.markNotificationsRead({ accountId: loginData.uid, ids: ["one", "two", "one", "already"] });
  assert.equal(result.data.ok, true);
  assert.equal(result.data.scope, "requestedLoadedItems");
  assert.deepEqual(result.data.confirmedIds, ["one", "two", "already"]);
  assert.deepEqual(result.data.failedIds, []);
  assert.deepEqual(result.data.unknownIds, []);
  assert.deepEqual(requests.map((request) => [request.method, new URL(request.url!).pathname]), [
    ["get", "/notifications"], ["post", "/notifications"], ["get", "/notifications"],
    ["post", "/notifications"], ["get", "/notifications"], ["get", "/notifications/unreadCount"],
  ]);
  assert.deepEqual(requests.filter((request) => request.method === "post")
    .map((request) => Object.fromEntries(new URLSearchParams(String(request.data)))),
    [{ id: "one", read: "1" }, { id: "two", read: "1" }]);
});

test("POST success never marks a notification read when exact GET evidence is still unread", async () => {
  settings.set("auth.userInfo", loginData);
  respond = async (config) => ({ status: 200, data: config.method === "post" ? { success: true }
    : config.url!.endsWith("/unreadCount") ? { comic_follow: 0, site_notice: 1 } : [{ id: "one", read: false }] });
  const result = await plugin.markNotificationRead({ accountId: loginData.uid, id: "one" });
  assert.equal(result.data.ok, false);
  assert.deepEqual(result.data.confirmedIds, []);
  assert.deepEqual(result.data.failedIds, ["one"]);
  assert.equal(result.data.items[0]!.read, false);
});

test("lost write response is confirmed only by a later exact GET read state", async () => {
  settings.set("auth.userInfo", loginData);
  let marked = false;
  respond = async (config) => {
    if (config.method === "post") { marked = true; throw new Error("fixture lost response"); }
    return { status: 200, data: config.url!.endsWith("/unreadCount")
      ? { comic_follow: 0, site_notice: 0 } : [{ id: "one", read: marked }] };
  };
  const result = await plugin.markNotificationRead({ accountId: loginData.uid, id: "one" });
  assert.equal(result.data.ok, true);
  assert.deepEqual(result.data.confirmedIds, ["one"]);
  assert.equal(requests.filter((request) => request.method === "post").length, 1);
});

test("partial read results retain unknown and failed IDs for retry without marking unrelated rows", async () => {
  settings.set("auth.userInfo", loginData);
  let lastPosted = "";
  respond = async (config) => {
    if (config.method === "post") {
      lastPosted = new URLSearchParams(String(config.data)).get("id")!;
      return { status: 200, data: {} };
    }
    if (config.url!.endsWith("/unreadCount")) throw new Error("fixture count unavailable");
    if (lastPosted === "unknown") throw new Error("fixture verification unavailable");
    return { status: 200, data: [{ id: "failed", read: false }, { id: "unknown", read: false },
      { id: "no-status" }, { id: "other", read: false }] };
  };
  const result = await plugin.markNotificationsRead({ accountId: loginData.uid, ids: ["failed", "unknown", "missing", "no-status"] });
  assert.equal(result.data.ok, false);
  assert.deepEqual(result.data.failedIds, ["failed"]);
  assert.deepEqual(result.data.unknownIds, ["unknown", "missing", "no-status"]);
  assert.deepEqual(result.data.unreadSummary, { countsKnown: false, error: "unavailable" });
  assert.deepEqual(requests.filter((request) => request.method === "post")
    .map((request) => new URLSearchParams(String(request.data)).get("id")), ["failed", "unknown"]);
  assert.equal(result.data.items.find((item) => item.id === "other")!.read, false);
});

test("account mismatch, empty selection and all sentinel produce no request", async () => {
  settings.set("auth.userInfo", loginData);
  await assert.rejects(plugin.markNotificationRead({ accountId: "other", id: "one" }), /账号已变化/);
  await assert.rejects(plugin.markNotificationsRead({ accountId: loginData.uid, ids: [] }), /请选择/);
  await assert.rejects(plugin.markNotificationsRead({ accountId: loginData.uid, ids: ["all"] }), /请选择/);
  assert.equal(requests.length, 0);
});

test("account change after a write stops verification and all remaining writes", async () => {
  settings.set("auth.userInfo", loginData);
  const response = deferred<{ status: number; data: unknown }>();
  respond = async (config) => config.method === "post" ? response.promise
    : { status: 200, data: [{ id: "one", read: false }, { id: "two", read: false }] };
  const marking = plugin.markNotificationsRead({ accountId: loginData.uid, ids: ["one", "two"] }).catch((error) => error);
  await setImmediate();
  await plugin.clearPluginSession();
  response.resolve({ status: 200, data: {} });
  assert.ok(await marking instanceof state.SessionChangedError);
  assert.deepEqual(requests.map((request) => request.method), ["get", "post"]);
});

test("a second read action cannot queue duplicate writes while the first is in flight", async () => {
  settings.set("auth.userInfo", loginData);
  const response = deferred<{ status: number; data: unknown }>();
  let posted = false;
  respond = async (config) => {
    if (config.method === "post") { posted = true; return await response.promise; }
    return { status: 200, data: config.url!.endsWith("/unreadCount")
      ? { comic_follow: 0, site_notice: 0 } : [{ id: "one", read: posted }] };
  };
  const first = plugin.markNotificationRead({ accountId: loginData.uid, id: "one" });
  await setImmediate();
  await assert.rejects(plugin.markNotificationRead({ accountId: loginData.uid, id: "one" }), /正在更新/);
  response.resolve({ status: 200, data: {} });
  assert.equal((await first).data.ok, true);
  assert.equal(requests.filter((request) => request.method === "post").length, 1);
});

test("a failed initial read never posts and releases the action for a user retry", async () => {
  settings.set("auth.userInfo", loginData);
  respond = async () => { throw new Error("fixture unavailable"); };
  await assert.rejects(plugin.markNotificationRead({ accountId: loginData.uid, id: "one" }), /fixture unavailable/);
  assert.ok(requests.every((request) => request.method === "get"));
  respond = async (config) => ({ status: 200, data: config.url!.endsWith("/unreadCount")
    ? { comic_follow: 0, site_notice: 0 } : [{ id: "one", read: true }] });
  assert.equal((await plugin.markNotificationRead({ accountId: loginData.uid, id: "one" })).data.ok, true);
  assert.ok(requests.every((request) => request.method === "get"));
});
