import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import * as nodeCrypto from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import vm from "node:vm";

const bundle = readFileSync(
  new URL("../dist/breeze-plugin-jm-comic.bundle.cjs", import.meta.url),
  "utf8",
);
const credentials = { account: "fixture-account", password: "fixture-password" };
const profile = { uid: "fixture-user", username: credentials.account, jwttoken: "fixture-token" };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(
  gate: (name: string, key: string, value: unknown) => Promise<void> = async () => {},
  respond: (request: Request) => unknown = () => profile,
) {
  const settings = new Map<string, unknown>(),
    cache = new Map<string, unknown>();
  const requests: string[] = [];
  const context = vm.createContext({
    module: { exports: {} },
    exports: {},
    URL,
    URLSearchParams,
    Request,
    Response,
    Headers,
    FormData,
    Blob,
    AbortController,
    TextEncoder,
    TextDecoder,
    structuredClone,
    setTimeout,
    clearTimeout,
    ArrayBuffer,
    Uint8Array,
    DataView,
    nodeCryptoCompat: nodeCrypto,
    uuidv4: randomUUID,
    console: { info() {}, warn() {}, log() {}, error() {} },
    async fetch(input: Request | string, init?: RequestInit) {
      const request = input instanceof Request ? input : new Request(input, init);
      requests.push(new URL(request.url).pathname);
      return new Response(JSON.stringify(await respond(request)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    bridge: {
      async call(name: string, key: string, value: unknown) {
        await gate(name, key, value);
        if (name === "cache.get") return cache.get(key) ?? value ?? null;
        if (name === "cache.set") {
          cache.set(key, value);
          return true;
        }
        if (name === "cache.delete") {
          cache.delete(key);
          return true;
        }
        if (name === "load_plugin_config")
          return JSON.stringify({
            ok: true,
            value: settings.get(key) ?? JSON.parse(String(value)),
          });
        if (name === "save_plugin_config") {
          settings.set(key, JSON.parse(String(value)));
          return true;
        }
        if (name.includes("md5")) return createHash("md5").update(String(key)).digest("hex");
        if (name === "opencc.convert") return (key as unknown as { text: string }).text;
        throw new Error(`Unexpected compiled fixture bridge call ${name}`);
      },
    },
  });
  vm.runInContext(bundle, context, { filename: "jm-compiled-session-fixture.cjs" });
  return { plugin: context.module.exports.default, settings, cache, requests };
}

test("the actual compiled JM login and clearing use only the synthetic network and storage", async () => {
  const f = fixture();
  const info = await f.plugin.getInfo();
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(info.uuid, "6886291b-f524-441c-844b-c2efae9899a9");
  assert.equal(info.version, manifest.version);
  assert.equal(info.version, pkg.version);
  const result = await f.plugin.loginWithPassword(credentials);
  assert.equal(f.requests.length, 1);
  assert.ok(f.requests[0]!.endsWith("/login"));
  assert.equal(f.settings.get("auth.jwt"), profile.jwttoken, JSON.stringify(result));
  await f.plugin.clearPluginSession();
  assert.equal(f.settings.get("auth.jwt"), "");
});

test("compiled JM folder refresh requests a fresh directory while an old read is still pending", async () => {
  const started = deferred();
  const finishOldRead = deferred();
  const f = fixture(async () => {}, async (request) => {
    assert.equal(request.method, "GET");
    assert.equal(new URL(request.url).origin, "https://www.cdnhjk.net");
    assert.equal(request.headers.get("authorization"), "Bearer fixture-token");
    assert.equal(request.headers.get("cookie"), "AVS=fixture-avs");
    const revalidate = request.headers.get("cache-control") === "no-cache";
    if (f.requests.length === 1) {
      started.resolve();
      await finishOldRead.promise;
    }
    return { code: 200, data: { total: 0, list: [], folder_list: [
      { FID: "321", name: revalidate ? "设备二重命名" : "原名称" },
    ] } };
  });
  f.settings.set("auth.userInfo", { ...profile, s: "fixture-avs" });
  f.settings.set("auth.jwt", profile.jwttoken);
  const old = f.plugin.getCloudFavoriteFilterBundle();
  await started.promise;
  const fresh = f.plugin.getCloudFavoriteFilterBundle({ refresh: true });
  try {
    await setImmediate();
    assert.deepEqual(f.requests, ["/favorite", "/favorite"]);
    await fresh;
  } finally {
    finishOldRead.resolve();
  }
  const [before, after] = await Promise.all([old, fresh]);
  assert.equal(before.scheme.fields[0].options[1].label, "原名称");
  assert.equal(after.scheme.fields[0].options[1].label, "设备二重命名");

  const { preflightId } = await f.plugin.prepareJmFavoriteFolderChange({ folderId: "321" });
  const result = await f.plugin.renameFavoriteFolder({
    folderId: "321", folderName: "设备二重命名", preflightId,
  });
  assert.equal(result.folder.name, "设备二重命名");
  assert.deepEqual(f.requests, ["/favorite", "/favorite"]);
});

test("compiled JM sends a folder create as the official multipart form with the matching session", async () => {
  let created = false;
  const f = fixture(async () => {}, async (request) => {
    assert.equal(request.headers.get("authorization"), "Bearer fixture-token");
    assert.equal(request.headers.get("cookie"), "AVS=fixture-avs");
    assert.equal(request.redirect, "error");
    if (request.method === "POST") {
      assert.equal(new URL(request.url).pathname, "/favorite_folder");
      assert.match(request.headers.get("content-type") ?? "", /^multipart\/form-data; boundary=/);
      assert.deepEqual(Object.fromEntries(await request.formData()), {
        type: "add",
        folder_id: "",
        folder_name: "收藏夹样例",
        aid: "",
      });
      created = true;
      return { code: 200, data: { status: "ok" } };
    }
    return { code: 200, data: {
      total: 0, list: [],
      folder_list: created ? [{ FID: "321", name: "收藏夹样例" }] : null,
    } };
  });
  f.settings.set("auth.userInfo", { ...profile, s: "fixture-avs" });
  f.settings.set("auth.jwt", profile.jwttoken);
  const result = await f.plugin.createFavoriteFolder({ folderName: "收藏夹样例" });
  assert.equal(result.ok, true);
  assert.equal(result.folder.id, "321");
  assert.deepEqual(f.requests, ["/favorite", "/favorite_folder", "/favorite"]);
});

test("compiled JM accepts a late new folder only after two independent reads of the same account", async () => {
  let posts = 0;
  let readsAfterWrite = 0;
  const f = fixture(async () => {}, (request) => {
    assert.equal(request.headers.get("authorization"), "Bearer fixture-token");
    if (request.method === "POST") {
      posts++;
      return { code: 200, data: {} };
    }
    if (posts) {
      readsAfterWrite++;
      assert.equal(request.headers.get("cache-control"), "no-cache");
    }
    return { code: 200, data: { total: 0, list: [], folder_list:
      readsAfterWrite < 2 ? [] : [{ FID: "321", name: "编译版新增" }],
    } };
  });
  f.settings.set("auth.jwt", profile.jwttoken);
  const result = await f.plugin.createFavoriteFolder({ folderName: "编译版新增" });
  assert.equal(result.folder.id, "321");
  assert.equal(posts, 1);
  assert.deepEqual(f.requests, ["/favorite", "/favorite_folder", "/favorite", "/favorite"]);
});

test("compiled JM reports a rejected folder create at the folder limit without re-posting", async () => {
  const f = fixture(async () => {}, (request) => {
    if (request.method === "POST") {
      return { code: 200, data: { code: 400, msg: "資料夾數量已達上限" } };
    }
    return { code: 200, data: { total: 0, list: [], folder_list: null } };
  });
  f.settings.set("auth.jwt", profile.jwttoken);
  await assert.rejects(
    f.plugin.createFavoriteFolder({ folderName: "收藏夹样例" }),
    /收藏夹已达上限/,
  );
  assert.deepEqual(f.requests, ["/favorite", "/favorite_folder"]);
});

test("compiled JM reuses an editing-time check and returns only typed folder-limit data", async () => {
  const f = fixture(async () => {}, (request) => request.method === "POST"
    ? { code: 200, data: { code: 400, msg: "資料夾數量已達上限" } }
    : { code: 200, data: { total: 0, list: [], folder_list: [
      { FID: 0 }, { FID: "32", name: "私有收藏夹名称" },
    ] } });
  f.settings.set("auth.jwt", profile.jwttoken);
  const { preflightId } = await f.plugin.prepareJmFavoriteFolderChange();
  assert.deepEqual(f.requests, ["/favorite"]);
  f.requests.length = 0;
  await assert.rejects(f.plugin.createFavoriteFolder({
    preflightId, folderName: "另外一个", reportFolderFailure: true,
  }), (error: unknown) => {
    const message = (error as Error).message;
    assert.deepEqual(JSON.parse(message), {
      type: "jm_folder_change", phase: "rejected", reason: "limit", folderCount: 1,
    });
    return true;
  });
  assert.deepEqual(f.requests, ["/favorite_folder"]);
});

test("compiled JM profile verification uses the configured origin without password, redirects or session writes", async () => {
  const expectedPath = `/useredit/${profile.uid}`;
  const f = fixture(async (name, key) => {
    assert.notEqual(key, "auth.password");
    assert.notEqual(key, "auth.account");
    assert.notEqual(name, "save_plugin_config");
  }, (request) => {
    const url = new URL(request.url);
    assert.equal(url.origin, "https://www.cdnhjk.net");
    assert.equal(url.pathname, expectedPath);
    assert.equal(request.method, "GET");
    assert.equal(request.headers.get("authorization"), "Bearer fixture-token");
    assert.equal(request.headers.get("cookie"), null);
    assert.equal(request.credentials, "omit");
    assert.equal(request.redirect, "error");
    return { nickName: "Fixture", aboutMe: "", jwttoken: "unexpected-fixture-token" };
  });
  f.settings.set("auth.userInfo", profile);
  f.settings.set("auth.jwt", profile.jwttoken);
  const verification = await f.plugin.getUserProfileDetails();
  assert.equal(verification.data.accountId, profile.uid);
  assert.deepEqual(f.requests, [expectedPath]);
  assert.equal(f.settings.get("auth.jwt"), profile.jwttoken);
  assert.equal(f.cache.has("JmComic::jwt"), false);
});

test("compiled JM cannot release clearing after one write rejects while its persisted JWT write still runs", async () => {
  const writing = deferred(),
    release = deferred();
  const f = fixture(async (name, key, value) => {
    if (name !== "save_plugin_config") return;
    if (key === "auth.account" && value === JSON.stringify(credentials.account))
      throw new Error("fixture account persistence failed");
    if (key === "auth.jwt" && value === JSON.stringify(profile.jwttoken)) {
      writing.resolve();
      await release.promise;
    }
  });
  const login = f.plugin.loginWithPassword(credentials).catch((error: unknown) => error);
  await writing.promise;
  const clearing = f.plugin.clearPluginSession();
  await setImmediate();
  release.resolve();
  await Promise.all([login, clearing]);
  assert.equal(f.settings.get("auth.jwt"), "");
  assert.equal(f.cache.has("JmComic::jwt"), false);
});
