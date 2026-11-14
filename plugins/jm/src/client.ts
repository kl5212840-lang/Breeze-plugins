import type { AxiosResponse } from "axios";
import axios from "axios";
import { decodeResponsePayload, readJmJsonEnvelope, unwrapJmAlbumPayload } from "./codec";
import { Config } from "./constants";
import { JmFollowError, JmRequestError, resolveServerMessage, toFriendlyError } from "./errors";
import {
  cacheKeyFromConfig,
  getCachedResponse,
  getJwtToken,
  getUserAgent,
  setJwtToken,
  assertCurrentSession,
  currentSessionRevision,
} from "./state";
import type { JmLikeDiagnostic, JmLikeStage, JmMeta, JmRequestConfig } from "./types";
import { getHost, md5Hex, nowTs } from "./utils";

const JM_PLUGIN_ID = "6886291b-f524-441c-844b-c2efae9899a9";

export function buildUnauthorizedError(message = "登录过期，请重新登录"): Error {
  return new Error(JSON.stringify({ type: "unauthorized", source: JM_PLUGIN_ID, message }));
}

export class JmLikeUnconfirmedError extends JmRequestError {
  constructor(diagnostic?: JmLikeDiagnostic) {
    const message = "暂时无法确认点赞状态，请重新打开作品详情查看";
    super(diagnostic ? JSON.stringify({ type: "comic_like_unconfirmed", message, diagnostic }) : message);
  }
}

export class JmLikeRejectedError extends JmRequestError {
  constructor(message: string, diagnostic?: JmLikeDiagnostic) {
    super(JSON.stringify({ type: "comic_like_rejected", message, diagnostic }));
  }
}

function isLoginRequest(url: unknown): boolean {
  return String(url || "")
    .toLowerCase()
    .includes("/login");
}

function looksLikeCredentialError(message: string): boolean {
  const text = message.toLowerCase();
  return /登录失败|登入失敗|登入失败|登錄失敗|authentication failed/.test(text) || (
    /账号|帳號|用户名|用戶名|密码|密碼|password|credential/.test(text) &&
    /错误|錯誤|失败|失敗|不正确|不正確|不對|不存在|无效|無效|停用|incorrect|invalid|wrong|disabled|banned/.test(text)
  );
}

const jmMembershipMessages = new Set([
  "請先登入會員",
  "请先登入会员",
  "請先登錄會員",
  "请先登录会员",
]);

export function hasJmMembershipGate(decoded: unknown): boolean {
  const inner = (decoded as { data?: unknown } | null)?.data;
  return [decoded, inner].some((value) => {
    const message = resolveServerMessage(value, "").replace(/[。.!！]+$/, "").trim();
    return jmMembershipMessages.has(message);
  });
}

export function recordJmLikeStage(
  diagnostic: JmLikeDiagnostic | undefined,
  stage: "submit" | "readback",
  result: JmLikeStage["result"],
  status?: number,
) {
  const http = status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599
    ? status : undefined;
  if (diagnostic) diagnostic[stage] = { http, result };
  const line = `[jm.like] ${stage} http=${http ?? "unknown"} result=${result}`;
  if (result === "readable") console.info(line);
  else console.warn(line);
}

function validateJmLikeResponse(envelope: unknown, decoded: unknown, status: number, method: string, diagnostic?: JmLikeDiagnostic) {
  const levels = [envelope, decoded, (decoded as { data?: unknown } | null)?.data];
  const messages = levels.map((level) => resolveServerMessage(level, ""));
  const stage = method === "GET" ? "readback" : "submit";
  const httpRejected = status < 200 || status >= 300;
  if (status === 401 || levels.some(hasJmMembershipGate) ||
      levels.some((level) => Number((level as { code?: unknown } | null)?.code) === 401)) {
    recordJmLikeStage(diagnostic, stage, "login-required", status);
    throw buildUnauthorizedError();
  }
  if (httpRejected || levels.some(jmRejectedResponse)) {
    const result = httpRejected ? "http-rejected" : "business-rejected";
    recordJmLikeStage(diagnostic, stage, result, status);
    if (method === "GET") throw new JmLikeUnconfirmedError(diagnostic);
    const fallback = httpRejected ? `服务器响应异常 (${status || "unknown"})` : "点赞未成功";
    const message = messages.find((message) => message) || fallback;
    throw diagnostic ? new JmLikeRejectedError(message, diagnostic) : new JmRequestError(message);
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    recordJmLikeStage(diagnostic, stage, "unreadable", status);
    throw new JmLikeUnconfirmedError(diagnostic);
  }
  recordJmLikeStage(diagnostic, stage, "readable", status);
}

function jmRejectedResponse(level: unknown) {
  if (level === false) return true;
  if (!level || typeof level !== "object" || Array.isArray(level)) return false;
  const { code, status, ok, success } = level as Record<string, unknown>;
  return (code !== undefined && Number(code) !== 200) ||
    status === false || status === 0 ||
    ["0", "false", "error", "fail", "failed"].includes(String(status ?? "").trim().toLowerCase()) ||
    ok === false || success === false;
}

function validateJmFavoriteResponse(envelope: unknown, decoded: unknown, status: number) {
  const levels = [envelope, decoded, (decoded as { data?: unknown } | null)?.data];
  if (status === 401 || levels.some(hasJmMembershipGate) ||
      levels.some((level) => Number((level as { code?: unknown } | null)?.code) === 401)) {
    throw buildUnauthorizedError();
  }
  if (levels.some((level) => /已[满滿]/.test(resolveServerMessage(level, "")))) {
    throw new JmRequestError("收藏数已达上限");
  }
  if (status < 200 || status >= 300 || levels.some(jmRejectedResponse)) {
    throw new JmRequestError("禁漫未确认收藏操作，请重新打开作品查看");
  }
}

export function createJmClient() {
  const client = axios.create({
    timeout: 10000,
    validateStatus: () => true,
  });

  async function parseResponse(
    response: AxiosResponse,
  ): Promise<AxiosResponse> {
    const cfg = response.config as JmRequestConfig;
    const meta = cfg.__jmMeta;
    const revision = meta?.sessionRevision ?? currentSessionRevision();
    assertCurrentSession(revision);

    const envelope = meta?.comicLike || meta?.comicFavorite ? await readJmJsonEnvelope(response.data) : null;
    const decoded = await decodeResponsePayload(
      envelope ?? response.data,
      meta?.ts || nowTs(),
    );
    const status = Number(response.status || 0);
    assertCurrentSession(revision);

    if (meta?.comicLike) {
      // Decrypting string data can discard outer error fields. Check both
      // layers without importing a returned token into the current session.
      validateJmLikeResponse(envelope, decoded, status, String(cfg.method).toUpperCase(), meta.likeDiagnostic?.());
      response.data = decoded;
      return response;
    }

    if (meta?.comicFavorite) {
      validateJmFavoriteResponse(envelope, decoded, status);
      response.data = decoded;
      return response;
    }

    if (meta?.comicFollow) {
      const success = status >= 200 && status < 300;
      if ((success || status === 401 || status === 403) && hasJmMembershipGate(decoded)) {
        const album = success ? unwrapJmAlbumPayload(decoded) : {};
        if (album.id == null || typeof album.name !== "string" || !album.name.trim()) {
          throw new JmFollowError("signInRequired");
        }
      }
      if (!success) {
        if (status === 404 || status === 410) throw new JmFollowError("notFound");
        if (status === 408) throw new JmFollowError("network", true);
        throw new JmFollowError("sourceUnavailable");
      }
      response.data = decoded;
      return response;
    }

    if (status < 200 || status >= 300) {
      console.warn(`[jm.http] request failed status=${status || "unknown"}`);
      const serverMsg = resolveServerMessage(
        decoded,
        `服务器响应异常 (${status || "unknown"})`,
      );
      if (isLoginRequest(cfg.url)) {
        if (status === 401 || looksLikeCredentialError(serverMsg)) {
          throw new JmRequestError(serverMsg || "账号或密码错误");
        }
        throw new JmRequestError(serverMsg || "登录失败", status === 429 || status >= 500);
      }
      if (status === 401 || serverMsg === "請先登入會員") {
        const error = buildUnauthorizedError("登录过期，请重新登录");
        assertCurrentSession(revision);
        throw error;
      }
      throw new JmRequestError(serverMsg, status === 429 || status >= 500);
    }

    if (isLoginRequest(cfg.url)) {
      const serverMsg = resolveServerMessage(decoded, "");
      if (looksLikeCredentialError(serverMsg)) {
        console.warn("[jm.login] credentials rejected");
        throw new JmRequestError(serverMsg);
      }
    }

    if (!meta?.readOnlyProfile && decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
      const nextJwt = String(
        (decoded as Record<string, unknown>).jwttoken || "",
      ).trim();
      if (nextJwt) {
        await setJwtToken(nextJwt, revision);
      }
    }

    // if (
    //   !meta?.fromCache &&
    //   meta?.cacheEnabled &&
    //   String(cfg.method || "GET").toUpperCase() === "GET"
    // ) {
    //   await setCachedResponse(
    //     {
    //       method: String(cfg.method || "GET").toUpperCase(),
    //       url: String(cfg.url || ""),
    //       params: cfg.params as Record<string, unknown> | undefined,
    //       data: cfg.data,
    //     },
    //     decoded,
    //   );
    // }

    response.data = decoded;
    return response;
  }

  client.interceptors.request.use(async (config) => {
    const cfg = config as JmRequestConfig;
    const method = String(cfg.method || "GET").toUpperCase();
    const url = String(cfg.url || "");
    const meta: JmMeta = cfg.__jmMeta || {
      ts: nowTs(),
      cacheEnabled: false,
      useJwt: true,
      sessionRevision: currentSessionRevision(),
    };
    const revision = meta.sessionRevision ?? currentSessionRevision();
    meta.sessionRevision = revision;
    assertCurrentSession(revision);

    const token = await md5Hex(`${meta.ts}${Config.JM_VERSION}`);
    const authHeaders: Record<string, string> = {
      token,
      tokenparam: `${meta.ts},${Config.JM_VERSION}`,
      "user-agent": await getUserAgent(),
    };

    const host = getHost(url);
    if (host) {
      authHeaders.Host = host;
    }

    if (meta.useJwt) {
      const jwt = meta.requestJwt ?? await getJwtToken(revision);
      if (jwt) {
        authHeaders.Authorization = `Bearer ${jwt}`;
      }
    }

    assertCurrentSession(revision);

    cfg.headers = {
      ...(cfg.headers as Record<string, unknown>),
      ...authHeaders,
    } as unknown as JmRequestConfig["headers"];

    if (meta.cacheEnabled && method === "GET") {
      const cacheConfig = {
        method,
        url,
        params: cfg.params as Record<string, unknown> | undefined,
        data: cfg.data,
      };
      meta.cacheKey = cacheKeyFromConfig(cacheConfig);
      const cached = await getCachedResponse(cacheConfig);
      if (cached !== null && cached !== undefined) {
        meta.fromCache = true;
        cfg.adapter = async () => ({
          data: cached,
          status: 200,
          statusText: "OK",
          headers: {},
          config: cfg,
          request: undefined,
        });
      }
    }

    cfg.__jmMeta = meta;
    assertCurrentSession(revision);
    return cfg;
  });

  client.interceptors.response.use(
    (response: AxiosResponse) => parseResponse(response),
    async (err: unknown) => {
      const raw = err as { response?: AxiosResponse };
      if (raw?.response) {
        try {
          return await parseResponse(raw.response);
        } catch (parseErr) {
          return Promise.reject(toFriendlyError(parseErr));
        }
      }
      return Promise.reject(toFriendlyError(err));
    },
  );

  return client;
}
