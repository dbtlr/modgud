import { describeError, loggable } from './log.ts';
import type { Log } from './log.ts';

// HTTP helpers both listeners share.

// What Bun's server offers the fetch handler: the peer address of a request.
export type PeerAddress = { requestIP: (request: Request) => { address: string } | null };

// The media type of a Content-Type header, without parameters, in lowercase.
export const mediaType = (header: string | null) => header?.split(';')[0]?.trim().toLowerCase();

// A body as text, or undefined once it passes `limit` bytes.
export const readLimitedBody = async (body: AsyncIterable<Uint8Array>, limit: number) => {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > limit) {
      return undefined;
    }
    chunks.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
};

// A request body as text, or undefined when it is over `limit` bytes. A
// declared Content-Length over the limit is refused without reading.
export const readLimitedText = async (request: Request, limit: number) => {
  if (Number(request.headers.get('content-length')) > limit) {
    return undefined;
  }
  return request.body === null ? '' : readLimitedBody(request.body, limit);
};

// The answer to a request that failed unexpectedly: no detail, no stack.
export const internalServerError = () =>
  new Response('Internal Server Error', {
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
    status: 500,
  });

// Logs an unexpected error by the request's method and path and the error's
// message, never its query, headers, body, or stack, and answers HTTP 500.
export const answerUnexpectedError = (log: Log, request: Request, error: unknown) => {
  log.warn(
    `Answered ${request.method} ${loggable(new URL(request.url).pathname)} with HTTP 500: ${loggable(describeError(error))}`,
  );
  return internalServerError();
};
