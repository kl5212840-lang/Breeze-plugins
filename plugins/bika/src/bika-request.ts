import axios from "axios";
import type { BikaRequestPayload } from "./bika-types";
import client, { buildCacheKey, readCache } from "./client";

function toUpperMethod(method: unknown): string {
  const value = String(method || "GET").trim();
  return (value || "GET").toUpperCase();
}

export async function bikaRequest(payload: BikaRequestPayload = { url: "" }) {
  const resolvedPayload: BikaRequestPayload = {
    ...payload,
  };
  const method = toUpperMethod(resolvedPayload.method);
  const useCache = Boolean(resolvedPayload.cache && method === "GET");
  const cacheKey = buildCacheKey(resolvedPayload, method);

  if (useCache) {
    const cachedData = await readCache(cacheKey);
    if (cachedData !== undefined) {
      return cachedData;
    }
  }

  const requestConfig: Record<string, unknown> = {
    url: resolvedPayload.url,
    method,
    __bikaPayload: resolvedPayload,
    __useCache: useCache,
    __cacheKey: cacheKey,
  };

  if (method !== "GET" && method !== "HEAD") {
    const requestBody = resolvedPayload.body == null ? {} : resolvedPayload.body;
    requestConfig.data = requestBody;
    requestConfig.body =
      typeof requestBody === "string" ? requestBody : JSON.stringify(requestBody);
  }

  const response = await client.request(requestConfig);
  return response.data;
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

  const { host } = new URL(targetUrl);
  const requestImage = async (imageUrl: string) => {
    const imageHost = new URL(imageUrl).host;
    const response = await axios.get(imageUrl, {
      headers: { Host: imageHost },
      timeout: Math.max(0, timeoutMs) || 30000,
      responseType: "arraybuffer",
    });
    return new Uint8Array(response.data);
  };

  try {
    return await requestImage(targetUrl);
  } catch (error) {
    // Some category art exists on Picacomic's image CDN but returns 404 on
    // the original-quality storage mirror. Do not retry unrelated hosts.
    const status = axios.isAxiosError(error) ? error.response?.status : null;
    if ((status === 404 || status === 422) &&
        ["s3.picacomic.com", "storage.diwodiwo.xyz"].includes(host)) {
      const fallback = new URL(targetUrl);
      fallback.host = "img.picacomic.com";
      return requestImage(fallback.toString());
    }
    // Do not propagate an AxiosError carrying the full image URL and headers.
    throw new Error("图片请求失败，请稍后重试");
  }
}
