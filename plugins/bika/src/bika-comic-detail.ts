import type {
  ChapterContentContract,
  ChapterPage,
  ChapterWithPages,
  ComicDetailContract,
  ReadSnapshotContract,
  StringMap,
} from "breeze-plugin-kit";
import {
  createActionItem,
  createImage,
  createMetadataActionList,
  ensureBikaComicShape,
  openSearchAction,
  toComicListItem,
} from "./bika-comic-shared";
import { buildBikaImageUrl } from "./bika-image";
import { bikaRequest } from "./bika-request";
import type { BikaChapterPayload, BikaReadSnapshotPayload, ComicDetailPayload } from "./bika-types";
import { toBool, toNum, toStringMap } from "./bika-utils";
import { getApiBase } from "./client";
import { BIKA_PLUGIN_ID } from "./info";
import { loadPluginSetting } from "./plugin-config";

export async function getComicDetail(
  payload: ComicDetailPayload = {},
): Promise<ComicDetailContract> {
  const apiBase = await getApiBase();
  const comicId = String(payload.comicId ?? "").trim();
  if (!comicId) {
    throw new Error("comicId 不能为空");
  }

  const infoResponse = (await bikaRequest({
    url: `${apiBase}comics/${comicId}`,
    method: "GET",
  })) as StringMap;

  const comic: StringMap = toStringMap(toStringMap(infoResponse.data).comic);
  ensureBikaComicShape(comic as Record<string, unknown>);

  const epsCount = toNum(comic.epsCount, 0);
  const firstEpsResponse = await bikaRequest({
    url: `${apiBase}comics/${comicId}/eps?page=1`,
    method: "GET",
    cache: true,
  });
  const firstEps = toStringMap(toStringMap(toStringMap(firstEpsResponse).data).eps);
  const pageValue = firstEps.pages;
  const reportedPages =
    typeof pageValue === "number" || (typeof pageValue === "string" && pageValue.trim().length > 0)
      ? toNum(pageValue, Number.NaN)
      : Number.NaN;
  // The chapter endpoint owns its pagination. The detail count can be stale;
  // use its 40-chapter estimate only when page metadata is unavailable.
  const totalPages =
    Number.isSafeInteger(reportedPages) && reportedPages >= 0
      ? Math.max(1, reportedPages)
      : Math.max(1, Math.ceil(epsCount / 40));
  const remainingEpsResponses = await Promise.all(
    Array.from({ length: totalPages - 1 }, (_, index) =>
      bikaRequest({
        url: `${apiBase}comics/${comicId}/eps?page=${index + 2}`,
        method: "GET",
        cache: true,
      }),
    ),
  );
  const epsResponses = [firstEpsResponse, ...remainingEpsResponses];

  const epsDocs: StringMap[] = epsResponses
    .flatMap((item) => toStringMap(toStringMap(toStringMap(item).data).eps).docs ?? [])
    .filter((item): item is StringMap => !!item && typeof item === "object" && !Array.isArray(item))
    .sort((a, b) => toNum(a.order) - toNum(b.order));

  let recommendResponse: StringMap = {};
  try {
    recommendResponse = (await bikaRequest({
      url: `${apiBase}comics/${comicId}/recommendation`,
      method: "GET",
      cache: true,
    })) as StringMap;
  } catch {
    // Recommendations are optional. Essential detail/chapter failures above
    // still reject; an unavailable recommendation must not block reading.
  }

  const recommendRaw = toStringMap(recommendResponse.data).comics;
  const recommend: StringMap[] = (Array.isArray(recommendRaw) ? recommendRaw : [])
    .filter((item): item is StringMap => !!item && typeof item === "object" && !Array.isArray(item))
    .map((item: StringMap) => {
      const next: StringMap = { ...item };
      next.author ??= "";
      next.likesCount = toNum(next.likesCount, 0);
      const thumb = toStringMap(next.thumb);
      thumb.fileServer ??= "";
      thumb.path ??= "";
      thumb.originalName ??= "";
      next.thumb = thumb;
      return next;
    });
  const recommendItems = await Promise.all(
    recommend.map(async (item: StringMap) => {
      const unified = await toComicListItem(item, {
        pictureType: "cover",
      });
      return {
        source: unified.source,
        id: unified.id,
        title: unified.title,
        subtitle: unified.subtitle,
        finished: unified.finished,
        likesCount: unified.likesCount,
        viewsCount: unified.viewsCount,
        updatedAt: unified.updatedAt,
        cover: unified.cover,
        metadata: unified.metadata,
        raw: unified.raw,
        extern: unified.extern,
      };
    }),
  );

  const normal = {
    comicInfo: {
      id: String(comic._id ?? comicId),
      title: String(comic.title ?? ""),
      titleMeta: [
        createActionItem(`浏览：${toNum(comic.totalViews)}`),
        createActionItem(`更新时间：${String(comic.updated_at ?? new Date().toISOString())}`),
        ...(toNum(comic.pagesCount) > 0
          ? [createActionItem(`页数：${toNum(comic.pagesCount)}`)]
          : []),
        createActionItem(`章节数：${toNum(comic.epsCount)}`),
      ],
      creator: {
        id: "",
        name: "",
        avatar: createImage({
          id: "",
          url: "",
          name: "",
          path: "",
          extern: {},
        }),
        onTap: null,
        extern: {} as StringMap,
      },
      description: String(comic.description ?? ""),
      cover: createImage({
        id: String(comic._id ?? comicId),
        url: await buildBikaImageUrl(
          toStringMap(comic.thumb).fileServer,
          toStringMap(comic.thumb).path,
          "cover",
        ),
        path: String(toStringMap(comic.thumb).path ?? "").replace(/[^a-zA-Z0-9_\-.]/g, "_"),
        name: String(toStringMap(comic.thumb).originalName ?? ""),
      }),
      metadata: [
        createMetadataActionList("author", "作者", comic.author, (item) =>
          createActionItem(item, openSearchAction({ source: BIKA_PLUGIN_ID, keyword: item })),
        ),
        createMetadataActionList("chineseTeam", "汉化组", comic.chineseTeam, (item) =>
          createActionItem(item, openSearchAction({ source: BIKA_PLUGIN_ID, keyword: item })),
        ),
        createMetadataActionList("categories", "分类", comic.categories, (item) =>
          createActionItem(
            item,
            openSearchAction({
              source: BIKA_PLUGIN_ID,
              categories: [item],
            }),
          ),
        ),
        createMetadataActionList("tags", "标签", comic.tags, (item) =>
          createActionItem(item, openSearchAction({ source: BIKA_PLUGIN_ID, keyword: item })),
        ),
      ].filter((item): item is NonNullable<typeof item> => item != null),
      extern: {} as StringMap,
    },
    eps: epsDocs.map((item: StringMap) => ({
      id: String(item._id ?? ""),
      requestId: String(toNum(item.order)),
      logicalKey: "",
      storageChapterId: "",
      name: String(item.title ?? ""),
      order: toNum(item.order),
      extern: {} as StringMap,
    })),
    recommend: recommendItems,
    totalViews: toNum(comic.totalViews),
    totalLikes: toNum(comic.totalLikes),
    totalComments: toNum(comic.totalComments),
    isFavourite: toBool(comic.isFavourite),
    isLiked: toBool(comic.isLiked),
    allowComments: toBool(comic.allowComment, false),
    allowLike: true,
    allowCollected: true,
    allowDownload: true,
    extern: {} as StringMap,
  };

  return {
    source: BIKA_PLUGIN_ID as string,
    comicId,
    extern: (payload.extern ?? null) as Record<string, unknown> | null,
    scheme: {
      version: "1.0.0" as const,
      type: "comicDetail" as const,
      source: BIKA_PLUGIN_ID,
    },
    data: {
      normal,
      raw: {
        comicInfo: comic,
        eps: epsDocs,
        recommend,
      },
    },
  } satisfies ComicDetailContract;
}

export async function getChapter(
  payload: BikaChapterPayload = {},
): Promise<ChapterContentContract> {
  const apiBase = await getApiBase();
  void (await loadPluginSetting("network.proxy", "3"));
  const comicId = String(payload.comicId ?? "").trim();
  const chapterId = toNum(payload.chapterId, 0);
  if (!comicId) {
    throw new Error("comicId 不能为空");
  }
  if (!chapterId) {
    throw new Error("chapterId 不能为空");
  }

  const docs: ChapterPage[] = [];
  let page = 1;
  let totalPages = 1;
  let epId = "";
  let epName = "";

  while (page <= totalPages) {
    const result = (await bikaRequest({
      url: `${apiBase}comics/${comicId}/order/${chapterId}/pages?page=${page}`,
      method: "GET",
      cache: true,
    })) as StringMap;
    const data = toStringMap(result.data);
    const pagesData = toStringMap(data.pages);
    const ep = toStringMap(data.ep);

    epId = String(ep.id ?? ep._id ?? epId);
    epName = String(ep.title ?? epName);
    totalPages = toNum(pagesData.pages, 1);

    const pageDocs: StringMap[] = (Array.isArray(pagesData.docs) ? pagesData.docs : []).filter(
      (item): item is StringMap => !!item && typeof item === "object" && !Array.isArray(item),
    );
    for (const doc of pageDocs) {
      const media = toStringMap(doc.media);
      docs.push({
        name: String(media.originalName ?? ""),
        path: String(media.path ?? ""),
        url: await buildBikaImageUrl(media.fileServer, media.path, "comic"),
        id: String(doc.id ?? ""),
        extern: {} as StringMap,
      });
    }

    page += 1;
  }

  const chapter = {
    id: epId,
    requestId: "",
    logicalKey: "",
    storageChapterId: "",
    name: epName,
    order: chapterId,
    pages: docs,
    extern: {} as StringMap,
  } satisfies ChapterWithPages;

  return {
    source: BIKA_PLUGIN_ID,
    comicId,
    chapterId: String(chapterId),
    extern: (payload.extern ?? null) as Record<string, unknown> | null,
    scheme: {
      version: "1.0.0" as const,
      type: "chapterContent" as const,
      source: BIKA_PLUGIN_ID,
    },
    data: {
      comic: {
        id: comicId,
        source: BIKA_PLUGIN_ID,
        title: epName,
        extern: {} as StringMap,
      },
      chapter,
      chapters: [],
    },
  } satisfies ChapterContentContract;
}

export async function getReadSnapshot(
  payload: BikaReadSnapshotPayload = {},
): Promise<ReadSnapshotContract> {
  const comicId = String(payload.comicId ?? "").trim();
  if (!comicId) {
    throw new Error("comicId 不能为空");
  }

  const detail = await getComicDetail({
    comicId,
    extern: payload.extern,
  });
  const normal = toStringMap(toStringMap(detail.data).normal);
  const comicInfo = toStringMap(normal.comicInfo);

  const chapterRefs = (Array.isArray(normal.eps) ? normal.eps : [])
    .filter((item): item is StringMap => !!item && typeof item === "object" && !Array.isArray(item))
    .map((ep: StringMap) => ({
      id: String(ep.id ?? ""),
      name: String(ep.name ?? ""),
      order: toNum(ep.order, 0),
      extern: toStringMap(ep.extern),
    }));

  const chapterIdInput = String(payload.chapterId ?? "").trim();
  const externInput = toStringMap(payload.extern);
  const order = toNum(externInput.order, 0);
  const targetChapter =
    chapterRefs.find((item) => String(item.id) === chapterIdInput) ??
    chapterRefs.find((item) => toNum(item.order, 0) === order) ??
    chapterRefs.find((item) => toNum(item.order, 0) > 0) ??
    chapterRefs[0];
  const chapterOrder = toNum(targetChapter?.order, toNum(chapterIdInput, order));
  if (chapterOrder <= 0) {
    throw new Error("chapterId 不能为空");
  }

  const chapterBundle = await getChapter({
    comicId,
    chapterId: chapterOrder,
    extern: payload.extern,
  });
  const chapterData = toStringMap(toStringMap(chapterBundle.data).chapter);
  const chapterPages: StringMap[] = (
    Array.isArray(chapterData.pages) ? chapterData.pages : []
  ).filter((item): item is StringMap => !!item && typeof item === "object" && !Array.isArray(item));
  const pages = chapterPages.map((doc: StringMap) => ({
    id: String(doc.id ?? ""),
    name: String(doc.name ?? doc.originalName ?? ""),
    path: String(doc.path ?? ""),
    url: String(doc.url ?? doc.fileServer ?? ""),
    extern: toStringMap(doc.extern),
  }));

  return {
    source: BIKA_PLUGIN_ID,
    extern: (payload.extern ?? null) as Record<string, unknown> | null,
    data: {
      comic: {
        id: String(comicInfo.id ?? comicId),
        source: BIKA_PLUGIN_ID,
        title: String(comicInfo.title ?? ""),
        extern: toStringMap(comicInfo.extern),
      },
      chapter: {
        id: String(targetChapter?.id ?? ""),
        requestId: "",
        logicalKey: "",
        storageChapterId: "",
        name: String(targetChapter?.name ?? ""),
        order: chapterOrder,
        pages,
        extern: {} as StringMap,
      },
      chapters: chapterRefs,
    },
  } satisfies ReadSnapshotContract;
}
