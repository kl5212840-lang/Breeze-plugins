import { createBasicMetadata, toStringMap } from "./common";
import { PLUGIN_ID } from "./config";
import type { SearchApiComic } from "./types";

export type CopyFilterOption = { label: string; value: string };
export const COPY_ORDER_OPTIONS: CopyFilterOption[] = [
  { label: "更新最新", value: "-datetime_updated" },
  { label: "更新最早", value: "datetime_updated" },
  { label: "热度最高", value: "-popular" },
  { label: "热度最低", value: "popular" },
];

export function normalizeCopySearchScope(value: unknown) {
  const scope = String(value ?? "").trim();
  return ["", "name", "author", "local"].includes(scope) ? scope : "";
}

/** /update/newest and /recs wrap comics; /comics returns flat comic records. */
export function normalizeCopyComicRow(value: unknown): SearchApiComic | null {
  const row = toStringMap(value);
  for (const candidate of [row, toStringMap(row.comic), toStringMap(row.book)]) {
    if (String(candidate.path_word ?? "").trim()) return candidate as SearchApiComic;
  }
  return null;
}

export function mapCopyComicListItem(value: unknown) {
  const item = normalizeCopyComicRow(value);
  if (!item) return null;
  const comicId = String(item.path_word).trim();
  const authorNames = [
    ...new Set(
      (Array.isArray(item.author) ? item.author : [])
        .map((a) => String(a?.name ?? "").trim())
        .filter(Boolean),
    ),
  ];
  const themes = [
    ...new Set(
      (Array.isArray(item.theme) ? item.theme : [])
        .map((t) => String(t?.name ?? "").trim())
        .filter(Boolean),
    ),
  ];
  const aliases = [
    ...new Set(
      (Array.isArray(item.alias) ? item.alias : [item.alias])
        .map((v) => String(v ?? "").trim())
        .filter(Boolean),
    ),
  ];
  const statusText =
    String(item.status?.display ?? "").trim() || String(item.status?.value ?? "").trim();
  const latest = String(item.last_chapter_name ?? "").trim();
  const path = `comic/${comicId}/cover.jpg`;
  const popularity =
    item.popular == null || String(item.popular).trim() === "" ? null : Number(item.popular);
  return {
    source: PLUGIN_ID,
    id: comicId,
    title: String(item.name ?? "").trim() || `漫画 ${comicId}`,
    subtitle: [authorNames.join(" / "), statusText, latest].filter(Boolean).join(" · "),
    finished: String(item.status?.value ?? "") === "1" || /完[结結]/.test(statusText),
    // Popularity is neither a like count nor a measured view count.
    likesCount: 0,
    viewsCount: 0,
    updatedAt: String(item.datetime_updated ?? "").trim(),
    cover: {
      id: comicId,
      url: String(item.cover ?? "").trim(),
      path,
      name: `${comicId}.jpg`,
      extern: { path },
    },
    metadata: [
      ...(authorNames.length ? [createBasicMetadata("author", "作者", authorNames)] : []),
      ...(themes.length ? [createBasicMetadata("categories", "题材", themes)] : []),
      ...(aliases.length ? [createBasicMetadata("aliases", "别名", aliases)] : []),
      ...(popularity !== null && Number.isFinite(popularity) && popularity >= 0
        ? [createBasicMetadata("popularity", "热度", [String(popularity)])]
        : []),
      ...(statusText ? [createBasicMetadata("status", "状态", [statusText])] : []),
      ...(latest ? [createBasicMetadata("latest", "更新", [latest])] : []),
    ],
    raw: item,
    extern: { comicId, pathWord: comicId },
  };
}

export function resolveCopyDiscoverFilters(input: unknown) {
  const value = toStringMap(input);
  const top = String(value.top ?? "").trim();
  let theme = String(value.theme ?? "").trim();
  if (/^C\d+$/i.test(theme)) theme = `comiket${theme.slice(1)}`;
  theme =
    ({ TL: "teenslove", AA: "aa", FATE: "fate", LoveLive: "lovelive" } as Record<string, string>)[
      theme
    ] ?? theme;
  if (!/^[a-zA-Z0-9_-]*$/.test(theme)) theme = "";
  const ordering = String(value.ordering ?? "").trim();
  return {
    theme,
    top: ["", "japan", "korea", "west", "finish"].includes(top) ? top : "",
    ordering: COPY_ORDER_OPTIONS.some((o) => o.value === ordering) ? ordering : "-datetime_updated",
  };
}

export function copyAuthorReferences(input: unknown) {
  const item = normalizeCopyComicRow(input);
  const seen = new Set<string>();
  return (Array.isArray(item?.author) ? item.author : []).flatMap((author) => {
    const name = String(author?.name ?? "").trim();
    const pathWord = String(author?.path_word ?? "").trim();
    if (!name || !pathWord || seen.has(pathWord)) return [];
    seen.add(pathWord);
    return [{ name, pathWord }];
  });
}

export function normalizeCopyThemeOptions(value: unknown): CopyFilterOption[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((raw) => {
    const row = toStringMap(raw);
    const label = String(row.name ?? row.label ?? "").trim();
    const slug = String(row.path_word ?? row.value ?? "").trim();
    if (!label || !/^[a-zA-Z0-9_-]+$/.test(slug) || seen.has(slug)) return [];
    seen.add(slug);
    return [{ label, value: slug }];
  });
}
