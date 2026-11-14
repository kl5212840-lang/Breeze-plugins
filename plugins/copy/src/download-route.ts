import { toStringMap } from "./common";
import { CopyFollowError, readCopyPublicApi, type CopyPublicRequest } from "./follow-metadata";
import type { ChapterContentResult } from "./types";

export const copyDownloadRouteCandidateLimit = 3;
export const copyDownloadRouteBudgetMs = 12_000;
export const copyDownloadRouteCandidateBudgetMs = 4_000;
export const copyDownloadImageTimeoutMs = 12_000;
export const copyImageAccept = "image/avif,image/webp,image/apng,image/*,*/*;q=0.8";

/** Only the known public image CDN is eligible for a host-managed transfer. */
export function copyBackgroundDownload(url: string) {
  const target = new URL(url); // The chapter resolver already validated it.
  if (
    target.protocol !== "https:" ||
    !target.hostname.endsWith(".mangafunb.fun") ||
    target.href !== url ||
    target.port ||
    target.username ||
    target.password ||
    /[?#]/.test(url)
  ) return undefined;
  return {
    version: 1,
    credentialFree: true,
    redirectPolicy: "same-url",
    headers: { Accept: copyImageAccept },
  } as const;
}

export function copyDownloadRouteKey(apiBase: string) {
  return `copy:${new URL(apiBase).hostname}`;
}

export function readCopyDownloadExclusions(excluded: unknown): ReadonlySet<string> {
  if (
    !Array.isArray(excluded) ||
    excluded.length > copyDownloadRouteCandidateLimit ||
    excluded.some((value) => typeof value !== "string" || !/^[a-zA-Z0-9._|:-]{1,180}$/.test(value))
  ) {
    throw new CopyFollowError("invalidResponse", false);
  }
  return new Set<string>(excluded);
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function safeImageUrl(value: unknown) {
  try {
    const original = text(value);
    const url = new URL(original);
    if (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.hostname &&
      !url.username &&
      !url.password
    )
      return original;
  } catch {
    // The entire manifest is unusable if any page cannot be requested safely.
  }
  return "";
}

function exactChapter(comicId: string, chapterId: string, data: ChapterContentResult | undefined) {
  const result = toStringMap(data);
  const comic = toStringMap(result.comic);
  const chapter = toStringMap(result.chapter);
  const slug = text(comic.path_word),
    workId = text(comic.uuid);
  const chapterSlug = text(chapter.comic_path_word),
    chapterWorkId = text(chapter.comic_id);
  // The requested alias must be confirmed by the chapter or by both parts of
  // the response agreeing on the other work identifier.
  const workMatches =
    chapterSlug === comicId ||
    chapterWorkId === comicId ||
    (slug === comicId && chapterWorkId !== "" && chapterWorkId === workId) ||
    (workId === comicId && chapterSlug !== "" && chapterSlug === slug);
  if (
    text(chapter.uuid) !== chapterId ||
    !workMatches ||
    (slug && chapterSlug && slug !== chapterSlug) ||
    (workId && chapterWorkId && workId !== chapterWorkId)
  ) {
    throw new CopyFollowError("invalidResponse");
  }

  const contents = Array.isArray(chapter.contents) ? chapter.contents : [];
  const urls = contents.map((item) => safeImageUrl(toStringMap(item).url));
  if (!urls.length || urls.some((url) => !url)) throw new CopyFollowError("invalidResponse");

  const words = chapter.words;
  let orderedUrls = urls;
  if (Array.isArray(words) && words.length === urls.length) {
    const order = words.map((word) =>
      typeof word === "number" || (typeof word === "string" && word.trim()) ? Number(word) : NaN,
    );
    if (order.some((word) => !Number.isFinite(word))) {
      throw new CopyFollowError("invalidResponse");
    }
    orderedUrls = urls
      .map((url, index) => ({ url, order: order[index]!, index }))
      .sort((left, right) => left.order - right.order || left.index - right.index)
      .map(({ url }) => url);
  }
  return { comicTitle: text(comic.name), chapterName: text(chapter.name), imageUrls: orderedUrls };
}

/** Resolve the actual chapter, bypassing catalog and chapter caches. */
export async function readCopyDownloadChapter(
  apiBase: string,
  comicId: string,
  chapterId: string,
  request: CopyPublicRequest,
  deadline: number,
  loadTrustedToken?: () => Promise<string>,
) {
  const urlFor = (chapterPath: string) =>
    new URL(
      `${apiBase}/comic/${encodeURIComponent(comicId)}/${chapterPath}/${encodeURIComponent(chapterId)}?platform=1`,
    );
  const fetchChapter = async (path: string, options: CopyPublicRequest) => {
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw new CopyFollowError("network");
    const { data } = await readCopyPublicApi<ChapterContentResult>(urlFor(path), {
      ...options,
      resource: "chapter",
      timeoutMs,
    });
    if (Date.now() >= deadline) throw new CopyFollowError("network");
    return exactChapter(comicId, chapterId, data.results);
  };
  let path = "chapter2";
  try {
    try {
      return await fetchChapter(path, request);
    } catch (error) {
      // HTTP 404 may be the older endpoint spelling. A definitive business
      // response (e.g. explicitly removed) keeps its original meaning.
      if (!(error instanceof CopyFollowError) || !error.retryable || error.status !== 404)
        throw error;
      path = "chapter";
      return await fetchChapter(path, request);
    }
  } catch (error) {
    if (
      !(error instanceof CopyFollowError) ||
      error.reason !== "signInRequired" ||
      !loadTrustedToken
    )
      throw error;
    const token = await loadTrustedToken();
    if (!token) throw error;
    const authorization = `Token ${token}`;
    return fetchChapter(path, {
      ...request,
      headers: { ...request.headers, authorization },
      ...(request.appHeaders ? { appHeaders: { ...request.appHeaders, authorization } } : {}),
    });
  }
}
