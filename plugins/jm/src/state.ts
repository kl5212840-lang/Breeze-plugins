import { Config } from "./constants";
import { cache, pluginConfig } from "breeze-plugin-kit";
import type { CacheKeyConfig } from "./types";
import { randomDeviceId } from "./utils";

let fallbackDeviceId = "";
let fallbackJwt = "";
let fallbackUa = "";
let sessionRevision = 0;
let sessionWrites = Promise.resolve();

export class SessionChangedError extends Error {
  constructor() {
    super("会话已变更，请重新操作");
    this.name = "SessionChangedError";
  }
}

export function currentSessionRevision() {
  return sessionRevision;
}

export function assertCurrentSession(revision: number) {
  if (revision !== sessionRevision) throw new SessionChangedError();
}

export async function waitForSessionWrites(revision: number) {
  await sessionWrites;
  assertCurrentSession(revision);
}

function writeSession(revision: number, write: () => Promise<void>) {
  const task = sessionWrites.then(async () => {
    assertCurrentSession(revision);
    await write();
    assertCurrentSession(revision);
  });
  sessionWrites = task.catch(() => {});
  return task;
}

export function saveSessionValues(
  revision: number,
  values: Record<string, unknown>,
) {
  return writeSession(revision, async () => {
    await Promise.all(Object.entries(values).map(([key, value]) =>
      pluginConfig.save(key, JSON.stringify(value)),
    ));
  });
}

export function clearSession() {
  const revision = ++sessionRevision;
  fallbackJwt = "";
  // Queue clearing after any already-started write. Late responses retain
  // their old revision and cannot restore either settings or the cached JWT.
  return writeSession(revision, async () => {
    await Promise.all([
      cacheDelete(scopedKey("jwt")),
      ...Object.entries({
        "auth.account": "",
        "auth.password": "",
        "auth.jwt": "",
        "auth.userInfo": {},
      }).map(([key, value]) => pluginConfig.save(key, JSON.stringify(value))),
    ]);
  });
}

type RuntimeEndpointCache = {
  apiBaseUrl: string;
  imageBaseUrl: string;
  /** 备用图片线路（img_host 之后的内置域名池），可选以兼容旧缓存 */
  imageBaseUrls?: string[];
  hostPool: string[];
  updatedAt: number;
};

async function cacheSet(key: string, value: unknown) {
  await cache.set(key, value);
}

async function cacheDelete(key: string) {
  await cache.delete(key);
}

function scopedKey(key: string): string {
  const raw = String(key || "").trim();
  return `${Config.JM_CACHE_SCOPE}::${raw}`;
}

async function getCachedString(key: string) {
  const value = await cache.get<unknown>(scopedKey(key), null);
  return normalizedString(value);
}

function normalizedString(value: unknown) {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text === "null" || text === "undefined" ? "" : text;
}

async function setCachedString(key: string, value: string) {
  await cacheSet(scopedKey(key), value);
}

export async function getDeviceId() {
  const cached = await getCachedString("device");
  if (cached) {
    fallbackDeviceId = cached;
    return cached;
  }

  if (!fallbackDeviceId) {
    fallbackDeviceId = randomDeviceId();
  }
  await setCachedString("device", fallbackDeviceId);
  return fallbackDeviceId;
}

export async function getJwtToken(revision = currentSessionRevision()) {
  await waitForSessionWrites(revision);
  const cached = await getCachedString("jwt");
  assertCurrentSession(revision);
  if (cached) {
    fallbackJwt = cached;
    return cached;
  }
  return fallbackJwt;
}

export function setJwtToken(token: string, revision = currentSessionRevision()) {
  return writeSession(revision, async () => {
    const normalized = normalizedString(token);
    fallbackJwt = normalized;
    await setCachedString("jwt", normalized);
  });
}

function generateAndroidUserAgent(deviceId: string) {
  const androidVersions = ["10", "11", "12", "13", "14", "15"];
  const chromeVersions = [
    "114.0.5735.196",
    "116.0.5845.172",
    "118.0.5993.111",
    "119.0.6045.194",
    "120.0.6099.230",
    "121.0.6167.178",
    "122.0.6261.119",
    "123.0.6312.118",
    "124.0.6367.179",
    "125.0.6422.165",
  ];
  const buildCodes = [
    "TQ1A.230305.002",
    "UP1A.231005.007",
    "UQ1A.240205.002",
    "AP1A.240405.002",
  ];

  const android =
    androidVersions[Math.floor(Math.random() * androidVersions.length)] || "13";
  const chrome =
    chromeVersions[Math.floor(Math.random() * chromeVersions.length)] ||
    "120.0.6099.230";
  const build =
    buildCodes[Math.floor(Math.random() * buildCodes.length)] ||
    "TQ1A.230305.002";

  return `Mozilla/5.0 (Linux; Android ${android}; ${deviceId} Build/${build}; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/${chrome} Mobile Safari/537.36`;
}

export async function getUserAgent() {
  if (fallbackUa) return fallbackUa;

  const cached = await getCachedString("ua");
  if (cached) {
    fallbackUa = cached;
    return cached;
  }

  const ua = generateAndroidUserAgent(await getDeviceId());
  fallbackUa = ua;
  await setCachedString("ua", ua);
  return ua;
}

export function cacheKeyFromConfig(config: CacheKeyConfig): string {
  const q = config.params ? JSON.stringify(config.params) : "";
  const body =
    config.data === undefined || config.data === null
      ? ""
      : String(config.data);
  return `${config.method}|${config.url}|${q}|${body}`;
}

export async function getCachedResponse(config: CacheKeyConfig) {
  const key = cacheKeyFromConfig(config);
  const storeKey = scopedKey(`resp:${key}`);
  const raw = (await cache.get(storeKey, null)) as {
    expireAt?: number;
    value?: unknown;
  } | null;

  if (!raw || typeof raw !== "object") return null;

  const expireAt = Number(raw.expireAt || 0);
  if (!Number.isFinite(expireAt) || Date.now() > expireAt) {
    await cacheDelete(storeKey);
    return null;
  }

  return raw.value ?? null;
}

export async function setCachedResponse(
  config: CacheKeyConfig,
  value: unknown,
) {
  const key = cacheKeyFromConfig(config);
  try {
    await cacheSet(scopedKey(`resp:${key}`), {
      expireAt: Date.now() + 10 * 60 * 1000,
      value,
    });
  } catch (err) {
    console.warn("[jm.cache] save failed");
  }
}

export async function getRuntimeEndpointCache(
  ttlMs = 30 * 60 * 1000,
): Promise<RuntimeEndpointCache | null> {
  const raw = (await cache.get(
    scopedKey("runtime:endpoints"),
    null,
  )) as RuntimeEndpointCache | null;
  if (!raw || typeof raw !== "object") return null;

  const apiBaseUrl = String(raw.apiBaseUrl || "").trim();
  const imageBaseUrl = String(raw.imageBaseUrl || "").trim();
  const imageBaseUrls = Array.isArray(raw.imageBaseUrls)
    ? raw.imageBaseUrls.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const hostPool = Array.isArray(raw.hostPool)
    ? raw.hostPool.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const updatedAt = Number(raw.updatedAt || 0);

  if (!apiBaseUrl || !imageBaseUrl || !Number.isFinite(updatedAt)) return null;
  if (Date.now() - updatedAt > ttlMs) return null;

  return { apiBaseUrl, imageBaseUrl, imageBaseUrls, hostPool, updatedAt };
}

export async function setRuntimeEndpointCache(input: {
  apiBaseUrl: string;
  imageBaseUrl: string;
  imageBaseUrls?: string[];
  hostPool: string[];
}) {
  await cacheSet(scopedKey("runtime:endpoints"), {
    apiBaseUrl: String(input.apiBaseUrl || "").trim(),
    imageBaseUrl: String(input.imageBaseUrl || "").trim(),
    imageBaseUrls: Array.isArray(input.imageBaseUrls)
      ? input.imageBaseUrls
          .map((item) => String(item || "").trim())
          .filter(Boolean)
      : [],
    hostPool: Array.isArray(input.hostPool)
      ? input.hostPool.map((item) => String(item || "").trim()).filter(Boolean)
      : [],
    updatedAt: Date.now(),
  });
}

export type EndpointSpeedRecord = {
  url: string;
  ok: boolean;
  ms: number | null;
  status: number | null;
  checkedAt: number;
};

export type EndpointSpeedCache = {
  measuredAt: number;
  image: EndpointSpeedRecord[];
  api: EndpointSpeedRecord[];
};

function parsePluginConfigValue(raw: unknown): unknown {
  try {
    const decoded = JSON.parse(String(raw));
    if (decoded && typeof decoded === "object" && decoded.ok === true) {
      return decoded.value;
    }
  } catch {
    // noop
  }
  return null;
}

export async function getEndpointSpeedCache(): Promise<EndpointSpeedCache | null> {
  const value = parsePluginConfigValue(
    await pluginConfig.load("network.speed", ""),
  );
  if (!value || typeof value !== "object") return null;

  const raw = value as Partial<EndpointSpeedCache>;
  const measuredAt = Number(raw.measuredAt || 0);
  if (!Number.isFinite(measuredAt) || measuredAt <= 0) return null;

  const toRecords = (input: unknown): EndpointSpeedRecord[] =>
    Array.isArray(input)
      ? input
          .map((item) => {
            const entry = (item ?? {}) as Partial<EndpointSpeedRecord>;
            const url = String(entry.url || "").trim();
            if (!url) return null;
            const ms = Number(entry.ms);
            const status = Number(entry.status);
            return {
              url,
              ok: entry.ok === true,
              ms: Number.isFinite(ms) ? ms : null,
              status: Number.isFinite(status) ? status : null,
              checkedAt: Number(entry.checkedAt || 0) || measuredAt,
            } satisfies EndpointSpeedRecord;
          })
          .filter((item): item is EndpointSpeedRecord => item !== null)
      : [];

  return {
    measuredAt,
    image: toRecords(raw.image),
    api: toRecords(raw.api),
  };
}

export async function setEndpointSpeedCache(
  input: Omit<EndpointSpeedCache, "measuredAt"> & { measuredAt?: number },
) {
  await pluginConfig.save(
    "network.speed",
    JSON.stringify({
      measuredAt: Number(input.measuredAt || Date.now()),
      image: Array.isArray(input.image) ? input.image : [],
      api: Array.isArray(input.api) ? input.api : [],
    }),
  );
}
