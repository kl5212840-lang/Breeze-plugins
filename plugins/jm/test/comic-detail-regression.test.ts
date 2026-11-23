import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
import type { ComicListItem } from "breeze-plugin-kit";

let response: unknown;
type FixtureReply = { status: number; data: unknown };
let responseFor: ((config: InternalAxiosRequestConfig) => FixtureReply | Promise<FixtureReply>) | undefined;
const requests: InternalAxiosRequestConfig[] = [];
const settingReads: string[] = [];
const tokenWrites: string[] = [];
const settings = new Map<string, unknown>();
const cache = new Map<string, unknown>();
(globalThis as any).bridge = {
  call: async (name: string, key: any, value: unknown) => {
    if (name === "cache.get") return cache.get(key) ?? value ?? null;
    if (name === "cache.set") {
      if (key === "JmComic::jwt") tokenWrites.push(key);
      cache.set(key, value);
      return true;
    }
    if (name === "cache.delete") { cache.delete(key); return true; }
    if (name === "load_plugin_config") {
      settingReads.push(key);
      return JSON.stringify({ ok: true, value: settings.get(key) ?? JSON.parse(String(value)) });
    }
    if (name === "save_plugin_config") {
      if (key === "auth.jwt") tokenWrites.push(key);
      settings.set(key, JSON.parse(String(value)));
      return true;
    }
    if (name.includes("md5")) return "fixture-hash";
    if (name === "opencc.convert") return key.text;
    if (name === "flutter.showToast") return true;
    throw Error(`Unexpected offline fixture bridge call ${name}`);
  },
};
axios.defaults.adapter = async (config) => {
  requests.push(config);
  const reply = await (responseFor?.(config) ?? { status: 200, data: response });
  return { ...reply, statusText: "fixture", headers: {}, config };
};
const { default: plugin } = await import("../src/index");
const { decodeResponsePayload } = await import("../src/codec");
const full = { id: 51, name: "fixture title", description: "fixture summary", tags: ["fixture tag"], total_views: "123", likes: "8", comment_total: "3" };
beforeEach(() => {
  response = { ...full };
  responseFor = undefined;
  requests.length = 0;
  settingReads.length = 0;
  tokenWrites.length = 0;
  settings.clear();
  cache.clear();
});

const followPayload = { comicId: "51", extern: { comicFollow: true } };
const series = [
  { id: "51", sort: "0", name: "cover" },
  { id: "53", sort: "2", name: "second" },
  { id: "52", sort: "1", name: "first" },
];

function followFailure(reason: string) {
  return (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(JSON.parse(error.message).type, "comic_follow_error");
    assert.equal(JSON.parse(error.message).reason, reason);
    return true;
  };
}

test("public follow starts without saved JWT and ignores a returned JWT", async () => {
  settings.set("auth.jwt", "expired-fixture-token");
  responseFor = (request) => request.headers.get("Authorization")
    ? { status: 401, data: { message: "Unauthorized" } }
    : { status: 200, data: { ...full, series, jwttoken: "unexpected-fixture-token" } };

  const result = await plugin.getComicDetail(followPayload);
  assert.equal(requests.length, 1);
  assert.match(requests[0]?.url ?? "", /\/album$/);
  assert.equal(requests[0]?.headers.get("Authorization"), undefined);
  assert.equal(settingReads.includes("auth.jwt"), false);
  assert.deepEqual(tokenWrites, []);
  assert.deepEqual(result.data.normal.eps.map(({ id, order, name }) => [id, order, name]), [
    ["52", 1, "first"],
    ["53", 2, "second"],
  ]);
  assert.equal(JSON.stringify(result).includes("unexpected-fixture-token"), false);
});

test("an explicit JM membership response allows one read with the saved JWT", async () => {
  settings.set("auth.jwt", "valid-fixture-token");
  responseFor = (request) => request.headers.get("Authorization") === "Bearer valid-fixture-token"
    ? { status: 200, data: { ...full, series, jwttoken: "unexpected-fixture-token" } }
    : { status: 401, data: { msg: "請先登入會員" } };
  const result = await plugin.getComicDetail(followPayload);
  assert.deepEqual(requests.map((request) => request.headers.get("Authorization")), [
    undefined,
    "Bearer valid-fixture-token",
  ]);
  assert.equal(requests[0]?.url, requests[1]?.url);
  assert.deepEqual(tokenWrites, []);
  assert.equal(result.data.normal.eps.length, 2);
});

test("a confirmed membership gate without a session asks to sign in", async () => {
  responseFor = () => ({ status: 200, data: { code: 401, data: { msg: "請先登入會員" } } });
  await assert.rejects(plugin.getComicDetail(followPayload), followFailure("signInRequired"));
  assert.equal(requests.length, 1);
});

test("an ambiguous 401 does not read or forward saved credentials", async () => {
  settings.set("auth.jwt", "not-for-the-gateway");
  responseFor = () => ({ status: 401, data: "Unauthorized" });
  await assert.rejects(plugin.getComicDetail(followPayload), followFailure("sourceUnavailable"));
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.headers.get("Authorization"), undefined);
  assert.equal(settingReads.includes("auth.jwt"), false);
  assert.deepEqual(tokenWrites, []);
});

test("only a confirmed one-shot becomes one chapter, while ordinary detail accepts sparse albums", async () => {
  for (const bad of [
    { ...full, total_photos: "8" },
    { ...full, series: null, total_photos: "8" },
    { ...full, series: [] },
    { ...full, series: [{ id: "", sort: "1" }] },
    { ...full, series: [{ id: "52", sort: "0" }], total_photos: "8" },
    { ...full, series: [...series, { id: "53", sort: "3" }] },
  ]) {
    response = bad;
    await assert.rejects(plugin.getComicDetail(followPayload), followFailure("invalidResponse"));
  }
  for (const singleSeries of [[], [series[0]]]) {
    response = { ...full, series: singleSeries, total_photos: "8" };
    const { data: { normal } } = await plugin.getComicDetail(followPayload);
    assert.deepEqual(normal.eps.map(({ id, order, name }) => [id, order, name]), [["51", 1, "第1话"]]);
  }
  response = { ...full };
  assert.equal((await plugin.getComicDetail({ comicId: "51" })).data.normal.eps.length, 1);
});

test("search sends the selected author or tag scope without changing ordinary requests", async () => {
  response = { content: [], total: 0 };
  const schema = await plugin.getAdvancedSearchScheme({ extern: { main_tag: "3" } });
  assert.deepEqual(
    schema.scheme.fields.find((field) => field.key === "search_type")?.options?.map((option) => option.value),
    ["site", "work", "author", "tag", "character"],
  );
  assert.equal(schema.data.values.main_tag, 3);
  assert.equal(schema.data.values.search_type, "tag");
  assert.equal(schema.data.values.y, "");
  assert.equal(schema.data.values.m, "");
  const sort = schema.scheme.fields.find((field) => field.key === "sortBy")?.options;
  assert.equal(sort?.find((option) => option.value === 1)?.label, "最新");
  assert.equal(sort?.find((option) => option.value === 5)?.label, "从旧到新");
  const dateFields = schema.scheme.fields.filter((field) => field.key === "y" || field.key === "m");
  assert.deepEqual(dateFields.map((field) => Reflect.get(field, "optionLayout")), ["menu", "menu"]);
  assert.equal(Reflect.get(dateFields[1]!, "requiresOption"), "y");
  assert.equal(Reflect.get(await plugin.getInfo(), "breezeExperience").jmSearchDiscoveryFunction,
    "getJmSearchDiscovery");

  for (const [keyword, scope, expected] of [
    ["fixture", undefined, undefined],
    ["fixture", "unknown", undefined],
    ["fixture", 2, 2],
    ["123", "3", 3],
  ] as const) {
    const before = requests.length;
    await plugin.searchComic({ keyword, page: 1, extern: { main_tag: scope } });
    assert.equal(requests.length, before + 1);
    const request = requests[requests.length - 1]!;
    assert.match(request.url ?? "", /\/search$/);
    assert.equal(request.params.search_query, keyword);
    assert.equal(request.params.main_tag, expected);
  }
});

test("JM search sends official modes and dates without changing legacy scope requests", async () => {
  response = { code: 200, data: { content: [], total: 0 } };
  for (const mode of ["site", "work", "author", "tag", "character"]) {
    await plugin.searchComic({
      keyword: "example",
      page: 2,
      extern: { search_type: mode, main_tag: 2, y: "2020", m: "03", sortBy: 5 },
    });
    assert.deepEqual(requests[requests.length - 1]?.params, {
      search_query: "example", page: 2, o: "old", search_type: mode, y: 2020, m: 3,
    });
  }
  await plugin.searchComic({ keyword: "123", extern: { search_type: "character" } });
  assert.match(requests[requests.length - 1]?.url ?? "", /\/search$/);
  assert.equal(requests[requests.length - 1]?.params.search_type, "character");

  await plugin.searchComic({ keyword: "example", extern: {
    search_type: "unsupported", main_tag: 3, y: 2016, m: 13,
  } });
  assert.deepEqual(requests[requests.length - 1]?.params, {
    search_query: "example", page: 1, o: "", main_tag: 3,
  });
  await plugin.searchComic({ keyword: "example", extern: { search_type: "site", y: "", m: 5 } });
  assert.deepEqual(requests[requests.length - 1]?.params, {
    search_query: "example", page: 1, o: "", search_type: "site",
  });
});

test("JM public lists continue a short page while the source reports more rows", async () => {
  response = { code: 200, data: { content: [full], total: 81 } };
  const first = await plugin.searchComic({ keyword: "fixture", page: 1 });
  assert.equal(first.data.paging.hasReachedMax, false);
  const last = await plugin.searchComic({ keyword: "fixture", page: 2 });
  assert.equal(last.data.paging.hasReachedMax, true);

  response = { content: [full], total: 81 };
  assert.equal((await plugin.getRankingData({ page: 1 })).data.hasReachedMax, false);
  assert.equal((await plugin.getRankingData({ page: 2 })).data.hasReachedMax, true);
  response = { list: [full], total: 28 };
  assert.equal((await plugin.getPromoteListData({ page: 1 })).data.hasReachedMax, false);
  assert.equal((await plugin.getPromoteListData({ page: 2 })).data.hasReachedMax, true);
});

test("JM earliest ordering uses available publication dates while retaining every result", async () => {
  response = { code: 200, data: { content: [
    { id: 51, name: "later", adddate: "2025-06-28" },
    { id: 52, name: "earlier", adddate: "2020-03-10" },
    { id: 53, name: "same day", adddate: "2020-03-10" },
    { id: 54, name: "unknown" },
  ], total: 4 } };
  const result = await plugin.searchComic({ keyword: "example", extern: { sortBy: 5 } });
  assert.deepEqual(result.data.items.map((item) => item.id), ["52", "53", "51", "54"]);
  assert.equal(result.data.paging.total, 4);
});

test("JM search discovery keeps one available section when the other fails", async () => {
  settings.set("auth.jwt", "private-fixture-token");
  responseFor = (request) => request.url?.endsWith("/hot_tags")
    ? { status: 200, data: { code: 200, data: [" first ", "first", "second"] } }
    : { status: 200, data: [{ ...full }, { ...full }, { id: 1, name: "" }] };
  const discovery = await plugin.getJmSearchDiscovery();
  assert.deepEqual(discovery.data.topics, ["first", "second"]);
  assert.equal(discovery.data.topicStatus, "ready");
  assert.equal(discovery.data.recommendationStatus, "ready");
  assert.deepEqual(discovery.data.items.map(({ id, title }) => [id, title]), [["51", full.name]]);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.method === "get"));
  assert.ok(requests.every((request) => !request.headers.get("Authorization")));
  assert.equal(settingReads.includes("auth.jwt"), false);
  assert.deepEqual(tokenWrites, []);

  responseFor = (request) => request.url?.endsWith("/hot_tags")
    ? { status: 503, data: {} }
    : { status: 200, data: { code: 200, data: [] } };
  assert.deepEqual((await plugin.getJmSearchDiscovery()).data, {
    topics: [], items: [], topicStatus: "unavailable", recommendationStatus: "ready",
  });
});

test("detail metadata opens the matching source search scope", async () => {
  response = { ...full, author: ["fixture author"], works: ["fixture work"], actors: ["fixture actor"] };
  const { data: { normal } } = await plugin.getComicDetail({ comicId: "51" });
  response = { content: [], total: 0 };
  for (const [type, mode, keyword, mainTag] of [
    ["author", "author", "fixture author", 2],
    ["tags", "tag", "fixture tag", 3],
    ["works", "work", "fixture work", undefined],
    ["actors", "character", "fixture actor", undefined],
  ] as const) {
    const action = normal.comicInfo.metadata.find((item) => item.type === type)?.value[0]?.onTap;
    assert.equal(action?.type, "openSearch");
    const payload = action?.payload as { keyword: string; extern?: Record<string, unknown> };
    assert.equal(payload.keyword, keyword);
    assert.equal(payload.extern?.main_tag, mainTag);
    await plugin.searchComic(payload);
    assert.deepEqual(requests[requests.length - 1]?.params, {
      search_query: keyword, page: 1, o: "", search_type: mode,
    });
  }
});

test("album object-data envelope retains description, tags and explicit counts", async () => {
  response = { code: 200, data: full };
  const result = await plugin.getComicDetail({ comicId: "51" });
  const normal = result.data.normal;
  assert.equal(normal.comicInfo.id, "51");
  assert.equal(normal.comicInfo.description, full.description);
  assert.equal(normal.comicInfo.metadata.find((item) => item.type === "tags")?.value[0]?.name, "fixture tag");
  assert.equal(normal.totalViews, 123);
  assert.equal(normal.totalComments, 3);
});

test("publication date never substitutes for the update timestamp in detail or ID lookup", async () => {
  const addtime = String(Date.parse("2020-03-09T17:00:00Z") / 1000);
  const updateTime = "2025-11-22T18:00:00.000Z";
  response = { ...full, id: 151, addtime };
  let detail = (await plugin.getComicDetail({ comicId: "151" })).data.normal;
  assert.equal(detail.comicInfo.titleMeta.some((item) => item.name === "发布：2020-03-10"), true);
  assert.equal(detail.comicInfo.titleMeta.some((item) => item.name.startsWith("更新：")), false);
  assert.equal((await plugin.searchComic({ keyword: "JM151" })).data.items[0]?.updatedAt, "");

  response = { ...full, id: 151, addtime, update_at: Date.parse(updateTime) / 1000 };
  detail = (await plugin.getComicDetail({ comicId: "151" })).data.normal;
  assert.equal(detail.comicInfo.titleMeta.some((item) => item.name === "更新：2025-11-23"), true);
  assert.equal((await plugin.searchComic({ keyword: "JM151" })).data.items[0]?.updatedAt, updateTime);
});

test("missing or invalid optional metrics stay unknown; explicit zero remains known", async () => {
  response = { id: 51, name: "fixture title", likes: "0", total_views: "", comment_total: "bad" };
  const normal = (await plugin.getComicDetail({ comicId: "51" })).data.normal;
  assert.deepEqual(normal.extern.metricAvailability, { totalViews: false, totalLikes: true, totalComments: false });
  assert.equal(normal.totalLikes, 0);
  assert.equal(normal.comicInfo.titleMeta.some((item) => item.name.startsWith("浏览：")), false);
  assert.equal(normal.comicInfo.description, "");
  assert.equal(normal.comicInfo.metadata.length, 0);
});

for (const [name, value] of [
  ["wrong identity", { ...full, id: 52 }],
  ["empty title", { ...full, name: " " }],
  ["error document", { code: 200, msg: "fixture error" }],
  ["logical error", { ...full, code: 500 }],
] as const) {
  test(`album rejects ${name} instead of showing a successful empty detail`, async () => {
    response = value;
    await assert.rejects(plugin.getComicDetail({ comicId: "51" }), /作品资料|详情/);
  });
}

test("generic object-data decoding remains unchanged for account and mutation contracts", async () => {
  for (const payload of [
    { code: 200, data: { uid: "fixture-user", nickname: "fixture name" } },
    { code: 200, data: { status: "ok", msg: "fixture result" } },
    { code: 200, data: { list: [], total: 0 } },
  ]) {
    assert.deepEqual(await decodeResponsePayload(payload, "1"), payload);
  }
});

test("missing optional fields are distinct from legitimate empty values and invalid fragments", async () => {
  for (const [input, expected] of [
    [{ id: 51, name: "fixture" }, ["description", "tags"]],
    [{ id: 51, name: "fixture", description: "", tags: [] }, []],
    [{ id: 51, name: "fixture", description: null, tags: "bad" }, ["description", "tags"]],
    [{ id: 51, name: "fixture", description: "valid", tags: ["valid", {}] }, ["tags"]],
  ] as const) {
    response = input;
    const normal = (await plugin.getComicDetail({ comicId: "51" })).data.normal;
    assert.deepEqual(normal.extern.fieldsMissing, expected);
    assert.equal(normal.comicInfo.description.includes("[object Object]"), false);
    assert.equal(normal.comicInfo.metadata.some((item) => item.value.some((value) => value.name.includes("[object Object]"))), false);
  }
});

test("album metadata in the wrapper fills only absent nested fields, with explicit nested emptiness authoritative", async () => {
  response = { code: 200, description: "root summary", tags: ["root tag"], total_views: "7",
    data: { id: 51, name: "fixture", likes: "0", comment_total: "0" } };
  let normal = (await plugin.getComicDetail({ comicId: "51" })).data.normal;
  assert.equal(normal.comicInfo.description, "root summary");
  assert.equal(normal.comicInfo.metadata.find((item) => item.type === "tags")?.value[0]?.name, "root tag");
  assert.deepEqual(normal.extern.fieldsMissing, []);
  assert.deepEqual(normal.extern.metricAvailability, { totalViews: true, totalLikes: true, totalComments: true });
  response = { code: 200, description: "root summary", tags: ["root tag"], total_views: "7",
    data: { id: 51, name: "fixture", description: "", tags: [], total_views: null } };
  normal = (await plugin.getComicDetail({ comicId: "51" })).data.normal;
  assert.equal(normal.comicInfo.description, "");
  assert.equal(normal.comicInfo.metadata.length, 0);
  assert.deepEqual(normal.extern.fieldsMissing, []);
  assert.equal((normal.extern.metricAvailability as any).totalViews, false);
});

test("work likes remain visible with no write capability", async () => {
  response = { ...full, liked: true, likes: "14" };
  const { data: { normal } } = await plugin.getComicDetail({ comicId: "51" });
  assert.equal(normal.allowLike, false);
  assert.equal(normal.totalLikes, 14);
  assert.equal(normal.isLiked, true);
  assert.equal("toggleLike" in plugin, false);
  assert.deepEqual(requests.map((request) => [request.method, new URL(request.url!).pathname]), [
    ["get", "/album"],
  ]);
});

test("JM list metrics distinguish real zero from absent and malformed counts", async () => {
  response = { list: [
    { id: 51, name: "known", likes: "0", total_views: "29" },
    { id: 52, name: "missing" },
    { id: 53, name: "malformed", likes: true, total_views: [15] },
  ] };
  const { data } = await plugin.getWeekRankingData({});
  const items: ComicListItem[] = data.items;
  assert.deepEqual(items.map((item) => [item.likesCount, item.viewsCount]), [[0, 29], [0, 0], [0, 0]]);
  assert.deepEqual(items.map((item) => [item.raw.likes, item.raw.totalViews]), [[0, 29], [null, null], [null, null]]);
  assert.deepEqual(items.map((item) => item.extern), [
    { metricAvailability: { totalLikes: true, totalViews: true } },
    { metricAvailability: { totalLikes: false, totalViews: false } },
    { metricAvailability: { totalLikes: false, totalViews: false } },
  ]);
});

test("JM chapter labels preserve source names and use the source order for unnamed entries", async () => {
  response = { ...full, series: [
    { id: "53", sort: "52", name: "" },
    { id: "52", sort: "48", name: "第48話" },
  ] };
  const { data: { normal } } = await plugin.getComicDetail({ comicId: "51" });
  assert.deepEqual(normal.eps.map(({ id, order, name }) => [id, order, name]), [
    ["52", 1, "第48話"], ["53", 2, "第52话"],
  ]);
  assert.equal(normal.comicInfo.titleMeta.some((item) => item.name === "章节数：2"), true);
});

test("JM detail only presents chapter and page counts backed by album fields", async () => {
  response = { ...full, total_photos: true };
  let normal = (await plugin.getComicDetail({ comicId: "51" })).data.normal;
  assert.equal(normal.eps.length, 1);
  assert.equal(normal.comicInfo.titleMeta.some((item) => /^(章节数|页数)：/.test(item.name)), false);

  response = { ...full, series: [], total_photos: "12" };
  normal = (await plugin.getComicDetail({ comicId: "51" })).data.normal;
  assert.equal(normal.comicInfo.titleMeta.some((item) => item.name === "章节数：1"), true);
  assert.equal(normal.comicInfo.titleMeta.some((item) => item.name === "页数：12"), true);
});
