/** Public bidobido video modules. Never use the authenticated comic client here. */
import { BIKA_PLUGIN_ID as SOURCE } from "./bika-identity";
const HOMES = {
  movie: "https://adult-movie.bidobido.xyz/",
  animate: "https://adult-animate.bidobido.xyz/",
} as const;
type Module = keyof typeof HOMES;
type MapValue = Record<string, unknown>;
type Args = {
  home?: unknown;
  id?: unknown;
  page?: unknown;
  query?: unknown;
  snapshot?: unknown;
  lineId?: unknown;
  episodeId?: unknown;
};
type Reader = (url: string) => Promise<unknown>;
const object = (v: unknown): MapValue =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as MapValue) : {};
const text = (v: unknown, limit = 500) =>
  typeof v === "string"
    ? v
        .replace(/[\x00-\x1f\x7f]/g, " ")
        .trim()
        .slice(0, limit)
    : "";
function moduleFor(raw: unknown): Module {
  const home = text(raw, 300);
  for (const [key, value] of Object.entries(HOMES)) if (home === value) return key as Module;
  throw new Error("无效的视频来源");
}
function idFor(module: Module, raw: unknown): string {
  const id = text(raw, 100),
    prefix = `${module}:`;
  if (!id.startsWith(prefix) || !/^[A-Za-z0-9_-]{1,64}$/.test(id.slice(prefix.length)))
    throw new Error("无效的视频编号");
  return id.slice(prefix.length);
}
function https(raw: unknown): string {
  try {
    const u = new URL(text(raw, 4096));
    if (u.protocol !== "https:" || u.username || u.password) return "";
    return u.href;
  } catch {
    return "";
  }
}
function watchUrl(module: Module, hid: string): string {
  const url = new URL(`/videos/${hid}`, HOMES[module]);
  url.searchParams.set("line", "default");
  url.searchParams.set("episode", hid);
  return url.href;
}
function normalizeRow(module: Module, raw: unknown): MapValue {
  const row = object(raw),
    hid = text(row.hid, 100);
  idFor(module, `${module}:${hid}`);
  const title = text(row.name)
    .replace(/<[^>]*>/g, "")
    .trim();
  if (!title) throw new Error("视频缺少名称");
  const number = String(row.hits ?? "");
  return {
    id: `${module}:${hid}`,
    title,
    detailUrl: new URL(`/videos/${hid}`, HOMES[module]).href,
    coverUrl:
      module === "movie"
        ? https(row.pic_s) || https(row.pic_b)
        : https(row.pic_b) || https(row.pic_s),
    ...(module === "animate" ? { containCover: true } : {}),
    description: text(row.description, 1500),
    remarks: text(row.barcode, 200),
    genres: Array.isArray(row.tags)
      ? row.tags
          .map((x) => text(x, 80))
          .filter(Boolean)
          .join("、")
          .slice(0, 500)
      : "",
    actors: Array.isArray(row.girls)
      ? row.girls
          .map((x) => text(x, 80))
          .filter((x) => x && x !== "無資料")
          .join("、")
          .slice(0, 1000)
      : "",
    ...(/^\d+$/.test(number) && Number.isSafeInteger(Number(number))
      ? { sourceViews: Number(number) }
      : {}),
  };
}
function fromSnapshot(module: Module, args: Args): MapValue {
  const hid = idFor(module, args.id),
    snapshot = object(args.snapshot);
  if (
    snapshot.id !== `${module}:${hid}` ||
    snapshot.detailUrl !== new URL(`/videos/${hid}`, HOMES[module]).href ||
    !text(snapshot.title)
  )
    throw new Error("视频资料不可用，请重新浏览");
  const fields = ["title", "description", "remarks", "genres", "actors"] as const;
  const item: MapValue = {
    id: `${module}:${hid}`,
    detailUrl: snapshot.detailUrl,
    coverUrl: https(snapshot.coverUrl),
    ...(module === "animate" ? { containCover: true } : {}),
  };
  for (const key of fields) item[key] = text(snapshot[key], key === "description" ? 1500 : 1000);
  if (
    typeof snapshot.sourceViews === "number" &&
    Number.isSafeInteger(snapshot.sourceViews) &&
    snapshot.sourceViews >= 0
  )
    item.sourceViews = snapshot.sourceViews;
  item.lines = [
    {
      id: "default",
      label: "默认",
      episodes: [
        { id: hid, title: "播放", watchUrl: watchUrl(module, hid), resolveOnPlayback: true },
      ],
    },
  ];
  return item;
}
async function readPublic(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    timeout: 10000,
  } as RequestInit);
  if (!response.ok) throw new Error("视频接口暂不可用");
  const body = await response.text();
  if (body.length > 2500000) throw new Error("视频数据过大");
  return JSON.parse(body);
}
export function createBikaVideoAdapter(read: Reader = readPublic) {
  return {
    async catalog(args: Args = {}) {
      const module = moduleFor(args.home),
        page = Number(args.page ?? 1),
        query = text(args.query, 300);
      if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw new Error("无效页码");
      if (module === "animate" && query) throw new Error("此来源暂不支持搜索");
      const url = new URL("/api/list", HOMES[module]);
      url.searchParams.set("page", String(page));
      url.searchParams.set("q", query);
      const result = object(await read(url.href));
      if (result.code !== 0 || !Array.isArray(result.list)) throw new Error("视频列表暂不可用");
      const items: MapValue[] = [];
      for (const row of result.list.slice(0, 100)) {
        try {
          items.push(normalizeRow(module, row));
        } catch {
          /* Skip a malformed row. */
        }
      }
      if (result.list.length && !items.length) throw new Error("视频列表格式已变化");
      const count = (v: unknown) => {
        if (
          (typeof v !== "number" && (typeof v !== "string" || !/^\d+$/.test(v))) ||
          !Number.isSafeInteger(Number(v)) ||
          Number(v) < 0
        )
          throw new Error("视频分页数据不可用");
        return Number(v);
      };
      return {
        source: SOURCE,
        data: {
          items,
          categories: [],
          page,
          pageCount: count(result.pageTotal),
          total: count(result.productTotal),
        },
      };
    },
    async detail(args: Args = {}) {
      const module = moduleFor(args.home);
      return { source: SOURCE, data: fromSnapshot(module, args) };
    },
    async playback(args: Args = {}) {
      const module = moduleFor(args.home),
        item = fromSnapshot(module, args),
        hid = idFor(module, args.id);
      if ((args.lineId && args.lineId !== "default") || (args.episodeId && args.episodeId !== hid))
        throw new Error("视频选集不可用");
      const url = new URL("/api/getVideoUrl", HOMES[module]);
      url.searchParams.set("hid", hid);
      const raw = object(await read(url.href));
      if (raw.code !== 0) throw new Error("播放地址暂不可用");
      const sources: MapValue[] = [],
        seen = new Set<string>();
      for (const key of ["url_hls_cdn", "url_hls", "url_cdn", "url"]) {
        const candidate = https(
          typeof raw[key] === "string"
            ? (raw[key] as string).replace(/^http:\/\//i, "https://")
            : "",
        );
        if (candidate && !seen.has(candidate)) {
          seen.add(candidate);
          sources.push({
            url: candidate,
            quality: key.includes("hls") ? "HLS" : "Auto",
            headers: {},
          });
        }
      }
      if (!sources.length) throw new Error("播放地址暂不可用");
      return {
        source: SOURCE,
        data: { item, lineId: "default", episodeId: hid, watchUrl: watchUrl(module, hid), sources },
      };
    },
  };
}
const adapter = createBikaVideoAdapter();
export const getBikaVideoCatalog = adapter.catalog;
export const getBikaVideoDetail = adapter.detail;
export const getBikaVideoPlayback = adapter.playback;
export function bikaVideoAction(home: string) {
  const module = moduleFor(home);
  return {
    type: "openVideoLibrary",
    payload: {
      source: SOURCE,
      title: module === "movie" ? "小電影" : "小里番",
      tabTitle: module === "movie" ? "电影" : "里番",
      url: HOMES[module],
      protocol: 2,
      nativeSearch: module === "movie",
      catalogFnPath: "getBikaVideoCatalog",
      detailFnPath: "getBikaVideoDetail",
      playbackFnPath: "getBikaVideoPlayback",
      capabilities: {
        search: module === "movie" ? "full" : "none",
        year: false,
        recent: false,
        sourceSort: false,
        filtersOnSearch: false,
        detailFromSnapshot: true,
        itemNamespace: module,
        ...(module === "animate" ? { posterAspectRatio: 4 / 3 } : {}),
      },
    },
  };
}
export function bikaVideoEntry(raw: unknown): ReturnType<typeof bikaVideoAction> | null {
  try {
    const u = new URL(String(raw));
    if (u.search || u.hash || u.username || u.password || u.pathname !== "/") return null;
    return bikaVideoAction(u.href);
  } catch {
    return null;
  }
}
