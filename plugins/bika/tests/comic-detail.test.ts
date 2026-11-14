import assert from "node:assert/strict";
import * as nodeCrypto from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { AxiosError, type AxiosAdapter } from "axios";
import client from "../src/client";
import { getComicDetail, getReadSnapshot } from "../src/bika-comic-detail";
import plugin from "../src/index";
import { toggleFavorite, toggleLike } from "../src/bika-comic-library";
import { beginBikaAuthChange } from "../src/bika-auth-session";

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
          return {
            ok: true,
            value: memory.has(`config:${key}`) ? memory.get(`config:${key}`) : JSON.parse(String(args[1])),
          };
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
let authorizations: string[];
let detailFields: Record<string, unknown>;
let likeResponse: Record<string, unknown>;
let favoriteResponse: Record<string, unknown>;
let likeCalls: Array<{
  method: string;
  origin: string;
  authorization: string;
  channel: string;
  cacheControl: string;
  redirect: RequestRedirect | undefined;
}>;

const adapter: AxiosAdapter = async (config) => {
  const url = new URL(String(config.url));
  const target = `${url.pathname}${url.search}`;
  requested.push(target);
  if (target === "/comics/offline-comic" || target === "/comics/offline-comic/like") {
    likeCalls.push({
      method: String(config.method).toUpperCase(),
      origin: url.origin,
      authorization: String(config.headers.get("authorization") ?? ""),
      channel: String(config.headers.get("app-channel") ?? ""),
      cacheControl: String(config.headers.get("Cache-Control") ?? ""),
      redirect: config.fetchOptions?.redirect,
    });
  }
  authorizations.push(String(config.headers.get("authorization") ?? ""));
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
        ...detailFields,
      },
    };
  } else if (url.pathname === "/comics/offline-comic/like") {
    return { data: likeResponse, status: 200, statusText: "OK", headers: {}, config };
  } else if (url.pathname === "/comics/offline-comic/favourite") {
    return { data: favoriteResponse, status: 200, statusText: "OK", headers: {}, config };
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
  authorizations = [];
  detailFields = {};
  likeResponse = { code: 200, data: { action: "like" } };
  favoriteResponse = { code: 200, data: { action: "favourite" } };
  likeCalls = [];
  client.defaults.adapter = adapter;
});

after(() => {
  client.defaults.adapter = originalAdapter;
});

test("favorite uses the resulting site action even when the previous state was stale", async () => {
  memory.set("config:auth.authorization", "fixture-authorization");
  assert.deepEqual(await toggleFavorite({ comicId: "offline-comic", currentFavorite: true }), {
    favorited: true, nextStep: "none",
  });
  favoriteResponse = { code: 200, data: { action: "un_favourite" } };
  assert.deepEqual(await toggleFavorite({ comicId: "offline-comic", currentFavorite: false }), {
    favorited: false, nextStep: "none",
  });
  assert.deepEqual(requested, Array(2).fill("/comics/offline-comic/favourite"));
});

test("an unknown favorite receipt uses one same-work readback, with no second write", async () => {
  memory.set("config:auth.authorization", "fixture-authorization");
  favoriteResponse = { code: 200, data: {} };
  detailFields = { isFavourite: false };
  assert.deepEqual(await toggleFavorite({ comicId: "offline-comic", currentFavorite: true }), {
    favorited: false, nextStep: "none",
  });
  assert.deepEqual(requested, ["/comics/offline-comic/favourite", "/comics/offline-comic"]);
  assert.deepEqual(authorizations, Array(2).fill("fixture-authorization"));

  for (const fields of [{}, { isFavourite: true }, { _id: "different-comic", isFavourite: false }]) {
    detailFields = fields;
    await assert.rejects(toggleFavorite({ comicId: "offline-comic", currentFavorite: true }), /未确认收藏状态/);
  }
});

test("favorite rejects an explicit refusal without claiming success from a later read", async () => {
  memory.set("config:auth.authorization", "fixture-authorization");
  favoriteResponse = { code: 403, data: { action: "favourite" } };
  await assert.rejects(toggleFavorite({ comicId: "offline-comic", currentFavorite: false }), /未确认收藏状态/);
  assert.deepEqual(requested, ["/comics/offline-comic/favourite"]);
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

test("detail author, tag and team open the matching source search field", async () => {
  detailFields = { author: "作者甲", tags: ["标签甲"], chineseTeam: "汉化组甲", categories: ["分类甲"] };
  const detail = await getComicDetail({ comicId: "offline-comic" });
  const metadata = detail.data.normal.comicInfo.metadata;
  const info = await plugin.getInfo();
  for (const [type, field, value] of [
    ["author", "author", "作者甲"],
    ["tags", "tag", "标签甲"],
    ["chineseTeam", "team", "汉化组甲"],
  ] as const) {
    const action = metadata.find((item) => item.type === type)?.value[0]?.onTap;
    assert.ok(action?.type === "openSearch");
    assert.deepEqual(action.payload, {
      source: info.uuid,
      keyword: value,
      extern: { keyword: value, bikaSearchField: field },
    });
  }
  assert.equal(info.breezeExperience.publicSearchFields, 1);
  const category = metadata.find((item) => item.type === "categories")?.value[0]?.onTap;
  assert.ok(category?.type === "openSearch");
  assert.deepEqual(category.payload, { source: info.uuid, extern: { categories: ["分类甲"] } });
});

const followPayload = { comicId: "offline-comic", extern: { comicFollow: true } };

test("follow reads fresh public chapter metadata without reading or changing the detail cache", async () => {
  assert.equal((await plugin.getInfo()).breezeExperience.comicFollow, 1);
  await plugin.getComicDetail({ comicId: "offline-comic" });
  const cacheBefore = new Map(memory);
  requested = [];
  authorizations = [];
  chapterCount = 2;

  const follow = await plugin.getComicDetail(followPayload);
  assert.ok("data" in follow);
  assert.equal(follow.data.normal.comicInfo.id, "offline-comic");
  assert.deepEqual(follow.data.normal.eps.map(({ id, name, order }) => ({ id, name, order })), [
    { id: "ep-1", name: "Chapter 1", order: 1 },
    { id: "ep-2", name: "Chapter 2", order: 2 },
  ]);
  assert.deepEqual(requested, ["/comics/offline-comic", "/comics/offline-comic/eps?page=1"]);
  assert.deepEqual(authorizations, ["", ""]);
  assert.deepEqual(memory, cacheBefore);
});

test("follow uses the active authorization for a site requiring it", async () => {
  memory.set("config:auth.authorization", "fixture-session");
  const follow = await plugin.getComicDetail(followPayload);
  assert.ok("data" in follow);
  assert.equal(follow.data.normal.eps.length, 1);
  assert.deepEqual(authorizations, ["fixture-session", "fixture-session"]);
  assert.deepEqual([...memory], [["config:auth.authorization", "fixture-session"]]);
});

test("follow preserves the structured sign-in requirement from an HTTP 200 Bika error", async () => {
  client.defaults.adapter = async (config) => ({
    ...await adapter(config),
    data: { code: 401, error: "1005", message: "unauthorized" },
  });
  await assert.rejects(plugin.getComicDetail(followPayload), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(JSON.parse(error.message).type, "unauthorized");
    return true;
  });
  assert.deepEqual(requested, ["/comics/offline-comic"]);
  assert.deepEqual(authorizations, [""]);
});

test("follow does not ask for sign-in on an unrecognized gateway 401", async () => {
  client.defaults.adapter = async (config) => {
    const response = { ...await adapter(config), status: 401, data: "Unauthorized gateway" };
    throw new AxiosError("Gateway denied", "ERR_BAD_REQUEST", config, undefined, response);
  };
  assert.deepEqual(await plugin.getComicDetail(followPayload), {
    type: "comic_follow_error",
    reason: "sourceUnavailable",
    retryable: false,
  });
});

test("follow rejects a truncated second chapter page without committing any cache", async () => {
  chapterCount = 41;
  reportedPages = 2;
  client.defaults.adapter = async (config) => {
    const response = await adapter(config);
    if (String(config.url).endsWith("/eps?page=2")) {
      response.data.data.eps.docs = [];
    }
    return response;
  };
  assert.deepEqual(await plugin.getComicDetail(followPayload), {
    type: "comic_follow_error",
    reason: "invalidResponse",
    retryable: false,
  });
  assert.equal(memory.size, 0);
});

test("follow checks the entire chapter directory with bounded requests in flight", async () => {
  chapterCount = 281;
  reportedPages = 8;
  let concurrent = 0;
  let peakConcurrent = 0;
  client.defaults.adapter = async (config) => {
    concurrent++;
    peakConcurrent = Math.max(concurrent, peakConcurrent);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return await adapter(config);
    } finally {
      concurrent--;
    }
  };
  const follow = await plugin.getComicDetail(followPayload);
  assert.ok("data" in follow);
  const chapters = follow.data.normal.eps;
  assert.equal(chapters.length, 281);
  assert.equal(chapters[chapters.length - 1]?.id, "ep-281");
  assert.ok(peakConcurrent > 1 && peakConcurrent <= 3);
  assert.equal(requested.length, 9);
});

test("follow reports a transport failure without publishing the upstream error text", async () => {
  client.defaults.adapter = async (config) => {
    throw new AxiosError("Fixture text should stay out of the error envelope", "ERR_NETWORK", config);
  };
  assert.deepEqual(await plugin.getComicDetail(followPayload), {
    type: "comic_follow_error",
    reason: "network",
    retryable: true,
  });
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


test("detail distinguishes unknown counters from true zero before filling defaults", async () => {
  detailFields = { totalViews: " ", totalLikes: false, totalComments: -1, epsCount: undefined, pagesCount: "" };
  let detail = (await getComicDetail({ comicId: "offline-comic" })).data.normal;
  assert.deepEqual(detail.extern.metricAvailability, {
    totalViews: false, totalLikes: false, totalComments: false,
  });
  assert.equal(detail.comicInfo.titleMeta.some((item) => item.name.startsWith("浏览：")), false);
  assert.equal(detail.comicInfo.titleMeta.some((item) => item.name.startsWith("更新时间：")), false);
  assert.equal(detail.comicInfo.titleMeta.some((item) => item.name.startsWith("章节数：")), false);

  detailFields = { totalViews: 0, totalLikes: "0", totalComments: 0, commentsCount: 8, epsCount: 0, pagesCount: 0 };
  detail = (await getComicDetail({ comicId: "offline-comic" })).data.normal;
  assert.deepEqual(detail.extern.metricAvailability, {
    totalViews: true, totalLikes: true, totalComments: true,
  });
  assert.equal(detail.totalViews, 0);
  assert.equal(detail.totalLikes, 0);
  assert.equal(detail.totalComments, 0);
  assert.ok(detail.comicInfo.titleMeta.some((item) => item.name === "浏览：0"));
});

test("detail reads supported alias counters when a total is unavailable", async () => {
  detailFields = { likesCount: "7", commentsCount: "9", viewsCount: 3 };
  const detail = (await getComicDetail({ comicId: "offline-comic" })).data.normal;
  assert.equal(detail.totalViews, 3);
  assert.equal(detail.totalLikes, 7);
  assert.equal(detail.totalComments, 9);
});

const likePayload = { comicId: "offline-comic", currentLiked: false };

test("like uses the recognized server action and explicit zero without another request", async () => {
  likeResponse = { code: 200, data: { action: "unlike", totalLikes: 0, likesCount: 12 } };
  assert.deepEqual(await toggleLike(likePayload), {
    liked: false, verified: true, totalLikes: 0,
  });
  assert.deepEqual(requested, ["/comics/offline-comic/like"]);
});

test("like confirms a missing total with one request under the selected auth and route", async () => {
  memory.set("config:auth.authorization", "fixture-session");
  memory.set("config:network.proxy", "2");
  detailFields = { isLiked: true, totalLikes: "21", likesCount: 9 };
  assert.deepEqual(await toggleLike({ ...likePayload, currentLiked: true }), {
    liked: true, verified: true,
  });
  assert.deepEqual(requested, ["/comics/offline-comic/like"]);
  const [post] = likeCalls;
  assert.equal(post?.method, "POST");
  assert.equal(post?.authorization, "fixture-session");
  assert.equal(post?.channel, "2");
  assert.equal(post?.redirect, "error");
  assert.equal([...memory.keys()].some((key) => key.startsWith("bikaComic:requestCache:")), false);
});

for (const [name, fields] of [
  ["another work", { _id: "other", isLiked: true, totalLikes: 55 }],
  ["contradictory state", { isLiked: "false", likesCount: 55 }],
  ["invalid numeric fields", { isLiked: true, totalLikes: false, likesCount: -1 }],
] as const) {
  test(`like keeps confirmed action and omits a count from ${name}`, async () => {
    likeResponse = { code: 200, data: { action: "like", ...fields } };
    assert.deepEqual(await toggleLike(likePayload), { liked: true, verified: true });
    assert.deepEqual(requested, ["/comics/offline-comic/like"]);
  });
}

test("like returns an unchanged total from the receipt without another request", async () => {
  likeResponse = { code: 200, data: { action: "like", likesCount: 227 } };
  assert.deepEqual(await toggleLike({ ...likePayload, previousTotalLikes: 227 }), {
    liked: true, verified: true, totalLikes: 227,
  });
  assert.deepEqual(requested, ["/comics/offline-comic/like"]);
});

for (const envelope of [
  { code: 503, data: { action: "like", totalLikes: 2 } },
  { code: 200, success: false, data: { action: "like" } },
  { code: 200, data: { action: "unknown", liked: true } },
]) {
  test(`like rejects an unsuccessful envelope after one POST: ${JSON.stringify(envelope)}`, async () => {
    likeResponse = envelope;
    await assert.rejects(toggleLike(likePayload));
    assert.deepEqual(requested, ["/comics/offline-comic/like"]);
  });
}

test("like keeps structured authorization errors from a HTTP 200 mutation response", async () => {
  likeResponse = { code: 401, error: "1005", message: "unauthorized" };
  await assert.rejects(toggleLike(likePayload), (error: Error) =>
    JSON.parse(error.message).type === "unauthorized"
  );
  assert.deepEqual(requested, ["/comics/offline-comic/like"]);
});

test("like drops a result when the auth generation changes during the POST", async () => {
  client.defaults.adapter = async (config) => {
    const result = await adapter(config);
    if (String(config.method).toUpperCase() === "POST") beginBikaAuthChange();
    return result;
  };
  await assert.rejects(toggleLike(likePayload), /账号已变化/);
  assert.deepEqual(requested, ["/comics/offline-comic/like"]);
});
