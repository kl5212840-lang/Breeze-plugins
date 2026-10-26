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
  flutterTools,
  hostRuntime,
  opencc,
  pluginConfig,
  runtime,
} from "breeze-plugin-kit";
import {
  buildUnauthorizedError,
  createJmClient,
  setUnauthorizedSchemeProvider,
} from "./client";
import { decodeResponsePayload } from "./codec";
import { Config } from "./constants";
import { JmRequestError, retryTransient, toFriendlyError } from "./errors";
import { buildPluginInfo } from "./get-info";
import { buildRequestConfig } from "./request-config";
import {
  getCachedResponse,
  getEndpointSpeedCache,
  getRuntimeEndpointCache,
  setEndpointSpeedCache,
  setRuntimeEndpointCache,
  assertCurrentSession,
  clearSession,
  currentSessionRevision,
  saveSessionValues,
  waitForSessionWrites,
} from "./state";
import type { EndpointSpeedRecord } from "./state";
import type { RequestPayload } from "./types";
import { getHost, md5Hex } from "./utils";

const JM_PLUGIN_ID = "6886291b-f524-441c-844b-c2efae9899a9";

const jmClient = createJmClient();

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
  if (index >= 0) {
    Config.imagesUrlIndex = index;
  }
}

function noteImageBaseFailure(url: string) {
  const base = imageBaseOf(url);
  if (!base) return;
  imageBaseFailures.set(base, (imageBaseFailures.get(base) ?? 0) + 1);
}

/** 候选顺序：用户固定线路 → 请求本身域名 → 当前最快 → 其余备用 */
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
  push(imageBaseOf(targetUrl));
  push(Config.imagesUrl);
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
}: FetchImageBytesParams = {}): Promise<Uint8Array> {
  const targetUrl = String(url).trim();
  if (!targetUrl) throw new Error("url 不能为空");

  if (taskGroupKey && (await runtime.isTaskGroupCancelled(taskGroupKey))) {
    console.log("[fetchImageBytes] 任务已取消，跳过下载");
    return new Uint8Array(new ArrayBuffer(0));
  }

  const timeout = Math.max(0, Number(timeoutMs)) || 30000;
  const attempts = await buildImageAttempts(targetUrl);
  let lastError: unknown = null;

  for (const attempt of attempts) {
    const host = getHost(attempt);
    try {
      const response = await axios.get(attempt, {
        headers: {
          Host: host,
          Referer: Config.baseUrl || Config.JM_FALLBACK_API_BASE,
          "X-Requested-With": "com.JMComic3.app",
          Accept:
            "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
          "x-rquickjs-host-offload-binary-v1": "1",
        },
        timeout,
        responseType: "arraybuffer",
        validateStatus: () => true,
      });

      const status = Number(response.status || 0);
      if (status < 200 || status >= 300) {
        throw new Error(`图片下载失败 (${status || "unknown"})`);
      }

      const bytes = new Uint8Array(response.data as ArrayBufferLike);
      if (!bytes.length) {
        throw new Error("图片数据为空");
      }

      noteImageBaseSuccess(attempt);
      return bytes;
    } catch (error) {
      lastError = error;
      noteImageBaseFailure(attempt);
      console.warn("[jm.image] current route failed; trying next route");
    }
  }

  throw toFriendlyError(
    lastError ?? new Error(`图片下载失败，已尝试 ${attempts.length} 条线路`),
  );
}

async function jmRequest(
  input: RequestPayload,
  revision = currentSessionRevision(),
) {
  await waitForSessionWrites(revision);
  const resolvedJwtToken =
    input.useJwt === false
      ? ""
      : String(input.jwtToken ?? "").trim() ||
        String(await loadPluginSetting("auth.jwt", "")).trim();
  assertCurrentSession(revision);
  const { config, cacheEnabled } = await buildRequestConfig({
    ...input,
    jwtToken: resolvedJwtToken,
  }, revision);

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
};

type JmReadSnapshotPayload = {
  comicId?: string;
  chapterId?: string;
  extern?: Record<string, unknown>;
};

type JmHomePayload = {
  page?: number;
  extern?: Record<string, unknown>;
  path?: string;
  useJwt?: boolean;
  jwtToken?: string;
};

type JmRankingPayload = {
  page?: number;
  extern?: Record<string, unknown>;
  path?: string;
  useJwt?: boolean;
  jwtToken?: string;
};

type JmPromoteListPayload = {
  id?: number;
  page?: number;
  extern?: Record<string, unknown>;
  path?: string;
  useJwt?: boolean;
  jwtToken?: string;
};

type JmWeekRankingPayload = {
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
  return {
    source: JM_PLUGIN_ID,
    id,
    title: String(item?.name ?? ""),
    subtitle: "",
    finished: false,
    likesCount: toNum(item?.likes),
    viewsCount: toNum(item?.total_views ?? item?.totalViews),
    updatedAt: String(item?.update_at ?? ""),
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
      likes: toNum(item?.likes),
      totalViews: toNum(item?.total_views ?? item?.totalViews),
      tags: toStrList(item?.tags),
      works: toStrList(item?.works),
      actors: toStrList(item?.actors),
    },
    extern: {},
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
      rawName: String(item?.name ?? ""),
    }))
    .sort((a, b) => toNum(a?.sort, 0) - toNum(b?.sort, 0));

  return filtered.map((item, index) => {
    const order = index + 1;
    return {
      ...item,
      order,
      name: `第${order}话 ${String(item?.rawName ?? "")}`,
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

async function loadPluginSetting(key: string, fallback: unknown) {
  const raw = await pluginConfig.load(key, JSON.stringify(fallback));
  try {
    const decoded = JSON.parse(String(raw));
    if (decoded?.ok === true) {
      return decoded.value;
    }
  } catch (_) {
    // noop
  }
  return fallback;
}

async function isJmLoggedIn(): Promise<boolean> {
  const jwt = String(await loadPluginSetting("auth.jwt", "")).trim();
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
  return `${hour}:${minute}`;
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
  if (!record) return "未测试";
  if (!record.ok) return "不可用";
  return record.ms === null ? "已响应" : `${record.ms} ms`;
}

function buildEndpointOptions(
  bases: string[],
  speedMap: Map<string, EndpointSpeedRecord>,
) {
  return [
    { label: "自动（选最快）", value: "" },
    ...bases.map((base) => ({
      label: `${getHost(base)}（${speedLabel(speedMap.get(base))}）`,
      value: base,
    })),
  ];
}

async function probeEndpoint(
  url: string,
  timeoutMs = 6000,
): Promise<EndpointSpeedRecord> {
  const started = Date.now();
  try {
    const response = await axios.get(url, {
      timeout: timeoutMs,
      validateStatus: () => true,
      responseType: "arraybuffer",
    });
    return {
      url,
      ok: true,
      ms: Date.now() - started,
      status: Number(response.status || 0) || null,
      checkedAt: Date.now(),
    };
  } catch (error) {
    console.warn("[jm.speed] route unavailable");
    return {
      url,
      ok: false,
      ms: null,
      status: null,
      checkedAt: Date.now(),
    };
  }
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

/** 探测所有候选线路并缓存结果，供插件设置页展示（不修改全局设置） */
async function measureEndpointSpeeds() {
  const imageTargets = currentImageBases();
  const apiTargets = currentApiBases();

  const [image, api] = await Promise.all([
    Promise.all(imageTargets.map((base) => probeEndpoint(`${base}/`))),
    Promise.all(
      apiTargets.map((base) =>
        probeEndpoint(`${base}/setting?app_img_shunt=1&express=off`),
      ),
    ),
  ]);

  const measuredAt = Date.now();
  await setEndpointSpeedCache({ measuredAt, image, api });

  const failed = image.filter((item) => !item.ok).length +
    api.filter((item) => !item.ok).length;
  const message = [
    `图片线路: ${rankSpeedRecords(image) || "无可用"}`,
    `接口线路: ${rankSpeedRecords(api) || "无可用"}`,
    failed > 0 ? `不可用 ${failed} 条` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    flutterTools.showToast({ message, level: "info" });
  } catch (_) {
    // noop
  }
  console.log("[jm.speed] measured", { measuredAt, image, api });

  return {
    source: JM_PLUGIN_ID,
    data: { ok: true, measuredAt, message, image, api },
  };
}

/** 设置页线路字段变更回调：固定线路并立即生效 */
async function onNetworkChanged(
  payload: {
    key?: string;
    value?: unknown;
    extern?: Record<string, unknown>;
  } = {},
) {
  const key = String(payload.key ?? "");
  const value = String(payload.value ?? "").trim();

  if (key === "network.imageBase") {
    pinnedImageBaseCache = { value, at: Date.now() };
    if (value) {
      Config.imagesUrls = Array.from(
        new Set([...Config.buildImageCandidates(value), ...Config.imagesUrls]),
      );
      Config.imagesUrlIndex = Math.max(0, Config.imagesUrls.indexOf(value));
    } else {
      Config.imagesUrlIndex = 0;
    }
  } else if (key === "network.apiBase") {
    pinnedApiBaseCache = { value, at: Date.now() };
    if (value) {
      Config.baseUrls = Array.from(new Set([value, ...Config.baseUrls]));
      Config.baseUrlIndex = 0;
    } else {
      Config.baseUrlIndex = 0;
    }
  }

  if (key) {
    await pluginConfig.save(key, JSON.stringify(value));
  }

  return {
    source: JM_PLUGIN_ID,
    data: { ok: true, key, value },
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
  const networkTitle = speedCache
    ? `网络线路（测于 ${formatClock(speedCache.measuredAt)}）`
    : "网络线路（未测速，可在下方操作区测试）";

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
        {
          id: "network",
          title: networkTitle,
          fields: [
            {
              key: "network.imageBase",
              kind: "choice",
              label: "图片线路",
              fnPath: "onNetworkChanged",
              options: buildEndpointOptions(imageBases, imageSpeedMap),
            },
            {
              key: "network.apiBase",
              kind: "choice",
              label: "接口线路",
              fnPath: "onNetworkChanged",
              options: buildEndpointOptions(apiBases, apiSpeedMap),
            },
          ],
        },
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
    const stored = await loadPluginSetting("auth.userInfo", {});
    assertCurrentSession(revision);
    const current =
      stored && typeof stored === "object"
        ? (stored as Record<string, any>)
        : ({} as Record<string, any>);
    if (String(current.username ?? current.nickname ?? "").trim()) {
      return current;
    }

    const account = String(await loadPluginSetting("auth.account", "")).trim();
    const password = String(
      await loadPluginSetting("auth.password", ""),
    ).trim();
    if (!account || !password) {
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

  const username = String(user.username ?? user.nickname ?? "").trim();
  if (!username) {
    throw new Error("未获取到用户信息，请先完成登录或刷新会话");
  }
  const coin = String(user.coin ?? "").trim();
  const level = toNum(user.level, 0);
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
        `Lv.${level}${levelName ? ` ${levelName}` : ""}`,
        exp || nextLevelExp ? `经验值: ${exp}/${nextLevelExp}` : "",
      ],
      extern: {
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

setUnauthorizedSchemeProvider(async () => {
  const bundle = await getLoginBundle();
  return bundle as Record<string, unknown>;
});

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
    data: {
      account,
      password,
      jwtToken,
    },
    raw: result,
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
  const decoded = (await decodeResponsePayload(response.data, tsSec)) as Record<
    string,
    unknown
  > | null;
  if (!decoded || typeof decoded !== "object") {
    throw new Error("decode setting response failed");
  }
  return decoded;
}

async function resolveDynamicHosts() {
  const hostPool = await loadHostPool();
  if (!hostPool.length) {
    throw new Error("empty host pool");
  }

  const tsSec = String(Math.floor(Date.now() / 1000));
  let picked = "";
  let setting: Record<string, unknown> | null = null;
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

  const imageBaseUrls = Config.buildImageCandidates(setting.img_host);
  const rawBaseUrls = [
    picked,
    ...hostPool.map((item) => normalizeBaseBaseUrl(item)),
  ].filter(Boolean);

  return {
    imageBaseUrl: imageBaseUrls[0] ?? Config.JM_FALLBACK_IMAGE_BASE,
    imageBaseUrls,
    baseUrls: Array.from(new Set(rawBaseUrls)),
  };
}

/** 写入候选线路列表，并把用户固定的线路设为当前首选 */
function applyEndpointLists(
  apiList: string[],
  imageList: string[],
  pinnedApi: string,
) {
  Config.baseUrls = apiList.length ? apiList : [Config.JM_FALLBACK_API_BASE];
  Config.imagesUrls = imageList.length
    ? imageList
    : Config.buildImageCandidates();

  const apiPinnedIndex = pinnedApi ? Config.baseUrls.indexOf(pinnedApi) : -1;
  Config.baseUrlIndex = apiPinnedIndex >= 0 ? apiPinnedIndex : 0;

  const pinnedImage = pinnedImageBaseCache.value;
  const imagePinnedIndex = pinnedImage
    ? Config.imagesUrls.indexOf(pinnedImage)
    : -1;
  Config.imagesUrlIndex = imagePinnedIndex >= 0 ? imagePinnedIndex : 0;
}

async function resolveFastestBases() {
  const pinnedApi = await getPinnedApiBase();
  const cached = await getRuntimeEndpointCache();

  if (cached) {
    const apiList = Array.from(
      new Set(
        [cached.apiBaseUrl, ...cached.hostPool]
          .map((item) => normalizeBaseBaseUrl(item))
          .filter(Boolean),
      ),
    );
    const imageList =
      cached.imageBaseUrls && cached.imageBaseUrls.length
        ? cached.imageBaseUrls
        : Config.buildImageCandidates(cached.imageBaseUrl);

    applyEndpointLists(
      apiList.length ? apiList : [Config.JM_FALLBACK_API_BASE],
      imageList,
      pinnedApi,
    );

    if (pinnedApi && Config.baseUrls.includes(pinnedApi)) {
      Config.baseUrlIndex = Config.baseUrls.indexOf(pinnedApi);
    } else {
      Config.baseUrlIndex = Math.max(
        0,
        Config.baseUrls.indexOf(normalizeBaseBaseUrl(cached.apiBaseUrl)),
      );
    }

    return { data: Config.baseUrl };
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

  Config.baseUrls = baseCandidates;
  Config.imagesUrls = imageCandidates;

  try {
    Config.baseUrlIndex = await getFastestUrlIndex(Config.baseUrls);
  } catch (error) {
    console.warn("[jm.init] choose fastest api base failed");
  }

  try {
    Config.imagesUrlIndex = await getFastestUrlIndex(Config.imagesUrls);
  } catch (error) {
    console.warn("[jm.init] choose fastest image base failed");
  }

  // 用户固定线路优先于测速结果（候选列表全部保留，供失败时回退）
  applyEndpointLists(Config.baseUrls, Config.imagesUrls, pinnedApi);

  const data = Config.baseUrl || Config.JM_FALLBACK_API_BASE;

  try {
    await setRuntimeEndpointCache({
      apiBaseUrl: Config.baseUrl,
      imageBaseUrl: Config.imagesUrl,
      imageBaseUrls: Config.imagesUrls,
      hostPool: baseCandidates,
    });
  } catch (error) {
    console.warn("[jm.init] cache hostRuntime endpoints failed");
  }

  return { data };
}

async function tryJmCheckin(revision = currentSessionRevision()) {
  await waitForSessionWrites(revision);
  const stored = await loadPluginSetting("auth.userInfo", {});
  assertCurrentSession(revision);
  const uid = stored?.uid;
  if (!uid) {
    console.error("无法获取用户UID，跳过签到");
    return false;
  }

  try {
    return await retryTransient(async () => {
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
        return true;
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

      let msg = String(chkRes?.data?.msg ?? chkRes?.msg ?? "");

      msg = await opencc.convert(msg, "t2s.json");
      assertCurrentSession(revision);

      if (msg !== "今天已经签到过了") {
        try {
          flutterTools.showToast({
            message: "禁漫自动签到成功！",
            level: "success",
          });
        } catch (_) {}
      }

      return true;
    }, () => assertCurrentSession(revision));
  } catch (_) {
    assertCurrentSession(revision);
    console.warn("[jm.checkin] request failed; stopped");
    return false;
  }
}

async function checkInToday() {
  const user = await loadPluginSetting("auth.userInfo", {});
  if (!user?.uid) {
    throw await buildUnauthorizedError("请先登录禁漫账号");
  }
  const ok = await tryJmCheckin();
  return {
    source: JM_PLUGIN_ID,
    data: {
      ok,
      message: ok ? "今日签到已完成" : "签到未完成，请检查线路后重试",
    },
  };
}

async function getNotifications() {
  const raw = await jmRequest({
    path: `${Config.baseUrl}/notifications`,
    method: "GET",
    cache: false,
    useJwt: true,
  });
  const root = toStringMap(raw);
  const rows = Array.isArray(raw)
    ? raw
    : Array.isArray(root.list)
      ? root.list
      : Array.isArray(toStringMap(root.data).list)
        ? toStringMap(root.data).list as unknown[]
        : [];
  const items = rows.filter((value: unknown) => {
    const item = toStringMap(value);
    return !String(item.content ?? "").includes("/payment?");
  }).map((value: unknown) => {
    const item = toStringMap(value);
    const content = Array.isArray(item.content)
      ? item.content
          .map((entry) => {
            const detail = toStringMap(entry);
            return String(detail.name ?? detail.title ?? detail.album_name ?? "").trim();
          })
          .filter(Boolean)
          .join("、")
      : formatNotificationText(item.content);
    const readValue = item.read;
    return {
      id: String(item.id ?? ""),
      title: String(item.title ?? "通知"),
      content,
      time: String(item.date ?? item.time ?? ""),
      read: readValue === true || readValue === 1 || readValue === "1" || readValue === "true",
      type: String(item.type ?? ""),
    };
  });
  return {
    source: JM_PLUGIN_ID,
    data: { items, total: toNum(root.total, items.length) },
  };
}

function formatNotificationText(value: unknown): string {
  const entities: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  };
  return String(value ?? "")
    .replace(/<br\s*\/?\s*>|<\/p\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity: string) => {
      const lower = entity.toLowerCase();
      if (lower.startsWith("#")) {
        const hex = lower.startsWith("#x");
        const point = Number.parseInt(lower.slice(hex ? 2 : 1), hex ? 16 : 10);
        return Number.isFinite(point) && point > 0 && point <= 0x10ffff
          ? String.fromCodePoint(point)
          : match;
      }
      return entities[lower] ?? match;
    })
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n+ */g, "\n")
    .trim();
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

    const checkedIn = await tryJmCheckin(revision);
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
  await resolveFastestBases();
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
        {
          key: "clear_session",
          title: "清理插件会话",
          fnPath: "clearPluginSession",
        },
      ],
    },
    data: {
      actions: ["speedtest", "clear_session"],
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
          extern: { source: "ranking", type, order: "new" },
        },
        filter: {
          fnPath: "getRankingFilterBundle",
          extern: { source: "ranking", type, order: "new" },
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

  const recommend = await getHomeRecommendData();
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
  return {
    source: JM_PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "rankingFilter",
      title: "筛选漫画",
      fields: [
        {
          key: "category",
          kind: "choice",
          label: "分类",
          options: getJmRankingCategoryOptions(),
        },
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
        category: selectedType === "禁漫汉化组"
          ? "jm_translation_team"
          : selectedType,
        order: String(extern.order ?? "new"),
      },
    },
  };
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

async function getComicDetail(
  payload: ComicDetailPayload = {},
): Promise<ComicDetailContract> {
  const comicId = String(payload.comicId ?? "").trim();
  if (!comicId) {
    throw new Error("comicId 不能为空");
  }

  const path = `${Config.baseUrl}/album`;

  const response = (await jmRequest({
    path,
    method: "GET",
    params: { id: comicId },
    useJwt: payload.useJwt ?? true,
    jwtToken: payload.jwtToken,
  })) as Record<string, any>;

  const series = normalizeJmSeries(response.series as any[]);
  const normalizedInfo = {
    ...response,
    id: toNum(response.id),
    name: String(response.name ?? ""),
    description: String(response.description ?? ""),
    addtime: String(response.addtime ?? "0"),
    total_views: String(response.total_views ?? "0"),
    likes: String(response.likes ?? "0"),
    comment_total: String(response.comment_total ?? "0"),
    author: toStrList(response.author),
    tags: toStrList(response.tags),
    works: toStrList(response.works),
    actors: toStrList(response.actors),
    related_list: Array.isArray(response.related_list)
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
      id: String(normalizedInfo.id),
      title: normalizedInfo.name,
      titleMeta: [
        createActionItem(`浏览：${toNum(normalizedInfo.total_views)}`),
        ...(timestampToIso(normalizedInfo.addtime)
          ? [createActionItem(`更新：${timestampToIso(normalizedInfo.addtime).slice(0, 10)}`)]
          : []),
        createActionItem(
          `章节数：${normalizedInfo.series.length > 0 ? normalizedInfo.series.length : 1}`,
        ),
        ...(toNum(response.total_photos) > 0
          ? [createActionItem(`页数：${toNum(response.total_photos)}`)]
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
              openSearchAction({ source: JM_PLUGIN_ID, keyword: item }),
            ),
        ),
        createMetadataActionList("tags", "标签", normalizedInfo.tags, (item) =>
          createActionItem(
            item,
            openSearchAction({ source: JM_PLUGIN_ID, keyword: item }),
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
    totalViews: toNum(normalizedInfo.total_views),
    totalLikes: toNum(normalizedInfo.likes),
    totalComments: toNum(normalizedInfo.comment_total),
    isFavourite: toBool(normalizedInfo.is_favorite),
    isLiked: toBool(normalizedInfo.liked),
    allowComments: true,
    allowLike: true,
    allowCollected: true,
    allowDownload: true,
    extern: {},
  };

  const scheme = {
    version: "1.0.0" as const,
    type: "comicDetail" as const,
    source: JM_PLUGIN_ID,
  };

  const data: ComicDetailData = {
    normal,
    raw: {
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

  if ((Number(keyword) >= 100 || keywordLower.startsWith("jm")) && page === 1) {
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
    cache: true,
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
    cache: true,
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
  const c = String(extern.type ?? extern.c ?? "");
  const o = String(extern.order ?? extern.o ?? "");
  const path = `${Config.baseUrl}/categories/filter`;
  const rankingPageSize = 80;

  const raw = await jmRequest({
    path,
    method: "GET",
    params: { page, c, o },
    cache: true,
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
    cache: true,
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
    cache: true,
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
  const page = Math.max(1, toNum(payload.page, 1));
  const extern = toStringMap(payload.extern);
  const folderId = String(payload.folderId ?? extern.folderId ?? "");
  const order = String(payload.order ?? extern.order ?? "mr") || "mr";
  const path = `${Config.baseUrl}/favorite`;
  const raw = (await jmRequest({
    path,
    method: "GET",
    params: { page, folder_id: folderId, o: order },
    cache: false,
    useJwt: payload.useJwt ?? true,
    jwtToken: payload.jwtToken,
  })) as Record<string, any>;

  const list = Array.isArray(raw.list) ? raw.list : [];
  const total = toNum(raw.total, 0);
  const hasReachedMax = total > 0 ? page * 20 >= total : list.length < 20;

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
      total,
      hasReachedMax,
      items: list.map((item: any) => toComicItem(item)),
      raw,
    },
  };
}

async function toggleLike(
  payload: JmLikePayload = {},
): Promise<ToggleLikeResult> {
  const comicId = String(payload.comicId ?? "").trim();
  if (!comicId) {
    throw new Error("comicId 不能为空");
  }

  const currentLiked = toBool(payload.currentLiked, false);
  if (currentLiked) {
    flutterTools.showToast({
      message: "JM 暂不支持取消点赞",
      level: "warning",
    });
    return {
      liked: true,
    };
  }

  const path = `${Config.baseUrl}/like`;
  await jmRequest({
    path,
    method: "POST",
    formData: { id: comicId },
    cache: false,
    useJwt: payload.useJwt ?? true,
    jwtToken: payload.jwtToken,
  });

  return {
    liked: true,
  };
}

async function toggleFavorite(
  payload: JmToggleFavoritePayload = {},
): Promise<ToggleFavoriteResult> {
  const comicId = String(payload.comicId ?? "").trim();
  if (!comicId) {
    throw new Error("comicId 不能为空");
  }

  const path = `${Config.baseUrl}/favorite`;
  const res = await jmRequest({
    path,
    method: "POST",
    formData: { aid: comicId },
    cache: false,
    useJwt: payload.useJwt ?? true,
    jwtToken: payload.jwtToken,
  });


  const result = toStringMap(res);
  const body = toStringMap(result.data);
  const message = String(body.msg ?? result.msg ?? "");
  if (/已[满滿]/.test(message)) {
    throw new JmRequestError("收藏数已达上限");
  }
  const status = body.status ?? result.status;
  if (
    status === false ||
    status === 0 ||
    ["error", "fail", "failed"].includes(String(status).toLowerCase())
  ) {
    throw new JmRequestError(message || "收藏操作未完成");
  }

  const favorited = !toBool(payload.currentFavorite, false);

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
  if (!comicId || !folderId) {
    throw new Error("comicId 或 folderId 不能为空");
  }

  const path = `${Config.baseUrl}/favorite_folder`;
  await jmRequest({
    path,
    method: "POST",
    formData: {
      type: "move",
      folder_id: folderId,
      folder_name: folderName,
      aid: comicId,
    },
    cache: false,
    useJwt: payload.useJwt ?? true,
    jwtToken: payload.jwtToken,
  });

  return {
    ok: true,
  };
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
      throw await buildUnauthorizedError("登录已失效，请重新登录后再评论");
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
    cache: true,
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

async function getChapter(payload: JmChapterPayload = {}) {
  const chapterId = String(payload.chapterId ?? "").trim();
  if (!chapterId) {
    throw new Error("chapterId 不能为空");
  }

  const path = `${Config.baseUrl}/chapter`;
  const response = (await jmRequest({
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
  const imageBase = String(Config.imagesUrl).trim();
  const docs = images.map((image) => ({
    name: String(image ?? ""),
    path: String(image ?? ""),
    url: imageBase
      ? `${imageBase}/media/photos/${chapterId}/${String(image ?? "")}`
      : "",
    id: String(image ?? ""),
  }));

  const result = {
    source: JM_PLUGIN_ID,
    comicId: String(payload.comicId ?? ""),
    chapterId,
    extern: payload.extern ?? null,
    scheme: {
      version: "1.0.0",
      type: "chapterContent",
      source: JM_PLUGIN_ID,
    },
    data: {
      chapter: {
        id: String(response.id ?? chapterId),
        requestId: String(response.id ?? chapterId),
        logicalKey: String(response.id ?? chapterId),
        storageChapterId: String(response.id ?? chapterId),
        name: String(response.name ?? ""),
        order: 0,
        pages: docs.map((doc) => ({
          ...doc,
          extern: {},
        })),
        extern: {},
      },
    },
    chapter: {
      id: String(response.id ?? chapterId),
      requestId: String(response.id ?? chapterId),
      logicalKey: String(response.id ?? chapterId),
      storageChapterId: String(response.id ?? chapterId),
      name: String(response.name ?? ""),
      order: 0,
      pages: docs.map((doc) => ({
        ...doc,
        extern: {},
      })),
      extern: {},
    },
  };
  return result;
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
  checkInToday,
  getNotifications,
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
