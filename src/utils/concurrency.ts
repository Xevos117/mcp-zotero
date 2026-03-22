export const DEFAULT_CONCURRENCY = 5;

export interface CancellationToken {
  cancelled: boolean;
}

export function createCancellationToken(): CancellationToken {
  return { cancelled: false };
}

/**
 * Runs `fn` over `items` with at most `concurrency` invocations in flight.
 * Returns results in input order as `PromiseSettledResult<R>[]`.
 *
 * When `cancel` is provided and `cancel.cancelled` is set to `true`,
 * workers stop picking up new items. Items that were never started
 * have `undefined` slots in the returned array — callers that filter
 * with `.filter(r => r?.status === "fulfilled")` handle this safely.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number = DEFAULT_CONCURRENCY,
  cancel?: CancellationToken
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      if (cancel?.cancelled) break;
      const i = nextIndex++;
      try {
        const value = await fn(items[i], i);
        results[i] = { status: "fulfilled", value };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return results;
}
