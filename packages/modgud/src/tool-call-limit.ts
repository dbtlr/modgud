// ADR-0006: how many tools/call requests one Grant may hand to its Service
// in any 60 seconds, the refusal a call past that limit gets, and the
// episodes the log records instead of each refusal.
import type { JSONRPCResultResponse, RequestId } from '@modelcontextprotocol/server';

import type { Log } from './log.ts';
import { createWindowLimit } from './rate-limit.ts';
import { RefusalEpisode } from './refusal-episode.ts';

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
  readonly #window: ReturnType<typeof createWindowLimit>;
  readonly #episode: RefusalEpisode;

  constructor({ limit, log, now }: { limit: number; log: Log; now: () => number }) {
    this.limit = limit;
    this.#window = createWindowLimit({ limit, now, windowMs: WINDOW_MS });
    this.#episode = new RefusalEpisode({
      now,
      onEnd: (refused) =>
        log.info(
          '{service} {upstream} for {grant} ended a tool call limit episode, refusing tool calls: {refused}.',
          { refused },
        ),
      onStart: () =>
        log.warn(
          '{service} {upstream} for {grant} refused a tool call: the Grant reached its tool call limit of {limit} per minute.',
          { limit },
        ),
    });
  }

  // Decides a tools/call about to be handed to the Child or Link. A call that
  // fits counts at once; one that does not is refused and never counts.
  take(): ToolCallDecision {
    const waitMs = this.#window.wait(GRANT);
    if (waitMs > 0) {
      this.#episode.refused();
      return { kind: 'refuse', retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
    }
    this.#window.record(GRANT);
    this.#episode.admitted();
    return { kind: 'send' };
  }

  // Ends the current episode, if any, logging how many calls it refused.
  endEpisode() {
    this.#episode.end();
  }
}
