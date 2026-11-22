import type { LogFields } from '@loomcli/core';
import type { LoggingError } from '@loomcli/plugins/logging';

// The part of Loom's log that the listeners use. `serve` passes its action's
// log, and Loom's logging plugin records each event; tests pass a recorder.
// A message is a constant template with `{name}` placeholders, and each value
// goes in `fields`; `with` returns a Log whose every event carries its fields.
export type Log = {
  info: (message: string, fields?: LogFields) => void;
  warn: (message: string, fields?: LogFields) => void;
  with: (fields: LogFields) => Log;
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

// The most code points of a Child's text, such as one stderr line, that a log
// line carries (ADR-0002).
export const CHILD_LOG_LIMIT = 2000;

// Text from a Child or a Caller as a log line may carry it: its first `limit`
// code points, made loggable.
export const excerpt = (text: string, limit: number) =>
  // oxlint-disable-next-line typescript/no-misused-spread -- code points, as loggable counts them
  loggable([...text].slice(0, limit).join(''));

// A message from a Service, a Child's or a Link's, as a log excerpt. A message
// nested too deeply to stringify is named as such instead of overflowing the
// stack.
export const excerptOfMessage = (message: unknown) => {
  try {
    return excerpt(JSON.stringify(message), CHILD_LOG_LIMIT);
  } catch {
    return '(nested too deeply to log)';
  }
};

// An error's message, for a log line or a fatal message.
export const describeError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// Loom's logging plugin drops a record it cannot write and says nothing. This
// is its `onError`: it prints each distinct failure once, on stderr, which a
// service manager such as systemd keeps, so a log that stopped being written
// does not go unnoticed. Repeats of a failure already printed stay quiet.
export const reportLogFailures = (print: (line: string) => void) => {
  const printed = new Set<string>();
  return (error: LoggingError): undefined => {
    const line =
      error.kind === 'unresolved-directory'
        ? `Modgud cannot write its log: ${error.variable ?? 'HOME'} is not set.`
        : `Modgud cannot write its log (${error.kind}) at ${error.path ?? 'an unknown path'}: ${describeError(error.cause)}`;
    if (!printed.has(line)) {
      printed.add(line);
      print(loggable(line));
    }
    return undefined;
  };
};
