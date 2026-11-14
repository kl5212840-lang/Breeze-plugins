import { RetryableRequestError } from "../../shared/transient-retry";
export { isTransientError, retryTransient } from "../../shared/transient-retry";

export function resolveServerMessage(data: unknown, fallback: string): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return fallback;
  }

  const map = data as Record<string, unknown>;
  const raw = map.errorMsg ?? map.msg ?? map.message;
  const text = String(raw || "").trim();
  return text || fallback;
}

export function toFriendlyNetworkError(err: unknown): string {
  const code = String((err as { code?: string } | null)?.code || "");
  const message = String(
    (err as { message?: string } | null)?.message || "",
  ).toLowerCase();

  if (code === "ECONNABORTED" || message.includes("timeout")) {
    return "连接服务器超时";
  }
  if (code === "ERR_NETWORK") {
    return "网络连接失败";
  }
  if (code === "ERR_CANCELED") {
    return "请求被取消";
  }
  return "未知网络错误";
}

export function toFriendlyError(err: unknown): Error {
  if (err instanceof Error && err.message.trim()) {
    return err;
  }
  return new Error(toFriendlyNetworkError(err));
}
export class JmRequestError extends RetryableRequestError {
  constructor(message: string, retryable = false) {
    super(message, retryable);
    this.name = "JmRequestError";
  }
}

type JmFollowFailure =
  | "network"
  | "sourceUnavailable"
  | "invalidResponse"
  | "signInRequired"
  | "notFound";

export class JmFollowError extends Error {
  constructor(readonly reason: JmFollowFailure, retryable = false) {
    super(JSON.stringify({ type: "comic_follow_error", reason, retryable }));
  }
}
