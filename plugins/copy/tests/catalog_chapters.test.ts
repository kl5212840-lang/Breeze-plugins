import test from "node:test";
import assert from "node:assert/strict";
import { loadCopyChapterPages } from "../src/catalog_chapters.ts";
const chapters = (start: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({
    uuid: `chapter-${start + i}`,
    name: `Chapter ${start + i}`,
  }));

test("all chapter pages are concatenated in server order beyond 500", async () => {
  const requested: number[] = [];
  const result = await loadCopyChapterPages(async (offset, limit) => {
    requested.push(offset);
    assert.equal(limit, 500);
    return { offset, limit, total: 503, list: chapters(offset, offset === 0 ? 500 : 3) };
  });
  assert.deepEqual(requested, [0, 500]);
  assert.equal(result.length, 503);
  assert.equal(result[500].uuid, "chapter-500");
  assert.equal(result[502].uuid, "chapter-502");
});
test("exactly 500 and empty groups do not request an unnecessary page", async () => {
  let calls = 0;
  assert.equal(
    (
      await loadCopyChapterPages(async () => {
        calls++;
        return { offset: 0, limit: 500, total: 500, list: chapters(0, 500) };
      })
    ).length,
    500,
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    await loadCopyChapterPages(async () => ({ offset: 0, limit: 500, total: 0, list: [] })),
    [],
  );
});
test("server limit and consumed rows govern continuation", async () => {
  const offsets: number[] = [];
  const result = await loadCopyChapterPages(async (offset) => {
    offsets.push(offset);
    return { offset, limit: 2, total: 3, list: chapters(offset, offset === 0 ? 2 : 1) };
  });
  assert.deepEqual(offsets, [0, 2]);
  assert.equal(result.length, 3);
});
test("a required later page failure rejects instead of exposing a truncated prefix", async () => {
  await assert.rejects(
    loadCopyChapterPages(async (offset) => {
      if (offset) throw Error("second page offline");
      return { offset, limit: 500, total: 501, list: chapters(0, 500) };
    }),
    /second page offline/,
  );
});
test("repeated pages, early empty pages and invalid chapter identities fail explicitly", async () => {
  await assert.rejects(
    loadCopyChapterPages(async () => ({ limit: 2, total: 4, list: chapters(0, 2) })),
    /重复/,
  );
  await assert.rejects(
    loadCopyChapterPages(async (offset) => ({
      offset,
      limit: 2,
      total: 4,
      list: offset ? [] : chapters(0, 2),
    })),
    /完整/,
  );
  await assert.rejects(
    loadCopyChapterPages(async () => ({ offset: 0, total: 1, list: [{ name: "Missing ID" }] })),
    /标识/,
  );
});
test("incorrect offsets and changing totals never silently reorder a catalogue", async () => {
  await assert.rejects(
    loadCopyChapterPages(async () => ({ offset: 0, limit: 2, total: 4, list: chapters(0, 2) })),
    /位置/,
  );
  await assert.rejects(
    loadCopyChapterPages(async (offset) => ({
      offset,
      limit: 2,
      total: offset ? 5 : 4,
      list: chapters(offset, 2),
    })),
    /变化/,
  );
});

test("unknown totals have a finite page budget", async () => {
  await assert.rejects(
    loadCopyChapterPages(async (offset) => ({ list: chapters(offset, 2) }), {
      pageSize: 2,
      maxPages: 2,
    }),
    /安全范围/,
  );
});

test("malformed chapter payloads are not reported as a successfully empty group", async () => {
  await assert.rejects(
    loadCopyChapterPages(async () => ({ total: 0 })),
    /格式/,
  );
  await assert.rejects(
    loadCopyChapterPages(async () => ({ total: 1, list: chapters(0, 2) })),
    /变化/,
  );
});
