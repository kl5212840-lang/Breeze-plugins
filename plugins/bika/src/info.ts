import type { ComicListScene, InfoContract } from "breeze-plugin-kit";
import { BIKA_SEARCH_CATEGORY_OPTIONS } from "./bika-constants";

export type BikaPluginInfo = InfoContract & {
  breezeExperience: {
    searchHotFunction: string;
    profileTab: boolean;
    profileAvatarFunction: string;
    profileBioFunction: string;
    legacySources: string[];
    searchQuickCategories: string[];
  };
};

export const BIKA_PLUGIN_ID = "e9f18928-3ba8-4d86-a12e-b53a62f47933";
export function buildRankingScene(): ComicListScene {
  return {
    title: "哔咔排行榜",
    source: BIKA_PLUGIN_ID,
    body: {
      type: "pluginPagedComicList",
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
  };
}

export function buildCloudFavoriteScene(): ComicListScene {
  return {
    title: "云端收藏",
    source: BIKA_PLUGIN_ID,
    body: {
      type: "pluginPagedComicList",
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
  };
}

export function buildManifestInfo(): BikaPluginInfo {
  return {
    name: "哔咔漫画+",
    uuid: BIKA_PLUGIN_ID,
    iconUrl:
      "https://raw.githubusercontent.com/kl5212840-lang/Breeze-plugin-bika-personal/main/assets/logo_round.webp",
    describe: "独立更新的哔咔漫画插件",
    version: "0.1.11",
    updateUrl:
      "https://raw.githubusercontent.com/kl5212840-lang/Breeze-plugins/main/updates/bika.json",
    home: "https://github.com/kl5212840-lang/Breeze-plugin-bika-personal",
    npmName: "",
    breezeExperience: {
      searchHotFunction: "hotSearch",
      profileTab: true,
      profileAvatarFunction: "updateAvatar",
      profileBioFunction: "updateProfile",
      legacySources: ["0a0e5858-a467-4702-994a-79e608a4589d"],
      searchQuickCategories: [
        "短篇",
        "嗶咔漢化",
        "CG雜圖",
        "禁書目錄",
        "生肉",
        ...BIKA_SEARCH_CATEGORY_OPTIONS.filter(
          (item) => !["短篇", "嗶咔漢化", "CG雜圖", "禁書目錄", "生肉"].includes(item),
        ),
      ],
    },
    function: [
      {
        id: "navigation",
        title: "分类",
        action: {
          type: "openPluginFunction",
          payload: {
            id: "navigation",
            title: "分类",
            presentation: "page",
          },
        },
      },
      {
        id: "ranking",
        title: "排行榜",
        action: {
          type: "openComicList",
          payload: {
            scene: buildRankingScene(),
          },
        },
      },
    ],
  };
}
