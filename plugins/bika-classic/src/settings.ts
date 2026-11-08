import type { SettingsBundleContract } from "breeze-plugin-kit";
import { getSettingsBundle as getCoreSettingsBundle } from "../../bika/src/bika-settings";
import { loadPluginSetting } from "../../bika/src/plugin-config";

export const EXPERIENCE_STYLE_KEY = "ui.experienceStyle";
export type ExperienceStyle = "original" | "follow";
export function normalizeExperienceStyle(value: unknown): ExperienceStyle {
  return value === "follow" ? "follow" : "original";
}

export async function getSettingsBundle(): Promise<SettingsBundleContract> {
  const [bundle, value] = await Promise.all([
    getCoreSettingsBundle({ retainApiChoice: true }), loadPluginSetting(EXPERIENCE_STYLE_KEY, "original"),
  ]);
  return {
    ...bundle,
    scheme: { ...bundle.scheme, sections: [
      { id: "appearance", title: "界面", fields: [{
        key: EXPERIENCE_STYLE_KEY, kind: "select", label: "外观",
        options: [
          { label: "原版粉色", value: "original" },
          { label: "跟随全局", value: "follow" },
        ],
      }] },
      ...bundle.scheme.sections,
    ] },
    data: { ...bundle.data, values: {
      ...bundle.data.values, [EXPERIENCE_STYLE_KEY]: normalizeExperienceStyle(value),
    } },
  };
}
