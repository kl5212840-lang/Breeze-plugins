import type { InfoContract } from "breeze-plugin-kit";
import { PLUGIN_ID, PLUGIN_VERSION } from "./config";

export function buildPluginInfo(): InfoContract & {
  websiteUrl: string;
  breezeExperience: {
    comicFollow: 1;
    copyTopicSearch: 1;
    profileTab: boolean;
    profileKind: string;
    profileCloudFavoriteFunction: string;
    profileAvatarFunction: string;
  };
} {
  return {
    name: "拷贝漫画",
    uuid: PLUGIN_ID,
    iconUrl:
      "https://raw.githubusercontent.com/deretame/Breeze-plugin-copyComic/main/assets/u3.webp",
    describe: "拷贝漫画插件",
    version: PLUGIN_VERSION,
    home: "https://github.com/kl5212840-lang/Breeze-plugin-copyComic",
    websiteUrl: "https://www.mangacopy.com/",
    updateUrl:
      "https://raw.githubusercontent.com/kl5212840-lang/Breeze-plugins/main/updates/copy.json",
    npmName: "",
    breezeExperience: {
      comicFollow: 1,
      copyTopicSearch: 1,
      profileTab: true,
      profileKind: "generic",
      profileCloudFavoriteFunction: "getCloudFavoriteData",
      profileAvatarFunction: "updateAvatar",
    },
    function: [
      {
        id: "recommend",
        title: "漫画推荐",
        action: {
          type: "openComicList",
          payload: {
            scene: {
              title: "漫画推荐",
              source: PLUGIN_ID,
              body: {
                type: "pluginPagedComicList",
                request: {
                  fnPath: "getHomeRecommend",
                  core: {},
                  extern: {},
                },
              },
            },
          },
        },
      },
      {
        id: "newest",
        title: "全新上架",
        action: {
          type: "openComicList",
          payload: {
            scene: {
              title: "全新上架",
              source: PLUGIN_ID,
              body: {
                type: "pluginPagedComicList",
                request: {
                  fnPath: "getHomeNewest",
                  core: {},
                  extern: {},
                },
              },
            },
          },
        },
      },
      {
        id: "discover",
        title: "发现",
        action: {
          type: "openComicList",
          payload: {
            scene: {
              title: "发现",
              source: PLUGIN_ID,
              body: {
                type: "pluginPagedComicList",
                request: {
                  fnPath: "getHomeDiscover",
                  core: {},
                  extern: {},
                },
              },
              filter: {
                fnPath: "getHomeDiscoverFilterBundle",
                core: {},
                extern: {},
              },
            },
          },
        },
      },
      {
        id: "rank",
        title: "排行榜",
        action: {
          type: "openComicList",
          payload: {
            scene: {
              title: "排行榜",
              source: PLUGIN_ID,
              body: {
                type: "pluginPagedComicList",
                request: {
                  fnPath: "getHomeRank",
                  core: {},
                  extern: {},
                },
              },
              filter: {
                fnPath: "getHomeRankFilterBundle",
                core: {},
                extern: {},
              },
            },
          },
        },
      },

    ],
  };
}

export function buildManifestInfo(): InfoContract {
  return buildPluginInfo();
}
