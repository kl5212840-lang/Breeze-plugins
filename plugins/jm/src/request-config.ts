import { assertCurrentSession, currentSessionRevision, setJwtToken } from "./state";
import type { JmRequestConfig, RequestPayload } from "./types";
import { nowTs, toQueryString } from "./utils";

export async function buildRequestConfig(
  input: RequestPayload,
  revision = currentSessionRevision(),
  requestJwt?: string,
): Promise<{
  config: JmRequestConfig;
  cacheEnabled: boolean;
}> {
  assertCurrentSession(revision);
  const method = String(input.method || "GET").toUpperCase();
  const url = String(input.path || input.url || "").trim();
  if (!url) {
    throw new Error("请求地址不能为空");
  }

  const headers: Record<string, string> = {};
  const inputJwt = String(input.jwtToken || "").trim();
  const protectSession = input.readOnlyProfile || input.comicFavorite;
  if (inputJwt && !input.comicFollow && !input.comicLike && !protectSession) {
    await setJwtToken(inputJwt, revision);
  }

  let body = input.data;
  if (method === "POST" && input.formData) {
    body = toQueryString(input.formData);
    headers["content-type"] = "application/x-www-form-urlencoded";
  } else if (method === "POST" && typeof body === "string") {
    headers["content-type"] =
      headers["content-type"] || "application/x-www-form-urlencoded";
  }

  const cacheEnabled = !input.comicFollow && !input.comicLike && !input.comicFavorite && input.cache === true;
  const config: JmRequestConfig = {
    method,
    url,
    params: input.params,
    data: body,
    headers: headers as unknown as JmRequestConfig["headers"],
    timeout: 10000,
    responseType: "arraybuffer",
    validateStatus: () => true,
    ...((input.comicFollow || protectSession) && { withCredentials: false }),
    ...(((input.comicFollow && requestJwt) || input.comicLike || protectSession) && {
      maxRedirects: 0,
      // Keep the redirect status available for like operations without
      // sending the write or credentials to a Location target.
      fetchOptions: { redirect: input.comicLike ? "manual" : "error" },
    }),
    __jmMeta: {
      ts: nowTs(),
      cacheEnabled,
      comicFollow: input.comicFollow,
      comicLike: input.comicLike,
      likeDiagnostic: input.likeDiagnostic,
      comicFavorite: input.comicFavorite,
      readOnlyProfile: input.readOnlyProfile,
      useJwt: input.useJwt !== false,
      requestJwt,
      sessionRevision: revision,
    },
  };

  return { config, cacheEnabled };
}
