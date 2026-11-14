import axios from "axios";
import { hasJmMembershipGate } from "./client";
import { decodeResponsePayload, optionalJmCount, readJmJsonEnvelope, unwrapJmAlbumPayload } from "./codec";
import { Config } from "./constants";
import { assertCurrentSession, getUserAgent } from "./state";
import { md5Hex, nowTs } from "./utils";

const routeKeyPattern = /^[A-Za-z0-9._|:-]{1,180}$/;
const dnsHostPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
const pageNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const lockedRouteRequestOptions = {
  maxRedirects: 0,
  withCredentials: false,
  fetchOptions: { redirect: "error" },
} as const;

export type JmDownloadRoute = { version: 1; key: string; apiHost: string; imageHost: string };

export const jmPublicImageHeaders = {
  "X-Requested-With": "com.JMComic3.app",
  Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
  "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
} as const;

export function jmBackgroundDownload(url: string, route: JmDownloadRoute) {
  const target = new URL(url);
  if (target.href !== url || !Config.buildImageCandidates().includes(target.origin)) {
    return undefined;
  }
  const locked = lockedDownloadImage(url, {
    jmDownloadApiHost: route.apiHost,
    jmDownloadImageHost: route.imageHost,
  });
  if (!locked) return undefined;
  return {
    version: 1,
    credentialFree: true,
    redirectPolicy: "same-url",
    headers: { Referer: locked.referer, ...jmPublicImageHeaders },
  } as const;
}

export function downloadRouteExclusions(raw: unknown): Set<string> | null {
  const input = object(raw);
  if (input?.version !== 1) return null;
  const excluded = input.excluded ?? [];
  if (!Array.isArray(excluded) || excluded.length > 3 ||
      !excluded.every((key) => typeof key === "string" && routeKeyPattern.test(key))) {
    throw new Error("下载线路请求无效，请重试");
  }
  return new Set(excluded);
}

export function jmDownloadBase(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.port && !url.username && !url.password &&
      (!url.pathname || url.pathname === "/") && !url.search && !url.hash &&
      dnsHostPattern.test(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

export function jmDownloadPair(api: URL, image: URL): JmDownloadRoute | null {
  const key = `jm|${api.hostname}|${image.hostname}`;
  return routeKeyPattern.test(key)
    ? { version: 1, key, apiHost: api.hostname, imageHost: image.hostname }
    : null;
}

export function lockedDownloadImage(url: string, extern?: Record<string, unknown>) {
  if (extern?.jmDownloadImageHost === undefined && extern?.jmDownloadApiHost === undefined) return null;
  const parsed = new URL(url);
  const imageHost = extern?.jmDownloadImageHost;
  const apiHost = extern?.jmDownloadApiHost;
  const page = /^\/media\/photos\/[1-9]\d*\/([^/]+)$/.exec(parsed.pathname)?.[1];
  if (typeof imageHost !== "string" || !dnsHostPattern.test(imageHost) ||
      typeof apiHost !== "string" || !dnsHostPattern.test(apiHost) ||
      parsed.protocol !== "https:" || parsed.port || parsed.username || parsed.password ||
      parsed.hostname !== imageHost || parsed.search || parsed.hash || !page || !pageNamePattern.test(page)) {
    throw new Error("下载图片与所选线路不匹配");
  }
  return { referer: `https://${apiHost}` };
}

function object(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : null;
}

function rejected(row: Record<string, unknown> | null): boolean {
  return !!row && ((row.code !== undefined && Number(row.code) !== 200) ||
    row.status === false || row.ok === false || row.success === false || Boolean(row.error));
}

async function readJmDownloadJson(
  api: URL,
  path: "album" | "chapter",
  params: Record<string, string | number>,
  revision: number,
  jwt?: string,
) {
  const ts = nowTs();
  const headers: Record<string, string> = {
    Host: api.host,
    Token: await md5Hex(`${ts}${Config.JM_VERSION}`),
    Tokenparam: `${ts},${Config.JM_VERSION}`,
    Accept: "application/json",
  };
  if (api.origin === jmDownloadBase(Config.baseUrl)?.origin) {
    headers["User-Agent"] = await getUserAgent();
  }
  assertCurrentSession(revision);
  if (jwt) {
    if (api.origin !== jmDownloadBase(Config.baseUrl)?.origin) return null;
    headers.Authorization = `Bearer ${jwt}`;
  }
  const response = await axios.get(`${api.origin}/${path}`, {
    ...lockedRouteRequestOptions,
    params,
    headers,
    timeout: 5000,
    responseType: "arraybuffer",
    maxContentLength: 2 * 1024 * 1024,
    validateStatus: () => true,
  }).catch((error: unknown) => {
    assertCurrentSession(revision);
    if (axios.isAxiosError(error) && ["ECONNABORTED", "ETIMEDOUT"].includes(error.code ?? "")) {
      return { status: 408, data: null };
    }
    throw error;
  });
  assertCurrentSession(revision);
  // Error responses can be HTML or empty. Keep the HTTP status before any
  // success-payload decoding so transport failure survives route selection.
  if (response.status === 408 || response.status === 425 || response.status === 429 ||
      response.status >= 500) {
    return { status: response.status, envelope: null, decoded: null };
  }
  const envelope = object(await readJmJsonEnvelope(response.data));
  const decoded = object(await decodeResponsePayload(envelope, ts));
  assertCurrentSession(revision);
  return { status: response.status, envelope, decoded };
}

export async function readJmDownloadAlbum(
  api: URL,
  requestedId: number,
  revision: number,
  jwt?: string,
) {
  const result = await readJmDownloadJson(api, "album", { id: requestedId }, revision, jwt);
  if (!result) return "unavailable" as const;
  const { status, envelope, decoded } = result;
  if (status === 408 || status === 425 || status >= 500) return { transportStatus: status } as const;
  const album = unwrapJmAlbumPayload(decoded);
  if (status === 200 && ![envelope, decoded, album].some(rejected) &&
      optionalJmCount(album.id) === requestedId && typeof album.name === "string" && album.name.trim()) {
    return album;
  }
  if ((jwt && status === 401) || ([200, 401, 403].includes(status) &&
      (hasJmMembershipGate(envelope) || hasJmMembershipGate(decoded)))) {
    return "memberGate" as const;
  }
  const codes = [Number(envelope?.code), Number(decoded?.code), Number(album.code)];
  if (status === 429 || codes.includes(429)) return "rateLimited" as const;
  if (status === 404 || status === 410 || codes.includes(404) || codes.includes(410)) return "notFound" as const;
  if (status === 401 || status === 403 || codes.includes(403)) return "restricted" as const;
  return "unavailable" as const;
}

export async function readJmDownloadChapter(
  api: URL,
  requestedId: number,
  revision: number,
  jwt?: string,
) {
  const result = await readJmDownloadJson(api, "chapter", { skip: "", id: requestedId }, revision, jwt);
  if (!result) return null;
  const { status, envelope, decoded } = result;
  const chapter = object(decoded?.data) ?? decoded;
  const images = chapter?.images;
  if (status === 200 && chapter && ![envelope, decoded, chapter].some(rejected) &&
      optionalJmCount(chapter.id) === requestedId && Array.isArray(images) &&
      images.length > 0 && images.length <= 4096 &&
      images.every((name): name is string => typeof name === "string" && pageNamePattern.test(name)) &&
      new Set(images.map((name) => name.toLowerCase())).size === images.length) {
    return { id: String(requestedId), name: String(chapter.name ?? ""), images };
  }
  if ([200, 401, 403].includes(status) &&
      (hasJmMembershipGate(envelope) || hasJmMembershipGate(decoded))) return "memberGate" as const;
  const codes = [Number(envelope?.code), Number(decoded?.code), Number(chapter?.code)];
  if (status === 429 || codes.includes(429)) return { transportStatus: 429 } as const;
  if (status === 408 || status === 425 || status >= 500) return { transportStatus: status } as const;
  if ([401, 403, 451].includes(status) || codes.some((code) => [401, 403, 451].includes(code)))
    return "restricted" as const;
  if ([404, 410].includes(status) || codes.some((code) => [404, 410].includes(code)))
    return "notFound" as const;
  return null;
}
