import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../src/index.ts";

test("cloud favorites send declared ordering and expose only verified site totals", async () => {
  const scene = (await plugin.getCloudFavoriteSceneBundle()).data.scene;
  assert.equal(scene.body.request?.fnPath, "getCloudFavoriteData");
  assert.equal(scene.filter?.fnPath, "getCloudFavoriteFilterBundle");
  assert.equal(scene.filter?.extern?.source, "cloudFavorite");
  const bundle = await plugin.getCloudFavoriteFilterBundle();
  const field = bundle.scheme.fields?.find(field => field.key === "ordering");
  assert.ok(field);
  assert.equal(bundle.data.values?.ordering, "-datetime_modifier");
  assert.deepEqual(field.options?.map(option => option.value),
    ["-datetime_modifier", "datetime_modifier", "-popular"]);
  const previousBridge = globalThis.bridge;
  const previousFetch = globalThis.fetch;
  const requests: URL[] = [];
  let results: Record<string, unknown> = {list: [], limit: 21};
  globalThis.bridge = {call: async (fn: string, key: string, fallback: unknown) => {
    if (fn === "load_plugin_config") {
      return JSON.stringify({ok: true, value: key === "auth.token" ? "fixture-token" : fallback});
    }
    if (fn === "cache.get") return fallback;
    return true;
  }} as typeof globalThis.bridge;
  globalThis.fetch = async input => {
    const request = input as Request;
    assert.equal(request.method, "GET");
    assert.equal(request.headers.get("authorization"), "Token fixture-token");
    requests.push(new URL(request.url));
    return new Response(JSON.stringify({code: 200, results}),
      {headers: {"content-type": "application/json"}});
  };
  try {
    for (const option of field.options ?? []) {
      const extern = option.result?.extern;
      assert.equal(extern?.ordering, option.value);
      for (const page of [1, 2]) {
        await plugin.getCloudFavoriteData({page, extern});
        const url = requests.at(-1)!;
        assert.equal(url.pathname, "/api/v3/member/collect/comics");
        assert.equal(url.searchParams.get("ordering"), option.value);
        assert.equal(url.searchParams.get("offset"), String((page - 1) * 21));
        assert.equal(url.searchParams.get("limit"), "21");
        assert.equal(url.searchParams.get("free_type"), "1");
        assert.equal(url.searchParams.has("order"), false);
      }
    }
    assert.equal(requests.length, 6);
    const comic = {uuid: 1, comic: {path_word: "real-comic", name: "Real comic"}};
    const cases = [
      {page: 1, results: {list: [comic], total: 40}, total: 40, ended: false},
      {page: 2, results: {list: [comic], total: "22"}, total: 22, ended: true},
      {page: 1, results: {list: [], total: 0}, total: 0, ended: true},
      {page: 1, results: {list: []}, total: undefined, ended: true},
      {page: 1, results: {list: [], total: 40}, total: undefined, ended: true},
      {page: 1, results: {list: [comic], total: true}, total: undefined, ended: true},
      {page: 2, results: {list: [comic], total: 21}, total: undefined, ended: true},
    ];
    for (const testCase of cases) {
      results = testCase.results;
      const {data} = await plugin.getCloudFavoriteData({page: testCase.page});
      assert.equal(Object.hasOwn(data, "total"), testCase.total !== undefined);
      assert.equal(Reflect.get(data, "total"), testCase.total);
      assert.equal(Reflect.get(data, "hasReachedMax"), testCase.ended);
    }
    results = {total: 0};
    await assert.rejects(plugin.getCloudFavoriteData(), /收藏资料读取不完整/);
  } finally {
    globalThis.bridge = previousBridge;
    globalThis.fetch = previousFetch;
  }
});
