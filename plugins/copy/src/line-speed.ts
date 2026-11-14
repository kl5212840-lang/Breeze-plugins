import { normalizeCopyComicRow } from "./catalog";
import {
  CopyFollowError, copyChapterGroupUrl, copyChapterProbeGroup, readCopyPublicApi,
  readCopyPublicDetail, type CopyPublicRequest,
} from "./follow-metadata";
import type { ChapterApiData } from "./types";

export const COPY_SPEED_KEY = "network.speed.v1";
export const COPY_AUTO_CHOICE = "auto";
export type ProbeResult = {
  ok: boolean;
  ms: number | null;
  status: number | null;
};
export type RouteProbe = ProbeResult & {
  choice: string;
  host: string;
  account?: ProbeResult;
  failedAt?: "directory" | "detail" | "chapters";
};
const PROBE_VERSION = 4;
const ACCOUNT_PROBE_VERSIONS = new Set([2, 3, PROBE_VERSION]);
const SPEED_TTL_MS = 20 * 60_000;
const routeProbeBudgetMs = 6500;
const qualifiedRouteLimitMs = 8500;
const qualifiedReadingWindowMs = 5500;
export type SpeedContext = { choice: string; platform: string };
type SpeedState = {
  version: 1;
  probeVersion?: number;
  revision: string;
  measuredAt: number;
  context: SpeedContext;
  results: RouteProbe[];
};
export type SpeedStore = { load(): Promise<unknown>; save(value: string): Promise<void> };
export type SpeedResult = {
  ok: boolean;
  stale: boolean;
  revision: string | null;
  measuredAt: number;
  results: RouteProbe[];
  message: string;
};

function unbox(value: unknown): unknown {
  if (value && typeof value === "object" && "value" in value)
    return unbox((value as { value: unknown }).value);
  if (typeof value === "string") {
    try {
      return unbox(JSON.parse(value));
    } catch {
      return value;
    }
  }
  return value;
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

type ProbeOptions = {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

const maxBodyBytes = 512 * 1024;

async function probeCopyJson(
  urls: URL[],
  headers: Record<string, string>,
  options: ProbeOptions,
  validate: (data: Record<string, unknown>, response: Response) => boolean,
  method = "GET",
): Promise<ProbeResult> {
  const now =
    options.now ?? (() => (typeof performance === "undefined" ? Date.now() : performance.now()));
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (options.signal?.aborted) cancel();
  options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 6000);
  let status: number | null = null;
  try {
    for (const url of urls) {
      const started = now();
      const response = await (options.fetch ?? globalThis.fetch)(new Request(url, {
        method,
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
        headers,
      }));
      status = response.status;
      if (response.redirected || (response.url && new URL(response.url).origin !== url.origin)) break;
      if (status === 429 || status >= 500) break;
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > maxBodyBytes) break;
      const text = await response.text();
      if (text.length > maxBodyBytes || controller.signal.aborted) break;
      let data: unknown;
      try { data = JSON.parse(text); } catch {}
      if (validate(object(data), response)) {
        return { ok: true, ms: Math.max(0, Math.round(now() - started)), status };
      }
    }
  } catch {
    // No useful response was obtained within the shared deadline.
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    cancel();
  }
  return { ok: false, ms: null, status };
}

/** Qualify the directory and rank the successful detail and first chapter page. */
export async function probeCopyRoute(
  choice: string,
  base: string,
  platform: string,
  options: ProbeOptions & Pick<CopyPublicRequest, "appHeaders" | "isAppGate"> & { tryNewest?: boolean } = {},
): Promise<RouteProbe> {
  const directory = new URL(`${base}/comics`);
  directory.search = new URLSearchParams({ limit: "2", offset: "0", free_type: "1", platform }).toString();
  const urls = [directory];
  if (options.tryNewest) {
    const newest = new URL(`${base}/update/newest`);
    newest.search = new URLSearchParams({ limit: "2", offset: "0", platform: "3" }).toString();
    urls.unshift(newest);
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (options.signal?.aborted) cancel();
  options.signal?.addEventListener("abort", cancel, { once: true });
  const now = options.now ?? (() => (typeof performance === "undefined" ? Date.now() : performance.now()));
  const probeStarted = now();
  let timer = setTimeout(cancel, options.timeoutMs ?? routeProbeBudgetMs);
  let hasReadingWindow = false;
  const request: CopyPublicRequest = {
    headers: options.headers ?? {
      Accept: "application/json",
      version: "2025.05.09",
      Origin: "https://2025copy.com",
      region: "0",
      webp: "0",
      ...(platform ? { platform } : {}),
    },
    ...(options.appHeaders ? { appHeaders: options.appHeaders } : {}),
    ...(options.isAppGate ? { isAppGate: options.isAppGate } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    signal: controller.signal,
  };
  const route = { choice, host: directory.hostname };
  const { appHeaders, ...withoutFallback } = request;
  const appRequest = appHeaders ? { ...withoutFallback, headers: appHeaders } : request;
  const sampled = new Set<string>();
  let failure: Pick<RouteProbe, "failedAt" | "status"> = { failedAt: "directory", status: null };
  function record(stage: NonNullable<RouteProbe["failedAt"]>, status: number | null) {
    const stages = ["directory", "detail", "chapters"] as const;
    if (stages.indexOf(stage) >= stages.indexOf(failure.failedAt!)) failure = { failedAt: stage, status };
  }
  try {
    for (const url of urls) {
      if (controller.signal.aborted || sampled.size >= 2) break;
      let comicIds: string[];
      try {
        const { data, status } = await readCopyPublicApi(url, request);
        record("directory", status);
        const result = object(data.results);
        const list = result.list;
        if (!Array.isArray(list) || list.length < 1 || list.length > 50 ||
            (result.total != null && (!Number.isSafeInteger(Number(result.total)) || Number(result.total) < list.length))) continue;
        comicIds = list.flatMap((entry) => {
          const comic = normalizeCopyComicRow(entry);
          return typeof comic?.path_word === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(comic.path_word) &&
            typeof comic.name === "string" && comic.name.trim() ? [comic.path_word] : [];
        });
      } catch (error) {
        if (error instanceof CopyFollowError) {
          record("directory", error.status);
          if (!error.retryable) break;
        }
        continue;
      }
      if (!hasReadingWindow && comicIds.length && !controller.signal.aborted) {
        hasReadingWindow = true;
        // Slow discovery should leave time for a real reading sample. Only a
        // qualified directory can extend the deadline, once and up to the cap.
        if (options.timeoutMs === undefined) {
          const elapsed = Math.max(0, now() - probeStarted);
          const totalBudget = Math.min(qualifiedRouteLimitMs,
            Math.max(routeProbeBudgetMs, elapsed + qualifiedReadingWindowMs));
          if (totalBudget > routeProbeBudgetMs) {
            clearTimeout(timer);
            timer = setTimeout(cancel, Math.max(0, totalBudget - elapsed));
          }
        }
      }
      for (const comicId of comicIds) {
        if (controller.signal.aborted || sampled.size >= 2) break;
        if (sampled.has(comicId)) continue;
        sampled.add(comicId);
        let stage: "detail" | "chapters" = "detail";
        // Match a fresh detail load, including any App-profile negotiation.
        // Directory discovery and failed works are availability checks only.
        const started = now();
        try {
          const { detail, status, usedApp } = await readCopyPublicDetail(base, comicId, request, { requireSummary: true });
          const group = copyChapterProbeGroup(detail.results);
          record(stage, status);
          if (!group) continue;
          stage = "chapters";
          const { data, status: chapterStatus } = await readCopyPublicApi<ChapterApiData>(
            copyChapterGroupUrl(base, comicId, group, 0, 1), usedApp ? appRequest : request,
          );
          record(stage, chapterStatus);
          const rows = data.results?.list;
          if (!Array.isArray(rows) || rows.length === 0) continue;
          const first = rows[0];
          const total = data.results?.total, offset = data.results?.offset;
          if (!first || typeof first.uuid !== "string" || !first.uuid.trim() ||
              (total != null && (!Number.isSafeInteger(Number(total)) || Number(total) < rows.length)) ||
              (offset != null && Number(offset) !== 0) ||
              (first.comic_path_word != null && first.comic_path_word !== comicId)) continue;
          return { ...route, ok: true, ms: Math.max(0, Math.round(now() - started)), status: chapterStatus };
        } catch (error) {
          if (error instanceof CopyFollowError) {
            record(stage, error.status);
            if (!error.retryable && error.reason === "sourceUnavailable" && !error.restricted) {
              return { ...route, ok: false, ms: null, ...failure };
            }
          }
        }
      }
    }
    return { ...route, ok: false, ms: null, ...failure };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    cancel();
  }
}

/** A Copy-style anonymous challenge proves the account endpoint answered. */
export function probeCopyAccount(base: string, options: ProbeOptions): Promise<ProbeResult> {
  return probeCopyJson(
    [new URL(`${base}/member/info?platform=1`)],
    options.headers ?? {},
    options,
    (data, response) => (response.ok || response.status === 401) && Number(data.code) === 401,
  );
}

/** The app API advertises its login method without receiving any credentials. */
export function probeCopyLogin(base: string, options: ProbeOptions): Promise<ProbeResult> {
  return probeCopyJson(
    [new URL(`${base}/login`)],
    options.headers ?? {},
    options,
    (_data, response) => (response.ok || response.status === 405) &&
      (response.headers.get("allow") ?? "").split(",").some((value) => value.trim().toUpperCase() === "POST"),
    "OPTIONS",
  );
}

/** Only measurements are persisted. This class cannot select or change a route. */
export class CopyLineSpeedTest {
  private epoch = 0;
  private flight: Promise<SpeedResult> | null = null;
  constructor(
    private readonly options: {
      bases: Readonly<Record<string, string>>;
      store: SpeedStore;
      context(): Promise<SpeedContext>;
      probe?: (choice: string, base: string, platform: string) => Promise<RouteProbe>;
      now?: () => number;
      current?: () => boolean;
    },
  ) {}
  invalidate() {
    this.epoch++;
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }
  private sameRequest(a: SpeedContext, b: SpeedContext) {
    return a.platform === b.platform;
  }
  private async read(): Promise<SpeedState | null> {
    const raw = unbox(await this.options.store.load());
    if (raw == null || raw === "") return null;
    const state = object(raw),
      context = object(state.context);
    if (state.version !== 1) throw new Error("线路测试记录版本不兼容，请更新插件。");
    if (
      typeof state.revision !== "string" ||
      typeof context.choice !== "string" ||
      (context.choice !== COPY_AUTO_CHOICE &&
        !Object.prototype.hasOwnProperty.call(this.options.bases, context.choice)) ||
      typeof context.platform !== "string" ||
      typeof state.measuredAt !== "number" ||
      !Number.isFinite(state.measuredAt) ||
      state.measuredAt <= 0 ||
      !Array.isArray(state.results) ||
      state.results.length > Object.keys(this.options.bases).length
    ) {
      throw new Error("线路测试记录无法读取，请重新测试。");
    }
    const results: RouteProbe[] = [];
    for (const entry of state.results) {
      const row = object(entry),
        choice = row.choice;
      if (
        typeof choice !== "string" ||
        !Object.prototype.hasOwnProperty.call(this.options.bases, choice) ||
        row.host !== new URL(this.options.bases[choice]!).hostname ||
        typeof row.ok !== "boolean" ||
        (row.ok &&
          (typeof row.ms !== "number" ||
            !Number.isFinite(row.ms) ||
            row.ms < 0 ||
            row.ms > 60000)) ||
        (!row.ok && row.ms !== null)
      )
        throw new Error("线路测试记录无法读取，请重新测试。");
      results.push(row as unknown as RouteProbe);
    }
    return {
      version: 1,
      ...(typeof state.probeVersion === "number" ? { probeVersion: state.probeVersion } : {}),
      revision: state.revision,
      measuredAt: state.measuredAt,
      context: { choice: context.choice, platform: context.platform },
      results,
    };
  }
  async snapshot() {
    const state = await this.read();
    const now = this.now();
    const expired = state != null && (now < state.measuredAt || now - state.measuredAt > SPEED_TTL_MS);
    return state == null
      ? null
      : {
          ...state,
          stale: state.probeVersion !== PROBE_VERSION ||
            !this.sameRequest(state.context, await this.options.context()) ||
            expired,
          accountStale: expired || !ACCOUNT_PROBE_VERSIONS.has(state.probeVersion ?? 0),
        };
  }
  measure(): Promise<SpeedResult> {
    if (this.flight) return this.flight;
    const result = this.run();
    this.flight = result;
    result.then(
      () => {
        if (this.flight === result) this.flight = null;
      },
      () => {
        if (this.flight === result) this.flight = null;
      },
    );
    return result;
  }
  private async run(): Promise<SpeedResult> {
    const epoch = this.epoch,
      before = await this.read(),
      context = await this.options.context();
    const current = () => epoch === this.epoch && this.options.current?.() !== false;
    const choices = Object.keys(this.options.bases);
    const results = new Array<RouteProbe>(choices.length);
    let cursor = 0;
    const probe = this.options.probe ?? probeCopyRoute;
    await Promise.all(
      Array.from({ length: Math.min(3, choices.length) }, async () => {
        while (cursor < choices.length && current()) {
          const index = cursor++,
            choice = choices[index]!;
          results[index] = await probe(choice, this.options.bases[choice]!, context.platform);
        }
      }),
    );
    const measuredAt = this.now(),
      complete = results.filter(Boolean);
    let stale =
      !current() ||
      !this.sameRequest(context, await this.options.context()) ||
      (await this.read())?.revision !== before?.revision;
    let revision: string | null = null;
    if (!stale) {
      const state: SpeedState = {
        version: 1,
        probeVersion: PROBE_VERSION,
        revision: `${measuredAt}-${Math.random().toString(36).slice(2, 14)}`,
        measuredAt,
        context,
        results: complete,
      };
      await this.options.store.save(JSON.stringify(state));
      const saved = await this.read();
      if (JSON.stringify(saved) !== JSON.stringify(state))
        throw new Error("线路测试记录未保存，请重试。");
      stale = !current() || !this.sameRequest(context, await this.options.context());
      revision = state.revision;
    }
    const available = complete.filter((row) => row.ok).length;
    return {
      ok: !stale && available > 0,
      stale,
      revision,
      measuredAt,
      results: complete,
      message: stale
        ? "线路选择或请求标识已变化，本次结果未应用。"
        : `阅读测速：${available} 条通过目录、详情及章节验证，${complete.length - available} 条未通过。`,
    };
  }
}
