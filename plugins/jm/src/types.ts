import type { InternalAxiosRequestConfig } from "axios";

export type RequestPayload = {
  path?: string;
  url?: string;
  method?: string;
  params?: Record<string, unknown>;
  data?: unknown;
  formData?: Record<string, unknown>;
  multipartForm?: boolean;
  cache?: boolean;
  comicFollow?: boolean;
  comicFavorite?: boolean;
  folderReadbackTimeoutMs?: number;
  freshRead?: boolean;
  readOnlyProfile?: boolean;
  readScope?: string;
  useJwt?: boolean;
  jwtToken?: string;
};

export type JmMeta = {
  ts: string;
  cacheEnabled: boolean;
  cacheKey?: string;
  comicFollow?: boolean;
  comicFavorite?: boolean;
  favoriteFolderCreate?: boolean;
  readOnlyProfile?: boolean;
  useJwt: boolean;
  requestJwt?: string;
  assertScopedRequest?: () => Promise<void>;
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
