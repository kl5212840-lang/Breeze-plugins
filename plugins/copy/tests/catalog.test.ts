import test from "node:test";
import assert from "node:assert/strict";
import {
  mapCopyComicListItem,
  normalizeCopyComicRow,
  resolveCopyDiscoverFilters,
  normalizeCopyThemeOptions,
  copyAuthorReferences,
  normalizeCopySearchScope,
} from "../src/catalog.ts";

const comic = {
  name: "Sample",
  path_word: "sample",
  cover: "https://example.com/cover.jpg",
  author: [{ name: "Author", path_word: "author" }],
  popular: 1200,
  alias: "Other title",
  datetime_updated: "2026-10-26",
  theme: [{ name: "Fantasy", path_word: "qihuan" }],
};

test("flat and wrapped API rows keep the same comic identity", () => {
  assert.deepEqual(normalizeCopyComicRow(comic), comic);
  assert.deepEqual(normalizeCopyComicRow({ comic, name: "chapter label" }), comic);
  assert.deepEqual(normalizeCopyComicRow({ book: comic }), comic);
  assert.equal(normalizeCopyComicRow({ comic: { name: "invalid" } }), null);
  assert.equal(normalizeCopyComicRow(null), null);
});

test("list fields preserve useful metadata without inventing likes or views", () => {
  const item = mapCopyComicListItem(comic)!;
  const values = (type: string) =>
    item.metadata.find((m) => m.type === type)?.value.map((v) => v.name);
  assert.equal(item.id, "sample");
  assert.equal(item.likesCount, 0);
  assert.equal(item.viewsCount, 0);
  assert.equal(item.updatedAt, "2026-10-26");
  assert.deepEqual(values("author"), ["Author"]);
  assert.deepEqual(values("aliases"), ["Other title"]);
  assert.deepEqual(values("popularity"), ["1200"]);
  assert.deepEqual(values("categories"), ["Fantasy"]);
  assert.deepEqual(item.raw, comic);
});

test("zero popularity differs from unknown and absent detail data stays absent", () => {
  const zero = mapCopyComicListItem({ ...comic, popular: 0 })!;
  const unknown = mapCopyComicListItem({ name: "Minimal", path_word: "minimal" })!;
  assert.deepEqual(
    zero.metadata.find((m) => m.type === "popularity")?.value.map((v) => v.name),
    ["0"],
  );
  assert.equal(
    unknown.metadata.some((m) => m.type === "popularity"),
    false,
  );
  assert.equal(unknown.updatedAt, "");
  assert.equal(unknown.subtitle, "");
  assert.equal(
    unknown.metadata.some((m) => m.type === "status" || m.type === "latest"),
    false,
  );
});

test("only verified mobile filters are sent and legacy theme slugs migrate", () => {
  assert.deepEqual(resolveCopyDiscoverFilters({ top: "korea", theme: "C108" }), {
    theme: "comiket108",
    top: "korea",
    ordering: "-datetime_updated",
  });
  assert.deepEqual(
    resolveCopyDiscoverFilters({ top: "finish", region: "0", status: "2", ordering: "-popular" }),
    { theme: "", top: "finish", ordering: "-popular" },
  );
  assert.deepEqual(
    resolveCopyDiscoverFilters({ top: "invalid", region: "99", status: "99", ordering: "bad" }),
    { theme: "", top: "", ordering: "-datetime_updated" },
  );
});

test("author navigation uses returned slugs and never invents one from a name", () => {
  assert.deepEqual(
    copyAuthorReferences({
      ...comic,
      author: [
        { name: "Author", path_word: "author" },
        { name: "Alias", path_word: "author" },
        { name: "No slug" },
      ],
    }),
    [{ name: "Author", pathWord: "author" }],
  );
});

test("theme options preserve server slugs and reject malformed or duplicate entries", () => {
  assert.deepEqual(
    normalizeCopyThemeOptions([
      { name: "C108", path_word: "comiket108" },
      { name: "Fantasy", path_word: "qihuan" },
      { name: "Again", path_word: "qihuan" },
      { name: "Bad", path_word: "../bad" },
    ]),
    [
      { label: "C108", value: "comiket108" },
      { label: "Fantasy", value: "qihuan" },
    ],
  );
});

test("malformed optional arrays do not break an otherwise valid comic", () => {
  const item = mapCopyComicListItem({
    name: "Valid",
    path_word: "valid",
    author: "invalid",
    theme: null,
  })!;
  assert.equal(item.title, "Valid");
  assert.equal(item.subtitle, "");
});

test("unknown or cross-source search scopes fall back instead of reaching the API", () => {
  for (const value of ["", "name", "author", "local"])
    assert.equal(normalizeCopySearchScope(value), value);
  for (const value of ["categories", "random", "tag", null, { q: "author" }, 1])
    assert.equal(normalizeCopySearchScope(value), "");
});
