import bikaClient, { getApiBase } from "../../bika/src/client";
import { BIKA_PLUGIN_ID } from "./identity";

const fields = ["name", "email", "password", "question1", "question2", "question3",
  "answer1", "answer2", "answer3", "birthday", "gender"] as const;
type Field = typeof fields[number];
type Registration = Record<Field, string>;
export type RegistrationReason = "invalidInput" | "busy" | "duplicateIdentity" |
  "unauthorized" | "rateLimited" | "unavailable" | "rejected" | "uncertain";
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};

// Client rules recovered from the selected iOS 2.5.85 registration forms. In
// particular, its username is serialized as `email`; it is not an email field.
export function invalidRegistrationField(raw: unknown, now = new Date()): Field | null {
  const value = object(raw);
  for (const key of fields) if (typeof value[key] !== "string") return key;
  const p = value as Registration;
  if (p.name.length < 2 || p.name.length > 50) return "name";
  if (!/^[0-9a-zA-Z]+$/.test(p.email)) return "email";
  if (p.password.length < 8) return "password";
  for (const key of fields.filter((key) => /^(question|answer)/.test(key)))
    if (!p[key].length) return key;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.birthday)) return "birthday";
  const [year, month, day] = p.birthday.split("-").map(Number) as [number, number, number];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day)
    return "birthday";
  const age = now.getFullYear() - year -
    (now.getMonth() + 1 < month || now.getMonth() + 1 === month && now.getDate() < day ? 1 : 0);
  if (age < 18) return "birthday";
  if (!["m", "f", "bot"].includes(p.gender)) return "gender";
  return null;
}

let submitting = false;
function failure(reason: RegistrationReason, field?: Field) {
  return { source: BIKA_PLUGIN_ID,
    data: { version: 1, status: "failed" as const, reason, ...(field ? { field } : {}) } };
}

/** No config/cache writes, automatic sign-in, retries or raw errors. Secrets
 * only live in the submitted request; neither response nor error echoes them. */
export async function registerAccount(payload: Record<string, unknown> = {}) {
  if (submitting) return failure("busy");
  const field = invalidRegistrationField(payload);
  if (field) return failure("invalidInput", field);
  const body = Object.fromEntries(fields.map((key) => [key, payload[key]])) as Registration;
  submitting = true;
  try {
    const base = await getApiBase();
    // All HTTP statuses stay local to registration: a rejected registration is
    // not an expired existing session. The shared client's default is unchanged.
    const response = await bikaClient.post(`${base}auth/register`, JSON.stringify(body), {
      validateStatus: () => true,
    });
    const data = object(response.data);
    if (response.status === 200 && data.message === "success")
      return { source: BIKA_PLUGIN_ID,
        data: { version: 1, status: "success" as const, account: body.email } };
    if (response.status === 400 && ["1008", "1009"].includes(String(data.error)))
      return failure("duplicateIdentity");
    if (response.status === 401) return failure("unauthorized");
    if (response.status === 429) return failure("rateLimited");
    if (response.status >= 500) return failure("unavailable");
    return failure("rejected");
  } catch {
    // A timeout may follow a committed write. Do not automatically retry or
    // forward Axios config/body, server text, password or security questions.
    return failure("uncertain");
  } finally {
    submitting = false;
  }
}
