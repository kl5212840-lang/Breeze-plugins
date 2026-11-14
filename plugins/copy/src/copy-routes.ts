// The official 3.1.1 app contains mapi.mangacopy.com and api.copy202602.com.
// The website announces copy4000.com and its CSP lists the older Copy domains.
// Keep existing choice keys for saved settings, independently of display names.
export const COPY_API_ROUTES: Readonly<Record<string, string>> = {
  官方App线路: "https://api.copy202602.com/api/v3",
  官方国际线路: "https://mapi.mangacopy.com/api/v3",
  国际服: "https://api.mangacopy.com/api/v3",
  国际服1: "https://api.copy2000.online/api/v3",
  国际服2: "https://api.copy3000.com/api/v3",
  大陆专线1: "https://mapi.copy20.com/api/v3",
  大陆专线2: "https://mapi.copy2000.site/api/v3",
  大陆专线3: "https://api.2025copy.com/api/v3",
  大陆专线新站: "https://api.2026copy.com/api/v3",
  大陆Copy4000: "https://api.copy4000.com/api/v3",
  热辣漫画线路1: "https://mapi.hotmangasd.com/api/v3",
  热辣漫画线路2: "https://api.manga2025.com/api/v3",
  热辣漫画线路3: "https://mapi.hotmangasf.com/api/v3",
  热辣漫画线路4: "https://mapi.hotmangasg.com/api/v3",
  热辣漫画线路5: "https://mapi.elfgjfghkk.club/api/v3",
  热辣漫画线路6: "https://mapi.fgjfghkk.club/api/v3",
  热辣漫画线路7: "https://mapi.fgjfghkkcenter.club/api/v3",
};

export const COPY_DEFAULT_CHOICE = "大陆专线2";

export function isCopyRouteChoice(value: string) {
  return Object.prototype.hasOwnProperty.call(COPY_API_ROUTES, value);
}

// Account eligibility is an allowlist. A new reading mirror cannot inherit it.
const accountChoices = new Set([
  "官方App线路", "官方国际线路", "国际服", "国际服2",
  "大陆专线1", COPY_DEFAULT_CHOICE, "大陆专线3", "大陆专线新站", "大陆Copy4000",
]);

export function isCopyAccountChoice(choice: string) {
  return accountChoices.has(choice);
}

const accountOrigins = new Map(
  Object.entries(COPY_API_ROUTES)
    .filter(([choice]) => isCopyAccountChoice(choice))
    .map(([, base]) => [new URL(base).origin, base]),
);

const hotHosts = new Set(Object.entries(COPY_API_ROUTES)
  .filter(([choice]) => choice.startsWith("热辣漫画线路"))
  .map(([, base]) => new URL(base).hostname));

export function accountBaseForOrigin(origin: string) {
  return accountOrigins.get(origin);
}

export function isCopyAccountBase(base: string) {
  return accountOrigins.get(new URL(base).origin) === base;
}

export function isHotMangaApiBase(url: string) {
  return hotHosts.has(new URL(url).hostname);
}
