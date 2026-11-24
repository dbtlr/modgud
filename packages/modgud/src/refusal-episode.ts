// How the log records a limit's refusals: as episodes, not one line each, so a
// Caller that keeps hitting a limit cannot fill the log at its own rate.

// How long a limit must go without a refusal before an admitted request ends
// its episode.
const EPISODE_QUIET_MS = 60_000;

// One limit's current episode. The first refusal starts it; it ends at the
// first request admitted after 60 seconds without a refusal, or when the
// Grant ends or Modgud shuts down. The caller owns the log lines: `onStart`
// logs the opening warning, and `onEnd` logs the count of refusals.
export class RefusalEpisode {
  readonly #now: () => number;
  readonly #onStart: () => void;
  readonly #onEnd: (refused: number) => void;
  // Set from the refusal that starts an episode until the episode ends.
  #open: { refused: number; lastRefusalAt: number } | undefined;

  constructor({
    now,
    onEnd,
    onStart,
  }: {
    now: () => number;
    onEnd: (refused: number) => void;
    onStart: () => void;
  }) {
    this.#now = now;
    this.#onStart = onStart;
    this.#onEnd = onEnd;
  }

  // Counts a refusal, starting an episode when none is open.
  refused() {
    const now = this.#now();
    if (this.#open === undefined) {
      this.#open = { lastRefusalAt: now, refused: 0 };
      this.#onStart();
    }
    this.#open.refused += 1;
    this.#open.lastRefusalAt = now;
  }

  // Notes a request the limit let through, which ends an episode that has had
  // no refusal for a full quiet window.
  admitted() {
    if (this.#open !== undefined && this.#now() - this.#open.lastRefusalAt >= EPISODE_QUIET_MS) {
      this.end();
    }
  }

  // Ends the current episode, if any, reporting how many requests it refused.
  end() {
    if (this.#open !== undefined) {
      const { refused } = this.#open;
      this.#open = undefined;
      this.#onEnd(refused);
    }
  }
}
