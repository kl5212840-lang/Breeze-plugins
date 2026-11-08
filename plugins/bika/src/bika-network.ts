import { loadPluginSetting } from "./plugin-config";

export const APP_CHANNEL_SETTING_KEY = "network.proxy";
export const DEFAULT_APP_CHANNEL = "3";
export const APP_CHANNELS = ["1", "2", "3"] as const;

export function normalizeAppChannel(value: unknown): string {
  const channel =
    typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  return APP_CHANNELS.some((item) => item === channel) ? channel : DEFAULT_APP_CHANNEL;
}

export async function loadAppChannel(): Promise<string> {
  return normalizeAppChannel(await loadPluginSetting(APP_CHANNEL_SETTING_KEY, DEFAULT_APP_CHANNEL));
}
