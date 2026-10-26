import { toStringMap } from "./common";
import type { ChapterApiData, ChapterApiItem } from "./types";

function integer(value: unknown): number | null {
  if (value == null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

/** Collect a complete group before exposing it or writing the chapter cache. */
export async function loadCopyChapterPages(
  fetchPage: (offset: number, limit: number) => Promise<unknown>,
  { pageSize = 500, maxPages = 200 } = {},
): Promise<ChapterApiItem[]> {
  const result: ChapterApiItem[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let expectedTotal: number | null = null;
  for (let page = 0; page < maxPages; page++) {
    const data = toStringMap(await fetchPage(offset, pageSize)) as ChapterApiData;
    const actualOffset = integer(data.offset);
    if (actualOffset !== null && actualOffset !== offset) {
      throw new Error("章节分页位置异常，请重试");
    }
    const total = integer(data.total);
    if (total !== null) {
      if (expectedTotal !== null && total !== expectedTotal) {
        throw new Error("章节目录已变化，请重试");
      }
      expectedTotal = total;
    }
    if (!Array.isArray(data.list)) throw new Error("章节列表格式异常，请重试");
    const rows = data.list;
    for (const chapter of rows) {
      const id = String(chapter?.uuid ?? "").trim();
      if (!id) throw new Error("章节标识缺失，请重试");
      if (seen.has(id)) throw new Error("章节分页重复，请重试");
      seen.add(id);
      result.push(chapter);
    }
    const next = offset + rows.length;
    if (expectedTotal !== null) {
      if (next > expectedTotal) throw new Error("章节目录已变化，请重试");
      if (next === expectedTotal) return result;
      if (!rows.length) throw new Error("章节目录尚未完整加载，请重试");
    } else {
      const reportedLimit = integer(data.limit);
      const limit = reportedLimit !== null && reportedLimit > 0 ? reportedLimit : pageSize;
      if (rows.length < limit) return result;
    }
    if (next <= offset) throw new Error("章节分页没有进展，请重试");
    offset = next;
  }
  throw new Error("章节分页超出安全范围，请重试");
}
