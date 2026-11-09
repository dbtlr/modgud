export type BoundOptions = {
  // The most bytes the relay may hold, not yet handed on, when another chunk
  // arrives. One chunk may take it past this.
  limitBytes: number;
  // Called once, when the relay ends the stream for holding too much.
  onOverflow: () => void;
};

// Cancels a source the relay no longer reads. A failed cancel changes nothing
// for the relay, which has already ended its own stream.
const cancelQuietly = async (reader: { cancel: () => Promise<void> }) => {
  try {
    await reader.cancel();
  } catch {
    // Nothing more to do.
  }
};

// Relays a byte stream while holding at most `limitBytes` that the reader has
// not taken, plus one chunk (ADR-0002, "A Caller's streams are bounded"). It
// reads the source as fast as the source produces, and hands one chunk on per
// pull. When a chunk arrives while it holds more than the limit, it discards
// what it holds, cancels the source, and ends the stream cleanly.
export const boundStream = (
  source: ReadableStream<Uint8Array>,
  { limitBytes, onOverflow }: BoundOptions,
): ReadableStream<Uint8Array> => {
  const reader = source.getReader();
  const held: Uint8Array[] = [];
  let heldBytes = 0;
  let sourceDone = false;
  let stopped = false;
  // Set while the reader waits for a chunk the relay does not have yet.
  let waiting = false;
  let controller!: ReadableStreamDefaultController<Uint8Array>;

  const handOn = () => {
    const chunk = held.shift();
    if (chunk === undefined) {
      if (sourceDone) {
        controller.close();
      } else {
        waiting = true;
      }
      return;
    }
    heldBytes -= chunk.byteLength;
    controller.enqueue(chunk);
  };

  const overflow = () => {
    stopped = true;
    held.length = 0;
    heldBytes = 0;
    void cancelQuietly(reader);
    controller.close();
    onOverflow();
  };

  const pump = async () => {
    try {
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- one chunk at a time, in order
        const { done, value } = await reader.read();
        if (stopped) {
          return;
        }
        if (done) {
          sourceDone = true;
          if (waiting) {
            waiting = false;
            handOn();
          }
          return;
        }
        if (heldBytes > limitBytes) {
          overflow();
          return;
        }
        held.push(value);
        heldBytes += value.byteLength;
        if (waiting) {
          waiting = false;
          handOn();
        }
      }
    } catch (error) {
      if (!stopped) {
        stopped = true;
        controller.error(error);
      }
    }
  };

  return new ReadableStream<Uint8Array>(
    {
      cancel: async (reason) => {
        stopped = true;
        held.length = 0;
        heldBytes = 0;
        await reader.cancel(reason);
      },
      pull: () => {
        handOn();
      },
      start: (started) => {
        controller = started;
        void pump();
      },
    },
    { highWaterMark: 0 },
  );
};
