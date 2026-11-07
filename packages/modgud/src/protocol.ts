// The MCP rules Modgud applies between Callers and a Grant's shared Child
// (ADR-0002): which protocol versions it speaks, what a Caller's `initialize`
// gets from the Child's result, which requests Modgud answers itself, and the
// fixed errors it answers in place of a Child.
import type {
  JSONRPCErrorResponse,
  JSONRPCMessage,
  JSONRPCRequest,
  JSONRPCResultResponse,
  RequestId,
} from '@modelcontextprotocol/server';
import { z } from 'zod';

// The 2025-era revisions Modgud serves to Callers and accepts from a Child,
// newest first. A later request whose `MCP-Protocol-Version` header names any
// other version gets HTTP 400.
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

// The version Modgud asks a Child for in its own `initialize`.
export const CHILD_PROTOCOL_VERSION = '2025-11-25';

const isSupported = (version: string) => SUPPORTED_PROTOCOL_VERSIONS.includes(version);

// Revision names are dates, so they compare as strings.
const isNewer = (version: string, than: string) => version > than;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// The part of a Child's initialize result that Modgud keeps and answers from.
const childInitializeResult = z.looseObject({
  capabilities: z.record(z.string(), z.unknown()),
  instructions: z.string().optional(),
  protocolVersion: z.string().refine(isSupported),
  serverInfo: z.unknown(),
});

export type ChildInitializeResult = z.infer<typeof childInitializeResult>;

// A Child's initialize result, or undefined when it is malformed or names a
// version that is not a 2025-era version Modgud supports.
export const parseChildInitializeResult = (result: unknown): ChildInitializeResult | undefined => {
  const parsed = childInitializeResult.safeParse(result);
  return parsed.success ? parsed.data : undefined;
};

// The version a Caller's Session gets: the one it requested when Modgud
// supports it and it is no newer than the Child's, otherwise the Child's.
export const negotiatedVersion = (requested: string, child: string) =>
  isSupported(requested) && !isNewer(requested, child) ? requested : child;

// A Child's capabilities as a Caller sees them: without `tasks` and without
// `resources.subscribe`, whose state would be shared across the Grant's
// Sessions and lost with the Child.
export const callerCapabilities = (capabilities: Record<string, unknown>) => {
  const { resources, tasks: _tasks, ...visible } = capabilities;
  if (isRecord(resources)) {
    const { subscribe: _subscribe, ...rest } = resources;
    return { ...visible, resources: rest };
  }
  return resources === undefined ? visible : { ...visible, resources };
};

// JSON with every object's keys sorted, so equal values compare equal.
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .toSorted()
      .map((name) => `${JSON.stringify(name)}:${canonicalJson(value[name])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

// What a Session was given at `initialize`, which a later Child must still
// match for the Session to continue.
export type Given = { capabilities: string; protocolVersion: string };

// The answer to a Caller's `initialize`, from the Child's result, and what it
// gives the Session.
export const initializeAnswer = (requested: string, child: ChildInitializeResult) => {
  const protocolVersion = negotiatedVersion(requested, child.protocolVersion);
  const capabilities = callerCapabilities(child.capabilities);
  return {
    given: { capabilities: canonicalJson(capabilities), protocolVersion } satisfies Given,
    result: {
      capabilities,
      ...(child.instructions === undefined ? {} : { instructions: child.instructions }),
      protocolVersion,
      serverInfo: child.serverInfo,
    },
  };
};

// Whether a Session can continue on a new Child: the version it was given is
// no newer than the Child's, and the capabilities are the ones the Child's
// result would give.
export const stillMatches = (given: Given, child: ChildInitializeResult) =>
  !isNewer(given.protocolVersion, child.protocolVersion) &&
  given.capabilities === canonicalJson(callerCapabilities(child.capabilities));

// The fixed messages of the errors Modgud answers in place of a Child. Detail
// goes only to the log.
export const ERRORS = {
  methodNotFound: { code: -32_601, message: 'Method not found' },
  sessionEnded: { code: -32_603, message: 'The session ended' },
  stopped: { code: -32_603, message: 'The Service stopped before it answered' },
  tooManyRequests: { code: -32_000, message: 'Too many requests are open for this Grant' },
  unavailable: { code: -32_603, message: 'The Service is unavailable' },
  unreachable: { code: -32_603, message: 'The Service could not be reached' },
} as const;

export const errorResponse = (
  id: RequestId,
  error: (typeof ERRORS)[keyof typeof ERRORS],
): JSONRPCErrorResponse => ({ error: { ...error }, id, jsonrpc: '2.0' });

export const emptyResult = (id: RequestId): JSONRPCResultResponse => ({
  id,
  jsonrpc: '2.0',
  result: {},
});

// Modgud's own answer to a Caller request it does not forward, or undefined
// for one it forwards. `ping` and `logging/setLevel` need no Child, and
// subscriptions and tasks are not offered (ADR-0002).
export const ownAnswer = (request: JSONRPCRequest): JSONRPCMessage | undefined => {
  const { id, method } = request;
  if (method === 'ping' || method === 'logging/setLevel') {
    return emptyResult(id);
  }
  if (
    method === 'resources/subscribe' ||
    method === 'resources/unsubscribe' ||
    method.startsWith('tasks/')
  ) {
    return errorResponse(id, ERRORS.methodNotFound);
  }
  return undefined;
};

// A progress token, as JSON-RPC allows one.
export type ProgressToken = string | number;

const asToken = (value: unknown): ProgressToken | undefined =>
  typeof value === 'string' || typeof value === 'number' ? value : undefined;

// The progress token a request carries in `params._meta`.
export const requestProgressToken = (request: JSONRPCRequest): ProgressToken | undefined => {
  const meta = request.params?._meta;
  return isRecord(meta) ? asToken(meta.progressToken) : undefined;
};

// The request id a `notifications/cancelled` names, or the progress token a
// `notifications/progress` names.
export const notificationParam = (
  message: { params?: Record<string, unknown> | undefined },
  name: 'progressToken' | 'requestId',
): ProgressToken | undefined => asToken(message.params?.[name]);

// A Caller request as Modgud forwards it: with the Child-side id and progress
// token, and without the `task` parameter, so it runs as an ordinary request.
export const renumbered = (
  request: JSONRPCRequest,
  id: number,
  progressToken: number | undefined,
): JSONRPCRequest => {
  if (request.params === undefined) {
    return { ...request, id };
  }
  const { _meta: meta, task: _task, ...params } = request.params;
  const rewrittenMeta =
    progressToken === undefined || !isRecord(meta) ? meta : { ...meta, progressToken };
  return {
    ...request,
    id,
    params: { ...params, ...(rewrittenMeta === undefined ? {} : { _meta: rewrittenMeta }) },
  };
};
