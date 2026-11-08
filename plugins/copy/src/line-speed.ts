export const COPY_SPEED_KEY = "network.speed.v1";
export type RouteProbe = {
  choice: string;
  host: string;
  ok: boolean;
  ms: number | null;
  status: number | null;
};
export type SpeedContext = { choice: string; platform: string };
type SpeedState = {
  version: 1;
  revision: string;
  measuredAt: number;
  context: SpeedContext;
  results: RouteProbe[];
};
export type SpeedStore = { load(): Promise<unknown>; save(value: string): Promise<void> };
export type SpeedResult = {
  ok: boolean;
  stale: boolean;
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

/** The fallback platform argument is source metadata, not an account or proxy.
 * This probe intentionally never calls the authenticated Copy API helpers. */
export async function probeCopyRoute(
  choice: string,
  base: string,
  platform: string,
  options: {
    fetch?: typeof fetch;
    now?: () => number;
    timeoutMs?: number;
    headers?: Record<string, string>;
  } = {},
): Promise<RouteProbe> {
  const url = new URL(`${base}/comics`);
  url.search = new URLSearchParams({
    limit: "1",
    offset: "0",
    free_type: "1",
    platform,
  }).toString();
  const host = url.hostname,
    now =
      options.now ?? (() => (typeof performance === "undefined" ? Date.now() : performance.now())),
    started = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 6000);
  let status: number | null = null;
  try {
    const response = await (options.fetch ?? globalThis.fetch)(
      new Request(url, {
        method: "GET",
        credentials: "omit",
        redirect: "error",
        signal: controller.signal,
        headers: options.headers ?? {
          Accept: "application/json",
          version: "2025.05.09",
          Origin: "https://2025copy.com",
          region: "0",
          webp: "0",
          ...(platform ? { platform } : {}),
        },
      }),
    );
    status = response.status;
    if (
      !response.ok ||
      response.redirected ||
      (response.url && new URL(response.url).origin !== url.origin)
    )
      throw new Error("invalid response");
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > 512 * 1024) throw new Error("oversized response");
    const text = await response.text();
    if (text.length > 512 * 1024 || controller.signal.aborted) throw new Error("invalid response");
    const data = object(JSON.parse(text)),
      result = object(data.results);
    const list = result.list;
    // HTTP 200/login pages/empty objects are not proof of a usable content API.
    if (
      Number(data.code) !== 200 ||
      !Array.isArray(list) ||
      list.length < 1 ||
      list.length > 50 ||
      !Number.isInteger(result.total) ||
      Number(result.total) < list.length ||
      !list.every((entry) => {
        const comic = object(entry);
        return (
          typeof comic.path_word === "string" &&
          /^[A-Za-z0-9_-]{1,200}$/.test(comic.path_word) &&
          typeof comic.name === "string" &&
          comic.name.trim().length > 0 &&
          comic.name.length <= 500
        );
      })
    )
      throw new Error("invalid content");
    return { choice, host, ok: true, ms: Math.max(0, Math.round(now() - started)), status };
  } catch {
    return { choice, host, ok: false, ms: null, status };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
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
  private same(a: SpeedContext, b: SpeedContext) {
    return a.choice === b.choice && a.platform === b.platform;
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
      !Object.prototype.hasOwnProperty.call(this.options.bases, context.choice) ||
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
      revision: state.revision,
      measuredAt: state.measuredAt,
      context: { choice: context.choice, platform: context.platform },
      results,
    };
  }
  async snapshot() {
    const state = await this.read();
    return state == null
      ? null
      : { ...state, stale: !this.same(state.context, await this.options.context()) };
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
      !this.same(context, await this.options.context()) ||
      (await this.read())?.revision !== before?.revision;
    if (!stale) {
      const state: SpeedState = {
        version: 1,
        revision: `${measuredAt}-${Math.random().toString(36).slice(2, 14)}`,
        measuredAt,
        context,
        results: complete,
      };
      await this.options.store.save(JSON.stringify(state));
      const saved = await this.read();
      if (JSON.stringify(saved) !== JSON.stringify(state))
        throw new Error("线路测试记录未保存，请重试。");
      stale = !current() || !this.same(context, await this.options.context());
    }
    const available = complete.filter((row) => row.ok).length;
    return {
      ok: !stale && available > 0,
      stale,
      measuredAt,
      results: complete,
      message: stale
        ? "线路选择或请求标识已变化，本次结果未应用。"
        : `测试完成：${available} 条可用，${complete.length - available} 条失败。`,
    };
  }
}
