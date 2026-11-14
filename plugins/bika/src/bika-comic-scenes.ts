import type {
  AdvancedSearchContract,
  ComicListSceneBundleContract,
  FilterBundleContract,
} from "breeze-plugin-kit";
import {
  bikaSearchFieldParameter,
  bikaSearchOverride,
  bikaSearchSortBy,
  boolKeyList,
  getBikaRankingOptions,
  loadBlockedCategories,
} from "./bika-comic-shared";
import { BIKA_SEARCH_CATEGORY_OPTIONS } from "./bika-constants";
import { toNum, toStringMap } from "./bika-utils";
import { getApiBase } from "./client";
import { BIKA_PLUGIN_ID } from "./info";

export async function getCloudFavoriteFilterBundle(): Promise<FilterBundleContract> {
  return {
    source: BIKA_PLUGIN_ID,
    scheme: {
      version: "1.0.0" as const,
      type: "rankingFilter" as const,
      title: "云端收藏筛选",
      fields: [
        {
          key: "order",
          kind: "choice" as const,
          label: "排序",
          options: [
            {
              label: "收藏时间(新→旧)",
              value: "dd",
              result: { extern: { sort: "dd" } },
            },
            {
              label: "收藏时间(旧→新)",
              value: "da",
              result: { extern: { sort: "da" } },
            },
          ],
        },
      ],
    },
    data: {
      values: {
        order: "dd",
      },
    },
  };
}

export async function getCloudFavoriteSceneBundle(): Promise<ComicListSceneBundleContract> {
  return {
    source: BIKA_PLUGIN_ID,
    scheme: {
      version: "1.0.0" as const,
      type: "comicListSceneBundle" as const,
    },
    data: {
      scene: {
        title: "云端收藏",
        source: BIKA_PLUGIN_ID,
        body: {
          type: "pluginPagedComicList" as const,
          request: {
            fnPath: "getFavoriteData",
            core: {},
            extern: {
              source: "cloudFavorite",
              sort: "dd",
            },
          },
        },
        filter: {
          fnPath: "getCloudFavoriteFilterBundle",
          extern: {
            source: "cloudFavorite",
          },
        },
      },
    },
  };
}

export async function getComicListSceneBundle(): Promise<ComicListSceneBundleContract> {
  return {
    source: BIKA_PLUGIN_ID,
    scheme: {
      version: "1.0.0" as const,
      type: "comicListSceneBundle" as const,
    },
    data: {
      scene: {
        title: "哔咔排行榜",
        source: BIKA_PLUGIN_ID,
        body: {
          type: "pluginPagedComicList" as const,
          request: {
            fnPath: "getRankingData",
            core: {
              days: "H24",
              type: "comic",
            },
            extern: {
              source: "ranking",
            },
          },
        },
        filter: {
          fnPath: "getRankingFilterBundle",
          extern: {
            source: "ranking",
          },
        },
      },
    },
  };
}

export async function getRankingFilterBundle(): Promise<FilterBundleContract> {
  return {
    source: BIKA_PLUGIN_ID,
    scheme: {
      version: "1.0.0" as const,
      type: "rankingFilter" as const,
      title: "筛选排行榜",
      fields: [
        {
          key: "ranking",
          kind: "choice" as const,
          label: "榜单",
          options: getBikaRankingOptions(),
        },
        {
          key: "rankingType",
          kind: "choice" as const,
          label: "类别",
          options: [
            { label: "最热门", value: "comic", result: { core: { type: "comic" } } },
            { label: "骑士榜", value: "creator", result: { core: { type: "creator" } } },
          ],
        },
      ],
    },
    data: {
      values: {
        ranking: "day",
        rankingType: "comic",
      },
    },
  };
}

export async function getAdvancedSearchScheme(
  payload: { extern?: Record<string, unknown> } = {},
): Promise<AdvancedSearchContract> {
  const extern = toStringMap(payload.extern);
  const categories = BIKA_SEARCH_CATEGORY_OPTIONS;

  const blockedCategories = await loadBlockedCategories();
  const selectedCategories = boolKeyList(extern.categories);
  const selectedBlocked = boolKeyList(extern.blockedCategories);
  const override = String(extern.url ?? "").trim();
  const scoped = bikaSearchOverride(override, await getApiBase());
  const creator = extern.mode === "creator" && String(extern.creatorId ?? "").trim() !== "";
  const canSort = !override || scoped?.pathname === "/comics";
  const canSelectCategories = !override && !creator && !bikaSearchFieldParameter(extern.bikaSearchField);
  const selectedSortBy = toNum(extern.sortBy, bikaSearchSortBy(scoped?.searchParams.get("s")));

  return {
    source: BIKA_PLUGIN_ID,
    scheme: {
      version: "1.0.0" as const,
      type: "advancedSearch" as const,
      fields: [
        ...(canSort ? [{
          key: "sortBy",
          kind: "choice" as const,
          label: "排序",
          options: [
            { label: "最新", value: 1 },
            { label: "最早", value: 2 },
            { label: "最多喜欢", value: 3 },
            { label: "最多观看", value: 4 },
          ],
        }] : []),
        ...(canSelectCategories ? [{
          key: "categories",
          kind: "multiChoice" as const,
          label: "分类选择",
          options: categories.map((item: string) => ({
            label: item,
            value: item,
          })),
        }] : []),
        {
          key: "blockedCategories",
          kind: "multiChoice" as const,
          label: "屏蔽分类",
          options: categories.map((item: string) => ({
            label: item,
            value: item,
          })),
        },
      ],
    },
    data: {
      values: {
        sortBy: selectedSortBy,
        categories: selectedCategories,
        blockedCategories: selectedBlocked.length > 0 ? selectedBlocked : blockedCategories,
      },
    },
  };
}
