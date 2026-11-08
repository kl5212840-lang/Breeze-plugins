import assert from "node:assert/strict";
import * as nodeCrypto from "node:crypto";
import { after, beforeEach, test } from "node:test";
import type { AxiosAdapter } from "axios";
import client, { BACKUP_API_BASE, DEFAULT_API_BASE } from "../src/client";
import { bikaRequest } from "../src/bika-request";
import { getCapabilitiesBundle, getSettingsBundle, saveSettings } from "../src/bika-settings";
import { buildBikaImageUrl } from "../src/bika-image";
import { normalizeAppChannel } from "../src/bika-network";

const config = new Map<string, unknown>();
const cache = new Map<string, unknown>();
const writes: string[] = [];
const requests: { url: string; channel: string }[] = [];
Object.assign(globalThis, {
  nodeCryptoCompat: nodeCrypto,
  uuidv4: nodeCrypto.randomUUID,
  bridge: {
    async call(name: string, ...args: unknown[]) {
      const key = String(args[0]);
      switch (name) {
        case "load_plugin_config":
          return {
            ok: true,
            value: config.has(key) ? config.get(key) : JSON.parse(String(args[1])),
          };
        case "save_plugin_config":
          writes.push(key);
          config.set(key, JSON.parse(String(args[1])));
          return { ok: true };
        case "cache.get":
          return cache.has(key) ? cache.get(key) : args[1];
        case "cache.set":
          cache.set(key, args[1]);
          return;
        case "cache.delete":
          cache.delete(key);
          return;
        case "dart.getAppVersion":
          return "3.0.37";
        default:
          throw new Error(`Unexpected offline bridge call ${name}`);
      }
    },
  },
});
const originalAdapter = client.defaults.adapter;
const adapter: AxiosAdapter = async (request) => {
  requests.push({ url: String(request.url), channel: String(request.headers.get("app-channel")) });
  return {
    data: { code: 200, request: requests.length },
    status: 200,
    statusText: "OK",
    headers: {},
    config: request,
  };
};
beforeEach(() => {
  config.clear();
  cache.clear();
  writes.length = 0;
  requests.length = 0;
  client.defaults.adapter = adapter;
});
after(() => {
  client.defaults.adapter = originalAdapter;
});

test("network settings expose neutral origins and three channels with default 3", async () => {
  const bundle = await getSettingsBundle({ retainApiChoice: true });
  const fields = bundle.scheme.sections.flatMap((section) => section.fields);
  const channel = fields.find((field) => field.key === "network.proxy");
  const api = fields.find((field) => field.key === "network.apiBase");
  assert.ok(channel?.kind === "select" && api?.kind === "select");
  assert.deepEqual(
    channel.options?.map((option) => option.value),
    ["1", "2", "3"],
  );
  assert.deepEqual(
    api.options?.map((option) => option.label),
    ["picacomic", "go2778"],
  );
  assert.equal(bundle.data.values["network.proxy"], "3");
  assert.equal(requests.length, 0);
});

test("stored channel reaches actual headers and existing image routing; invalid stored values fall back", async () => {
  for (const channel of ["1", "2", "3", 1, 2, 3, "0", "4", "1x", {}, null]) {
    config.set("network.proxy", channel);
    await bikaRequest({ url: `${DEFAULT_API_BASE}categories` });
    const expected = normalizeAppChannel(channel);
    assert.equal(requests[requests.length - 1]?.channel, expected);
    assert.equal(
      await buildBikaImageUrl("https://storage1.picacomic.com", "folder/image.jpg", "comic"),
      `${expected === "1" ? "https://storage.diwodiwo.xyz" : "https://s3.picacomic.com"}/folder/image.jpg`,
    );
    assert.equal(
      await buildBikaImageUrl("https://storage1.picacomic.com", "folder/image.jpg", "cover"),
      "https://img.picacomic.com/folder/image.jpg",
    );
  }
});

test("partial channel save preserves origin, credentials, preferences and cached entries", async () => {
  const baseline = {
    "network.apiBase": BACKUP_API_BASE,
    "auth.account": "fixture-account",
    "auth.password": "fixture-password",
    "auth.authorization": "fixture-token",
    "image.quality": "original",
    "home.blockedCategories": ["fixture"],
    "download.slow": true,
  };
  for (const [key, value] of Object.entries(baseline)) config.set(key, value);
  cache.set("bika:network.apiBase", BACKUP_API_BASE);
  cache.set("keep", { fixture: true });
  await saveSettings({ key: "network.proxy", value: "1" });
  assert.deepEqual(writes, ["network.proxy"]);
  for (const [key, value] of Object.entries(baseline)) assert.deepEqual(config.get(key), value);
  assert.equal(cache.get("bika:network.apiBase"), BACKUP_API_BASE);
  assert.deepEqual(cache.get("keep"), { fixture: true });
  assert.equal(config.get("network.proxy"), "1");
  await saveSettings({ values: { "network.apiBase": DEFAULT_API_BASE } });
  assert.equal(config.get("network.proxy"), "1");
  assert.equal(config.get("network.apiBase"), DEFAULT_API_BASE);
  const before = [...config.entries()];
  const beforeWrites = writes.length;
  for (const value of ["0", "4", "", null, {}, "3.0"]) {
    await assert.rejects(
      saveSettings({ values: { "network.proxy": value, "network.apiBase": BACKUP_API_BASE } }),
      /分流通道/,
    );
  }
  await assert.rejects(
    saveSettings({ values: { "network.apiBase": "https://unverified.example/" } }),
    /API/,
  );
  await saveSettings({ key: "unknown", value: "2" });
  assert.deepEqual([...config.entries()], before);
  assert.equal(writes.length, beforeWrites);
  assert.equal(requests.length, 0);
});

test("request cache is isolated by actual origin and channel without deleting old entries", async () => {
  const load = (origin: string) => bikaRequest({ url: `${origin}categories`, cache: true });
  config.set("network.proxy", "3");
  const original = await load(DEFAULT_API_BASE);
  assert.deepEqual(await load(DEFAULT_API_BASE), original);
  assert.equal(requests.length, 1);
  config.set("network.proxy", "1");
  const channelOne = await load(DEFAULT_API_BASE);
  assert.notDeepEqual(channelOne, original);
  assert.equal(requests.length, 2);
  const otherOrigin = await load(BACKUP_API_BASE);
  assert.notDeepEqual(otherOrigin, channelOne);
  assert.equal(requests.length, 3);
  assert.deepEqual(await load(DEFAULT_API_BASE), channelOne);
  config.set("network.proxy", "3");
  assert.deepEqual(await load(DEFAULT_API_BASE), original);
  assert.equal(requests.length, 3);
});

// Capability discovery must be a pure read, not a maintenance reset shortcut.
test("ordinary settings expose no account-clearing maintenance command", async () => {
  config.set("auth.account", "synthetic-account");
  config.set("auth.password", "synthetic-password");
  config.set("auth.authorization", "synthetic-token");
  const capabilities = await getCapabilitiesBundle();
  assert.equal(capabilities.scheme.actions.some((action) => action.fnPath === "clearPluginSession"), false);
  assert.deepEqual(writes, []);
  assert.deepEqual(requests, []);
  assert.equal(config.get("auth.account"), "synthetic-account");
  assert.equal(config.get("auth.password"), "synthetic-password");
});
