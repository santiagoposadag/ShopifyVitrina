/**
 * Downloading a burst of inbound photos under the webhook's ACK deadline.
 *
 * Kapso gives the webhook ~10s to ACK and its media tokens expire in ~4 min, so
 * the files must be fetched now, inside the request, but never at the cost of
 * the ACK. That makes the time budget the whole design problem, and it has two
 * halves that a single shared deadline cannot express at once.
 */

/** Time budget for one burst of inbound media. */
export interface MediaDownloadBudget {
  /**
   * Ceiling for the WHOLE burst, protecting the ACK deadline. Wall-clock, not a
   * sum: downloads run concurrently, so this holds however many photos arrive.
   */
  totalMs: number;
  /**
   * Ceiling for any single download, so one slow file fails alone instead of
   * taking the burst with it.
   */
  perDownloadMs: number;
}

export type MediaDownloadResult =
  | { ok: true; buffer: Buffer }
  | { ok: false; error: unknown };

/** Max downloads in flight at once, so a 37-photo listing cannot open 37 sockets. */
const MAX_CONCURRENT = 8;

/**
 * Fetch every item, returning one result per item IN INPUT ORDER — photo order is
 * the listing's order, and the first photo becomes the storefront's cover.
 *
 * Failures are values, not exceptions: one unreachable file must not discard the
 * rest of a listing, so this never rejects.
 *
 * Downloads run concurrently and each gets its OWN deadline, combined with a
 * shared one. Both halves matter, and the original code had only the shared half:
 * a single AbortSignal.timeout was created per request and passed to every
 * sequential download, so the first slow file drained the entire budget and every
 * later download rejected instantly on the already-aborted signal — three photos
 * failing 2ms apart, the last two never even attempted. Sequential downloads also
 * cannot fit a real listing: 11 photos against one 6s budget is arithmetic that
 * only ever ends one way.
 */
export async function downloadInboundMedia<T>(
  items: T[],
  download: (item: T, signal: AbortSignal) => Promise<Buffer>,
  budget: MediaDownloadBudget,
): Promise<MediaDownloadResult[]> {
  if (items.length === 0) return [];

  // One shared ceiling for the burst, armed once so it covers queue wait too —
  // an item held behind MAX_CONCURRENT still has to answer to the ACK deadline.
  const burstDeadline = AbortSignal.timeout(budget.totalMs);
  const results = new Array<MediaDownloadResult>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      // Armed here, not up front: a download's own clock starts when it starts,
      // not when the burst did, or queued items would forfeit their budget.
      const signal = AbortSignal.any([burstDeadline, AbortSignal.timeout(budget.perDownloadMs)]);
      try {
        results[index] = { ok: true, buffer: await download(items[index]!, signal) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT, items.length) }, () => worker()),
  );
  return results;
}
