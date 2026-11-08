import type { ComicListScene, InfoContract } from "breeze-plugin-kit";
import { bikaVideoAction } from "./bika-video";
import { BIKA_SEARCH_CATEGORY_OPTIONS } from "./bika-constants";
import { BIKA_PLUGIN_ID } from "./bika-identity";
export { BIKA_PLUGIN_ID } from "./bika-identity";

export type BikaPluginInfo = InfoContract & {
  breezeVideoModules: ReturnType<typeof bikaVideoAction>[];
  breezeExperience: {
    aggregateMedia: string;
    searchHotFunction: string;
    profileTab: boolean;
    bikaExperience: {
      version: number;
      appearanceKey: string;
      loadingArtwork: string;
      accessLinesVersion: number;
      imageQualityVersion: number;
    };
    profileAvatarFunction: string;
    profileBioFunction: string;
    profileCheckinFunction: string;
    profileCheckinStatusFunction: string;
    profileCheckinDateBasis: string;
    profileCheckinStatusSource: string;
    legacySources: string[];
    searchQuickCategories: string[];
  };
};

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
    version: "0.1.23",
    updateUrl:
      "https://raw.githubusercontent.com/kl5212840-lang/Breeze-plugins/main/updates/bika.json",
    home: "https://github.com/kl5212840-lang/Breeze-plugin-bika-personal",
    npmName: "",
    breezeVideoModules: [bikaVideoAction("https://adult-movie.bidobido.xyz/"), bikaVideoAction("https://adult-animate.bidobido.xyz/")],
    breezeExperience: {
      aggregateMedia: "comic",
      searchHotFunction: "hotSearch",
      profileTab: true,
      bikaExperience: {
        version: 1,
        appearanceKey: "ui.experienceStyle",
        loadingArtwork: "bikaIos2585",
        accessLinesVersion: 1,
        imageQualityVersion: 1,
      },
      profileAvatarFunction: "updateAvatar",
      profileBioFunction: "updateProfile",
      profileCheckinFunction: "checkInToday",
      profileCheckinStatusFunction: "getCheckinStatus",
      profileCheckinDateBasis: "observedUtc8",
      profileCheckinStatusSource: "serverProfile",
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
