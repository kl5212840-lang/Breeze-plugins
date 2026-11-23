import { JmRequestError } from "./errors";
import type { RequestPayload } from "./types";

type AccountRequest = (path: string, options: RequestPayload) => Promise<unknown>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function responseData(value: unknown): unknown {
  const envelope = record(value);
  if ("code" in envelope && Number(envelope.code) !== 200) {
    throw new JmRequestError("禁漫账号资料暂时无法读取，请重试");
  }
  return "data" in envelope ? envelope.data : value;
}

export function jmTrackedComicId(value: unknown): string {
  const id = typeof value === "number" || typeof value === "string"
    ? String(value).trim() : "";
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
    throw new JmRequestError("漫画编号无效");
  }
  return id;
}

export function jmPageLengthMatchesTotal(length: number, total: number, page: number) {
  return length === Math.max(0, Math.min(20, total - (page - 1) * 20));
}

export async function readJmSiteFollows(request: AccountRequest, page: number) {
  const raw = await request("/album_tracking", {
    method: "POST", multipartForm: true, formData: { page },
  });
  const data = record(responseData(raw));
  if (!Array.isArray(data.item) || !/^\d+$/.test(String(data.totalCnt ?? ""))) {
    throw new JmRequestError("连载追踪列表暂时无法读取，请重试");
  }
  const total = Number(data.totalCnt);
  if (!Number.isSafeInteger(total) || !jmPageLengthMatchesTotal(data.item.length, total, page) ||
      (data.page != null && Number(data.page) !== page)) {
    throw new JmRequestError("连载追踪列表暂时无法读取，请重试");
  }
  const items = data.item.map((row) => {
    const item = record(row);
    const id = jmTrackedComicId(item.id);
    if (typeof item.name !== "string" || !item.name.trim()) {
      throw new JmRequestError("连载追踪列表暂时无法读取，请重试");
    }
    return { id, title: item.name.trim() };
  });
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new JmRequestError("连载追踪列表暂时无法读取，请重试");
  }
  return { items, page, total, hasMore: page * 20 < total };
}

export async function readJmSiteFollow(request: AccountRequest, id: string): Promise<boolean> {
  const raw = await request("/album_sertracking", { method: "GET", params: { id } });
  const value = responseData(raw);
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  throw new JmRequestError("连载追踪状态暂时无法确认，请重试");
}

export async function setJmSiteFollow(request: AccountRequest, id: string, desired: boolean) {
  if (await readJmSiteFollow(request, id) === desired) return desired;
  try {
    await request("/album_sertracking", { method: "POST", multipartForm: true, formData: { id } });
  } catch (_) {
    // A response may be lost after the server toggles. Never repeat the write.
  }
  if (await readJmSiteFollow(request, id) !== desired) {
    throw new JmRequestError("连载追踪状态暂时无法确认，请重试");
  }
  return desired;
}

export function jmFavoriteTag(value: unknown): string {
  const tag = typeof value === "string" ? value.trim() : "";
  if (!tag || /[,\u0000-\u001f\u007f]/.test(tag)) {
    throw new JmRequestError("收藏标签无效");
  }
  return tag;
}

export async function readJmFavoriteTags(request: AccountRequest): Promise<string[]> {
  const raw = await request("/tags_favorite", { method: "GET" });
  const data = record(responseData(raw));
  if (!Array.isArray(data.list)) {
    throw new JmRequestError("标签收藏暂时无法读取，请重试");
  }
  return [...new Set(data.list.map((item) => jmFavoriteTag(record(item).tag)))];
}

export async function setJmFavoriteTags(
  request: AccountRequest,
  tags: string[],
  desired: boolean,
  tagWasPresent = false,
) {
  let change = tags;
  // The host read this tag under the same account before showing Remove.
  // The site's remove request is explicit, so a second pre-read is redundant.
  if (desired || tags.length !== 1 || !tagWasPresent) {
    const previous = await readJmFavoriteTags(request);
    change = tags.filter((tag) => previous.includes(tag) !== desired);
    if (change.length === 0) return previous;
  }
  try {
    await request("/tags_favorite_update", {
      method: "POST", multipartForm: true,
      formData: { type: desired ? "add" : "remove", tags: change.join(",") },
    });
  } catch (_) {
    // Verify uncertain submissions with a read rather than reapplying them.
  }
  const latest = await readJmFavoriteTags(request);
  if (change.some((tag) => latest.includes(tag) !== desired)) {
    throw new JmRequestError("标签收藏暂时无法确认，请重试");
  }
  return latest;
}
