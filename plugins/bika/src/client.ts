import axios, { AxiosHeaders } from "axios";
import { buildUnauthorizedError, cache, hostRuntime } from "breeze-plugin-kit";
import { loadPluginSetting } from "./plugin-config";
import { BIKA_PLUGIN_ID } from "./info";
import { loadAppChannel, normalizeAppChannel } from "./bika-network";
import { assertBikaImageQuality, BikaImageQualityChangedError, loadBikaImageQuality, normalizeBikaImageQuality, type BikaImageQuality } from "./bika-image-quality";
import { isTransientError, RetryableRequestError } from "../../shared/transient-retry";
import { BikaAccountChangedError } from "./bika-auth-session";

export class BikaRequestError extends RetryableRequestError {
  constructor(message: string, retryable: boolean, readonly status?: number) {
    super(message, retryable);
    this.name = "BikaRequestError";
  }
}

type ClientPayload = {
  url?: string;
  method?: string;
  body?: unknown;
  cache?: boolean;
  imageQuality?: string;
  authorization?: string;
  settings?: {
    imageQuality?: string;
    authorization?: string;
  };
};

export { DEFAULT_API_BASE, BACKUP_API_BASE, API_BASE_CACHE_KEY } from "./bika-access-line-policy";
import { DEFAULT_API_BASE, BACKUP_API_BASE, API_BASE_CACHE_KEY,
  LINE_CONFIRMATION_KEY, lineBase } from "./bika-access-line-policy";

export class BikaAccessLineChangedError extends Error {
  constructor() { super("访问线路已更改，请重试"); this.name = "BikaAccessLineChangedError"; }
}
export async function captureBikaLine(): Promise<string> {
  return JSON.stringify([await loadPluginSetting("network.apiBase", DEFAULT_API_BASE),
    await loadPluginSetting(LINE_CONFIRMATION_KEY, null)]);
}
export async function assertBikaLine(snapshot: string): Promise<void> {
  if (await captureBikaLine() !== snapshot) throw new BikaAccessLineChangedError();
}

export let API_BASE = DEFAULT_API_BASE;
export const CACHE_KEY_PREFIX = "bikaComic:requestCache:";
const API_KEY = "C69BAF41DA5ABD1FFEDC6D2FEA56B";
const SECRET_KEY = "~d}$Q7$eIni=V)9\\RK/P.RM4;9[7|@/CA}b~OW!3?EV`:<>M7pddUBL5n|0/*Cn";
const CACHE_TTL_MS = 10 * 60 * 1000;

function normalizeApiBase(base: string): string {
  const value = String(base || "").trim();
  if (!value) return "";
  return value.endsWith("/") ? value : `${value}/`;
}

export function setApiBase(base: string) {
  const normalized = normalizeApiBase(base);
  API_BASE = normalized || DEFAULT_API_BASE;
  bikaClient.defaults.baseURL = API_BASE;
}

export async function getApiBase() {
  const cached = await cache.get(API_BASE_CACHE_KEY, DEFAULT_API_BASE).catch(() => DEFAULT_API_BASE);
  const raw = await loadPluginSetting("network.apiBase", cached);
  const normalized = lineBase(raw) ?? DEFAULT_API_BASE;
  const next = normalized || DEFAULT_API_BASE;
  if (API_BASE !== next) {
    API_BASE = next;
    bikaClient.defaults.baseURL = API_BASE;
  }
  return next;
}

type CacheEntry = {
  expireAt: number;
  data: unknown;
};

function toCacheStorageKey(cacheKey: string): string {
  return `${CACHE_KEY_PREFIX}${cacheKey}`;
}

function deepClone<T>(input: T): T {
  if (input === null || input === undefined) {
    return input;
  }
  return structuredClone(input);
}

export async function writeCache(cacheKey: string, data: unknown) {
  await cache.set(toCacheStorageKey(cacheKey), {
    expireAt: Date.now() + CACHE_TTL_MS,
    data: deepClone(data),
  } satisfies CacheEntry);
}

function isCacheEntry(v: unknown): v is CacheEntry {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  if (!("expireAt" in v)) return false;
  return typeof v.expireAt === "number";
}

export async function readCache(cacheKey: string): Promise<unknown | undefined> {
  const key = toCacheStorageKey(cacheKey);

  const entry = (await cache.get(key, undefined)) as CacheEntry | undefined;

  if (!entry) return undefined;
  if (!isCacheEntry(entry)) {
    await cache.delete(key);
    return undefined;
  }

  if (entry.expireAt <= Date.now()) {
    await cache.delete(key);
    return undefined;
  }

  return deepClone(entry.data);
}

function normalizeForKey(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) || "";
  } catch {
    return String(value);
  }
}

function normalizeRequestUrlForKey(url: unknown): string {
  const value = String(url || "").trim();
  if (!value) return "";
  return cleanPath(value);
}

export function buildCacheKey(payload: ClientPayload, method: string, channel = "3"): string {
  const authForKey = payload.authorization ?? payload.settings?.authorization;
  const qualityForKey = normalizeBikaImageQuality(payload.imageQuality ?? payload.settings?.imageQuality);
  const normalizedUrl = normalizeRequestUrlForKey(payload.url);
  const origin = new URL(String(payload.url || "/"), API_BASE).origin;
  const rawKey = `${origin}|${normalizeAppChannel(channel)}|${method}|${normalizedUrl}|${normalizeForKey(payload.body)}|${String(authForKey || "")}|${String(qualityForKey || "")}`;
  const digest = hostRuntime.crypto.createHash("sha256").update(rawKey).digest("hex") as string;
  // Older entries may have been written in the guest bucket by a signed request.
  return `v4:${digest}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function randomHex(len: number): string {
  let out = "";
  while (out.length < len) {
    out += hostRuntime.uuidv4().split("-").join("");
  }
  return out.slice(0, len);
}

function toUpperMethod(method: unknown): string {
  const value = String(method || "GET").trim();
  return (value || "GET").toUpperCase();
}

function cleanPath(input: string): string {
  const value = String(input || "").trim();
  if (!value) return "";

  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      return `${parsed.pathname}${parsed.search}`.replace(/^\/+/, "");
    } catch {
      // ignore parse error
    }
  }

  return value.replace(DEFAULT_API_BASE, "").replace(BACKUP_API_BASE, "").replace(/^\/+/, "");
}

function createSignature(path: string, timestamp: number, nonce: string, method: string): string {
  const raw = `${path}${timestamp}${nonce}${method}${API_KEY}`.toLowerCase();
  return hostRuntime.crypto.createHmac("sha256", SECRET_KEY).update(raw).digest("hex") as string;
}

export function safeBikaResponseMessage(raw: unknown, fallback: string, privateValues: string[] = []): string {
  const data = raw as { message?: unknown; errorMsg?: unknown } | null;
  const value = data?.message ?? data?.errorMsg;
  let message = typeof value === "string" ? value.trim() : "";
  const known: Record<string, string> = {
    "email or password not match": "账号或密码不匹配",
    "invalid email or password": "账号或密码不匹配",
    "under review": "审核中",
    "unauthorized": "账号验证失败，请重试",
  };
  if (known[message.toLowerCase()]) return known[message.toLowerCase()]!;
  for (const value of privateValues.filter(Boolean)) message = message.split(value).join("[已隐藏]");
  message = message.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[已隐藏]");
  return message && message.length <= 160 &&
    !/[\r\n]|https?:\/\/|(?:password|token|authorization|cookie)\s*[=:]|bearer\s+/i.test(message)
    ? message : fallback;
}

function mapNetworkError(err: unknown, retryable: boolean): string {
  const e = err as {
    code?: string;
    message?: string;
    config?: { data?: unknown; headers?: Record<string, unknown> };
    response?: {
      data?: { code?: number; message?: string; errorMsg?: string };
      status?: number;
    };
  };

  const data = e?.response?.data;
  let body: Record<string, unknown> = {};
  try { body = typeof e?.config?.data === "string" ? JSON.parse(e.config.data) : e?.config?.data as Record<string, unknown> ?? {}; } catch {}
  const privateValues = ["email", "password", "old_password", "new_password", "token"]
    .map((key) => typeof body?.[key] === "string" ? body[key] as string : "");
  privateValues.push(String(e?.config?.headers?.authorization ?? ""));
  const status = e?.response?.status;
  if (status === 408 || e?.code === "ECONNABORTED" || e?.code === "ETIMEDOUT") {
    return "连接哔咔超时，请重试";
  }
  if (status !== undefined && status >= 500) {
    return `哔咔服务暂时无法响应（HTTP ${status}）`;
  }
  if (status === 429) return "请求太频繁，请稍后重试（HTTP 429）";
  if (status === undefined && retryable) return "无法连接哔咔，请检查网络后重试";
  return safeBikaResponseMessage(data, status === undefined
    ? "请求失败，请稍后重试"
    : `请求失败（HTTP ${status}）`, privateValues);
}

export function isBikaUnauthorizedEnvelope(value: unknown): boolean {
  const payload = value as { code?: unknown; error?: unknown; message?: unknown } | null;
  return (payload?.code === 401 || payload?.code === "401") &&
    (payload.error === "1005" || payload.error === 1005) &&
    payload.message === "unauthorized";
}

const bikaClient = axios.create({
  timeout: 10_000,
  adapter: "fetch",
});

bikaClient.interceptors.request.use(async (config) => {
  const lineConfig = config as unknown as { __bikaLine?: string };
  const line = lineConfig.__bikaLine ?? await captureBikaLine();
  lineConfig.__bikaLine = line;
  await assertBikaLine(line);
  const method = toUpperMethod(config.method);
  const requestUrl = String(config.url || "");
  const [selectedBase, confirmation] = JSON.parse(line) as [string, { base?: string } | null];
  if (confirmation && (confirmation.base !== selectedBase ||
      new URL(requestUrl || "/", selectedBase).origin !== new URL(selectedBase).origin)) {
    throw new BikaAccessLineChangedError();
  }
  const nonce = randomHex(32);
  const timestamp = nowSeconds();
  const path = cleanPath(requestUrl);

  const qualitySnapshot = (config as unknown as { __bikaImageQuality?: BikaImageQuality }).__bikaImageQuality;
  const imageQuality = qualitySnapshot === undefined
    ? await loadBikaImageQuality()
    : normalizeBikaImageQuality(qualitySnapshot);
  (config as unknown as { __bikaImageQuality?: BikaImageQuality }).__bikaImageQuality = imageQuality;
  if (method === "GET") await assertBikaImageQuality(imageQuality);
  const authorization = String(await loadPluginSetting("auth.authorization", "")).trim();
  const pinnedAuthorization = (config as unknown as { __bikaAuthorization?: string }).__bikaAuthorization;
  if (pinnedAuthorization !== undefined && pinnedAuthorization !== authorization) {
    throw new BikaAccountChangedError();
  }
  const snapshot = (config as unknown as { __bikaChannel?: string }).__bikaChannel;
  const appChannel = snapshot == null ? await loadAppChannel() : normalizeAppChannel(snapshot);
  const headers = AxiosHeaders.from(config.headers);

  headers.set("api-key", API_KEY);
  headers.set("accept", "application/vnd.picacomic.com.v1+json");
  headers.set("app-channel", appChannel);
  headers.set("time", String(timestamp));
  headers.set("nonce", nonce);
  headers.set("signature", createSignature(path, timestamp, nonce, method));
  headers.set("app-version", "2.2.1.3.3.4");
  headers.set("app-uuid", "defaultUuid");
  headers.set("app-platform", "android");
  headers.set("app-build-version", "45");
  headers.set("accept-encoding", "gzip");
  headers.set("user-agent", "okhttp/3.8.1");
  headers.set("content-type", "application/json; charset=UTF-8");
  headers.set("image-quality", imageQuality);

  if (authorization.trim()) {
    headers.set("authorization", authorization);
  }

  config.method = method;
  config.headers = headers;
  if (pinnedAuthorization !== undefined &&
      String(await loadPluginSetting("auth.authorization", "")).trim() !== pinnedAuthorization) {
    throw new BikaAccountChangedError();
  }
  await (config as unknown as { __bikaAssertAuthorization?: () => Promise<void> }).__bikaAssertAuthorization?.();
  await assertBikaLine(line);
  return config;
});

bikaClient.interceptors.response.use(
  async (response) => {
    const cfg = response.config as {
      __bikaLine?: string;
      __bikaImageQuality?: BikaImageQuality;
      method?: string;
    };

    if (cfg.__bikaLine !== undefined) await assertBikaLine(cfg.__bikaLine);
    if (cfg.__bikaImageQuality !== undefined && toUpperMethod(cfg.method) === "GET") {
      await assertBikaImageQuality(cfg.__bikaImageQuality);
    }
    return response;
  },
  async (error: unknown) => {
    if (error instanceof BikaAccountChangedError || error instanceof BikaAccessLineChangedError || error instanceof BikaImageQualityChangedError) throw error;
    const pinnedLine = (error as { config?: { __bikaLine?: string } })?.config?.__bikaLine;
    if (pinnedLine !== undefined) await assertBikaLine(pinnedLine);
    const e = error as {
      code?: string;
      config?: { url?: string; __bikaRequireStructuredUnauthorized?: boolean };
      response?: {
        data?: { code?: number; message?: string; error?: string };
        status?: number;
      };
    };
    const data = e?.response?.data;
    const isLogin = cleanPath(String(e?.config?.url ?? "")).split("?")[0] === "auth/sign-in";
    if (!isLogin && (
      (e?.response?.status === 401 && !e?.config?.__bikaRequireStructuredUnauthorized) ||
      isBikaUnauthorizedEnvelope(data)
    )) {
      throw buildUnauthorizedError(BIKA_PLUGIN_ID, "登录过期，请重新登录");
    }

    // Axios errors retain config, headers and request bodies (including login
    // credentials). Only a safe message may cross the plugin/runtime boundary.
    const status = e?.response?.status;
    const retryable = e?.code !== "ERR_CANCELED" && (
      status === undefined ? isTransientError(error) : status === 408 || status === 429 || status >= 500
    );
    throw new BikaRequestError(mapNetworkError(error, retryable), retryable, status);
  },
);

export default bikaClient;
