import type { AxiosResponse } from "axios";
import axios from "axios";
import { decodeResponsePayload } from "./codec";
import { Config } from "./constants";
import { JmRequestError, resolveServerMessage, toFriendlyError } from "./errors";
import {
  cacheKeyFromConfig,
  getCachedResponse,
  getJwtToken,
  getUserAgent,
  setJwtToken,
  assertCurrentSession,
  currentSessionRevision,
} from "./state";
import type { JmMeta, JmRequestConfig } from "./types";
import { getHost, md5Hex, nowTs } from "./utils";

type UnauthorizedErrorPayload = {
  type: "unauthorized";
  source: string;
  message: string;
  scheme?: Record<string, unknown>;
  data?: Record<string, unknown>;
};

const JM_PLUGIN_ID = "6886291b-f524-441c-844b-c2efae9899a9";

let unauthorizedSchemeProvider:
  | (() => Promise<Record<string, unknown> | undefined>)
  | null = null;

export function setUnauthorizedSchemeProvider(
  provider: () => Promise<Record<string, unknown> | undefined>,
) {
  unauthorizedSchemeProvider = provider;
}

export async function buildUnauthorizedError(
  message = "登录过期，请重新登录",
): Promise<Error> {
  const payload: UnauthorizedErrorPayload = {
    type: "unauthorized",
    source: JM_PLUGIN_ID,
    message,
  };
  try {
    const bundle = await unauthorizedSchemeProvider?.();
    if (bundle && typeof bundle === "object") {
      payload.scheme = (bundle.scheme as Record<string, unknown>) ?? undefined;
      payload.data = (bundle.data as Record<string, unknown>) ?? undefined;
    }
  } catch (_) {
    // ignore scheme build errors
  }
  return new Error(JSON.stringify(payload));
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

    const decoded = await decodeResponsePayload(
      response.data,
      meta?.ts || nowTs(),
    );
    const status = Number(response.status || 0);
    assertCurrentSession(revision);

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
        const error = await buildUnauthorizedError("登录过期，请重新登录");
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

    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
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
      const jwt = await getJwtToken(revision);
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
