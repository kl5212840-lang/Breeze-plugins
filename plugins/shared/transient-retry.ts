// Source-independent retry primitives. Errors carry only a safe message and
// retry classification; never retain an HTTP request, body, headers or cause.
export class RetryableRequestError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    readonly status?: number,
    readonly retryAfter?: string,
  ) {
    super(message);
  }
}

export function safeRetryAfter(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  if (/^\d{1,10}$/.test(text)) return text;
  if (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text) &&
      Number.isFinite(Date.parse(text))) return text;
  return undefined;
}

export function httpFailureEvidence(status: number, retryAfter?: string): string {
  return `HTTP ${status}${retryAfter === undefined ? "" : ` Retry-After: ${retryAfter}`}`;
}

export function isTransientError(error: unknown): boolean {
  if (error instanceof RetryableRequestError) return error.retryable;
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  return [
    "ECONNABORTED",
    "ETIMEDOUT",
    "ERR_NETWORK",
    "ECONNRESET",
    "ENETUNREACH",
    "EAI_AGAIN",
  ].includes(code);
}

// Three total attempts, preserving the existing JM 1s/2s backoff contract.
export async function retryTransient<T>(
  operation: () => Promise<T>,
  assertActive: () => void,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    assertActive();
    try {
      const result = await operation();
      assertActive();
      return result;
    } catch (error) {
      assertActive();
      if (attempt >= 2 || !isTransientError(error) ||
          (error instanceof RetryableRequestError &&
            (error.status === 429 || error.retryAfter !== undefined))) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, (attempt + 1) * 1000));
    }
  }
}
