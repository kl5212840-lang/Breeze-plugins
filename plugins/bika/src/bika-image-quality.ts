import { loadPluginSetting } from "./plugin-config";

/** Network image quality from the selected iOS 2.5.85 client; distinct from
 * Flutter FilterQuality. Existing installations keep their original default. */
export const IMAGE_QUALITY_SETTING_KEY = "image.quality";
export const IMAGE_QUALITIES = ["original", "high", "medium", "low"] as const;
export type BikaImageQuality = (typeof IMAGE_QUALITIES)[number];
export const DEFAULT_IMAGE_QUALITY: BikaImageQuality = "original";

export function isBikaImageQuality(value: unknown): value is BikaImageQuality {
  return typeof value === "string" && IMAGE_QUALITIES.some((item) => item === value);
}

export function normalizeBikaImageQuality(value: unknown): BikaImageQuality {
  return isBikaImageQuality(value) ? value : DEFAULT_IMAGE_QUALITY;
}

export async function loadBikaImageQuality(): Promise<BikaImageQuality> {
  return normalizeBikaImageQuality(
    await loadPluginSetting(IMAGE_QUALITY_SETTING_KEY, DEFAULT_IMAGE_QUALITY),
  );
}

export class BikaImageQualityChangedError extends Error {
  constructor() {
    super("图片质量已更改，请重试");
    this.name = "BikaImageQualityChangedError";
  }
}

/** Reject a stale read, never report a completed mutation as a failed read. */
export async function assertBikaImageQuality(quality: BikaImageQuality): Promise<void> {
  if (await loadBikaImageQuality() !== quality) throw new BikaImageQualityChangedError();
}
