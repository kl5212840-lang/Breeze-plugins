import axios from "axios";
import type {
  AdvancedSearchContract,
  CapabilitiesBundleContract,
  ComicDetailContract,
  ComicDetailData,
  ComicDetailNormal,
  ComicListSceneBundleContract,
  CommentFeedContract,
  CommentMutationContract,
  FilterBundleContract,
  FunctionPageContract,
  InfoContract,
  ListFavoriteFoldersResult,
  RecommendItem,
  SettingsBundleContract,
  ToggleFavoriteResult,
  ToggleLikeResult,
  UserInfoBundleContract,
} from "breeze-plugin-kit";
import {
  hostRuntime,
  opencc,
  pluginConfig,
  runtime,
} from "breeze-plugin-kit";
import { buildUnauthorizedError, createJmClient, JmLikeUnconfirmedError, recordJmLikeStage } from "./client";
import { optionalJmCount, unwrapJmAlbumPayload } from "./codec";
import {
  downloadRouteExclusions,
  jmBackgroundDownload,
  jmDownloadBase,
  jmDownloadPair,
  jmPublicImageHeaders,
  lockedDownloadImage,
  lockedRouteRequestOptions,
  readJmDownloadAlbum,
  readJmDownloadChapter,
} from "./download-route";
import { parseJmNotifications } from "./notifications";
import { decodePublicJmData, probeJmAlbum, probeJmCatalog, probeJmCover, probeJmRankingCatalog } from "./line-speed";
import { Config } from "./constants";
import { isTransientError, JmFollowError, JmRequestError, retryTransient, toFriendlyError } from "./errors";
import { buildPluginInfo } from "./get-info";
import { buildRequestConfig } from "./request-config";
import {
  getCachedResponse,
  getEndpointSpeedCache,
  getJwtToken,
  getRuntimeEndpointCache,
  setEndpointSpeedCache,
  setRuntimeEndpointCache,
  assertCurrentSession,
  clearSession,
  currentSessionRevision,
  saveSessionValues,
  waitForSessionWrites,
} from "./state";
import type { EndpointSpeedCache, EndpointSpeedRecord } from "./state";
import type { JmLikeDiagnostic, RequestPayload } from "./types";
import { getHost, md5Hex } from "./utils";
import { notifyAutoCheckinCompleted } from "../../shared/auto-checkin-notice";

const JM_PLUGIN_ID = "6886291b-f524-441c-844b-c2efae9899a9";

const jmClient = createJmClient();

// Only explicit server check-in evidence creates this account-scoped receipt.
function checkinDate() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function readCheckin(uid: unknown, revision: number) {
  const receipt = await loadPluginSetting("auth.checkin", {});
  assertCurrentSession(revision);
  const accountId = String(uid ?? "").trim();
  const checkedInDate = accountId && receipt?.accountId === accountId &&
    receipt?.checkedInDate === checkinDate() ? receipt.checkedInDate : null;
  return { accountId, checkedIn: checkedInDate ? true : null, checkedInDate,
    checkinProof: checkedInDate ? {
      source: "savedReceipt", date: checkedInDate, verifiedThisRequest: false,
      evidenceSource: receipt.evidenceSource ?? null,
      confirmedAt: typeof receipt.confirmedAt === "string" ? receipt.confirmedAt : null,
    } : null };
}

// GET /daily is the current activity's account-specific calendar. Only its
// explicit boolean for today's cell establishes a receipt; progress, missing
// cells, web-only error strings and failed requests are not evidence.
async function verifyCheckinCalendar(uid: unknown, revision: number) {
  const requestDate = checkinDate();
  const result = (status: "confirmed" | "notSigned" | "unknown" | "failed", signed: boolean | null = null) => ({
    source: "serverCalendar", date: requestDate, checkedAt: new Date().toISOString(), status, signed,
  });
  try {
    const response = await jmRequest({
      path: `${Config.baseUrl}/daily`,
      method: "GET",
      params: { user_id: uid },
      cache: false,
    }, revision);
    assertCurrentSession(revision);
    const daily = response?.data ?? response;
    if (response?.status === false || daily?.status === false ||
        daily?.ok === false || daily?.success === false ||
        (response?.code !== undefined && Number(response.code) !== 200) ||
        (daily?.code !== undefined && Number(daily.code) !== 200) ||
        !daily?.daily_id || !Array.isArray(daily.record) ||
        checkinDate() !== requestDate) return result("unknown");
    const today = requestDate.slice(-2);
    const cells = daily.record.flatMap((week: unknown) => Array.isArray(week) ? week : [])
      .filter((cell: any) => cell && String(cell.date).padStart(2, "0") === today);
    if (cells.length !== 1 || typeof cells[0].signed !== "boolean") return result("unknown");
    return result(cells[0].signed ? "confirmed" : "notSigned", cells[0].signed);
  } catch (_) {
    assertCurrentSession(revision);
    // Profile data remains usable when only the read-only calendar fails.
    console.warn("[jm.checkin] calendar unavailable");
    return result("failed");
  }
}

async function refreshCheckin(uid: unknown, revision: number) {
  const known = await readCheckin(uid, revision);
  if (known.checkedIn === true || !known.accountId) return known;
  const verification = await verifyCheckinCalendar(uid, revision);
  if (verification.status === "confirmed") {
    await saveSessionValues(revision, { "auth.checkin": {
      accountId: known.accountId, checkedInDate: verification.date,
      evidenceSource: "serverCalendar", confirmedAt: verification.checkedAt,
    } });
  }
  return { ...(await readCheckin(uid, revision)), checkinVerification: verification };
}

// Explicit recheck is read-only even when a current receipt already exists.
// A failed or conflicting read does not overwrite a previously confirmed receipt.
async function getCheckinStatus() {
  const revision = currentSessionRevision();
  await waitForSessionWrites(revision);
  const user = await loadPluginSetting("auth.userInfo", {});
  assertCurrentSession(revision);
  const known = await readCheckin(user?.uid, revision);
  if (!known.accountId) throw buildUnauthorizedError("请先登录禁漫账号");
  let verification = await verifyCheckinCalendar(known.accountId, revision);
  const current = await readCheckin(known.accountId, revision);
  if (verification.date !== checkinDate()) {
    verification = { ...verification, status: "unknown", signed: null };
  }
  return { source: JM_PLUGIN_ID, data: {
    ...current, verification,
    ...(verification.status === "confirmed" ? {
      checkedIn: true, checkedInDate: verification.date,
      checkinProof: { source: "serverCalendar", evidenceSource: "serverCalendar", date: verification.date,
        confirmedAt: verification.checkedAt, verifiedThisRequest: true },
    } : {}),
  } };
}

type JmCheckinOutcome = "failed" | "alreadyCheckedIn" | { accountId: string; date: string };
const pendingCheckins = new Map<number, {
  task: Promise<JmCheckinOutcome>;
  manualRequested: boolean;
}>();

type FetchImageBytesParams = {
  url?: string;
  timeoutMs?: number;
  taskGroupKey?: string;
  extern?: Record<string, unknown>;
};

const IMAGE_BASE_FAILURE_LIMIT = 3;
const imageBaseFailures = new Map<string, number>();

let pinnedImageBaseCache = { value: "", at: 0 };
let pinnedApiBaseCache = { value: "", at: 0 };

async function getPinnedImageBase(): Promise<string> {
  if (Date.now() - pinnedImageBaseCache.at < 10_000) {
    return pinnedImageBaseCache.value;
  }
  let value = "";
  try {
    value = String(await loadPluginSetting("network.imageBase", "")).trim();
  } catch {
    value = "";
  }
  pinnedImageBaseCache = { value, at: Date.now() };
  return value;
}

async function getPinnedApiBase(): Promise<string> {
  if (Date.now() - pinnedApiBaseCache.at < 10_000) {
    return pinnedApiBaseCache.value;
  }
  let value = "";
  try {
    value = String(await loadPluginSetting("network.apiBase", "")).trim();
  } catch {
    value = "";
  }
  pinnedApiBaseCache = { value, at: Date.now() };
  return value;
}

function imageBaseOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "";
  }
}

/** 只替换 host，保留路径与查询串 */
function swapImageBase(targetUrl: string, base: string): string {
  const normalized = Config.normalizeBaseUrl(base);
  if (!normalized) return targetUrl;
  try {
    const parsed = new URL(targetUrl);
    const next = new URL(normalized);
    parsed.protocol = next.protocol;
    parsed.host = next.host;
    return parsed.toString();
  } catch {
    const marker = targetUrl.indexOf("//");
    const pathStart = marker >= 0 ? targetUrl.indexOf("/", marker + 2) : -1;
    const path = pathStart >= 0 ? targetUrl.slice(pathStart) : "";
    return `${normalized}${path}`;
  }
}

function noteImageBaseSuccess(url: string) {
  const base = imageBaseOf(url);
  if (!base) return;
  imageBaseFailures.set(base, 0);
  const index = Config.imagesUrls.indexOf(base);
  if (index >= 0 &&
      (imageBaseFailures.get(Config.imagesUrl) ?? 0) >= IMAGE_BASE_FAILURE_LIMIT) {
    Config.imagesUrlIndex = index;
  }
}

function noteImageBaseFailure(url: string) {
  const base = imageBaseOf(url);
  if (!base) return;
  imageBaseFailures.set(base, (imageBaseFailures.get(base) ?? 0) + 1);
}

/** 新请求优先使用当前线路，旧封面地址仍可作为候选。 */
async function buildImageAttempts(targetUrl: string): Promise<string[]> {
  const pinned = await getPinnedImageBase();
  const candidates = (
    Config.imagesUrls.length
      ? Config.imagesUrls
      : Config.buildImageCandidates()
  )
    .map((item) => Config.normalizeBaseUrl(item))
    .filter(Boolean);

  const order: string[] = [];
  const push = (base: string) => {
    const normalized = Config.normalizeBaseUrl(base);
    if (normalized && !order.includes(normalized)) order.push(normalized);
  };

  push(pinned);
  push(Config.imagesUrl);
  push(imageBaseOf(targetUrl));
  for (const base of candidates) push(base);

  const healthy = order.filter(
    (base) => (imageBaseFailures.get(base) ?? 0) < IMAGE_BASE_FAILURE_LIMIT,
  );
  const finalOrder = healthy.length ? healthy : order;

  return finalOrder.map((base) => swapImageBase(targetUrl, base));
}

async function fetchImageBytes({
  url = "",
  timeoutMs = 30000,
  taskGroupKey = "",
  extern,
}: FetchImageBytesParams = {}): Promise<Uint8Array> {
  const targetUrl = String(url).trim();
  if (!targetUrl) throw new Error("url 不能为空");

  if (taskGroupKey && (await runtime.isTaskGroupCancelled(taskGroupKey))) {
    console.log("[fetchImageBytes] 任务已取消，跳过下载");
    return new Uint8Array(new ArrayBuffer(0));
  }

  const locked = lockedDownloadImage(targetUrl, extern);
  const requestedTimeout = Math.max(0, Number(timeoutMs)) || 30000;
  const timeout = locked ? Math.min(requestedTimeout, 12000) : requestedTimeout;
  const attempts = locked ? [targetUrl] : await buildImageAttempts(targetUrl);
  let lastError: unknown = null;

  for (const attempt of attempts) {
    const host = getHost(attempt);
    try {
      const response = await axios.get(attempt, {
        ...(locked ? lockedRouteRequestOptions : {}),
        headers: {
          Host: host,
          Referer: locked?.referer ?? (Config.baseUrl || Config.JM_FALLBACK_API_BASE),
          ...jmPublicImageHeaders,
          "x-rquickjs-host-offload-binary-v1": "1",
        },
        timeout,
        responseType: "arraybuffer",
        validateStatus: () => true,
      });

      const status = Number(response.status || 0);
      if (locked ? status !== 200 : status < 200 || status >= 300) {
        throw new Error(`图片下载失败 (${status || "unknown"})`);
      }

      const bytes = new Uint8Array(response.data as ArrayBufferLike);
      if (!bytes.length) {
        throw new Error("图片数据为空");
      }

      if (!locked) noteImageBaseSuccess(attempt);
      return bytes;
    } catch (error) {
      lastError = error;
      if (!locked) {
        noteImageBaseFailure(attempt);
        console.warn("[jm.image] current route failed; trying next route");
      }
    }
  }

  throw toFriendlyError(
    lastError ?? new Error(`图片下载失败，已尝试 ${attempts.length} 条线路`),
  );
}

async function jmRequest(
  input: RequestPayload,
  revision = currentSessionRevision(),
  requestJwt?: string,
) {
  await waitForSessionWrites(revision);
  const resolvedJwtToken =
    input.useJwt === false
      ? ""
      : requestJwt ?? (
        String(input.jwtToken ?? "").trim() ||
        String(await loadPluginSetting("auth.jwt", "")).trim()
      );
  assertCurrentSession(revision);
  const { config, cacheEnabled } = await buildRequestConfig({
    ...input,
    jwtToken: resolvedJwtToken,
  }, revision, requestJwt);

  try {
    const response = await jmClient.request(config);
    assertCurrentSession(revision);
    return response.data;
  } catch (err) {
    assertCurrentSession(revision);
    if (
      cacheEnabled &&
      String(config.method || "GET").toUpperCase() === "GET"
    ) {
      const cached = await getCachedResponse({
        method: String(config.method || "GET").toUpperCase(),
        url: String(config.url || ""),
        params: config.params as Record<string, unknown> | undefined,
        data: config.data,
      });
      assertCurrentSession(revision);
      if (cached !== null && cached !== undefined) {
        return cached;
      }
    }
    throw toFriendlyError(err);
  }
}

type ComicDetailPayload = {
  comicId?: string;
  extern?: Record<string, unknown>;
  path?: string;
  useJwt?: boolean;
  jwtToken?: string;
};

type JmSearchPayload = {
  keyword?: string;
  page?: number;
  extern?: Record<string, unknown>;
  path?: string;
  useJwt?: boolean;
  jwtToken?: string;
};

type JmChapterPayload = {
  comicId?: string;
  chapterId?: string;
  extern?: Record<string, unknown>;
  path?: string;
  useJwt?: boolean;
  jwtToken?: string;
  downloadRoute?: unknown;
};

type JmReadSnapshotPayload = {
  comicId?: string;
  chapterId?: string;
  extern?: Record<string, unknown>;
};

type JmHomePayload = {
  refresh?: boolean;
  page?: number;
  extern?: Record<string, unknown>;
  path?: string;
  useJwt?: boolean;
  jwtToken?: string;
};

type JmRankingPayload = {
  refresh?: boolean;
  page?: number;
  extern?: Record<string, unknown>;
  path?: string;
  useJwt?: boolean;
  jwtToken?: string;
};

type JmPromoteListPayload = {
  refresh?: boolean;
  id?: number;
  page?: number;
  extern?: Record<string, unknown>;
  path?: string;
  useJwt?: boolean;
  jwtToken?: string;
};

type JmWeekRankingPayload = {
  refresh?: boolean;
  date?: number;
  type?: string;
  page?: number;
  extern?: Record<string, unknown>;
  path?: string;
  useJwt?: boolean;
  jwtToken?: string;
};

type JmCloudFavoritePayload = {
  page?: number;
  folderId?: string;
  order?: string;
  extern?: Record<string, unknown>;
  path?: string;
  useJwt?: boolean;
  jwtToken?: string;
};

type JmLikePayload = {
  comicId?: string;
  currentLiked?: boolean;
  previousTotalLikes?: number;
  includeLikeDiagnostic?: boolean;
  extern?: Record<string, unknown>;
  path?: string;
  useJwt?: boolean;
  jwtToken?: string;
};

type JmToggleFavoritePayload = {
  comicId?: string;
  currentFavorite?: boolean;
  extern?: Record<string, unknown>;
  path?: string;
  useJwt?: boolean;
  jwtToken?: string;
};

type JmFavoriteFolderPayload = {
  comicId?: string;
  folderId?: string;
  folderName?: string;
  extern?: Record<string, unknown>;
  path?: string;
  useJwt?: boolean;
  jwtToken?: string;
};

type JmCommentFeedPayload = {
  comicId?: string;
  page?: number;
  extern?: Record<string, unknown>;
  path?: string;
  useJwt?: boolean;
  jwtToken?: string;
};

type JmCommentPostPayload = {
  comicId?: string;
  content?: string;
  extern?: Record<string, unknown>;
  path?: string;
  useJwt?: boolean;
  jwtToken?: string;
};

type JmCommentReplyPayload = JmCommentPostPayload & {
  commentId?: string;
};

type RankingFilterOption = {
  label: string;
  value: string;
  result: Record<string, unknown>;
  children?: RankingFilterOption[];
};

type JmLoginPayload = {
  account?: string;
  password?: string;
  extern?: Record<string, unknown>;
  path?: string;
  useJwt?: boolean;
  jwtToken?: string;
};

const JM_SEARCH_CATEGORY_OPTIONS = [
  { label: "同人", value: "同人" },
  { label: "单本", value: "单本" },
  { label: "短篇", value: "短篇" },
  { label: "其他类", value: "其他类" },
  { label: "韩漫", value: "韩漫" },
  { label: "English Manga", value: "English Manga" },
];

function toNum(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toStrList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => String(item ?? ""))
    .filter((item) => item.trim().length > 0);
}

function toBool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }
  return fallback;
}

function stripHtmlTags(value: unknown): string {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatDisplayTime(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return "";
  }

  const normalized = raw.includes("T")
    ? raw
    : raw.replace(" ", "T").replace(/\//g, "-");
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return raw;
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function buildMetadata(type: string, name: string, value: unknown) {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  const normalized = list
    .map((item) => String(item ?? "").trim())
    .filter((item) => item.length > 0);

  if (!normalized.length) {
    return null;
  }

  return {
    type,
    name,
    value: normalized,
  };
}

function createActionItem(
  name: unknown,
  onTap: Record<string, unknown> = {},
  extern: Record<string, unknown> = {},
) {
  return {
    name: String(name ?? ""),
    onTap,
    extern,
  };
}

function createMetadataActionList(
  type: string,
  name: string,
  values: unknown,
  mapItem?: (value: string) => ReturnType<typeof createActionItem>,
) {
  const list = Array.isArray(values) ? values : values == null ? [] : [values];
  const normalized = list
    .map((item) => String(item ?? "").trim())
    .filter((item) => item.length > 0)
    .map((item) => (mapItem ? mapItem(item) : createActionItem(item)));

  if (!normalized.length) {
    return null;
  }

  return {
    type,
    name,
    value: normalized,
  };
}

function createImage(input: {
  id: unknown;
  url: unknown;
  name?: unknown;
  path?: unknown;
  extern?: Record<string, unknown>;
}) {
  return {
    id: String(input.id ?? ""),
    url: String(input.url ?? ""),
    name: String(input.name ?? ""),
    path: String(input.path ?? ""),
    extern: input.extern ?? {},
  };
}

function openSearchAction(payload: Record<string, unknown>) {
  const source = String(payload.source ?? "").trim();
  const keyword = String(payload.keyword ?? "").trim();
  const inheritedExtern =
    payload.extern &&
    typeof payload.extern === "object" &&
    !Array.isArray(payload.extern)
      ? (payload.extern as Record<string, unknown>)
      : {};
  const extern = {
    ...inheritedExtern,
    ...(typeof payload.url === "string" && payload.url.trim().length
      ? { url: payload.url.trim() }
      : {}),
    ...(Array.isArray(payload.categories)
      ? { categories: payload.categories }
      : {}),
    ...(typeof payload.mode === "string" && payload.mode.trim().length
      ? { mode: payload.mode.trim() }
      : {}),
    ...(typeof payload.creatorId === "string" && payload.creatorId.trim().length
      ? { creatorId: payload.creatorId.trim() }
      : {}),
  };
  return {
    type: "openSearch",
    payload: {
      ...(source ? { source } : {}),
      ...(keyword ? { keyword } : {}),
      extern,
    },
  };
}

function buildJmCoverUrl(item: any): string {
  const image = String(item?.image ?? "").trim();
  if (image.startsWith("http://") || image.startsWith("https://")) {
    return image;
  }

  const imageBase = Config.imagesUrl;
  if (!imageBase) {
    return image;
  }

  if (image.startsWith("/")) {
    return `${imageBase}${image}`;
  }

  if (image.startsWith("media/")) {
    return `${imageBase}/${image}`;
  }

  const id = String(item?.id ?? "").trim();
  if (!id) {
    return image;
  }

  return `${imageBase}/media/albums/${id}_3x4.jpg`;
}

function toComicItem(item: any) {
  const id = String(item?.id ?? "");
  const totalLikes = optionalJmCount(item?.likes);
  const totalViews = optionalJmCount(item?.total_views ?? item?.totalViews);
  return {
    source: JM_PLUGIN_ID,
    id,
    title: String(item?.name ?? ""),
    subtitle: "",
    finished: false,
    likesCount: totalLikes ?? 0,
    viewsCount: totalViews ?? 0,
    updatedAt: comicUpdateTime(item?.update_at),
    cover: {
      id,
      url: buildJmCoverUrl(item),
      path: `${id}.jpg`,
      extern: {
        path: `${id}.jpg`,
      },
    },
    metadata: [
      buildMetadata("author", "作者", item?.author),
      buildMetadata("categories", "分类", [
        item?.category?.title,
        item?.category_sub?.title,
      ]),
      buildMetadata("tags", "标签", item?.tags),
      buildMetadata("works", "作品", item?.works),
      buildMetadata("actors", "角色", item?.actors),
    ].filter(Boolean),
    raw: {
      id,
      author: String(item?.author ?? ""),
      description: item?.description ?? "",
      name: String(item?.name ?? ""),
      image: String(item?.image ?? ""),
      category: {
        id: String(item?.category?.id ?? ""),
        title: String(item?.category?.title ?? ""),
      },
      category_sub: {
        id:
          item?.category_sub?.id == null ? null : String(item.category_sub.id),
        title:
          item?.category_sub?.title == null
            ? null
            : String(item.category_sub.title),
      },
      liked: toBool(item?.liked),
      is_favorite: toBool(item?.is_favorite),
      update_at: toNum(item?.update_at),
      likes: totalLikes,
      totalViews,
      tags: toStrList(item?.tags),
      works: toStrList(item?.works),
      actors: toStrList(item?.actors),
    },
    extern: { metricAvailability: { totalLikes: totalLikes !== null, totalViews: totalViews !== null } },
  };
}

function normalizeJmSeries(series: any[]): any[] {
  const cleaned = Array.isArray(series) ? series : [];
  const filtered = cleaned
    .filter((item) => String(item?.sort ?? "") !== "0")
    .map((item) => ({
      ...item,
      id: String(item?.id ?? ""),
      sort: String(item?.sort ?? ""),
      rawOrder: toNum(item?.sort, 0),
      rawName: typeof item?.name === "string" ? item.name.trim() : "",
    }))
    .sort((a, b) => toNum(a?.sort, 0) - toNum(b?.sort, 0));

  return filtered.map((item, index) => {
    const order = index + 1;
    return {
      ...item,
      order,
      name: item.rawName || (item.rawOrder > 0 ? `第${item.rawOrder}话` : ""),
    };
  });
}

function toStringMap(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function boolKeyList(value: unknown): string[] {
  const map = toStringMap(value);
  return Object.entries(map)
    .filter(([, checked]) => Boolean(checked))
    .map(([key]) => key);
}

function toBoolMap(values: string[]): Record<string, boolean> {
  return values.reduce<Record<string, boolean>>((acc, item) => {
    if (item.trim()) {
      acc[item] = true;
    }
    return acc;
  }, {});
}

function createChoiceOption(
  label: string,
  value: string,
  result: Record<string, unknown>,
  children?: RankingFilterOption[],
): RankingFilterOption {
  return { label, value, result, ...(children ? { children } : {}) };
}

function buildComicListScene(input: {
  title: string;
  list: {
    fnPath: string;
    core?: Record<string, unknown>;
    extern?: Record<string, unknown>;
  };
  filter?: {
    fnPath: string;
    core?: Record<string, unknown>;
    extern?: Record<string, unknown>;
  };
}) {
  return {
    title: input.title,
    source: JM_PLUGIN_ID,
    list: {
      fnPath: input.list.fnPath,
      core: input.list.core ?? {},
      extern: input.list.extern ?? {},
    },
    ...(input.filter
      ? {
          filter: {
            fnPath: input.filter.fnPath,
            core: input.filter.core ?? {},
            extern: input.filter.extern ?? {},
          },
        }
      : {}),
  };
}

function openComicListAction(scene: ReturnType<typeof buildComicListScene>) {
  return {
    type: "openComicList",
    payload: { scene },
  };
}

function getJmRankingCategoryOptions(): RankingFilterOption[] {
  return [
    createChoiceOption("最新a漫", "latest", { extern: { type: "0" } }),
    createChoiceOption("同人", "doujin", { extern: { type: "doujin" } }, [
      createChoiceOption("汉化", "doujin_chinese", {
        extern: { type: "doujin_chinese" },
      }),
      createChoiceOption("日语", "doujin_japanese", {
        extern: { type: "doujin_japanese" },
      }),
      createChoiceOption("CG图集", "doujin_CG", {
        extern: { type: "doujin_CG" },
      }),
    ]),
    createChoiceOption("单本", "single", { extern: { type: "single" } }, [
      createChoiceOption("汉化", "single_chinese", {
        extern: { type: "single_chinese" },
      }),
      createChoiceOption("日语", "single_japanese", {
        extern: { type: "single_japanese" },
      }),
      createChoiceOption("青年漫", "single_youth", {
        extern: { type: "single_youth" },
      }),
    ]),
    createChoiceOption("短篇", "short", { extern: { type: "short" } }, [
      createChoiceOption("汉化", "short_chinese", {
        extern: { type: "short_chinese" },
      }),
      createChoiceOption("日语", "short_japanese", {
        extern: { type: "short_japanese" },
      }),
    ]),
    createChoiceOption("其他类", "another", { extern: { type: "another" } }, [
      createChoiceOption("其他漫画", "another_other", {
        extern: { type: "another_other" },
      }),
      createChoiceOption("3D", "another_3d", {
        extern: { type: "another_3d" },
      }),
      createChoiceOption("角色扮演", "another_cosplay", {
        extern: { type: "another_cosplay" },
      }),
    ]),
    createChoiceOption("韩漫", "hanman", { extern: { type: "hanman" } }, [
      createChoiceOption("汉化", "hanman_chinese", {
        extern: { type: "hanman_chinese" },
      }),
    ]),
    createChoiceOption(
      "English Manga",
      "meiman",
      { extern: { type: "meiman" } },
      [
        createChoiceOption("IRODORI", "meiman_irodori", {
          extern: { type: "meiman_irodori" },
        }),
        createChoiceOption("FAKKU", "meiman_fakku", {
          extern: { type: "meiman_fakku" },
        }),
        createChoiceOption("18scan", "meiman_18scan", {
          extern: { type: "meiman_18scan" },
        }),
        createChoiceOption("Manhwa", "meiman_manhwa", {
          extern: { type: "meiman_manhwa" },
        }),
        createChoiceOption("Comic", "meiman_comic", {
          extern: { type: "meiman_comic" },
        }),
        createChoiceOption("Other", "meiman_other", {
          extern: { type: "meiman_other" },
        }),
      ],
    ),
    createChoiceOption("Cosplay", "another_cosplay_direct", {
      extern: { type: "another_cosplay" },
    }),
    createChoiceOption("3D", "3D", { extern: { type: "3D" } }),
    createChoiceOption("禁漫汉化组", "jm_translation_team", {
      extern: { type: "禁漫汉化组" },
    }),
  ];
}

function getJmRankingOrderOptions(): RankingFilterOption[] {
  return [
    createChoiceOption("最新", "new", { extern: { order: "new" } }),
    createChoiceOption("最多点赞", "tf", { extern: { order: "tf" } }),
    createChoiceOption("总排行", "mv", { extern: { order: "mv" } }),
    createChoiceOption("月排行", "mv_m", { extern: { order: "mv_m" } }),
    createChoiceOption("周排行", "mv_w", { extern: { order: "mv_w" } }),
    createChoiceOption("日排行", "mv_t", { extern: { order: "mv_t" } }),
  ];
}

function rankingCategoryForType(options: RankingFilterOption[], type: string): RankingFilterOption | undefined {
  for (const option of options) {
    if (toStringMap(option.result.extern).type === type) return option;
    const child = rankingCategoryForType(option.children ?? [], type);
    if (child) return child;
  }
  return undefined;
}

function getJmWeekRankingWeekOptions(): RankingFilterOption[] {
  return [
    createChoiceOption("周一", "monday", { core: { date: 1 } }),
    createChoiceOption("周二", "tuesday", { core: { date: 2 } }),
    createChoiceOption("周三", "wednesday", { core: { date: 3 } }),
    createChoiceOption("周四", "thursday", { core: { date: 4 } }),
    createChoiceOption("周五", "friday", { core: { date: 5 } }),
    createChoiceOption("周六", "saturday", { core: { date: 6 } }),
    createChoiceOption("周日", "sunday", { core: { date: 7 } }),
    createChoiceOption("已完结", "completed", { core: { date: 0 } }),
  ];
}

function getJmWeekRankingCategoryOptions(): RankingFilterOption[] {
  return [
    createChoiceOption("全部", "all", { core: { type: "all" } }),
    createChoiceOption("日漫", "manga", { core: { type: "manga" } }),
    createChoiceOption("韩漫", "hanman", { core: { type: "hanman" } }),
  ];
}

function getTimeRankingCategoryOptions(tag: string): RankingFilterOption[] {
  switch (tag) {
    case "hanManTypeMap":
      return [
        createChoiceOption("韩漫", "hanman", { extern: { type: "hanman" } }),
        createChoiceOption("汉化", "hanman_chinese", {
          extern: { type: "hanman_chinese" },
        }),
      ];
    case "qiTaLeiTypeMap":
      return [
        createChoiceOption("其他类", "another", {
          extern: { type: "another" },
        }),
        createChoiceOption("其他漫画", "another_other", {
          extern: { type: "another_other" },
        }),
        createChoiceOption("3D", "another_3d", {
          extern: { type: "another_3d" },
        }),
        createChoiceOption("角色扮演", "another_cosplay", {
          extern: { type: "another_cosplay" },
        }),
      ];
    case "禁漫汉化组":
      return [
        createChoiceOption("禁漫汉化组", "jm_translation_team", {
          extern: { type: "禁漫汉化组" },
        }),
      ];
    default:
      return [
        createChoiceOption("分类", "default", {
          extern: { type: tag || "all" },
        }),
      ];
  }
}

function getTimeRankingOrderOptions(): RankingFilterOption[] {
  return [
    createChoiceOption("最新", "new", { extern: { order: "new" } }),
    createChoiceOption("最多点赞", "tf", { extern: { order: "tf" } }),
    createChoiceOption("总排行", "mv", { extern: { order: "mv" } }),
    createChoiceOption("月排行", "mv_m", { extern: { order: "mv_m" } }),
    createChoiceOption("周排行", "mv_w", { extern: { order: "mv_w" } }),
    createChoiceOption("日排行", "mv_t", { extern: { order: "mv_t" } }),
  ];
}

function getCurrentWeekRankingValue(): string {
  const weekday = new Date().getDay();
  switch (weekday) {
    case 1:
      return "monday";
    case 2:
      return "tuesday";
    case 3:
      return "wednesday";
    case 4:
      return "thursday";
    case 5:
      return "friday";
    case 6:
      return "saturday";
    case 0:
    default:
      return "sunday";
  }
}

async function normalizeHomeSectionTitle(value: unknown): Promise<string> {
  const title = String(value ?? "").trim();
  if (!title) {
    return "";
  }

  const normalizedTitle = String(
    await opencc.convert(title, "t2s.json"),
  ).trim();
  if (normalizedTitle !== "连载更新→右滑看更多→") {
    return normalizedTitle;
  }

  const weekMap = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return `${weekMap[new Date().getDay()] ?? ""}连载更新`;
}

function sortByToOrder(value: unknown): string {
  const sortBy = Number(value);
  if (sortBy === 2) return "mv";
  if (sortBy === 3) return "mp";
  if (sortBy === 4) return "tf";
  return "";
}

async function loadPluginSetting(key: string, fallback: unknown, { strict = false } = {}) {
  const raw = await pluginConfig.load(key, JSON.stringify(fallback));
  try {
    const decoded = JSON.parse(String(raw));
    if (decoded?.ok === true && (!strict || Object.prototype.hasOwnProperty.call(decoded, "value"))) {
      return decoded.value;
    }
  } catch (_) {
    // noop
  }
  if (strict) throw new JmRequestError("账号资料读取失败，请稍后重试", true);
  return fallback;
}

async function isJmLoggedIn({ strict = false } = {}): Promise<boolean> {
  const jwt = String(await loadPluginSetting("auth.jwt", "", { strict }) ?? "").trim();
  return jwt.length > 0 && jwt !== "null" && jwt !== "undefined";
}

/**
 * 告知宿主本插件为禁漫：页面图由服务端分块打乱，需宿主在落盘前重排还原。
 * Breeze 3.0.34+ 会调用该导出；更早的版本会忽略它，无副作用。
 */
async function isJm() {
  return true;
}

let commentEnabledCache = { value: false, at: 0 };

/**
 * 「允许发表评论」总开关（默认关闭）。
 * 只影响“发表”：查看评论、翻页与回复展示均不受影响。
 */
async function isCommentEnabled(): Promise<boolean> {
  if (Date.now() - commentEnabledCache.at < 10_000) {
    return commentEnabledCache.value;
  }
  let value = false;
  try {
    value = toBool(await loadPluginSetting("comment.enabled", false), false);
  } catch {
    value = false;
  }
  commentEnabledCache = { value, at: Date.now() };
  return value;
}

/** 设置页「允许发表评论」开关回调：即时生效并持久化 */
async function onCommentChanged(
  payload: {
    key?: string;
    value?: unknown;
    extern?: Record<string, unknown>;
  } = {},
): Promise<Record<string, unknown>> {
  const key = String(payload.key ?? "").trim();
  const value = toBool(payload.value, false);
  if (key === "comment.enabled") {
    commentEnabledCache = { value, at: Date.now() };
  }
  if (key) {
    await pluginConfig.save(key, JSON.stringify(value));
  }
  return {
    source: JM_PLUGIN_ID,
    data: { ok: true, key, value },
  };
}

async function loadBlockedCategories(): Promise<string[]> {
  const value = await loadPluginSetting("search.blockedCategories", []);
  return toStrList(value);
}

async function saveBlockedCategories(values: string[]) {
  await pluginConfig.save("search.blockedCategories", JSON.stringify(values));
}

function formatClock(ts: number): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${date.getMonth() + 1}-${date.getDate()} ${hour}:${minute}`;
}

function buildSpeedMap(records: EndpointSpeedRecord[]) {
  const map = new Map<string, EndpointSpeedRecord>();
  for (const record of records) {
    const base = imageBaseOf(record.url) || Config.normalizeBaseUrl(record.url);
    if (base) map.set(base, record);
  }
  return map;
}

function speedLabel(record?: EndpointSpeedRecord): string {
  if (!record) return "未测";
  if (record.ok) return record.ms === null ? "通过" : `${record.ms} ms`;
  if (record.status === null) return "连接无响应";
  if (record.failedAt === "album") return "无法打开作品";
  if (record.failedAt === "catalog") return "无法打开作品列表";
  return "无法加载封面";
}

function buildEndpointOptions(
  bases: string[],
  speedMap: Map<string, EndpointSpeedRecord>,
  activeAutoBase: string,
) {
  const active = Config.normalizeBaseUrl(activeAutoBase);
  const domains = bases.map((base) => {
    try { return new URL(base).hostname; } catch { return ""; }
  });
  const shortNames = domains.map((domain) =>
    domain.length > 24 ? `${domain.slice(0, 13)}…${domain.slice(-8)}` : domain);
  const counts = new Map<string, number>();
  for (const name of shortNames) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [
    { label: "自动（可用优先）", value: "" },
    ...bases.map((base, index) => {
      const domain = domains[index]!;
      const shortened = shortNames[index]!;
      const name = counts.get(shortened) === 1 ? shortened : domain;
      const speed = speedLabel(speedMap.get(base));
      return {
        label: `${getHost(base)}（${speed}）`,
        value: base,
        routeOption: {
          title: `${name} · ${speed}`,
          domain,
          inUse: Boolean(active && base === active),
        },
      };
    }),
  ];
}

function rankSpeedRecords(records: EndpointSpeedRecord[], limit = 3) {
  return records
    .filter((item) => item.ok && item.ms !== null)
    .sort((a, b) => Number(a.ms) - Number(b.ms))
    .slice(0, limit)
    .map((item) => `${getHost(item.url)} ${item.ms}ms`)
    .join("  ");
}

/** 当前候选图片线路：已解析的线路 + 内置域名池（init 未完成时也能展示全部候选） */
function currentImageBases(): string[] {
  return Array.from(
    new Set(
      [
        ...Config.imagesUrls.map((item) => Config.normalizeBaseUrl(item)),
        ...Config.buildImageCandidates(Config.imagesUrl),
      ].filter(Boolean),
    ),
  );
}

function currentApiBases(): string[] {
  const list = Config.baseUrls
    .map((item) => normalizeBaseBaseUrl(item))
    .filter(Boolean);
  return list.length ? Array.from(new Set(list)) : [Config.JM_FALLBACK_API_BASE];
}

const JM_SPEED_MAX_AGE_MS = 20 * 60_000;
let endpointWrites = Promise.resolve();
let pendingEndpointMeasurement: ReturnType<typeof measureAndApplyEndpointSpeeds> | undefined;
let runtimeEndpointsReady = false;

function writeEndpoints<T>(write: () => Promise<T>): Promise<T> {
  const result = endpointWrites.then(write);
  endpointWrites = result.then(() => {}, () => {});
  return result;
}

function isRecentEndpointSpeed(speed: EndpointSpeedCache): boolean {
  const age = Date.now() - speed.measuredAt;
  return age >= 0 && age <= JM_SPEED_MAX_AGE_MS;
}

function fastestEndpoint(bases: string[], records: EndpointSpeedRecord[]): string {
  const results = buildSpeedMap(records);
  let best = "";
  let fastest = Infinity;
  for (const base of bases) {
    const record = results.get(base);
    if (record?.ok && record.ms !== null && record.ms >= 0 && record.ms < fastest) {
      best = base;
      fastest = record.ms;
    }
  }
  return best;
}

function rankedDownloadBases(pin: string, active: string, bases: string[], records: EndpointSpeedRecord[]) {
  const known = new Map<string, URL>();
  for (const base of bases) {
    const url = jmDownloadBase(base);
    if (url) known.set(url.origin, url);
  }
  if (pin) {
    const pinned = known.get(jmDownloadBase(pin)?.origin ?? "");
    return pinned ? [pinned] : [];
  }
  const order = [active, ...records.filter((record) => record.ok && record.ms !== null && record.ms >= 0)
    .sort((a, b) => a.ms! - b.ms!).map((record) => record.url), ...bases];
  const origins = new Set(order.map((base) => jmDownloadBase(base)?.origin));
  return [...origins].flatMap((origin) => {
    const candidate = origin ? known.get(origin) : undefined;
    return candidate ? [candidate] : [];
  });
}

function endpointIndex(bases: string[], preference: string, fastest: string, previous: string) {
  for (const value of [preference, fastest, previous]) {
    const index = bases.indexOf(value);
    if (index >= 0) return index;
  }
  return 0;
}

function applyEndpointSelection(
  pinnedApi: string,
  pinnedImage: string,
  speed: EndpointSpeedCache | null,
  previousApi: string,
  previousImage: string,
) {
  const recent = speed && isRecentEndpointSpeed(speed) ? speed : null;
  const api = recent ? fastestEndpoint(Config.baseUrls, recent.api) : "";
  const image = recent ? fastestEndpoint(Config.imagesUrls, recent.image) : "";
  Config.baseUrlIndex = endpointIndex(Config.baseUrls, pinnedApi, api, previousApi);
  Config.imagesUrlIndex = endpointIndex(Config.imagesUrls, pinnedImage, image, previousImage);
  if (image && !pinnedImage) imageBaseFailures.delete(image);
}

function measureEndpointSpeeds() {
  if (pendingEndpointMeasurement) return pendingEndpointMeasurement;
  const measurement = measureAndApplyEndpointSpeeds();
  pendingEndpointMeasurement = measurement;
  const release = () => {
    if (pendingEndpointMeasurement === measurement) pendingEndpointMeasurement = undefined;
  };
  void measurement.then(release, release);
  return measurement;
}

/** 以有效公开响应为测速依据，只给自动模式应用成绩。 */
async function measureAndApplyEndpointSpeeds() {
  const activeApi = Config.baseUrl;
  const catalogs = await Promise.all(currentApiBases().map(probeJmCatalog));
  let directory = catalogs.find(({ record, value }) => record.url === activeApi && value !== null) ??
    catalogs.find(({ value }) => value !== null);
  if (!directory) {
    // One anonymous read on the active line when the latest feed did not
    // respond anywhere. Never retry a rejection or change the user's line.
    const index = catalogs.findIndex(({ record }) => record.url === activeApi && record.status === null);
    if (index >= 0) {
      const fallback = await probeJmRankingCatalog(activeApi);
      catalogs[index] = fallback;
      if (fallback.value !== null) directory = fallback;
    }
  }
  let api: EndpointSpeedRecord[] = catalogs.map(({ record }) => ({
    ...record, failedAt: "catalog",
  }));
  let sampleId = "";
  let sampleApi = "";
  for (const id of directory?.value ?? []) {
    api = await Promise.all(catalogs.map(async ({ record }) => {
      if (!record.ok) return { ...record, failedAt: "catalog" as const };
      const detail = await probeJmAlbum(record.url, id, (raw) => {
        const album = unwrapJmAlbumPayload(raw);
        const workId = Number(id);
        if (optionalJmCount(album.id) !== workId || typeof album.name !== "string" || !album.name.trim()) {
          return false;
        }
        normalizeJmFollowSeries(album, workId);
        return true;
      });
      return detail.ok ? detail : { ...detail, failedAt: "album" as const };
    }));
    const winner = fastestEndpoint(api.map((row) => row.url), api);
    if (winner) {
      sampleId = id;
      sampleApi = winner;
      break;
    }
  }
  const image = sampleId
    ? await Promise.all(currentImageBases().map((base) => probeJmCover(base, sampleId, sampleApi)))
    : [];

  const measuredAt = Date.now();
  const effectiveRouteChanged = await writeEndpoints(async () => {
    const speed = { measuredAt, image, api };
    await setEndpointSpeedCache(speed);
    const [pinnedApi, pinnedImage] = await Promise.all([getPinnedApiBase(), getPinnedImageBase()]);
    const previousApi = Config.baseUrl;
    const previousImage = Config.imagesUrl;
    Config.baseUrls = currentApiBases();
    Config.imagesUrls = currentImageBases();
    applyEndpointSelection(pinnedApi, pinnedImage, speed, previousApi, previousImage);
    return previousApi !== Config.baseUrl;
  });

  const failed = image.filter((item) => !item.ok).length +
    api.filter((item) => !item.ok).length;
  const anyPassing = api.some((item) => item.ok) || image.some((item) => item.ok);
  const outcome = !anyPassing ? "failure" : failed > 0 || !api.length || !image.length ? "partial" : "success";
  const message = [
    `接口线路：${rankSpeedRecords(api) || "无法打开作品"}`,
    `图片线路：${sampleId ? rankSpeedRecords(image) || "无法加载封面" : "作品未能打开，暂未测试"}`,
    failed > 0 ? `${failed} 条线路未通过` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    source: JM_PLUGIN_ID,
    ok: true,
    message,
    data: { ok: true, outcome, measuredAt, message, image, api, effectiveRouteChanged },
  };
}

/** 保存固定线路或回到自动模式。 */
async function onNetworkChanged(
  payload: {
    key?: string;
    value?: unknown;
    extern?: Record<string, unknown>;
  } = {},
) {
  const key = String(payload.key ?? "");
  const value = Config.normalizeBaseUrl(payload.value);

  const isImage = key === "network.imageBase";
  const isApi = key === "network.apiBase";
  const previousApi = Config.baseUrl;
  if (isImage || isApi) {
    const shouldMeasure = await writeEndpoints(async () => {
      const bases = isImage ? currentImageBases() : currentApiBases();
      if (value && !bases.includes(value)) throw new Error("线路不在当前候选中");
      const previousPin = await (isImage ? getPinnedImageBase() : getPinnedApiBase());
      await pluginConfig.save(key, JSON.stringify(value));
      const speed = value ? null : await getEndpointSpeedCache().catch(() => null);
      const results = speed && isRecentEndpointSpeed(speed) ? (isImage ? speed.image : speed.api) : [];
      const fastest = fastestEndpoint(bases, results);
      const index = endpointIndex(bases, value, fastest, previousPin ? "" : (isImage ? Config.imagesUrl : Config.baseUrl));
      if (isImage) {
        pinnedImageBaseCache = { value, at: Date.now() };
        Config.imagesUrls = bases;
        Config.imagesUrlIndex = index;
        imageBaseFailures.delete(Config.imagesUrl);
      } else {
        pinnedApiBaseCache = { value, at: Date.now() };
        Config.baseUrls = bases;
        Config.baseUrlIndex = index;
      }
      return Boolean(previousPin && !value && !fastest);
    });
    if (shouldMeasure) {
      // A failed probe leaves the saved Auto selection and its available fallback.
      await measureEndpointSpeeds().catch(() => {});
    }
  }

  return {
    source: JM_PLUGIN_ID,
    data: { ok: true, key, value, effectiveRouteChanged: previousApi !== Config.baseUrl },
  };
}

async function getSettingsBundle(): Promise<SettingsBundleContract> {
  const [account, password, commentEnabled, pinnedImage, pinnedApi, speedCache] =
    await Promise.all([
      loadPluginSetting("auth.account", ""),
      loadPluginSetting("auth.password", ""),
      loadPluginSetting("comment.enabled", false),
      loadPluginSetting("network.imageBase", ""),
      loadPluginSetting("network.apiBase", ""),
      getEndpointSpeedCache(),
    ]);

  const imageBases = currentImageBases();
  const apiBases = currentApiBases();

  const imageSpeedMap = buildSpeedMap(speedCache?.image ?? []);
  const apiSpeedMap = buildSpeedMap(speedCache?.api ?? []);
  const networkSection = {
    id: "network",
    title: "网络线路",
    headerAction: { key: "speedtest", title: "测速", fnPath: "measureEndpointSpeeds" },
    ...(speedCache ? { footer: `上次测速 ${formatClock(speedCache.measuredAt)}${isRecentEndpointSpeed(speedCache) ? "" : " · 旧结果"}` } : {}),
    fields: [
      {
        key: "network.imageBase",
        kind: "choice" as const,
        label: "图片线路",
        description: `当前使用 ${getHost(Config.imagesUrl)}。自动模式优先使用加载封面最快的可用线路。`,
        fnPath: "onNetworkChanged",
        options: buildEndpointOptions(imageBases, imageSpeedMap, pinnedImage ? "" : Config.imagesUrl),
      },
      {
        key: "network.apiBase",
        kind: "choice" as const,
        label: "接口线路",
        description: `当前使用 ${getHost(Config.baseUrl)}。自动模式优先使用打开作品最快的可用线路。`,
        fnPath: "onNetworkChanged",
        options: buildEndpointOptions(apiBases, apiSpeedMap, pinnedApi ? "" : Config.baseUrl),
      },
    ],
  };

  return {
    source: JM_PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "settings",
      sections: [
        {
          id: "account",
          title: "账号",
          fields: [
            { key: "auth.account", kind: "text", label: "用户名" },
            { key: "auth.password", kind: "password", label: "密码" },
          ],
        },
        {
          id: "comment",
          title: "评论",
          fields: [
            {
              key: "comment.enabled",
              kind: "switch",
              label: "允许发表评论（关闭后仍可查看评论）",
              fnPath: "onCommentChanged",
            },
          ],
        },
        networkSection,
      ],
    },
    data: {
      canShowUserInfo: true,
      values: {
        "auth.account": String(account ?? ""),
        "auth.password": String(password ?? ""),
        "comment.enabled": toBool(commentEnabled, false),
        "network.imageBase": String(pinnedImage ?? ""),
        "network.apiBase": String(pinnedApi ?? ""),
      },
    },
  };
}

async function getUserInfoBundle(): Promise<UserInfoBundleContract> {
  const revision = currentSessionRevision();
  await waitForSessionWrites(revision);
  const ensureUserInfo = async () => {
    const stored = await loadPluginSetting("auth.userInfo", {}, { strict: true });
    assertCurrentSession(revision);
    const current =
      stored && typeof stored === "object"
        ? (stored as Record<string, any>)
        : ({} as Record<string, any>);
    if (String(current.username ?? current.nickname ?? "").trim()) {
      return current;
    }

    const account = String(await loadPluginSetting("auth.account", "", { strict: true }) ?? "").trim();
    const password = String(
      await loadPluginSetting("auth.password", "", { strict: true }) ?? "",
    ).trim();
    if (!account || !password) {
      const profileMissing = stored == null ||
        (typeof stored === "object" && !Array.isArray(stored) && Object.keys(stored).length === 0);
      if (profileMissing && !(await isJmLoggedIn({ strict: true })) && !(await getJwtToken(revision))) {
        const error = buildUnauthorizedError("请先登录禁漫账号");
        assertCurrentSession(revision);
        throw error;
      }
      return current;
    }

    const refreshed = (await jmRequest({
      path: `${Config.baseUrl}/login`,
      method: "POST",
      formData: { username: account, password },
      cache: false,
      useJwt: false,
    }, revision)) as Record<string, any>;
    await saveSessionValues(revision, {
      "auth.userInfo": refreshed,
      "auth.jwt": String(refreshed?.jwttoken ?? ""),
    });
    return refreshed;
  };

  const user = await ensureUserInfo();
  assertCurrentSession(revision);

  const username = String(user?.username ?? user?.nickname ?? "").trim();
  if (!username) {
    throw new JmRequestError("账号资料读取失败，请稍后重试", true);
  }
  return buildUserInfoBundle(user, await refreshCheckin(user.uid, revision));
}

function buildUserInfoBundle(user: Record<string, any>, checkin: Record<string, unknown>): UserInfoBundleContract {
  const username = String(user.username ?? user.nickname ?? "").trim();
  const coin = String(user.coin ?? "").trim();
  const parsedLevel = (typeof user.level === "number" ||
    typeof user.level === "string" && user.level.trim()) ? Number(user.level) : NaN;
  const level = Number.isFinite(parsedLevel) && parsedLevel >= 0 ? parsedLevel : null;
  const levelName = String(user.level_name ?? user.levelName ?? "").trim();
  const exp = String(user.exp ?? "").trim();
  const nextLevelExp = String(user.nextLevelExp ?? "").trim();
  const photo = String(user.photo ?? "").trim();

  return {
    source: JM_PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "userInfo",
    },
    data: {
      title: "账号",
      avatar: {
        id: String(user.uid ?? "me"),
        url: buildJmUserCover(photo),
        name: photo,
        path: photo ? (photo.endsWith(".jpg") ? photo : `${photo}.jpg`) : "",
        extern: {
          path: photo ? (photo.endsWith(".jpg") ? photo : `${photo}.jpg`) : "",
        },
      },
      lines: [
        `${username}${coin ? ` (硬币: ${coin})` : ""}`,
        level !== null ? `Lv.${level}${levelName ? ` ${levelName}` : ""}` : levelName,
        exp || nextLevelExp ? `经验值: ${exp}/${nextLevelExp}` : "",
      ],
      extern: {
        ...checkin,
        profileDataSource: "storedSession",
        uid: String(user.uid ?? ""),
        name: username,
        level,
        title: levelName,
        coin,
        experience: exp,
        nextLevelExperience: nextLevelExp,
      },
    },
  };
}

// Settings must never enter the profile's legacy automatic-login fallback or
// trigger network reads. Missing login data is an unavailable account summary.
async function getSettingsUserInfoBundle() {
  const revision = currentSessionRevision();
  await waitForSessionWrites(revision);
  const user = await loadPluginSetting("auth.userInfo", {});
  assertCurrentSession(revision);
  if (!user || !String(user.username ?? user.nickname ?? "").trim()) {
    return { source: JM_PLUGIN_ID, data: { available: false, lines: [],
      extern: { profileDataSource: "storedSession" } } };
  }
  const bundle = buildUserInfoBundle(user, await readCheckin(user.uid, revision));
  return { ...bundle, data: { ...bundle.data, available: true } };
}

// /useredit contains private edit fields too. Return only these display fields;
// it does not establish fresh avatar, balance, level or experience information.
async function getUserProfileDetails() {
  const revision = currentSessionRevision();
  await waitForSessionWrites(revision);
  const [user, storedJwt] = await Promise.all([
    loadPluginSetting("auth.userInfo", {}, { strict: true }),
    loadPluginSetting("auth.jwt", "", { strict: true }),
  ]);
  assertCurrentSession(revision);
  if (!user || typeof user !== "object" || Array.isArray(user) || typeof storedJwt !== "string") {
    throw new JmRequestError("账号资料读取失败，请稍后重试", true);
  }
  const uid = user.uid;
  if (uid != null && typeof uid !== "string" && typeof uid !== "number") {
    throw new JmRequestError("账号资料读取失败，请稍后重试", true);
  }
  const accountId = String(uid ?? "").trim();
  const jwt = storedJwt.trim();
  // The UID alone may have come from an imported profile. Require the current
  // persisted session, even if a previous runtime left a cached JWT behind.
  if (!accountId || !jwt || jwt === "null" || jwt === "undefined") {
    throw buildUnauthorizedError("请先登录禁漫账号");
  }
  const api = jmDownloadBase(Config.baseUrl);
  if (!api) throw new JmRequestError("账号线路暂不可用，请稍后重试");
  const raw = await jmRequest({
    path: `${api.origin}/useredit/${encodeURIComponent(accountId)}`,
    method: "GET", cache: false, useJwt: true, readOnlyProfile: true,
  }, revision, jwt);
  assertCurrentSession(revision);
  const data = raw?.data ?? raw;
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      typeof data.nickName !== "string" || typeof data.aboutMe !== "string" ||
      raw?.status === false || data.status === false || data.ok === false || data.success === false ||
      (raw?.code !== undefined && Number(raw.code) !== 200) ||
      (data.code !== undefined && Number(data.code) !== 200)) {
    throw new JmRequestError("账号资料读取失败，请稍后重试");
  }
  return { source: JM_PLUGIN_ID, data: { accountId, nickname: data.nickName,
    aboutMe: data.aboutMe, profileDataSource: "serverUserEdit", checkedAt: new Date().toISOString() } };
}

async function getLoginBundle() {
  return {
    source: JM_PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "login",
      title: "禁漫登录",
      fields: [
        { key: "account", kind: "text", label: "用户名" },
        { key: "password", kind: "password", label: "密码" },
      ],
      action: {
        fnPath: "loginWithPassword",
        submitText: "登录",
      },
    },
    data: {
      account: String(await loadPluginSetting("auth.account", "")),
      password: String(await loadPluginSetting("auth.password", "")),
    },
  };
}

async function loginWithPassword(
  payload: JmLoginPayload = {},
  revision = currentSessionRevision(),
) {
  await waitForSessionWrites(revision);
  const account = String(payload.account ?? "").trim();
  const password = String(payload.password ?? "");
  if (!account || !password) {
    throw new Error("账号或密码不能为空");
  }

  const path = `${Config.baseUrl}/login`;
  let result: any;
  try {
    result = await jmRequest({
      path,
      method: "POST",
      formData: { username: account, password },
      useJwt: false,
    }, revision);
  } catch (error) {
    console.warn("[jm.login] request failed");
    throw error;
  }

  const jwtToken = String((result as any)?.jwttoken ?? "");
  await saveSessionValues(revision, {
    "auth.account": account,
    "auth.password": password,
    "auth.jwt": jwtToken,
    "auth.userInfo": result,
  });
  assertCurrentSession(revision);

  return {
    source: JM_PLUGIN_ID,
    data: { account },
  };
}

let jmInitStarted = false;
let jmAuthFlowRunning = false;

function normalizeBaseBaseUrl(url: string): string {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return raw.replace(/\/+$/g, "");
  }
  return `https://${raw}`.replace(/\/+$/g, "");
}

async function fetchTextFromAny(urls: string[]) {
  let lastError: unknown = null;
  for (const url of urls) {
    try {
      const response = await axios.get(url, {
        timeout: 8000,
        responseType: "text",
        validateStatus: () => true,
      });
      if (response.status >= 200 && response.status < 300) {
        return String(response.data ?? "");
      }
      lastError = new Error(`status=${response.status} url=${url}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("host config urls unavailable");
}

async function loadHostPool(): Promise<string[]> {
  const raw = await fetchTextFromAny(Config.JM_HOST_CONFIG_URLS);
  const normalized = raw.replace(/[^A-Za-z0-9+/=]/g, "");
  const key = await md5Hex(Config.JM_HOSTCFG_AES_SEED);
  const plain = await hostRuntime.aesEcbPkcs7DecryptB64(normalized, key);
  const parsed = JSON.parse(String(plain || "{}")) as { Server?: unknown };
  if (!Array.isArray(parsed.Server)) return [];
  return parsed.Server.map((item) => String(item || "").trim()).filter(Boolean);
}

async function fetchSettingFromDomain(domain: string, tsSec: string) {
  const url = `${normalizeBaseBaseUrl(domain)}/setting?app_img_shunt=1&t=${tsSec}`;
  const token = await md5Hex(`${tsSec}${Config.JM_SECRET}`);
  const response = await axios.get(url, {
    timeout: 8000,
    validateStatus: () => true,
    headers: {
      Tokenparam: `${tsSec},${Config.JM_VERSION}`,
      Token: token,
    },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`status=${response.status}`);
  }
  const decoded = (await decodePublicJmData(response.data, tsSec)) as Record<
    string,
    unknown
  > | null;
  const imageBase = typeof decoded?.img_host === "string" ? Config.normalizeBaseUrl(decoded.img_host) : "";
  if (!imageBase || !getHost(imageBase)) {
    throw new Error("decode setting response failed");
  }
  return { imageBase };
}

async function resolveDynamicHosts() {
  const hostPool = await loadHostPool();
  if (!hostPool.length) {
    throw new Error("empty host pool");
  }

  const tsSec = String(Math.floor(Date.now() / 1000));
  let picked = "";
  let setting: Awaited<ReturnType<typeof fetchSettingFromDomain>> | null = null;
  for (const domain of hostPool) {
    try {
      setting = await fetchSettingFromDomain(domain, tsSec);
      picked = normalizeBaseBaseUrl(domain);
      if (setting) break;
    } catch {
      // try next domain
    }
  }

  if (!setting) {
    throw new Error("all setting endpoints failed");
  }

  const imageBaseUrls = Config.buildImageCandidates(setting.imageBase);
  const rawBaseUrls = [
    picked,
    ...hostPool.map((item) => normalizeBaseBaseUrl(item)),
  ].filter(Boolean);

  return {
    imageBaseUrls,
    baseUrls: Array.from(new Set(rawBaseUrls)),
  };
}

/** 初始化候选列表，并恢复固定线路或仍有效的测速结果。 */
async function applyEndpointLists(apiList: string[], imageList: string[]) {
  await writeEndpoints(async () => {
    const [pinnedApi, pinnedImage, speed] = await Promise.all([
      getPinnedApiBase(), getPinnedImageBase(), getEndpointSpeedCache().catch(() => null),
    ]);
    const previousApi = runtimeEndpointsReady ? Config.baseUrl : "";
    const previousImage = runtimeEndpointsReady ? Config.imagesUrl : "";
    Config.baseUrls = apiList.length ? apiList : [Config.JM_FALLBACK_API_BASE];
    Config.imagesUrls = imageList.length ? imageList : Config.buildImageCandidates();
    applyEndpointSelection(pinnedApi, pinnedImage, speed, previousApi, previousImage);
    runtimeEndpointsReady = true;
  });
}

async function resolveRuntimeEndpoints() {
  const cached = await getRuntimeEndpointCache();

  if (cached) {
    const apiList = Array.from(
      new Set(
        [...cached.hostPool, cached.apiBaseUrl]
          .map((item) => normalizeBaseBaseUrl(item))
          .filter(Boolean),
      ),
    );
    const imageList =
      cached.imageBaseUrls && cached.imageBaseUrls.length
        ? cached.imageBaseUrls
        : Config.buildImageCandidates(cached.imageBaseUrl);

    await applyEndpointLists(apiList, imageList);
    return;
  }

  let baseCandidates = [Config.JM_FALLBACK_API_BASE];
  let imageCandidates = Config.buildImageCandidates();
  try {
    const dynamic = await resolveDynamicHosts();
    if (dynamic.baseUrls.length > 0) {
      baseCandidates = dynamic.baseUrls;
    }
    if (dynamic.imageBaseUrls.length > 0) {
      imageCandidates = dynamic.imageBaseUrls;
    }
  } catch (error) {
    console.warn("[jm.init] resolve dynamic hosts failed");
  }

  await applyEndpointLists(baseCandidates, imageCandidates);

  try {
    await setRuntimeEndpointCache({
      apiBaseUrl: baseCandidates[0]!,
      imageBaseUrl: imageCandidates[0]!,
      imageBaseUrls: imageCandidates,
      hostPool: baseCandidates,
    });
  } catch (error) {
    console.warn("[jm.init] cache hostRuntime endpoints failed");
  }

}

async function tryJmCheckin(revision: number, automatic = false) {
  let pending = pendingCheckins.get(revision);
  if (pending === undefined) {
    const task = performJmCheckin(revision).finally(() => {
      if (pendingCheckins.get(revision)?.task === task) pendingCheckins.delete(revision);
    });
    pending = { task, manualRequested: !automatic };
    pendingCheckins.set(revision, pending);
  }
  if (!automatic) pending.manualRequested = true;
  const result = await pending.task;
  if (automatic && typeof result === "object" && !pending.manualRequested && result.date === checkinDate()) {
    assertCurrentSession(revision);
    void notifyAutoCheckinCompleted(result.accountId, result.date);
  }
  return result !== "failed";
}

async function performJmCheckin(revision: number): Promise<JmCheckinOutcome> {
  await waitForSessionWrites(revision);
  const stored = await loadPluginSetting("auth.userInfo", {});
  assertCurrentSession(revision);
  const uid = stored?.uid;
  const accountId = String(uid ?? "").trim();
  if (!uid || !accountId) {
    console.error("无法获取用户UID，跳过签到");
    return "failed";
  }

  if ((await readCheckin(uid, revision)).checkedIn === true) return "alreadyCheckedIn";
  const requestDate = checkinDate();

  try {
    return await retryTransient<JmCheckinOutcome>(async () => {
      const dailyListRes = await jmRequest({
        url: `${Config.baseUrl}/daily_list/filter`,
        method: "POST",
        formData: {
          data: String(new Date().getFullYear()),
        },
      }, revision);

      const list = dailyListRes?.data?.list ?? dailyListRes?.list ?? [];
      if (!Array.isArray(list) || list.length === 0) {
        console.log("今日无签到项");
        return "failed";
      }

      const lastItem = list[list.length - 1];
      const dailyId = lastItem?.id;
      if (!dailyId) {
        throw new Error("无法获取 dailyId");
      }

      const chkRes = await jmRequest({
        url: `${Config.baseUrl}/daily_chk`,
        method: "POST",
        formData: {
          user_id: uid,
          daily_id: dailyId,
        },
      }, revision);

      const rawMessage = String(chkRes?.data?.msg ?? chkRes?.msg ?? "");
      const message = (await opencc.convert(rawMessage, "t2s.json")).trim();
      assertCurrentSession(revision);

      // Exact endpoint outcomes, never an arbitrary toast or HTTP 200 alone.
      const outcome = chkRes?.data ?? chkRes;
      const alreadyCheckedIn = ["今天已经签到过了", "今天已經簽到過了"].includes(message);
      // Mobile /daily_chk rewards are anchored so an error quoting a reward is refused.
      const newlyCheckedIn = ["签到成功", "签到成功！"].includes(message) ||
        /^Jcoin:\d+\s+EXP:\d+$/.test(message);
      if (chkRes?.status === false || outcome?.status === false ||
          outcome?.success === false || outcome?.ok === false ||
          (chkRes?.code !== undefined && Number(chkRes.code) !== 200) ||
          (outcome?.code !== undefined && Number(outcome.code) !== 200) ||
          !(alreadyCheckedIn || newlyCheckedIn)) {
        return "failed";
      }
      if (checkinDate() !== requestDate) return "failed";
      await saveSessionValues(revision, {
        "auth.checkin": { accountId, checkedInDate: requestDate,
          evidenceSource: "dailyCheckin", confirmedAt: new Date().toISOString() },
      });

      return newlyCheckedIn ? { accountId, date: requestDate } : "alreadyCheckedIn";
    }, () => assertCurrentSession(revision));
  } catch (_) {
    assertCurrentSession(revision);
    console.warn("[jm.checkin] request failed; stopped");
    return "failed";
  }
}

async function checkInToday() {
  const revision = currentSessionRevision();
  await waitForSessionWrites(revision);
  const user = await loadPluginSetting("auth.userInfo", {});
  if (!user?.uid) {
    throw buildUnauthorizedError("请先登录禁漫账号");
  }
  assertCurrentSession(revision);
  const ok = await tryJmCheckin(revision);
  const checkin = await readCheckin(user.uid, revision);
  return {
    source: JM_PLUGIN_ID,
    data: {
      ok,
      ...checkin,
      message: ok ? "今日签到已完成" : "签到未完成，请检查线路后重试",
    },
  };
}

async function getNotifications() {
  const revision = currentSessionRevision();
  await waitForSessionWrites(revision);
  const user = await loadPluginSetting("auth.userInfo", {});
  assertCurrentSession(revision);
  const parsed = await readNotificationList(revision);
  let unreadSummary: Record<string, unknown>;
  try {
    unreadSummary = (await readNotificationUnreadCount(user?.uid, revision)).data;
  } catch (_) {
    assertCurrentSession(revision);
    unreadSummary = { countsKnown: false, error: "unavailable" };
  }
  return {
    source: JM_PLUGIN_ID,
    data: { accountId: String(user?.uid ?? "").trim() || null, ...parsed, unreadSummary },
  };
}

async function readNotificationList(revision: number) {
  const raw = await jmRequest({
    path: `${Config.baseUrl}/notifications`,
    method: "GET",
    cache: false,
    useJwt: true,
  }, revision);
  assertCurrentSession(revision);
  return parseJmNotifications(raw);
}

async function readNotificationUnreadCount(uid: unknown, revision: number) {
  const accountId = String(uid ?? "").trim();
  if (!accountId) throw buildUnauthorizedError("请先登录禁漫账号");
  const raw = await jmRequest({ path: `${Config.baseUrl}/notifications/unreadCount`,
    method: "GET", cache: false, useJwt: true }, revision);
  assertCurrentSession(revision);
  const data = raw?.data ?? raw;
  const valid = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (!valid(data?.comic_follow) || !valid(data?.site_notice) ||
      !Number.isSafeInteger(data.comic_follow + data.site_notice) ||
      raw?.status === false || data.status === false || data.ok === false || data.success === false ||
      (raw?.code !== undefined && Number(raw.code) !== 200) ||
      (data.code !== undefined && Number(data.code) !== 200)) {
    throw new JmRequestError("未读消息数量读取失败，请稍后重试");
  }
  return { source: JM_PLUGIN_ID, data: { accountId,
    comicFollow: data.comic_follow, siteNotice: data.site_notice,
    total: data.comic_follow + data.site_notice, countsKnown: true, checkedAt: new Date().toISOString() } };
}

async function getNotificationUnreadCount() {
  const revision = currentSessionRevision();
  await waitForSessionWrites(revision);
  const user = await loadPluginSetting("auth.userInfo", {});
  assertCurrentSession(revision);
  return await readNotificationUnreadCount(user?.uid, revision);
}

const pendingNotificationMarks = new Set<number>();

// Only explicit user-selected IDs are touched. There is no API-wide "all"
// sentinel. Each write is serial, then independently verified by an exact ID
// read; a successful POST or a failed connection alone proves nothing.
async function markNotificationsRead(payload: { ids?: unknown; accountId?: unknown } = {}) {
  const revision = currentSessionRevision();
  await waitForSessionWrites(revision);
  const user = await loadPluginSetting("auth.userInfo", {});
  assertCurrentSession(revision);
  const accountId = String(user?.uid ?? "").trim();
  if (!accountId || payload.accountId !== accountId) throw new JmRequestError("账号已变化，请刷新消息后重试");
  if (!Array.isArray(payload.ids) || !payload.ids.length ||
      payload.ids.some((id) => typeof id !== "string" || !id.trim() || id.trim().toLowerCase() === "all")) {
    throw new JmRequestError("请选择已加载的未读消息");
  }
  const ids = [...new Set(payload.ids as string[])];
  if (pendingNotificationMarks.has(revision)) throw new JmRequestError("消息正在更新，请稍后重试");
  pendingNotificationMarks.add(revision);
  try {
    let latest = await readNotificationList(revision);
    const confirmedIds: string[] = [];
    const failedIds: string[] = [];
    const unknownIds: string[] = [];
    for (const id of ids) {
      assertCurrentSession(revision);
      const matches = latest.items.filter((item) => item.id === id);
      if (matches.length !== 1 || matches[0]!.read === null) {
        unknownIds.push(id);
        continue;
      }
      if (matches[0]!.read === true) {
        confirmedIds.push(id);
        continue;
      }
      try {
        await jmRequest({ path: `${Config.baseUrl}/notifications`, method: "POST",
          formData: { id, read: "1" }, cache: false, useJwt: true }, revision);
      } catch (_) {
        assertCurrentSession(revision);
        // The server may have received a write even when its response is lost.
      }
      assertCurrentSession(revision);
      try {
        latest = await readNotificationList(revision);
        const verified = latest.items.filter((item) => item.id === id);
        if (verified.length !== 1 || verified[0]!.read === null) unknownIds.push(id);
        else if (verified[0]!.read === true) confirmedIds.push(id);
        else failedIds.push(id);
      } catch (_) {
        assertCurrentSession(revision);
        unknownIds.push(id);
      }
    }
    let unreadSummary: Record<string, unknown>;
    try {
      unreadSummary = (await readNotificationUnreadCount(accountId, revision)).data;
    } catch (_) {
      assertCurrentSession(revision);
      unreadSummary = { countsKnown: false, error: "unavailable" };
    }
    return { source: JM_PLUGIN_ID, data: { accountId, scope: "requestedLoadedItems",
      ok: confirmedIds.length === ids.length, requestedIds: ids, confirmedIds, failedIds, unknownIds,
      ...latest, unreadSummary } };
  } finally {
    pendingNotificationMarks.delete(revision);
  }
}

async function markNotificationRead(payload: { id?: unknown; accountId?: unknown } = {}) {
  return await markNotificationsRead({ ids: [payload.id], accountId: payload.accountId });
}

export async function runJmAuthAndCheckInLoop() {
  if (jmAuthFlowRunning) {
    return;
  }
  jmAuthFlowRunning = true;
  const revision = currentSessionRevision();
  try {
    await waitForSessionWrites(revision);
    const account = String(
      await loadPluginSetting("auth.account", ""),
    ).trim();
    const password = String(await loadPluginSetting("auth.password", ""));

    if (!account || !password) {
      console.info("[jm.init] skip auth/checkin: no credentials");
      return;
    }

    await retryTransient(
      () => loginWithPassword({ account, password }, revision),
      () => assertCurrentSession(revision),
    );

    const checkedIn = await tryJmCheckin(revision, true);
    if (!checkedIn) {
      console.warn("[jm.init] checkin incomplete; stopped");
      return;
    }

    console.info("[jm.init] login + checkin ok");
  } catch (_) {
    console.warn("[jm.init] login/checkin incomplete; stopped");
  } finally {
    jmAuthFlowRunning = false;
  }
}

async function init() {
  await resolveRuntimeEndpoints();
  if (!jmInitStarted) {
    jmInitStarted = true;
    void runJmAuthAndCheckInLoop();
  }

  return {
    source: JM_PLUGIN_ID,
    data: {
      ok: true,
      started: true,
      runtimeImageBaseUrl: Config.imagesUrl,
      fastestApiBase: Config.baseUrl,
    },
  };
}

async function getCapabilitiesBundle(): Promise<CapabilitiesBundleContract> {
  return {
    source: JM_PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "capabilities" as const,
      actions: [
        {
          key: "speedtest",
          title: "测试所有线路速度",
          fnPath: "measureEndpointSpeeds",
        },
      ],
    },
    data: {
      actions: ["speedtest"],
    },
  };
}

function buildJmRankingScene() {
  return buildComicListScene({
    title: "禁漫排行榜",
    list: {
      fnPath: "getRankingData",
      extern: { source: "ranking" },
    },
    filter: {
      fnPath: "getRankingFilterBundle",
      extern: { source: "ranking" },
    },
  });
}

function buildJmRecommendScene() {
  return buildComicListScene({
    title: "推荐",
    list: {
      fnPath: "getRecommendData",
      extern: { source: "recommend" },
    },
  });
}

function buildJmLatestScene() {
  return buildComicListScene({
    title: "最新",
    list: {
      fnPath: "getLatestData",
      extern: { source: "latest" },
    },
  });
}

function buildJmCloudFavoriteScene() {
  return buildComicListScene({
    title: "云端收藏",
    list: {
      fnPath: "getCloudFavoriteData",
      extern: { source: "cloudFavorite", order: "mr", folderId: "" },
    },
    filter: {
      fnPath: "getCloudFavoriteFilterBundle",
      extern: { source: "cloudFavorite" },
    },
  });
}

async function getCloudFavoriteFilterBundle(
  payload: JmCloudFavoritePayload = {},
): Promise<FilterBundleContract> {
  const extern = toStringMap(payload.extern);
  const path = `${Config.baseUrl}/favorite`;
  const raw = (await jmRequest({
    path,
    method: "GET",
    params: { page: 1, folder_id: "", o: "mr" },
    cache: false,
    useJwt: payload.useJwt ?? true,
    jwtToken: payload.jwtToken,
  })) as Record<string, any>;

  const folderList = Array.isArray(raw.folder_list) ? raw.folder_list : [];
  const folderOptions = [
    {
      label: "默认",
      value: "",
      result: { extern: { folderId: "" } },
    },
    ...folderList.map((item: any) => ({
      label: String(item?.name ?? ""),
      value: String(item?.FID ?? ""),
      result: { extern: { folderId: String(item?.FID ?? "") } },
    })),
  ];

  return {
    source: JM_PLUGIN_ID,
    scheme: {
      version: "1.0.0" as const,
      type: "rankingFilter" as const,
      title: "云端收藏筛选",
      fields: [
        {
          key: "folderId",
          kind: "choice",
          label: "收藏夹",
          options: folderOptions,
        },
        {
          key: "order",
          kind: "choice",
          label: "排序",
          options: [
            {
              label: "收藏时间",
              value: "mr",
              result: { extern: { order: "mr" } },
            },
            {
              label: "更新时间",
              value: "mp",
              result: { extern: { order: "mp" } },
            },
          ],
        },
      ],
    },
    data: {
      values: {
        folderId: String(extern.folderId ?? ""),
        order: String(extern.order ?? "mr"),
      },
    },
  };
}

async function getCloudFavoriteSceneBundle(): Promise<ComicListSceneBundleContract> {
  return {
    source: JM_PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "comicListSceneBundle",
    },
    data: {
      scene: buildJmCloudFavoriteScene() as any,
    },
  };
}

async function getInfo(): Promise<InfoContract> {
  return buildPluginInfo({
    buildLatestScene: buildJmLatestScene,
    buildRankingScene: buildJmRankingScene,
  }) as InfoContract;
}

async function getFunctionPage(
  payload: Record<string, unknown> = {},
): Promise<FunctionPageContract> {
  const id = String(payload.id ?? toStringMap(payload.core).id ?? "").trim();
  if (id === "categories") {
    const categories = [
      ["同人", "doujin", "系列与角色同人", "people"],
      ["单本", "single", "完整单册", "menu_book"],
      ["短篇", "short", "碎片时间阅读", "auto_stories"],
      ["韩漫", "hanman", "纵向阅读作品", "view_day"],
      ["CG 图集", "doujin_CG", "图集与插画", "collections"],
      ["3D", "another_3d", "三维作品", "view_in_ar"],
      ["Cosplay", "another_cosplay", "角色扮演", "theater_comedy"],
      ["禁漫汉化组", "禁漫汉化组", "汉化作品", "translate"],
    ].map(([title, type, subtitle, icon]) => ({
      title,
      subtitle,
      icon,
      action: openComicListAction(buildComicListScene({
        title,
        list: {
          fnPath: "getRankingData",
          extern: { source: "ranking", type, order: "new", categoryScope: type },
        },
        filter: {
          fnPath: "getRankingFilterBundle",
          extern: { source: "ranking", type, order: "new", categoryScope: type },
        },
      })),
    }));
    return {
      source: JM_PLUGIN_ID,
      scheme: {
        version: "1.0.0",
        type: "page",
        title: "分类",
        body: {
          type: "list" as const,
          children: [{ type: "source-category-grid" as const, key: "categories" }],
        } as any,
      },
      data: { categories, hasReachedMax: true },
    };
  }
  if (id !== "recommend") {
    throw new Error(`未知功能: ${id}`);
  }

  const recommend = await getHomeRecommendData({ refresh: payload.refresh === true });
  const sections = Array.isArray((recommend as any)?.data?.sections)
    ? (recommend as any).data.sections
    : [];

  const pickedSections = sections
    .filter((section: any) => {
      const title = String(section?.title ?? "").trim();
      return title !== "禁漫小說" && title !== "禁漫書庫";
    })
    .map((section: any) => ({
      id: String(section?.id ?? ""),
      title: String(section?.title ?? ""),
      subtitle: String(section?.subtitle ?? ""),
      action: toStringMap(section?.action),
      body: {
        type: "comic-list",
        direction: "horizontal",
        key: "items",
        titleBelow: true,
      },
      items: Array.isArray(section?.items) ? section.items : [],
      raw: section?.raw ?? section,
    }));


  return {
    source: JM_PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "page",
      title: "推荐",
      body: {
        type: "list" as const,
        children: [{ type: "comic-section-list" as const, key: "sections" }],
      },
    },
    data: {
      sections: pickedSections,
      hasReachedMax: true,
    },
  };
}

async function getComicListSceneBundle(): Promise<ComicListSceneBundleContract> {
  return {
    source: JM_PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "comicListSceneBundle",
    },
    data: {
      scene: buildComicListScene({
        title: "禁漫排行榜",
        list: {
          fnPath: "getRankingData",
          extern: { source: "ranking" },
        },
        filter: {
          fnPath: "getRankingFilterBundle",
          extern: { source: "ranking" },
        },
      }) as any,
    },
  };
}

async function getRankingFilterBundle(
  payload: { extern?: Record<string, unknown> } = {},
): Promise<FilterBundleContract> {
  const extern = toStringMap(payload.extern);
  const selectedType = String(extern.type ?? "latest");
  const categoryScope = typeof extern.categoryScope === "string" ? extern.categoryScope : "";
  const categories = getJmRankingCategoryOptions();
  const scoped = categoryScope ? rankingCategoryForType(categories, categoryScope) : undefined;
  return {
    source: JM_PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "rankingFilter",
      title: "筛选漫画",
      ...(categoryScope ? { optionLayout: "wrap" } : {}),
      fields: [
        ...(!categoryScope || (scoped && scoped.children?.length) ? [{
          key: "category",
          kind: "choice" as const,
          label: scoped ? "子分类" : "分类",
          options: scoped
            ? [createChoiceOption("全部", scoped.value, scoped.result), ...(scoped.children ?? [])]
            : categories,
        }] : []),
        {
          key: "order",
          kind: "choice",
          label: "排序",
          options: getJmRankingOrderOptions(),
        },
      ],
    },
    data: {
      values: {
        category: scoped ? scoped.value : selectedType === "禁漫汉化组"
          ? "jm_translation_team"
          : selectedType,
        order: String(extern.order ?? "new"),
      },
    },
  };
}

function jmSearchScope(value: unknown): 0 | 2 | 3 {
  const mode = typeof value === "string" ? value.trim() : value;
  if (mode === 2 || mode === "2") return 2;
  if (mode === 3 || mode === "3") return 3;
  return 0;
}

async function getAdvancedSearchScheme(
  payload: { extern?: Record<string, unknown> } = {},
): Promise<AdvancedSearchContract> {
  const extern = toStringMap(payload.extern);
  return {
    source: JM_PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "advancedSearch",
      fields: [
        {
          key: "main_tag",
          kind: "choice",
          label: "搜索范围",
          options: [
            { label: "综合", value: 0 },
            { label: "作者", value: 2 },
            { label: "标签", value: 3 },
          ],
        },
        {
          key: "sortBy",
          kind: "choice",
          label: "排序",
          options: [
            { label: "从新到旧", value: 1 },
            { label: "最多观看", value: 2 },
            { label: "最多图片", value: 3 },
            { label: "最多点赞", value: 4 },
          ],
        },
      ],
    },
    data: {
      values: {
        main_tag: jmSearchScope(extern.main_tag),
        sortBy: toNum(extern.sortBy, 1),
      },
    },
  };
}

async function getWeekRankingFilterBundle(): Promise<FilterBundleContract> {
  return {
    source: JM_PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "weekRankingFilter",
      title: "筛选更新",
      fields: [
        {
          key: "week",
          kind: "choice",
          label: "星期",
          options: getJmWeekRankingWeekOptions(),
        },
        {
          key: "category",
          kind: "choice",
          label: "分类",
          options: getJmWeekRankingCategoryOptions(),
        },
      ],
    },
    data: {
      values: {
        week: getCurrentWeekRankingValue(),
        category: "all",
      },
    },
  };
}

async function getTimeRankingFilterBundle(
  payload: { tag?: string } = {},
): Promise<FilterBundleContract> {
  const tag = String(payload.tag ?? "").trim();
  const categoryOptions = getTimeRankingCategoryOptions(tag);
  return {
    source: JM_PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "timeRankingFilter",
      title: "筛选排行榜",
      fields: [
        {
          key: "order",
          kind: "choice",
          label: "排序",
          options: getTimeRankingOrderOptions(),
        },
        {
          key: "category",
          kind: "choice",
          label: "分类",
          options: categoryOptions,
        },
      ],
    },
    data: {
      values: {
        order: "new",
        category: categoryOptions[0]?.value ?? "",
      },
    },
  };
}

async function clearPluginSession() {
  await clearSession();

  return {
    ok: true,
    message: "jm 插件会话已清理",
  };
}

async function dumpRuntimeInfo() {
  return {
    ok: true,
    data: {
      pluginName: "jmComic",
      now: new Date().toISOString(),
    },
  };
}

function timestampToIso(value: unknown): string {
  const seconds = toNum(value, 0);
  if (seconds <= 0) {
    return "";
  }
  return new Date(seconds * 1000).toISOString();
}

function comicUpdateTime(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const text = String(value).trim();
  if (/^[1-9][0-9]{9}$/.test(text)) return timestampToIso(text);
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(text)) return "";
  const day = text.slice(0, 10);
  const calendarDate = new Date(day);
  return Number.isFinite(calendarDate.getTime()) &&
    calendarDate.toISOString().slice(0, 10) === day &&
    Number.isFinite(Date.parse(text)) ? text : "";
}

async function readJmFollowAlbum(path: string, comicId: string) {
  const revision = currentSessionRevision();
  const input = {
    path,
    method: "GET",
    params: { id: comicId },
    comicFollow: true,
  };
  try {
    return await jmRequest({ ...input, useJwt: false }, revision);
  } catch (error) {
    if (!(error instanceof JmFollowError) || error.reason !== "signInRequired") throw error;

    // Use the same configured API route only after a site-specific member
    // response. A gateway status alone must never receive a saved token.
    const route = new URL(path);
    if (route.protocol !== "https:" || route.username || route.password) {
      throw new JmFollowError("sourceUnavailable");
    }
    const saved = await loadPluginSetting("auth.jwt", "");
    const configuredJwt = typeof saved === "string" ? saved.trim() : "";
    const jwt = configuredJwt && !["null", "undefined"].includes(configuredJwt)
      ? configuredJwt
      : await getJwtToken(revision);
    assertCurrentSession(revision);
    if (!jwt) throw error;
    if (path !== `${Config.baseUrl}/album`) throw new JmFollowError("sourceUnavailable");
    return jmRequest(input, revision, jwt);
  }
}

function normalizeJmFollowSeries(response: Record<string, unknown>, albumId: number) {
  if (!Array.isArray(response.series)) throw new JmFollowError("invalidResponse");

  const chapters: Array<{ id: string; sort: number; name: string }> = [];
  const seen = new Set<number>();
  for (const raw of response.series) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new JmFollowError("invalidResponse");
    }
    const id = optionalJmCount(raw.id);
    const sort = raw.sort;
    const order = typeof sort === "number" || (typeof sort === "string" && sort.trim())
      ? Number(sort)
      : NaN;
    if (id === null || id <= 0 || !Number.isFinite(order) || order < 0) {
      throw new JmFollowError("invalidResponse");
    }
    if (order === 0) {
      if (id !== albumId) throw new JmFollowError("invalidResponse");
      continue;
    }
    if (seen.has(id)) throw new JmFollowError("invalidResponse");
    seen.add(id);
    chapters.push({
      id: String(id),
      sort: order,
      name: typeof raw.name === "string" ? raw.name : "",
    });
  }

  const parentId = optionalJmCount(response.series_id);
  // A one-shot has an explicit empty series (or its own cover row) and pages.
  // Missing lists, empty partial replies and redirected children are uncertain.
  if (chapters.length === 0 &&
      ((optionalJmCount(response.total_photos) ?? 0) <= 0 ||
       (parentId !== null && parentId !== 0 && parentId !== albumId))) {
    throw new JmFollowError("invalidResponse");
  }
  return normalizeJmSeries(chapters);
}

function jmDownloadTransportError(status: number) {
  return new Error(JSON.stringify({
    type: "comic_download_route_unavailable",
    reason: status === 429 ? "rateLimited" : "sourceUnavailable",
    retryable: true, httpStatus: status,
  }));
}

async function readAutomaticJmDownloadAlbum(payload: ComicDetailPayload, albumId: number) {
  const revision = currentSessionRevision();
  await waitForSessionWrites(revision);
  const readPin = async () => {
    await endpointWrites;
    const pin = await loadPluginSetting("network.apiBase", "", { strict: true });
    assertCurrentSession(revision);
    if (typeof pin !== "string") throw new Error("下载线路设置暂不可用，请重试");
    return pin.trim();
  };
  if (await readPin()) return null;

  const speed = await getEndpointSpeedCache().catch(() => null);
  const recent = speed && isRecentEndpointSpeed(speed) ? speed.api : [];
  const activeApi = jmDownloadBase(Config.baseUrl)?.origin;
  const candidates = rankedDownloadBases("", Config.baseUrl, currentApiBases(), recent).slice(0, 3);
  const chapterId = optionalJmCount(payload.extern?.chapterId);
  const read = (api: URL, jwt?: string) => readJmDownloadAlbum(api, albumId, revision, jwt).catch(() => {
    assertCurrentSession(revision);
    return "unavailable" as const;
  });
  const unavailable = () => new Error(JSON.stringify({ type: "comic_download_route_unavailable" }));
  const terminal = (reason: "notFound" | "sourceUnavailable", message: string) =>
    new Error(JSON.stringify({ type: "comic_detail_error", reason, message, retryable: false }));

  let lastTransportStatus: number | undefined;
  for (const api of candidates) {
    if (await readPin()) throw unavailable();
    let album = await read(api);
    if (await readPin()) throw unavailable();
    const current = api.origin === activeApi && api.origin === jmDownloadBase(Config.baseUrl)?.origin;
    if (album === "memberGate" && current) {
      // Only the active API may receive an existing session, and only after a
      // recognizable membership response on that exact origin.
      if (payload.useJwt === false) throw buildUnauthorizedError("请先登录禁漫账号");
      const saved = await loadPluginSetting("auth.jwt", "", { strict: true });
      const jwt = typeof saved === "string" ? saved.trim() : "";
      if (!jwt || jwt === "null" || jwt === "undefined") throw buildUnauthorizedError("请先登录禁漫账号");
      if (await readPin() || api.origin !== jmDownloadBase(Config.baseUrl)?.origin) throw unavailable();
      album = await read(api, jwt);
      if (await readPin() || api.origin !== jmDownloadBase(Config.baseUrl)?.origin) throw unavailable();
      if (album === "memberGate") throw buildUnauthorizedError("登录过期，请重新登录");
      if (album === "unavailable") throw unavailable();
    }
    if (album === "rateLimited") {
      throw jmDownloadTransportError(429);
    }
    if (current && album === "notFound") throw terminal("notFound", "作品已不存在或已下架");
    if (current && album === "restricted") {
      throw terminal("sourceUnavailable", "来源暂时限制访问此作品");
    }
    if (typeof album === "string") continue;
    if ("transportStatus" in album && typeof album.transportStatus === "number") {
      lastTransportStatus = album.transportStatus;
      continue;
    }
    if (current) return { album };
    // Use the validated catalog only if it includes the queued episode.
    try {
      const verifiedSeries = normalizeJmFollowSeries(album, albumId);
      const containsEpisode = verifiedSeries.length
        ? verifiedSeries.some((chapter) => optionalJmCount(chapter.id) === chapterId)
        : chapterId === albumId;
      if (containsEpisode) return { album, verifiedSeries };
    } catch (error) {
      if (!(error instanceof JmFollowError)) throw error;
    }
  }
  if (lastTransportStatus !== undefined) throw jmDownloadTransportError(lastTransportStatus);
  throw unavailable();
}

async function getComicDetail(
  payload: ComicDetailPayload = {},
): Promise<ComicDetailContract> {
  const comicId = String(payload.comicId ?? "").trim();
  const comicFollow = payload.extern?.comicFollow === true;
  const requestedId = Number(comicId);
  const validRequestedId = /^\d+$/.test(comicId) && Number.isSafeInteger(requestedId) && requestedId > 0;
  if (comicFollow && !validRequestedId) throw new JmFollowError("invalidResponse");
  if (!comicId) {
    throw new Error("comicId 不能为空");
  }

  const downloadAlbum = !comicFollow && payload.extern?.comicDownload === true && validRequestedId
    ? await readAutomaticJmDownloadAlbum(payload, requestedId)
    : null;
  const path = `${Config.baseUrl}/album`;
  const response = downloadAlbum?.album ?? unwrapJmAlbumPayload(comicFollow
    ? await readJmFollowAlbum(path, comicId)
    : await jmRequest({
        path,
        method: "GET",
        params: { id: comicId },
        useJwt: payload.useJwt ?? true,
        jwtToken: payload.jwtToken,
      }));

  const responseId = optionalJmCount(response.id);
  if (!validRequestedId || responseId === null || responseId !== requestedId ||
      typeof response.name !== "string" || !response.name.trim()) {
    if (comicFollow) throw new JmFollowError("invalidResponse");
    throw new Error("作品详情暂时无法读取，请重试");
  }
  const totalViews = optionalJmCount(response.total_views);
  const totalLikes = optionalJmCount(response.likes);
  const totalComments = optionalJmCount(response.comment_total);
  const totalPages = optionalJmCount(response.total_photos);
  const metricAvailability = {
    totalViews: totalViews !== null,
    totalLikes: totalLikes !== null,
    totalComments: totalComments !== null,
  };
  const descriptionKnown = typeof response.description === "string";
  const tagsKnown = Array.isArray(response.tags) && response.tags.every((tag) => typeof tag === "string");
  const fieldsMissing = [
    ...(!descriptionKnown ? ["description"] : []),
    ...(!tagsKnown ? ["tags"] : []),
  ];
  const publicTags = Array.isArray(response.tags)
    ? response.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const series = comicFollow
    ? normalizeJmFollowSeries(response, requestedId)
    : downloadAlbum?.verifiedSeries ?? normalizeJmSeries(response.series as any[]);
  const normalizedInfo = {
    ...response,
    id: toNum(response.id),
    name: String(response.name ?? ""),
    description: descriptionKnown ? response.description as string : "",
    addtime: String(response.addtime ?? "0"),
    total_views: totalViews === null ? null : String(totalViews),
    likes: totalLikes === null ? null : String(totalLikes),
    comment_total: totalComments === null ? null : String(totalComments),
    author: toStrList(response.author),
    tags: toStrList(publicTags),
    works: toStrList(response.works),
    actors: toStrList(response.actors),
    related_list: !comicFollow && Array.isArray(response.related_list)
      ? response.related_list
      : [],
    liked: toBool(response.liked),
    is_favorite: toBool(response.is_favorite),
    is_aids: toBool(response.is_aids),
    price: String(response.price ?? "0"),
    purchased: String(response.purchased ?? "0"),
    series,
  };

  const normal: ComicDetailNormal = {
    comicInfo: {
      id: comicFollow ? comicId : String(normalizedInfo.id),
      title: normalizedInfo.name,
      titleMeta: [
        ...(totalViews === null ? [] : [createActionItem(`浏览：${totalViews}`, {}, { metric: "totalViews" })]),
        ...(timestampToIso(normalizedInfo.addtime)
          ? [createActionItem(`更新：${timestampToIso(normalizedInfo.addtime).slice(0, 10)}`)]
          : []),
        ...(Array.isArray(response.series)
          ? [createActionItem(`章节数：${normalizedInfo.series.length || 1}`)]
          : []),
        ...(totalPages !== null && totalPages > 0
          ? [createActionItem(`页数：${totalPages}`)]
          : []),
      ],
      creator: {
        id: "",
        name: "",
        avatar: createImage({
          id: "",
          url: "",
          name: "",
        }),
        onTap: {},
        extern: {},
      },
      description: normalizedInfo.description,
      cover: createImage({
        id: String(normalizedInfo.id),
        url: buildJmCoverUrl(normalizedInfo),
        path: `${normalizedInfo.id}.jpg`,
        extern: {},
      }),
      metadata: [
        createMetadataActionList(
          "author",
          "作者",
          normalizedInfo.author,
          (item) =>
            createActionItem(
              item,
              openSearchAction({
                source: JM_PLUGIN_ID,
                keyword: item,
                extern: { main_tag: 2 },
              }),
            ),
        ),
        createMetadataActionList("tags", "标签", normalizedInfo.tags, (item) =>
          createActionItem(
            item,
            openSearchAction({
              source: JM_PLUGIN_ID,
              keyword: item,
              extern: { main_tag: 3 },
            }),
          ),
        ),
        createMetadataActionList(
          "works",
          "作品",
          normalizedInfo.works,
          (item) =>
            createActionItem(
              item,
              openSearchAction({ source: JM_PLUGIN_ID, keyword: item }),
            ),
        ),
        createMetadataActionList(
          "actors",
          "角色",
          normalizedInfo.actors,
          (item) =>
            createActionItem(
              item,
              openSearchAction({ source: JM_PLUGIN_ID, keyword: item }),
            ),
        ),
      ].filter((item): item is NonNullable<typeof item> => item != null),
      extern: {},
    },
    eps: (() => {
      const mapped = normalizedInfo.series.map((item: any) => ({
        id: String(item?.id ?? ""),
        requestId: String(item?.id ?? ""),
        logicalKey: String(item?.id ?? ""),
        storageChapterId: String(item?.id ?? ""),
        name: String(item?.name ?? ""),
        order: toNum(item?.order, 0),
        extern: {
          sort: toNum(item?.rawOrder, toNum(item?.sort, 0)),
        },
      }));

      if (mapped.length > 0) {
        return mapped;
      }

      return [
        {
          id: String(normalizedInfo.id),
          requestId: String(normalizedInfo.id),
          logicalKey: String(normalizedInfo.id),
          storageChapterId: String(normalizedInfo.id),
          name: "第1话",
          order: 1,
          extern: {
            sort: 1,
          },
        },
      ];
    })(),
    recommend: (normalizedInfo.related_list as any[]).map(
      (item: any): RecommendItem => {
        const unifiedItem = toComicItem(item);
        return {
          source: JM_PLUGIN_ID,
          id: unifiedItem.id,
          title: unifiedItem.title,
          subtitle: unifiedItem.subtitle,
          finished: unifiedItem.finished,
          likesCount: unifiedItem.likesCount,
          viewsCount: unifiedItem.viewsCount,
          updatedAt: unifiedItem.updatedAt,
          cover: createImage({
            id: unifiedItem.id,
            url: buildJmCoverUrl(item),
            path: `${unifiedItem.id}.jpg`,
            extern: {},
          }),
          metadata: [],
          raw: unifiedItem.raw,
          extern: {
            unifiedItem,
          },
        };
      },
    ),
    totalViews: totalViews ?? 0,
    totalLikes: totalLikes ?? 0,
    totalComments: totalComments ?? 0,
    isFavourite: !comicFollow && toBool(normalizedInfo.is_favorite),
    isLiked: !comicFollow && toBool(normalizedInfo.liked),
    allowComments: true,
    allowLike: true,
    allowCollected: true,
    allowDownload: true,
    extern: { metricAvailability, fieldsMissing, canUnlike: false },
  };

  const scheme = {
    version: "1.0.0" as const,
    type: "comicDetail" as const,
    source: JM_PLUGIN_ID,
  };

  const data: ComicDetailData = {
    normal,
    raw: comicFollow ? {} : {
      comicInfo: normalizedInfo,
    },
  };

  return {
    source: JM_PLUGIN_ID,
    comicId,
    extern: payload.extern ?? null,
    scheme,
    data,
  };
}

async function searchComic(payload: JmSearchPayload = {}) {
  const extern = toStringMap(payload.extern);
  const page = Math.max(1, toNum(payload.page, 1));
  const keyword = String(payload.keyword ?? extern.keyword ?? "").trim();
  const keywordLower = keyword.toLowerCase();
  const scope = jmSearchScope(extern.main_tag);
  const order = String(extern.sort ?? sortByToOrder(extern.sortBy)).trim();
  const path =
    String(payload.path ?? extern.path ?? "").trim() ||
    `${Config.baseUrl}/search`;
  const searchPageSize = 80;
  const buildResult = (content: any[], total: number) => {
    const scheme = {
      version: "1.0.0",
      type: "searchResult",
      source: JM_PLUGIN_ID,
      list: "comicGrid",
    };

    const data = {
      paging: {
        page,
        pages: total > 0 ? Math.max(1, Math.ceil(total / searchPageSize)) : page,
        total,
        hasReachedMax:
          content.length === 0 ||
          content.length < searchPageSize ||
          (total > 0 && (page - 1) * searchPageSize + content.length >= total),
      },
      items: content.map((item: any) => toComicItem(item)),
    };

    return {
      source: JM_PLUGIN_ID,
      extern: {
        ...extern,
        sortBy: toNum(extern.sortBy, 1),
      },
      scheme,
      data,
      paging: data.paging,
      items: data.items,
    };
  };

  if (
    scope === 0 &&
    (Number(keyword) >= 100 || keywordLower.startsWith("jm")) &&
    page === 1
  ) {
    const comicId = keywordLower.startsWith("jm")
      ? keyword.slice(2).trim()
      : keyword;
    if (comicId) {
      try {
        const detailResponse = await getComicDetail({
          comicId,
          useJwt: payload.useJwt,
          jwtToken: payload.jwtToken,
        });
        const comicInfo = (detailResponse?.data?.raw as Record<string, any>)
          ?.comicInfo as Record<string, any> | undefined;
        if (comicInfo?.id) {
          return buildResult(
            [
              {
                ...comicInfo,
                author: Array.isArray(comicInfo.author)
                  ? comicInfo.author.join("/")
                  : comicInfo.author,
                total_views: comicInfo.total_views ?? comicInfo.totalViews,
                update_at: comicInfo.update_at ?? comicInfo.addtime,
              },
            ],
            1,
          );
        }
      } catch (_error) {
        // ignore direct-id fallback failure and continue with normal search
      }
    }
  }

  const response = (await jmRequest({
    path,
    method: "GET",
    params: {
      search_query: keyword,
      page,
      o: order,
      ...(scope === 0 ? {} : { main_tag: scope }),
    },
    useJwt: payload.useJwt ?? true,
    jwtToken: payload.jwtToken,
  })) as Record<string, any>;

  const content = Array.isArray(response.content) ? response.content : [];

  return buildResult(content, toNum(response.total, content.length));
}

function buildHomeSectionAction(section: any) {
  const title = String(section?.title ?? "").trim();
  const id = String(section?.id ?? "").trim();

  if (
    title.includes("推荐") ||
    title.includes("推薦") ||
    id === "30" ||
    title === "禁漫去码&全彩化" ||
    title === "禁漫去碼&全彩化"
  ) {
    return openComicListAction(
      buildComicListScene({
        title,
        list: {
          fnPath: "getPromoteListData",
          core: {
            id: toNum(id),
            path: `${Config.baseUrl}/promote_list`,
          },
          extern: {
            source: "promoteList",
            pages: 27,
          },
        },
      }),
    );
  }
  if (id === "26" || title.endsWith("连载更新")) {
    return openComicListAction(
      buildComicListScene({
        title: "每周连载更新",
        list: {
          fnPath: "getWeekRankingData",
          extern: { source: "weekRanking" },
        },
        filter: {
          fnPath: "getWeekRankingFilterBundle",
          extern: { source: "weekRanking" },
        },
      }),
    );
  }
  if (id === "998" || title === "禁漫汉化组") {
    return openComicListAction(
      buildComicListScene({
        title,
        list: {
          fnPath: "getRankingData",
          extern: { source: "ranking" },
        },
        filter: {
          fnPath: "getTimeRankingFilterBundle",
          core: { tag: "禁漫汉化组" },
          extern: { source: "timeRanking" },
        },
      }),
    );
  }
  if (id === "999" || title === "韩漫更新") {
    return openComicListAction(
      buildComicListScene({
        title,
        list: {
          fnPath: "getRankingData",
          extern: { source: "ranking" },
        },
        filter: {
          fnPath: "getTimeRankingFilterBundle",
          core: { tag: "hanManTypeMap" },
          extern: { source: "timeRanking" },
        },
      }),
    );
  }
  if (id === "1000" || title === "其他更新") {
    return openComicListAction(
      buildComicListScene({
        title,
        list: {
          fnPath: "getRankingData",
          extern: { source: "ranking" },
        },
        filter: {
          fnPath: "getTimeRankingFilterBundle",
          core: { tag: "qiTaLeiTypeMap" },
          extern: { source: "timeRanking" },
        },
      }),
    );
  }

  return {
    type: "none",
    payload: {},
  };
}

async function getHomeRecommendData(payload: JmHomePayload = {}) {
  const extern = toStringMap(payload.extern);
  const promotePath =
    String(payload.path ?? extern.promotePath ?? "").trim() ||
    `${Config.baseUrl}/promote?page=0`;

  const promote = await jmRequest({
    path: promotePath,
    method: "GET",
    cache: payload.refresh !== true,
    useJwt: payload.useJwt ?? true,
    jwtToken: payload.jwtToken,
  });

  const normalizedSections = await Promise.all(
    (Array.isArray(promote) ? promote : []).map(async (section: any) => ({
      ...section,
      title: await normalizeHomeSectionTitle(section?.title),
    })),
  );

  const sections = normalizedSections
    .filter((section: any) => {
      const title = String(section?.title ?? "");
      return title !== "禁漫书库" && title !== "禁漫小说";
    })
    .map((section: any) => ({
      id: String(section?.id ?? ""),
      title: String(section?.title ?? ""),
      subtitle: "",
      action: buildHomeSectionAction(section),
      body: {
        type: "comic-list",
        direction: "horizontal",
        key: "items",
      },
      items: (Array.isArray(section?.content) ? section.content : []).map(
        toComicItem,
      ),
      raw: section,
    }));

  return {
    source: JM_PLUGIN_ID,
    extern: payload.extern ?? null,
    scheme: {
      version: "1.0.0",
      type: "homeRecommend",
    },
    data: {
      sections,
      hasReachedMax: true,
    },
  };
}

async function getHomeLatestData(payload: JmHomePayload = {}) {
  const extern = toStringMap(payload.extern);
  const page = Number.isFinite(Number(payload.page)) ? Number(payload.page) : 0;
  const path =
    String(payload.path ?? extern.suggestionPath ?? "").trim() ||
    `${Config.baseUrl}/latest`;
  const suggestion = await jmRequest({
    path,
    method: "GET",
    params: { page: Math.max(0, page) },
    cache: payload.refresh !== true,
    useJwt: payload.useJwt ?? true,
    jwtToken: payload.jwtToken,
  });

  const suggestionItems = (Array.isArray(suggestion) ? suggestion : []).map(
    toComicItem,
  );

  return {
    source: JM_PLUGIN_ID,
    extern: payload.extern ?? null,
    scheme: {
      version: "1.0.0",
      type: "homeLatest",
    },
    data: {
      page,
      suggestionItems,
      hasReachedMax: suggestionItems.length < 80,
    },
  };
}

async function getRankingData(payload: JmRankingPayload = {}) {
  const page = Number.isFinite(Number(payload.page)) ? Number(payload.page) : 0;
  const extern = toStringMap(payload.extern);
  const selected = String(extern.type ?? extern.c ?? "");
  const scope = typeof extern.categoryScope === "string" ? extern.categoryScope : "";
  const scoped = scope ? rankingCategoryForType(getJmRankingCategoryOptions(), scope) : undefined;
  const c = !scope || selected === scope || rankingCategoryForType(scoped?.children ?? [], selected)
    ? selected : scope;
  const o = String(extern.order ?? extern.o ?? "");
  const path = `${Config.baseUrl}/categories/filter`;
  const rankingPageSize = 80;

  const raw = await jmRequest({
    path,
    method: "GET",
    params: { page, c, o },
    cache: payload.refresh !== true,
    useJwt: payload.useJwt ?? true,
    jwtToken: payload.jwtToken,
  });

  const total = toNum((raw as any)?.total, 0);
  const content = Array.isArray((raw as any)?.content)
    ? (raw as any).content
    : [];
  const loadedCount = Math.max(0, page - 1) * rankingPageSize + content.length;
  const hasReachedMax =
    content.length === 0 ||
    content.length < rankingPageSize ||
    (total > 0 && loadedCount >= total);

  return {
    source: JM_PLUGIN_ID,
    extern: payload.extern ?? null,
    scheme: {
      version: "1.0.0",
      type: "rankingFeed",
      card: "comic",
    },
    data: {
      page,
      total,
      hasReachedMax,
      items: content.map((item: any) => toComicItem(item)),
      raw,
    },
  };
}

async function getPromoteListData(payload: JmPromoteListPayload = {}) {
  const id = toNum(payload.id, 0);
  const page = Math.max(0, toNum(payload.page, 0));
  const path = `${Config.baseUrl}/promote_list`;
  const pageSize = 27;

  const raw = (await jmRequest({
    path,
    method: "GET",
    params: { id, page },
    cache: payload.refresh !== true,
    useJwt: payload.useJwt ?? true,
    jwtToken: payload.jwtToken,
  })) as Record<string, any>;

  const total = toNum(raw.total, 0);
  const list = Array.isArray(raw.list) ? raw.list : [];
  const loadedCount = Math.max(0, page - 1) * pageSize + list.length;
  const hasReachedMax =
    list.length === 0 ||
    list.length < pageSize ||
    (total > 0 && loadedCount >= total);

  return {
    source: JM_PLUGIN_ID,
    extern: payload.extern ?? null,
    scheme: {
      version: "1.0.0",
      type: "promoteListFeed",
      card: "comic",
    },
    data: {
      id,
      page,
      total,
      hasReachedMax,
      items: list.map((item: any) => toComicItem(item)),
      raw,
    },
  };
}

async function getLatestData(payload: JmRankingPayload = {}) {
  const page = Math.max(1, toNum(payload.page, 1));
  if (page == 1) {
    const latest = await getHomeLatestData({
      page: 0,
      path: undefined,
      useJwt: payload.useJwt,
      jwtToken: payload.jwtToken,
      refresh: payload.refresh,
    });
    const list = Array.isArray((latest as any)?.data?.suggestionItems)
      ? (latest as any).data.suggestionItems
      : [];

    return {
      source: JM_PLUGIN_ID,
      extern: payload.extern ?? null,
      scheme: {
        version: "1.0.0",
        type: "latestFeed",
        card: "comic",
      },
      data: {
        page,
        hasReachedMax: list.length < 80,
        items: list,
        raw: latest,
      },
    };
  }

  const requestPage = Math.max(0, page - 1);
  const path = `${Config.baseUrl}/latest`;
  const pageSize = 80;
  const raw = await jmRequest({
    path,
    method: "GET",
    params: { page: requestPage },
    cache: payload.refresh !== true,
    useJwt: payload.useJwt ?? true,
    jwtToken: payload.jwtToken,
  });


  const list = Array.isArray(raw) ? raw : [];
  return {
    source: JM_PLUGIN_ID,
    extern: payload.extern ?? null,
    scheme: {
      version: "1.0.0",
      type: "latestFeed",
      card: "comic",
    },
    data: {
      page,
      hasReachedMax: list.length === 0 || list.length < pageSize,
      items: list.map((item: any) => toComicItem(item)),
      raw,
    },
  };
}

async function getCloudFavoriteData(payload: JmCloudFavoritePayload = {}) {
  const page = Math.max(1, optionalJmCount(payload.page) ?? 1);
  const extern = toStringMap(payload.extern);
  const folderId = String(payload.folderId ?? extern.folderId ?? "");
  const order = String(payload.order ?? extern.order ?? "mr") || "mr";
  const request = await openJmFavoriteRequest(payload);
  const result = toStringMap(await request("/favorite", {
    method: "GET",
    params: { page, folder_id: folderId, o: order },
  }));
  const raw = Array.isArray(result.list) ? result : toStringMap(result.data);
  const list = raw.list;
  const total = optionalJmCount(raw.total);
  const offset = (page - 1) * 20;
  if (!Array.isArray(list) ||
      (list.length === 0 ? total === null || total > offset : total !== null && total < offset + list.length) ||
      list.some((item) => !optionalJmCount(toStringMap(item).id))) {
    throw new JmRequestError("收藏资料读取不完整，请重试");
  }

  return {
    source: JM_PLUGIN_ID,
    extern: payload.extern ?? null,
    scheme: {
      version: "1.0.0",
      type: "cloudFavoriteFeed",
      card: "comic",
    },
    data: {
      page,
      ...(total === null ? {} : { total }),
      hasReachedMax: total !== null && page * 20 >= total,
      items: list.map(toComicItem),
      raw,
    },
  };
}

function isJmLikeTransportFailure(error: unknown) {
  if (isTransientError(error)) return true;
  // QuickJS Fetch puts the native transport failure in a TypeError. Axios
  // does not always attach a transport code to that error.
  return axios.isAxiosError(error) && !error.response && error.name === "TypeError" &&
    /^(?:Failed to (?:send HTTP request|parse HTTP response headers|read HTTP response body bytes)|发送 HTTP 请求失败|解析 HTTP 响应头失败|读取 HTTP 响应体字节失败)/i.test(error.message);
}

async function toggleLike(
  payload: JmLikePayload = {},
): Promise<ToggleLikeResult & { verified: true; totalLikes?: number; likeDiagnostic?: JmLikeDiagnostic }> {
  const comicId = String(payload.comicId ?? "").trim();
  const requestedId = optionalJmCount(comicId);
  if (requestedId === null || requestedId === 0) {
    throw new JmRequestError("作品编号无效");
  }

  if (toBool(payload.currentLiked, false)) {
    throw new JmRequestError("禁漫暂不支持取消点赞");
  }

  const revision = currentSessionRevision();
  const baseUrl = Config.baseUrl;
  await waitForSessionWrites(revision);
  const useJwt = payload.useJwt !== false;
  const configuredJwt = useJwt
    ? String(payload.jwtToken ?? "").trim() ||
      String(await loadPluginSetting("auth.jwt", "", { strict: true }) ?? "").trim()
    : "";
  const requestJwt = useJwt && !configuredJwt ? await getJwtToken(revision)
    : configuredJwt === "null" || configuredJwt === "undefined" ? "" : configuredJwt;
  assertCurrentSession(revision);
  // Axios merges its request configuration. Use a callback to preserve one
  // diagnostics object for both requests without exposing it in either request.
  const diagnostic: JmLikeDiagnostic | undefined = payload.includeLikeDiagnostic === true ? {} : undefined;
  const options = { cache: false, comicLike: true, useJwt, likeDiagnostic: diagnostic ? () => diagnostic : undefined };
  try {
    await jmRequest({
      ...options,
      path: `${baseUrl}/like`,
      method: "POST",
      formData: { id: comicId },
    }, revision, requestJwt);
  } catch (error) {
    assertCurrentSession(revision);
    const transport = isJmLikeTransportFailure(error);
    if (!transport && !(error instanceof JmLikeUnconfirmedError)) throw error;
    // The server may have applied a write whose receipt never reached us.
    if (transport) recordJmLikeStage(diagnostic, "submit", "transport");
  }

  let album: Record<string, unknown>;
  try {
    album = unwrapJmAlbumPayload(await jmRequest({
      ...options,
      path: `${baseUrl}/album`,
      method: "GET",
      params: { id: comicId },
    }, revision, requestJwt));
  } catch (error) {
    assertCurrentSession(revision);
    if (!isJmLikeTransportFailure(error)) throw error;
    recordJmLikeStage(diagnostic, "readback", "transport");
    throw new JmLikeUnconfirmedError(diagnostic);
  }
  assertCurrentSession(revision);
  const albumId = optionalJmCount(album.id);
  const work = albumId === null ? "unknown" : albumId === requestedId ? "match" : "mismatch";
  const hasLiked = Object.prototype.hasOwnProperty.call(album, "liked");
  const likedField = album.liked;
  const likedType = !hasLiked ? "missing" : likedField === null ? "null" :
    Array.isArray(likedField) ? "array" : typeof likedField;
  const liked = toBool(likedField) ? "true" : !toBool(likedField, true) ? "false" : "unknown";
  const totalLikes = optionalJmCount(album.likes);
  const previous = optionalJmCount(payload.previousTotalLikes);
  const total = totalLikes !== null ? "present" :
    Object.prototype.hasOwnProperty.call(album, "likes") ? "invalid" : "missing";
  const totalChange = work !== "match" || totalLikes === null || previous === null ? "unknown" :
    totalLikes === previous ? "unchanged" : "changed";
  const result = work === "match" && liked === "true" ? "confirmed" : "unconfirmed";
  if (diagnostic) diagnostic.verify = { result, work, likedType, liked, total, totalChange };
  // Log only classifications. Never include raw fields, IDs, credentials, or URLs.
  console.info(`[jm.like] verify result=${result} work=${work} likedType=${likedType} liked=${liked} total=${total} totalChange=${totalChange}`);
  if (result !== "confirmed") {
    throw new JmLikeUnconfirmedError(diagnostic);
  }
  return {
    liked: true,
    verified: true,
    ...(diagnostic ? { likeDiagnostic: diagnostic } : {}),
    ...(totalLikes === null ? {} : { totalLikes }),
  };
}

async function openJmFavoriteRequest(payload: { useJwt?: boolean; jwtToken?: string }) {
  const revision = currentSessionRevision();
  const baseUrl = Config.baseUrl;
  await waitForSessionWrites(revision);
  const useJwt = payload.useJwt !== false;
  const configured = useJwt ? String(payload.jwtToken ?? "").trim() ||
    String(await loadPluginSetting("auth.jwt", "", { strict: true }) ?? "").trim() : "";
  const jwt = useJwt && !configured ? await getJwtToken(revision) : configured;
  assertCurrentSession(revision);
  if (!jwt || jwt === "null" || jwt === "undefined") {
    throw buildUnauthorizedError("请先登录禁漫天堂");
  }
  return (route: string, options: RequestPayload) => jmRequest({
    ...options, path: `${baseUrl}${route}`, comicFavorite: true, cache: false, useJwt,
  }, revision, jwt);
}

async function toggleFavorite(
  payload: JmToggleFavoritePayload = {},
): Promise<ToggleFavoriteResult> {
  const comicId = String(payload.comicId ?? "").trim();
  if (!comicId) throw new Error("comicId 不能为空");

  const request = await openJmFavoriteRequest(payload);
  const result = toStringMap(await request("/favorite", {
    method: "POST", formData: { aid: comicId },
  }));
  const body = toStringMap(result.data);
  const status = body.status ?? result.status;
  const type = body.type ?? result.type;
  if (status !== "ok" || (type !== "add" && type !== "remove")) {
    throw new JmRequestError("禁漫未确认收藏状态，请重新打开作品查看");
  }
  const favorited = type === "add";

  return {
    favorited,
    nextStep: favorited ? "selectFolder" : "none",
  };
}

async function listFavoriteFolders(
  payload: JmFavoriteFolderPayload = {},
): Promise<ListFavoriteFoldersResult> {
  const path = `${Config.baseUrl}/favorite`;
  const raw = (await jmRequest({
    path,
    method: "GET",
    params: { page: 1, folder_id: "", o: "mr" },
    cache: false,
    useJwt: payload.useJwt ?? true,
    jwtToken: payload.jwtToken,
  })) as Record<string, any>;

  const folders = Array.isArray(raw.folder_list) ? raw.folder_list : [];
  return {
    items: folders.map((item: any) => ({
      id: String(item?.FID ?? ""),
      name: String(item?.name ?? ""),
    })),
  };
}

async function moveFavoriteToFolder(payload: JmFavoriteFolderPayload = {}) {
  const comicId = String(payload.comicId ?? "").trim();
  const folderId = String(payload.folderId ?? "").trim();
  const folderName = String(payload.folderName ?? "").trim();
  const id = optionalJmCount(comicId);
  const target = optionalJmCount(folderId);
  if (!id || !target) {
    throw new Error("作品或收藏夹编号无效");
  }

  const request = await openJmFavoriteRequest(payload);
  await request("/favorite_folder", {
    method: "POST",
    formData: {
      type: "move",
      folder_id: folderId,
      folder_name: folderName,
      aid: comicId,
    },
  });

  // The move response has no known receipt identifying both work and folder.
  // Look for positive membership in the selected folder with bounded reads.
  for (let page = 1; page <= 2; page++) {
    const result = toStringMap(await request("/favorite", {
      method: "GET", params: { page, folder_id: folderId, o: "mr" },
    }));
    const folder = Array.isArray(result.list) ? result : toStringMap(result.data);
    const rows = folder.list;
    if (!Array.isArray(rows)) break;
    if (rows.some((row) => optionalJmCount(toStringMap(row).id) === id)) return { ok: true };
    const total = optionalJmCount(folder.total);
    if (rows.length < 20 || (total !== null && total <= page * 20)) break;
  }
  throw new JmRequestError("暂时无法确认已移入收藏夹，请打开目标收藏夹查看");
}

function buildJmUserCover(photo: unknown): string {
  const file = String(photo ?? "").trim();
  if (!file) {
    return "";
  }
  if (file.startsWith("http://") || file.startsWith("https://")) {
    return file;
  }
  return `${Config.imagesUrl}/media/users/${file}`;
}

function mapJmReplyItem(item: any) {
  const id = String(item?.CID ?? "");
  const photo = String(item?.photo ?? "").trim();
  return {
    id,
    author: {
      name: String(item?.nickname ?? item?.username ?? "匿名用户"),
      avatar: {
        url: buildJmUserCover(photo),
        path: photo ? `${String(item?.UID ?? "")}.jpg` : "",
        extern: {
          path: photo ? `${String(item?.UID ?? "")}.jpg` : "",
        },
      },
    },
    content: stripHtmlTags(item?.content),
    createdAt: formatDisplayTime(item?.addtime),
    extern: {
      commentId: id,
    },
  };
}

function mapJmCommentItem(item: any) {
  const id = String(item?.CID ?? "");
  const photo = String(item?.photo ?? "").trim();
  const replies = Array.isArray(item?.replys) ? item.replys : [];
  return {
    id,
    author: {
      name: String(item?.nickname ?? item?.username ?? "匿名用户"),
      avatar: {
        url: buildJmUserCover(photo),
        path: photo ? `${String(item?.UID ?? "")}.jpg` : "",
        extern: {
          path: photo ? `${String(item?.UID ?? "")}.jpg` : "",
        },
      },
    },
    content: stripHtmlTags(item?.content),
    createdAt: formatDisplayTime(item?.addtime),
    replyCount: replies.length,
    replies: replies.map((reply: any) => mapJmReplyItem(reply)),
    extern: {
      commentId: id,
    },
  };
}

async function getCommentFeed(
  payload: JmCommentFeedPayload = {},
): Promise<CommentFeedContract> {
  const comicId = String(payload.comicId ?? "").trim();
  const page = Math.max(1, toNum(payload.page, 1));
  if (!comicId) {
    throw new Error("comicId 不能为空");
  }

  const path = `${Config.baseUrl}/forum`;
  const raw = (await jmRequest({
    path,
    method: "GET",
    params: { page, mode: "manhua", aid: comicId },
    cache: false,
    useJwt: payload.useJwt ?? true,
    jwtToken: payload.jwtToken,
  })) as Record<string, any>;

  const list = Array.isArray(raw?.list) ? raw.list : [];
  const total = toNum(raw?.total, 0);
  const pageSize = 10;
  const hasReachedMax = list.length < pageSize || page * pageSize >= total;

  const loggedIn = await isJmLoggedIn();
  const commentEnabled = await isCommentEnabled();

  return {
    source: JM_PLUGIN_ID,
    extern: payload.extern ?? null,
    scheme: {
      version: "1.0.0",
      type: "commentFeed",
    },
    data: {
      replyMode: "embedded",
      canComment: {
        comic: commentEnabled && loggedIn,
        reply: commentEnabled && loggedIn,
      },
      paging: {
        hasReachedMax,
      },
      topItems: [],
      items: list.map((item: any) => mapJmCommentItem(item)),
    },
  };
}

const JM_COMMENT_LOGIN_HINTS = [
  "請先登入會員",
  "请先登入会员",
  "請先登入",
  "请先登录",
  "請先登錄",
  "请先登錄",
];

function isJmLoginRequiredMessage(message: string): boolean {
  const text = String(message || "").trim();
  if (!text) {
    return false;
  }
  if (JM_COMMENT_LOGIN_HINTS.some((hint) => text.includes(hint))) {
    return true;
  }
  const lower = text.toLowerCase();
  return lower.includes("not logged") || lower.includes("unauthorized");
}

function pickJmCommentResponse(raw: unknown): {
  status: string;
  msg: string;
} {
  const root = (raw ?? {}) as Record<string, any>;
  const payload =
    root.data && typeof root.data === "object" && !Array.isArray(root.data)
      ? (root.data as Record<string, any>)
      : root;

  const status = String(payload?.status ?? root?.status ?? "")
    .trim()
    .toLowerCase();
  const msg = String(
    payload?.msg ??
      payload?.message ??
      payload?.errorMsg ??
      root?.msg ??
      root?.message ??
      root?.errorMsg ??
      "",
  ).trim();

  return { status, msg };
}

async function submitJmComment(input: {
  comicId: string;
  content: string;
  commentId: string;
  path?: string;
  useJwt?: boolean;
  jwtToken?: string;
}) {
  const response = await jmRequest({
    path: input.path?.trim() || `${Config.baseUrl}/comment`,
    method: "POST",
    formData: {
      aid: input.comicId,
      comment: input.content,
      comment_id: input.commentId,
    },
    cache: false,
    useJwt: input.useJwt ?? true,
    jwtToken: input.jwtToken,
  });

  const { status, msg } = pickJmCommentResponse(response);
  const succeeded = status === "ok" || status === "success";
  if (!succeeded) {
    const message = msg || (status ? `评论发送失败 (${status})` : "评论发送失败");
    if (isJmLoginRequiredMessage(message)) {
      throw buildUnauthorizedError("登录已失效，请重新登录后再评论");
    }
    throw new Error(message);
  }
}

async function postComment(
  payload: JmCommentPostPayload = {},
): Promise<CommentMutationContract> {
  const comicId = String(payload.comicId ?? "").trim();
  const content = String(payload.content ?? "").trim();
  if (!comicId) {
    throw new Error("comicId 不能为空");
  }
  if (!content) {
    throw new Error("评论内容不能为空");
  }

  if (!(await isCommentEnabled())) {
    throw new Error("评论功能已关闭，请在插件设置中开启「允许发表评论」");
  }

  await submitJmComment({
    comicId,
    content,
    commentId: "0",
    path: payload.path,
    useJwt: payload.useJwt,
    jwtToken: payload.jwtToken,
  });

  return {
    source: JM_PLUGIN_ID,
    scheme: { version: "1.0.0", type: "commentMutation" },
    data: {
      ok: true,
      mode: "postComment",
      created: null,
      insertHint: {
        strategy: "prependAfterTop",
        needsRefetch: true,
      },
    },
  };
}

async function postCommentReply(
  payload: JmCommentReplyPayload = {},
): Promise<CommentMutationContract> {
  const comicId = String(payload.comicId ?? "").trim();
  const commentId = String(
    payload.commentId ?? payload.extern?.commentId ?? "",
  ).trim();
  const content = String(payload.content ?? "").trim();
  if (!comicId) {
    throw new Error("comicId 不能为空");
  }
  if (!commentId) {
    throw new Error("commentId 不能为空");
  }
  if (!content) {
    throw new Error("评论内容不能为空");
  }

  if (!(await isCommentEnabled())) {
    throw new Error("评论功能已关闭，请在插件设置中开启「允许发表评论」");
  }

  await submitJmComment({
    comicId,
    content,
    commentId,
    path: payload.path,
    useJwt: payload.useJwt,
    jwtToken: payload.jwtToken,
  });

  return {
    source: JM_PLUGIN_ID,
    scheme: { version: "1.0.0", type: "commentMutation" },
    data: {
      ok: true,
      mode: "postReply",
      parentId: commentId,
      created: null,
      insertHint: {
        strategy: "prepend",
        targetCommentId: commentId,
        needsRefetch: true,
      },
    },
  };
}

async function getWeekRankingData(payload: JmWeekRankingPayload = {}) {
  const date = toNum(payload.date, 0);
  const type = String(payload.type ?? "all");
  const page = Math.max(1, toNum(payload.page, 1));
  const path = `${Config.baseUrl}/serialization`;
  const pageSize = 40;

  const raw = await jmRequest({
    path,
    method: "GET",
    params: { date, type, page },
    cache: payload.refresh !== true,
    useJwt: payload.useJwt ?? true,
    jwtToken: payload.jwtToken,
  });

  if ((raw as Record<string, any>)["error"] === "没有资料") {
    return {
      source: JM_PLUGIN_ID,
      extern: payload.extern ?? null,
      scheme: {
        version: "1.0.0",
        type: "weekRankingFeed",
        card: "comic",
      },
      data: {
        date,
        page,
        hasReachedMax: true,
        items: [],
        raw,
      },
    };
  }

  const list = Array.isArray((raw as Record<string, any>).list)
    ? (raw as Record<string, any>).list
    : [];
  const hasReachedMax = list.length === 0 || list.length < pageSize;

  return {
    source: JM_PLUGIN_ID,
    extern: payload.extern ?? null,
    scheme: {
      version: "1.0.0",
      type: "weekRankingFeed",
      card: "comic",
    },
    data: {
      date,
      page,
      hasReachedMax,
      items: list.map((item: any) => toComicItem(item)),
      raw,
    },
  };
}

async function selectDownloadChapter(payload: JmChapterPayload, chapterId: string) {
  const excluded = downloadRouteExclusions(payload.downloadRoute);
  if (!excluded) return null;
  const revision = currentSessionRevision();
  await waitForSessionWrites(revision);
  const [apiSetting, imageSetting] = await Promise.all([
    loadPluginSetting("network.apiBase", "", { strict: true }),
    loadPluginSetting("network.imageBase", "", { strict: true }),
  ]);
  assertCurrentSession(revision);
  if (typeof apiSetting !== "string" || typeof imageSetting !== "string") {
    throw new Error("下载线路设置暂不可用，请重试");
  }
  const apiPin = apiSetting.trim();
  const imagePin = imageSetting.trim();
  if (apiPin && imagePin) return null;
  const requestedId = optionalJmCount(chapterId);
  if (!requestedId) throw new Error("下载章节编号无效");

  const speed = await getEndpointSpeedCache().catch(() => null);
  assertCurrentSession(revision);
  const recent = speed && isRecentEndpointSpeed(speed) ? speed : null;
  const activeApi = jmDownloadBase(Config.baseUrl)?.origin;
  const apiBases = rankedDownloadBases(apiPin, Config.baseUrl, currentApiBases(), recent?.api ?? []);
  const imageBases = rankedDownloadBases(imagePin, Config.imagesUrl, currentImageBases(), recent?.image ?? []);
  const candidates = apiBases.flatMap((api) => {
    for (const image of imageBases) {
      const route = jmDownloadPair(api, image);
      if (route && !excluded.has(route.key)) return [{ api, image, route }];
    }
    return [];
  }).slice(0, 3);

  const read = (api: URL, jwt?: string) => readJmDownloadChapter(api, requestedId, revision, jwt).catch(() => {
    assertCurrentSession(revision);
    return null;
  });
  let needsLogin = false;
  let lastTransportStatus: number | undefined;
  let attempted = false;
  for (const { api, image, route } of candidates) {
    attempted = true;
    let chapter = await read(api);
    if (chapter === "memberGate" && api.origin === activeApi && payload.useJwt !== false) {
      const configured = String(payload.jwtToken || await loadPluginSetting("auth.jwt", "") || "").trim();
      const jwt = configured && configured !== "null" && configured !== "undefined"
        ? configured
        : await getJwtToken(revision);
      assertCurrentSession(revision);
      if (jwt) chapter = await read(api, jwt);
      needsLogin = chapter === "memberGate";
    }
    if (chapter === "restricted" || chapter === "notFound") {
      throw new Error(JSON.stringify({
        type: "comic_download_route_unavailable", retryable: false, reason: chapter,
      }));
    }
    if (!chapter || chapter === "memberGate") continue;
    if ("transportStatus" in chapter) {
      if (chapter.transportStatus === 429) throw jmDownloadTransportError(429);
      lastTransportStatus = chapter.transportStatus;
      continue;
    }
    return { chapter, imageBase: image.origin, route };
  }
  if (needsLogin) throw buildUnauthorizedError("请先登录禁漫账号");
  if (lastTransportStatus !== undefined) throw jmDownloadTransportError(lastTransportStatus);
  throw new Error(JSON.stringify({
    type: "comic_download_route_unavailable",
    ...(attempted ? { retryable: false, reason: "unverified" } : { reason: "noCandidate" }),
  }));
}

async function getChapter(payload: JmChapterPayload = {}) {
  const chapterId = String(payload.chapterId ?? "").trim();
  if (!chapterId) {
    throw new Error("chapterId 不能为空");
  }

  const path = `${Config.baseUrl}/chapter`;
  const selected = await selectDownloadChapter(payload, chapterId);
  const response = selected?.chapter ?? (await jmRequest({
    path,
    method: "GET",
    params: {
      skip: "",
      id: chapterId,
    },
    cache: true,
    useJwt: payload.useJwt ?? true,
    jwtToken: payload.jwtToken,
  })) as Record<string, any>;

  const images = Array.isArray(response.images) ? response.images : [];
  const imageBase = selected?.imageBase ?? String(Config.imagesUrl).trim();
  const docExtern = selected ? {
    jmDownloadApiHost: selected.route.apiHost,
    jmDownloadImageHost: selected.route.imageHost,
  } : {};
  const pages = images.map((image) => {
    const name = String(image ?? "");
    const url = imageBase
      ? `${imageBase}/media/photos/${selected?.chapter.id ?? chapterId}/${name}`
      : "";
    const backgroundDownload = selected
      ? jmBackgroundDownload(url, selected.route)
      : undefined;
    return {
      name, path: name, url, id: name,
      extern: backgroundDownload ? { ...docExtern, backgroundDownload } : docExtern,
    };
  });

  const chapter = {
    id: String(response.id ?? chapterId),
    requestId: selected ? chapterId : String(response.id ?? chapterId),
    logicalKey: String(response.id ?? chapterId),
    storageChapterId: String(response.id ?? chapterId),
    name: String(response.name ?? ""),
    order: 0,
    pages,
    extern: selected ? { downloadRoute: selected.route } : {},
  };

  return {
    source: JM_PLUGIN_ID,
    comicId: String(payload.comicId ?? ""),
    chapterId,
    extern: payload.extern ?? null,
    scheme: {
      version: "1.0.0",
      type: "chapterContent",
      source: JM_PLUGIN_ID,
    },
    data: { chapter },
    chapter,
  };
}

async function getReadSnapshot(payload: JmReadSnapshotPayload = {}) {
  const comicId = String(payload.comicId ?? "").trim();
  if (!comicId) {
    throw new Error("comicId 不能为空");
  }

  const externInput = toStringMap(payload.extern);
  const detailPath = String(externInput.path ?? "").trim();
  const detailUseJwt =
    externInput.useJwt === undefined
      ? undefined
      : toBool(externInput.useJwt, true);
  const detailJwtToken = String(externInput.jwtToken ?? "").trim();

  const detail = await getComicDetail({
    comicId,
    extern: payload.extern,
    path: detailPath || undefined,
    useJwt: detailUseJwt,
    jwtToken: detailJwtToken || undefined,
  });
  const normal = (detail as any)?.data?.normal ?? (detail as any)?.normal ?? {};

  const chapterRefs = (Array.isArray(normal?.eps) ? normal.eps : []).map(
    (ep: any) => {
      const id = String(ep?.id ?? "");
      const order = toNum(ep?.order, 0);
      return {
        id,
        requestId: String(ep?.requestId ?? id),
        logicalKey: String(ep?.logicalKey ?? id),
        storageChapterId: String(ep?.storageChapterId ?? id),
        name: String(ep?.name ?? ""),
        order,
        extern: {
          sort: toNum(ep?.extern?.sort, order),
          ...toStringMap(ep?.extern),
        },
      };
    },
  );

  let chapterId = String(payload.chapterId ?? "").trim();
  const order = toNum(externInput.order, 0);
  if (!chapterId && order > 0) {
    const found = chapterRefs.find(
      (item: any) => toNum(item?.order, 0) === order,
    );
    chapterId = String(found?.id ?? "").trim();
  }
  if (!chapterId) {
    chapterId = String(chapterRefs[0]?.id ?? "").trim();
  }
  if (!chapterId) {
    throw new Error("chapterId 不能为空");
  }

  const chapterBundle = await getChapter({
    comicId,
    chapterId,
    extern: payload.extern,
    path: detailPath || undefined,
    useJwt: detailUseJwt,
    jwtToken: detailJwtToken || undefined,
  });
  const chapterData =
    (chapterBundle as any)?.data?.chapter ??
    (chapterBundle as any)?.chapter ??
    {};
  const pages = (
    Array.isArray(chapterData?.pages) ? chapterData.pages : []
  ).map((doc: any) => ({
    id: String(doc?.id ?? ""),
    name: String(doc?.name ?? doc?.originalName ?? ""),
    path: String(doc?.path ?? ""),
    url: String(doc?.url ?? doc?.fileServer ?? ""),
    extern: toStringMap(doc?.extern),
  }));

  const currentChapter = chapterRefs.find(
    (item: any) => String(item.id) === String(chapterId),
  ) ??
    chapterRefs.find((item: any) => toNum(item?.order, 0) === order) ?? {
      id: String(chapterData?.id ?? chapterId),
      requestId: String(chapterData?.requestId ?? chapterData?.id ?? chapterId),
      logicalKey: String(
        chapterData?.logicalKey ?? chapterData?.id ?? chapterId,
      ),
      storageChapterId: String(
        chapterData?.storageChapterId ?? chapterData?.id ?? chapterId,
      ),
      name: String(chapterData?.name ?? ""),
      order: order > 0 ? order : 1,
      extern: {},
    };

  const comicInfo = normal?.comicInfo ?? {};

  const result = {
    source: JM_PLUGIN_ID,
    extern: payload.extern ?? null,
    data: {
      comic: {
        id: String(comicInfo?.id ?? comicId),
        source: JM_PLUGIN_ID,
        title: String(comicInfo?.title ?? ""),
        description: String(comicInfo?.description ?? ""),
        cover: {
          ...(comicInfo?.cover ?? {}),
          extern: toStringMap(comicInfo?.cover?.extern),
        },
        creator: {
          ...(comicInfo?.creator ?? {}),
          avatar: {
            ...(comicInfo?.creator?.avatar ?? {}),
            extern: toStringMap(comicInfo?.creator?.avatar?.extern),
          },
          extern: toStringMap(comicInfo?.creator?.extern),
        },
        titleMeta: (Array.isArray(comicInfo?.titleMeta)
          ? comicInfo.titleMeta
          : []
        ).map((item: any) => ({
          name: String(item?.name ?? ""),
          onTap: toStringMap(item?.onTap),
          extern: toStringMap(item?.extern),
        })),
        metadata: (Array.isArray(comicInfo?.metadata)
          ? comicInfo.metadata
          : []
        ).map((meta: any) => ({
          type: String(meta?.type ?? ""),
          name: String(meta?.name ?? ""),
          value: (Array.isArray(meta?.value) ? meta.value : []).map(
            (item: any) => ({
              name: String(item?.name ?? ""),
              onTap: toStringMap(item?.onTap),
              extern: toStringMap(item?.extern),
            }),
          ),
        })),
        extern: toStringMap(comicInfo?.extern),
      },
      chapter: {
        id: String(chapterData?.id ?? currentChapter.id),
        requestId: String(
          chapterData?.requestId ??
            currentChapter.requestId ??
            currentChapter.id,
        ),
        logicalKey: String(
          chapterData?.logicalKey ??
            currentChapter.logicalKey ??
            currentChapter.id,
        ),
        storageChapterId: String(
          chapterData?.storageChapterId ??
            currentChapter.storageChapterId ??
            currentChapter.id,
        ),
        name: String(chapterData?.name ?? currentChapter.name),
        order: toNum(currentChapter.order, 0),
        pages,
        extern: toStringMap(chapterData?.extern),
      },
      chapters: chapterRefs,
    },
  };
  return result;
}

async function testUrlSpeed(url: string) {
  const start = Date.now();
  try {
    await axios.get(url, { timeout: 5000 });
    return { url, duration: Date.now() - start };
  } catch (error) {
    return { url, duration: null };
  }
}

async function getFastestUrlIndex(urls: string[]) {
  if (!urls || urls.length === 0) return 0;

  const testPromises = urls.map((url) => testUrlSpeed(url));

  const results = await Promise.all(testPromises);

  const successfulResults = results.filter((r) => r.duration !== null);

  if (successfulResults.length === 0) {
    return 0;
  }

  const fastestResult = successfulResults.reduce((prev, curr) =>
    curr.duration < prev.duration ? curr : prev,
  );

  return urls.indexOf(fastestResult.url);
}

export default {
  init,
  jmRequest,
  getComicDetail,
  getSettingsBundle,
  getUserInfoBundle,
  getSettingsUserInfoBundle,
  getUserProfileDetails,
  checkInToday,
  getCheckinStatus,
  getNotifications,
  getNotificationUnreadCount,
  markNotificationRead,
  markNotificationsRead,
  getLoginBundle,
  loginWithPassword,
  getCapabilitiesBundle,
  getComicListSceneBundle,
  getInfo,
  getFunctionPage,
  getCloudFavoriteFilterBundle,
  getCloudFavoriteSceneBundle,
  getRankingFilterBundle,
  getAdvancedSearchScheme,
  getWeekRankingFilterBundle,
  getTimeRankingFilterBundle,
  clearPluginSession,
  dumpRuntimeInfo,
  measureEndpointSpeeds,
  onNetworkChanged,
  onCommentChanged,
  isJm,
  getHomeLatestData,
  getRankingData,
  getPromoteListData,
  getLatestData,
  getCloudFavoriteData,
  getCommentFeed,
  postComment,
  postCommentReply,
  toggleLike,
  toggleFavorite,
  listFavoriteFolders,
  moveFavoriteToFolder,
  getWeekRankingData,
  searchComic,
  getChapter,
  getReadSnapshot,
  fetchImageBytes,
  getFastestUrlIndex,
};
