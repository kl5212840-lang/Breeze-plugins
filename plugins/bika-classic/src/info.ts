import type { ComicListScene, InfoContract } from "breeze-plugin-kit";
import { BIKA_SEARCH_CATEGORY_OPTIONS } from "../../bika/src/bika-constants";
import { bikaVideoAction } from "../../bika/src/bika-video";
import { BIKA_PLUGIN_ID } from "./identity";
export { BIKA_PLUGIN_ID } from "./identity";

export type BikaRankingScene = ComicListScene & {
  body: ComicListScene["body"] & { params: { layout: "bikaRanking" } };
};

export function buildRankingScene(): BikaRankingScene {
  return {
    title: "排行榜",
    source: BIKA_PLUGIN_ID,
    body: {
      type: "pluginPagedComicList",
      params: { layout: "bikaRanking" },
      request: {
        fnPath: "getRankingData",
        core: { days: "H24", type: "comic" },
        extern: { source: "ranking" },
      },
    },
    filter: { fnPath: "getRankingFilterBundle", extern: { source: "ranking" } },
  };
}

export function buildCloudFavoriteScene(): ComicListScene {
  return {
    title: "站点收藏",
    source: BIKA_PLUGIN_ID,
    body: {
      type: "pluginPagedComicList",
      request: {
        fnPath: "getFavoriteData",
        core: {},
        extern: { source: "cloudFavorite", sort: "dd" },
      },
    },
    filter: { fnPath: "getCloudFavoriteFilterBundle", extern: { source: "cloudFavorite" } },
  };
}

export function buildManifestInfo() {
  return {
    name: "哔咔漫画",
    uuid: BIKA_PLUGIN_ID,
    iconUrl:
      "https://raw.githubusercontent.com/kl5212840-lang/Breeze-plugin-bika-personal/main/assets/logo_round.webp",
    describe: "社区适配的哔咔阅读体验，独立保存本机资料",
    version: "0.1.4",
    // Local candidate. Add a dedicated channel only when a release exists.
    updateUrl: "",
    home: "https://github.com/kl5212840-lang/Breeze-plugins",
    npmName: "",
    breezeVideoModules: [
      bikaVideoAction("https://adult-movie.bidobido.xyz/"),
      bikaVideoAction("https://adult-animate.bidobido.xyz/"),
    ],
    breezeExperience: {
      aggregateMedia: "comic",
      bikaExperience: {
        version: 1,
        appearanceKey: "ui.experienceStyle",
        loadingArtwork: "bikaIos2585",
        gameListFunction: "getGameListBundle",
        gameDetailFunction: "getGameDetailsBundle",
        officialHelpFunction: "getOfficialHelpBundle",
        registration: { version: 1, submitFunction: "registerAccount" },
      },
      searchHotFunction: "hotSearch",
      profileTab: true,
      profileKind: "bika",
      videoBrowseOnly: true,
      profileVideoRecords: true,
      profileAvatarFunction: "updateAvatar",
      profileBioFunction: "updateProfile",
      profileCloudFavoriteFunction: "getProfileCloudFavoriteBundle",
      profileCheckinFunction: "checkInToday",
      profileCheckinStatusFunction: "getCheckinStatus",
      profileCheckinDateBasis: "observedUtc8",
      profileCheckinStatusSource: "serverProfile",
      searchQuickCategories: BIKA_SEARCH_CATEGORY_OPTIONS,
      // Optional, versioned declaration. Older hosts safely ignore it.
      communityAdaptation: {
        version: 1,
        intent: "officialExperience",
        officialRelease: false,
        localRecords: "standalone",
        accountSession: "standalone",
        recordImport: "unavailable",
        baseline: "userSelectedIos2585",
      },
    },
    function: [
      {
        id: "home",
        title: "首页",
        action: {
          type: "openPluginFunction",
          payload: { id: "home", title: "首页", presentation: "page" },
        },
      },

    ],
  } satisfies InfoContract & Record<string, unknown>;
}

export type BikaPluginInfo = ReturnType<typeof buildManifestInfo>;
