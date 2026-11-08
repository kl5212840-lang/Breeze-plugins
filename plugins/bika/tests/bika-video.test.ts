import assert from "node:assert/strict";
import { test } from "node:test";
import { bikaVideoEntry, createBikaVideoAdapter } from "../src/bika-video";
const movie = "https://adult-movie.bidobido.xyz/",
  anime = "https://adult-animate.bidobido.xyz/";
const row = {
  hid: "QC-BT-123",
  name: "Film",
  pic_b: "https://image.example/cover.jpg",
  pic_s: "https://image.example/portrait.jpg",
  description: "Description",
  tags: ["HD"],
  girls: ["Actor"],
  hits: "12",
};
test("public paging, movie search, exact origins, no anime false search", async () => {
  const urls: string[] = [];
  const adapter = createBikaVideoAdapter(async (u) => {
    urls.push(u);
    return { code: 0, list: [row], productTotal: 42, pageTotal: 3 };
  });
  const page = await adapter.catalog({ home: movie, page: 2, query: "HD & film" });
  assert.equal(page.data.items[0].id, "movie:QC-BT-123");
  assert.equal(page.data.items[0].coverUrl, "https://image.example/portrait.jpg");
  assert.equal(page.data.page, 2);
  assert.equal(page.data.pageCount, 3);
  const url = new URL(urls[0]);
  assert.equal(url.pathname, "/api/list");
  assert.equal(url.searchParams.get("page"), "2");
  assert.equal(url.searchParams.get("q"), "HD & film");
  await assert.rejects(adapter.catalog({ home: anime, query: "anything" }));
  await assert.rejects(
    adapter.catalog({ home: "https://adult-movie.bidobido.xyz.evil/", page: 1 }),
  );
  await assert.rejects(adapter.catalog({ home: movie, page: 0 }));
  assert.equal(bikaVideoEntry(movie)?.payload.capabilities.itemNamespace, "movie");
  assert.equal(bikaVideoEntry(movie + "?token=x"), null);
  assert.equal(bikaVideoEntry(movie + "other"), null);
});
test("snapshot can reopen after restart and rejects mismatched origin and id", async () => {
  const adapter = createBikaVideoAdapter(async () => ({
    code: 0,
    list: [row],
    pageTotal: 1,
    productTotal: 1,
  }));
  const item = (await adapter.catalog({ home: movie })).data.items[0];
  const snapshot = JSON.parse(JSON.stringify(item));
  const restored = await createBikaVideoAdapter().detail({ home: movie, id: item.id, snapshot });
  assert.equal(restored.data.id, item.id);
  const line = (restored.data.lines as any[])[0];
  assert.equal(line.episodes[0].resolveOnPlayback, true);
  assert.equal(
    line.episodes[0].watchUrl,
    "https://adult-movie.bidobido.xyz/videos/QC-BT-123?line=default&episode=QC-BT-123",
  );
  await assert.rejects(adapter.detail({ home: anime, id: item.id, snapshot }));
  await assert.rejects(adapter.detail({ home: movie, id: "movie:../x", snapshot }));
  await assert.rejects(
    adapter.detail({
      home: movie,
      id: item.id,
      snapshot: { ...snapshot, detailUrl: "https://evil.example/videos/QC-BT-123" },
    }),
  );
});
test("playback obtains fresh sources with fallback and rejects bad selections", async () => {
  let seen = "";
  const adapter = createBikaVideoAdapter(async (u) => {
    seen = u;
    return {
      code: 0,
      url_hls_cdn: "",
      url_hls: "http://media.example/a.m3u8",
      url_cdn: "https://media.example/b.mp4",
      url: "https://media.example/b.mp4",
    };
  });
  const snapshot = { id: "movie:QC-BT-123", title: "Film", detailUrl: movie + "videos/QC-BT-123" };
  const out = await adapter.playback({
    home: movie,
    id: snapshot.id,
    snapshot,
    lineId: "default",
    episodeId: "QC-BT-123",
  });
  assert.equal(new URL(seen).pathname, "/api/getVideoUrl");
  assert.deepEqual(
    out.data.sources.map((s) => s.url),
    ["https://media.example/a.m3u8", "https://media.example/b.mp4"],
  );
  await assert.rejects(
    adapter.playback({ home: movie, id: snapshot.id, snapshot, episodeId: "other" }),
  );
});

test("accepts 64 character IDs and rejects longer IDs and malformed totals", async () => {
  const hid = "a".repeat(64);
  const adapter = createBikaVideoAdapter(async () => ({
    code: 0,
    list: [{ ...row, hid }],
    productTotal: 1,
    pageTotal: 1,
  }));
  const item = (await adapter.catalog({ home: movie })).data.items[0];
  assert.equal(item.id, `movie:${hid}`);
  assert.equal(
    (await adapter.detail({ home: movie, id: item.id, snapshot: item })).data.id,
    item.id,
  );
  await assert.rejects(adapter.detail({ home: movie, id: `movie:${hid}x`, snapshot: item }));
  const invalid = createBikaVideoAdapter(async () => ({
    code: 0,
    list: [],
    productTotal: null,
    pageTotal: 1,
  }));
  await assert.rejects(invalid.catalog({ home: movie }));
});

test("animate preserves full horizontal cover through snapshot while movie keeps defaults", async () => {
  const adapter = createBikaVideoAdapter(async () => ({
    code: 0,
    list: [row],
    productTotal: 1,
    pageTotal: 1,
  }));
  const animateItem = (await adapter.catalog({ home: anime })).data.items[0];
  assert.equal(animateItem.containCover, true);
  assert.equal(animateItem.coverUrl, "https://image.example/cover.jpg");
  const detail = await adapter.detail({ home: anime, id: animateItem.id, snapshot: animateItem });
  assert.equal(detail.data.containCover, true);
  assert.equal(bikaVideoEntry(anime)?.payload.capabilities.posterAspectRatio, 4 / 3);
  const movieItem = (await adapter.catalog({ home: movie })).data.items[0];
  assert.equal(movieItem.containCover, undefined);
  assert.equal(bikaVideoEntry(movie)?.payload.capabilities.posterAspectRatio, undefined);
});
