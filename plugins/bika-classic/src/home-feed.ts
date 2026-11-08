import { buildUnauthorizedError, hostRuntime, type ComicListItem } from "breeze-plugin-kit";
import { toComicListItem } from "../../bika/src/bika-comic-shared";
import { getApiBase } from "../../bika/src/client";
import { loadAppChannel } from "../../bika/src/bika-network";
import { loadPluginSetting } from "../../bika/src/plugin-config";
import { toStrList } from "../../bika/src/bika-utils";
import { assertBikaAuthRevision, currentBikaAuthRevision } from "../../bika/src/bika-auth-session";
import { BIKA_PLUGIN_ID } from "./identity";
import { invalidateUnusableHomeRanking, requestHomeFeed } from "./home-request";

export type HomeContext = {
  key: string;
  revision: number;
  authorization: string;
  apiBase: string;
  channel: string;
  blockedCategories: Set<string>;
  homeBlockedCategories: Set<string>;
};

export async function readHomeContext(): Promise<HomeContext> {
  const revision = currentBikaAuthRevision();
  const [rawAuthorization, apiBase, channel, rawBlocked, rawHomeBlocked] = await Promise.all([
    loadPluginSetting("auth.authorization", ""),
    getApiBase(),
    loadAppChannel(),
    loadPluginSetting("search.blockedCategories", []),
    loadPluginSetting("home.blockedCategories", []),
  ]);
  assertBikaAuthRevision(revision);
  const authorization = typeof rawAuthorization === "string" ? rawAuthorization.trim() : "";
  const blocked = [...new Set(toStrList(rawBlocked))].sort();
  const homeBlocked = [...new Set(toStrList(rawHomeBlocked))].sort();
  const key = hostRuntime.crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        BIKA_PLUGIN_ID,
        revision,
        authorization,
        apiBase,
        channel,
        blocked,
        homeBlocked,
      ]),
    )
    .digest("hex") as string;
  return { key, revision, authorization, apiBase, channel, blockedCategories: new Set(blocked), homeBlockedCategories: new Set(homeBlocked) };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function readFeed(
  context: HomeContext,
  kind: "latest" | "ranking",
): Promise<ComicListItem[]> {
  const response = await requestHomeFeed(context, {
    url: `${context.apiBase}${kind === "latest" ? "comics/advanced-search?page=1" : "comics/leaderboard?tt=H24&ct=VC"}`,
    method: kind === "latest" ? "POST" : "GET",
    ...(kind === "latest" ? { body: { sort: "dd", keyword: "", categories: [] } } : {}),
    // Preserve the mature adapters' policy: latest is uncached and ranking
    // keeps its existing 10-minute request cache. Pinned auth scopes its key.
    cache: kind === "ranking",
  });
  const raw = object(response.data);
  const docs = feedDocs(raw, kind);
  if (docs === null) {
    if (kind === "ranking")
      await invalidateUnusableHomeRanking(
        response.storageKey,
        (value) => feedDocs(value, "ranking") === null,
      );
    if (raw.code === 401) throw buildUnauthorizedError(BIKA_PLUGIN_ID, "请先登录哔咔账号");
    throw new Error("首页内容暂时无法读取，请重试");
  }
  const candidates = docs
    .slice(0, 100)
    .map(object)
    .filter(
      (doc) =>
        typeof (doc._id ?? doc.id) === "string" &&
        String(doc._id ?? doc.id).trim() &&
        typeof doc.title === "string" &&
        doc.title.trim(),
    );
  const visible = candidates
    .filter(
      (doc) =>
        !toStrList(doc.categories).some((category) => context.blockedCategories.has(category)),
    )
    .slice(0, 12);
  return await Promise.all(visible.map((doc) => toComicListItem(doc)));
}

function feedDocs(value: unknown, kind: "latest" | "ranking"): unknown[] | null {
  const raw = object(value);
  if (raw.code !== 200) return null;
  const comics = object(raw.data).comics;
  const docs = kind === "ranking" || Array.isArray(comics) ? comics : object(comics).docs;
  if (!Array.isArray(docs)) return null;
  if (
    docs.length &&
    !docs.slice(0, 100).some((value) => {
      const doc = object(value);
      return (
        typeof (doc._id ?? doc.id) === "string" &&
        String(doc._id ?? doc.id).trim() &&
        typeof doc.title === "string" &&
        doc.title.trim()
      );
    })
  )
    return null;
  return docs;
}

// Same verified endpoints, parameters and cache policy as the mature adapters.
export const readLatestHomeFeed = (context: HomeContext) => readFeed(context, "latest");
export const readRankingHomeFeed = (context: HomeContext) => readFeed(context, "ranking");
