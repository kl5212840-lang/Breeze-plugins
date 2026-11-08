/** API origins and public DNS decoding from the selected iOS 2.5.85 snapshot. */
export const DEFAULT_API_BASE = "https://picaapi.picacomic.com/";
export const BACKUP_API_BASE = "https://picaapi.go2778.com/";
export const API_BASE_SETTING_KEY = "network.apiBase";
export const LINE_CONFIRMATION_KEY = "network.accessLineConfirmation";
export const API_BASE_CACHE_KEY = "bika:network.apiBase";
export const BASES = [DEFAULT_API_BASE, BACKUP_API_BASE] as const;

export function publicLineDomain(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 253 || raw !== raw.trim()) return null;
  const value = raw.toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value)) return null;
  if (/(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example|onion)$/.test(value)) return null;
  return value;
}

export function lineBase(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password || u.port ||
        u.pathname !== "/" || u.search || u.hash || !u.hostname.startsWith("picaapi.")) return null;
    const domain = publicLineDomain(u.hostname.slice(8));
    return domain ? `https://picaapi.${domain}/` : null;
  } catch { return null; }
}

export function decodeLineText(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  const parts = raw.split("_");
  if (parts.length !== 2) return null;
  try {
    const encoded = parts[1]!.split("").reverse().join("").replace(/"/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
    // Domains are ASCII; rejecting non-ASCII is stricter than the original UTF8
    // decode, and avoids accepting replacement characters as a hostname.
    return publicLineDomain(atob(encoded).split("").reverse().join("").replace(/@/g, "."));
  } catch { return null; }
}
