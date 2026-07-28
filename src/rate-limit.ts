/**
 * A small rate limiter for Forge's 60-requests-per-minute budget.
 *
 * Two halves, because either alone is insufficient:
 *
 *  - A local sliding window stops us *reaching* the limit when a caller asks for
 *    something wide ("check SSL on every site"). Without it the first 60 calls
 *    burst through and every later one 429s.
 *  - Server-reported state (X-RateLimit-Remaining / -Reset) is authoritative and
 *    accounts for requests the local window never saw — another process sharing
 *    the token, or a limit Forge raised on request. When Forge says zero left, we
 *    wait for its reset rather than trusting our own count.
 *
 * The budget is per *token*, so when this server is shared (e.g. behind a
 * gateway) all callers draw on one pool. That is exactly why cursor-following is
 * not automatic anywhere in this package: one tool call must not be able to spend
 * the whole minute.
 */

export interface RateLimiterOptions {
  readonly requestsPerMinute: number;
  /** Injectable for tests. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const WINDOW_MS = 60_000;

/**
 * Read a numeric header, or null when it is absent or not a number.
 *
 * Not merely `Number(headers.get(x))`: `Number(null)` is 0, which is finite, so a
 * MISSING header would read as a real zero. That turned an absent `Retry-After`
 * into "retry immediately" — hot-looping against the very limit we had just hit —
 * and an absent `X-RateLimit-Remaining` into "no budget left".
 */
function numericHeader(headers: { get(name: string): string | null }, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw.trim().length === 0) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export class RateLimiter {
  private readonly limit: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Timestamps of recent requests, oldest first. */
  private recent: number[] = [];
  /** Server-reported remaining allowance, or null when unknown. */
  private serverRemaining: number | null = null;
  /** Epoch ms when the server's window resets, or null when unknown. */
  private serverResetAt: number | null = null;
  /** Serialises waiters so N concurrent callers don't all decide to go at once. */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: RateLimiterOptions) {
    this.limit = Math.max(1, Math.floor(options.requestsPerMinute));
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Wait until a request may be sent, then record it. */
  async acquire(): Promise<void> {
    const run = this.queue.then(() => this.waitForSlot());
    // Swallow rejections on the chain itself so one failure doesn't poison the queue.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async waitForSlot(): Promise<void> {
    for (;;) {
      const now = this.now();
      this.recent = this.recent.filter((t) => now - t < WINDOW_MS);

      if (this.serverResetAt !== null && now >= this.serverResetAt) {
        this.serverRemaining = null;
        this.serverResetAt = null;
      }

      if (this.serverRemaining !== null && this.serverRemaining <= 0 && this.serverResetAt !== null) {
        await this.sleep(Math.max(0, this.serverResetAt - now) + 50);
        continue;
      }

      if (this.recent.length >= this.limit) {
        const oldest = this.recent[0] ?? now;
        await this.sleep(Math.max(0, WINDOW_MS - (now - oldest)) + 50);
        continue;
      }

      this.recent.push(now);
      if (this.serverRemaining !== null) this.serverRemaining -= 1;
      return;
    }
  }

  /**
   * Feed back what Forge reported. `X-RateLimit-Reset` is seconds-until-reset in
   * Forge's responses; we tolerate an absolute epoch too, since that is the other
   * common convention and mistaking one for the other would mean either a
   * pointless wait or none at all.
   */
  observeHeaders(headers: { get(name: string): string | null }): void {
    const remaining = numericHeader(headers, 'x-ratelimit-remaining');
    if (remaining !== null) this.serverRemaining = remaining;

    const reset = numericHeader(headers, 'x-ratelimit-reset');
    if (reset !== null && reset > 0) {
      const now = this.now();
      // Anything below ~1e6 cannot be an epoch, so treat it as a delta in seconds.
      this.serverResetAt = reset < 1_000_000 ? now + reset * 1000 : reset * 1000;
    }
  }

  /** How long to wait after a 429, honouring Retry-After when present. */
  retryDelayMs(headers: { get(name: string): string | null }, attempt: number): number {
    const retryAfter = numericHeader(headers, 'retry-after');
    if (retryAfter !== null && retryAfter >= 0) return retryAfter * 1000 + 50;
    if (this.serverResetAt !== null) {
      return Math.max(0, this.serverResetAt - this.now()) + 50;
    }
    return Math.min(30_000, 1000 * 2 ** attempt);
  }

  async wait(ms: number): Promise<void> {
    await this.sleep(ms);
  }
}
