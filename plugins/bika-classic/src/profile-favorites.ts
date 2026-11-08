import { buildUnauthorizedError } from "breeze-plugin-kit";
import { bikaRequest } from "../../bika/src/bika-request";
import { toComicListItem } from "../../bika/src/bika-comic-shared";
import { getApiBase } from "../../bika/src/client";
import { loadPluginSetting } from "../../bika/src/plugin-config";
import { currentBikaAuthRevision, assertBikaAuthRevision } from "../../bika/src/bika-auth-session";
import { BIKA_PLUGIN_ID } from "./identity";

const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

const nonnegativeInteger = (value: unknown): number | null => {
  if (!(typeof value === "number" || typeof value === "string" && value.trim() !== "")) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
};

// Keep the shared core unchanged. BK's full list and its profile preview use
// the same proven favorite GET and the mature favorite-image/item mapper.
export async function getFavoriteData(payload: Record<string, unknown> = {}) {
  const page = payload.page === undefined ? 1 : nonnegativeInteger(payload.page);
  if (page === null || page < 1) throw new Error("收藏页码无效");
  const extern = object(payload.extern);
  const sort = String(extern.sort ?? extern.order ?? "dd").trim() || "dd";
  if (!["dd", "da"].includes(sort)) throw new Error("收藏排序无效");
  const revision = currentBikaAuthRevision();
  const authorization = String(await loadPluginSetting("auth.authorization", "")).trim();
  assertBikaAuthRevision(revision);
  if (!authorization || ["null", "undefined"].includes(authorization))
    throw buildUnauthorizedError(BIKA_PLUGIN_ID, "请先登录哔咔账号");
  const assertAuth = async () => {
    assertBikaAuthRevision(revision);
    if (String(await loadPluginSetting("auth.authorization", "")).trim() !== authorization)
      throw new Error("账号已变化，请重新读取收藏");
    assertBikaAuthRevision(revision);
  };
  const base = await getApiBase();
  const raw = object(await bikaRequest({
    url: `${base}users/favourite?s=${sort}&page=${page}`, method: "GET", cache: false,
    authorization, assertAuthorization: assertAuth,
  }));
  await assertAuth();
  if (raw.code === 401) throw buildUnauthorizedError(BIKA_PLUGIN_ID, "请重新登录哔咔账号");
  const comics = object(object(raw.data).comics), docs = comics.docs;
  const currentPage = nonnegativeInteger(comics.page), pages = nonnegativeInteger(comics.pages);
  const total = nonnegativeInteger(comics.total);
  if (raw.code !== 200 || !Array.isArray(docs) || docs.length > 100 ||
      currentPage !== page || pages === null ||
      (docs.length > 0 && pages < page) ||
      (docs.length === 0 && total !== null && total > 0 && (page === 1 || page < pages)) ||
      docs.some((v) => {
        const doc = object(v);
        return typeof doc._id !== "string" || !doc._id.trim() ||
          typeof doc.title !== "string" || !doc.title.trim();
      })) throw new Error("收藏资料不完整，请重试");
  const items = await Promise.all(docs.map((v) => toComicListItem(object(v), { pictureType: "favourite" })));
  await assertAuth();
  const paging = { page: currentPage, pages, hasReachedMax: currentPage >= pages,
    ...(total === null ? {} : { total }) };
  return {
    source: BIKA_PLUGIN_ID,
    extern: payload.extern ?? null,
    scheme: { version: "1.0.0", type: "searchResult", source: BIKA_PLUGIN_ID, list: "comicGrid" },
    data: { items, paging }, paging, items,
  };
}

// A scene describes navigation, not account items. The preview deliberately
// reads page one of the exact same strict adapter without another HTTP call.
export async function getProfileCloudFavoriteBundle() {
  const result = await getFavoriteData({ page: 1, extern: { sort: "dd" } });
  return { source: BIKA_PLUGIN_ID, data: { items: result.data.items, total: result.paging.total ?? null } };
}
