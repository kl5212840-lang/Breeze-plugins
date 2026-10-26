import test from "node:test";
import assert from "node:assert/strict";
import { loadCopyThemeOptions, COPY_THEME_CACHE_TTL_MS } from "../src/catalog_theme_cache.ts";
const options = [{ label: "C108", value: "comiket108" }];
const fallback = [{ label: "Fantasy", value: "qihuan" }];
test("fresh cache avoids taxonomy network requests", async () => {
  let calls = 0;
  const result = await loadCopyThemeOptions({
    read: async () => ({ fetchedAt: 100, options }),
    write: async () => {},
    fetch: async () => {
      calls++;
      return [];
    },
    fallback,
    now: () => 200,
  });
  assert.deepEqual(result, options);
  assert.equal(calls, 0);
});
test("stale cache remains usable when taxonomy is unavailable", async () => {
  const result = await loadCopyThemeOptions({
    read: async () => ({ fetchedAt: 0, options }),
    write: async () => {},
    fetch: async () => {
      throw Error("offline");
    },
    fallback,
    now: () => COPY_THEME_CACHE_TTL_MS + 1,
  });
  assert.deepEqual(result, options);
});
test("first offline use keeps bundled taxonomy and invalid server data cannot overwrite it", async () => {
  let writes = 0;
  const result = await loadCopyThemeOptions({
    read: async () => null,
    write: async () => {
      writes++;
    },
    fetch: async () => [{ name: "Bad", path_word: "../bad" }],
    fallback,
  });
  assert.deepEqual(result, fallback);
  assert.equal(writes, 0);
});
test("fresh server slugs are used even if persistence fails", async () => {
  const result = await loadCopyThemeOptions({
    read: async () => {
      throw Error("storage");
    },
    write: async () => {
      throw Error("storage");
    },
    fetch: async () => [{ name: "C108", path_word: "comiket108" }],
    fallback,
  });
  assert.deepEqual(result, options);
});
