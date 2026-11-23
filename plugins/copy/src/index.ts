import {
  COPY_SPEED_KEY,
  CopyLineSpeedTest,
  probeCopyRoute,
  probeCopyAccount,
  probeCopyLogin,
  type SpeedResult,
} from "./line-speed";
import { CopyAvatarRejectedError, CopyAvatarSubmittedError, createCopyAvatarHelper, type CopyEditableProfile } from "./profile-avatar";
import { copyProfileTransport, prepareCopyAvatarJpeg } from "./profile-avatar-runtime";
import { readAccountCredentials, saveAccountCredentials } from "./account-credentials";
import {
  COPY_API_ROUTES,
  COPY_AUTO_CHOICE,
  COPY_AUTO_SPEED_CHOICE,
  COPY_DEFAULT_CHOICE,
  accountBaseForOrigin,
  isCopyAccountBase,
  isCopyAccountChoice,
  isCopyAutoChoice,
  isCopyRouteChoice,
  isHotMangaApiBase,
} from "./copy-routes";
import type {
  AdvancedSearchContract,
  CapabilitiesBundleContract,
  ChapterContentContract,
  ChapterPage,
  ChapterSummary,
  ChapterWithPages,
  ComicDetailContract,
  ComicListScene,
  ComicListSceneBundleContract,
  ComicPagedListContract,
  CommentFeedContract,
  CommentFeedPayload,
  CommentItem,
  CommentRepliesContract,
  CommentRepliesPayload,
  FavoriteWorkflowContinuePayload,
  FavoriteWorkflowResult,
  FavoriteWorkflowStartPayload,
  FilterBundleContract,
  LoginBundleContract,
  LoginSubmitPayload,
  LoginSubmitResult,
  OpenComicListAction,
  ReadSnapshotContract,
  SearchResultContract,
  StringMap,
  UserInfoBundleContract,
} from "breeze-plugin-kit";
import {
  authConfig,
  buildLoginBundle,
  buildUnauthorizedError,
  cache,
  pluginConfig,
  readLoginValues,
  runtime,
} from "breeze-plugin-kit";
import ky, { isHTTPError, isNetworkError, isTimeoutError, type Options } from "ky";
import { safeCopyLoginReason } from "./login-error";
import {
  NOT_FOUND_IMAGE_URL,
  SettingsBundleContract,
  createActionItem,
  createImage,
  nonnegativeInteger,
  toStringMap,
} from "./common";
import {
  AUTH_TOKEN_CONFIG_KEY,
  CHAPTER_CACHE_TTL_MS,
  DOWNLOAD_CANCELLED_MESSAGE,
  PLUGIN_ID,
  SEARCH_PAGE_SIZE,
} from "./config";
import { buildPluginInfo } from "./get-info";
import {
  COPY_ORDER_OPTIONS,
  COPY_THEME_SLUG,
  copyAuthorReferences,
  findCopySearchTopic,
  mapCopyComicListItem,
  normalizeCopyComicRow,
  normalizeCopySearchScope,
  resolveCopyDiscoverFilters,
} from "./catalog";
import { loadCopyThemeOptions } from "./catalog_theme_cache";
import { responseCacheGeneration, writeResponseCache } from "../../shared/response-cache";
import { loadCopyChapterPages } from "./catalog_chapters";
import { COPY_FALLBACK_THEMES } from "./catalog_themes";
import {
  copyBackgroundDownload, copyImageAccept,
  copyDownloadImageTimeoutMs, copyDownloadRouteBudgetMs, copyDownloadRouteCandidateBudgetMs,
  copyDownloadRouteCandidateLimit, copyDownloadRouteKey, readCopyDownloadChapter, readCopyDownloadExclusions,
} from "./download-route";
import {
  CopyFollowError, copyChapterGroupUrl, readCopyPublicApi, readCopyPublicDetail,
  type CopyFollowSummary,
} from "./follow-metadata";
import type {
  CachedChapterContent,
  ChapterApiData,
  ChapterContentInfo,
  ChapterContentItem,
  ChapterContentResult,
  ChapterPayload,
  CloudFavoritePayload,
  CollectApiData,
  CollectApiItem,
  ComicCommentData,
  ComicCommentItem,
  ComicDetailPayload,
  ComicQueryResult,
  CopyApiResponse,
  DetailApiGroup,
  DetailApiResult,
  FetchImagePayload,
  MappedEpItem,
  MemberInfoResult,
  NewestApiData,
  NewestPayload,
  RankApiData,
  RankPayload,
  ReadSnapshotPayload,
  RecommendApiData,
  RecommendPayload,
  SearchApiComic,
  SearchApiData,
  SearchPayload,
} from "./types";

const API_DOMAIN_CONFIG_KEY = "api.domain";
const AUTO_ROUTE_KEY = "network.autoRoute.v1";
const API_BASE_CACHE_KEY = "copyComic:apiBase:v1";
const PLATFORM_CONFIG_KEY = "api.platform";
const PLATFORM_CACHE_KEY = "copyComic:platform:v1";
const DEFAULT_PLATFORM_VALUE = "1";
const HOME_PAGE_SIZE = 18;
const PLATFORM_OPTIONS: Array<{ label: string; value: string }> = [
  { label: "1（默认）", value: "1" },
  { label: "2", value: "2" },
  { label: "3", value: "3" },
  { label: "4", value: "4" },
  { label: "5", value: "5" },
  { label: "无", value: "" },
  { label: "空格", value: " " },
];
const RANK_AUDIENCE_OPTIONS: Array<{ label: string; value: string }> = [
  { label: "男频", value: "男频" },
  { label: "女频", value: "女频" },
];
const RANK_DATE_OPTIONS: Array<{ label: string; value: string }> = [
  { label: "日榜", value: "日榜" },
  { label: "周榜", value: "周榜" },
  { label: "月榜", value: "月榜" },
  { label: "总榜", value: "总榜" },
];
const RANK_TYPE_OPTIONS: Array<{ label: string; value: string }> = [
  { label: "所有", value: "所有" },
  { label: "轻小说", value: "轻小说" },
];
const DISCOVER_TOP_OPTIONS: Array<{ label: string; value: string }> = [
  { label: "全部", value: "" },
  { label: "日本", value: "japan" },
  { label: "韩漫", value: "korea" },
  { label: "美漫", value: "west" },
  { label: "完结", value: "finish" },
];
const SEARCH_SCOPE_OPTIONS: Array<{ label: string; value: string }> = [
  { label: "全部", value: "" },
  { label: "标题", value: "name" },
  { label: "作者", value: "author" },
  { label: "汉化组", value: "local" },
];
const lineSpeedTest = new CopyLineSpeedTest({
  bases: COPY_API_ROUTES,
  store: {
    load: () => pluginConfig.load(COPY_SPEED_KEY, ""),
    save: async (value) => { await pluginConfig.save(COPY_SPEED_KEY, value); },
  },
  context: async () => {
    const [choice, platform] = await Promise.all([resolveApiDomainChoice(), resolvePlatformValue()]);
    return { choice, platform };
  },
  probe: async (choice, base, platform) => {
    const accountCapable = isCopyAccountChoice(choice);
    const [directory, account] = await Promise.all([
      probeCopyRoute(choice, base, platform, {
        ...getPublicCopyRequest(base, platform),
        tryNewest: accountCapable,
      }),
      accountCapable ? measureAccountEndpoint(base) : undefined,
    ]);
    return { ...directory, ...(account ? { account } : {}) };
  },
});

async function readLineSpeeds() {
  try { return await lineSpeedTest.snapshot(); } catch { return null; }
}

function fastestReadingChoice(
  speed: Pick<SpeedResult, "results" | "stale"> | null,
  eligible: (choice: string) => boolean,
) {
  let winner: string | undefined;
  let fastest = Infinity;
  if (speed && !speed.stale) {
    for (const row of speed.results) {
      if (row.ok && row.ms !== null && row.ms < fastest && eligible(row.choice)) {
        winner = row.choice;
        fastest = row.ms;
      }
    }
  }
  return winner;
}

function publicReadingChoice(
  mode: string,
  preferred: string,
  speed: Pick<SpeedResult, "results" | "stale"> | null,
) {
  if (mode !== COPY_AUTO_CHOICE) return preferred;
  // A verified mirror is a public reading fallback only. It never becomes
  // the saved account-capable preference, nor a destination for credentials.
  return fastestReadingChoice(speed, isCopyAccountChoice) ??
    fastestReadingChoice(speed, isCopyRouteChoice) ?? preferred;
}

async function measuredCopyAccountReadingChoices() {
  const speed = await readLineSpeeds();
  return speed && !speed.stale
    ? speed.results.filter((row) => isCopyAccountChoice(row.choice) && row.ok && row.ms !== null)
      .sort((left, right) => left.ms! - right.ms!).map((row) => row.choice)
    : [];
}

let routeRevision = 0;
let routeWrites = Promise.resolve();

function writeRoute<T>(write: () => Promise<T>): Promise<T> {
  const result = routeWrites.then(write);
  routeWrites = result.then(() => {}, () => {});
  return result;
}

async function readRouteSelection() {
  const revision = routeRevision;
  const [choice, platform] = await Promise.all([
    resolveApiDomainChoice(), resolvePlatformValue(),
  ]);
  const preferred = isCopyAutoChoice(choice) ? await readAutoRoute(choice) : choice;
  const effective = publicReadingChoice(choice, preferred,
    choice === COPY_AUTO_CHOICE ? await readLineSpeeds() : null);
  return { revision, choice, platform, preferred, effective };
}

async function applyAutoMeasurement(
  owner: Awaited<ReturnType<typeof readRouteSelection>>,
  result: SpeedResult,
) {
  return writeRoute(async () => {
    const current = await readRouteSelection();
    if (result.stale || owner.revision !== current.revision ||
        !isCopyAutoChoice(owner.choice) || owner.choice !== current.choice ||
        owner.platform !== current.platform) {
      return { effective: current.effective, changed: false };
    }
    const saved = await readLineSpeeds();
    if (saved === null || saved.stale || saved.revision !== result.revision) {
      return { effective: current.effective, changed: false };
    }
    const preferred = fastestReadingChoice(saved, (choice) =>
      isEligibleAutoReadingChoice(current.choice, choice)) ?? current.preferred;
    if (preferred !== current.preferred) {
      await saveRoutePreference(AUTO_ROUTE_KEY, preferred);
    }
    const effective = publicReadingChoice(current.choice, preferred, saved);
    return { effective, changed: effective !== owner.effective };
  });
}

function copyRouteName(choice: string) {
  return choice.replace("大陆专线新站", "大陆新")
    .replace("大陆专线", "大陆 ").replace("国际服", "国际")
    .replace("热辣漫画线路", "热辣 ").replace("官方App线路", "官方 App")
    .replace("官方国际线路", "官方国际").replace("大陆Copy4000", "大陆 4000");
}

function routeResult(effective: string, changed: boolean) {
  return {
    effectiveChoice: effective,
    effectiveHost: getApiHost(apiBaseFromChoice(effective)),
    effectiveRouteChanged: changed,
  };
}

async function testLineSpeeds() {
  const owner = await writeRoute(readRouteSelection);
  const { revision, ...result } = await lineSpeedTest.measure();
  const { effective, changed } = await applyAutoMeasurement(owner, { revision, ...result });
  return { source: PLUGIN_ID, ok: true, message: result.message,
    data: { ...result, ok: true, anyAvailable: result.ok, ...routeResult(effective, changed) } };
}

function apiBaseFromChoice(choice: string) {
  return COPY_API_ROUTES[choice] ?? COPY_API_ROUTES[COPY_DEFAULT_CHOICE]!;
}

function unwrapStoredValue(raw: unknown) {
  const map = toStringMap(raw);
  if ("value" in map) {
    return map.value;
  }
  if (typeof raw !== "string") {
    return raw;
  }
  if (raw === " ") return raw;
  const text = raw.trim();
  if (!text) return "";
  if (
    (text.startsWith("{") && text.endsWith("}")) ||
    (text.startsWith("[") && text.endsWith("]"))
  ) {
    try {
      const parsed = JSON.parse(text);
      const parsedMap = toStringMap(parsed);
      if ("value" in parsedMap) {
        return parsedMap.value;
      }
      return parsed;
    } catch {
      return raw;
    }
  }
  return raw;
}

async function saveRoutePreference(key: string, value: string) {
  await pluginConfig.save(key, JSON.stringify(value));
  const saved = unwrapStoredValue(await pluginConfig.load(key, "__unset__"));
  if (saved !== value) throw new Error("线路设置未保存，请重试。");
}

function isEligibleAutoReadingChoice(mode: string, choice: string) {
  return mode === COPY_AUTO_SPEED_CHOICE ? isCopyRouteChoice(choice) : isCopyAccountChoice(choice);
}

async function readAutoRoute(mode: string) {
  const raw = await pluginConfig.load(AUTO_ROUTE_KEY, "").catch(() => "");
  const choice = String(unwrapStoredValue(raw) ?? "").trim();
  return isEligibleAutoReadingChoice(mode, choice) ? choice : COPY_DEFAULT_CHOICE;
}

async function saveApiDomainChoice(choice: string) {
  await saveRoutePreference(API_DOMAIN_CONFIG_KEY, choice);
  if (isCopyAutoChoice(choice)) return;
  await Promise.allSettled([
    cache.set(API_DOMAIN_CONFIG_KEY, choice),
    cache.set(API_BASE_CACHE_KEY, apiBaseFromChoice(choice)),
  ]);
}

async function savePlatformValue(platform: string) {
  await saveRoutePreference(PLATFORM_CONFIG_KEY, platform);
  await Promise.allSettled([
    cache.set(PLATFORM_CONFIG_KEY, platform),
    cache.set(PLATFORM_CACHE_KEY, platform),
  ]);
}

async function resolveApiDomainChoice() {
  const stored = await pluginConfig.load(API_DOMAIN_CONFIG_KEY, "").catch(() => "");
  const choice = String(unwrapStoredValue(stored) ?? "").trim();
  if (isCopyAutoChoice(choice) || isCopyRouteChoice(choice)) return choice;

  // Older installations may have only the derived base or the cached choice.
  const cached = await cache.get(API_BASE_CACHE_KEY, "").catch(() => "");
  const base = String(unwrapStoredValue(cached) ?? "").trim();
  const matching = Object.keys(COPY_API_ROUTES).find((key) => COPY_API_ROUTES[key] === base);
  if (matching) return matching;

  const rawChoice = await cache.get(API_DOMAIN_CONFIG_KEY, "").catch(() => "");
  const cachedChoice = String(unwrapStoredValue(rawChoice) ?? "").trim();
  return isCopyRouteChoice(cachedChoice) ? cachedChoice : COPY_DEFAULT_CHOICE;
}

async function resolveApiBase() {
  const choice = await resolveApiDomainChoice();
  const preferred = isCopyAutoChoice(choice) ? await readAutoRoute(choice) : choice;
  return apiBaseFromChoice(publicReadingChoice(choice, preferred,
    choice === COPY_AUTO_CHOICE ? await readLineSpeeds() : null));
}

async function resolvePlatformValue() {
  // Both the empty string and a single space are valid explicit choices.
  const missing = "__unset__";
  const stored = await pluginConfig.load(PLATFORM_CONFIG_KEY, missing).catch(() => missing);
  const value = String(unwrapStoredValue(stored) ?? missing);
  if (PLATFORM_OPTIONS.some((item) => item.value === value)) return value;
  for (const key of [PLATFORM_CACHE_KEY, PLATFORM_CONFIG_KEY]) {
    const raw = await cache.get(key, missing).catch(() => missing);
    const cached = String(unwrapStoredValue(raw) ?? missing);
    if (PLATFORM_OPTIONS.some((item) => item.value === cached)) return cached;
  }
  return DEFAULT_PLATFORM_VALUE;
}

function openTagAuthorListAction(
  title: string,
  extern: Record<string, unknown> = {},
): OpenComicListAction {
  return {
    type: "openComicList",
    payload: {
      scene: {
        title,
        source: PLUGIN_ID,
        body: {
          type: "pluginPagedComicList",
          request: { fnPath: "getTagAuthorList", extern: toStringMap(extern) },
        },
        filter: { fnPath: "getTagAuthorListFilterBundle", extern: toStringMap(extern) },
      },
    },
  };
}

async function getInfo(): Promise<ReturnType<typeof buildPluginInfo>> {
  return buildPluginInfo();
}

async function getApiHeaders(apiBase?: string) {
  return getApiHeadersForBase(apiBase ?? await resolveApiBase(), await resolvePlatformValue());
}
function getApiHeadersForBase(apiBase: string, platform: string) {
  const isHotMangaApi = isHotMangaApiBase(apiBase);
  const requestVersion = isHotMangaApi ? "2025.02.12" : "2025.05.09";

  const baseHeaders = {
    Accept: "application/json",
    "Accept-Language": "en-US,en;q=0.9,zh-TW;q=0.8,zh;q=0.7",
    version: requestVersion,
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "same-origin",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
  };

  if (isHotMangaApi) {
    const headers: Record<string, string> = {
      ...baseHeaders,
      Origin: "https://m.relamanhua.org",
      webp: "1",
    };
    if (platform.length > 0) {
      headers.platform = platform;
    }
    return headers;
  }

  const headers: Record<string, string> = {
    ...baseHeaders,
    Origin: "https://2025copy.com",
    region: "0",
    webp: "0",
  };
  if (platform.length > 0) {
    headers.platform = platform;
  }
  return headers;
}

function isAntiPiracyMessage(message: string) {
  const text = message.toLowerCase();
  return (
    text.includes("破解") ||
    text.includes("正版") ||
    text.includes("请到官网") ||
    text.includes("請到官網") ||
    text.includes("download") ||
    text.includes("更新最新app")
  );
}

const APP_FALLBACK_UA =
  "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.5735.196 Mobile Safari/537.36 iDOKit/1.0.0 RSSX/1.0.0";

function getAppFallbackHeaders(base: string, platform = DEFAULT_PLATFORM_VALUE): Record<string, string> {
  return { ...getApiHeadersForBase(base, platform), "User-Agent": APP_FALLBACK_UA };
}

function getPublicCopyRequest(base: string, platform: string, preferApp = false) {
  const appHeaders = getAppFallbackHeaders(base, platform);
  if (preferApp) return { headers: appHeaders };
  return {
    headers: getApiHeadersForBase(base, platform),
    appHeaders,
    isAppGate: isAntiPiracyMessage,
  };
}

function getApiHost(apiBase: string) {
  try {
    return new URL(apiBase).host.toLowerCase();
  } catch {
    return "";
  }
}

function createPagingInfo(page: number, pages: number, total: number) {
  return {
    page,
    pages: Math.max(1, pages),
    total,
    hasReachedMax: page >= Math.max(1, pages),
  };
}

function formatDateTime(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) return text;
  return new Date(parsed).toISOString().slice(0, 19).replace("T", " ");
}

function normalizeGroups(value: unknown): DetailApiGroup[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => toStringMap(item) as DetailApiGroup)
      .filter((item) => Boolean(String(item.path_word ?? "").trim()));
  }
  const map = toStringMap(value);
  return Object.values(map)
    .map((item) => toStringMap(item) as DetailApiGroup)
    .filter((item) => Boolean(String(item.path_word ?? "").trim()));
}

function copyReadScopeOptions(scope?: string): Pick<Options, "fetch" | "retry"> {
  if (!scope) return {};
  return {
    retry: 0,
    fetch: (request, init) => globalThis.fetch(request, {
      ...init, breezeReadScope: scope,
    } as RequestInit),
  };
}

async function fetchCopyApi<T>(url: string, options?: Pick<Options, "retry" | "timeout" | "fetch">) {
  console.log(`[api] fetchCopyApi url="${url}"`);
  try {
    const json = (await ky
      .get(url, {
        ...options,
        headers: await getApiHeaders(url),
      })
      .json()) as CopyApiResponse<T>;
    console.log(json.message);
    if (Number(json.code ?? 0) !== 200) {
      throw new Error(json.message || "请求失败");
    }
    return json;
  } catch (error) {
    const message = String((error as Error).message ?? "");
    if (!isAntiPiracyMessage(message)) {
      throw error;
    }
    console.log(`[fallback] anti-piracy detected, retry with app headers: ${message}`);
    const fallbackHeaders = getAppFallbackHeaders(url);
    const json = (await ky
      .get(url, {
        ...options,
        headers: fallbackHeaders,
      })
      .json()) as CopyApiResponse<T>;
    console.log(`[fallback] response code=${json.code} message="${json.message}"`);
    if (Number(json.code ?? 0) !== 200) {
      throw new Error(json.message || "请求失败");
    }
    return json;
  }
}

const copyAccountRequest = {
  credentials: "omit",
  redirect: "error",
  retry: 0,
} as const;

async function fetchCopyApiWithHeaders<T>(url: string, headers: Record<string, string>, anonymousFallback = false, readScope?: string, timeoutMs?: number) {
  const json = await ky.get(url, {
    headers,
    ...(headers.authorization || anonymousFallback ? copyAccountRequest : {}),
    ...copyReadScopeOptions(readScope),
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs, retry: 0 }),
  }).json<CopyApiResponse<T>>();
  if (Number(json.code ?? 0) !== 200) {
    throw new Error(json.message || "请求失败");
  }
  return json;
}

async function loadAuthToken() {
  try {
    return String(await authConfig.load(AUTH_TOKEN_CONFIG_KEY, "")).trim();
  } catch {
    return "";
  }
}

const AUTH_USERNAME_CONFIG_KEY = "auth.username";
const COLLECT_PAGE_SIZE = 21;
const DEFAULT_COLLECT_ORDERING = "-datetime_modifier";
const COLLECT_ORDERING_OPTIONS: Array<{ label: string; value: string }> = [
  { label: "最近收藏", value: "-datetime_modifier" },
  { label: "最早收藏", value: "datetime_modifier" },
  { label: "热度最高", value: "-popular" },
];

async function loadAuthUsername(): Promise<string> {
  try {
    return String(await authConfig.load(AUTH_USERNAME_CONFIG_KEY, "")).trim();
  } catch {
    return "";
  }
}

function getAccountApiHeaders(apiBase: string) {
  return getAppFallbackHeaders(apiBase, DEFAULT_PLATFORM_VALUE);
}

function measureAccountEndpoint(base: string) {
  return probeCopyAccount(base, { headers: getAccountApiHeaders(base) });
}

async function measuredAccountBases() {
  const speed = await readLineSpeeds();
  return speed && !speed.accountStale
    ? speed.results
        .filter((row) => isCopyAccountChoice(row.choice) && row.account?.ok && row.account.ms != null)
        .sort((a, b) => a.account!.ms! - b.account!.ms!)
        .map((row) => apiBaseFromChoice(row.choice))
    : [];
}

type RouteSelection = Awaited<ReturnType<typeof readRouteSelection>>;
let verifiedAccountRoute: { token: string; choice: string; base: string } | undefined;

function pinnedAccountBase(route: RouteSelection) {
  return isCopyAccountChoice(route.choice) ? apiBaseFromChoice(route.choice) : undefined;
}

function uniqueBases(...values: Array<string | undefined>) {
  return [...new Set(values.filter((base): base is string => base !== undefined))];
}

async function selectLoginBase(route: RouteSelection) {
  const pinned = pinnedAccountBase(route);
  if (pinned) return pinned;

  const credentials = await readAccountCredentials(pluginConfig);
  const former = credentials && accountBaseForOrigin(credentials.origin);
  const measured = await measuredAccountBases();
  const candidates = uniqueBases(
    former || undefined,
    ...measured.slice(0, 2),
    isCopyAccountChoice(route.effective) ? apiBaseFromChoice(route.effective) : undefined,
    apiBaseFromChoice("大陆专线1"),
    apiBaseFromChoice(COPY_DEFAULT_CHOICE),
    apiBaseFromChoice("官方App线路"),
  ).slice(0, 5);
  const controller = new AbortController();
  try {
    return await Promise.any(candidates.map(async (base) => {
      const options = {
        headers: getAccountApiHeaders(base),
        timeoutMs: 4000,
        signal: controller.signal,
      };
      const [member, login] = await Promise.all([
        measured.includes(base) ? true : probeCopyAccount(base, options).then((result) => result.ok),
        probeCopyLogin(base, options),
      ]);
      if (!member || !login.ok) throw new Error("账户接口未响应");
      return base;
    }));
  } catch {
    throw new Error("无法连接可用的拷贝账号线路，请稍后重试");
  } finally {
    controller.abort();
  }
}

async function loadAccountRoutes(token: string) {
  if (!token) throw buildUnauthorizedError(PLUGIN_ID, "请先登录拷贝漫画");
  const [route, stored, username] = await Promise.all([
    readRouteSelection(), readAccountCredentials(pluginConfig), loadAuthUsername(),
  ]);
  const credentials = stored && (!username || stored.account === username) ? stored : null;
  const issuedBase = credentials ? accountBaseForOrigin(credentials.origin) : undefined;
  if (credentials && !issuedBase) {
    throw buildUnauthorizedError(PLUGIN_ID, "请重新登录拷贝漫画");
  }
  const verified = verifiedAccountRoute?.token === token &&
    verifiedAccountRoute.choice === route.choice ? verifiedAccountRoute.base : undefined;
  const effective = isCopyAccountChoice(route.effective) ? apiBaseFromChoice(route.effective) : undefined;
  const pinned = pinnedAccountBase(route);
  const defaultBase = apiBaseFromChoice(COPY_DEFAULT_CHOICE);
  const automatic = isCopyAutoChoice(route.choice);
  const [measured] = automatic ? await measuredAccountBases() : [];
  const first = verified ?? pinned ?? issuedBase ?? measured ?? effective ?? defaultBase;
  const fallback = uniqueBases(issuedBase, pinned, measured, effective, defaultBase)
    .find((base) => base !== first);
  return {
    first,
    fallback: automatic || issuedBase ? fallback : undefined,
    choice: route.choice,
    authoritativeBase: issuedBase ?? verified ?? pinned,
    username,
  };
}

function getAuthedHeaders(apiBase: string, token: string): Record<string, string> {
  if (!isCopyAccountBase(apiBase)) throw new Error("该线路仅供阅读");
  return { ...getAccountApiHeaders(apiBase), authorization: `Token ${token}` };
}

async function loadAccountRequest() {
  const token = await loadAuthToken();
  const { first: apiBase } = await loadAccountRoutes(token);
  return { apiBase, headers: getAuthedHeaders(apiBase, token) };
}

async function fetchComicUuid(comicId: string, base?: string): Promise<string> {
  const apiBase = base ?? await resolveApiBase();
  const params = new URLSearchParams({ platform: "1" });
  const detailUrl = `${apiBase}/comic2/${encodeURIComponent(comicId)}?${params.toString()}`;
  const detailResp = await fetchCopyApi<DetailApiResult>(detailUrl);
  const resultsMap = toStringMap(detailResp.results);
  let uuid = "";
  if ("comic" in resultsMap) {
    const comicMap = toStringMap(resultsMap.comic);
    if ("uuid" in comicMap) {
      uuid = String(comicMap.uuid ?? "").trim();
    }
  }
  if (!uuid) {
    throw new Error("未找到漫画 UUID，无法收藏");
  }
  return uuid;
}

async function queryFavoriteCollectId(
  comicId: string,
  account?: Awaited<ReturnType<typeof loadAccountRequest>>,
): Promise<number | null> {
  const { apiBase, headers } = account ?? await loadWorkAccountRequest();
  const params = new URLSearchParams({ platform: "1" });
  const queryUrl = `${apiBase}/comic2/${encodeURIComponent(comicId)}/query?${params.toString()}`;
  let queryResp: CopyApiResponse<ComicQueryResult>;
  try {
    queryResp = await fetchCopyApiWithHeaders<ComicQueryResult>(queryUrl, headers);
  } catch (error) {
    const message = String((error as Error).message ?? "");
    const lowered = message.toLowerCase();
    if (
      lowered.includes("登录") ||
      lowered.includes("登錄") ||
      lowered.includes("token") ||
      lowered.includes("unauthorized") ||
      lowered.includes("401")
    ) {
      throw buildUnauthorizedError(PLUGIN_ID, "登录已失效，请重新登录");
    }
    throw error instanceof Error ? error : new Error(message || "请求失败");
  }
  const resultsMap = toStringMap(queryResp.results);
  const collect = resultsMap.collect;
  const collectId = nonnegativeInteger(collect);
  if (collect === null || collectId === 0) return null;
  if (collectId === null) throw new Error("拷贝未确认收藏状态，请重新打开作品查看");
  return collectId;
}

async function loadWorkAccountRequest() {
  const choice = await resolveApiDomainChoice();
  if (!isCopyAutoChoice(choice) && !isCopyAccountChoice(choice)) {
    throw new Error("该阅读线路不支持拷贝账号收藏");
  }
  return loadAccountRequest();
}

async function addCopyFavorite(comicId: string): Promise<void> {
  const { apiBase, headers } = await loadWorkAccountRequest();
  const uuid = await fetchComicUuid(comicId, apiBase);
  const body = new URLSearchParams({ comic_id: uuid, is_collect: "1" }).toString();
  let resp: CopyApiResponse<null>;
  try {
    resp = (await ky
      .post(`${apiBase}/member/collect/comic?platform=1`, {
        ...copyAccountRequest,
        headers: {
          ...headers,
          "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
        },
        body,
      })
      .json()) as CopyApiResponse<null>;
  } catch (error) {
    const message = String((error as Error).message ?? "");
    const lowered = message.toLowerCase();
    if (
      lowered.includes("登录") ||
      lowered.includes("登錄") ||
      lowered.includes("token") ||
      lowered.includes("unauthorized") ||
      lowered.includes("401")
    ) {
      throw buildUnauthorizedError(PLUGIN_ID, "登录已失效，请重新登录");
    }
    throw error instanceof Error ? error : new Error(message || "收藏失败");
  }
  if (Number(resp.code ?? 0) !== 200) {
    throw new Error(resp.message || "收藏失败");
  }
}

async function removeCopyFavorite(
  collectId: number,
  account: Awaited<ReturnType<typeof loadAccountRequest>>,
): Promise<void> {
  const { apiBase, headers } = account;
  const body = new URLSearchParams({ ids: String(collectId) }).toString();
  let resp: CopyApiResponse<unknown>;
  try {
    // ky.delete 不支持 body，改用 method DELETE 的通用请求。
    resp = (await ky(`${apiBase}/member/collect/comics?platform=1`, {
      ...copyAccountRequest,
      method: "DELETE",
      headers: {
        ...headers,
        "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
      },
      body,
    }).json()) as CopyApiResponse<unknown>;
  } catch (error) {
    const message = String((error as Error).message ?? "");
    const lowered = message.toLowerCase();
    if (
      lowered.includes("登录") ||
      lowered.includes("登錄") ||
      lowered.includes("token") ||
      lowered.includes("unauthorized") ||
      lowered.includes("401")
    ) {
      throw buildUnauthorizedError(PLUGIN_ID, "登录已失效，请重新登录");
    }
    throw error instanceof Error ? error : new Error(message || "取消收藏失败");
  }
  if (Number(resp.code ?? 0) !== 200) {
    throw new Error(resp.message || "取消收藏失败");
  }
}

function mapCollectComicToGrid(item: CollectApiItem) {
  const collectId = Number(item.uuid ?? 0);
  const comicMap = toStringMap(item.comic);
  const comic = normalizeCopyComicRow(comicMap);
  const grid = comic ? mapSearchComicToGrid(comic) : null;
  if (!grid) {
    return null;
  }
  return {
    ...grid,
    extern: {
      ...toStringMap(grid.extern),
      collectId: Number.isFinite(collectId) ? collectId : 0,
    },
  };
}

function buildCopyCloudFavoriteScene(): ComicListScene {
  return {
    title: "云端收藏",
    source: PLUGIN_ID,
    body: {
      type: "pluginPagedComicList",
      request: {
        fnPath: "getCloudFavoriteData",
        core: {},
        extern: { source: "cloudFavorite" },
      },
    },
    filter: {
      fnPath: "getCloudFavoriteFilterBundle",
      extern: { source: "cloudFavorite" },
    },
  };
}

function sanitizeFileName(name: string) {
  const sanitized = name.replace(/[\\/:*?"<>|]/g, "_").trim();
  return sanitized || "image.jpg";
}

function extractImageName(imageUrl: string, index: number) {
  const fallback = `page-${String(index + 1).padStart(3, "0")}.jpg`;
  try {
    const parsed = new URL(imageUrl);
    const segment = parsed.pathname.split("/").filter(Boolean).pop();
    if (!segment) return fallback;
    return sanitizeFileName(decodeURIComponent(segment));
  } catch {
    return fallback;
  }
}

function sortChapterImageUrls(contents: ChapterContentItem[], words: unknown): string[] {
  const urls = contents.map((item) => String(item.url ?? "").trim());
  const orderList = Array.isArray(words) ? words.map((n) => Number(n)) : [];

  if (orderList.length !== urls.length) {
    return urls.filter(Boolean);
  }

  const mapped = urls
    .map((url, index) => ({
      url,
      index,
      order: orderList[index],
    }))
    .filter((item) => item.url && Number.isFinite(item.order));

  if (!mapped.length) {
    return urls.filter(Boolean);
  }

  mapped.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.index - b.index;
  });

  return mapped.map((item) => item.url);
}

function pickTargetChapter(
  eps: Array<{
    id: string;
    name: string;
    order: number;
    groupTitle: string | null;
    extern: Record<string, unknown>;
  }>,
  chapterIdInput: unknown,
  externInput: unknown,
) {
  const chapterIdText = String(chapterIdInput ?? "").trim();
  const extern = toStringMap(externInput);
  const externSort = Number(extern.sort ?? extern.order ?? extern.index ?? 0);
  const chapterIdAsNumber = Number(chapterIdText);

  const byId = eps.find((item) => item.id === chapterIdText);
  const byExternSort =
    Number.isFinite(externSort) && externSort > 0
      ? eps.find((item) => item.order === externSort)
      : undefined;
  const byNumericChapterId =
    Number.isFinite(chapterIdAsNumber) && chapterIdAsNumber > 0
      ? eps.find((item) => item.order === chapterIdAsNumber)
      : undefined;

  return byId ?? byExternSort ?? byNumericChapterId ?? eps[0];
}

async function isTaskGroupCancelled(taskGroupKey: string) {
  const key = String(taskGroupKey ?? "").trim();
  if (!key) return false;
  try {
    return Boolean(await runtime.isTaskGroupCancelled(key));
  } catch {
    return false;
  }
}

function buildChapterCacheKey(comicId: string, groups: DetailApiGroup[], route: PublicComicRoute) {
  const groupKey = groups
    .map((group) => String(group.path_word ?? "").trim())
    .filter(Boolean)
    .sort()
    .join(",");
  return `copyComic:chapters:v3:${JSON.stringify([copyChapterRouteKey(route), comicId, groupKey])}`;
}

async function readChapterCache(cacheKey: string): Promise<MappedEpItem[] | null> {
  try {
    const raw = await cache.get(cacheKey, null);
    const data = toStringMap(raw);
    const ts = Number(data.ts ?? 0);
    if (!Number.isFinite(ts) || ts <= 0) return null;
    if (Date.now() - ts > CHAPTER_CACHE_TTL_MS) return null;
    const eps = Array.isArray(data.eps) ? data.eps : [];
    const mapped = eps
      .map((item) => toStringMap(item))
      .map((item) => {
        const groupTitle = String(item.groupTitle ?? "").trim();
        return {
          id: String(item.id ?? "").trim(),
          name: String(item.name ?? "").trim(),
          order: Number(item.order ?? 0) || 0,
          groupTitle: groupTitle || null,
          extern: toStringMap(item.extern),
        };
      })
      .filter((item) => item.id);
    return mapped;
  } catch {
    return null;
  }
}

async function writeChapterCache(cacheKey: string, eps: MappedEpItem[], generation?: number) {
  try {
    await writeResponseCache(cacheKey, {
      ts: Date.now(),
      eps: eps.map(
        (ep) =>
          ({
            id: ep.id,
            requestId: ep.id,
            logicalKey: ep.id,
            storageChapterId: ep.id,
            name: ep.name,
            order: ep.order,
            groupTitle: ep.groupTitle,
            extern: ep.extern,
          }) as ChapterSummary,
      ),
    }, generation);
  } catch {
    // ignore cache write errors
  }
}

function chapterPageCacheKey(scope: string | null, comicId: string, chapterId: string) {
  return scope == null ? null : `copyComic:chapterContent:v2:${JSON.stringify([scope, comicId, chapterId])}`;
}

async function readChapterContentCache(
  key: string | null,
): Promise<CachedChapterContent | null> {
  if (key == null) return null;
  try {
    const raw = await cache.get(key, null);
    const data = toStringMap(raw);
    const ts = Number(data.ts ?? 0);
    if (!Number.isFinite(ts) || ts <= 0) return null;
    if (Date.now() - ts > CHAPTER_CACHE_TTL_MS) return null;

    const chapter = toStringMap(data.chapter);
    const name = String(chapter.name ?? "").trim();
    const contents = (Array.isArray(chapter.contents) ? chapter.contents : [])
      .map((item) => toStringMap(item))
      .map((item) => ({ url: String(item.url ?? "").trim() }))
      .filter((item) => item.url);
    const words = Array.isArray(chapter.words)
      ? chapter.words.map((n) => Number(n)).filter((n) => Number.isFinite(n))
      : [];

    if (contents.length === 0) return null;
    return { name, contents, words };
  } catch {
    return null;
  }
}

async function writeChapterContentCache(
  key: string | null,
  chapter: CachedChapterContent,
  generation?: number,
) {
  if (key == null) return;
  try {
    await writeResponseCache(key, {
      ts: Date.now(),
      chapter,
    }, generation);
  } catch {
    // ignore cache write errors
  }
}

type PublicComicRoute = {
  apiBase: string;
  platform: string;
  fallback: boolean;
  preferApp?: boolean;
  cacheGeneration?: number;
  recovery?: {
    deadline: number;
    anonymousMirror: boolean;
    assertCurrent: () => Promise<void>;
  };
};

const publicMirrorWindowMs = 4500;

function copyChapterRouteKey(route: PublicComicRoute) {
  return JSON.stringify([route.apiBase, route.platform, route.fallback, route.preferApp === true]);
}

function copyRouteReadTimeout(route: PublicComicRoute, defaultMs: number) {
  if (!route.recovery) return defaultMs;
  const remaining = route.recovery.deadline - Date.now() - (route.recovery.anonymousMirror ? 0 : publicMirrorWindowMs);
  if (remaining <= 0) throw new CopyFollowError("network");
  return Math.min(remaining, defaultMs);
}

async function loadTrustedCopyChapterToken(apiBase: string) {
  if (!isCopyAccountBase(apiBase)) return "";
  const token = await loadAuthToken();
  if (!token) return "";
  const stored = await readAccountCredentials(pluginConfig);
  return !stored || accountBaseForOrigin(stored.origin) ? token : "";
}

async function prepareCopyChapterRead(route: PublicComicRoute) {
  const { apiBase, platform } = route;
  const headers = getPublicCopyRequest(apiBase, platform, route.preferApp).headers;
  if (!route.fallback) {
    const token = await loadTrustedCopyChapterToken(apiBase);
    if (token) headers.authorization = `Token ${token}`;
  }
  // A token-authorized reply may contain private media URLs. Only anonymous
  // responses are reusable after a route or account transition.
  return { headers, cacheScope: headers.authorization ? null : copyChapterRouteKey(route) };
}

async function readChapterContent(
  comicId: string, chapterId: string, route: PublicComicRoute,
) {
  const { headers, cacheScope } = await prepareCopyChapterRead(route);
  const key = chapterPageCacheKey(cacheScope, comicId, chapterId);
  return getChapterContentWithCache(comicId, chapterId, route.apiBase, headers, route.platform, route.fallback, key, route.cacheGeneration,
    route.recovery ? () => copyRouteReadTimeout(route, 4500) : undefined);
}

async function getChapterContentWithCache(
  comicId: string,
  chapterId: string,
  apiBase: string,
  headers: Record<string, string>,
  platform: string,
  anonymousFallback: boolean,
  cacheKey: string | null,
  generation?: number,
  timeout?: () => number,
) {
  const cached = await readChapterContentCache(cacheKey);
  if (cached) return cached;

  const chapterParams = new URLSearchParams({
    platform: "1",
  });

  async function doFetchChapterContent(chapterHeaders: Record<string, string>) {
    const primaryChapterPath = isHotMangaApiBase(apiBase) ? "chapter" : "chapter2";
    const secondaryChapterPath = primaryChapterPath === "chapter" ? "chapter2" : "chapter";
    const buildChapterUrl = (chapterPath: string) =>
      `${apiBase}/comic/${encodeURIComponent(comicId)}/${chapterPath}/${encodeURIComponent(chapterId)}?${chapterParams.toString()}`;

    let chapterResp: CopyApiResponse<ChapterContentResult>;
    try {
      chapterResp = await fetchCopyApiWithHeaders<ChapterContentResult>(
        buildChapterUrl(primaryChapterPath),
        chapterHeaders,
        anonymousFallback,
        undefined,
        timeout?.(),
      );
    } catch (error) {
      const status = Number((error as { response?: { status?: unknown } })?.response?.status ?? 0);
      if (status !== 404) {
        throw error;
      }
      chapterResp = await fetchCopyApiWithHeaders<ChapterContentResult>(
        buildChapterUrl(secondaryChapterPath),
        chapterHeaders,
        anonymousFallback,
        undefined,
        timeout?.(),
      );
    }
    return chapterResp;
  }

  let chapterResp: CopyApiResponse<ChapterContentResult>;
  try {
    chapterResp = await doFetchChapterContent(headers);
  } catch (error) {
    const message = String((error as Error).message ?? "");
    if (!isAntiPiracyMessage(message) || headers["User-Agent"] === APP_FALLBACK_UA) {
      throw error;
    }
    console.log(`[fallback] anti-piracy detected, retry with app headers: ${message}`);
    chapterResp = await doFetchChapterContent({
      ...getAppFallbackHeaders(apiBase, platform),
      ...(headers.authorization ? { authorization: headers.authorization } : {}),
    });
  }

  const chapterNode = toStringMap(chapterResp.results);
  const chapterInfo = toStringMap(chapterNode.chapter) as ChapterContentInfo;
  const contents = (
    Array.isArray(chapterInfo.contents) ? chapterInfo.contents : []
  ) as ChapterContentItem[];
  const words = Array.isArray(chapterInfo.words)
    ? chapterInfo.words.map((n) => Number(n)).filter((n) => Number.isFinite(n))
    : [];
  const result: CachedChapterContent = {
    name: String(chapterInfo.name ?? "").trim(),
    contents,
    words,
  };
  if (result.contents.length > 0) {
    await writeChapterContentCache(cacheKey, result, generation);
  }
  return result;
}

async function fetchAllGroupChapters(
  comicId: string, groups: DetailApiGroup[], route: PublicComicRoute,
  summary: CopyFollowSummary | null, workSlug: string,
) {
  const { apiBase, platform } = route;
  if (!groups.length) return [];
  const cacheKey = buildChapterCacheKey(comicId, groups, route);
  const cached = await readChapterCache(cacheKey);
  if (cached && cached.length > 0 && (!summary ||
      (summary.chapterCount === cached.length && cached.some((ep) => ep.id === summary.latestChapterId)))) {
    return cached;
  }

  const list: MappedEpItem[] = [];

  let order = 1;
  for (const group of groups) {
    const groupPathWord = String(group.path_word ?? "").trim();
    if (!groupPathWord) continue;

    let chapterList;
    try {
      chapterList = await loadCopyChapterPages(async (offset, limit) => {
        await route.recovery?.assertCurrent();
        const { data } = await readCopyPublicApi<ChapterApiData>(
          copyChapterGroupUrl(apiBase, comicId, groupPathWord, offset, limit),
          { ...getPublicCopyRequest(apiBase, platform, route.preferApp), timeoutMs: copyRouteReadTimeout(route, 6500) },
        );
        if (Array.isArray(data.results?.list) && data.results.list.some((chapter) => {
          const reported = String(chapter?.comic_path_word ?? "").trim();
          return reported !== "" && reported !== workSlug && reported !== comicId;
        })) throw new CopyFollowError("invalidResponse");
        return data.results;
      });
    } catch (error) {
      if (error instanceof CopyFollowError) throw error;
      throw new CopyFollowError("invalidResponse");
    }
    if (!chapterList.length && Number(group.count) > 0) throw new CopyFollowError("invalidResponse");

    const groupName = String(group.name ?? "").trim();
    const groupTitle = groupName || null;
    for (const chapter of chapterList) {
      const chapterId = String(chapter.uuid ?? "").trim();
      if (!chapterId) continue;
      const chapterName = String(chapter.name ?? "").trim() || `第${order}话`;
      list.push({
        id: chapterId,
        name: chapterName,
        order,
        groupTitle,
        extern: {
          sort: order,
          groupPathWord,
          groupName,
          comicId,
          chapterId,
          size: Number(chapter.size ?? 0) || 0,
          createdAt: String(chapter.datetime_created ?? "").trim(),
        },
      });
      order += 1;
    }
  }

  await writeChapterCache(cacheKey, list, route.cacheGeneration);
  return list;
}

function mapSearchComicToGrid(item: SearchApiComic) {
  const grid = mapCopyComicListItem(item);
  if (!grid) return null;
  return {
    ...grid,
    extern: {
      ...grid.extern,
      authorActions: copyAuthorReferences(item).map((author) => ({
        label: author.name,
        action: openTagAuthorListAction(`作者：${author.name}`, {
          author: author.pathWord,
          ordering: "-datetime_updated",
        }),
      })),
    },
  };
}

function readDirectoryItems(value: unknown) {
  if (!Array.isArray(value)) throw new Error("站点目录响应不完整");
  const items = value.flatMap((row) => {
    const comic = normalizeCopyComicRow(row);
    const item = typeof comic?.path_word === "string"
      ? mapSearchComicToGrid(comic) : null;
    return item ? [item] : [];
  });
  // Preserve compatible flat/wrapped rows, but never report a broken nonempty
  // response as a confirmed empty shelf or final page.
  if (value.length > 0 && items.length === 0) {
    throw new Error("站点目录响应不完整");
  }
  return items;
}

async function getHomeRecommend(payload: RecommendPayload = {}): Promise<ComicPagedListContract> {
  const apiBase = await resolveApiBase();
  const page = Math.max(1, Number(payload.page ?? 1) || 1);
  const offset = (page - 1) * HOME_PAGE_SIZE;
  const params = new URLSearchParams({
    pos: "3200102",
    limit: String(HOME_PAGE_SIZE),
    offset: String(offset),
    platform: "3",
  });
  const apiUrl = `${apiBase}/recs?${params.toString()}`;
  const json = await fetchCopyApi<RecommendApiData>(apiUrl);
  const data = toStringMap(json.results);
  const items = readDirectoryItems(data.list);

  const total = Number(data.total ?? items.length) || items.length;
  const limit = Number(data.limit ?? HOME_PAGE_SIZE) || HOME_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const paging = createPagingInfo(page, pageCount, total);

  return {
    source: PLUGIN_ID,
    extern: payload.extern ?? null,
    scheme: {
      version: "1.0.0",
      type: "searchResult",
      source: PLUGIN_ID,
      list: "comicGrid",
    },
    data: { hasReachedMax: paging.hasReachedMax, items },
  };
}

async function getHomeNewest(payload: NewestPayload = {}): Promise<ComicPagedListContract> {
  const apiBase = await resolveApiBase();
  const page = Math.max(1, Number(payload.page ?? 1) || 1);
  const offset = (page - 1) * HOME_PAGE_SIZE;
  const isHot = isHotMangaApiBase(apiBase);
  const newestParams = new URLSearchParams({
    limit: String(HOME_PAGE_SIZE),
    offset: String(offset),
    platform: "3",
  });
  const updateParams = new URLSearchParams({
    limit: String(HOME_PAGE_SIZE),
    offset: String(offset),
    ordering: "-datetime_updated",
    platform: "3",
  });
  const primaryUrl = isHot
    ? `${apiBase}/comics?${updateParams.toString()}`
    : `${apiBase}/update/newest?${newestParams.toString()}`;
  const fallbackUrl = isHot
    ? `${apiBase}/update/newest?${newestParams.toString()}`
    : `${apiBase}/comics?${updateParams.toString()}`;

  async function readDirectory(url: string) {
    const response = await fetchCopyApi<NewestApiData>(url, { retry: 0, timeout: 6000 });
    const data = toStringMap(response.results);
    return { data, items: readDirectoryItems(data.list) };
  }
  let directory: Awaited<ReturnType<typeof readDirectory>>;
  try {
    directory = await readDirectory(primaryUrl);
  } catch (error) {
    const status = isHTTPError(error) ? error.response.status : 0;
    if (status === 401 || status === 403 || status === 429) throw error;
    directory = await readDirectory(fallbackUrl);
  }
  const { data, items } = directory;

  const total = Number(data.total ?? items.length) || items.length;
  const limit = Number(data.limit ?? HOME_PAGE_SIZE) || HOME_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const paging = createPagingInfo(page, pageCount, total);

  return {
    source: PLUGIN_ID,
    extern: payload.extern ?? null,
    scheme: {
      version: "1.0.0",
      type: "searchResult",
      source: PLUGIN_ID,
      list: "comicGrid",
    },
    data: { hasReachedMax: paging.hasReachedMax, items },
  };
}

async function getHomeRank(payload: RankPayload = {}): Promise<ComicPagedListContract> {
  const apiBase = await resolveApiBase();
  const extern = toStringMap(payload.extern);
  const page = Math.max(1, Number(payload.page ?? 1) || 1);
  const offset = (page - 1) * HOME_PAGE_SIZE;
  const audienceMap: Record<string, "male" | "female"> = {
    男频: "male",
    女频: "female",
  };
  const dateMap: Record<string, "day" | "week" | "month" | "total"> = {
    日榜: "day",
    周榜: "week",
    月榜: "month",
    总榜: "total",
  };
  const typeMap: Record<string, "1" | "5"> = { 所有: "1", 轻小说: "5" };

  const audienceOption = String(extern.audience ?? "男频");
  const dateOption = String(extern.dateType ?? "日榜");
  const typeOption = String(extern.rankType ?? "所有");

  const audienceType =
    payload.audienceType === "female"
      ? "female"
      : payload.audienceType === "male"
        ? "male"
        : (audienceMap[audienceOption] ?? "male");
  const dateType = (
    ["day", "week", "month", "total"].includes(String(payload.dateType))
      ? String(payload.dateType)
      : (dateMap[dateOption] ?? "day")
  ) as "day" | "week" | "month" | "total";
  const rankType = (Number(payload.rankType) === 5 ? "5" : (typeMap[typeOption] ?? "1")) as
    | "1"
    | "5";
  const params = new URLSearchParams({
    type: rankType,
    date_type: dateType,
    limit: String(HOME_PAGE_SIZE),
    offset: String(offset),
    audience_type: audienceType,
    platform: "3",
  });
  const apiUrl = `${apiBase}/ranks?${params.toString()}`;
  const json = await fetchCopyApi<RankApiData>(apiUrl);
  const data = toStringMap(json.results);
  const items = readDirectoryItems(data.list);

  const total = Number(data.total ?? items.length) || items.length;
  const limit = Number(data.limit ?? HOME_PAGE_SIZE) || HOME_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const paging = createPagingInfo(page, pageCount, total);

  return {
    source: PLUGIN_ID,
    extern: payload.extern ?? null,
    scheme: {
      version: "1.0.0",
      type: "searchResult",
      source: PLUGIN_ID,
      list: "comicGrid",
    },
    data: { hasReachedMax: paging.hasReachedMax, items },
  };
}
async function getTagAuthorList(
  payload: { page?: number; extern?: Record<string, unknown> } = {},
): Promise<ComicPagedListContract> {
  const apiBase = await resolveApiBase();
  const platform = await resolvePlatformValue();
  const extern = toStringMap(payload.extern);
  const page = Math.max(1, Number(payload.page ?? 1) || 1);
  const limit = HOME_PAGE_SIZE;
  const offset = (page - 1) * limit;
  const author = String(extern.author ?? "").trim();
  const theme = String(extern.theme ?? "").trim();
  const ordering = String(extern.ordering ?? "-datetime_updated").trim() || "-datetime_updated";
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    ordering,
    free_type: "1",
    platform,
  });
  if (author) params.set("author", author);
  if (theme) params.set("theme", theme);
  const apiUrl = `${apiBase}/comics?${params.toString()}`;
  const json = await fetchCopyApi<SearchApiData>(apiUrl);
  const data = toStringMap(json.results);
  const items = readDirectoryItems(data.list);
  const total = Number(data.total ?? items.length) || items.length;
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const paging = createPagingInfo(page, pageCount, total);
  return {
    source: PLUGIN_ID,
    extern: payload.extern ?? null,
    scheme: { version: "1.0.0", type: "searchResult", source: PLUGIN_ID, list: "comicGrid" },
    data: { hasReachedMax: paging.hasReachedMax, items },
  };
}
async function getTagAuthorListFilterBundle(
  payload: { extern?: Record<string, unknown> } = {},
): Promise<FilterBundleContract> {
  const extern = toStringMap(payload.extern);
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "comicListFilter",
      title: "排序",
      fields: [
        {
          key: "ordering",
          kind: "choice",
          label: "排序",
          options: COPY_ORDER_OPTIONS.map((item) => ({
            label: item.label,
            value: item.value,
            result: { extern: { ordering: item.value } },
          })),
        },
      ],
    },
    data: {
      values: {
        ordering: String(extern.ordering ?? "-datetime_updated"),
      },
    },
  };
}
const COMMENT_PAGE_SIZE = 10;

function mapComicCommentToItem(raw: ComicCommentItem): CommentItem {
  const id = String(raw.id ?? "").trim();
  const replyCount = Number(raw.count ?? 0) || 0;
  return {
    id,
    author: {
      name: String(raw.user_name ?? "").trim() || "匿名",
      avatar: {
        url: String(raw.user_avatar ?? "").trim(),
        path: `comment/avatar/${String(raw.user_id ?? "").trim() || id}`,
      },
    },
    content: String(raw.comment ?? ""),
    createdAt: String(raw.create_at ?? "").trim(),
    replyCount,
    replies: [],
    extern: { commentId: id, replyId: id },
  };
}

async function fetchComicCommentPage(
  comicId: string,
  replyId: string,
  page: number,
): Promise<{ items: CommentItem[]; hasReachedMax: boolean }> {
  const apiBase = await resolveApiBase();
  const platform = await resolvePlatformValue();
  const uuid = await fetchComicUuid(comicId);
  const offset = (page - 1) * COMMENT_PAGE_SIZE;
  const params = new URLSearchParams({
    comic_id: uuid,
    reply_id: replyId,
    limit: String(COMMENT_PAGE_SIZE),
    offset: String(offset),
    platform,
  });
  const json = await fetchCopyApi<ComicCommentData>(`${apiBase}/comments?${params.toString()}`);
  const data = toStringMap(json.results);
  const list = (Array.isArray(data.list) ? data.list : []) as ComicCommentItem[];
  const items = list.map(mapComicCommentToItem).filter((item) => item.id);
  const total = Number(data.total ?? items.length) || items.length;
  return { items, hasReachedMax: offset + COMMENT_PAGE_SIZE >= total };
}

async function getCommentFeed(payload: CommentFeedPayload = {}): Promise<CommentFeedContract> {
  const comicId = String(payload.comicId ?? toStringMap(payload.extern).comicId ?? "").trim();
  if (!comicId) throw new Error("comicId 不能为空");
  const page = Math.max(1, Number(payload.page ?? 1) || 1);
  const { items, hasReachedMax } = await fetchComicCommentPage(comicId, "", page);
  return {
    source: PLUGIN_ID,
    extern: payload.extern ?? null,
    scheme: { version: "1.0.0", type: "commentFeed" },
    data: {
      topItems: [],
      items,
      paging: { hasReachedMax },
      replyMode: "lazy",
      canComment: { comic: false, reply: false },
    },
  };
}

async function getCommentReplies(
  payload: CommentRepliesPayload = {},
): Promise<CommentRepliesContract> {
  const extern = toStringMap(payload.extern);
  const comicId = String(payload.comicId ?? extern.comicId ?? "").trim();
  const commentId = String(payload.commentId ?? extern.commentId ?? extern.replyId ?? "").trim();
  if (!comicId) throw new Error("comicId 不能为空");
  if (!commentId) throw new Error("commentId 不能为空");
  const page = Math.max(1, Number(payload.page ?? 1) || 1);
  const { items, hasReachedMax } = await fetchComicCommentPage(comicId, commentId, page);
  return {
    source: PLUGIN_ID,
    extern: payload.extern ?? null,
    scheme: { version: "1.0.0", type: "commentReplies" },
    data: { commentId, items, paging: { hasReachedMax } },
  };
}

async function getHomeRankFilterBundle(
  payload: { extern?: Record<string, unknown> } = {},
): Promise<FilterBundleContract> {
  const extern = toStringMap(payload.extern);
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "rankingFilter",
      title: "筛选排行榜（高级选项）",
      fields: [
        {
          key: "audience",
          kind: "choice",
          label: "受众",
          options: RANK_AUDIENCE_OPTIONS.map((item) => ({
            label: item.label,
            value: item.value,
            result: { extern: { audience: item.value } },
          })),
        },
        {
          key: "dateType",
          kind: "choice",
          label: "周期",
          options: RANK_DATE_OPTIONS.map((item) => ({
            label: item.label,
            value: item.value,
            result: { extern: { dateType: item.value } },
          })),
        },
        {
          key: "rankType",
          kind: "choice",
          label: "类型",
          options: RANK_TYPE_OPTIONS.map((item) => ({
            label: item.label,
            value: item.value,
            result: { extern: { rankType: item.value } },
          })),
        },
      ],
    },
    data: {
      values: {
        audience: String(extern.audience ?? "男频"),
        dateType: String(extern.dateType ?? "日榜"),
        rankType: String(extern.rankType ?? "所有"),
      },
    },
  };
}

async function getHomeDiscover(payload: RecommendPayload = {}): Promise<ComicPagedListContract> {
  const apiBase = await resolveApiBase();
  const extern = toStringMap(payload.extern);
  const page = Math.max(1, Number(payload.page ?? 1) || 1);
  const offset = (page - 1) * HOME_PAGE_SIZE;
  const { theme, top, ordering } = resolveCopyDiscoverFilters(extern);
  const params = new URLSearchParams({
    limit: String(HOME_PAGE_SIZE),
    offset: String(offset),
    free_type: "1",
    ordering,
    theme,
    top,
    platform: "3",
  });
  const apiUrl = `${apiBase}/comics?${params.toString()}`;
  const json = await fetchCopyApi<SearchApiData>(apiUrl);
  const data = toStringMap(json.results);
  const items = readDirectoryItems(data.list);

  const total = Number(data.total ?? items.length) || items.length;
  const limit = Number(data.limit ?? HOME_PAGE_SIZE) || HOME_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const paging = createPagingInfo(page, pageCount, total);

  return {
    source: PLUGIN_ID,
    extern: payload.extern ?? null,
    scheme: {
      version: "1.0.0",
      type: "searchResult",
      source: PLUGIN_ID,
      list: "comicGrid",
    },
    data: { hasReachedMax: paging.hasReachedMax, items },
  };
}

const _themeRequests = new Map<string, Promise<Array<{ label: string; value: string }>>>();

async function getDiscoverThemeOptions(apiBase: string) {
  const generation = await responseCacheGeneration();
  const current = _themeRequests.get(apiBase);
  if (current) return current;
  const key = `copyComic:themes:v1:${new URL(apiBase).host}`;
  const request = loadCopyThemeOptions({
    read: async () => unwrapStoredValue(await cache.get(key, null)),
    write: (value) => writeResponseCache(key, value, generation),
    fetch: async () => {
      const response = await ky
        .get(`${apiBase}/theme/comic/count`, {
          searchParams: { limit: "500", offset: "0", platform: "1" },
          headers: await getApiHeaders(),
          timeout: 3500,
          retry: 0,
        })
        .json<CopyApiResponse<SearchApiData>>();
      const data = toStringMap(response.results);
      const list = Array.isArray(data.list) ? data.list : [];
      if (response.code !== 200 || Number(data.total ?? list.length) > list.length) {
        throw new Error("Theme catalogue incomplete");
      }
      return list;
    },
    fallback: COPY_FALLBACK_THEMES,
  });
  _themeRequests.set(apiBase, request);
  try {
    return await request;
  } finally {
    if (_themeRequests.get(apiBase) === request) _themeRequests.delete(apiBase);
  }
}

export async function resolveSearchTopic(
  payload: { keyword?: string; variants?: string[] } = {},
) {
  const keyword = String(payload.keyword ?? "").trim();
  const topic = keyword
    ? findCopySearchTopic(await getDiscoverThemeOptions(await resolveApiBase()), keyword, payload.variants)
    : null;
  return { source: PLUGIN_ID, topic };
}

async function getHomeDiscoverFilterBundle(
  payload: { extern?: Record<string, unknown> } = {},
): Promise<FilterBundleContract> {
  const extern = toStringMap(payload.extern);
  const themes = await getDiscoverThemeOptions(await resolveApiBase());
  const values = resolveCopyDiscoverFilters(extern);
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "comicListFilter",
      title: "筛选漫画",
      fields: [
        {
          key: "theme",
          kind: "choice",
          label: "分类",
          options: [{ label: "全部", value: "" }, ...themes].map((item) => ({
            label: item.label,
            value: item.value,
            result: { extern: { theme: item.value } },
          })),
        },
        {
          key: "top",
          kind: "choice",
          label: "范围",
          options: DISCOVER_TOP_OPTIONS.map((item) => ({
            label: item.label,
            value: item.value,
            result: { extern: { top: item.value } },
          })),
        },
        {
          key: "ordering",
          kind: "choice",
          label: "排序",
          options: COPY_ORDER_OPTIONS.map((item) => ({
            label: item.label,
            value: item.value,
            result: { extern: { ordering: item.value } },
          })),
        },
      ],
    },
    data: { values },
  };
}

async function getCapabilities(): Promise<CapabilitiesBundleContract> {
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "capabilities",
      actions: [
        {
          key: "home.recommend",
          title: "漫画推荐",
          fnPath: "getHomeRecommend",
        },
        { key: "home.newest", title: "全新上架", fnPath: "getHomeNewest" },
        { key: "home.discover", title: "发现", fnPath: "getHomeDiscover" },
        { key: "home.rank", title: "排行榜", fnPath: "getHomeRank" },
      ],
    },
    data: {},
  };
}
async function getAdvancedSearchScheme(): Promise<AdvancedSearchContract> {
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "advancedSearch",
      title: "高级搜索",
      fields: [
        {
          key: "q_type",
          kind: "choice",
          label: "搜索范围",
          options: SEARCH_SCOPE_OPTIONS.map((item) => ({ label: item.label, value: item.value })),
        },
      ],
    },
    data: { values: { q_type: "" } },
  };
}

async function searchComic(payload: SearchPayload & { __breezeReadScope?: string } = {}): Promise<SearchResultContract> {
  const apiBase = await resolveApiBase();
  const extern = toStringMap(payload.extern);
  const page = Math.max(1, Number(payload.page ?? 1) || 1);
  const keyword = String(payload.keyword ?? extern.keyword ?? "").trim();
  const topicRequest = extern.copySearchTopic;
  if (topicRequest === true || typeof topicRequest === "string") {
    const theme = topicRequest === true
      ? (keyword && findCopySearchTopic(
        await getDiscoverThemeOptions(apiBase), keyword, extern.copySearchVariants,
      )?.value) || ""
      : topicRequest;
    if (!COPY_THEME_SLUG.test(theme)) {
      return copySearchResponse(page, payload.extern, { list: [], total: 0 });
    }
    const params = new URLSearchParams({
      limit: String(SEARCH_PAGE_SIZE),
      offset: String((page - 1) * SEARCH_PAGE_SIZE),
      free_type: "1",
      ordering: "-datetime_updated",
      theme,
      platform: await resolvePlatformValue(),
    });
    const json = await fetchCopyApi<SearchApiData>(`${apiBase}/comics?${params.toString()}`, copyReadScopeOptions(payload.__breezeReadScope));
    return copySearchResponse(page, payload.extern, toStringMap(json.results), SEARCH_PAGE_SIZE);
  }
  const externSearchType = String(extern.searchType ?? "").trim();
  const externPathWord = String(extern.pathWord ?? "").trim();
  const externApiUrl = String(extern.apiUrl ?? extern.searchUrl ?? extern.url ?? "").trim();

  const scopeQType = normalizeCopySearchScope(extern.q_type);

  if (!keyword && !externApiUrl) {
    throw new Error("keyword 不能为空");
  }

  const apiUrl = externApiUrl
    ? (() => {
        const parsed = new URL(externApiUrl);
        if (parsed.pathname.endsWith("/search/comic")) {
          parsed.searchParams.set(
            "q_type",
            normalizeCopySearchScope(extern.q_type ?? parsed.searchParams.get("q_type")),
          );
        }
        if (externPathWord && externSearchType === "theme") {
          parsed.searchParams.set("theme", externPathWord);
        }
        if (externPathWord && externSearchType === "author") {
          parsed.searchParams.set("author", externPathWord);
        }
        const limitFromUrl = Number(parsed.searchParams.get("limit") ?? 0);
        const resolvedLimit =
          Number.isFinite(limitFromUrl) && limitFromUrl > 0 ? limitFromUrl : SEARCH_PAGE_SIZE;
        parsed.searchParams.set("limit", String(resolvedLimit));
        parsed.searchParams.set("offset", String((page - 1) * resolvedLimit));
        return parsed.toString();
      })()
    : (() => {
        const offset = (page - 1) * SEARCH_PAGE_SIZE;
        const params = new URLSearchParams({
          limit: String(SEARCH_PAGE_SIZE),
          offset: String(offset),
          q: keyword,
          q_type: scopeQType,
          platform: "1",
        });
        return `${apiBase}/search/comic?${params.toString()}`;
      })();
  const json = await fetchCopyApi<SearchApiData>(apiUrl, copyReadScopeOptions(payload.__breezeReadScope));

  if (Number(json.code ?? 0) !== 200) {
    throw new Error(json.message || "搜索失败");
  }

  const requestedLimit = Number(new URL(apiUrl).searchParams.get("limit"));
  return copySearchResponse(page, payload.extern, toStringMap(json.results), requestedLimit);
}

function copySearchResponse(
  page: number,
  extern: SearchPayload["extern"],
  data: Record<string, unknown>,
  limit = SEARCH_PAGE_SIZE,
): SearchResultContract {
  if (!Array.isArray(data.list)) {
    throw new Error("搜索结果格式错误");
  }
  const items = data.list.map((row) => {
    const item = mapSearchComicToGrid(row as SearchApiComic);
    if (!item) {
      throw new Error("搜索结果格式错误");
    }
    return item;
  });

  const offset = (page - 1) * limit;
  if ((data.offset != null && nonnegativeInteger(data.offset) !== offset) ||
      (data.limit != null && nonnegativeInteger(data.limit) !== limit) || items.length > limit) {
    throw new Error("搜索分页返回不一致，请重试");
  }
  const total = nonnegativeInteger(data.total);
  const observedEnd = offset + items.length;
  if (total !== null && (items.length === 0 ? offset < total : observedEnd !== Math.min(offset + limit, total))) {
    throw new Error("搜索分页返回不完整，请重试");
  }
  const paging = total === null
    ? { page, pages: page, total: 0, hasReachedMax: items.length < limit }
    : createPagingInfo(page, Math.ceil(total / limit), total);

  return {
    source: PLUGIN_ID,
    extern: extern ?? null,
    scheme: {
      version: "1.0.0",
      type: "searchResult",
      source: PLUGIN_ID,
      list: "comicGrid",
    },
    data: {
      paging,
      items,
    },
    paging,
    items,
  };
}

async function readOnPublicComicRoute<T>(
  read: (route: PublicComicRoute) => Promise<T>,
  { download, follow, allowMirrorRecovery }: { download: boolean; follow: boolean; allowMirrorRecovery: boolean },
) {
  const selected = await readRouteSelection();
  const hasPublicWinner = isCopyAutoChoice(selected.choice) && !isCopyAccountChoice(selected.effective);
  const readerToken = hasPublicWinner && !download && !follow ? await loadAuthToken() : "";
  const useAccountRoute = hasPublicWinner && (download || Boolean(readerToken));
  const measured = useAccountRoute ? await measuredCopyAccountReadingChoices() : undefined;
  const preferred = useAccountRoute ? measured?.[0] ?? COPY_DEFAULT_CHOICE : selected.effective;
  const deadline = Date.now() + 12_000;
  const speed = readerToken && allowMirrorRecovery ? await readLineSpeeds() : null;
  const verifiedMirror = Boolean(speed && !speed.stale && speed.results.some((row) =>
    row.choice === selected.effective && row.ok && row.ms !== null));
  const assertCurrent = async () => {
    const current = await readRouteSelection();
    if (current.revision !== selected.revision || current.choice !== selected.choice ||
        current.platform !== selected.platform || current.effective !== selected.effective ||
        await loadAuthToken() !== readerToken || routeRevision !== selected.revision) {
      throw new CopyFollowError("sourceUnavailable", false);
    }
  };
  const assertMirrorCurrent = async () => {
    const current = await readLineSpeeds();
    if (!current || current.stale || current.revision !== speed?.revision) {
      throw new CopyFollowError("sourceUnavailable", false);
    }
    await assertCurrent();
  };
  const context = (choice: string, recover: boolean): PublicComicRoute => ({
    apiBase: apiBaseFromChoice(choice), platform: selected.platform,
    fallback: choice !== preferred,
    ...(recover ? { recovery: {
      deadline, anonymousMirror: choice === selected.effective,
      assertCurrent: choice === selected.effective ? assertMirrorCurrent : assertCurrent,
    } } : {}),
  });
  const attempt = async (choice: string, recover: boolean) => {
    const route = context(choice, recover);
    const assertFresh = route.recovery?.assertCurrent ?? (verifiedMirror ? assertCurrent : undefined);
    await assertFresh?.();
    const result = await read(route);
    await assertFresh?.();
    return result;
  };
  const accessDenied = (error: CopyFollowError) =>
    download && [401, 403, 451].includes(error.status ?? 0);
  try {
    return await attempt(preferred, verifiedMirror);
  } catch (error) {
    if (!isCopyAutoChoice(selected.choice) || !(error instanceof CopyFollowError) ||
        !error.retryable || accessDenied(error) || routeRevision !== selected.revision || Date.now() >= deadline) {
      throw error;
    }
    let recover = verifiedMirror && temporaryCopyReadFailure(error);
    const passing = measured ?? await measuredCopyAccountReadingChoices();
    const candidates = [...new Set(recover ? passing : [
      ...passing, COPY_DEFAULT_CHOICE, "官方App线路", "大陆专线1",
    ])].filter((choice) => choice !== preferred).slice(0, 2);
    for (const candidate of candidates) {
      if (routeRevision !== selected.revision || Date.now() >= deadline) break;
      // Leave one normal public request window for the verified mirror.
      if (recover && deadline - Date.now() <= publicMirrorWindowMs) break;
      try {
        const result = await attempt(candidate, recover);
        if (routeRevision === selected.revision) return result;
        break;
      } catch (alternateError) {
        // An alternate cannot impose a different access policy or turn a
        // temporary failure into a work removal on the selected route.
        recover &&= temporaryCopyReadFailure(alternateError);
        if (!(alternateError instanceof CopyFollowError)) break;
        if (download && (!alternateError.retryable || accessDenied(alternateError))) throw alternateError;
        if (!alternateError.retryable) break;
      }
    }
    if (recover && Date.now() < deadline) return attempt(selected.effective, true);
    throw error;
  }
}

function isTemporaryCopyStatus(status: number | null) {
  return status === 408 || status === 425 || (status != null && status >= 500 && status <= 599);
}

function temporaryCopyReadFailure(error: unknown) {
  return error instanceof CopyFollowError && error.retryable && !error.restricted &&
    (error.reason === "network" ||
      (error.reason === "sourceUnavailable" && isTemporaryCopyStatus(error.status)));
}

async function readCopyReaderChapter(comicId: string, chapterId: string, route: PublicComicRoute) {
  const recovery = route.recovery!;
  if (recovery.anonymousMirror) {
    const chapter = await readCopyDownloadChapter(
      route.apiBase, comicId, chapterId, getPublicCopyRequest(route.apiBase, route.platform, route.preferApp),
      recovery.deadline, undefined, isHotMangaApiBase(route.apiBase) ? "chapter" : "chapter2",
    );
    return { name: chapter.chapterName, contents: chapter.imageUrls.map((url) => ({ url })), words: [] };
  }
  try {
    return await readChapterContent(comicId, chapterId, route);
  } catch (error) {
    if (isTimeoutError(error) ||
        (isNetworkError(error) && !/redirect|abort|cancel/i.test(String((error as Error & { cause?: unknown }).cause)))) {
      throw new CopyFollowError("network");
    }
    if (isHTTPError(error) && isTemporaryCopyStatus(error.response.status) &&
        !error.response.headers.has("retry-after") &&
        ![210, 401, 403, 404, 410, 429, 451].includes(Number(toStringMap(error.data).code))) {
      throw new CopyFollowError("sourceUnavailable", true, error.response.status);
    }
    throw error;
  }
}

function detailReadError(error: CopyFollowError, message?: string) {
  if (error.reason === "signInRequired") return buildUnauthorizedError(PLUGIN_ID, "请先登录拷贝漫画");
  const messages = {
    network: "连接拷贝漫画失败，请检查网络或切换线路后重试",
    sourceUnavailable: error.restricted ? "站点限制了此作品的访问" : "拷贝线路暂不可用，请稍后重试",
    invalidResponse: "拷贝暂未返回有效的详情或章节，请重试或切换线路",
    notFound: "拷贝漫画已下架此作品或找不到它",
  };
  return new Error(JSON.stringify({
    type: "comic_detail_error", source: PLUGIN_ID, reason: error.reason,
    retryable: error.retryable, httpStatus: error.status, message: message ?? messages[error.reason],
  }, null, 2));
}

function copyDownloadReadError(error: CopyFollowError) {
  if (error.status === 429) {
    return new Error(JSON.stringify({
      type: "comic_detail_error", source: PLUGIN_ID, reason: "rateLimited",
      retryable: true, httpStatus: 429, message: "拷贝线路请求过于频繁，请稍后重试",
    }));
  }
  if (error.reason === "notFound") {
    return detailReadError(error, "拷贝漫画找不到所选章节");
  }
  return detailReadError(error);
}

function copyDownloadRouteUnavailable(error?: CopyFollowError) {
  return new Error(JSON.stringify({
    type: "comic_download_route_unavailable",
    reason: error?.reason ?? "noCandidate",
    ...(error ? { retryable: error.retryable, httpStatus: error.status } : {}),
    message: "暂未找到可下载该章节的拷贝线路，请稍后重试或切换线路",
  }));
}

async function getComicDetailResult(payload: ComicDetailPayload, options: {
  reader?: { chapterId: string; extern: Record<string, unknown> };
  allowMirrorRecovery?: boolean;
} = {}): Promise<{
  detail: ComicDetailContract;
  route: PublicComicRoute;
  preparedChapter?: { target: MappedEpItem; content: CachedChapterContent };
}> {
  const comicId = String(payload.comicId ?? "").trim();
  if (!comicId) {
    throw new Error("comicId 不能为空");
  }
  const follow = toStringMap(payload.extern).comicFollow === true;
  const download = payload.extern?.comicDownload === true;
  const reader = options.reader;
  let resolvedChapterId = "";
  const cacheGeneration = follow ? undefined : await responseCacheGeneration();
  const { detail: detailResp, summary: detailSummary, eps, route, preparedChapter } = await readOnPublicComicRoute(async (candidate) => {
    const { apiBase, platform, fallback } = candidate;
    const publicDetail = await readCopyPublicDetail(apiBase, comicId, {
      ...getPublicCopyRequest(apiBase, platform),
      timeoutMs: copyRouteReadTimeout(candidate, 4500),
    }, {
      requireSummary: follow, strictIdentity: follow || fallback,
    });
    await candidate.recovery?.assertCurrent();
    const route = { ...candidate, preferApp: publicDetail.usedApp, cacheGeneration };
    if (follow) return { ...publicDetail, route, eps: [], preparedChapter: undefined };
    const result = toStringMap(publicDetail.detail.results);
    const comic = toStringMap(result.comic);
    const raw = result.groups ?? comic.groups;
    const groups = normalizeGroups(raw);
    const groupCount = Array.isArray(raw) ? raw.length : Object.keys(toStringMap(raw)).length;
    if ((raw != null && typeof raw !== "object") || groups.length !== groupCount ||
        new Set(groups.map((group) => group.path_word?.trim())).size !== groups.length ||
        (!groups.length && Object.keys(toStringMap(comic.last_chapter)).length > 0)) {
      throw new CopyFollowError("invalidResponse");
    }
    const workSlug = String(comic.path_word ?? comicId).trim();
    const eps = await fetchAllGroupChapters(comicId, groups, route, publicDetail.summary, workSlug);
    if (!reader || !route.recovery || !eps.length) return { ...publicDetail, route, eps, preparedChapter: undefined };
    const target = pickTargetChapter(eps, resolvedChapterId || reader.chapterId, reader.extern)!;
    const matchesRequest = !reader.chapterId || target.id === reader.chapterId ||
      (/^\d+$/.test(reader.chapterId) && target.order === Number(reader.chapterId));
    if (route.recovery.anonymousMirror &&
        (!matchesRequest || (resolvedChapterId && target.id !== resolvedChapterId))) {
      throw new CopyFollowError("invalidResponse", false);
    }
    resolvedChapterId = target.id;
    await route.recovery.assertCurrent();
    const content = await readCopyReaderChapter(comicId, target.id, route);
    return { ...publicDetail, route, eps, preparedChapter: { target, content } };
  }, { follow, download, allowMirrorRecovery: options.allowMirrorRecovery !== false }).catch((error: unknown) => {
    if (!follow && error instanceof CopyFollowError) {
      throw download ? copyDownloadReadError(error) : detailReadError(error);
    }
    throw error;
  });
  const resultMap = toStringMap(detailResp.results);
  const detailMap = toStringMap(resultMap.comic);
  const authorsRaw = Array.isArray(detailMap.author) ? detailMap.author : [];
  const themesRaw = Array.isArray(detailMap.theme) ? detailMap.theme : [];
  const statusMap = toStringMap(detailMap.status);
  const regionMap = toStringMap(detailMap.region);
  const reclassMap = toStringMap(detailMap.reclass);
  const lastChapterMap = toStringMap(detailMap.last_chapter);
  const authorEntries = authorsRaw
    .map((item) => {
      const authorMap = toStringMap(item);
      return {
        name: String("name" in authorMap ? (authorMap.name ?? "") : "").trim(),
        pathWord: String("path_word" in authorMap ? (authorMap.path_word ?? "") : "").trim(),
      };
    })
    .filter((item) => item.name);
  const themeEntries = themesRaw
    .map((item) => {
      const themeMap = toStringMap(item);
      return {
        name: String("name" in themeMap ? (themeMap.name ?? "") : "").trim(),
        pathWord: String("path_word" in themeMap ? (themeMap.path_word ?? "") : "").trim(),
      };
    })
    .filter((item) => item.name);
  const authorActions = authorEntries.map((author) =>
    createActionItem(
      author.name,
      openTagAuthorListAction(`作者：${author.name}`, {
        author: author.pathWord || author.name,
        ordering: "-datetime_updated",
      }),
    ),
  );
  const themeActions = themeEntries.map((theme) =>
    createActionItem(
      theme.name,
      openTagAuthorListAction(`分类：${theme.name}`, {
        theme: theme.pathWord || theme.name,
        ordering: "-datetime_updated",
      }),
    ),
  );
  const statusText =
    String("display" in statusMap ? (statusMap.display ?? "") : "").trim() ||
    String("value" in statusMap ? (statusMap.value ?? "") : "").trim();
  // The full detail can contain cached chapters. Only publish its summary if
  // the displayed chapter list confirms the count and the latest identity.
  const followSummary = detailSummary && (
    follow || (
      detailSummary.chapterCount === eps.length &&
      (eps.length === 0 || eps.some((ep) => ep.id === detailSummary.latestChapterId))
    )
  ) ? detailSummary : null;
  const updateText = formatDateTime(
    "datetime_updated" in detailMap ? detailMap.datetime_updated : "",
  );
  const title = String("name" in detailMap ? (detailMap.name ?? "") : "").trim() || comicId;
  const coverUrl = String("cover" in detailMap ? (detailMap.cover ?? "") : "").trim();
  const popular = nonnegativeInteger(resultMap.popular) ?? nonnegativeInteger(detailMap.popular);
  const regionText = String("display" in regionMap ? (regionMap.display ?? "") : "").trim();
  const reclassText = String("display" in reclassMap ? (reclassMap.display ?? "") : "").trim();
  const lastChapterName = String(
    "name" in lastChapterMap ? (lastChapterMap.name ?? "") : "",
  ).trim();
  async function resolveIsFavourite(): Promise<boolean> {
    try {
      if (await loadAuthToken()) {
        return (await queryFavoriteCollectId(comicId)) !== null;
      }
    } catch {
      // ignore, default to false
    }
    return false;
  }
  async function fetchCommentTotal(): Promise<number | null> {
    try {
      const uuidForCount = String(detailMap.uuid ?? "").trim();
      if (!uuidForCount) return null;
      const countParams = new URLSearchParams({
        comic_id: uuidForCount,
        limit: "1",
        offset: "0",
        platform: route.platform,
      });
      const { data: countJson } = await readCopyPublicApi<ComicCommentData>(
        new URL(`${route.apiBase}/comments?${countParams.toString()}`),
        getPublicCopyRequest(route.apiBase, route.platform, route.preferApp),
      );
      return nonnegativeInteger(toStringMap(countJson.results).total);
    } catch {
      return null;
    }
  }
  const [isFavourite, totalComments] = follow
    ? [false, null] as const
    : await Promise.all([resolveIsFavourite(), fetchCommentTotal()]);
  if (route.recovery) {
    try {
      await route.recovery.assertCurrent();
    } catch (error) {
      if (error instanceof CopyFollowError) throw detailReadError(error);
      throw error;
    }
  }

  const normal = {
    comicInfo: {
      id: comicId,
      title,
      titleMeta: [
        createActionItem(`状态：${statusText || "未知"}`),
        createActionItem(`类型：${reclassText || "未知"}`),
        createActionItem(`分区：${regionText || "未知"}`),
        createActionItem(`更新时间：${updateText || "未知"}`),
        createActionItem(`最新：${lastChapterName || "未知"}`),
        createActionItem(`章节数：${(follow ? detailSummary?.chapterCount : undefined) ?? eps.length}`),
        ...(popular === null ? [] : [createActionItem(`热度：${popular}`)]),
      ],
      creator: {
        id: "",
        name: "",
        avatar: createImage({
          id: "",
          url: NOT_FOUND_IMAGE_URL,
          name: "",
          path: "",
          extern: {},
        }),
        onTap: null,
        extern: {},
      },
      description: String("brief" in detailMap ? (detailMap.brief ?? "") : ""),
      cover: createImage({
        id: comicId,
        url: coverUrl || NOT_FOUND_IMAGE_URL,
        name: `${comicId}.jpg`,
        path: `comic/${comicId}/cover.jpg`,
        extern: {},
      }),
      metadata: [
        {
          type: "author",
          name: "作者",
          value: authorActions,
        },
        {
          type: "tags",
          name: "标签",
          value: themeActions,
        },
      ].filter((meta) => {
        const value = toStringMap(meta).value;
        return Array.isArray(value) && value.length > 0;
      }),
      extern: {},
    },
    eps: eps.map((ep) => ({
      id: ep.id,
      requestId: ep.id,
      logicalKey: ep.id,
      storageChapterId: ep.id,
      name: ep.name,
      order: ep.order,
      groupTitle: ep.groupTitle,
      extern: ep.extern,
    })),
    recommend: [],
    totalViews: 0,
    totalLikes: 0,
    totalComments: totalComments ?? 0,
    isFavourite,
    isLiked: false,
    allowComments: true,
    allowLike: false,
    allowCollected: true,
    allowDownload: true,
    extern: {
      metricAvailability: { totalViews: false, totalLikes: false, totalComments: totalComments !== null },
      ...(followSummary ? { comicFollow: followSummary } : {}),
    },
  };

  const scheme = {
    version: "1.0.0" as const,
    type: "comicDetail" as const,
    source: PLUGIN_ID,
  };

  const data = {
    normal,
    raw: {
      comicInfo: detailMap,
      series: eps,
    },
  };

  return {
    route,
    preparedChapter,
    detail: { source: PLUGIN_ID, comicId, extern: payload.extern ?? null, scheme, data },
  };
}

async function getComicDetail(payload: ComicDetailPayload = {}): Promise<ComicDetailContract> {
  return (await getComicDetailResult(payload)).detail;
}

async function getReadSnapshot(payload: ReadSnapshotPayload = {}): Promise<ReadSnapshotContract> {
  const comicId = String(payload.comicId ?? "").trim();
  if (!comicId) {
    throw new Error("comicId 不能为空");
  }
  const extern = toStringMap(payload.extern);
  const inputChapterId = String(payload.chapterId ?? extern.chapterId ?? "").trim();

  const { detail, route, preparedChapter } = await getComicDetailResult({
    comicId,
    extern: payload.extern,
  }, { reader: { chapterId: inputChapterId, extern } });
  const normal = toStringMap(toStringMap(detail.data).normal);
  const comicInfo = toStringMap(normal.comicInfo);
  const eps = (Array.isArray(normal.eps) ? normal.eps : [])
    .map((item) => toStringMap(item))
    .map((item) => {
      const groupTitle = String(item.groupTitle ?? "").trim();
      return {
        id: String(item.id ?? "").trim(),
        name: String(item.name ?? "").trim(),
        order: Number(item.order ?? 0) || 0,
        groupTitle: groupTitle || null,
        extern: toStringMap(item.extern),
      };
    })
    .filter((item) => item.id);
  if (eps.length === 0) {
    throw new Error("未找到可阅读章节");
  }
  const targetChapter = preparedChapter?.target ?? pickTargetChapter(eps, inputChapterId, extern);
  const chapterId = targetChapter.id;

  const chapterContent = preparedChapter?.content ?? await readChapterContent(comicId, chapterId, route);
  const imageUrls = sortChapterImageUrls(chapterContent.contents, chapterContent.words);
  const pages = imageUrls.map((imageUrl, index) => {
    const name = extractImageName(imageUrl, index);
    const id = `${chapterId}-${index + 1}`;
    return {
      id,
      name,
      path: `comic/${comicId}/${id}/${name}`,
      url: imageUrl,
      extern: {
        index: index + 1,
        comicId,
        chapterId,
        chapterOrder: targetChapter.order,
      },
    };
  });
  if (pages.length === 0) {
    throw new Error("当前章节没有可用图片");
  }

  const chapters = eps.map((item) => ({
    id: item.id,
    name: item.name || `章节 ${item.id}`,
    order: item.order,
    extern: {
      ...item.extern,
      comicId,
      chapterId: item.id,
      order: item.order,
    },
  }));

  return {
    source: PLUGIN_ID,
    extern: payload.extern ?? null,
    data: {
      comic: {
        id: String(comicInfo.id ?? comicId),
        source: PLUGIN_ID,
        title: String(comicInfo.title ?? ""),
        extern: toStringMap(comicInfo.extern),
      },
      chapter: {
        id: chapterId,
        requestId: chapterId,
        logicalKey: chapterId,
        storageChapterId: chapterId,
        name: chapterContent.name || targetChapter.name || `章节 ${chapterId}`,
        order: targetChapter.order,
        groupTitle: targetChapter.groupTitle,
        pages,
        extern: targetChapter.extern,
      },
      chapters,
    },
  };
}

async function getDownloadChapter(
  payload: ChapterPayload, selected: Awaited<ReturnType<typeof readRouteSelection>>,
  comicId: string, chapterId: string,
): Promise<ChapterContentContract> {
  if (!chapterId) throw detailReadError(new CopyFollowError("invalidResponse", false), "缺少要下载的章节标识");
  let excluded: ReadonlySet<string>;
  try {
    excluded = readCopyDownloadExclusions(payload.downloadRoute?.excluded);
  } catch (error) {
    if (error instanceof CopyFollowError) throw detailReadError(error, "下载线路参数无效");
    throw error;
  }
  const deadline = Date.now() + copyDownloadRouteBudgetMs;
  const automatic = isCopyAutoChoice(selected.choice);
  const measured = automatic ? await measuredCopyAccountReadingChoices() : [];
  const choices = automatic ? [
    selected.effective, ...measured, COPY_DEFAULT_CHOICE, "官方App线路", "大陆专线1", "官方国际线路",
  ] : [selected.choice];
  const compatibleBases = choices.filter(isCopyAccountChoice).map(apiBaseFromChoice);
  const candidates = [...new Set(compatibleBases)]
    .filter((base) => !excluded.has(copyDownloadRouteKey(base)))
    .slice(0, copyDownloadRouteCandidateLimit);

  const changed = () => detailReadError(
    new CopyFollowError("sourceUnavailable", false), "拷贝下载线路或请求标识已变更，请重试",
  );
  const assertSelection = async () => {
    const current = await readRouteSelection();
    if (current.choice !== selected.choice || current.platform !== selected.platform ||
        current.revision !== selected.revision || routeRevision !== selected.revision) throw changed();
  };
  const selectedBase = compatibleBases[0];
  let lastFailure: CopyFollowError | undefined;
  for (const base of candidates) {
    if (routeRevision !== selected.revision) throw changed();
    if (Date.now() >= deadline) break;
    let manifest: Awaited<ReturnType<typeof readCopyDownloadChapter>>;
    try {
      manifest = await readCopyDownloadChapter(
        base, comicId, chapterId, getPublicCopyRequest(base, selected.platform),
        automatic ? Math.min(deadline, Date.now() + copyDownloadRouteCandidateBudgetMs) : deadline,
        base === selectedBase ? async () => {
          await assertSelection();
          return loadTrustedCopyChapterToken(base);
        } : undefined,
      );
    } catch (error) {
      if (!(error instanceof CopyFollowError)) throw error;
      await assertSelection();
      const status = error.status;
      if (!error.retryable || status === 401 || status === 403 ||
          status === 404 || status === 410 || status === 451) {
        if (error.retryable) throw copyDownloadRouteUnavailable(
          new CopyFollowError(error.reason, false, status),
        );
        throw copyDownloadReadError(error);
      }
      lastFailure = error;
      continue;
    }
    await assertSelection();
    if (Date.now() >= deadline) break;

    const extern = toStringMap(payload.extern);
    const order = Number(extern.order ?? 0);
    const chapterOrder = Number.isSafeInteger(order) && order >= 0 ? order : 0;
    const names = manifest.imageUrls.map(extractImageName);
    const nameCounts = new Map<string, number>();
    for (const name of names) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    const pages = manifest.imageUrls.map((url, index) => {
      const name = names[index]!;
      const disambiguator = nameCounts.get(name)! > 1 ? `page-${index + 1}/` : "";
      const backgroundDownload = copyBackgroundDownload(url);
      return {
        id: `${chapterId}-${index + 1}`, name, url,
        path: `comic/${comicId}/${chapterId}/${disambiguator}${name}`,
        extern: {
          index: index + 1, comicId, chapterId, chapterOrder, copyDownloadRouteVersion: 1,
          ...(backgroundDownload ? { backgroundDownload } : {}),
        },
      };
    });
    const chapter: ChapterWithPages = {
      id: chapterId, requestId: chapterId, logicalKey: chapterId, storageChapterId: chapterId,
      name: manifest.chapterName || `章节 ${chapterId}`, order: chapterOrder,
      groupTitle: String(extern.groupName ?? "").trim() || null,
      pages,
      extern: {
        downloadRoute: { version: 1, key: copyDownloadRouteKey(base), apiHost: new URL(base).hostname, ...(!automatic ? { canSwitch: false } : {}) },
      },
    };
    return {
      source: PLUGIN_ID, comicId, chapterId, extern: payload.extern ?? null,
      scheme: { version: "1.0.0", type: "chapterContent", source: PLUGIN_ID },
      data: {
        comic: { id: comicId, source: PLUGIN_ID, title: manifest.comicTitle || chapter.name, extern: {} },
        chapter, chapters: [],
      },
    };
  }
  await assertSelection();
  throw copyDownloadRouteUnavailable(lastFailure);
}

async function getChapter(payload: ChapterPayload = {}): Promise<ChapterContentContract> {
  const extern = toStringMap(payload.extern);
  const comicId = String(payload.comicId ?? extern.comicId ?? "").trim();
  const inputChapterId = String(payload.chapterId ?? extern.chapterId ?? "").trim();
  if (!comicId) {
    throw new Error("comicId 不能为空");
  }
  if (payload.downloadRoute?.version === 1) {
    const selected = await readRouteSelection();
    // Old fixed-route tasks may carry an order instead of an upstream chapter
    // ID. Keep catalog resolution for those tasks until an exact ID is known.
    const fixedWithExactId = isCopyAccountChoice(selected.choice) &&
      inputChapterId !== "" && !/^\d+$/.test(inputChapterId);
    if (isCopyAutoChoice(selected.choice) || fixedWithExactId) {
      return getDownloadChapter(payload, selected, comicId, inputChapterId);
    }
  }

  const { detail, route } = await getComicDetailResult({
    comicId,
    extern: payload.extern,
  }, { allowMirrorRecovery: false });
  const normal = toStringMap(toStringMap(detail.data).normal);
  const eps = (Array.isArray(normal.eps) ? normal.eps : [])
    .map((item) => toStringMap(item))
    .map((item) => {
      const groupTitle = String(item.groupTitle ?? "").trim();
      return {
        id: String(item.id ?? "").trim(),
        name: String(item.name ?? "").trim(),
        order: Number(item.order ?? 0) || 0,
        groupTitle: groupTitle || null,
        extern: toStringMap(item.extern),
      };
    })
    .filter((item) => item.id);
  if (eps.length === 0) {
    throw new Error("未找到可下载章节");
  }
  const targetChapter = pickTargetChapter(eps, inputChapterId, extern);
  const chapterId = targetChapter.id;

  const chapterContent = await readChapterContent(comicId, chapterId, route);
  const imageUrls = sortChapterImageUrls(chapterContent.contents, chapterContent.words);
  const docs = imageUrls.map((imageUrl, index) => {
    const name = extractImageName(imageUrl, index);
    const path = `comic/${comicId}/${chapterId}/${name}`;
    return {
      id: `${chapterId}-${index + 1}`,
      name,
      path,
      url: imageUrl,
      extern: {
        index: index + 1,
        comicId,
        chapterId,
        chapterOrder: targetChapter.order,
      },
    };
  });
  if (docs.length === 0) {
    throw new Error("当前章节没有可下载图片");
  }

  const chapter = {
    id: chapterId,
    requestId: chapterId,
    logicalKey: chapterId,
    storageChapterId: chapterId,
    name: chapterContent.name || targetChapter.name || `章节 ${chapterId}`,
    order: targetChapter.order,
    groupTitle: targetChapter.groupTitle,
    pages: docs,
    extern: targetChapter.extern,
  };

  return {
    source: PLUGIN_ID,
    comicId,
    chapterId,
    extern: payload.extern ?? null,
    scheme: {
      version: "1.0.0",
      type: "chapterContent",
      source: PLUGIN_ID,
    },
    data: {
      comic: {
        id: comicId,
        source: PLUGIN_ID,
        title: chapter.name,
        extern: {},
      },
      chapter,
      chapters: eps.map((item) => ({
        id: item.id,
        requestId: item.id,
        logicalKey: item.id,
        storageChapterId: item.id,
        name: item.name || `章节 ${item.id}`,
        order: item.order,
        extern: {
          ...item.extern,
          comicId,
          chapterId: item.id,
          order: item.order,
        },
      })),
    },
  };
}

async function fetchImageBytes({
  url = "",
  timeoutMs = 30000,
  taskGroupKey = "",
  extern = {},
}: FetchImagePayload = {}): Promise<Uint8Array<ArrayBufferLike>> {
  const targetUrl = String(url).trim();
  if (!targetUrl) {
    throw new Error("url 不能为空");
  }

  const externMap = toStringMap(extern);
  const resolvedTaskGroupKey = String(
    taskGroupKey || externMap.taskGroupKey || externMap.qjsTaskGroupKey || externMap.comicId || "",
  ).trim();
  if (resolvedTaskGroupKey && (await isTaskGroupCancelled(resolvedTaskGroupKey))) {
    throw new Error(DOWNLOAD_CANCELLED_MESSAGE);
  }

  const resolvedTimeout = Math.max(0, Number(timeoutMs) || 30000);
  const isDownloadRoute = externMap.copyDownloadRouteVersion === 1;
  const arrayBuffer = await ky
    .get(targetUrl, {
      headers: {
        Accept: copyImageAccept,
        "x-rquickjs-host-offload-binary-v1": "1",
      },
      timeout: isDownloadRoute ? Math.min(resolvedTimeout, copyDownloadImageTimeoutMs) : resolvedTimeout,
      ...(isDownloadRoute ? { retry: 0, credentials: "omit" } : {}),
    })
    .arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.byteLength === 0) {
    throw new Error("图片数据为空");
  }
  return bytes;
}

async function getDownloadConcurrency(): Promise<{ concurrency: number }> {
  return { concurrency: 1 };
}

async function submitCopyLogin(
  username: string,
  password: string,
): Promise<CopyApiResponse<MemberInfoResult>> {
  const route = await readRouteSelection();
  const apiBase = await selectLoginBase(route);
  if (route.revision !== routeRevision) throw new Error("线路已切换，请重新登录");
  const nodeBuffer = globalThis.Buffer;
  if (!nodeBuffer) {
    throw new Error("当前运行时不支持 base64 编码");
  }
  const rawBytes = new TextEncoder().encode(`${password}-1729`);
  const encrypted = nodeBuffer.from(rawBytes).toString("base64");
  const body = new URLSearchParams({
    username,
    password: encrypted,
    salt: "1729",
  }).toString();
  let response: Response;
  try {
    response = await ky.post(`${apiBase}/login`, {
      headers: {
        ...getAccountApiHeaders(apiBase),
        "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
      },
      body,
      ...copyAccountRequest,
      throwHttpErrors: false,
    });
  } catch (error) {
    throw new Error((error as { name?: string })?.name === "TimeoutError"
      ? "连接服务器超时" : "网络连接失败，请检查网络后重试");
  }
  let resp: CopyApiResponse<MemberInfoResult & { token?: string }>;
  try {
    resp = await response.json() as typeof resp;
  } catch {
    throw new Error(`服务器响应异常 (HTTP ${response.status})`);
  }
  if (!resp || typeof resp !== "object" || Array.isArray(resp)) {
    throw new Error(`服务器响应异常 (HTTP ${response.status})`);
  }
  if (!response.ok || Number(resp.code ?? 0) !== 200) {
    const reason = safeCopyLoginReason(resp, [username, password, encrypted]);
    throw new Error(reason || (!response.ok ? `服务器响应异常 (HTTP ${response.status})` : "登录未完成，网站未提供原因"));
  }
  const resultsMap = toStringMap(resp.results);
  const token = typeof resultsMap.token === "string" ? resultsMap.token.trim() : "";
  if (!token) {
    throw new Error("登录成功但未返回 token");
  }
  await saveAccountCredentials(pluginConfig, username, password, new URL(apiBase).origin);
  await Promise.all([
    authConfig.save(AUTH_TOKEN_CONFIG_KEY, token),
    authConfig.save(AUTH_USERNAME_CONFIG_KEY, username),
  ]);
  if (token !== await loadAuthToken() || username !== await loadAuthUsername()) {
    throw new Error("登录资料保存失败，请重试");
  }
  return resp;
}

async function getLoginBundle(): Promise<LoginBundleContract> {
  const stored = await readAccountCredentials(pluginConfig);
  const credentials = stored && accountBaseForOrigin(stored.origin) ? stored : null;
  const username = credentials?.account ?? await loadAuthUsername();
  const bundle = buildLoginBundle(PLUGIN_ID, {
    title: "拷贝漫画登录",
    fields: [
      { key: "username", kind: "text", label: "用户名", required: true },
      { key: "password", kind: "password", label: "密码", required: true },
    ],
    submitFnPath: "loginWithPassword",
    submitText: "登录",
    values: { username, password: credentials?.password ?? "" },
  });
  return {
    ...bundle,
    data: {
      ...bundle.data,
      // Registration is handled by the site's own form (captcha/invites may
      // change). Breeze opens this HTTPS page in the system browser only.
      registerUrl: "https://2026copy.com/web/login/?url=person%2Fhome",
      registerLabel: "注册账号",
    },
  };
}

async function loginWithPassword(payload: LoginSubmitPayload = {}): Promise<LoginSubmitResult> {
  const values = readLoginValues(payload);
  const payloadMap = toStringMap(payload);
  if (typeof payloadMap.savedCredentialOrigin === "string" &&
      !accountBaseForOrigin(payloadMap.savedCredentialOrigin)) {
    throw new Error("请在登录页重新输入拷贝漫画账号");
  }
  const username = String(
    values.username ?? ("username" in payloadMap ? payloadMap.username : "") ?? "",
  ).trim();
  const password = String(
    values.password ?? ("password" in payloadMap ? payloadMap.password : "") ?? "",
  );
  if (!username || !password) {
    throw new Error("用户名或密码不能为空");
  }
  await submitCopyLogin(username, password);
  return {
    source: PLUGIN_ID,
    message: "登录成功",
    data: { username },
  };
}

export async function updateAvatar(payload: Record<string, unknown> = {}) {
  if (payload.cancelled === true) return { ok: false, cancelled: true };
  const image = prepareCopyAvatarJpeg(payload.jpegBase64);
  const token = await loadAuthToken();
  if (!token) return { ok: false, avatarRestriction: "signIn", message: "请先登录后再更换头像" };
  await loadAccountRoutes(token);
  try {
    const confirmed = await createCopyAvatarHelper(copyProfileTransport, token).update(image);
    if (!confirmed) throw new Error("头像未保存");
    try {
      // Preserve the independently observed avatar all the way to the view.
      // The app member endpoint may still contain the old avatar after a web edit.
      const profile = await readCopyUserInfoBundle(confirmed, token);
      return { ok: true, confirmed: true, message: "头像已更新", profile };
    } catch {
      throw new CopyAvatarSubmittedError("头像已提交，暂时无法确认个人页资料，请刷新查看");
    }
  } catch (error) {
    if (error instanceof CopyAvatarSubmittedError) {
      return { ok: false, submitted: true, message: error.message };
    }
    if (error instanceof CopyAvatarRejectedError) {
      return { ok: false, avatarRestriction: error.restriction, message: error.message };
    }
    throw error;
  }
}

async function getUserInfoBundle(): Promise<UserInfoBundleContract> {
  return readCopyUserInfoBundle();
}

async function readCopyUserInfoBundle(
  confirmed?: CopyEditableProfile,
  expectedToken?: string,
): Promise<UserInfoBundleContract> {
  const token = await loadAuthToken();
  if (expectedToken && token !== expectedToken) throw new Error("账号已改变，请刷新资料");
  const { first, fallback, choice, authoritativeBase, username: storedUsername } = await loadAccountRoutes(token);
  let infoMap: Record<string, unknown> | undefined;
  let rejected = false;
  for (const base of uniqueBases(first, fallback)) {
    try {
      const response = await ky.get(`${base}/member/info?platform=1`, {
        ...copyAccountRequest,
        headers: getAuthedHeaders(base, token),
        throwHttpErrors: false,
        timeout: 4500,
      });
      const data = await response.json<CopyApiResponse<MemberInfoResult>>();
      if ((response.ok || response.status === 401) && Number(data?.code) === 401) {
        rejected ||= base === authoritativeBase;
        continue;
      }
      if (!response.ok || Number(data?.code) !== 200) continue;
      const result = toStringMap(data.results);
      const id = result.user_id;
      if ((typeof id !== "string" && typeof id !== "number") || !String(id).trim() || id === "me") continue;
      if (token !== await loadAuthToken()) throw new Error("账号已改变，请刷新资料");
      infoMap = result;
      verifiedAccountRoute = { token, choice, base };
      break;
    } catch {
      // Only a structured rejection from the account's own route can expire it.
    }
  }
  if (token !== await loadAuthToken()) throw new Error("账号已改变，请刷新资料");
  if (!infoMap) {
    if (rejected) throw buildUnauthorizedError(PLUGIN_ID);
    throw new Error("无法读取拷贝账号资料，请稍后重试");
  }
  const username =
    String(
      ("nickname" in infoMap ? infoMap.nickname : "") ??
        ("username" in infoMap ? infoMap.username : "") ??
        "",
    ).trim() || storedUsername;
  let avatarUrl = String("avatar" in infoMap ? (infoMap.avatar ?? "") : "").trim();
  let profile = confirmed;
  if (!profile && token) {
    try {
      profile = await createCopyAvatarHelper(copyProfileTransport, token).read(1800);
    } catch {
      // Sites without this optional web capability keep their app profile.
    }
  }
  const memberUsername = String(infoMap.username ?? storedUsername).trim();
  if (token !== await loadAuthToken()) throw new Error("账号已改变，请刷新资料");
  const sameAccount = !memberUsername || memberUsername === profile?.username;
  if (confirmed && !sameAccount) throw new Error("账号已改变，请刷新资料");
  if (profile && sameAccount) avatarUrl = profile.avatar.trim();
  const userId = String("user_id" in infoMap ? (infoMap.user_id ?? "") : "").trim();
  return {
    source: PLUGIN_ID,
    scheme: { version: "1.0.0", type: "userInfo" },
    data: {
      title: "拷贝漫画",
      avatar: {
        id: userId || "me",
        url: avatarUrl,
        name: avatarUrl ? `${userId || "me"}.jpg` : "",
        // Image identity includes the observed URL, so both disk and resized
        // Flutter image caches cannot reuse a previous avatar under user/me.jpg.
        path: avatarUrl ? `user/${userId || "me"}/avatar/${encodeURIComponent(avatarUrl)}.jpg` : "",
        extern: {},
      },
      lines: [username || "拷贝漫画用户", userId ? `ID: ${userId}` : ""],
      extern: { userId, username, avatarChangeNotice: "头像每30天可更换一次" },
    },
  };
}

async function startFavoriteAction(
  payload: FavoriteWorkflowStartPayload,
): Promise<FavoriteWorkflowResult> {
  const comicId = String(payload.comicId ?? "").trim();
  const action = payload.action;
  if (!comicId) {
    return {
      status: "failed",
      favorited: false,
      committed: false,
      message: "comicId 不能为空",
      errorCode: "INVALID_COMIC_ID",
    };
  }
  if (action === "add") {
    try {
      await addCopyFavorite(comicId);
      return { status: "completed", favorited: true, committed: true };
    } catch (error) {
      return {
        status: "failed",
        favorited: false,
        committed: false,
        message: error instanceof Error ? error.message : String(error),
        errorCode: "FAVORITE_REQUEST_FAILED",
      };
    }
  }
  if (action === "removeAll") {
    try {
      const account = await loadWorkAccountRequest();
      const collectId = await queryFavoriteCollectId(comicId, account);
      if (collectId !== null) await removeCopyFavorite(collectId, account);
      return { status: "completed", favorited: false, committed: collectId !== null };
    } catch (error) {
      return {
        status: "failed",
        favorited: true,
        committed: false,
        message: error instanceof Error ? error.message : String(error),
        errorCode: "FAVORITE_REQUEST_FAILED",
      };
    }
  }
  if (action === "removeFromTarget") {
    const contextMap = toStringMap(payload.context);
    const targetMap = toStringMap(contextMap.target);
    const targetId = String("id" in targetMap ? (targetMap.id ?? "") : "").trim();
    if (!targetId) {
      return {
        status: "failed",
        favorited: true,
        committed: false,
        message: "缺少当前收藏夹信息，无法安全移除",
        errorCode: "TARGET_REQUIRED",
      };
    }
    const collectId = nonnegativeInteger(targetId);
    if (!collectId) {
      return {
        status: "failed",
        favorited: true,
        committed: false,
        message: "收藏夹 ID 无效",
        errorCode: "INVALID_TARGET",
      };
    }
    try {
      const account = await loadWorkAccountRequest();
      const current = await queryFavoriteCollectId(comicId, account);
      if (current !== null && current !== collectId) {
        return {
          status: "failed",
          favorited: true,
          committed: false,
          message: "当前收藏不在目标收藏夹中，已拒绝移除",
          errorCode: "TARGET_MISMATCH",
        };
      }
      if (current !== null) await removeCopyFavorite(collectId, account);
      return { status: "completed", favorited: false, committed: current !== null };
    } catch (error) {
      return {
        status: "failed",
        favorited: true,
        committed: false,
        message: error instanceof Error ? error.message : String(error),
        errorCode: "FAVORITE_REQUEST_FAILED",
      };
    }
  }
  return {
    status: "failed",
    favorited: false,
    committed: false,
    message: "拷贝漫画只支持全局收藏与取消，不支持移动",
    errorCode: "UNSUPPORTED_ACTION",
  };
}

async function continueFavoriteAction(
  payload: FavoriteWorkflowContinuePayload,
): Promise<FavoriteWorkflowResult> {
  if (!String(payload.comicId ?? "").trim()) {
    return {
      status: "failed",
      favorited: false,
      committed: false,
      message: "comicId 不能为空",
      errorCode: "INVALID_COMIC_ID",
    };
  }
  return {
    status: "failed",
    committed: false,
    message: "拷贝漫画收藏不需要继续交互",
    errorCode: "UNSUPPORTED_CONTINUATION",
  };
}

async function getCloudFavoriteData(
  payload: CloudFavoritePayload & { __breezeReadScope?: string } = {},
): Promise<ComicPagedListContract> {
  const { apiBase, headers } = await loadAccountRequest();
  const extern = toStringMap(payload.extern);
  const page = Math.max(1, Number(payload.page ?? extern.page ?? 1) || 1);
  const offset = (page - 1) * COLLECT_PAGE_SIZE;
  const ordering =
    String(payload.ordering ?? extern.ordering ?? DEFAULT_COLLECT_ORDERING).trim() ||
    DEFAULT_COLLECT_ORDERING;
  const params = new URLSearchParams({
    limit: String(COLLECT_PAGE_SIZE),
    offset: String(offset),
    free_type: "1",
    ordering,
  });
  // Missing credentials are a first-time sign-in state, not an expired session.
  // Keep that structured error outside the request catch below.
  let json: CopyApiResponse<CollectApiData>;
  try {
    json = await fetchCopyApiWithHeaders<CollectApiData>(
      `${apiBase}/member/collect/comics?${params.toString()}`,
      headers,
      false,
      payload.__breezeReadScope,
    );
  } catch (error) {
    const message = String((error as Error).message ?? "");
    const lowered = message.toLowerCase();
    if (
      lowered.includes("登录") ||
      lowered.includes("登錄") ||
      lowered.includes("token") ||
      lowered.includes("unauthorized") ||
      lowered.includes("401")
    ) {
      throw buildUnauthorizedError(PLUGIN_ID, "登录已失效，请重新登录");
    }
    throw error instanceof Error ? error : new Error(message || "获取收藏失败");
  }
  const resultsMap = toStringMap(json.results);
  if (!Array.isArray(resultsMap.list)) {
    throw new Error("收藏资料读取不完整，请重试");
  }
  const rawList = resultsMap.list;
  const items = rawList
    .map((row) => {
      const rowMap = toStringMap(row);
      const comicMap = toStringMap(rowMap.comic);
      const collectId = "uuid" in rowMap ? Number(rowMap.uuid ?? 0) : 0;
      const authorsRaw =
        "author" in comicMap && Array.isArray(comicMap.author) ? comicMap.author : [];
      const themesRaw = "theme" in comicMap && Array.isArray(comicMap.theme) ? comicMap.theme : [];
      return mapCollectComicToGrid({
        uuid: Number.isFinite(collectId) ? collectId : 0,
        comic: {
          name: "name" in comicMap ? String(comicMap.name ?? "") : "",
          path_word: "path_word" in comicMap ? String(comicMap.path_word ?? "") : "",
          cover: "cover" in comicMap ? String(comicMap.cover ?? "") : "",
          author: authorsRaw.map((author) => ({
            name: String(toStringMap(author).name ?? ""),
          })),
          popular: nonnegativeInteger(comicMap.popular) ?? undefined,
          datetime_updated:
            "datetime_updated" in comicMap ? String(comicMap.datetime_updated ?? "") : "",
          last_chapter_name:
            "last_chapter_name" in comicMap ? String(comicMap.last_chapter_name ?? "") : "",
          theme: themesRaw.map((theme) => ({
            name: String(toStringMap(theme).name ?? ""),
          })),
        },
      });
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
  const limit = Number(
    "limit" in resultsMap ? (resultsMap.limit ?? COLLECT_PAGE_SIZE) : COLLECT_PAGE_SIZE,
  );
  const pageSize = Number.isFinite(limit) && limit > 0 ? limit : COLLECT_PAGE_SIZE;
  const rawTotal = resultsMap.total;
  const parsedTotal = typeof rawTotal === "number"
    ? rawTotal
    : typeof rawTotal === "string" && /^\d+$/.test(rawTotal.trim())
      ? Number(rawTotal)
      : NaN;
  const observedEnd = offset + rawList.length;
  const total = Number.isSafeInteger(parsedTotal) && parsedTotal >= 0 &&
    (rawList.length === 0 ? parsedTotal <= offset : parsedTotal >= observedEnd)
    ? parsedTotal
    : undefined;
  return {
    source: PLUGIN_ID,
    extern: payload.extern ?? null,
    scheme: {
      version: "1.0.0",
      type: "cloudFavoriteFeed",
      card: "comicGrid",
    },
    data: {
      items,
      ...(total === undefined ? {} : { total }),
      hasReachedMax: total === undefined
        ? rawList.length < pageSize
        : observedEnd >= total,
    },
  };
}

async function getCloudFavoriteSceneBundle(): Promise<ComicListSceneBundleContract> {
  return {
    source: PLUGIN_ID,
    scheme: { version: "1.0.0", type: "comicListSceneBundle" },
    data: { scene: buildCopyCloudFavoriteScene() },
  };
}

async function getCloudFavoriteFilterBundle(
  payload: { extern?: Record<string, unknown> } = {},
): Promise<FilterBundleContract> {
  const extern = toStringMap(payload.extern);
  const ordering =
    String(extern.ordering ?? DEFAULT_COLLECT_ORDERING).trim() || DEFAULT_COLLECT_ORDERING;
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "filter",
      title: "云端收藏筛选",
      fields: [
        {
          key: "ordering",
          kind: "choice",
          label: "排序",
          options: COLLECT_ORDERING_OPTIONS.map((item) => ({
            label: item.label,
            value: item.value,
            result: { extern: { ordering: item.value } },
          })),
        },
      ],
    },
    data: { values: { ordering } },
  };
}

async function getSettingsBundle(): Promise<SettingsBundleContract> {
  const [route, speed] = await Promise.all([readRouteSelection(), readLineSpeeds()]);
  const { choice: selectedApiDomainChoice, platform: selectedPlatformValue } = route;
  const date = speed ? new Date(speed.measuredAt) : null;
  const time = date ? `${date.getMonth() + 1}-${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}` : "";
  const speedOptions = Object.entries(COPY_API_ROUTES).map(([value, base]) => {
    const result = speed?.stale ? undefined : speed?.results.find((row) => row.choice === value);
    const name = copyRouteName(value);
    const onlyReading = !isCopyAccountChoice(value);
    const status = result ? (result.ok ? `${result.ms} ms` : "暂不可用") : "未测速";
    const title = `${name} · ${status}${onlyReading ? " · 仅阅读" : ""}`;
    const domain = new URL(base).hostname;
    return {
      value,
      label: `${title} · ${domain}`,
      routeOption: {
        title: `${name} · ${status}${onlyReading ? " / 仅阅读" : ""}`,
        domain,
        status: result == null ? "unknown" : result.ok ? "available" : "unavailable",
        latencyMs: result?.ms ?? null,
        readOnly: onlyReading,
        inUse: isCopyAutoChoice(selectedApiDomainChoice) && value === route.effective && result?.ok !== false,
      },
    };
  });
  const networkFields = [
    {
      key: API_DOMAIN_CONFIG_KEY,
      kind: "select" as const,
      label: "访问线路",
      description: "可用优先在账号线路不可用时，会为公开阅读使用已测通的线路。",
      fnPath: "saveSettings",
      persist: false,
      options: [
        { value: COPY_AUTO_CHOICE, label: "自动（可用优先）" },
        { value: COPY_AUTO_SPEED_CHOICE, label: "自动（速度优先）" },
        ...speedOptions,
      ],
    },
    {
      key: PLATFORM_CONFIG_KEY,
      kind: "select" as const,
      label: "请求标识",
      fnPath: "saveSettings",
      persist: false,
      options: PLATFORM_OPTIONS,
    },
  ];

  const networkSection = {
    id: "network", title: "网络", fields: networkFields,
    headerAction: { key: "line-speed", title: "测速", fnPath: "testLineSpeeds" },
    ...(time && !speed?.stale ? { footer: `上次测速 ${time}` } : {}),
  };

  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "settings",
      sections: [
        networkSection,
      ],
    },
    data: {
      canShowUserInfo: true,
      canLogin: true,
      loginTitle: "拷贝漫画登录",
      values: {
        [API_DOMAIN_CONFIG_KEY]: selectedApiDomainChoice,
        [PLATFORM_CONFIG_KEY]: selectedPlatformValue,
      },
    },
  };
}

async function saveSettings(payload: {
  key?: string;
  value?: unknown;
  values?: Record<string, unknown>;
} = {}) {
  const values = toStringMap(payload.values);
  const input = toStringMap(payload);
  const choice = String(values[API_DOMAIN_CONFIG_KEY] ?? input[API_DOMAIN_CONFIG_KEY] ??
    (payload.key === API_DOMAIN_CONFIG_KEY || !payload.key ? payload.value : "") ?? "").trim();
  const rawPlatform = values[PLATFORM_CONFIG_KEY] ?? input[PLATFORM_CONFIG_KEY] ??
    (payload.key === PLATFORM_CONFIG_KEY ? payload.value : undefined);
  const platform = rawPlatform == null ? undefined : String(rawPlatform);
  const { before, owner, enabledAuto } = await writeRoute(async () => {
    const before = await readRouteSelection();
    const changeChoice = choice !== before.choice &&
      (isCopyAutoChoice(choice) || isCopyRouteChoice(choice));
    const changePlatform = typeof platform === "string" && platform !== before.platform &&
      PLATFORM_OPTIONS.some((item) => item.value === platform);
    const enabledAuto = changeChoice && isCopyAutoChoice(choice);
    if (changeChoice || changePlatform) {
      routeRevision++;
      lineSpeedTest.invalidate();
    }
    if (enabledAuto) {
      await saveRoutePreference(
        AUTO_ROUTE_KEY,
        isCopyAccountChoice(before.effective) ? before.effective : COPY_DEFAULT_CHOICE,
      );
    }
    if (changeChoice) await saveApiDomainChoice(choice);
    if (changePlatform) await savePlatformValue(platform);
    return { before, owner: await readRouteSelection(), enabledAuto };
  });

  let effective = owner.effective;
  if (enabledAuto) {
    try {
      const cached = await readLineSpeeds();
      let measured = cached && !cached.stale
        ? { ...cached, ok: cached.results.some((row) => row.ok), message: "" }
        : await lineSpeedTest.measure();
      // An earlier manual speed test can still be winding down when Auto is enabled.
      if (measured.stale && owner.revision === routeRevision) {
        measured = await lineSpeedTest.measure();
      }
      ({ effective } = await applyAutoMeasurement(owner, measured));
    } catch {
      // The requested mode was saved. Keep the prior effective route if the
      // measurement or its durable readback could not finish.
      effective = (await writeRoute(readRouteSelection)).effective;
    }
  }
  return { ok: true, data: {
    ...routeResult(effective, owner.revision === routeRevision && before.effective !== effective),
    requestPlatformChanged: owner.revision === routeRevision && before.platform !== owner.platform,
  } };
}

export async function getCapabilitiesBundle(): Promise<CapabilitiesBundleContract> {
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0" as const,
      type: "capabilities" as const,
      actions: [{ key: "line-speed", title: "测试线路速度", fnPath: "testLineSpeeds" }],
    },
    data: { actions: ["line-speed"] },
  };
}

export default {
  getInfo,
  getCapabilities,
  resolveSearchTopic,
  searchComic,
  getAdvancedSearchScheme,
  getHomeRecommend,
  getHomeNewest,
  getHomeDiscover,
  getHomeDiscoverFilterBundle,
  getTagAuthorList,
  getTagAuthorListFilterBundle,
  getHomeRank,
  getHomeRankFilterBundle,
  getComicDetail,
  getCommentFeed,
  getCommentReplies,
  loadCommentReplies: getCommentReplies,
  getChapter,
  getReadSnapshot,
  fetchImageBytes,
  getDownloadConcurrency,
  getSettingsBundle,
  saveSettings,
  getCapabilitiesBundle,
  testLineSpeeds,
  getLoginBundle,
  loginWithPassword,
  getUserInfoBundle,
  updateAvatar,
  startFavoriteAction,
  continueFavoriteAction,
  getCloudFavoriteData,
  getCloudFavoriteSceneBundle,
  getCloudFavoriteFilterBundle,
};
