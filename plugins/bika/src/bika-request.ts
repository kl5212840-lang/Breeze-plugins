import axios from "axios";
import { buildUnauthorizedError } from "breeze-plugin-kit";
import type { BikaRequestPayload } from "./bika-types";
import client, { buildCacheKey, readCache, writeCache, captureBikaLine, assertBikaLine } from "./client";
import { loadAppChannel } from "./bika-network";
import { assertBikaImageQuality, loadBikaImageQuality, normalizeBikaImageQuality } from "./bika-image-quality";
import { assertBikaAuthRevision, BikaAccountChangedError, currentBikaAuthRevision } from "./bika-auth-session";
import { loadPluginSetting } from "./plugin-config";
import { isTransientError } from "../../shared/transient-retry";
import { BIKA_PLUGIN_ID } from "./bika-identity";
import { toStringMap } from "./bika-utils";

function toUpperMethod(method: unknown): string {
  const value = String(method || "GET").trim();
  return (value || "GET").toUpperCase();
}

function assertReadResponse(response: unknown, arrayPath?: readonly string[]) {
  const envelope = toStringMap(response);
  const code = envelope.code == null ? 200 : Number(envelope.code);
  if (code === 401) throw buildUnauthorizedError(BIKA_PLUGIN_ID, "登录过期，请重新登录");
  if (code === 403) throw new Error("哔咔当前请求没有访问权限");
  if (code === 429) throw new Error("哔咔请求过于频繁（429）");
  if (code >= 500 && code <= 599) throw new Error("哔咔服务暂时无法响应");
  if (code !== 200 || !response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("哔咔返回的数据格式错误");
  }
  if (!arrayPath) return;
  let value = envelope.data;
  for (const field of arrayPath) value = toStringMap(value)[field];
  if (!Array.isArray(value)) throw new Error("哔咔返回的数据格式错误");
}

export async function bikaRequest(payload: BikaRequestPayload = { url: "" }) {
  const authRevision = currentBikaAuthRevision();
  const line = payload.lineSnapshot ?? await captureBikaLine();
  const imageQuality = payload.imageQuality === undefined
    ? await loadBikaImageQuality()
    : normalizeBikaImageQuality(payload.imageQuality);
  const method = toUpperMethod(payload.method);
  const useCache = Boolean(payload.cache && method === "GET");
  const loadAuthorization = async () => String(await loadPluginSetting("auth.authorization", "")).trim();
  const authorization = payload.authorization ?? (useCache ? await loadAuthorization() : undefined);
  const resolvedPayload: BikaRequestPayload = { ...payload, imageQuality, authorization };
  const assertCacheAuthorization = async () => {
    if (await loadAuthorization() !== authorization) throw new BikaAccountChangedError();
    assertBikaAuthRevision(authRevision);
  };
  if (method === "GET") await assertBikaImageQuality(imageQuality);
  // One immutable channel snapshot feeds both the cache and the wire request.
  const channel = payload.appChannel ?? await loadAppChannel();
  const cacheKey = useCache ? buildCacheKey(resolvedPayload, method, channel) : undefined;

  if (cacheKey && resolvedPayload.refresh !== true) {
    const cachedData = await readCache(cacheKey).catch(() => undefined);
    if (cachedData !== undefined) {
      let usable = true;
      try {
        assertReadResponse(cachedData, resolvedPayload.cacheArray);
      } catch {
        // Older clients could persist an HTTP 200 error or incomplete object.
        usable = false;
      }
      if (usable) {
        await assertBikaLine(line);
        await assertBikaImageQuality(imageQuality);
        await assertCacheAuthorization();
        return cachedData;
      }
    }
  }

  const requestConfig: Record<string, unknown> = {
    url: resolvedPayload.url,
    method,
    ...(resolvedPayload.timeoutMs !== undefined ? { timeout: resolvedPayload.timeoutMs } : {}),
    __bikaChannel: channel,
    __bikaImageQuality: imageQuality,
    __bikaLine: line,
    ...(resolvedPayload.lineSnapshot !== undefined ? { fetchOptions: { redirect: "error" } } : {}),
    ...(resolvedPayload.lineSnapshot !== undefined && method === "GET"
      ? { headers: { "Cache-Control": "no-cache" } } : {}),
    ...(resolvedPayload.authorization !== undefined ? { __bikaAuthorization: resolvedPayload.authorization } : {}),
    ...(resolvedPayload.assertAuthorization ? { __bikaAssertAuthorization: resolvedPayload.assertAuthorization } : {}),
    ...(resolvedPayload.requireStructuredUnauthorized ? { __bikaRequireStructuredUnauthorized: true } : {}),
  };

  if (method !== "GET" && method !== "HEAD") {
    const requestBody = resolvedPayload.body == null ? {} : resolvedPayload.body;
    requestConfig.data = requestBody;
    requestConfig.body =
      typeof requestBody === "string" ? requestBody : JSON.stringify(requestBody);
  }

  const response = await client.request(requestConfig);
  await assertBikaLine(line);
  if (method === "GET") await assertBikaImageQuality(imageQuality);
  if (cacheKey) {
    await assertCacheAuthorization();
    assertReadResponse(response.data, resolvedPayload.cacheArray);
    // Storage is optional. A correct remote result remains usable on disk error.
    await writeCache(cacheKey, response.data).catch(() => {});
  }
  return response.data;
}

function knownBikaCoverMirror(cover: URL): string | null {
  if (cover.origin !== "https://img.picacomic.com" || cover.username ||
      cover.password || cover.search || cover.hash) return null;
  const encoded = /^\/[A-Za-z0-9_-]{43}\/rs:fill:300:400:0\/g:sm\/([A-Za-z0-9_-]{1,200})\.jpg$/.exec(cover.pathname)?.[1];
  if (!encoded) return null;
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const source = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const asset = /^https:\/\/storage-b\.picacomic\.com(\/static\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.jpg)$/.exec(source)?.[1];
    return asset ? `https://storage-b.diwodiwo.xyz${asset}` : null;
  } catch {
    return null;
  }
}

function isCompleteBikaJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
    bytes[2] === 0xff && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
}

export async function fetchImageBytes({
  url = "",
  timeoutMs = 30000,
}: {
  url?: string;
  timeoutMs?: number;
} = {}) {
  const targetUrl = url.trim();
  if (!targetUrl) throw new Error("url 不能为空");

  const target = new URL(targetUrl);
  const mirror = knownBikaCoverMirror(target);
  const budget = Math.max(0, timeoutMs) || 30000;
  const started = Date.now();
  const requestImage = (imageUrl: string, timeout = budget, restricted = false) =>
    axios.get(imageUrl, {
      headers: { Host: new URL(imageUrl).host },
      timeout,
      responseType: "arraybuffer",
      validateStatus: () => true,
      ...(restricted && {
        withCredentials: false,
        maxRedirects: 0,
        fetchOptions: { redirect: "error" },
      }),
    });
  const requestKnownCoverMirror = async () => {
    const remaining = budget - (Date.now() - started);
    if (!mirror || remaining <= 0) return null;
    try {
      const response = await requestImage(mirror, Math.min(10000, remaining), true);
      const bytes = new Uint8Array(response.data);
      return response.status === 200 && isCompleteBikaJpeg(bytes) ? bytes : null;
    } catch {
      return null;
    }
  };

  let response;
  try {
    // Leave time for the known alternate on this exact cover URL format.
    const primaryTimeout = mirror ? Math.max(1, Math.min(6000, Math.floor(budget / 2))) : budget;
    response = await requestImage(targetUrl, primaryTimeout);
    // Some category art exists on Picacomic's image CDN but returns 404 on
    // the original-quality storage mirror. Do not retry unrelated hosts.
    if ((response.status === 404 || response.status === 422) &&
      ["s3.picacomic.com", "storage.diwodiwo.xyz"].includes(target.host)) {
      const fallback = new URL(targetUrl);
      fallback.host = "img.picacomic.com";
      response = await requestImage(fallback.toString());
    }
  } catch (error) {
    // Do not propagate an AxiosError carrying the full image URL and headers.
    if (isTransientError(error)) {
      const recovered = await requestKnownCoverMirror();
      if (recovered) return recovered;
      throw new Error("Image network request failed");
    }
    throw new Error("Unsupported image response");
  }
  if (response.status < 200 || response.status >= 300) {
    if ([403, 404, 408, 422, 500, 502, 503, 504].includes(response.status)) {
      const recovered = await requestKnownCoverMirror();
      if (recovered) return recovered;
    }
    throw new Error(`图片请求失败（HTTP ${response.status}）`);
  }
  return new Uint8Array(response.data);
}
