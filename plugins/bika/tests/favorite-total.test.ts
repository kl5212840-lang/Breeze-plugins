import assert from "node:assert/strict";
import * as nodeCrypto from "node:crypto";
import { after, test } from "node:test";
import client from "../src/client";
import { getFavoriteData } from "../src/bika-comic-library";

// Synthetic HTTP/config only; never access a user's account or real network.
const cache = new Map<string, unknown>();
let total: unknown;
Object.assign(globalThis, {
  nodeCryptoCompat: nodeCrypto,
  uuidv4: nodeCrypto.randomUUID,
  bridge: {
    async call(name: string, ...args: unknown[]) {
      const key = String(args[0]);
      switch (name) {
        case "load_plugin_config":
          return { ok: true, value: JSON.parse(String(args[1])) };
        case "cache.get": return cache.has(key) ? cache.get(key) : args[1];
        case "cache.set": cache.set(key, args[1]); return;
        case "cache.delete": cache.delete(key); return;
        default: throw new Error(`Unexpected offline bridge call ${name}`);
      }
    },
  },
});
const originalAdapter = client.defaults.adapter;
client.defaults.adapter = async (request) => ({
  data: { code: 200, data: { comics: {
    docs: [{ _id: "fixture-comic", title: "Fixture", thumb: {} }],
    page: 1, pages: 5, ...(total === undefined ? {} : { total }),
  } } },
  status: 200, statusText: "Fixture", headers: {}, config: request,
});
after(() => { client.defaults.adapter = originalAdapter; });

test("favorite totals use the server count, never the loaded page length", async () => {
  for (total of [100, "100"]) {
    cache.clear();
    const result = await getFavoriteData();
    assert.equal(result.items.length, 1);
    assert.equal(result.paging?.total, 100);
    assert.equal(result.data.paging?.total, 100);
  }
});

test("missing or malformed favorite totals cannot become a fake collection count", async () => {
  for (total of [undefined, null, "", "invalid", -1, 0, 1.5, {}, true]) {
    cache.clear();
    await assert.rejects(getFavoriteData(), /收藏资料读取不完整/);
  }
});
