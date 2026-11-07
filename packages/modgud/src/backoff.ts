// When a Grant's Child may start again after failed starts (ADR-0002): no
// sooner than `baseMs` after a failure, doubling with each consecutive
// failure up to `maxMs`. The owner resets the count once a Child has run
// long enough.
export class Backoff {
  readonly #baseMs: number;
  readonly #maxMs: number;
  readonly #now: () => number;
  #failures = 0;
  #retryAt = Number.NEGATIVE_INFINITY;

  constructor({ baseMs, maxMs, now }: { baseMs: number; maxMs: number; now: () => number }) {
    this.#baseMs = baseMs;
    this.#maxMs = maxMs;
    this.#now = now;
  }

  // Counts one more consecutive failure, from now.
  failed() {
    this.#failures += 1;
    const delay = Math.min(this.#baseMs * 2 ** (this.#failures - 1), this.#maxMs);
    this.#retryAt = this.#now() + delay;
  }

  // Forgets the consecutive failures, so the next one waits `baseMs` again.
  reset() {
    this.#failures = 0;
  }

  // Whether a start must wait.
  get blocked() {
    return this.#now() < this.#retryAt;
  }
}
