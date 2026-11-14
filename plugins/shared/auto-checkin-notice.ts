export async function notifyAutoCheckinCompleted(accountId: string, date: string) {
  const host = globalThis as typeof globalThis & {
    bridge?: { call(name: string, payload: string): unknown };
  };
  try {
    await host.bridge?.call("breeze.checkin.completed", JSON.stringify({ accountId, date }));
  } catch {
    // Older hosts lack the notice capability. The check-in still completed.
  }
}
