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
      return new Response(JSON.stringify(profile), {
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
