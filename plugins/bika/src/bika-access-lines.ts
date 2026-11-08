import { cache, hostRuntime } from "breeze-plugin-kit";
import { loadPluginSetting, savePluginSetting } from "./plugin-config";
import { setApiBase } from "./client";
import { API_BASE_CACHE_KEY, API_BASE_SETTING_KEY, BASES, DEFAULT_API_BASE,
  LINE_CONFIRMATION_KEY, decodeLineText, lineBase } from "./bika-access-line-policy";

type Confirmation = { base: string; revision: string };
type Line = { base: string; elapsedMs: number; requiresAuthentication?: boolean };
type Diagnostic = { source?: string; base?: string; kind: "found" | "empty" | "http" | "parse" | "transport" | "available"; status?: number };
type Diagnostics = { candidateCount: number; discovery: Diagnostic[]; probes: Diagnostic[] };
type Run = { controller: AbortController; snapshot: string; lines: Line[]; completed: boolean };
const runs = new Map<string, Run>();
const cancelled = new Set<string>();
const QUERY = "name=cert.safaanalysis2024.com&type=TXT";
const DNS_URLS = [`https://cloudflare-dns.com/dns-query?${QUERY}`];
let selectionTail: Promise<unknown> = Promise.resolve();

export async function readAccessLineState() {
  const saved = await loadPluginSetting(API_BASE_SETTING_KEY, null);
  const base = lineBase(saved) ?? DEFAULT_API_BASE;
  const value = await loadPluginSetting(LINE_CONFIRMATION_KEY, null) as Confirmation | null;
  const confirmation = value && value.base === base && typeof value.revision === "string" && value.revision
    ? { base, revision: value.revision } : null;
  // Preserve an existing origin and account data without manufacturing an
  // explicit selection. Only a committed confirmation satisfies first entry.
  const hasSession = Boolean(String(await loadPluginSetting("auth.authorization", "")).trim());
  const retained = !confirmation && (BASES as readonly string[]).includes(base) &&
    (saved === base || hasSession);
  return { base, confirmation, retained, snapshot: JSON.stringify([base, confirmation?.revision ?? ""]) };
}
export async function getBikaAccessLineState() {
  const state = await readAccessLineState();
  return { ok: true, ...state, selected: state.confirmation !== null };
}

/** Separate fetch: no signed comic client, credentials, cookies or redirects.
 * Host ensure_http_target_allowed additionally resolves/rejects private IPs. */
async function publicGet(url: string, signal: AbortSignal, accept = "application/vnd.picacomic.com.v1+json") {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const timer = setTimeout(abort, 5000);
  try {
    const response = await fetch(url, {
      method: "GET", headers: { accept }, credentials: "omit", redirect: "error",
      cache: "no-store", signal: controller.signal,
    });
    const text = await response.text();
    if (text.length > 65536) throw new Error("Oversized public response");
    return { status: response.status, text };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
function domainsFromAnswers(value: unknown): string[] {
  const answers = object(value).Answer;
  if (!Array.isArray(answers)) return [];
  return answers.slice(0, 32).flatMap((a) => {
    const row = object(a);
    const domain = row.type === 16 ? decodeLineText(row.data) : null;
    return domain ? [domain] : [];
  });
}
type CheckResult = { ok: boolean; cancelled?: boolean; runId?: string; snapshot?: string; lines: Line[]; diagnostics: Diagnostics };
export async function checkBikaAccessLines(payload: { runId?: unknown } = {}): Promise<CheckResult> {
  const id = typeof payload.runId === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(payload.runId) ? payload.runId : "";
  if (!id) throw new Error("Invalid line check");
  const diagnostics: Diagnostics = { candidateCount: 0, discovery: [], probes: [] };
  if (cancelled.has(id)) return { ok: false, cancelled: true, lines: [], diagnostics };
  // One explicit check per runtime. Discarding a prior run also aborts its I/O.
  for (const r of runs.values()) r.controller.abort();
  runs.clear();
  const run: Run = { controller: new AbortController(), snapshot: "",
    lines: [], completed: false };
  runs.set(id, run);
  const remembered = await readAccessLineState();
  run.snapshot = remembered.snapshot;
  const signal = run.controller.signal;
  const domains = new Set<string>(["picacomic.com", "go2778.com"]);
  if (remembered.confirmation) domains.add(new URL(remembered.base).hostname.slice(8));
  async function discover(url: string, source: string, accept: string,
    decode: (value: unknown) => string[]) {
    let response;
    try { response = await publicGet(url, signal, accept); }
    catch { diagnostics.discovery.push({ source, kind: "transport" }); return; }
    if (response.status !== 200) {
      diagnostics.discovery.push({ source, kind: "http", status: response.status }); return;
    }
    try {
      const found = decode(JSON.parse(response.text));
      for (const domain of found) domains.add(domain);
      diagnostics.discovery.push({ source, kind: found.length ? "found" : "empty" });
    } catch { diagnostics.discovery.push({ source, kind: "parse" }); }
  }
  await Promise.all(DNS_URLS.map(url => discover(url, "dns", "application/dns-json", value => {
    const data = object(value);
    if (typeof data.Status !== "number" && !Array.isArray(data.Answer)) throw new Error("Invalid DNS response");
    return domainsFromAnswers(value);
  })));
  if (!signal.aborted) {
    // Known public bootstrap only, with its own JSON media type.
    await discover("https://recommend.go2778.com/dns/", "recommend", "application/json", value => {
      if (!Array.isArray(value)) throw new Error("Invalid recommendation response");
      return value.slice(0, 32).map(decodeLineText).filter((domain): domain is string => domain !== null);
    });
  }
  const candidates = [...domains].slice(0, 12).map((d) => `https://picaapi.${d}/`);
  diagnostics.candidateCount = candidates.length;
  let cursor = 0;
  const clock = () => typeof performance !== "undefined" ? performance.now() : Date.now();
  await Promise.all([0, 1].map(async () => {
    while (!signal.aborted && cursor < candidates.length) {
      const base = candidates[cursor++]!;
      const start = clock();
      try {
        const response = await publicGet(base, signal);
        // The live API challenges an unsigned anonymous request with this
        // precise JSON contract. It confirms reachability, never account access.
        let requiresAuthentication = false;
        if (response.status === 401) {
          try {
            const data = object(JSON.parse(response.text));
            requiresAuthentication = data.code === 401 && String(data.error) === "1005" && data.message === "unauthorized";
          } catch {
            diagnostics.probes.push({ base, kind: "parse", status: 401 });
            continue;
          }
        }
        if (!signal.aborted && (response.status === 200 || requiresAuthentication)) {
          run.lines.push({ base, elapsedMs: Math.max(0, Math.round(clock() - start)),
            ...(requiresAuthentication ? { requiresAuthentication: true } : {}) });
          diagnostics.probes.push({ base, kind: "available", status: response.status });
        } else {
          diagnostics.probes.push({ base, kind: "http", status: response.status });
        }
      } catch { diagnostics.probes.push({ base, kind: "transport" }); }
    }
  }));
  if (signal.aborted || runs.get(id) !== run) return { ok: false, cancelled: true, lines: [], diagnostics };
  run.completed = true;
  return { ok: true, runId: id, snapshot: run.snapshot, lines: run.lines, diagnostics };
}
export async function cancelBikaAccessLineCheck(payload: { runId?: unknown } = {}) {
  const id = String(payload.runId ?? "");
  cancelled.add(id);
  if (cancelled.size > 32) cancelled.delete(cancelled.values().next().value!);
  runs.get(id)?.controller.abort();
  runs.delete(id);
  return { ok: true };
}
export async function selectBikaAccessLine(payload: { runId?: unknown; base?: unknown; snapshot?: unknown } = {}) {
  const action = async () => {
    const run = runs.get(String(payload.runId ?? ""));
    const base = lineBase(payload.base);
    if (!run || !run.completed || run.controller.signal.aborted || !base ||
        !run.lines.some((line) => line.base === base)) return { ok: false, reason: "checkRequired" };
    const current = await readAccessLineState();
    if (current.snapshot !== payload.snapshot || current.snapshot !== run.snapshot)
      return { ok: false, reason: "changed" };
    const confirmation = { base, revision: hostRuntime.uuidv4() };
    await savePluginSetting(API_BASE_SETTING_KEY, base);
    await cache.set(API_BASE_CACHE_KEY, base);
    // Confirmation commits last. An interrupted partial save requires recheck.
    await savePluginSetting(LINE_CONFIRMATION_KEY, confirmation);
    const readback = await readAccessLineState();
    if (readback.confirmation?.revision !== confirmation.revision || readback.base !== base)
      return { ok: false, reason: "saveFailed" };
    setApiBase(base);
    runs.delete(String(payload.runId));
    return { ok: true, base };
  };
  const next = selectionTail.then(action, action);
  selectionTail = next.catch(() => {});
  return next;
}

export { BASES };
