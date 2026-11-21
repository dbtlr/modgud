import { expect } from 'bun:test';

import type { LogFields } from '@loomcli/core';

import type { Log } from '../log.ts';

// One recorded log call: the constant template and the fields it carried,
// bound fields included, as Loom records them.
export type LogEntry = {
  level: 'info' | 'warn';
  message: string;
  fields: LogFields;
};

// Loom copies fields as JSON: a field whose value is undefined drops out, and
// an Error becomes { name, message, stack, cause }, so a test can see an Error
// that wrongly enters a field.
const copyOfFields = (fields: LogFields): LogFields => {
  const copy: unknown = JSON.parse(
    JSON.stringify(fields, (_key, value: unknown) =>
      value instanceof Error
        ? { cause: value.cause, message: value.message, name: value.name, stack: value.stack }
        : value,
    ),
  );
  return typeof copy === 'object' && copy !== null ? Object.fromEntries(Object.entries(copy)) : {};
};

// A Log that records each call as an entry. `with` binds fields under the
// call's own, as Loom does, and shares the same entries.
export const createLogRecorder = () => {
  const entries: LogEntry[] = [];
  const bind = (bound: LogFields): Log => {
    const record = (level: LogEntry['level']) => (message: string, fields?: LogFields) => {
      entries.push({ fields: copyOfFields({ ...bound, ...fields }), level, message });
    };
    return {
      info: record('info'),
      warn: record('warn'),
      with: (more) => bind({ ...bound, ...copyOfFields(more) }),
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

// Checks the fields a relay binds on every Child and Link event: the Service,
// the kind of upstream, and the Grant. A call field that replaced one of them
// fails here.
export const expectBoundFields = (entry: LogEntry) => {
  expect(entry.fields.service).toMatch(/^[\w-]+$/u);
  expect(entry.fields.upstream).toMatch(/^(child|link)$/u);
  expect(entry.fields.grant).toMatch(/^(static-token|authorization [\w-]{8})$/u);
};

// The Session end events with this reason. Each names its Service and the
// first eight characters of the Session id.
export const sessionsEnded = (entries: LogEntry[], reason: string) =>
  entriesOf(entries, '{service} session {session} ended: {reason}.')
    .filter((entry) => entry.fields.reason === reason)
    .map((entry) => {
      expect(entry.fields.session).toMatch(/^[0-9a-f]{8}$/u);
      expect(entry.fields.service).toMatch(/^[\w-]+$/u);
      return entry;
    });

// Whether a Child or Link stopped for this reason, with its bound fields.
export const stoppedFor = (entries: LogEntry[], reason: string) => {
  const stops = entriesOf(entries, STOPPED).filter((entry) => entry.fields.reason === reason);
  for (const entry of stops) {
    expectBoundFields(entry);
  }
  return stops.length > 0;
};
