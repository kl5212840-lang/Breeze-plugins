export type BikaRequestPayload = {
  url: string;
  method?: string;
  /** Per-read budget for optional follow-up requests. */
  timeoutMs?: number;
  readScope?: string;
  body?: unknown;
  cache?: boolean;
  /** Internal response shape, relative to the upstream data object. */
  cacheArray?: readonly string[];
  refresh?: boolean;
  imageQuality?: string;
  /** Internal authenticated operations pin one authorization identity. */
  authorization?: string;
  assertAuthorization?: () => Promise<void>;
  /** Internal operations can retain a route across related requests. */
  lineSnapshot?: string;
  appChannel?: string;
  /** Require a Bika error envelope before treating an HTTP 401 as a login requirement. */
  requireStructuredUnauthorized?: boolean;
};

export type ComicDetailPayload = {
  comicId?: string;
  refresh?: boolean;
  extern?: Record<string, unknown>;
};

export type BikaSearchPayload = {
  __breezeReadScope?: string;
  keyword?: string;
  page?: number;
  extern?: Record<string, unknown>;
};

export type BikaChapterPayload = {
  comicId?: string;
  chapterId?: number | string;
  extern?: Record<string, unknown>;
};

export type BikaReadSnapshotPayload = {
  comicId?: string;
  chapterId?: number | string;
  extern?: Record<string, unknown>;
};

export type BikaHomePayload = {
  __breezeReadScope?: string;
  refresh?: boolean;
  extern?: Record<string, unknown>;
  imageQuality?: string;
};

export type BikaRankingPayload = {
  __breezeReadScope?: string;
  refresh?: boolean;
  days?: string;
  type?: string;
  extern?: Record<string, unknown>;
  imageQuality?: string;
};

export type RankingFilterOption = {
  label: string;
  value: string;
  result: Record<string, unknown>;
};

export type BikaLoginPayload = {
  account?: string;
  password?: string;
  extern?: Record<string, unknown>;
  imageQuality?: string;
};

export type BikaFavoritePayload = {
  __breezeReadScope?: string;
  page?: number;
  extern?: Record<string, unknown>;
  imageQuality?: string;
};

export type BikaLikePayload = {
  comicId?: string;
  currentLiked?: boolean;
  previousTotalLikes?: number;
  extern?: Record<string, unknown>;
};

export type BikaToggleFavoritePayload = {
  comicId?: string;
  currentFavorite?: boolean;
  extern?: Record<string, unknown>;
};

export type BikaFavoriteFolderPayload = {
  comicId?: string;
  folderId?: string;
  folderName?: string;
  extern?: Record<string, unknown>;
};

export type BikaCommentFeedPayload = {
  comicId?: string;
  page?: number;
  commentId?: string;
  content?: string;
  extern?: Record<string, unknown>;
};
