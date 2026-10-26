import { normalizeCopyThemeOptions, type CopyFilterOption } from "./catalog";

export const COPY_THEME_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type ThemeCacheDependencies = {
  read: () => Promise<unknown>;
  write: (value: { fetchedAt: number; options: CopyFilterOption[] }) => Promise<unknown>;
  fetch: () => Promise<unknown>;
  fallback: CopyFilterOption[];
  now?: () => number;
};

/** A failed catalogue lookup must not make the filter sheet unavailable. */
export async function loadCopyThemeOptions(deps: ThemeCacheDependencies) {
  const now = (deps.now ?? Date.now)();
  let stale: CopyFilterOption[] = [];
  try {
    const value = (await deps.read()) as { fetchedAt?: unknown; options?: unknown } | null;
    stale = normalizeCopyThemeOptions(value?.options);
    const age = now - Number(value?.fetchedAt);
    if (stale.length && age >= 0 && age < COPY_THEME_CACHE_TTL_MS) return stale;
  } catch {
    /* A storage failure still allows a public taxonomy request. */
  }
  try {
    const fresh = normalizeCopyThemeOptions(await deps.fetch());
    if (!fresh.length) throw new Error("Empty theme catalogue");
    try {
      await deps.write({ fetchedAt: now, options: fresh });
    } catch {
      /* usable in memory */
    }
    return fresh;
  } catch {
    return stale.length ? stale : deps.fallback;
  }
}
