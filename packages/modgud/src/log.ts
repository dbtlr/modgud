// The part of Loom's log that the listeners use. `serve` passes its action's
// log, and Loom's logging plugin records each event; tests pass a recorder.
export type Log = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

// C0 controls (below 32), DEL (127), and C1 controls (128 to 159).
const isControl = (code: number) => code < 32 || (code >= 127 && code < 160);

// Text from a Child or a Caller, made safe for one log line: a tab becomes a
// space, and every other control character, newlines included, becomes a
// visible escape.
export const loggable = (text: string) =>
  // Code points, not graphemes: each control character is one code point.
  // oxlint-disable-next-line typescript/no-misused-spread
  [...text]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      if (!isControl(code)) {
        return character;
      }
      return character === '\t' ? ' ' : `\\u${code.toString(16).padStart(4, '0')}`;
    })
    .join('');

// Text from a Child or a Caller as a log line may carry it: its first `limit`
// code points, made loggable.
export const excerpt = (text: string, limit: number) =>
  // oxlint-disable-next-line typescript/no-misused-spread -- code points, as loggable counts them
  loggable([...text].slice(0, limit).join(''));

// An error's message, for a log line or a fatal message.
export const describeError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
