/**
 * Minimal in-process FIFO queue with per-phone serialization: messages from the
 * same phone run strictly in order; different phones run concurrently. No
 * external broker — good enough for the pilot's single-process deployment.
 */

export type Job<T> = () => Promise<T>;

export class PerPhoneQueue {
  // One tail promise per phone. Enqueue chains onto the tail so jobs for the
  // same phone never overlap. The map entry is cleared once its chain drains.
  private readonly tails = new Map<string, Promise<unknown>>();

  /** Enqueue a job for a phone. Resolves/rejects with the job's own result. */
  enqueue<T>(phone: string, job: Job<T>): Promise<T> {
    const previous = this.tails.get(phone) ?? Promise.resolve();
    // Run after the previous job settles, regardless of its outcome.
    const run = previous.then(job, job);
    // Keep the chain alive even if this job rejects; swallow only for the tail.
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(phone, tail);
    // Clean up the map entry when this is the last job in the chain.
    void tail.then(() => {
      if (this.tails.get(phone) === tail) this.tails.delete(phone);
    });
    return run;
  }

  /** Number of phones with an in-flight or queued chain. */
  get activePhones(): number {
    return this.tails.size;
  }
}
