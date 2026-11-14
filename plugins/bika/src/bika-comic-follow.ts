import { buildUnauthorizedError } from "breeze-plugin-kit";
import {
  assertBikaAuthRevision,
  BikaAccountChangedError,
  currentBikaAuthRevision,
} from "./bika-auth-session";
import { BIKA_PLUGIN_ID } from "./bika-identity";
import { bikaRequest } from "./bika-request";
import type { ComicDetailPayload } from "./bika-types";
import { toStringMap } from "./bika-utils";
import {
  assertBikaLine,
  BikaRequestError,
  captureBikaLine,
  getApiBase,
  isBikaUnauthorizedEnvelope,
} from "./client";
import { loadPluginSetting } from "./plugin-config";

const defaultPageSize = 40;
const maximumPages = 100;
const parallelPages = 3;
const requestWindowMs = 15_000;

type FailureReason = "network" | "invalidResponse" | "sourceUnavailable";

class FollowReadError extends Error {
  constructor(
    readonly reason: FailureReason,
    readonly retryable = false,
  ) {
    super(reason);
  }

  toEnvelope() {
    return { type: "comic_follow_error", reason: this.reason, retryable: this.retryable } as const;
  }
}

function count(value: unknown): number | null {
  if (typeof value === "string" && /^\d+$/.test(value.trim())) value = Number(value);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function validateNumber(value: unknown): number | null {
  const number = count(value);
  if (number === null && value != null) throw new FollowReadError("invalidResponse");
  return number;
}

// A tracking check reads only comic identity and the current chapter list.
// The ordinary detail and reading adapters retain their cached content.
export async function getComicFollowDetail(payload: ComicDetailPayload) {
  const comicId = String(payload.comicId ?? "").trim();
  if (!comicId) return new FollowReadError("invalidResponse").toEnvelope();
  const deadline = Date.now() + requestWindowMs;
  const revision = currentBikaAuthRevision();
  const line = await captureBikaLine();
  const apiBase = await getApiBase();
  const loadAuthorization = async () =>
    String(await loadPluginSetting("auth.authorization", "")).trim();
  const authorization = await loadAuthorization();
  const assertCurrent = async () => {
    await assertBikaLine(line);
    if ((await loadAuthorization()) !== authorization) throw new BikaAccountChangedError();
    assertBikaAuthRevision(revision);
  };

  const url = `${apiBase}comics/${encodeURIComponent(comicId)}`;
  const read = async (target: string) => {
    if (Date.now() >= deadline) throw new FollowReadError("network", true);
    const response = toStringMap(
      await bikaRequest({
        url: target,
        method: "GET",
        authorization,
        assertAuthorization: assertCurrent,
        requireStructuredUnauthorized: true,
      }),
    );
    await assertCurrent();
    if (Date.now() >= deadline) throw new FollowReadError("network", true);
    const status = validateNumber(response.code);
    if (isBikaUnauthorizedEnvelope(response)) throw buildUnauthorizedError(BIKA_PLUGIN_ID);
    if (status === 408) throw new FollowReadError("network", true);
    if (status !== null && status !== 200) throw new FollowReadError("sourceUnavailable");
    if (response.error || response.success === false) throw new FollowReadError("invalidResponse");
    return toStringMap(response.data);
  };
  const readPage = async (page: number) => toStringMap((await read(`${url}/eps?page=${page}`)).eps);

  try {
    const comic = toStringMap((await read(url)).comic);
    if (comic._id !== comicId) throw new FollowReadError("invalidResponse");
    const detailCount = count(comic.epsCount);

    const first = await readPage(1);
    const total = validateNumber(first.total);
    const pageSize = validateNumber(first.limit) ?? defaultPageSize;
    const advertisedPages = validateNumber(first.pages);
    const expected = total ?? detailCount;
    if (pageSize < 1 || pageSize > 100 || (advertisedPages === null && expected === null)) {
      throw new FollowReadError("invalidResponse");
    }
    const pageCount = Math.max(1, advertisedPages ?? Math.ceil(expected! / pageSize));
    if (
      pageCount > maximumPages ||
      (total !== null && pageCount !== Math.max(1, Math.ceil(total / pageSize)))
    ) {
      throw new FollowReadError("invalidResponse");
    }

    const ids = new Set<string>();
    const orders = new Set<number>();
    const eps: Array<{ id: string; name: string; order: number }> = [];
    const append = (raw: Awaited<ReturnType<typeof readPage>>, page: number) => {
      const index = validateNumber(raw.page);
      const declaredPages = validateNumber(raw.pages);
      const declaredTotal = validateNumber(raw.total);
      const declaredLimit = validateNumber(raw.limit);
      const docs: unknown = raw.docs;
      if (
        (index !== null && index !== page) ||
        (declaredPages !== null && Math.max(1, declaredPages) !== pageCount) ||
        (total !== null && declaredTotal !== null && declaredTotal !== total) ||
        (declaredLimit !== null && declaredLimit !== pageSize) ||
        !Array.isArray(docs) ||
        docs.length > pageSize ||
        (declaredPages === 0 && docs.length !== 0) ||
        (page < pageCount && docs.length !== pageSize) ||
        (pageCount > 1 && docs.length === 0)
      ) {
        throw new FollowReadError("invalidResponse");
      }
      for (const rawEpisode of docs) {
        const { _id: id, title: name, order: rawOrder } = toStringMap(rawEpisode);
        const order = count(rawOrder);
        if (
          typeof id !== "string" ||
          !id.trim() ||
          typeof name !== "string" ||
          order === null ||
          order < 1 ||
          ids.has(id) ||
          orders.has(order)
        ) {
          throw new FollowReadError("invalidResponse");
        }
        ids.add(id);
        orders.add(order);
        eps.push({ id, name, order });
      }
    };

    append(first, 1);
    for (let page = 2; page <= pageCount; page += parallelPages) {
      const responses = await Promise.all(
        Array.from({ length: Math.min(parallelPages, pageCount - page + 1) }, (_, i) =>
          readPage(page + i),
        ),
      );
      responses.forEach((response, i) => append(response, page + i));
    }
    if (
      (total !== null && total !== eps.length) ||
      (total === null && detailCount !== null && detailCount > eps.length) ||
      (eps.length === 0 && expected !== 0)
    ) {
      throw new FollowReadError("invalidResponse");
    }

    eps.sort((a, b) => a.order - b.order);
    return { source: BIKA_PLUGIN_ID, data: { normal: { comicInfo: { id: comicId }, eps } } };
  } catch (error) {
    if (error instanceof FollowReadError) return error.toEnvelope();
    if (error instanceof BikaRequestError) {
      if (error.status === 408 || (error.status === undefined && error.retryable)) {
        return new FollowReadError("network", true).toEnvelope();
      }
      if (error.status !== undefined) return new FollowReadError("sourceUnavailable").toEnvelope();
    }
    throw error;
  }
}
