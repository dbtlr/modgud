// Runtime log lines. Each starts with an ISO 8601 UTC timestamp, as
// Heimdall's do, so a supervised log reads the same across the fleet.
export type Log = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

export const timestampedLog = (
  print: (line: string) => void,
  now: () => Date = () => new Date(),
): Log => ({
  info: (message) => print(`${now().toISOString()} info ${message}`),
  warn: (message) => print(`${now().toISOString()} warn ${message}`),
});

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

// An error's message, for a log line or a fatal message.
export const describeError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
