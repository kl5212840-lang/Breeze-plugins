import axios from "axios";
import { decodeResponsePayload } from "./codec";
import { Config } from "./constants";
import type { EndpointSpeedRecord } from "./state";
import { md5Hex, nowTs } from "./utils";

const probeOptions = {
  timeout: 6000,
  maxRedirects: 0,
  fetchOptions: { redirect: "error" },
  withCredentials: false,
  validateStatus: () => true,
} as const;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function failed(value: unknown): boolean {
  const row = object(value);
  return !!row && ((row.code !== undefined && Number(row.code) !== 200) ||
    row.status === false || row.ok === false || row.success === false);
}

export async function decodePublicJmData(raw: unknown, ts: string): Promise<unknown> {
  const envelope = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (failed(envelope)) return null;
  const decoded = await decodeResponsePayload(envelope, ts);
  const nested = object(decoded)?.data;
  const value = object(nested) || Array.isArray(nested) ? nested : decoded;
  return failed(value) ? null : value;
}

async function probe<T>(url: string, check: (status: (code: number) => void) => Promise<T | null>) {
  const now = () => typeof performance === "undefined" ? Date.now() : performance.now();
  const started = now();
  let status: number | null = null;
  let value: T | null = null;
  try {
    value = await check((code) => { status = code || null; });
  } catch {
    // An unavailable route is reported alongside the other measurements.
  }
  const checkedAt = Date.now();
  const ok = value !== null;
  const record: EndpointSpeedRecord = {
    url, ok, ms: ok ? Math.max(0, Math.round(now() - started)) : null, status, checkedAt,
  };
  return { record, value };
}

async function signedPublicJson(
  url: string,
  setStatus: (code: number) => void,
  timeout: number = probeOptions.timeout,
) {
  const ts = nowTs();
  const response = await axios.get(url, {
    ...probeOptions,
    timeout,
    responseType: "text",
    maxContentLength: 512 * 1024,
    headers: {
      Accept: "application/json",
      Tokenparam: `${ts},${Config.JM_VERSION}`,
      Token: await md5Hex(`${ts}${Config.JM_VERSION}`),
    },
  });
  setStatus(response.status);
  return response.status === 200 ? decodePublicJmData(response.data, ts) : null;
}

export function probeJmCatalog(base: string) {
  return probeJmCatalogPath(base, "/latest?page=1");
}

export function probeJmRankingCatalog(base: string) {
  return probeJmCatalogPath(base, "/categories/filter?page=0&o=tf", 9000);
}

function probeJmCatalogPath(base: string, path: string, timeout?: number) {
  return probe(base, async (setStatus) => {
    const data = await signedPublicJson(`${base}${path}`, setStatus, timeout);
    const rows = Array.isArray(data) ? data : object(data)?.list ?? object(data)?.content;
    if (!Array.isArray(rows)) return null;
    const ids = new Set<string>();
    for (const value of rows) {
      const row = object(value);
      const id = String(row?.id ?? "");
      if (/^[1-9]\d{0,11}$/.test(id) && typeof row?.name === "string" && row.name.trim()) {
        ids.add(id);
        if (ids.size === 2) break;
      }
    }
    return ids.size > 0 ? [...ids] : null;
  });
}

export async function probeJmAlbum(base: string, id: string, validate: (data: unknown) => boolean) {
  const { record } = await probe(base, async (setStatus) => {
    const data = await signedPublicJson(`${base}/album?id=${id}`, setStatus);
    return validate(data) ? true : null;
  });
  return record;
}

export async function probeJmCover(base: string, id: string, referer: string) {
  const { record } = await probe(base, async (setStatus) => {
    const response = await axios.get(`${base}/media/albums/${id}_3x4.jpg`, {
      ...probeOptions,
      responseType: "arraybuffer",
      maxContentLength: 256 * 1024,
      headers: {
        Accept: "image/jpeg,image/*",
        Range: "bytes=0-63",
        Referer: referer,
        "X-Requested-With": "com.JMComic3.app",
      },
    });
    setStatus(response.status);
    if (response.status !== 200 && response.status !== 206) return null;
    const bytes = new Uint8Array(response.data);
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? true : null;
  });
  return record;
}
