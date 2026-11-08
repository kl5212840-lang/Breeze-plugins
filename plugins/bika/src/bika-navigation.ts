import { bikaVideoEntry } from "./bika-video";

export function isBikaNativeVideoShortcut(
  action: Record<string, unknown>,
  nativeVideoTab: unknown,
): boolean {
  if (nativeVideoTab !== true || action.type !== "openVideoLibrary") return false;
  const payload = action.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") return false;
  const entry = bikaVideoEntry(payload.url);
  return (
    !!entry &&
    payload.source === entry.payload.source &&
    payload.catalogFnPath === entry.payload.catalogFnPath &&
    payload.detailFnPath === entry.payload.detailFnPath &&
    payload.playbackFnPath === entry.payload.playbackFnPath
  );
}
