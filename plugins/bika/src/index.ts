import { getBikaAccessLineState, checkBikaAccessLines, cancelBikaAccessLineCheck,
  selectBikaAccessLine as commitBikaAccessLine } from "./bika-access-lines";
import { getBikaVideoCatalog, getBikaVideoDetail, getBikaVideoPlayback } from "./bika-video";
import { checkInToday, getCheckinStatus } from "./bika-checkin";
import { getChapter, getComicDetail, getReadSnapshot } from "./bika-comic-detail";
import { getComicFollowDetail } from "./bika-comic-follow";
import type { ComicDetailPayload } from "./bika-types";
import {
  getFavoriteData,
  getFunctionPage,
  getHomeData,
  listFavoriteFolders,
  moveFavoriteToFolder,
  searchComic,
  toggleFavorite,
  toggleLike,
} from "./bika-comic-library";
import { getRankingData } from "./bika-comic-ranking";
import {
  getAdvancedSearchScheme,
  getCloudFavoriteFilterBundle,
  getCloudFavoriteSceneBundle,
  getComicListSceneBundle,
  getRankingFilterBundle,
} from "./bika-comic-scenes";
import { getCommentFeed, loadCommentReplies, postComment, postCommentReply } from "./bika-comments";
import { bikaRequest, fetchImageBytes } from "./bika-request";
import {
  clearPluginSession,
  dumpRuntimeInfo,
  getCapabilitiesBundle,
  getLoginBundle,
  getSettingsBundle,
  getUserInfoBundle,
  init,
  loginWithPassword,
  saveSettings,
  updateAvatar,
  updatePassword,
  updateProfile,
} from "./bika-settings";
import { buildManifestInfo, type BikaPluginInfo } from "./info";

export { BIKA_PLUGIN_ID } from "./info";

async function getInfo(): Promise<BikaPluginInfo> {
  return buildManifestInfo();
}

export default {
  getBikaAccessLineState,
  checkBikaAccessLines,
  cancelBikaAccessLineCheck,
  selectBikaAccessLine: async (payload: Parameters<typeof commitBikaAccessLine>[0]) => {
    const result = await commitBikaAccessLine(payload);
    if (result.ok) await init();
    return result;
  },
  getBikaVideoCatalog,
  getBikaVideoDetail,
  getBikaVideoPlayback,
  init,
  bikaRequest,
  getComicDetail: (payload?: ComicDetailPayload) =>
    payload?.extern?.comicFollow === true ? getComicFollowDetail(payload) : getComicDetail(payload),
  getSettingsBundle,
  saveSettings,
  getUserInfoBundle,
  checkInToday,
  getCheckinStatus,
  updateAvatar,
  updateProfile,
  updatePassword,
  getLoginBundle,
  loginWithPassword,
  getCapabilitiesBundle,
  getComicListSceneBundle,
  getRankingFilterBundle,
  getAdvancedSearchScheme,
  clearPluginSession,
  dumpRuntimeInfo,
  getHomeData,
  getFavoriteData,
  toggleLike,
  getCommentFeed,
  loadCommentReplies,
  postComment,
  postCommentReply,
  toggleFavorite,
  listFavoriteFolders,
  moveFavoriteToFolder,
  getCloudFavoriteFilterBundle,
  getCloudFavoriteSceneBundle,
  getRankingData,
  searchComic,
  getChapter,
  getReadSnapshot,
  fetchImageBytes,
  getFunctionPage,
  getInfo,
};
