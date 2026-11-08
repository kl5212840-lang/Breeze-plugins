export const ACCOUNT_CREDENTIALS_KEY = "account.credentials";

interface ConfigStore {
  load(key: string, fallback: string): Promise<unknown>;
  save(key: string, value: string): Promise<unknown>;
}

export interface AccountCredentials {
  version: 1;
  account: string;
  password: string;
  origin: string;
  updatedAt: number;
  deleted: false;
}

function decode(raw: unknown): unknown {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (value && typeof value === "object" && "ok" in value) {
    if ((value as { ok: unknown }).ok !== true) throw new Error("账号密码读取失败");
    return (value as { value?: unknown }).value;
  }
  return value;
}

export async function readAccountCredentials(store: ConfigStore): Promise<AccountCredentials | null> {
  const raw = decode(await store.load(ACCOUNT_CREDENTIALS_KEY, "null"));
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<AccountCredentials>;
  if (value.version !== 1 || value.deleted !== false ||
      typeof value.account !== "string" || !value.account ||
      typeof value.password !== "string" || !value.password ||
      typeof value.origin !== "string" ||
      !Number.isSafeInteger(value.updatedAt) || (value.updatedAt ?? 0) <= 0) return null;
  try {
    const url = new URL(value.origin);
    if (url.protocol !== "https:" || url.origin !== value.origin || url.username || url.password) return null;
  } catch { return null; }
  return value as AccountCredentials;
}

export async function saveAccountCredentials(
  store: ConfigStore, account: string, password: string, origin: string,
): Promise<void> {
  const value: AccountCredentials = {
    version: 1, account, password, origin, updatedAt: Date.now(), deleted: false,
  };
  try {
    await store.save(ACCOUNT_CREDENTIALS_KEY, JSON.stringify(value));
    // The bridge can resolve with an error envelope. Verify durable storage
    // before reporting successful login; never include secrets in an error.
    const saved = await readAccountCredentials(store);
    if (!saved || JSON.stringify(saved) !== JSON.stringify(value)) throw new Error();
  } catch {
    throw new Error("登录资料保存失败，请重试");
  }
}
