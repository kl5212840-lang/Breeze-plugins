import type { InternalAxiosRequestConfig } from "axios";

export type JmLikeStage = {
  http?: number;
  result: "login-required" | "http-rejected" | "business-rejected" | "unreadable" | "readable" | "transport";
};

export type JmLikeDiagnostic = {
  submit?: JmLikeStage;
  readback?: JmLikeStage;
  verify?: {
    result: "confirmed" | "unconfirmed";
    work: "match" | "mismatch" | "unknown";
    likedType: string;
    liked: "true" | "false" | "unknown";
    total: "present" | "invalid" | "missing";
    totalChange: "changed" | "unchanged" | "unknown";
  };
};

export type RequestPayload = {
  path?: string;
  url?: string;
  method?: string;
  params?: Record<string, unknown>;
  data?: unknown;
  formData?: Record<string, unknown>;
  cache?: boolean;
  comicFollow?: boolean;
  comicLike?: boolean;
  likeDiagnostic?: () => JmLikeDiagnostic;
  comicFavorite?: boolean;
  readOnlyProfile?: boolean;
  useJwt?: boolean;
  jwtToken?: string;
};

export type JmMeta = {
  ts: string;
  cacheEnabled: boolean;
  cacheKey?: string;
  comicFollow?: boolean;
  comicLike?: boolean;
  likeDiagnostic?: () => JmLikeDiagnostic;
  comicFavorite?: boolean;
  readOnlyProfile?: boolean;
  useJwt: boolean;
  requestJwt?: string;
  fromCache?: boolean;
  sessionRevision?: number;
};

export type JmRequestConfig = InternalAxiosRequestConfig & {
  __jmMeta?: JmMeta;
};

export type CacheKeyConfig = {
  method: string;
  url: string;
  params?: Record<string, unknown>;
  data?: unknown;
};
