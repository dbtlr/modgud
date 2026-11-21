import type { LogFields } from '@loomcli/core';

import type { Log } from '../log.ts';

// One recorded log call: the constant template and the fields it carried,
// bound fields included, as Loom records them.
export type LogEntry = {
  level: 'info' | 'warn';
  message: string;
  fields: LogFields;
};

// Loom copies fields as JSON, which drops a field whose value is undefined.
const withoutUndefined = (fields: LogFields): LogFields =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));

// A Log that records each call as an entry. `with` binds fields under the
// call's own, as Loom does, and shares the same entries.
export const createLogRecorder = () => {
  const entries: LogEntry[] = [];
  const bind = (bound: LogFields): Log => {
    const record = (level: LogEntry['level']) => (message: string, fields?: LogFields) => {
      entries.push({ fields: { ...bound, ...withoutUndefined(fields ?? {}) }, level, message });
    };
    return {
      info: record('info'),
      warn: record('warn'),
      with: (more) => bind({ ...bound, ...withoutUndefined(more) }),
    };
  };
  return { entries, log: bind({}) };
};

// The entries recorded with exactly this template.
export const entriesOf = (entries: LogEntry[], message: string) =>
  entries.filter((entry) => entry.message === message);

// Every template and field of the entries as text, to assert that a value was
// or was not logged anywhere.
export const everything = (entries: LogEntry[]) =>
  entries.map((entry) => `${entry.message} ${JSON.stringify(entry.fields)}`).join('\n');

const STDERR = '{service} {upstream} for {grant} stderr: {line}';
const STOPPED = '{service} {upstream} for {grant} stopped: {reason}.';

// The stderr lines a Child wrote, as its events carry them.
export const stderrOf = (entries: LogEntry[]) =>
  entriesOf(entries, STDERR).map((entry) => String(entry.fields.line));

// The Session end events with this reason.
export const sessionsEnded = (entries: LogEntry[], reason: string) =>
  entriesOf(entries, '{service} session {session} ended: {reason}.').filter(
    (entry) => entry.fields.reason === reason,
  );

// Whether a Child or Link stopped for this reason.
export const stoppedFor = (entries: LogEntry[], reason: string) =>
  entriesOf(entries, STOPPED).some((entry) => entry.fields.reason === reason);
