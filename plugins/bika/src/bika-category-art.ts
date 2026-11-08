type MapValue = Record<string, unknown>;
export type BikaCategoryArtwork = { url: string; path: string; icon?: string };

const entries = [
  {
    link: "https://www.miss001.com/home",
    brokenPath: "/images/static/novel.jpg",
    icon: "ai_story",
  },
  {
    link: "https://game-download.bidobido.xyz/game/64db6f8b9d36612340f2fabb",
    brokenPath: "/images/static/star.jpg",
    icon: "game",
    url: "https://storage-b.bidobido.xyz/static/tobs/ac3bd4de-b089-4965-9048-6936b0b43bd3.png",
    path: "bika-star-official-ac3bd4de.png",
  },
  {
    link: "https://www.yyai.vip/explore/app/",
    brokenPath: "/images/static/night.jpg",
    icon: "night_chat",
    url: "https://www.yyai.vip/256-256.png",
    path: "bika-night-official-256.png",
  },
] as const;

/** Only repair the observed dead category assets; preserve future upstream art.
 * 2026-11-01: public requests for the three file.bidobido.xyz assets returned
 * 403 or 404 HTML rather than images. Replacement
 * images come from the linked official game page and AI site's own icon.
 * The novel site is challenge-protected, so use a semantic icon, not invented art.
 */
export function resolveBikaCategoryArtwork(
  category: MapValue,
  cover: BikaCategoryArtwork,
): BikaCategoryArtwork {
  if (!category.isWeb) return cover;
  let destination: URL;
  try {
    destination = new URL(String(category.link ?? ""));
  } catch {
    return cover;
  }
  if (destination.protocol !== "https:" || destination.username || destination.password)
    return cover;
  // The live novel and AI entries carry invite/referral parameters. Artwork
  // identifies the known destination, while the click action keeps its full URL.
  const entry = entries.find((candidate) => {
    const known = new URL(candidate.link);
    return destination.origin === known.origin && destination.pathname === known.pathname;
  });
  if (!entry) return cover;
  if (cover.url) {
    try {
      const url = new URL(cover.url);
      if (
        url.origin !== "https://file.bidobido.xyz" ||
        url.pathname !== entry.brokenPath ||
        url.username ||
        url.password ||
        url.hash
      )
        return cover;
    } catch {
      return cover;
    }
  }
  return "url" in entry
    ? { url: entry.url, path: entry.path, icon: entry.icon }
    : { url: "", path: "", icon: entry.icon };
}
