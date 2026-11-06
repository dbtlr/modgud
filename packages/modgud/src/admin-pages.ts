import { isIP } from 'node:net';

// The Admin listener's pages (docs/oauth.md, "Admin listener endpoints" and
// "Approval page"): plain server-rendered HTML with inline styles and no
// script. Every value a client supplied passes through `shown`, which strips
// control and bidirectional-formatting characters and escapes HTML.

// Control characters (C0, DEL, C1) and bidirectional-formatting characters.
const UNSHOWN = /[\p{Cc}\p{Bidi_Control}]/gu;

const HTML_ESCAPES: Record<string, string> = {
  '"': '&quot;',
  '&': '&amp;',
  "'": '&#39;',
  '<': '&lt;',
  '>': '&gt;',
};

const escapeHtml = (text: string) =>
  text.replaceAll(/["&'<>]/gu, (character) => HTML_ESCAPES[character] ?? '');

// A value as a page shows it: without control or bidirectional-formatting
// characters, HTML-escaped.
export const shown = (text: string) => escapeHtml(text.replaceAll(UNSHOWN, ''));

// A URI's host and port as a page shows them: the URL parser's ASCII form, in
// which an international name is punycode.
export const hostOf = (uri: string) => new URL(uri).host;

const isIpLiteral = (uri: string) => isIP(new URL(uri).hostname.replace(/^\[(.*)\]$/u, '$1')) !== 0;

// The page's Content-Security-Policy. The redirect URI's origin is a form
// action so the browser follows Approve's and Deny's redirect to it; CSP
// cannot name an IP-literal host, so then the policy has no form-action.
const formAction = (redirectUri: string | undefined) => {
  if (redirectUri === undefined) {
    return "form-action 'self'; ";
  }
  return isIpLiteral(redirectUri) ? '' : `form-action 'self' ${new URL(redirectUri).origin}; `;
};

export const contentSecurityPolicy = (redirectUri: string | undefined) =>
  `default-src 'none'; style-src 'unsafe-inline'; ${formAction(redirectUri)}frame-ancestors 'none'`;

// Headers every page carries.
export const pageHeaders = (redirectUri: string | undefined) =>
  new Headers({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': contentSecurityPolicy(redirectUri),
    'Content-Type': 'text/html; charset=utf-8',
    'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
  });

const STYLE = `
  body { font: 16px/1.5 system-ui, sans-serif; color: #1b1b1f; background: #f6f6f8; margin: 0; }
  main { max-width: 34rem; margin: 3rem auto; padding: 2rem; background: #fff; border-radius: 12px; box-shadow: 0 1px 4px rgb(0 0 0 / 12%); }
  h1 { font-size: 1.4rem; margin: 0 0 1rem; }
  .host { font-size: 1.6rem; font-weight: 700; word-break: break-all; margin: 0 0 1rem; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .4rem 1rem; margin: 0 0 1rem; }
  dt { color: #5c5c66; }
  dd { margin: 0; word-break: break-all; }
  code { font: .9em ui-monospace, monospace; }
  .warning { background: #fff4d6; border-left: 4px solid #d99a00; padding: .6rem .8rem; }
  .error { background: #fde8e8; border-left: 4px solid #c81e1e; padding: .6rem .8rem; }
  label { display: block; font-weight: 600; margin: 1rem 0 .3rem; }
  input { font: 1.3rem ui-monospace, monospace; letter-spacing: .15em; padding: .4rem .6rem; width: 12ch; }
  .actions { display: flex; gap: .8rem; margin-top: 1.2rem; }
  button { font: inherit; padding: .5rem 1.4rem; border-radius: 8px; border: 1px solid #8a8a94; background: #fff; cursor: pointer; }
  button[value="approve"] { background: #1d4ed8; border-color: #1d4ed8; color: #fff; }
`;

// A whole page around trusted markup.
const layout = (title: string, content: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Modgud</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${content}
</main>
</body>
</html>
`;

export type ApprovalPage = {
  // The pending request's identifier, the only value the form carries.
  pendingId: string;
  // Where the authorization code goes.
  redirectUri: string;
  serviceName: string;
  resource: string;
  clientName: string | undefined;
  // A metadata document's URL, when the client is one.
  metadataUrl: string | undefined;
  // A message about the last attempt, such as a wrong Pairing code.
  error?: string;
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

export const renderApprovalPage = (page: ApprovalPage) => {
  const redirectHost = hostOf(page.redirectUri);
  const metadataHost = page.metadataUrl === undefined ? undefined : hostOf(page.metadataUrl);
  const warnings = [
    ...(metadataHost !== undefined &&
    new URL(page.redirectUri).hostname !== new URL(page.metadataUrl ?? '').hostname
      ? [
          `The code goes to <strong>${shown(redirectHost)}</strong>, not to <strong>${shown(metadataHost)}</strong>, the host that published this client's metadata.`,
        ]
      : []),
    ...(LOOPBACK_HOSTS.has(new URL(page.redirectUri).hostname)
      ? ['The code goes to a program on the device you are approving from, not to a website.']
      : []),
  ];
  return layout(
    'Approve a connection',
    `<h1>Approve a connection?</h1>
<p>Approving sends an authorization code to</p>
<p class="host">${shown(redirectHost)}</p>
<dl>
<dt>Redirect URI</dt><dd><code>${shown(page.redirectUri)}</code></dd>
<dt>Service</dt><dd>${shown(page.serviceName)} <code>${shown(page.resource)}</code></dd>
<dt>Client name, chosen by the client</dt><dd>${page.clientName === undefined ? '<em>none given</em>' : shown(page.clientName)}</dd>
${metadataHost === undefined ? '' : `<dt>Client metadata from</dt><dd>${shown(metadataHost)}</dd>\n`}</dl>
${warnings.map((warning) => `<p class="warning">${warning}</p>`).join('\n')}
${page.error === undefined ? '' : `<p class="error" role="alert">${shown(page.error)}</p>`}
<form method="post" action="/authorize">
<input type="hidden" name="request" value="${shown(page.pendingId)}">
<label for="pairing_code">Pairing code</label>
<input id="pairing_code" name="pairing_code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="32" placeholder="XXXX-XXXX">
<p>Run <code>modgud pair</code> on the Modgud host to get a code.</p>
<div class="actions">
<button type="submit" name="action" value="approve">Approve</button>
<button type="submit" name="action" value="deny">Deny</button>
</div>
</form>`,
  );
};

export type ErrorPage = {
  title: string;
  message: string;
  // A link back to the client, carrying the OAuth error.
  returnTo?: { href: string; host: string };
};

export const renderErrorPage = (page: ErrorPage) =>
  layout(
    shown(page.title),
    `<h1>${shown(page.title)}</h1>
<p>${shown(page.message)}</p>
${page.returnTo === undefined ? '' : `<p><a href="${shown(page.returnTo.href)}">Return to ${shown(page.returnTo.host)}</a></p>`}`,
  );
