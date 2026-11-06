// Runs `modgud` with every listener that would bind a tailnet address bound to
// 127.0.0.1 instead, so tests can start `modgud serve` and reach its Admin
// listener on a host that has no tailnet address. Everything else, including
// the configuration's checks, runs unchanged.
const serve = Bun.serve.bind(Bun);
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
    return serve(options);
  },
});

await import('../main.ts');
