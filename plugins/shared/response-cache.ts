type ResponseCacheBridge = {
  call(route: string, ...arguments_: unknown[]): Promise<unknown>;
};

function responseCacheBridge(): ResponseCacheBridge | undefined {
  return (globalThis as typeof globalThis & { bridge?: ResponseCacheBridge }).bridge;
}

export async function responseCacheGeneration(): Promise<number | undefined> {
  try {
    const result = await responseCacheBridge()?.call("cache.response_generation");
    return typeof result === "number" && Number.isSafeInteger(result) ? result : undefined;
  } catch {
    // Older hosts do not implement generation-aware response cache writes.
    return undefined;
  }
}

export async function writeResponseCache(key: string, value: unknown, generation?: number) {
  const bridge = responseCacheBridge();
  if (generation === undefined) return bridge?.call("cache.set", key, value);
  return bridge?.call("cache.set", key, value, generation);
}
