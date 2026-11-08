/** Official web avatar protocol, deliberately unbound until API-token compatibility is verified.
 * Source: person.1b8bbe2f18a97f2437e5.js (2026copy.com public website).
 * The caller owns authentication and transport; this module never reads account configuration.
 */
export const COPY_PROFILE_ORIGIN = "https://2026copy.com";
export const COPY_AVATAR_LIMIT = 2 * 1024 * 1024;

export type CopyAvatarImage = {
  bytes: Uint8Array;
  mime: "image/jpeg" | "image/png";
  filename: string;
};
export type CopyProfileRequest = {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  // Transport must encode multipart with its own boundary, preserving file bytes/name.
  body?:
    | { kind: "multipart"; field: "file"; image: CopyAvatarImage }
    | { kind: "form"; values: Record<string, string> };
};
export type CopyProfileTransport = (request: CopyProfileRequest) => Promise<unknown>;
export type CopyEditableProfile = {
  username: string;
  nickname: string;
  avatar: string;
  gender: string;
  blood: string;
  birthday?: string;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function results(response: unknown, action: string): unknown {
  const body = record(response);
  if (body.code !== 200) {
    if (body.code === 401 || body.code === 403) throw new Error("登录已失效，请重新登录");
    // Do not echo arbitrary remote payloads, which can contain private account fields.
    throw new Error(`${action}失败，请稍后重试`);
  }
  return body.results;
}
function birthday(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(value);
  if (!match) return undefined;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === match[0].slice(0, 10)
    ? match[0].slice(0, 10)
    : undefined;
}
function choice(value: unknown): string {
  if (value == null) return "未知"; // The official edit form's explicit empty-field fallback.
  const selected = record(value).value;
  if (typeof selected !== "string" && typeof selected !== "number") {
    throw new Error("资料内容不完整，暂时无法更换头像");
  }
  return String(selected);
}
function profile(response: unknown): CopyEditableProfile {
  const info = record(record(results(response, "读取资料")).info);
  if (
    typeof info.username !== "string" ||
    !info.username ||
    typeof info.nickname !== "string" ||
    typeof info.avatar !== "string"
  ) {
    throw new Error("资料内容不完整，暂时无法更换头像");
  }
  return {
    username: info.username,
    nickname: info.nickname,
    avatar: info.avatar,
    gender: choice(info.gender),
    blood: choice(info.blood),
    birthday: birthday(info.datetime_birthday),
  };
}
function validateImage(image: CopyAvatarImage) {
  if (image.mime !== "image/jpeg" && image.mime !== "image/png") {
    throw new Error("请选择 JPEG 或 PNG 图片");
  }
  if (!image.bytes.length || image.bytes.length >= COPY_AVATAR_LIMIT) {
    throw new Error("请选择小于 2MiB 的非空图片");
  }
  const b = image.bytes;
  const jpeg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => b[i] === v);
  if ((image.mime === "image/jpeg" && !jpeg) || (image.mime === "image/png" && !png)) {
    throw new Error("图片内容与格式不符，请重新选择");
  }
  if (!image.filename.trim() || /[\r\n\0]/.test(image.filename)) {
    throw new Error("图片文件名无效，请重新选择");
  }
}

/** The write succeeded; only a read may be retried, never the avatar upload. */
export class CopyAvatarSubmittedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CopyAvatarSubmittedError";
  }
}

export function createCopyAvatarHelper(transport: CopyProfileTransport, token: string) {
  if (!token.trim() || /[\r\n]/.test(token)) throw new Error("请先登录");
  const authorization = `Token ${token}`;
  const send = async (request: CopyProfileRequest): Promise<unknown> => {
    try {
      return await transport(request);
    } catch {
      throw new Error("网络请求失败，请稍后重试");
    }
  };
  const read = async () =>
    profile(
      await send({
        url: `${COPY_PROFILE_ORIGIN}/api/v2/web/user/update/info`,
        method: "GET",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: authorization,
          platform: "2",
        },
      }),
    );
  return {
    read,
    async update(image: CopyAvatarImage | null): Promise<CopyEditableProfile | null> {
      if (image === null) return null;
      validateImage(image);
      const before = await read();
      const handle = results(
        await send({
          url: `${COPY_PROFILE_ORIGIN}/api/v1/upload/image`,
          method: "POST",
          headers: { Authorization: authorization },
          body: { kind: "multipart", field: "file", image },
        }),
        "上传头像",
      );
      // The website passes this opaque string unchanged, rather than deriving an image URL.
      if (typeof handle !== "string" || !handle.trim()) throw new Error("上传结果无效，头像未保存");
      const values: Record<string, string> = {
        nickname: before.nickname,
        gender: before.gender,
        blood: before.blood,
        avatar: handle,
      };
      if (before.birthday) values.birthday = before.birthday;
      let saved: unknown;
      try {
        saved = await send({
          url: `${COPY_PROFILE_ORIGIN}/api/v2/web/me/edit`,
          method: "POST",
          headers: {
            Authorization: authorization,
            platform: "2",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          },
          body: { kind: "form", values },
        });
      } catch {
        // A timeout/transport failure does not prove that the one-time write
        // failed. Never offer a repeat upload after crossing this boundary.
        throw new CopyAvatarSubmittedError("头像提交结果暂未确认，请刷新资料查看");
      }
      results(saved, "保存头像");
      let after: CopyEditableProfile;
      try {
        after = await read();
      } catch {
        throw new CopyAvatarSubmittedError("头像已提交，暂时无法确认结果，请刷新资料");
      }
      if (after.username !== before.username || !after.avatar || after.avatar === before.avatar) {
        throw new CopyAvatarSubmittedError("头像已提交，尚未确认更新，请刷新资料");
      }
      return after;
    },
  };
}
