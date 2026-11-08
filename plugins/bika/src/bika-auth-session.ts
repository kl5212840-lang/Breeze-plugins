import { savePluginSetting } from "./plugin-config";

let authRevision = 0;
let sessionWrites = Promise.resolve();

export class BikaAccountChangedError extends Error {
  constructor() {
    super("账号已变化，请重新读取");
  }
}
export function currentBikaAuthRevision() {
  return authRevision;
}
export function beginBikaAuthChange() {
  return ++authRevision;
}
export function assertBikaAuthRevision(revision: number) {
  if (revision !== authRevision) throw new BikaAccountChangedError();
}
export async function waitBikaSessionWrites(revision: number) {
  await sessionWrites;
  assertBikaAuthRevision(revision);
}

// Clearing is ordered after every already-started write. A rejected member of
// a parallel write must not release the queue while another member still runs.
export function saveBikaSessionValues(revision: number, values: Record<string, unknown>) {
  const task = sessionWrites.then(async () => {
    assertBikaAuthRevision(revision);
    const results = await Promise.allSettled(
      Object.entries(values).map(([key, value]) => savePluginSetting(key, value)),
    );
    assertBikaAuthRevision(revision);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  });
  sessionWrites = task.catch(() => {});
  return task;
}
