import { buildUnauthorizedError, type FunctionPageContract } from "breeze-plugin-kit";
import { getFunctionPage as getCoreFunctionPage } from "../../bika/src/bika-comic-library";
import { buildHomeAction, openSearchAction, toActionItem, toHomeChip } from "../../bika/src/bika-comic-shared";
import { buildBikaImageUrl } from "../../bika/src/bika-image";
import { resolveBikaCategoryArtwork } from "../../bika/src/bika-category-art";
import { isBikaNativeVideoShortcut } from "../../bika/src/bika-navigation";
import { invalidateUnusableHomeResponse, requestHomeFeed } from "./home-request";
import { assertBikaAuthRevision, BikaAccountChangedError } from "../../bika/src/bika-auth-session";
import { BIKA_PLUGIN_ID, buildRankingScene } from "./info";
import { readHomeContext, type HomeContext } from "./home-feed";

type Area = "categories" | "keywords";
type Item = Record<string, unknown>;
type Snapshot = { items: Item[]; observedAt: string };
let activeContext = "";
let generation = 0;
let snapshots: Partial<Record<Area, Snapshot>> = {};
let pending: { key: string; generation: number; task: Promise<FunctionPageContract> } | null = null;

export function clearHomeSnapshot() {
  activeContext = "";
  snapshots = {};
  pending = null;
  generation++;
}

function needsLogin(error: unknown) {
  try {
    const data = JSON.parse(String((error as Error)?.message ?? ""));
    return data.type === "unauthorized" && data.source === BIKA_PLUGIN_ID;
  } catch {
    return false;
  }
}

export async function getHomeData(): Promise<FunctionPageContract> {
  const context = await readHomeContext();
  if (context.key !== activeContext) {
    clearHomeSnapshot();
    activeContext = context.key;
  }
  if (pending?.key === context.key && pending.generation === generation) return pending.task;
  const ticket = generation;
  const task = loadHome(context, ticket).finally(() => {
    if (pending?.task === task) pending = null;
  });
  pending = { key: context.key, generation: ticket, task };
  return task;
}

async function assertHomeContextCurrent(context: HomeContext, ticket: number) {
  const current = await readHomeContext();
  assertBikaAuthRevision(context.revision);
  if (current.key !== context.key || generation !== ticket || activeContext !== context.key)
    throw new Error("浏览条件已变化，请重试");
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function areaRows(value: unknown, area: Area): unknown[] | null {
  const raw = object(value);
  const rows = object(raw.data)[area];
  return raw.code === 200 && Array.isArray(rows) ? rows : null;
}

async function readArea(context: HomeContext, area: Area): Promise<Item[]> {
  // Same documented endpoints and cache policy as the mature core. Validate
  // the business envelope before mapping; the core page wrapper turns a failed
  // business response into an indistinguishable empty page.
  const response = await requestHomeFeed(context, {
    url: `${context.apiBase}${area}`, method: "GET", cache: true,
  });
  const rows = areaRows(response.data, area);
  if (rows === null) {
    // Reuse the existing exact-key CAS: no healthy cache eviction or retry.
    await invalidateUnusableHomeResponse(response.storageKey,
      (value) => areaRows(value, area) === null);
    if (object(response.data).code === 401)
      throw buildUnauthorizedError(BIKA_PLUGIN_ID, "请先登录哔咔账号");
    throw new Error(area === "categories" ? "分类暂时无法读取，请重试" : "热词暂时无法读取，请重试");
  }
  if (area === "keywords") return rows.map(toHomeChip) as unknown as Item[];
  const categories = rows.map(object).filter((item) => {
    const title = String(item.title ?? "").trim();
    return title && !["最近更新", "随机本子"].includes(title)
      && !context.homeBlockedCategories.has(title);
  });
  const mapped = await Promise.all(categories.map(async (item) => {
    const thumb = object(item.thumb);
    const fileServer = String(thumb.fileServer ?? "").trim();
    const path = String(thumb.path ?? "").trim();
    const artwork = resolveBikaCategoryArtwork(item, {
      url: fileServer && path ? await buildBikaImageUrl(fileServer, path, "else") : "", path,
    });
    const action = await buildHomeAction(item, context.authorization);
    if (isBikaNativeVideoShortcut(action as unknown as Item, true)) return null;
    return { ...toActionItem({ title: String(item.title), coverUrl: artwork.url,
      coverPath: artwork.path, action }), ...(artwork.icon ? { icon: artwork.icon } : {}) };
  }));
  return mapped.filter((item): item is NonNullable<typeof item> => item !== null) as unknown as Item[];
}

async function loadHome(context: HomeContext, ticket: number): Promise<FunctionPageContract> {
  const areas: Area[] = ["categories", "keywords"];
  let rejectAuthentication!: (error: unknown) => void;
  const authentication = new Promise<never>((_, reject) => {
    rejectAuthentication = reject;
  });
  const tasks = areas.map((area) => readArea(context, area).catch((error) => {
    if (needsLogin(error) || error instanceof BikaAccountChangedError)
      rejectAuthentication(error);
    throw error;
  }));
  let results: PromiseSettledResult<Item[]>[];
  try {
    results = await Promise.race([Promise.allSettled(tasks), authentication]);
  } catch (error) {
    await assertHomeContextCurrent(context, ticket);
    clearHomeSnapshot();
    throw error;
  }
  await assertHomeContextCurrent(context, ticket);
  const notices: Array<{ label: string; action: Record<string, unknown> }> = [];
  const sectionStates: Record<string, { state: string; observedAt: string | null }> = {};
  for (const [index, area] of areas.entries()) {
    const result = results[index]!;
    if (result.status === "fulfilled")
      snapshots[area] = { items: structuredClone(result.value), observedAt: new Date().toISOString() };
    const snapshot = snapshots[area];
    const state = result.status === "fulfilled"
      ? result.value.length ? "fresh" : "empty"
      : snapshot ? "stale" : "error";
    sectionStates[area] = { state, observedAt: snapshot?.observedAt ?? null };
    if (state !== "fresh") {
      const title = area === "categories" ? "分类" : "热词";
      const label = state === "empty"
        ? `暂无可显示${title} · 重新加载`
        : `${title}${state === "stale" ? "更新" : "加载"}失败 · 重试`;
      // chip-list and openPluginFunction are already rendered by the host.
      // Failure is visible and retryable even before sectionStates is consumed.
      notices.push({ label, action: { type: "openPluginFunction", payload: {
        source: BIKA_PLUGIN_ID, id: "home", title: "首页", presentation: "page",
      } } });
    }
  }
  const shortcuts = [
    { label: "排行榜", action: { type: "openComicList", payload: { scene: buildRankingScene() } } },
    ...(!context.homeBlockedCategories.has("最近更新")
      ? [{ label: "最近更新", action: openSearchAction({ source: BIKA_PLUGIN_ID }) }] : []),
    ...(!context.homeBlockedCategories.has("随机本子")
      ? [{ label: "随机本子", action: openSearchAction({
        source: BIKA_PLUGIN_ID, url: `${context.apiBase}comics/random`,
      }) }] : []),
  ];
  return {
    source: BIKA_PLUGIN_ID,
    scheme: {
      version: "1.0.0", type: "page", title: "首页",
      body: { type: "list", children: [
        { type: "chip-list", key: "notices" },
        { type: "chip-list", key: "keywords" },
        { type: "chip-list", key: "shortcuts" },
        { type: "source-category-grid", key: "categories" },
      ] },
    } as unknown as FunctionPageContract["scheme"],
    data: {
      categories: structuredClone(snapshots.categories?.items ?? []),
      keywords: structuredClone(snapshots.keywords?.items ?? []),
      shortcuts, notices, sectionStates, hasReachedMax: true,
    },
  };
}

export async function getFunctionPage(payload: Record<string, unknown> = {}): Promise<FunctionPageContract> {
  const core = payload.core as Record<string, unknown> | undefined;
  const extern = payload.extern as Record<string, unknown> | undefined;
  const id = String(payload.id ?? core?.id ?? extern?.id ?? "");
  if (id === "home") return getHomeData();
  // Keep existing deep links callable without exposing a second category tab.
  if (id === "navigation") {
    const page = await getCoreFunctionPage(payload);
    const items = (page.data.items as Item[]).filter(
      (item) => !["最近更新", "随机本子"].includes(String(item.title ?? "")),
    );
    return { ...page, scheme: { ...page.scheme, title: "分类" }, data: { ...page.data, items } };
  }
  return getCoreFunctionPage(payload);
}
