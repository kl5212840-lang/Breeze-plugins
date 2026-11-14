import type {
  CapabilitiesBundleContract,
  LoginBundleContract,
  LoginSubmitPayload,
  LoginSubmitResult,
  SettingsBundleContract,
  SettingsSection,
  UserInfoBundleContract,
} from "breeze-plugin-kit";
import { buildLoginBundle, cache, flutterTools, readLoginValues } from "breeze-plugin-kit";
import { BIKA_HOME_CATEGORY_OPTIONS, BIKA_SEARCH_CATEGORY_OPTIONS } from "./bika-constants";
import { buildBikaImageUrl } from "./bika-image";
import { bikaRequest } from "./bika-request";
import type { BikaLoginPayload } from "./bika-types";
import { sanitizePath, toBool, toStrList, toStringMap } from "./bika-utils";
import {
  API_BASE_CACHE_KEY,
  BACKUP_API_BASE,
  DEFAULT_API_BASE,
  getApiBase,
  setApiBase,
  safeBikaResponseMessage,
} from "./client";
import { BIKA_PLUGIN_ID } from "./info";
import { loadPluginSetting, savePluginSetting } from "./plugin-config";
import { assertBikaAuth, assertBikaAuthRevision, beginBikaAuthChange, BikaAccountChangedError,
  checkInAutomatically, readBikaProfile } from "./bika-checkin";

import { APP_CHANNEL_SETTING_KEY, APP_CHANNELS, loadAppChannel } from "./bika-network";
import { IMAGE_QUALITY_SETTING_KEY, isBikaImageQuality, loadBikaImageQuality } from "./bika-image-quality";
import { currentBikaAuthRevision, saveBikaSessionValues, waitBikaSessionWrites } from "./bika-auth-session";
import { readAccessLineState } from "./bika-access-lines";
import { lineBase } from "./bika-access-line-policy";
import { retryTransient } from "../../shared/transient-retry";

export { loadPluginSetting } from "./plugin-config";

const API_BASE_SETTING_KEY = "network.apiBase";
const API_BASE_OPTIONS: Array<{ label: string; value: string }> = [
  { label: "picacomic", value: DEFAULT_API_BASE },
  { label: "go2778", value: BACKUP_API_BASE },
];

function normalizeApiBase(base: unknown): string {
  const value = String(base ?? "").trim();
  if (!value) return DEFAULT_API_BASE;
  return value.endsWith("/") ? value : `${value}/`;
}

function resolveApiBaseChoice(raw: unknown): string {
  const normalized = normalizeApiBase(raw);
  return lineBase(normalized) ?? DEFAULT_API_BASE;
}

async function readApiBaseFromCache(): Promise<string | null> {
  const cached = await cache.get(API_BASE_CACHE_KEY, "");
  const candidate = resolveApiBaseChoice(cached);
  if (!String(cached ?? "").trim()) {
    return null;
  }
  return candidate;
}

async function writeApiBaseToCache(apiBase: string) {
  await cache.set(API_BASE_CACHE_KEY, apiBase);
}
/**
 * 旧宿主（< 3.0.34，不懂 getLoginBundle）走 settings 账号密码区登录。
 * 三段比较：缺段按 0 补齐，Number(x)||0。
 */
function compareVersions(a: string, b: string): number {
  // dart.getAppVersion 返回 JSON 编码串（首尾带引号），先剥掉。
  const clean = (v: string) =>
    String(v ?? "")
      .trim()
      .replace(/^"+|"+$/g, "");
  const pa = clean(a)
    .split(".")
    .map((x) => Number(x) || 0);
  const pb = clean(b)
    .split(".")
    .map((x) => Number(x) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function isLegacyHost(): Promise<boolean> {
  const version = await flutterTools.getAppVersion();
  return compareVersions(version, "3.0.34") < 0;
}

export async function getSettingsBundle({ retainApiChoice = false }: { retainApiChoice?: boolean } = {}): Promise<SettingsBundleContract> {
  const cachedApiBase = await readApiBaseFromCache();
  if (cachedApiBase) {
    setApiBase(cachedApiBase);
  }

  const [
    account,
    password,
    proxy,
    imageQuality,
    slowDownload,
    blockedCategories,
    blockedHomeCategories,
    apiBase,
  ] = await Promise.all([
    loadPluginSetting("auth.account", ""),
    loadPluginSetting("auth.password", ""),
    loadAppChannel(),
    loadBikaImageQuality(),
    loadPluginSetting("download.slow", false),
    loadPluginSetting("search.blockedCategories", []),
    loadPluginSetting("home.blockedCategories", []),
    loadPluginSetting(API_BASE_SETTING_KEY, DEFAULT_API_BASE),
  ]);

  const legacyHost = await isLegacyHost();

  return {
    source: BIKA_PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "settings",
      sections: [
        ...(legacyHost
          ? [
              {
                id: "account",
                title: "账号",
                fields: [
                  {
                    key: "auth.account",
                    kind: "text",
                    label: "账号",
                  },
                  {
                    key: "auth.password",
                    kind: "password",
                    label: "密码",
                  },
                ],
              } as SettingsSection,
            ]
          : []),
        {
          id: "account",
          title: "账号",
          fields: [
            {
              key: "account.slogan",
              kind: "text",
              label: "更新简介",
              fnPath: "updateProfile",
              persist: false,
            },
            {
              key: "account.password",
              kind: "password",
              label: "更新密码",
              fnPath: "updatePassword",
              persist: false,
            },
          ],
        },
        {
          id: "image",
          title: "图片",
          fields: [
            {
              key: IMAGE_QUALITY_SETTING_KEY,
              kind: "select",
              label: "图片质量",
              fnPath: "saveSettings",
              options: [
                { label: "原图", value: "original" },
                { label: "高清", value: "high" },
                { label: "推荐", value: "medium" },
                { label: "极度压缩", value: "low" },
              ],
            },
          ],
        },
        {
          id: "shield",
          title: "屏蔽设置",
          fields: [
            {
              key: "home.blockedCategories",
              kind: "multiChoice",
              label: "首页屏蔽",
              options: BIKA_HOME_CATEGORY_OPTIONS.map((item) => ({
                label: item,
                value: item,
              })),
            },
            {
              key: "search.blockedCategories",
              kind: "multiChoice",
              label: "分类屏蔽",
              options: BIKA_SEARCH_CATEGORY_OPTIONS.map((item) => ({
                label: item,
                value: item,
              })),
            },
          ],
        },
        {
          id: "network",
          title: "网络设置",
          fields: [
            ...(retainApiChoice ? [{
              key: API_BASE_SETTING_KEY,
              kind: "select",
              label: "API 服务器",
              fnPath: "saveSettings",
              options: API_BASE_OPTIONS,
            } as const] : []),
            {
              key: APP_CHANNEL_SETTING_KEY,
              kind: "select",
              label: "分流通道",
              fnPath: "saveSettings",
              options: APP_CHANNELS.map((value) => ({ label: value, value })),
            },
          ],
        },
      ],
    },
    data: {
      canShowUserInfo: true,
      values: {
        ...(legacyHost
          ? {
              "auth.account": String(account ?? ""),
              "auth.password": String(password ?? ""),
            }
          : {}),
        "account.slogan": "",
        "account.password": "",
        "network.proxy": String(proxy ?? "3"),
        [IMAGE_QUALITY_SETTING_KEY]: imageQuality,
        "download.slow": toBool(slowDownload, false),
        "search.blockedCategories": toStrList(blockedCategories),
        "home.blockedCategories": toStrList(blockedHomeCategories),
        [API_BASE_SETTING_KEY]: resolveApiBaseChoice(apiBase),
      },
      canLogin: true,
    },
  };
}

export async function saveSettings(
  payload: { values?: Record<string, unknown>; [key: string]: unknown } = {},
) {
  const input = payload as Record<string, unknown>;
  const values = toStringMap(input.values);
  const changes: Record<string, unknown> = {};
  for (const key of [API_BASE_SETTING_KEY, APP_CHANNEL_SETTING_KEY, IMAGE_QUALITY_SETTING_KEY]) {
    if (Object.prototype.hasOwnProperty.call(values, key)) changes[key] = values[key];
    else if (Object.prototype.hasOwnProperty.call(input, key)) changes[key] = input[key];
    else if (input.key === key && Object.prototype.hasOwnProperty.call(input, "value"))
      changes[key] = input.value;
  }
  // Retain the old API-only {value} call without interpreting another field's
  // value as an API selection.
  if (
    !input.key &&
    !Object.keys(values).length &&
    Object.prototype.hasOwnProperty.call(input, "value")
  ) {
    changes[API_BASE_SETTING_KEY] = input.value;
  }
  const updated: Record<string, string> = {};
  if (Object.prototype.hasOwnProperty.call(changes, API_BASE_SETTING_KEY)) {
    const raw = changes[API_BASE_SETTING_KEY];
    if (typeof raw !== "string" || !raw.trim()) throw new Error("请选择有效的 API 服务器");
    const selected = normalizeApiBase(raw);
    if (!API_BASE_OPTIONS.some((option) => option.value === selected))
      throw new Error("请选择有效的 API 服务器");
    updated[API_BASE_SETTING_KEY] = selected;
  }
  if (Object.prototype.hasOwnProperty.call(changes, APP_CHANNEL_SETTING_KEY)) {
    const raw = changes[APP_CHANNEL_SETTING_KEY];
    const selected = typeof raw === "string" || typeof raw === "number" ? String(raw).trim() : "";
    if (!APP_CHANNELS.some((channel) => channel === selected))
      throw new Error("请选择有效的分流通道");
    updated[APP_CHANNEL_SETTING_KEY] = selected;
  }
  if (Object.prototype.hasOwnProperty.call(changes, IMAGE_QUALITY_SETTING_KEY)) {
    const selected = changes[IMAGE_QUALITY_SETTING_KEY];
    if (!isBikaImageQuality(selected)) throw new Error("请选择有效的图片质量");
    updated[IMAGE_QUALITY_SETTING_KEY] = selected;
  }
  for (const [key, value] of Object.entries(updated)) {
    await savePluginSetting(key, value);
    if (key === API_BASE_SETTING_KEY) {
      await writeApiBaseToCache(value);
      setApiBase(value);
    }
  }
  return {
    ok: true,
    data: {
      ...updated,
      ...(updated[API_BASE_SETTING_KEY] ? { apiBase: updated[API_BASE_SETTING_KEY] } : {}),
    },
  };
}

export async function getUserInfoBundle(): Promise<UserInfoBundleContract> {
  const profile = await readBikaProfile();
  const profileUser = profile.user;
  const avatar = toStringMap(profileUser.avatar);
  const avatarPath = String(avatar.path ?? "").trim();
  const avatarFileServer = String(avatar.fileServer ?? "").trim();
  const avatarUrl =
    avatarPath && avatarFileServer
      ? await buildBikaImageUrl(avatarFileServer, avatarPath, "creator")
      : "";
  await assertBikaAuth(profile.auth);
  const numberOrUnknown = (value: unknown) =>
    (typeof value === "number" || typeof value === "string" && value.trim()) &&
    Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  const level = numberOrUnknown(profileUser.level);
  const exp = numberOrUnknown(profileUser.exp);
  const slogan = typeof profileUser.slogan === "string" ? profileUser.slogan.trim() : "";

  return {
    source: BIKA_PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "userInfo",
    },
    data: {
      title: "账号",
      avatar: {
        id: String(profileUser._id ?? profileUser.id ?? "me"),
        url: avatarUrl,
        name: String(avatar.originalName ?? ""),
        path: sanitizePath(avatarPath),
        extern: {},
      },
      lines: [
        slogan ? `${String(profileUser.name ?? "")} (${slogan})` : String(profileUser.name ?? ""),
        level !== null ? `Lv.${level} ${String(profileUser.title ?? "")}` : String(profileUser.title ?? ""),
        exp !== null ? `经验值: ${exp}` : "",
        profile.status.isPunched === true ? "已签到" : profile.status.isPunched === false ? "未签到" : "",
      ],
      extern: {
        ...profile.status,
        name: String(profileUser.name ?? ""),
        level,
        title: String(profileUser.title ?? ""),
        slogan,
        exp,
        experience: exp === null ? "" : String(exp),
      },
    },
  };
}

export async function updateAvatar(payload: Record<string, unknown> = {}) {
  const jpegBase64 = String(payload.jpegBase64 ?? "").trim();
  if (!jpegBase64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(jpegBase64)) {
    throw new Error("请选择有效的头像图片");
  }
  // The host prepares a 200 × 200 JPEG before calling this function.
  if (jpegBase64.length > 700_000) {
    throw new Error("头像图片过大");
  }

  const apiBase = await getApiBase();
  await bikaRequest({
    url: `${apiBase}users/avatar`,
    method: "PUT",
    body: JSON.stringify({ avatar: `data:image/jpeg;base64,${jpegBase64}` }),
  });

  return { ok: true, message: "头像已更新" };
}

export async function updateProfile(payload: Record<string, unknown> = {}) {
  const value = String(payload.value ?? "").trim();
  if (!value) {
    throw new Error("简介不能为空");
  }

  const apiBase = await getApiBase();
  const result = await bikaRequest({
    url: `${apiBase}users/profile`,
    method: "PUT",
    body: JSON.stringify({ slogan: value }),
  });

  return {
    ok: true,
    message: "简介已更新",
    raw: result,
  };
}

export async function updatePassword(payload: Record<string, unknown> = {}) {
  const newPassword = String(payload.value ?? "");
  if (!newPassword.trim()) {
    throw new Error("密码不能为空");
  }

  const observedRevision = currentBikaAuthRevision();
  await waitBikaSessionWrites(observedRevision);
  const oldPassword = String(await loadPluginSetting("auth.password", ""));
  assertBikaAuthRevision(observedRevision);
  if (!oldPassword) {
    throw new Error("缺少旧密码，请重新登录后再试");
  }

  const revision = beginBikaAuthChange();
  const apiBase = await getApiBase();
  assertBikaAuthRevision(revision);
  const result = await bikaRequest({
    url: `${apiBase}users/password`,
    method: "PUT",
    body: JSON.stringify({
      new_password: newPassword,
      old_password: oldPassword,
    }),
    assertAuthorization: async () => assertBikaAuthRevision(revision),
  });

  await saveBikaSessionValues(revision, { "auth.password": newPassword });

  return {
    ok: true,
    message: "密码已更新",
    raw: result,
  };
}

export async function getLoginBundle(): Promise<LoginBundleContract> {
  const account = String(await loadPluginSetting("auth.account", ""));
  const password = String(await loadPluginSetting("auth.password", ""));
  return buildLoginBundle(BIKA_PLUGIN_ID, {
    title: "哔咔登录",
    fields: [
      { key: "account", kind: "text", label: "账号", required: true },
      { key: "password", kind: "password", label: "密码", required: true },
    ],
    submitFnPath: "loginWithPassword",
    submitText: "登录",
    values: { account, password },
  });
}

function readLoginFormValues(payload: BikaLoginPayload = {}) {
  const record = payload as Record<string, unknown>;
  if (record.values !== undefined) {
    const kitValues = readLoginValues(payload as LoginSubmitPayload);
    return {
      account: String(kitValues.account ?? "").trim(),
      password: String(kitValues.password ?? ""),
    };
  }
  return {
    account: String(record.account ?? "").trim(),
    password: String(record.password ?? ""),
  };
}

export async function loginWithPassword(
  payload: BikaLoginPayload = {},
): Promise<LoginSubmitResult> {
  const values = readLoginFormValues(payload);
  if (!values.account || !values.password) throw new Error("账号或密码不能为空");
  return performLoginWithRevision(values, beginBikaAuthChange());
}

async function performLoginWithRevision(
  payload: BikaLoginPayload,
  authRevision: number,
): Promise<LoginSubmitResult> {
  const { account, password } = readLoginFormValues(payload);

  if (!account || !password) {
    throw new Error("账号或密码不能为空");
  }

  await waitBikaSessionWrites(authRevision);
  const apiBase = await getApiBase();
  assertBikaAuthRevision(authRevision);
  const result = await bikaRequest({
    url: `${apiBase}auth/sign-in`,
    method: "POST",
    body: JSON.stringify({ email: account, password }),
    assertAuthorization: async () => assertBikaAuthRevision(authRevision),
  });

  const tokenValue = toStringMap(toStringMap(result).data).token;
  const token = typeof tokenValue === "string" ? tokenValue.trim() : "";
  assertBikaAuthRevision(authRevision);
  if (toStringMap(result).code !== 200 || !token || ["null", "undefined"].includes(token)) {
    throw new Error(safeBikaResponseMessage(result, "登录未完成，请重试", [account, password, token]));
  }
  await saveBikaSessionValues(authRevision, {
    "auth.account": account,
    "auth.password": password,
    "auth.authorization": token,
  });
  assertBikaAuthRevision(authRevision);

  return {
    source: BIKA_PLUGIN_ID,
    message: "登录成功",
    data: {
      account,
    },
  };
}

let automaticAuth: Promise<void> | null = null;
export function runBikaAuthAndCheckInLoop(): Promise<void> {
  if (automaticAuth) return automaticAuth;
  const task = performAutomaticAuth().finally(() => {
    if (automaticAuth === task) automaticAuth = null;
  });
  automaticAuth = task;
  return task;
}

async function performAutomaticAuth() {
  const observedRevision = currentBikaAuthRevision();
  try {
    await waitBikaSessionWrites(observedRevision);
    const account = String(await loadPluginSetting("auth.account", "")).trim();
    const password = String(await loadPluginSetting("auth.password", ""));
    assertBikaAuthRevision(observedRevision);
    if (!account || !password) {
      console.info("[bika.init] skip auth/checkin: no credentials");
      return;
    }

    // Reserve one generation for this flow. Retrying must never advance the
    // generation and take ownership back from a newer manual login/logout.
    const revision = beginBikaAuthChange();
    const result = await retryTransient(
      async () => {
        await performLoginWithRevision({ account, password }, revision);
        assertBikaAuthRevision(revision);
        return checkInAutomatically();
      },
      () => assertBikaAuthRevision(revision),
    );
    if (result.data.ok === true) console.info("[bika.init] checkin confirmed");
    else console.warn("[bika.init] checkin not confirmed");
  } catch (error) {
    if (error instanceof BikaAccountChangedError) return;
    console.warn("[bika.init] login/checkin incomplete; stopped");
  }
}

export async function init() {
  const savedApiBase = await loadPluginSetting(API_BASE_SETTING_KEY, DEFAULT_API_BASE);
  const selectedApiBase = resolveApiBaseChoice(savedApiBase);
  await writeApiBaseToCache(selectedApiBase);
  setApiBase(selectedApiBase);
  console.info(`[bika.init] api base selected: ${selectedApiBase}`);
  const accessLine = await readAccessLineState();
  if (accessLine.confirmation) void runBikaAuthAndCheckInLoop();

  return {
    source: BIKA_PLUGIN_ID,
    data: {
      ok: true,
      started: true,
      apiBase: await getApiBase(),
    },
  };
}

export async function getCapabilitiesBundle(): Promise<CapabilitiesBundleContract> {
  return {
    source: BIKA_PLUGIN_ID,
    scheme: {
      version: "1.0.0" as const,
      type: "capabilities" as const,
      actions: [],
    },
    data: {
      actions: [],
    },
  };
}

export async function clearPluginSession() {
  const revision = beginBikaAuthChange();
  await saveBikaSessionValues(revision, {
    "auth.account": "",
    "auth.password": "",
    "auth.authorization": "",
  });

  return {
    ok: true,
    message: "bika 插件会话已清理",
  };
}

export async function dumpRuntimeInfo() {
  return {
    ok: true,
    data: {
      pluginName: "bikaComic",
      now: new Date().toISOString(),
    },
  };
}
