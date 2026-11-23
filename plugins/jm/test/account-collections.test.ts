import assert from "node:assert/strict";
import { test } from "node:test";
import { readJmSiteFollows, setJmFavoriteTags, setJmSiteFollow } from "../src/account-collections";

test("site follow changes once and accepts confirmed state after a lost response", async () => {
  let followed = true;
  const requests: string[] = [];
  const request: Parameters<typeof setJmSiteFollow>[0] = async (path, options) => {
    assert.equal(path, "/album_sertracking");
    requests.push(options.method ?? "");
    if (options.method === "POST") {
      assert.deepEqual(options.formData, { id: "123" });
      assert.equal(options.multipartForm, true);
      followed = !followed;
      throw new Error("lost response");
    }
    assert.deepEqual(options.params, { id: "123" });
    return { code: 200, data: followed };
  };

  assert.equal(await setJmSiteFollow(request, "123", false), false);
  assert.deepEqual(requests, ["GET", "POST", "GET"]);
  assert.equal(await setJmSiteFollow(request, "123", false), false);
  assert.deepEqual(requests, ["GET", "POST", "GET", "GET"]);
});

test("site follow fails on mismatched readback without replaying the toggle", async () => {
  let writes = 0;
  const request: Parameters<typeof setJmSiteFollow>[0] = async (_, options) => {
    if (options.method === "POST") writes++;
    return false;
  };
  await assert.rejects(setJmSiteFollow(request, "456", true), /暂时无法确认/);
  assert.equal(writes, 1);
});

test("tracked album paging requires a valid server snapshot", async () => {
  const got = await readJmSiteFollows(async (path, options) => {
    assert.equal(path, "/album_tracking");
    assert.deepEqual(options.formData, { page: 2 });
    assert.equal(options.multipartForm, true);
    return { item: [{ id: 123, name: "漫画" }], totalCnt: "21" };
  }, 2);
  assert.deepEqual(got, {
    items: [{ id: "123", title: "漫画" }], page: 2, total: 21, hasMore: false,
  });
  await assert.rejects(readJmSiteFollows(async () => ({ item: [], totalCnt: 21 }), 2), /暂时无法读取/);
  await assert.rejects(readJmSiteFollows(async () => ({
    item: [{ id: 123, name: "漫画" }], totalCnt: 21,
  }), 1), /暂时无法读取/);
});

test("tag changes submit only affected tags and require readback", async () => {
  let tags = ["其他", "已收藏"];
  let writes = 0;
  const request: Parameters<typeof setJmFavoriteTags>[0] = async (path, options) => {
    if (options.method === "POST") {
      writes++;
      assert.equal(path, "/tags_favorite_update");
      assert.deepEqual(options.formData, { type: "add", tags: "标签甲,标签乙" });
      assert.equal(options.multipartForm, true);
      tags = [...tags, "标签甲", "标签乙"];
    } else {
      assert.equal(path, "/tags_favorite");
    }
    return { list: tags.map((tag) => ({ tag })) };
  };
  assert.deepEqual(await setJmFavoriteTags(request, ["已收藏", "标签甲", "标签乙"], true), tags);
  assert.deepEqual(await setJmFavoriteTags(request, ["已收藏", "标签甲", "标签乙"], true), tags);
  assert.equal(writes, 1);
});

test("visible saved tag removal writes once and still requires same-account readback", async () => {
  const calls: string[] = [];
  const request: Parameters<typeof setJmFavoriteTags>[0] = async (path, options) => {
    calls.push(options.method ?? "");
    if (path === "/tags_favorite_update") {
      assert.equal(options.multipartForm, true);
      assert.deepEqual(options.formData, { type: "remove", tags: "目标" });
      throw new Error("lost response");
    }
    assert.equal(path, "/tags_favorite");
    return { list: [{ tag: "其他" }] };
  };
  assert.deepEqual(await setJmFavoriteTags(request, ["目标"], false, true), ["其他"]);
  assert.deepEqual(calls, ["POST", "GET"]);
});
