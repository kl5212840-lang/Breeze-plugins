import { buildUnauthorizedError } from "breeze-plugin-kit";
import { bikaRequest } from "./bika-request";
import { getApiBase } from "./client";
import { BIKA_PLUGIN_ID } from "./info";
import { loadPluginSetting } from "./plugin-config";
import { assertBikaAuthRevision, currentBikaAuthRevision, BikaAccountChangedError } from "./bika-auth-session";
import { notifyAutoCheckinCompleted } from "../../shared/auto-checkin-notice";
export { assertBikaAuthRevision, beginBikaAuthChange, BikaAccountChangedError } from "./bika-auth-session";
type Auth = { revision: number; authorization: string };
async function readAuth(): Promise<Auth> {
  const revision = currentBikaAuthRevision();
  const raw = await loadPluginSetting("auth.authorization", "");
  const authorization = typeof raw === "string" ? raw.trim() : "";
  assertBikaAuthRevision(revision);
  if (!authorization || ["null", "undefined"].includes(authorization))
    throw buildUnauthorizedError(BIKA_PLUGIN_ID, "请先登录哔咔账号");
  return { revision, authorization };
}
export async function assertBikaAuth(auth: Auth) {
  assertBikaAuthRevision(auth.revision);
  if (String(await loadPluginSetting("auth.authorization", "")).trim() !== auth.authorization) {
    throw new BikaAccountChangedError();
  }
  assertBikaAuthRevision(auth.revision);
}

// No primary source establishes a reset timezone. This is the UTC+8 date of
// this observation for the host's freshness checks, NOT a claimed server day.
// No daily receipt is persisted or reused: every status read reaches profile.
function observationDate() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}
function assertDate(date: string) {
  if (date !== observationDate()) throw new Error("日期已变化，请重新核对");
}

export async function readBikaProfile(auth?: Auth) {
  const identity = auth ?? (await readAuth());
  const date = observationDate();
  const apiBase = await getApiBase();
  await assertBikaAuth(identity);
  const raw = await bikaRequest({
    url: `${apiBase}users/profile`,
    method: "GET",
    cache: false,
    authorization: identity.authorization,
    assertAuthorization: () => assertBikaAuth(identity),
  });
  await assertBikaAuth(identity);
  assertDate(date);
  const user = raw?.data?.user;
  const id = user?._id ?? user?.id;
  if (
    raw?.code !== 200 ||
    !user ||
    typeof user !== "object" ||
    Array.isArray(user) ||
    typeof id !== "string" ||
    !id.trim()
  ) {
    throw new Error("暂时无法读取账号资料，请重试");
  }
  const signed = typeof user.isPunched === "boolean" ? user.isPunched : null;
  const checkedAt = new Date().toISOString();
  const status = {
    accountId: id.trim(),
    checkedIn: signed,
    checkedInDate: signed === true ? date : null,
    isPunched: signed,
    checkinDateBasis: "observedUtc8",
    profileDataSource: "serverProfile",
    verification: {
      source: "serverProfile",
      date,
      dateBasis: "observedUtc8",
      serverDate: null,
      checkedAt,
      status: signed === true ? "confirmed" : signed === false ? "notSigned" : "unknown",
      signed,
    },
    checkinProof:
      signed === true
        ? {
            source: "serverProfile",
            date,
            dateBasis: "observedUtc8",
            serverDate: null,
            confirmedAt: checkedAt,
            verifiedThisRequest: true,
          }
        : null,
  };
  return { user: user as Record<string, unknown>, status, auth: identity, date };
}

export async function getCheckinStatus() {
  const profile = await readBikaProfile();
  return { source: BIKA_PLUGIN_ID, data: profile.status };
}

const pending = new Map<string, {
  task: ReturnType<typeof performCheckin>;
  manualRequested: boolean;
}>();
const submittingAccounts = new Set<string>();
export async function checkInToday(payload: { accountId?: unknown } = {}) {
  return requestCheckin(payload, false);
}

export async function checkInAutomatically() {
  return requestCheckin({}, true);
}

async function requestCheckin(payload: { accountId?: unknown }, automatic: boolean) {
  const auth = await readAuth();
  const key = `${auth.revision}:${auth.authorization}`;
  let current = pending.get(key);
  if (current === undefined) {
    const task = performCheckin(auth, payload.accountId).finally(() => pending.delete(key));
    current = { task, manualRequested: !automatic };
    pending.set(key, current);
  }
  if (!automatic) current.manualRequested = true;
  const { newlyConfirmed, ...result } = await current.task;
  if (payload.accountId !== undefined && payload.accountId !== result.data.accountId)
    throw new BikaAccountChangedError();
  if (automatic && newlyConfirmed && !current.manualRequested && result.data.checkedInDate) {
    assertBikaAuthRevision(auth.revision);
    assertDate(result.data.checkedInDate);
    void notifyAutoCheckinCompleted(result.data.accountId, result.data.checkedInDate);
  }
  return result;
}

async function performCheckin(auth: Auth, expectedId: unknown) {
  const before = await readBikaProfile(auth);
  if (expectedId !== undefined && expectedId !== before.status.accountId)
    throw new BikaAccountChangedError();
  if (before.status.checkedIn !== false) {
    return {
      source: BIKA_PLUGIN_ID,
      newlyConfirmed: false,
      data: {
        ...before.status,
        ok: before.status.checkedIn === true,
        message: before.status.checkedIn === true ? "今日已签到" : "暂时无法读取签到状态，请重试",
      },
    };
  }
  const apiBase = await getApiBase();
  await assertBikaAuth(auth);
  assertDate(before.date);
  if (submittingAccounts.has(before.status.accountId)) {
    return {
      source: BIKA_PLUGIN_ID,
      newlyConfirmed: false,
      data: { ...before.status, ok: false, message: "签到正在处理，请稍后核对" },
    };
  }
  submittingAccounts.add(before.status.accountId);
  try {
    // res.status='ok' is returned for repeated punches too. A POST response is
    // never the proof; even a lost response requires the following exact read.
    try {
      await bikaRequest({
        url: `${apiBase}users/punch-in`,
        method: "POST",
        body: "{}",
        cache: false,
        authorization: auth.authorization,
        assertAuthorization: () => assertBikaAuth(auth),
      });
    } catch {
      await assertBikaAuth(auth);
    }
    await assertBikaAuth(auth);
    assertDate(before.date);
    const after = await readBikaProfile(auth);
    if (after.status.accountId !== before.status.accountId) throw new BikaAccountChangedError();
    assertDate(before.date);
    return {
      source: BIKA_PLUGIN_ID,
      newlyConfirmed: after.status.checkedIn === true,
      data: {
        ...after.status,
        ok: after.status.checkedIn === true,
        message: after.status.checkedIn === true ? "今日签到已完成" : "签到尚未确认，请重试",
      },
    };
  } finally {
    submittingAccounts.delete(before.status.accountId);
  }
}
