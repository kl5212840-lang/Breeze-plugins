import { JmRequestError } from "./errors";

type JsonMap = Record<string, unknown>;
const map = (value: unknown): JsonMap => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as JsonMap : {};

export function notificationText(value: unknown): string {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value)
    .replace(/<br\s*\/?\s*>|<\/p\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity: string) => {
      const lower = entity.toLowerCase();
      if (lower.startsWith("#")) {
        const hex = lower.startsWith("#x");
        const point = Number.parseInt(lower.slice(hex ? 2 : 1), hex ? 16 : 10);
        return Number.isFinite(point) && point > 0 && point <= 0x10ffff
          ? String.fromCodePoint(point) : match;
      }
      return entities[lower] ?? match;
    })
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n+ */g, "\n")
    .trim();
}

function readStatus(value: unknown): boolean | null {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value === "string") {
    if (["true", "1"].includes(value.trim().toLowerCase())) return true;
    if (["false", "0"].includes(value.trim().toLowerCase())) return false;
  }
  return null;
}

function count(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function refused(body: JsonMap): boolean {
  return body.status === false || body.ok === false || body.success === false ||
    (body.code !== undefined && Number(body.code) !== 200);
}

/** Read-only notification parsing. Unknown state is never an empty inbox or
 * a fabricated unread count; an official message is not discarded for its URL. */
export function parseJmNotifications(raw: unknown) {
  const root = map(raw);
  const nested = map(root.data);
  if (refused(root) || refused(nested)) throw new JmRequestError("站内消息读取失败，请稍后重试");
  const rows = Array.isArray(raw) ? raw : Array.isArray(root.list) ? root.list
    : Array.isArray(nested.list) ? nested.list : null;
  if (rows === null) throw new JmRequestError("站内消息格式暂不可用，请稍后重试");
  const total = count(root.total) ?? count(nested.total);
  const items = rows.map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new JmRequestError("站内消息格式暂不可用，请稍后重试");
    }
    const item = map(value);
    const content = Array.isArray(item.content)
      ? item.content.map((part) => {
          const entry = map(part);
          return notificationText(typeof part === "string" || typeof part === "number"
            ? part : entry.name ?? entry.title ?? entry.album_name);
        }).filter(Boolean).join("、")
      : notificationText(item.content);
    const read = readStatus(item.read);
    return {
      id: typeof item.id === "string" || typeof item.id === "number" ? String(item.id) : "",
      title: notificationText(item.title) || "通知",
      content,
      time: typeof (item.date ?? item.time) === "string" ? String(item.date ?? item.time) : "",
      read,
      readKnown: read !== null,
      type: typeof item.type === "string" ? item.type : "",
    };
  });
  return {
    items,
    total: total ?? items.length,
    totalKnown: total !== null,
    complete: total !== null && total === items.length,
    knownUnreadCount: items.filter((item) => item.read === false).length,
    unknownReadCount: items.filter((item) => !item.readKnown).length,
  };
}
