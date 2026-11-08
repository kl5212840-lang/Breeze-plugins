import core from "../../bika/src/index";
import { cache } from "breeze-plugin-kit";
import {
  API_BASE_CACHE_KEY,
  DEFAULT_API_BASE,
  BACKUP_API_BASE,
  setApiBase,
} from "../../bika/src/client";
import { loadPluginSetting } from "../../bika/src/plugin-config";
import { BIKA_PLUGIN_ID, buildManifestInfo, buildRankingScene } from "./info";
import { clearHomeSnapshot, getHomeData, getFunctionPage } from "./home";
import { getSettingsBundle } from "./settings";
import { getGameListBundle, getGameDetailsBundle } from "./games";
import { getFavoriteData, getProfileCloudFavoriteBundle } from "./profile-favorites";
import { getOfficialHelpBundle } from "./official-help";
import { registerAccount } from "./registration";

// Installing or reopening this plugin must not log in, check in or start the
// shared core's automatic account flow. Manual account actions remain available.
async function init() {
  const saved = String(await loadPluginSetting("network.apiBase", DEFAULT_API_BASE));
  const apiBase = [DEFAULT_API_BASE, BACKUP_API_BASE].includes(saved) ? saved : DEFAULT_API_BASE;
  await cache.set(API_BASE_CACHE_KEY, apiBase);
  setApiBase(apiBase);
  return { source: BIKA_PLUGIN_ID, data: { ok: true, started: true, apiBase } };
}

export { BIKA_PLUGIN_ID };
export default {
  ...core,
  init,
  getInfo: async () => buildManifestInfo(),
  getHomeData,
  getFunctionPage,
  getSettingsBundle,
  getGameListBundle,
  getGameDetailsBundle,
  getProfileCloudFavoriteBundle,
  getFavoriteData,
  getOfficialHelpBundle,
  registerAccount,
  getComicListSceneBundle: async () => {
    const bundle = await core.getComicListSceneBundle();
    return { ...bundle, data: { ...bundle.data, scene: buildRankingScene() } };
  },
  clearPluginSession: async () => {
    clearHomeSnapshot();
    await core.clearPluginSession();
    return { source: BIKA_PLUGIN_ID, ok: true, message: "已退出登录" };
  },
  dumpRuntimeInfo: async () => ({
    source: BIKA_PLUGIN_ID,
    ok: true,
    data: { pluginName: "bika-classic", now: new Date().toISOString() },
  }),
};
