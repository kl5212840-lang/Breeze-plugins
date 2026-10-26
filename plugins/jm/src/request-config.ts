import { assertCurrentSession, currentSessionRevision, setJwtToken } from "./state";
import type { JmRequestConfig, RequestPayload } from "./types";
import { nowTs, toQueryString } from "./utils";

export async function buildRequestConfig(input: RequestPayload, revision = currentSessionRevision()): Promise<{
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
  if (inputJwt) {
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

  const cacheEnabled = input.cache === true;
  const config: JmRequestConfig = {
    method,
    url,
    params: input.params,
    data: body,
    headers: headers as unknown as JmRequestConfig["headers"],
    timeout: 10000,
    responseType: "arraybuffer",
    validateStatus: () => true,
    __jmMeta: {
      ts: nowTs(),
      cacheEnabled,
      useJwt: input.useJwt !== false,
      sessionRevision: revision,
    },
  };

  return { config, cacheEnabled };
}
