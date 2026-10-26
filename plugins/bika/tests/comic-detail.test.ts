import assert from "node:assert/strict";
import * as nodeCrypto from "node:crypto";
import { after, beforeEach, test } from "node:test";
import type { AxiosAdapter } from "axios";
import client from "../src/client";
import { getComicDetail, getReadSnapshot } from "../src/bika-comic-detail";

// Exercise the real request/cache/parser boundary without any network or account.
const memory = new Map<string, unknown>();
Object.assign(globalThis, {
  nodeCryptoCompat: nodeCrypto,
  uuidv4: nodeCrypto.randomUUID,
  bridge: {
    async call(name: string, ...args: unknown[]) {
      const key = String(args[0]);
      switch (name) {
        case "cache.get":
          return memory.has(key) ? memory.get(key) : args[1];
        case "cache.set":
          memory.set(key, args[1]);
          return;
        case "cache.delete":
          memory.delete(key);
          return;
        case "load_plugin_config":
          return { ok: true, value: JSON.parse(String(args[1])) };
        default:
          throw new Error(`Unexpected offline bridge call: ${name}`);
      }
    },
  },
});

const originalAdapter = client.defaults.adapter;
let chapterCount: number;
let detailChapterCount: number | undefined;
let reportedPages: unknown;
let failPath: string;
let recommendations: Record<string, unknown>[];
let requested: string[];

const adapter: AxiosAdapter = async (config) => {
  const url = new URL(String(config.url));
  const target = `${url.pathname}${url.search}`;
  requested.push(target);
  if (failPath && url.pathname.endsWith(failPath)) {
    throw new Error("Offline fixture request failed");
  }

  let data: unknown;
  if (url.pathname === "/comics/offline-comic") {
    data = {
      comic: {
        _id: "offline-comic",
        title: "Offline comic",
        epsCount: detailChapterCount ?? chapterCount,
        thumb: { fileServer: "https://images.invalid", path: "cover.jpg" },
      },
    };
  } else if (url.pathname === "/comics/offline-comic/eps") {
    const page = Number(url.searchParams.get("page"));
    const start = (page - 1) * 40;
    const count = Math.max(0, Math.min(40, chapterCount - start));
    data = {
      eps: {
        page,
        ...(reportedPages === undefined ? {} : { pages: reportedPages }),
        docs: Array.from({ length: count }, (_, index) => {
          const order = start + index + 1;
          return { _id: `ep-${order}`, title: `Chapter ${order}`, order };
        }).reverse(),
      },
    };
  } else if (url.pathname === "/comics/offline-comic/recommendation") {
    data = { comics: recommendations };
  } else if (url.pathname === "/comics/offline-comic/order/1/pages") {
    data = {
      ep: { _id: "ep-1", title: "Chapter 1" },
      pages: {
        pages: 1,
        docs: [
          {
            id: "page-1",
            media: { fileServer: "https://images.invalid", path: "page-1.jpg" },
          },
        ],
      },
    };
  } else {
    assert.fail(`Unexpected offline request: ${target}`);
  }
  return { data: { data }, status: 200, statusText: "OK", headers: {}, config };
};

beforeEach(() => {
  memory.clear();
  chapterCount = 1;
  detailChapterCount = undefined;
  reportedPages = 1;
  failPath = "";
  recommendations = [];
  requested = [];
  client.defaults.adapter = adapter;
});

after(() => {
  client.defaults.adapter = originalAdapter;
});

for (const count of [0, 1, 39, 40, 41, 80, 81]) {
  test(`chapter pagination requests only required pages for ${count} chapters`, async () => {
    chapterCount = count;
    reportedPages = Math.ceil(count / 40);
    const detail = await getComicDetail({ comicId: "offline-comic" });
    assert.deepEqual(
      requested.filter((url) => url.includes("/eps?")),
      Array.from(
        { length: Math.max(1, Math.ceil(count / 40)) },
        (_, index) => `/comics/offline-comic/eps?page=${index + 1}`,
      ),
    );
    const normal = detail.data.normal;
    assert.equal(normal.eps.length, count);
    assert.deepEqual(
      normal.eps.map((chapter) => chapter.order),
      Array.from({ length: count }, (_, index) => index + 1),
    );
  });
}

test("reported page count takes precedence over a stale chapter count", async () => {
  chapterCount = 80;
  reportedPages = "1";
  await getComicDetail({ comicId: "offline-comic" });
  assert.deepEqual(
    requested.filter((url) => url.includes("/eps?")),
    ["/comics/offline-comic/eps?page=1"],
  );
});

test("chapter metadata discovers later pages when detail count is missing", async () => {
  chapterCount = 41;
  detailChapterCount = 0;
  reportedPages = 2;
  const detail = await getComicDetail({ comicId: "offline-comic" });
  assert.equal(detail.data.normal.eps.length, 41);
  assert.deepEqual(
    requested.filter((url) => url.includes("/eps?")),
    ["/comics/offline-comic/eps?page=1", "/comics/offline-comic/eps?page=2"],
  );
});

for (const pages of [undefined, null, "", false, "invalid", -1, 1.5]) {
  test(`missing/invalid page count falls back to 40-chapter pages: ${String(pages)}`, async () => {
    chapterCount = 41;
    reportedPages = pages;
    const detail = await getComicDetail({ comicId: "offline-comic" });
    assert.equal(detail.data.normal.eps.length, 41);
    assert.deepEqual(
      requested.filter((url) => url.includes("/eps?")),
      ["/comics/offline-comic/eps?page=1", "/comics/offline-comic/eps?page=2"],
    );
  });
}

test("recommendation failure preserves details and chapter references", async () => {
  failPath = "/recommendation";
  const detail = await getComicDetail({ comicId: "offline-comic" });
  assert.equal(detail.data.normal.comicInfo.title, "Offline comic");
  assert.equal(detail.data.normal.eps[0]?.id, "ep-1");
  assert.deepEqual(detail.data.normal.recommend, []);
});

test("recommendation failure cannot block a reading snapshot", async () => {
  failPath = "/recommendation";
  const snapshot = await getReadSnapshot({ comicId: "offline-comic", chapterId: "ep-1" });
  assert.equal(snapshot.data.comic.title, "Offline comic");
  assert.equal(snapshot.data.chapter.order, 1);
  assert.equal(snapshot.data.chapter.pages.length, 1);
  assert.equal(snapshot.data.chapter.pages[0]?.id, "page-1");
  assert.equal(snapshot.data.chapters[0]?.id, "ep-1");
});

test("available recommendations retain their titles and identities", async () => {
  recommendations = [{ _id: "related-comic", title: "Related comic" }];
  const detail = await getComicDetail({ comicId: "offline-comic" });
  assert.equal(detail.data.normal.recommend[0]?.id, "related-comic");
  assert.equal(detail.data.normal.recommend[0]?.title, "Related comic");
});

test("required detail failures still reject", async () => {
  failPath = "/offline-comic";
  await assert.rejects(getComicDetail({ comicId: "offline-comic" }));
});

test("required first chapter page failures still reject", async () => {
  failPath = "/eps";
  await assert.rejects(getComicDetail({ comicId: "offline-comic" }));
  assert.equal(
    requested.some((url) => url.includes("/recommendation")),
    false,
  );
});

test("required later chapter page failures never return a truncated detail", async () => {
  chapterCount = 41;
  reportedPages = 2;
  const baseAdapter = client.defaults.adapter;
  client.defaults.adapter = async (config) => {
    if (String(config.url).endsWith("/eps?page=2")) {
      throw new Error("Offline second page failure");
    }
    return adapter(config);
  };
  await assert.rejects(getComicDetail({ comicId: "offline-comic" }));
  client.defaults.adapter = baseAdapter;
});

test("required reading page failures still reject after optional recommendations fail", async () => {
  const baseAdapter = client.defaults.adapter;
  client.defaults.adapter = async (config) => {
    const requestPath = new URL(String(config.url)).pathname;
    if (requestPath.endsWith("/recommendation") || requestPath.endsWith("/pages")) {
      throw new Error("Offline optional and essential request failures");
    }
    return adapter(config);
  };
  await assert.rejects(getReadSnapshot({ comicId: "offline-comic", chapterId: "ep-1" }));
  client.defaults.adapter = baseAdapter;
});
