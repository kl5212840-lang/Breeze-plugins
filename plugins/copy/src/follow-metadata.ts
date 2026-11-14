import { nonnegativeInteger, toStringMap } from "./common";
import { PLUGIN_ID } from "./config";
import type { CopyApiResponse, DetailApiResult } from "./types";

type FollowFailureReason =
  | "network"
  | "sourceUnavailable"
  | "invalidResponse"
  | "signInRequired"
  | "notFound";

export class CopyFollowError extends Error {
  constructor(
    readonly reason: FollowFailureReason,
    readonly retryable = true,
    readonly status: number | null = null,
    readonly restricted = false,
  ) {
    super(JSON.stringify({ type: "comic_follow_error", source: PLUGIN_ID, reason, retryable }));
  }
}

export type CopyFollowSummary = {
  chapterCount: number;
  latestChapterTitle: string;
  latestChapterId: string;
};

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function groupRows(results: unknown) {
  const result = toStringMap(results);
  const groups = result.groups ?? toStringMap(result.comic).groups;
  return Array.isArray(groups) ? groups : Object.values(toStringMap(groups));
}

export function copyChapterProbeGroup(results: unknown) {
  const group = groupRows(results)
    .map(toStringMap)
    .find((item) => (nonnegativeInteger(item.count) ?? 0) > 0);
  return text(group?.path_word);
}

export function copyChapterGroupUrl(
  apiBase: string, comicId: string, group: string, offset: number, limit: number,
) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  return new URL(`${apiBase}/comic/${encodeURIComponent(comicId)}/group/${encodeURIComponent(group)}/chapters?${params.toString()}`);
}

export function copyFollowSummary(comicId: string, results: unknown): CopyFollowSummary | null {
  const result = toStringMap(results);
  const comic = toStringMap(result.comic);
  if (text(comic.path_word) !== comicId && text(comic.uuid) !== comicId) return null;

  const rows = groupRows(results);
  if (rows.length === 0) return null;
  const ids = new Set<string>();
  let chapterCount = 0;
  for (const row of rows) {
    const group = toStringMap(row);
    const groupId = text(group.path_word);
    const count = nonnegativeInteger(group.count);
    if (!groupId || ids.has(groupId) || count === null) return null;
    ids.add(groupId);
    chapterCount += count;
  }
  if (!Number.isSafeInteger(chapterCount)) return null;

  const latest = toStringMap(comic.last_chapter);
  const latestChapterTitle = text(latest.name);
  const latestChapterId = text(latest.uuid);
  if (chapterCount === 0) {
    if ((latest.name != null && latest.name !== "") ||
        (latest.uuid != null && latest.uuid !== "") ||
        (comic.last_chapter != null && (
          typeof comic.last_chapter !== "object" || Array.isArray(comic.last_chapter)
        ))) return null;
  } else if (!latestChapterTitle || !latestChapterId) {
    return null;
  }
  return { chapterCount, latestChapterTitle, latestChapterId };
}

type FollowResponse = {
  status: number;
  ok: boolean;
  code: number | null;
  message: string;
  data: Record<string, unknown>;
};

const maxBodySize = 512 * 1024;

export type CopyPublicRequest = {
  headers: Record<string, string>;
  appHeaders?: Record<string, string>;
  isAppGate?: (message: string) => boolean;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  resource?: "chapter";
};

async function requestCopyPublicJson(
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
  request: typeof fetch,
): Promise<FollowResponse> {
  let response: Response;
  let body: string;
  try {
    response = await request(new Request(url, {
      headers, signal, credentials: "omit",
      redirect: headers.authorization === undefined ? "manual" : "error",
    }));
    if (response.redirected || (response.url && new URL(response.url).origin !== url.origin)) {
      throw new CopyFollowError("sourceUnavailable", true, response.status);
    }
    // An unavailable route may return an HTML status page. Keep its status even
    // when we cannot interpret the body.
    body = Number(response.headers.get("content-length")) > maxBodySize ? "" : await response.text();
  } catch (error) {
    if (error instanceof CopyFollowError) throw error;
    throw new CopyFollowError("network");
  }
  if (signal.aborted) throw new CopyFollowError("network");
  let data: Record<string, unknown> = {};
  if (body && body.length <= maxBodySize) {
    try { data = toStringMap(JSON.parse(body)); } catch { /* status still applies */ }
  }
  return {
    status: response.status,
    ok: response.ok,
    code: nonnegativeInteger(data.code),
    message: text(data.message) || text(data.msg),
    data,
  };
}

function followResponseError(
  { status, ok, code, message }: FollowResponse, resource?: CopyPublicRequest["resource"],
): CopyFollowError {
  if (status === 429 || code === 429) return new CopyFollowError("sourceUnavailable", false, 429);
  if ((ok || status === 401 || status === 403) &&
      (code === 401 || code === 403 || (resource === "chapter" && code === 210)) &&
      /请先?登录|請先?登[入錄]|需要登[录入錄]|登录后|登[入錄]後|未登[录入錄]|authentication required|login required|sign[ -]?in required/i.test(message)) {
    return new CopyFollowError("signInRequired", false, status);
  }
  if ((ok || status === 404 || status === 410) && (code === 210 || code === 404 || code === 410) &&
      (/作品.*(?:下架|合併|合并|不存在)|(?:comic|work) (?:was removed|not found)/i.test(message) ||
        (resource === "chapter" &&
          /(?:章节|章節).*(?:下架|刪除|删除|不存在)|chapter (?:was removed|not found)/i.test(message)))) {
    return new CopyFollowError("notFound", false, status);
  }
  if (status === 451 || code === 451 ||
      ((ok || status === 403) && (code === 403 || code === 210) &&
        /無權|无权|地區限制|地区限制|僅限會員|仅限会员|付費後|付费后|permission denied|access restricted|not available in your region/i.test(message))) {
    return new CopyFollowError("sourceUnavailable", false, status, true);
  }
  if (!ok || code !== null && code !== 200) return new CopyFollowError("sourceUnavailable", true, status);
  return new CopyFollowError("invalidResponse", true, status);
}

export async function readCopyPublicApi<T>(url: URL, options: CopyPublicRequest) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (options.signal?.aborted) cancel();
  options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, options.timeoutMs ?? 4500);
  const request = options.fetch ?? globalThis.fetch;
  try {
    let response = await requestCopyPublicJson(url, options.headers, controller.signal, request);
    let usedApp = false;
    if (!response.ok || response.code !== 200) {
      const error = followResponseError(response, options.resource);
      if (!error.retryable || !options.appHeaders || !options.isAppGate?.(response.message)) throw error;
      response = await requestCopyPublicJson(url, options.appHeaders, controller.signal, request);
      if (!response.ok || response.code !== 200) throw followResponseError(response, options.resource);
      usedApp = true;
    }
    return { data: response.data as CopyApiResponse<T>, status: response.status, usedApp };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}

export async function readCopyPublicDetail(
  apiBase: string,
  comicId: string,
  options: CopyPublicRequest,
  { requireSummary = false, strictIdentity = requireSummary }: {
    requireSummary?: boolean;
    strictIdentity?: boolean;
  } = {},
) {
  const url = new URL(`${apiBase}/comic2/${encodeURIComponent(comicId)}?platform=1`);
  const { data: detail, status, usedApp } = await readCopyPublicApi<DetailApiResult>(url, options);
  const comic = toStringMap(detail.results?.comic);
  const slug = text(comic.path_word), uuid = text(comic.uuid);
  const matches = slug === comicId || uuid === comicId;
  // Some older detail responses identify the selected work only by its UUID.
  // A different route must prove the requested identity before supplying it.
  if (!text(comic.name) || (!slug && !uuid) || ((strictIdentity || slug) && !matches)) {
    throw new CopyFollowError("invalidResponse", true, status);
  }
  const summary = copyFollowSummary(comicId, detail.results);
  if (requireSummary && !summary) throw new CopyFollowError("invalidResponse", true, status);
  return { detail, summary, status, usedApp };
}
