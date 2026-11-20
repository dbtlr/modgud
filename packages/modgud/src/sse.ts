const LF = 10;
const CR = 13;
const BOM = String.fromCodePoint(65279);

// Split lines at their ASCII terminators before decoding, so a partial line
// counts toward the event's byte budget as soon as its bytes arrive.
export async function* eventData(body: ReadableStream<Uint8Array>, maxBytes: number) {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let firstLine = true;
  let skipLF = false;
  let bytes = 0;
  let line = '';
  // The event's data lines so far, joined by LF as they arrive, so a stream
  // of many short lines holds one string rather than one entry per line.
  let data: string | undefined;

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
        const event = data ?? '';
        bytes = 0;
        data = undefined;
        if (event.length !== 0) {
          yield event;
        }
      } else {
        bytes += 1;
        if (bytes > maxBytes) {
          throw new Error('SSE event exceeds the limit');
        }
        if (line === 'data' || line.startsWith('data:')) {
          const value = line.slice(line.startsWith('data: ') ? 6 : 5);
          data = data === undefined ? value : `${data}\n${value}`;
        }
      }
      line = '';
    }
  }
}
