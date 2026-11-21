// ADR-0006: how many tools/call requests one Grant may hand to its Service
// in any 60 seconds, the refusal a call past that limit gets, and the
// episodes the log records instead of each refusal.
import type { JSONRPCResultResponse, RequestId } from '@modelcontextprotocol/server';

import type { Log } from './log.ts';
import { createWindowLimit } from './rate-limit.ts';

const WINDOW_MS = 60_000;
// The one key of a Grant's window: each Grant has its own ToolCallLimit.
const GRANT = 'grant';

export const RETRY_AFTER_META = 'com.dbtlr.modgud/retryAfterSeconds';

const plural = (count: number, one: string, many: string) =>
  `${String(count)} ${count === 1 ? one : many}`;

// The tool error a refused call gets. Its text is fixed apart from its two
// numbers, which say nothing about the Service.
export const toolCallRefusal = (
  id: RequestId,
  limit: number,
  retryAfterSeconds: number,
): JSONRPCResultResponse => ({
  id,
  jsonrpc: '2.0',
  result: {
    _meta: { [RETRY_AFTER_META]: retryAfterSeconds },
    content: [
      {
        text: `Rate limit reached: the limit is ${plural(limit, 'tool call', 'tool calls')} per minute. Try again in ${plural(retryAfterSeconds, 'second', 'seconds')}.`,
        type: 'text',
      },
    ],
    isError: true,
  },
});

export type ToolCallDecision = { kind: 'send' } | { kind: 'refuse'; retryAfterSeconds: number };

// One Grant's sliding window of counted calls and its current episode. It
// lives as long as the Grant's relay, so a Child or Link that restarts does
// not reset it.
export class ToolCallLimit {
  readonly limit: number;
  readonly #log: Log;
  readonly #now: () => number;
  readonly #window: ReturnType<typeof createWindowLimit>;
  // Set from the refusal that starts an episode until the episode ends.
  #episode: { refused: number; lastRefusalAt: number } | undefined;

  constructor({ limit, log, now }: { limit: number; log: Log; now: () => number }) {
    this.limit = limit;
    this.#log = log;
    this.#now = now;
    this.#window = createWindowLimit({ limit, now, windowMs: WINDOW_MS });
  }

  // Decides a tools/call about to be handed to the Child or Link. A call that
  // fits counts at once; one that does not is refused and never counts.
  take(): ToolCallDecision {
    const waitMs = this.#window.wait(GRANT);
    const now = this.#now();
    if (waitMs > 0) {
      if (this.#episode === undefined) {
        this.#episode = { lastRefusalAt: now, refused: 0 };
        this.#log.warn(
          '{service} {upstream} for {grant} refused a tool call: the Grant reached its limit of {limit} per minute.',
          { limit: this.limit },
        );
      }
      this.#episode.refused += 1;
      this.#episode.lastRefusalAt = now;
      return { kind: 'refuse', retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
    }
    this.#window.record(GRANT);
    if (this.#episode !== undefined && now - this.#episode.lastRefusalAt >= WINDOW_MS) {
      this.endEpisode();
    }
    return { kind: 'send' };
  }

  // Ends the current episode, if any, logging how many calls it refused: at
  // the first call sent after a quiet window, or when the Grant ends or
  // Modgud shuts down.
  endEpisode() {
    if (this.#episode !== undefined) {
      this.#log.info(
        '{service} {upstream} for {grant} ended a tool call limit episode: it refused {refused} in the episode.',
        { refused: this.#episode.refused },
      );
      this.#episode = undefined;
    }
  }
}
