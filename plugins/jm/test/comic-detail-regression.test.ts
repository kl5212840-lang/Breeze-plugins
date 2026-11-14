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
    schema.scheme.fields.find((field) => field.key === "main_tag")?.options?.map((option) => option.value),
    [0, 2, 3],
  );
  assert.equal(schema.data.values.main_tag, 3);

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

test("detail author and tag actions retain their exact search scope", async () => {
  response = { ...full, author: ["fixture author"] };
  const { data: { normal } } = await plugin.getComicDetail({ comicId: "51" });
  for (const [type, mode] of [["author", 2], ["tags", 3]] as const) {
    const action = normal.comicInfo.metadata.find((item) => item.type === type)?.value[0]?.onTap;
    assert.equal(action?.type, "openSearch");
    const payload = action?.payload as { extern?: Record<string, unknown> } | undefined;
    assert.equal(payload?.extern?.main_tag, mode);
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

const likePayload = { comicId: "51", currentLiked: false };

test("album like sends one form POST and reads the same session and album for the exact total", async () => {
  settings.set("auth.jwt", "fixture-member-session");
  responseFor = (request) => request.method === "post"
    ? { status: 200, data: { code: 200, data: { code: 200, jwttoken: "unrelated-token" } } }
    : { status: 200, data: { code: 200, data: { ...full, liked: true, likes: "14" } } };

  assert.deepEqual(await plugin.toggleLike(likePayload), { liked: true, verified: true, totalLikes: 14 });
  assert.deepEqual(requests.map((request) => [request.method, new URL(request.url!).pathname]), [
    ["post", "/like"],
    ["get", "/album"],
  ]);
  assert.equal(requests[0]?.data, "id=51");
  assert.equal(requests[0]?.headers.getContentType(), "application/x-www-form-urlencoded");
  assert.deepEqual(requests[1]?.params, { id: "51" });
  assert.ok(requests.every((request) => request.headers.get("Authorization") === "Bearer fixture-member-session"));
  assert.ok(requests.every((request) => request.maxRedirects === 0));
  assert.ok(requests.every((request) => (request as InternalAxiosRequestConfig & {
    fetchOptions?: { redirect?: string };
  }).fetchOptions?.redirect === "manual"));
  assert.deepEqual(tokenWrites, []);

  const reopened = (await plugin.getComicDetail({ comicId: "51" })).data.normal;
  assert.equal(reopened.isLiked, true);
  assert.equal(reopened.totalLikes, 14);
  assert.equal(reopened.extern.canUnlike, false);
});

test("album like confirms explicit liked while preserving a genuine zero or omitting an unknown total", async () => {
  for (const [likes, expected] of [
    ["0", { liked: true, verified: true, totalLikes: 0 }],
    ["invalid", { liked: true, verified: true }],
  ] as const) {
    responseFor = (request) => request.method === "post"
      ? { status: 200, data: {} }
      : { status: 200, data: { ...full, liked: true, likes } };
    assert.deepEqual(await plugin.toggleLike(likePayload), expected);
  }
});

test("an unreadable or lost like receipt permits one same-session album read without replaying the write", async () => {
  settings.set("auth.jwt", "fixture-member-session");
  const postReplies = [
    () => ({ status: 204, data: null }),
    () => ({ status: 200, data: "unreadable fixture reply" }),
    () => { throw new AxiosError("Network Error", "ERR_NETWORK"); },
    () => { throw AxiosError.from(new TypeError("Failed to read HTTP response body bytes")); },
  ];
  for (const postReply of postReplies) {
    requests.length = 0;
    responseFor = (request) => request.method === "post"
      ? postReply()
      : { status: 200, data: { ...full, liked: true, likes: "14" } };
    assert.deepEqual(await plugin.toggleLike(likePayload), { liked: true, verified: true, totalLikes: 14 });
    assert.deepEqual(requests.map((request) => [request.method, new URL(request.url!).pathname]), [
      ["post", "/like"],
      ["get", "/album"],
    ]);
    assert.ok(requests.every((request) => request.headers.get("Authorization") === "Bearer fixture-member-session"));
    assert.deepEqual(requests[1]?.params, { id: "51" });
    assert.deepEqual(tokenWrites, []);
  }
});

test("a lost like receipt with no matching liked read stays unconfirmed", async () => {
  responseFor = (request) => {
    if (request.method === "post") throw new AxiosError("Network Error", "ERR_NETWORK");
    return { status: 200, data: { ...full, liked: false, likes: "14" } };
  };
  await assert.rejects(plugin.toggleLike(likePayload), /无法确认点赞状态/);
  assert.deepEqual(requests.map((request) => request.method), ["post", "get"]);
});

test("a transport failure while reading the album reports unconfirmed status", async () => {
  responseFor = (request) => {
    if (request.method === "get") throw new AxiosError("Network Error", "ERR_NETWORK");
    return { status: 200, data: { code: 200 } };
  };
  await assert.rejects(plugin.toggleLike(likePayload), /无法确认点赞状态/);
  assert.deepEqual(requests.map((request) => request.method), ["post", "get"]);
});

test("like diagnostics record stages and safe field classifications only", async (t) => {
  const lines: string[] = [];
  for (const level of ["info", "warn"] as const) {
    t.mock.method(console, level, (line: string) => { lines.push(line); });
  }
  settings.set("auth.jwt", "private-fixture-token");
  const secret = "https://private.example/fixture-account";
  const readbacks = [
    {
      read: () => ({ status: 200, data: { id: 51, liked: false, likes: 4321, message: secret } }),
      expected: ["readback http=200 result=readable",
        "verify result=unconfirmed work=match likedType=boolean liked=false total=present totalChange=unchanged"],
    },
    {
      read: () => ({ status: 200, data: { id: 51, liked: "1", likes: secret } }),
      expected: ["readback http=200 result=readable",
        "verify result=unconfirmed work=match likedType=string liked=unknown total=invalid totalChange=unknown"],
    },
    {
      read: () => ({ status: 200, data: { id: 700001, account: secret } }),
      expected: ["readback http=200 result=readable",
        "verify result=unconfirmed work=mismatch likedType=missing liked=unknown total=missing totalChange=unknown"],
    },
    {
      read: () => ({ status: 503, data: { message: secret } }),
      expected: ["readback http=503 result=http-rejected"],
    },
    {
      read: () => ({ status: 200, data: { code: 500, message: secret } }),
      expected: ["readback http=200 result=business-rejected"],
    },
    {
      read: () => { throw new AxiosError(secret, "ERR_NETWORK"); },
      expected: ["readback http=unknown result=transport"],
    },
    {
      read: () => ({ status: 200, data: { id: 51, liked: "true", likes: 4322, message: secret } }),
      expected: ["readback http=200 result=readable",
        "verify result=confirmed work=match likedType=string liked=true total=present totalChange=changed"],
      confirmed: true,
    },
  ];
  for (const { read, expected, confirmed } of readbacks) {
    lines.length = 0;
    requests.length = 0;
    responseFor = (request) => request.method === "post"
      ? { status: 200, data: { code: 200, message: secret } }
      : read();
    const action = plugin.toggleLike({ ...likePayload, previousTotalLikes: 4321, includeLikeDiagnostic: true });
    if (confirmed) {
      assert.deepEqual(await action, { liked: true, verified: true, totalLikes: 4322, likeDiagnostic: {
        submit: { http: 200, result: "readable" },
        readback: { http: 200, result: "readable" },
        verify: { result: "confirmed", work: "match", likedType: "string", liked: "true", total: "present", totalChange: "changed" },
      } });
    } else {
      await assert.rejects(action, (error: Error) => {
        assert.doesNotMatch(error.message, /private\.example|private-fixture-token|fixture-account|700001|4321/);
        const failure = JSON.parse(error.message);
        assert.equal(failure.type, "comic_like_unconfirmed");
        assert.deepEqual(failure.diagnostic.submit, { http: 200, result: "readable" });
        assert.equal(failure.diagnostic.readback.result, expected[0]?.split("result=")[1]);
        return true;
      });
    }
    assert.deepEqual(requests.map((request) => request.method), ["post", "get"]);
    assert.deepEqual(lines.filter((line) => line.startsWith("[jm.like]")),
      ["submit http=200 result=readable", ...expected].map((line) => `[jm.like] ${line}`));
  }
  lines.length = 0;
  requests.length = 0;
  responseFor = () => ({ status: 403, data: { code: 403, message: "fixture rejection" } });
  await assert.rejects(plugin.toggleLike({ ...likePayload, includeLikeDiagnostic: true }), (error: Error) => {
    assert.deepEqual(JSON.parse(error.message), {
      type: "comic_like_rejected", message: "fixture rejection",
      diagnostic: { submit: { http: 403, result: "http-rejected" } },
    });
    return true;
  });
  assert.deepEqual(requests.map((request) => request.method), ["post"]);
  assert.deepEqual(lines, ["[jm.like] submit http=403 result=http-rejected"]);
});

test("album like cannot infer success from an unrelated, unliked or incomplete readback", async () => {
  for (const album of [
    { ...full, liked: false, likes: "10" },
    { ...full, likes: "10" },
    { ...full, liked: true, id: 52 },
  ]) {
    responseFor = (request) => request.method === "post"
      ? { status: 200, data: { code: 200 } }
      : { status: 200, data: album };
    await assert.rejects(plugin.toggleLike(likePayload), /点赞状态/);
  }
});

test("album like surfaces explicit business rejections without a second request", async () => {
  for (const rejected of [
    { code: 400, msg: "fixture rejection", data: '{"code":200}' },
    { code: 200, data: { code: 200, status: "error", msg: "fixture rejection" } },
  ]) {
    requests.length = 0;
    responseFor = () => ({ status: 200, data: rejected });
    await assert.rejects(plugin.toggleLike(likePayload), /fixture rejection/);
    assert.equal(requests.length, 1);
  }
});

test("album like maps HTTP and application membership failures to the login flow", async () => {
  for (const status of [200, 401, 403]) {
    requests.length = 0;
    responseFor = () => ({ status, data: { code: 200, data: { errorMsg: "請先登入會員" } } });
    await assert.rejects(plugin.toggleLike(likePayload), (error: Error) => JSON.parse(error.message).type === "unauthorized");
    assert.equal(requests.length, 1);
  }
});

test("album like does not repeat a rejected POST and cannot unlike", async () => {
  responseFor = () => ({ status: 307, data: null });
  await assert.rejects(plugin.toggleLike(likePayload), /307/);
  assert.equal(requests.length, 1);
  await assert.rejects(plugin.toggleLike({ ...likePayload, currentLiked: true }), /取消点赞/);
  assert.equal(requests.length, 1);
});

test("album like stops after logout while the POST is in flight", async () => {
  settings.set("auth.jwt", "fixture-member-session");
  let notifyPostStarted!: () => void;
  const started = new Promise<void>((resolve) => { notifyPostStarted = resolve; });
  let completePost!: (reply: FixtureReply) => void;
  const pending = new Promise<FixtureReply>((resolve) => { completePost = resolve; });
  responseFor = () => { notifyPostStarted(); return pending; };

  const like = plugin.toggleLike(likePayload);
  await started;
  await plugin.clearPluginSession();
  completePost({ status: 200, data: { code: 200 } });
  await assert.rejects(like, /会话已变更/);
  assert.equal(requests.length, 1);
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
