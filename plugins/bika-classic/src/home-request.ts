import { cache } from "breeze-plugin-kit";
import client, { buildCacheKey, CACHE_KEY_PREFIX, readCache } from "../../bika/src/client";
import { loadAppChannel } from "../../bika/src/bika-network";
import { assertBikaAuthRevision } from "../../bika/src/bika-auth-session";
import type { HomeContext } from "./home-feed";

type Request = { url: string; method: "GET" | "POST"; body?: unknown; cache: boolean };

export async function requestHomeFeed(context: HomeContext, payload: Request) {
  const channel = await loadAppChannel();
  assertBikaAuthRevision(context.revision);
  if (channel !== context.channel) throw new Error("浏览条件已变化，请重试");
  const useCache = payload.cache && payload.method === "GET";
  const request = { ...payload, authorization: context.authorization };
  const cacheKey = buildCacheKey(request, payload.method, channel);
  const storageKey = useCache ? `${CACHE_KEY_PREFIX}${cacheKey}` : null;
  if (useCache) {
    const cached = await readCache(cacheKey);
    if (cached !== undefined) return { data: cached, storageKey };
  }
  // Same internal transport/cache fields as bikaRequest. Axios fetch uses only
  // its explicit HTTP options; these fields never enter request data/headers.
  const config: Record<string, unknown> = {
    url: payload.url,
    method: payload.method,
    __bikaChannel: channel,
    __useCache: useCache,
    __cacheKey: cacheKey,
    __bikaAuthorization: context.authorization,
    __bikaAssertAuthorization: async () => assertBikaAuthRevision(context.revision),
  };
  if (payload.method === "POST") {
    config.data = payload.body ?? {};
    config.body = JSON.stringify(config.data);
  }
  return { data: (await client.request(config)).data as unknown, storageKey };
}

export async function invalidateUnusableHomeResponse(
  storageKey: string | null,
  isUnusable: (data: unknown) => boolean,
) {
  if (!storageKey) return false;
  try {
    const entry = await cache.get<Record<string, unknown> | null>(storageKey, null);
    if (!entry || typeof entry.expireAt !== "number" || !isUnusable(entry.data)) return false;
    // Atomic invalidation cannot erase a healthy result written after this
    // inspection. readCache treats the null value as a miss on an explicit call.
    return await cache.compareAndSet(storageKey, entry, null);
  } catch {
    // Preserve the original feed/authentication error if cache maintenance is
    // unavailable; never retry or report a successful repair in this branch.
    return false;
  }
}

// Keep the existing preview helper callable while the old feed adapter remains.
export const invalidateUnusableHomeRanking = invalidateUnusableHomeResponse;
