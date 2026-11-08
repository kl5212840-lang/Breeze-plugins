import { buildUnauthorizedError } from "breeze-plugin-kit";
import { bikaRequest } from "../../bika/src/bika-request";
import { getApiBase } from "../../bika/src/client";
import { loadAppChannel } from "../../bika/src/bika-network";
import { loadPluginSetting } from "../../bika/src/plugin-config";
import { assertBikaAuthRevision, currentBikaAuthRevision } from "../../bika/src/bika-auth-session";
import { BIKA_PLUGIN_ID } from "./identity";
import { buildBikaImageUrl } from "../../bika/src/bika-image";

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";

// Methods, paths, envelope and fields recovered from the user-selected iOS
// 2.5.85 snapshot. No game data is fetched during installation or init.
async function readGame(path: string) {
  const revision = currentBikaAuthRevision();
  const [rawAuthorization, base, channel] = await Promise.all([
    loadPluginSetting("auth.authorization", ""), getApiBase(), loadAppChannel(),
  ]);
  assertBikaAuthRevision(revision);
  const authorization = text(rawAuthorization);
  if (!authorization) throw buildUnauthorizedError(BIKA_PLUGIN_ID, "请先登录哔咔账号");
  const assertContext = async () => {
    assertBikaAuthRevision(revision);
    const [auth, nextBase, nextChannel] = await Promise.all([
      loadPluginSetting("auth.authorization", ""), getApiBase(), loadAppChannel(),
    ]);
    assertBikaAuthRevision(revision);
    if (text(auth) !== authorization || nextBase !== base || nextChannel !== channel)
      throw new Error("账号或线路已变化，请重新读取游戏");
  };
  const raw = object(await bikaRequest({
    url: `${base}${path}`, method: "GET", cache: false,
    authorization, assertAuthorization: assertContext,
  }));
  await assertContext();
  if (raw.code === 401) throw buildUnauthorizedError(BIKA_PLUGIN_ID, "请重新登录哔咔账号");
  if (raw.code !== 200) throw new Error("游戏内容暂时无法读取，请重试");
  return { data: object(raw.data), assertContext };
}

async function gameItem(value: unknown) {
  const raw = object(value), id = text(raw._id), title = text(raw.title);
  if (!id || !title) return null;
  const icon = object(raw.icon);
  return {
    id, title,
    cover: {
      url: text(icon.fileServer) && text(icon.path)
        ? await buildBikaImageUrl(icon.fileServer, icon.path, "cover") : "",
      path: text(icon.path),
    },
    publisher: text(raw.publisher), version: text(raw.version),
    adult: typeof raw.adult === "boolean" ? raw.adult : null,
    android: typeof raw.android === "boolean" ? raw.android : null,
    ios: typeof raw.ios === "boolean" ? raw.ios : null,
  };
}

export async function getGameListBundle(payload: Record<string, unknown> = {}) {
  const rawPage = payload.page ?? 1;
  if (typeof rawPage !== "number" || !Number.isSafeInteger(rawPage) || rawPage < 1)
    throw new Error("游戏页码无效");
  const response = await readGame(`games?page=${rawPage}`);
  const games = object(response.data.games);
  const page = games.page, pages = games.pages, docs = games.docs;
  if (!Array.isArray(docs) || docs.length > 100 ||
      !Number.isSafeInteger(page) || page !== rawPage ||
      typeof pages !== "number" || !Number.isSafeInteger(pages) || pages < 0 ||
      (docs.length > 0 && pages < rawPage))
    throw new Error("游戏列表资料不完整，请重试");
  const items = (await Promise.all(docs.map(gameItem))).filter((item) => item !== null);
  await response.assertContext();
  if (docs.length > 0 && items.length === 0) throw new Error("游戏列表资料不完整，请重试");
  return { source: BIKA_PLUGIN_ID, data: { items, page: rawPage, pages, hasMore: rawPage < pages } };
}

export async function getGameDetailsBundle(payload: Record<string, unknown> = {}) {
  const id = text(payload.id);
  if (!id || id.length > 128) throw new Error("游戏资料无效");
  const response = await readGame(`games/${encodeURIComponent(id)}`);
  const raw = object(response.data.game);
  const item = await gameItem(raw);
  await response.assertContext();
  if (!item || item.id !== id) throw new Error("游戏详情暂时无法读取，请重试");
  return {
    source: BIKA_PLUGIN_ID,
    data: { game: {
      ...item, description: text(raw.description),
      // These arrays are read directly by the selected IPA's platform helper.
      // Expose user-opened web links only; never turn them into comic tasks.
      downloadLinks: ["ios", "android"].flatMap((platform) => {
        const links = raw[`${platform}Links`];
        if (!Array.isArray(links)) return [];
        return [...new Set(links.filter((value): value is string => typeof value === "string"))]
          .slice(0, 20).flatMap((url) => {
            try {
              const parsed = new URL(url);
              return ["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password
                ? [{ platform, url: parsed.href }] : [];
            } catch { return []; }
          });
      }),
    } },
  };
}
