// 本插件使用**自有 uuid**，与官方禁漫插件（bf99008d-010b-4f17-ac7c-61a9b57dc3d9）
// 作为两个独立条目并存，互不覆盖。
//
// 注意：Breeze 3.0.33 及更早版本把官方 uuid 硬编码为页图反混淆开关
// （lib/network/http/picture/picture.dart 的 _kJmPluginUuid），换 uuid 后不会反混淆、
// 页面图会分块错乱。自 3.0.34 起宿主改为询问插件：本插件在 index.ts 导出
// `isJm()` 返回 true 即可触发反混淆，因此 uuid 可以自由更换。
const JM_PLUGIN_ID = "6886291b-f524-441c-844b-c2efae9899a9";

type Scene = Record<string, unknown>;

type BuildPluginInfoInput = {
  buildLatestScene: () => Scene;
  buildRankingScene: () => Scene;
};

export function buildPluginInfo(input: BuildPluginInfoInput) {
  return {
    name: "禁漫天堂+",
    uuid: JM_PLUGIN_ID,
    iconUrl:
      "https://raw.githubusercontent.com/kl5212840-lang/Breeze-plugin-JmComic-change/main/assets/fO.webp",
    creator: {
      name: "kl5212840-lang · 基于 mumushu0501-boop",
      describe: "https://github.com/mumushu0501-boop/Breeze-plugin-JmComic-change",
    },
    describe: "禁漫天堂插件：个人页、收藏、签到与多线路回退",
    version: "0.3.4",
    home: "https://github.com/kl5212840-lang/Breeze-plugin-JmComic-change",
    updateUrl:
      "https://raw.githubusercontent.com/kl5212840-lang/Breeze-plugins/main/updates/jm.json",
    breezeExperience: {
      profileTab: true,
      profileKind: "jm",
      profileCheckinFunction: "checkInToday",
      profileNotificationsFunction: "getNotifications",
      legacySources: [],
      searchQuickCategories: [
        "同人",
        "单本",
        "短篇",
        "韩漫",
        "CG图集",
        "3D",
        "Cosplay",
      ],
    },
    function: [
      {
        id: "recommend",
        title: "推荐",
        action: {
          type: "openPluginFunction" as const,
          payload: {
            id: "recommend",
            title: "推荐",
            presentation: "page" as const,
          },
        },
      },
      {
        id: "categories",
        title: "分类",
        action: {
          type: "openPluginFunction" as const,
          payload: {
            id: "categories",
            title: "分类",
            presentation: "page" as const,
          },
        },
      },
      {
        id: "latest",
        title: "最新",
        action: {
          type: "openComicList" as const,
          payload: { scene: input.buildLatestScene() },
        },
      },
      {
        id: "ranking",
        title: "排行榜",
        action: {
          type: "openComicList" as const,
          payload: { scene: input.buildRankingScene() },
        },
      },
    ],
  };
}

function buildManifestComicListScene(input: {
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

export function buildManifestInfo() {
  return buildPluginInfo({
    buildLatestScene: () =>
      buildManifestComicListScene({
        title: "最新",
        list: {
          fnPath: "getLatestData",
          extern: { source: "latest" },
        },
      }),
    buildRankingScene: () =>
      buildManifestComicListScene({
        title: "禁漫排行榜",
        list: {
          fnPath: "getRankingData",
          extern: { source: "ranking" },
        },
        filter: {
          fnPath: "getRankingFilterBundle",
          extern: { source: "ranking" },
        },
      }),
  });
}
