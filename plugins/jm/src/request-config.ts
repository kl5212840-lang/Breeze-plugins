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

  const headers: Record<string, string | false> = {};
  const folderReadback = method === "GET" ? input.folderReadbackTimeoutMs : undefined;
  if (method === "GET" && (input.freshRead || folderReadback !== undefined)) {
    headers["cache-control"] = "no-cache";
  }
  const inputJwt = String(input.jwtToken || "").trim();
  const protectSession = input.readOnlyProfile || input.comicFavorite;
  if (inputJwt && !input.comicFollow && !protectSession) {
    await setJwtToken(inputJwt, revision);
  }

  let body = input.data;
  if (method === "POST" && input.formData) {
    if (input.multipartForm) {
      const form = new FormData();
      for (const [name, value] of Object.entries(input.formData)) {
        if (value != null) form.append(name, String(value));
      }
      body = form;
      // Keep Axios from applying its default POST content type in the
      // headless runtime. Fetch provides the boundary for this FormData.
      headers["content-type"] = false;
    } else {
      body = toQueryString(input.formData);
      headers["content-type"] = "application/x-www-form-urlencoded";
    }
  } else if (method === "POST" && typeof body === "string") {
    headers["content-type"] =
      headers["content-type"] || "application/x-www-form-urlencoded";
  }

  const cacheEnabled = !input.comicFollow && !input.comicFavorite && !input.freshRead && input.cache === true;
  const restrictRedirect = (input.comicFollow && requestJwt) || protectSession;
  const readScope = method === "GET" || method === "HEAD" ? input.readScope : undefined;
  const config: JmRequestConfig = {
    method,
    url,
    params: input.params,
    data: body,
    headers: headers as unknown as JmRequestConfig["headers"],
    timeout: folderReadback ?? 10000,
    responseType: "arraybuffer",
    validateStatus: () => true,
    ...((input.comicFollow || protectSession) && { withCredentials: false }),
    ...(restrictRedirect && { maxRedirects: 0 }),
    ...((restrictRedirect || readScope) && {
      fetchOptions: {
        ...(restrictRedirect && { redirect: "error" }),
        ...(readScope && { breezeReadScope: readScope }),
      },
    }),
    __jmMeta: {
      ts: nowTs(),
      cacheEnabled,
      comicFollow: input.comicFollow,
      comicFavorite: input.comicFavorite,
      favoriteFolderCreate: input.comicFavorite === true && method === "POST" &&
        input.multipartForm === true && input.formData?.type === "add",
      readOnlyProfile: input.readOnlyProfile,
      useJwt: input.useJwt !== false,
      requestJwt,
      sessionRevision: revision,
    },
  };

  return { config, cacheEnabled };
}
