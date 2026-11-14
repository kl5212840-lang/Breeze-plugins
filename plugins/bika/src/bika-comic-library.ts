import { buildUnauthorizedError } from "breeze-plugin-kit";
import type {
  FunctionPageContract,
  ListFavoriteFoldersResult,
  SearchResultContract,
  StringMap,
  ToggleFavoriteResult,
  ToggleLikeResult,
} from "breeze-plugin-kit";
import {
  assertBikaAuthRevision,
  BikaAccountChangedError,
  currentBikaAuthRevision,
  waitBikaSessionWrites,
} from "./bika-auth-session";
import {
  bikaSearchFieldParameter,
  bikaSearchOverride,
  bikaSearchSortBy,
  boolKeyList,
  buildHomeAction,
  loadBlockedCategories,
  toActionItem,
  toBoolMap,
  toComicListItem,
  toHomeChip,
  toSortKeyword,
} from "./bika-comic-shared";
import { buildBikaImageUrl } from "./bika-image";
import { resolveBikaCategoryArtwork } from "./bika-category-art";
import { isBikaNativeVideoShortcut } from "./bika-navigation";
import { loadAppChannel } from "./bika-network";
import { bikaRequest } from "./bika-request";
import type {
  BikaFavoriteFolderPayload,
  BikaFavoritePayload,
  BikaHomePayload,
  BikaLikePayload,
  BikaSearchPayload,
  BikaToggleFavoritePayload,
} from "./bika-types";
import { bikaCount, bikaLikesCount, resolveSceneFnPath, toBool, toNum, toStrList, toStringMap } from "./bika-utils";
import { captureBikaLine, getApiBase } from "./client";
import { BIKA_PLUGIN_ID } from "./info";
import { loadPluginSetting } from "./plugin-config";

export async function searchComic(payload: BikaSearchPayload = {}): Promise<SearchResultContract> {
  const apiBase = await getApiBase();
  const payloadMap = toStringMap(payload);
  const extern = toStringMap(payload.extern);
  const page = Math.max(1, toNum(payload.page, 1));
  const keyword = String(payload.keyword ?? extern.keyword ?? "").trim();
  const field = bikaSearchFieldParameter(extern.bikaSearchField);
  if (extern.bikaSearchField != null && (!field || !keyword)) {
    throw new Error("搜索范围或关键词无效");
  }
  const mode = String(extern.mode ?? payloadMap.mode ?? "").trim();
  const creatorId = String(extern.creatorId ?? payloadMap.creatorId ?? "").trim();
  const categories = boolKeyList(extern.categories ?? payloadMap.categories);
  const localBlockedCategories = boolKeyList(extern.blockedCategories ?? payloadMap.blockedCategories);
  const blockedCategories = [...new Set([
    ...await loadBlockedCategories(),
    ...localBlockedCategories,
  ])];
  const overrideUrl = String(extern.url ?? payloadMap.url ?? "").trim();

  const scoped = bikaSearchOverride(overrideUrl, apiBase);
  if (overrideUrl && !scoped) throw new Error("无法识别此搜索入口，请重新打开");
  const sortBy = toNum(
    extern.sortBy ?? payloadMap.sortBy,
    bikaSearchSortBy(scoped?.searchParams.get("s")),
  );
  const sort = String(extern.sort ?? payloadMap.sort ?? toSortKeyword(sortBy)).trim() || "dd";

  let response: Record<string, unknown>;
  if (field || (mode === "creator" && creatorId)) {
    const url = new URL("comics", apiBase);
    url.searchParams.set(field ?? "ca", field ? keyword : creatorId);
    url.searchParams.set("s", sort);
    url.searchParams.set("page", String(page));
    response = (await bikaRequest({ url: url.href, method: "GET" })) as Record<string, unknown>;
  } else if (scoped) {
    if (scoped.pathname === "/comics") {
      scoped.searchParams.set("page", String(page));
      scoped.searchParams.set("s", sort);
    }
    response = (await bikaRequest({ url: scoped.href, method: "GET" })) as Record<string, unknown>;
  } else {
    response = (await bikaRequest({
      url: `${apiBase}comics/advanced-search?page=${page}`,
      method: "POST",
      body: {
        sort,
        keyword,
        categories,
      },
    })) as Record<string, unknown>;
  }

  const responseMap = toStringMap(response);
  const responseData = toStringMap(responseMap.data);
  const comicsPayload = responseData.comics;
  const comics: StringMap = Array.isArray(comicsPayload)
    ? {
        docs: comicsPayload,
        page,
        pages: page,
      }
    : toStringMap(comicsPayload);
  if (!Array.isArray(comics.docs)) {
    throw new Error("搜索结果格式错误");
  }
  const rawDocs = comics.docs;
  const docs: StringMap[] = rawDocs.filter(
    (item): item is StringMap => !!item && typeof item === "object" && !Array.isArray(item),
  );
  const normalizedDocs = docs.map((doc: StringMap) => {
    const next: StringMap = { ...doc };
    next.id ??= next._id;
    next.updated_at ??= "1970-01-01T00:00:00.000Z";
    next.created_at ??= "1970-01-01T00:00:00.000Z";
    next.description ??= "";
    next.chineseTeam ??= "";
    next.tags ??= [];
    next.author ??= "";
    const thumb = toStringMap(next.thumb);
    thumb.originalName ??= "";
    thumb.path ??= "";
    thumb.fileServer ??= "";
    next.thumb = thumb;
    next.likesCount = toNum(next.likesCount, 0);
    next.totalLikes = toNum(next.totalLikes, 0);
    return next;
  });

  const blockedSet = new Set(
    blockedCategories,
  );
  const filteredDocs = normalizedDocs.filter((doc: StringMap) => {
    const docCategories = toStrList(doc.categories);
    return !docCategories.some((item: string) => blockedSet.has(item));
  });

  const scheme = {
    version: "1.0.0" as const,
    type: "searchResult" as const,
    source: BIKA_PLUGIN_ID,
    list: "comicGrid",
  };

  const items = await Promise.all(
    filteredDocs.map(async (doc: StringMap) => await toComicListItem(doc)),
  );

  const data = {
    paging: {
      page: toNum(comics.page, page),
      pages: toNum(comics.pages, page),
      total: toNum(comics.total, filteredDocs.length),
      hasReachedMax: toNum(comics.page, page) >= toNum(comics.pages, page),
    },
    items,
  };

  return {
    source: BIKA_PLUGIN_ID,
    extern: {
      ...extern,
      ...(overrideUrl ? { url: overrideUrl } : {}),
      ...(mode ? { mode } : {}),
      ...(creatorId ? { creatorId } : {}),
      sortBy: bikaSearchSortBy(sort, sortBy),
      categories: toBoolMap(categories),
      blockedCategories: toBoolMap(localBlockedCategories),
    },
    scheme,
    data,
    paging: data.paging,
    items: data.items,
  };
}

async function getNavigationItems(refresh: boolean) {
  const apiBase = await getApiBase();
  const categoriesResponse = await bikaRequest({
    url: `${apiBase}categories`,
    method: "GET",
    cache: true,
    cacheArray: ["categories"],
    refresh,
  });
  const categoriesData = toStringMap(toStringMap(categoriesResponse).data);
  const categoriesRaw = Array.isArray(categoriesData.categories) ? categoriesData.categories : [];
  const categories: StringMap[] = categoriesRaw.filter(
    (item): item is StringMap => !!item && typeof item === "object" && !Array.isArray(item),
  );
  const authorization = String(await loadPluginSetting("auth.authorization", ""));
  // These two entries are app shortcuts rather than /categories records. Their
  // original Picacomic artwork is mirrored by the AGPL bikabika project.
  const classicArt =
    "https://raw.githubusercontent.com/kitUIN/bikabika/a7da0067f8769f7241ea23ebb6e0c3b7223d6953/bikabika/Assets/Picacgs";
  const categoryNavItems = await Promise.all(
    categories.map(async (item: StringMap) => {
      const thumb = toStringMap(item.thumb);
      const fileServer = String(thumb.fileServer ?? "").trim();
      const path = String(thumb.path ?? "").trim();
      const artwork = resolveBikaCategoryArtwork(item, {
        url: fileServer && path ? await buildBikaImageUrl(fileServer, path, "else") : "",
        path,
      });
      return {
        ...toActionItem({
          title: String(item.title ?? ""),
          coverUrl: artwork.url,
          coverPath: artwork.path,
          action: await buildHomeAction(item, authorization),
        }),
        ...(artwork.icon ? { icon: artwork.icon } : {}),
      };
    }),
  );

  return [
    toActionItem({
      title: "最近更新",
      coverUrl: `${classicArt}/cat_latest.jpg`,
      coverPath: "cat_latest.jpg",
      action: await buildHomeAction({ title: "最近更新" } as StringMap, authorization),
    }),
    toActionItem({
      title: "随机本子",
      coverUrl: `${classicArt}/cat_random.jpg`,
      coverPath: "cat_random.jpg",
      action: await buildHomeAction({ title: "随机本子" } as StringMap, authorization),
    }),
    ...categoryNavItems,
  ];
}

export async function getHomeData(payload: BikaHomePayload = {}): Promise<FunctionPageContract> {
  const apiBase = await getApiBase();
  const refresh = payload.refresh === true;
  const [navItems, keywordsResponse] = await Promise.all([
    getNavigationItems(refresh),
    bikaRequest({
      url: `${apiBase}keywords`,
      method: "GET",
      cache: true,
      cacheArray: ["keywords"],
      refresh,
    }),
  ]);
  const keywordsData = toStringMap(toStringMap(keywordsResponse).data);
  const keywordItems = Array.isArray(keywordsData.keywords)
    ? keywordsData.keywords.map((item: unknown) => toHomeChip(item))
    : [];

  return {
    source: BIKA_PLUGIN_ID,
    scheme: {
      version: "1.0.0" as const,
      type: "page" as const,
      title: "哔咔漫画",
      body: {
        type: "list" as const,
        children: [
          { type: "chip-list" as const, key: "keywords" },
          { type: "action-grid" as const, key: "navItems", bikaCategoryGrid: true },
        ],
      },
    } as unknown as FunctionPageContract["scheme"],
    data: {
      keywords: keywordItems,
      navItems,
      hasReachedMax: true,
    },
  };
}

export async function getFavoriteData(
  payload: BikaFavoritePayload = {},
): Promise<SearchResultContract> {
  const apiBase = await getApiBase();
  const page = Math.max(1, toNum(payload.page, 1));
  const extern = toStringMap(payload.extern);
  const sort = String(extern.sort ?? extern.order ?? "dd").trim() || "dd";

  const raw = await bikaRequest({
    url: `${apiBase}users/favourite?s=${sort}&page=${page}`,
    method: "GET",
  });

  const favData = toStringMap(toStringMap(raw).data);
  const comics: StringMap = toStringMap(favData.comics);
  const favDocs: StringMap[] = (Array.isArray(comics.docs) ? comics.docs : []).filter(
    (item): item is StringMap => !!item && typeof item === "object" && !Array.isArray(item),
  );
  // A loaded page is not the whole collection; malformed totals are not success.
  const rawTotal = comics.total;
  const total = typeof rawTotal === "number" ? rawTotal
    : typeof rawTotal === "string" && rawTotal.trim() ? Number(rawTotal) : NaN;
  if (!Number.isSafeInteger(total) || total < favDocs.length) {
    throw new Error("收藏资料读取不完整，请重试");
  }
  const currentPage = toNum(comics.page, page);
  const pages = toNum(comics.pages, currentPage);
  const items = await Promise.all(
    favDocs.map(
      async (item: StringMap) =>
        await toComicListItem(item, {
          pictureType: "favourite",
        }),
    ),
  );

  return {
    source: BIKA_PLUGIN_ID,
    extern: payload.extern ?? null,
    scheme: {
      version: "1.0.0" as const,
      type: "searchResult" as const,
      source: BIKA_PLUGIN_ID,
      list: "comicGrid",
    },
    data: {
      paging: {
        page: currentPage,
        pages,
        total,
        hasReachedMax: currentPage >= pages,
      },
      items,
    },
    paging: {
      page: currentPage,
      pages,
      total,
      hasReachedMax: currentPage >= pages,
    },
    items,
  };
}

function bikaLikeResponseData(response: unknown) {
  const envelope = toStringMap(response);
  const code = bikaCount(envelope.code);
  if (code === 401) {
    throw buildUnauthorizedError(BIKA_PLUGIN_ID, "登录过期，请重新登录");
  }
  if ((envelope.code != null && code !== 200) ||
      envelope.error || envelope.success === false || envelope.ok === false || envelope.status === false) {
    throw new Error("哔咔返回的点赞结果无效，请重新读取");
  }
  return toStringMap(envelope.data);
}

function compatibleLikeState(value: unknown, liked: boolean): boolean {
  return value == null || toBool(value, !liked) === liked;
}

export async function toggleLike(
  payload: BikaLikePayload = {},
): Promise<ToggleLikeResult & { verified: true; totalLikes?: number }> {
  const comicId = String(payload.comicId ?? "").trim();
  if (!comicId) {
    throw new Error("comicId 不能为空");
  }

  const revision = currentBikaAuthRevision();
  await waitBikaSessionWrites(revision);
  const lineSnapshot = await captureBikaLine();
  const apiBase = await getApiBase();
  const appChannel = await loadAppChannel();
  const loadAuthorization = async () =>
    String(await loadPluginSetting("auth.authorization", "")).trim();
  const authorization = await loadAuthorization();
  const assertAuthorization = async () => {
    if (await loadAuthorization() !== authorization) throw new BikaAccountChangedError();
    assertBikaAuthRevision(revision);
  };
  const pinned = { authorization, assertAuthorization, lineSnapshot, appChannel };
  const url = `${apiBase}comics/${encodeURIComponent(comicId)}`;
  const response = await bikaRequest({ ...pinned, url: `${url}/like`, method: "POST" }).catch(async (error: unknown) => {
    await assertAuthorization();
    throw error;
  });
  await assertAuthorization();
  const data = bikaLikeResponseData(response);
  if (data.action !== "like" && data.action !== "unlike") {
    throw new Error("哔咔未确认点赞状态，请重新读取");
  }
  const liked = data.action === "like";
  const sameWork = [data._id, data.id, data.comicId].every((id) => id == null || id === comicId);
  const totalLikes = sameWork && compatibleLikeState(data.isLiked ?? data.liked, liked)
    ? bikaLikesCount(data) : null;

  return {
    liked,
    verified: true,
    ...(totalLikes === null ? {} : { totalLikes }),
  };
}

export async function toggleFavorite(
  payload: BikaToggleFavoritePayload = {},
): Promise<ToggleFavoriteResult> {
  const comicId = String(payload.comicId ?? "").trim();
  if (!comicId) {
    throw new Error("comicId 不能为空");
  }

  const revision = currentBikaAuthRevision();
  await waitBikaSessionWrites(revision);
  const lineSnapshot = await captureBikaLine();
  const apiBase = await getApiBase();
  const appChannel = await loadAppChannel();
  const loadAuthorization = async () =>
    String(await loadPluginSetting("auth.authorization", "")).trim();
  const authorization = await loadAuthorization();
  if (!authorization) throw buildUnauthorizedError(BIKA_PLUGIN_ID, "请先登录哔咔");
  const assertAuthorization = async () => {
    if (await loadAuthorization() !== authorization) throw new BikaAccountChangedError();
    assertBikaAuthRevision(revision);
  };
  const pinned = { authorization, assertAuthorization, lineSnapshot, appChannel };
  const url = `${apiBase}comics/${encodeURIComponent(comicId)}`;
  const requireFavoriteData = (response: unknown) => {
    const envelope = toStringMap(response);
    const code = bikaCount(envelope.code);
    if (code === 401) throw buildUnauthorizedError(BIKA_PLUGIN_ID, "登录过期，请重新登录");
    if ((envelope.code != null && code !== 200) || envelope.error ||
        envelope.success === false || envelope.ok === false || envelope.status === false) {
      throw new Error("哔咔未确认收藏状态，请重新打开作品查看");
    }
    return toStringMap(envelope.data);
  };

  const response = await bikaRequest({ ...pinned, url: `${url}/favourite`, method: "POST" });
  await assertAuthorization();
  const data = requireFavoriteData(response);
  const sameWork = [data._id, data.id, data.comicId].every((id) => id == null || id === comicId);
  if (!sameWork) throw new Error("哔咔未确认收藏状态，请重新打开作品查看");

  // The site's receipt reports the resulting state in data.action.
  let favorited = data.action === "favourite" ? true : data.action === "un_favourite" ? false : null;
  if (favorited === null && typeof payload.currentFavorite === "boolean") {
    const detail = requireFavoriteData(await bikaRequest({ ...pinned, url, method: "GET", timeoutMs: 3500 }));
    await assertAuthorization();
    const comic = toStringMap(detail.comic);
    const desired = !payload.currentFavorite;
    if (comic._id === comicId && toBool(comic.isFavourite, !desired) === desired) favorited = desired;
  }
  if (favorited === null) throw new Error("哔咔未确认收藏状态，请重新打开作品查看");

  return {
    favorited,
    nextStep: "none" as const,
  };
}

export async function listFavoriteFolders(
  _payload: BikaFavoriteFolderPayload = {},
): Promise<ListFavoriteFoldersResult> {
  return {
    items: [],
  };
}

export async function moveFavoriteToFolder(_payload: BikaFavoriteFolderPayload = {}) {
  return {
    ok: true,
  };
}

export async function getFunctionPage(
  payload: Record<string, unknown> = {},
): Promise<FunctionPageContract> {
  const id = String(
    payload.id ?? toStringMap(payload.core).id ?? toStringMap(payload.extern).id,
  ).trim();
  const refresh = payload.refresh === true;

  if (id === "hotSearch") {
    const apiBase = await getApiBase();
    const keywordsResponse = await bikaRequest({
      url: `${apiBase}keywords`,
      method: "GET",
      cache: true,
      cacheArray: ["keywords"],
      refresh,
    });
    const keywordsData = toStringMap(toStringMap(keywordsResponse).data);
    const items = Array.isArray(keywordsData.keywords)
      ? keywordsData.keywords.map((item: unknown) => toHomeChip(item))
      : [];
    return {
      source: BIKA_PLUGIN_ID,
      scheme: {
        version: "1.0.0",
        type: "page",
        title: "热搜",
        body: {
          type: "list" as const,
          children: [{ type: "chip-list" as const, key: "items" }],
        },
      },
      data: {
        items,
        hasReachedMax: true,
      },
    };
  }

  if (id === "navigation") {
    const blocked = new Set(toStrList(await loadPluginSetting("home.blockedCategories", [])));
    const items = (await getNavigationItems(refresh)).filter((item) => {
      const title = String(item?.title ?? "").trim();
      if (blocked.has(title)) {
        return false;
      }

      const action = toStringMap(item?.action);
      const actionPayload = toStringMap(action.payload);
      if (isBikaNativeVideoShortcut(action, toStringMap(payload.extern).nativeVideoTab))
        return false;
      if (String(action.type ?? "") !== "openComicList") {
        return true;
      }

      const fnPath = resolveSceneFnPath(actionPayload.scene);
      return !!fnPath;
    });
    return {
      source: BIKA_PLUGIN_ID,
      scheme: {
        version: "1.0.0",
        type: "page",
        title: "导航",
        body: {
          type: "list" as const,
          children: [{ type: "action-grid", key: "items", bikaCategoryGrid: true }],
        },
      } as unknown as FunctionPageContract["scheme"],
      data: {
        items,
        hasReachedMax: true,
      },
    };
  }

  throw new Error(`未知功能: ${id}`);
}
