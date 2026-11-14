import ky from "ky";
import {
  COPY_AVATAR_LIMIT,
  COPY_AVATAR_SIZE_MESSAGE,
  COPY_PROFILE_ORIGIN,
  type CopyAvatarImage,
  type CopyProfileTransport,
} from "./profile-avatar";

/** Decode a canonical base64 JPEG without depending on Node Buffer in the plugin runtime. */
export function prepareCopyAvatarJpeg(value: unknown): CopyAvatarImage {
  if (typeof value === "string" && value.length > Math.ceil(COPY_AVATAR_LIMIT / 3) * 4) {
    throw new Error(COPY_AVATAR_SIZE_MESSAGE);
  }
  if (
    typeof value !== "string" ||
    !value ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new Error("请选择有效的 JPEG 头像图片");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const length = (value.length / 4) * 3 - padding;
  if (!length) throw new Error("请选择非空图片");
  if (length > COPY_AVATAR_LIMIT) throw new Error(COPY_AVATAR_SIZE_MESSAGE);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = new Uint8Array(length);
  let bits = 0,
    accumulator = 0,
    offset = 0;
  for (const character of value.slice(0, value.length - padding)) {
    accumulator = (accumulator << 6) | alphabet.indexOf(character);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset++] = (accumulator >>> bits) & 255;
    }
    accumulator &= (1 << bits) - 1;
  }
  if (accumulator !== 0 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw new Error("请选择有效的 JPEG 头像图片");
  }
  return { bytes, mime: "image/jpeg", filename: "avatar.jpg" };
}

/** Official-origin transport only. No Cookie, redirects, or retry of one-time avatar writes. */
export const copyProfileTransport: CopyProfileTransport = async (request) => {
  const url = new URL(request.url);
  const allowed =
    request.method === "GET"
      ? url.pathname === "/api/v2/web/user/update/info"
      : request.method === "POST" &&
        ["/api/v1/upload/image", "/api/v2/web/me/edit"].includes(url.pathname);
  if (
    url.origin !== COPY_PROFILE_ORIGIN ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !allowed
  ) {
    throw new Error("头像服务地址无效");
  }
  let body: FormData | URLSearchParams | undefined;
  if (request.body?.kind === "multipart") {
    const form = new FormData();
    const { image, field } = request.body;
    form.append(
      field,
      new Blob([new Uint8Array(image.bytes)], { type: image.mime }),
      image.filename,
    );
    body = form;
  } else if (request.body?.kind === "form") {
    body = new URLSearchParams(request.body.values);
  }
  const headers = Object.fromEntries(
    Object.entries(request.headers).filter(([name]) => name.toLowerCase() !== "cookie"),
  );
  const response = await ky(request.url, {
    method: request.method,
    headers,
    body,
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    retry: 0,
    timeout: request.timeoutMs ?? 20_000,
    throwHttpErrors: false,
  });
  if (response.ok) return response.json<unknown>();
  if (response.status < 400 || response.status >= 500) throw new Error("头像服务响应异常");
  // Preserve the HTTP classification; the body may contain a policy message
  // but may also be an HTML gateway page. Never trust a body code of 200 here.
  try {
    const body = await response.json<{ message?: unknown }>();
    return { code: response.status, message: body?.message };
  } catch {
    return { code: response.status };
  }
};
