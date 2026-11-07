// Runs `modgud` with every listener that would bind a tailnet address bound to
// 127.0.0.1 instead, so tests can start `modgud serve` and reach its Admin
// listener on a host that has no tailnet address. A request for THROW_PATH, on
// either listener, throws past the listener's own handling, so a test can see
// what serve does with an error that escapes. Everything else, including the
// configuration's checks, runs unchanged.
const serve = Bun.serve.bind(Bun);
const THROW_PATH = '/modgud-test-throw';
const TAILNET = /^(?:100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|fd7a:115c:a1e0:)/u;

Object.assign(Bun, {
  serve: (options: Parameters<typeof Bun.serve>[0]) => {
    if (
      'hostname' in options &&
      typeof options.hostname === 'string' &&
      TAILNET.test(options.hostname)
    ) {
      options.hostname = '127.0.0.1';
    }
    if ('fetch' in options && typeof options.fetch === 'function') {
      const { fetch } = options;
      options.fetch = function (this: unknown, request: Request, server: unknown) {
        if (new URL(request.url).pathname === THROW_PATH) {
          throw new Error('thrown past the listener');
        }
        return Reflect.apply(fetch, this, [request, server]);
      } as typeof fetch;
    }
    return serve(options);
  },
});

await import('../main.ts');
