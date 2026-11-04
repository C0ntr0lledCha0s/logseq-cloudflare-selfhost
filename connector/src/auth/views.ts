import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { escapeHtml, htmlPage } from "../html";

// Server-rendered pages for the MCP sign-in and the wizard's own sign-in. Every dynamic value is escaped.

export function notAllowedPage(headers: Headers = new Headers()): Response {
  return htmlPage(
    403,
    "Not allowed",
    `<h1>Not allowed</h1>
<p>This GitHub account is not allowed to use this connector. Sign in with the GitHub account that owns it.</p>`,
    headers,
  );
}

export function badRequestPage(message: string, headers: Headers = new Headers()): Response {
  return htmlPage(400, "Sign-in failed", `<h1>Sign-in failed</h1>\n<p>${escapeHtml(message)}</p>`, headers);
}

export function githubFailedPage(headers: Headers = new Headers()): Response {
  return htmlPage(
    502,
    "Sign-in failed",
    "<h1>Sign-in failed</h1>\n<p>GitHub sign-in failed. Please try again.</p>",
    headers,
  );
}

export function consentPage(details: ConsentDescription, handle: string, headers: Headers): Response {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `<strong>${escapeHtml(details.clientDomain)}</strong>`
    : "Not verified: this app registered itself, so its name may not be real.";
  const loopback = details.redirectIsLoopback
    ? '<p class="error"><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>'
    : "";
  const scopes =
    details.scope.length > 0
      ? `<dt>Scopes</dt><dd>${details.scope.map((s) => `<code>${escapeHtml(s)}</code>`).join(", ")}</dd>`
      : "";
  return htmlPage(
    200,
    `Authorize ${details.clientName}`,
    `<h1>Allow ${name} to access your Logseq graphs?</h1>
<p class="lede">It will be able to use every graph connected here, with the access you gave each one.</p>
${loopback}
<div class="card">
<dl class="props">
  <dt>App</dt><dd>${name}</dd>
  <dt>Publisher</dt><dd>${origin}</dd>
  <dt>Access sent to</dt><dd><strong>${escapeHtml(details.redirectHost)}</strong></dd>
  ${scopes}
</dl>
<form method="post" action="/authorize">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <div class="actions">
    <button name="decision" value="approve">Allow and sign in with GitHub</button>
    <button class="quiet" name="decision" value="deny">Deny</button>
  </div>
</form>
</div>
<p class="hint">You will sign in with GitHub next. Only the connector's owner is accepted.</p>`,
    headers,
  );
}

export function signedOutPage(headers: Headers): Response {
  return htmlPage(
    200,
    "Signed out",
    '<h1>Signed out</h1>\n<p>You are signed out of the connector.</p>\n<p class="footer-links"><a class="button" href="/login">Sign in again</a></p>',
    headers,
  );
}

export function formExpiredPage(): Response {
  return htmlPage(403, "Forbidden", "<h1>Forbidden</h1>\n<p>The form has expired. Reload and try again.</p>");
}
