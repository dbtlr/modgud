const LF = 10;
const CR = 13;
const BOM = String.fromCodePoint(65279);

// An event's data lines, joined by LF. A single line stays the string it
// already is; from the second line on, the lines go into one growable byte
// buffer that is decoded once when the event ends. Many short lines then cost
// their bytes, not one string or array entry per line, which the engine would
// keep as separate allocations.
class EventDataBuffer {
  readonly #encoder = new TextEncoder();
  #first: string | undefined;
  #bytes: Uint8Array | undefined;
  #length = 0;

  get empty() {
    return this.#first === undefined && this.#bytes === undefined;
  }

  append(value: string) {
    if (this.empty) {
      this.#first = value;
      return;
    }
    if (this.#first !== undefined) {
      const first = this.#first;
      this.#first = undefined;
      this.#write(first);
    }
    this.#write(value, true);
  }

  // The joined data, after which the buffer is empty again.
  take(): string {
    const text = this.#first ?? new TextDecoder().decode(this.#bytes?.subarray(0, this.#length));
    this.#first = undefined;
    this.#bytes = undefined;
    this.#length = 0;
    return text;
  }

  #write(value: string, afterLF = false) {
    const needed = this.#length + Buffer.byteLength(value) + (afterLF ? 1 : 0);
    let bytes = this.#bytes ?? new Uint8Array(Math.max(needed, 1024));
    if (needed > bytes.length) {
      const grown = new Uint8Array(Math.max(needed, bytes.length * 2));
      grown.set(bytes.subarray(0, this.#length));
      bytes = grown;
    }
    this.#bytes = bytes;
    if (afterLF) {
      bytes[this.#length] = LF;
      this.#length += 1;
    }
    this.#length += this.#encoder.encodeInto(value, bytes.subarray(this.#length)).written;
  }
}

// Split lines at their ASCII terminators before decoding, so a partial line
// counts toward the event's byte budget as soon as its bytes arrive.
export async function* eventData(body: ReadableStream<Uint8Array>, maxBytes: number) {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let firstLine = true;
  let skipLF = false;
  let bytes = 0;
  let line = '';
  const data = new EventDataBuffer();

  for await (const chunk of body) {
    let offset = 0;
    while (offset < chunk.length) {
      if (skipLF) {
        skipLF = false;
        if (chunk[offset] === LF) {
          if (bytes !== 0) {
            bytes += 1;
          }
          offset += 1;
        }
      }

      let end = offset;
      while (end < chunk.length && chunk[end] !== LF && chunk[end] !== CR) {
        end += 1;
      }
      bytes += end - offset;
      if (bytes > maxBytes) {
        throw new Error('SSE event exceeds the limit');
      }
      const complete = end < chunk.length;
      line += decoder.decode(chunk.subarray(offset, end), { stream: !complete });
      if (!complete) {
        break;
      }

      skipLF = chunk[end] === CR;
      offset = end + 1;
      if (firstLine && line.startsWith(BOM)) {
        line = line.slice(BOM.length);
      }
      firstLine = false;
      if (line.length === 0) {
        const event = data.empty ? '' : data.take();
        bytes = 0;
        if (event.length !== 0) {
          yield event;
        }
      } else {
        bytes += 1;
        if (bytes > maxBytes) {
          throw new Error('SSE event exceeds the limit');
        }
        if (line === 'data' || line.startsWith('data:')) {
          data.append(line.slice(line.startsWith('data: ') ? 6 : 5));
        }
      }
      line = '';
    }
  }
}
