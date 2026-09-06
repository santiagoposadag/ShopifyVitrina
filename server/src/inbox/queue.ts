/**
 * Minimal in-process FIFO queue with per-conversation serialization: work for
 * the same conversation runs strictly in order; different conversations run
 * concurrently. No external broker — good enough for the pilot's single-process
 * deployment.
 *
 * THE SERIALIZATION IS LOAD-BEARING, not a nicety. `claimInboxBatch` claims
 * every un-settled row of a conversation at once, so two overlapping batches
 * would either fight over the same rows or split one burst across two turns
 * that then answer each other's half.
 *
 * Keyed by CONVERSATION, not by phone: for a WhatsApp principal the key is the
 * phone, so this is the same behaviour it always had, and a door whose caller
 * has no phone still gets one turn at a time. The batcher above it still
 * debounces per phone — bursts are a human typing habit, not a property of a
 * conversation.
 */

export type Job<T> = () => Promise<T>;

export class PerConversationQueue {
  // One tail promise per conversation. Enqueue chains onto the tail so jobs for
  // the same conversation never overlap. The entry is cleared once it drains.
  private readonly tails = new Map<string, Promise<unknown>>();

  /** Enqueue a job for a conversation. Resolves/rejects with the job's own result. */
  enqueue<T>(conversationKey: string, job: Job<T>): Promise<T> {
    const previous = this.tails.get(conversationKey) ?? Promise.resolve();
    // Run after the previous job settles, regardless of its outcome.
    const run = previous.then(job, job);
    // Keep the chain alive even if this job rejects; swallow only for the tail.
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(conversationKey, tail);
    // Clean up the map entry when this is the last job in the chain.
    void tail.then(() => {
      if (this.tails.get(conversationKey) === tail) this.tails.delete(conversationKey);
    });
    return run;
  }

  /** Number of conversations with an in-flight or queued chain. */
  get activeConversations(): number {
    return this.tails.size;
  }
}
