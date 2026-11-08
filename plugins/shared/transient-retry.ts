// Source-independent retry primitives. Errors carry only a safe message and
// retry classification; never retain an HTTP request, body, headers or cause.
export class RetryableRequestError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
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
      if (attempt >= 2 || !isTransientError(error)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, (attempt + 1) * 1000));
    }
  }
}
