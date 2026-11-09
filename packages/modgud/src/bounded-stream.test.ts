import { expect, test } from 'bun:test';

import { boundStream } from './bounded-stream.ts';
import { rejectionOf } from './testing/listener-harness.ts';

const bytes = (length: number, fill = 97) => new Uint8Array(length).fill(fill);

// A source the test writes to, recording whether the relay cancelled it.
const controlledSource = () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const state = { cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    cancel: () => {
      state.cancelled = true;
    },
    start: (c) => {
      controller = c;
    },
  });
  return { controller, state, stream };
};

// Lets the relay read whatever the source has enqueued.
const settle = () => Bun.sleep(5);

const readAll = async (stream: ReadableStream<Uint8Array>) => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
};

test('a reader that keeps reading gets every chunk in order, then the end', async () => {
  const source = controlledSource();
  const relayed = boundStream(source.stream, { limitBytes: 10, onOverflow: () => undefined });
  const reading = readAll(relayed);
  for (const fill of [1, 2, 3, 4, 5]) {
    source.controller.enqueue(bytes(4, fill));
    // oxlint-disable-next-line no-await-in-loop -- the reader drains between chunks
    await settle();
  }
  source.controller.close();
  const chunks = await reading;
  expect(chunks.map((chunk) => chunk[0])).toEqual([1, 2, 3, 4, 5]);
});

test('a single chunk larger than the limit still reaches a reader', async () => {
  const source = controlledSource();
  let overflowed = false;
  const relayed = boundStream(source.stream, {
    limitBytes: 10,
    onOverflow: () => {
      overflowed = true;
    },
  });
  const reading = readAll(relayed);
  source.controller.enqueue(bytes(100));
  source.controller.close();
  const chunks = await reading;
  expect(chunks.map((chunk) => chunk.byteLength)).toEqual([100]);
  expect(overflowed).toBe(false);
});

test('chunks a reader never reads overflow only once the held bytes pass the limit', async () => {
  const source = controlledSource();
  let overflows = 0;
  const relayed = boundStream(source.stream, {
    limitBytes: 10,
    onOverflow: () => {
      overflows += 1;
    },
  });
  // Held 4, then 8, then 12: each arrives while 10 or fewer bytes are held.
  for (let index = 0; index < 3; index += 1) {
    source.controller.enqueue(bytes(4));
    // oxlint-disable-next-line no-await-in-loop -- one chunk at a time
    await settle();
  }
  expect(overflows).toBe(0);
  expect(source.state.cancelled).toBe(false);
  // This one arrives while 12 bytes are held.
  source.controller.enqueue(bytes(4));
  await settle();
  expect(overflows).toBe(1);
  expect(source.state.cancelled).toBe(true);
  // What it held is discarded, and the stream ends cleanly.
  expect(await readAll(relayed)).toEqual([]);
});

test('a stream holding exactly the limit takes another chunk', async () => {
  const source = controlledSource();
  let overflows = 0;
  boundStream(source.stream, {
    limitBytes: 10,
    onOverflow: () => {
      overflows += 1;
    },
  });
  for (const length of [5, 5, 1]) {
    source.controller.enqueue(bytes(length));
    // oxlint-disable-next-line no-await-in-loop -- one chunk at a time
    await settle();
  }
  expect(overflows).toBe(0);
  source.controller.enqueue(bytes(1));
  await settle();
  expect(overflows).toBe(1);
});

test('a keepalive counts as output toward the bound', async () => {
  const source = controlledSource();
  let overflows = 0;
  boundStream(source.stream, {
    limitBytes: 10,
    onOverflow: () => {
      overflows += 1;
    },
  });
  source.controller.enqueue(bytes(11));
  await settle();
  source.controller.enqueue(new TextEncoder().encode(': keepalive\n\n'));
  await settle();
  expect(overflows).toBe(1);
});

test('a reader that cancels cancels the source', async () => {
  const source = controlledSource();
  const relayed = boundStream(source.stream, { limitBytes: 10, onOverflow: () => undefined });
  await relayed.cancel();
  expect(source.state.cancelled).toBe(true);
});

test('a source that fails fails the relayed stream', async () => {
  const source = controlledSource();
  const relayed = boundStream(source.stream, { limitBytes: 10, onOverflow: () => undefined });
  source.controller.error(new Error('broken'));
  expect(await rejectionOf(readAll(relayed))).toBe('broken');
});
