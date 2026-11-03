import { EXPIRY_WARN_DAYS, type GraphRecord, daysUntilExpiry } from "../graphs";
import { escapeHtml, htmlPage } from "../html";

// Server-rendered pages for the "Connect a graph" wizard. Every dynamic value is escaped, and no
// page ever takes a token as input: token fields are always rendered empty.

const STYLE = `<style>
  label { display: block; margin: .6rem 0 .2rem; }
  fieldset { border: 1px solid #ccc; margin: .8rem 0; }
  section { border-top: 1px solid #ccc; padding: .5rem 0 1rem; }
  .error { background: #fde8e8; border-left: 4px solid #c00; padding: .5rem .8rem; }
  .warning { background: #fff4d6; border-left: 4px solid #c80; padding: .3rem .6rem; }
  .hint { color: #555; font-size: .9em; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .2rem 1rem; }
  dt { font-weight: 600; }
</style>`;

/** Fields the confirm and edit forms show again after a validation error. Never a token. */
export interface GraphFormValues {
  alias: string;
  mode: string;
  permission: string;
  expires: string;
  expiresUnknown: boolean;
}

function page(status: number, title: string, body: string): Response {
  return htmlPage(status, title, `${STYLE}\n${body}`);
}

function errorBox(error: string | undefined): string {
  return error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : "";
}

function csrfField(csrf: string): string {
  return `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
}

function checked(on: boolean): string {
  return on ? " checked" : "";
}

function modeFields(mode: string): string {
  return `<fieldset><legend>What Claude may do</legend>
  <label><input type="radio" name="mode" value="read"${checked(mode === "read")} required> Read only</label>
  <label><input type="radio" name="mode" value="write"${checked(mode === "write")}> Read and write</label>
</fieldset>`;
}

function permissionFields(permission: string): string {
  return `<fieldset><legend>Token permission (as chosen in Logseq)</legend>
  <label><input type="radio" name="permission" value="both"${checked(permission === "both")} required> both</label>
  <label><input type="radio" name="permission" value="read"${checked(permission === "read")}> read</label>
</fieldset>`;
}

function expiryFields(expires: string, unknown: boolean): string {
  return `<fieldset><legend>Token expiry</legend>
  <label>Expiry date shown in Logseq (YYYY-MM-DD)
    <input type="date" name="expires" value="${escapeHtml(expires)}" pattern="\\d{4}-\\d{2}-\\d{2}" placeholder="YYYY-MM-DD"></label>
  <label><input type="checkbox" name="expires_unknown" value="1"${checked(unknown)}> I don't know the expiry date</label>
</fieldset>`;
}

function tokenField(): string {
  return `<label>Personal access token
  <input type="password" name="token" autocomplete="off" spellcheck="false" required size="50"></label>`;
}

function expiryText(expiresAt: string | null, now: number): string {
  if (expiresAt === null) return "unknown";
  const date = escapeHtml(expiresAt.slice(0, 10));
  const days = daysUntilExpiry(expiresAt, now);
  if (days <= 0) return `${date} <span class="warning">Expired: create a new token in Logseq and replace it below.</span>`;
  if (days <= EXPIRY_WARN_DAYS) {
    const unit = days === 1 ? "day" : "days";
    return `${date} <span class="warning">Expires in ${days} ${unit}: create a new token in Logseq and replace it below.</span>`;
  }
  return date;
}

function graphSection(graph: GraphRecord, csrf: string, now: number): string {
  const alias = escapeHtml(graph.alias);
  const action = (name: string) => `/graphs/${encodeURIComponent(graph.alias)}/${name}`;
  const expires = graph.expiresAt === null ? "" : graph.expiresAt.slice(0, 10);
  return `<section id="graph-${alias}">
<h2>${alias}</h2>
<dl>
  <dt>Logseq graph</dt><dd>${escapeHtml(graph.graphName)}</dd>
  <dt>Claude may</dt><dd>${graph.mode === "write" ? "read-write" : "read-only"}</dd>
  <dt>Token permission</dt><dd>${escapeHtml(graph.permission)}</dd>
  <dt>Token expires</dt><dd>${expiryText(graph.expiresAt, now)}</dd>
  <dt>Last used</dt><dd>${graph.lastUsedAt === null ? "never" : escapeHtml(graph.lastUsedAt)}</dd>
</dl>
<details><summary>Edit</summary>
<form method="post" action="${action("edit")}">
  ${csrfField(csrf)}
  <label>Alias (how Claude names this graph)
    <input name="alias" value="${alias}" required maxlength="40"></label>
  ${modeFields(graph.mode)}
  ${expiryFields(expires, graph.expiresAt === null)}
  <button>Save</button>
</form>
</details>
<details><summary>Replace token</summary>
<form method="post" action="${action("token")}">
  ${csrfField(csrf)}
  <p class="hint">Create a new token for the same graph in Logseq, paste it here, then revoke the old one in Logseq.</p>
  ${tokenField()}
  ${permissionFields("")}
  ${expiryFields("", false)}
  <button>Replace token</button>
</form>
</details>
<details><summary>Disconnect</summary>
<form method="post" action="${action("disconnect")}">
  ${csrfField(csrf)}
  <p>Claude loses access to this graph immediately and the stored token is deleted.</p>
  <button>Disconnect ${alias}</button>
</form>
</details>
</section>`;
}

/** GET /graphs. */
export function graphListPage(graphs: GraphRecord[], csrf: string, now: number): Response {
  const list =
    graphs.length === 0
      ? "<p>No graphs are connected yet.</p>"
      : graphs.map((graph) => graphSection(graph, csrf, now)).join("\n");
  return page(
    200,
    "Connected graphs",
    `<h1>Connected graphs</h1>
<p><a href="/graphs/new">Connect a graph</a></p>
${list}
<form method="post" action="/logout">
  ${csrfField(csrf)}
  <button>Sign out</button>
</form>`,
  );
}

/** GET /graphs/new, and the same form again after a refused token. */
export function newGraphPage(csrf: string, status = 200, error?: string): Response {
  return page(
    status,
    "Connect a graph",
    `<h1>Connect a graph</h1>
${errorBox(error)}
<ol>
  <li>In Logseq (nightly), open <strong>Settings → Personal Access Tokens</strong>.</li>
  <li>Create a token for the graph you want Claude to use. Choose permission <strong>both</strong>,
    or <strong>read</strong> if Claude should only read it. Note the expiry date Logseq shows.</li>
  <li>Paste the token below. It is checked with your sync server, stored encrypted, and never shown again.</li>
</ol>
<p class="hint">Only unencrypted graphs can be connected.</p>
<form method="post" action="/graphs/new">
  ${csrfField(csrf)}
  ${tokenField()}
  <button>Check token</button>
</form>
<p><a href="/graphs">Back to connected graphs</a></p>`,
  );
}

/** Refusal for an end-to-end encrypted graph. */
export function encryptedGraphPage(csrf: string, graphName: string): Response {
  return newGraphPage(
    csrf,
    422,
    `“${graphName}” is an end-to-end encrypted graph, and encrypted graphs aren't supported: ` +
      "their content is encrypted with keys that stay on your devices, so the connector can't read it. " +
      "Nothing was saved. Revoke this token in Logseq.",
  );
}

/** The confirm step: `pending` is the sealed token; the page never contains the token itself. */
export function confirmPage(
  csrf: string,
  pending: string,
  graphName: string,
  values: GraphFormValues,
  status = 200,
  error?: string,
): Response {
  return page(
    status,
    "Confirm graph",
    `<h1>Connect “${escapeHtml(graphName)}”</h1>
${errorBox(error)}
<form method="post" action="/graphs/confirm">
  ${csrfField(csrf)}
  <input type="hidden" name="pending" value="${escapeHtml(pending)}">
  <label>Alias (how Claude names this graph: lowercase letters, digits and hyphens)
    <input name="alias" value="${escapeHtml(values.alias)}" required maxlength="40"></label>
  ${modeFields(values.mode)}
  ${permissionFields(values.permission)}
  ${expiryFields(values.expires, values.expiresUnknown)}
  <button>Connect</button>
</form>
<p class="hint">This form expires 10 minutes after the token was checked.</p>
<p><a href="/graphs">Cancel</a></p>`,
  );
}

/** A short message page with a link onwards. */
export function messagePage(status: number, title: string, message: string): Response {
  return page(
    status,
    title,
    `<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<p><a href="/graphs">Back to connected graphs</a></p>`,
  );
}

/** After a disconnect: the token still works in Logseq until the owner revokes it there. */
export function disconnectedPage(alias: string): Response {
  return page(
    200,
    "Graph disconnected",
    `<h1>Disconnected ${escapeHtml(alias)}</h1>
<p>Claude can no longer use this graph, and the stored token has been deleted.</p>
<p><strong>Also revoke the token in Logseq</strong> (Settings → Personal Access Tokens), so it stops working everywhere.</p>
<p><a href="/graphs">Back to connected graphs</a></p>`,
  );
}

export function forbiddenPage(): Response {
  return messagePage(403, "Forbidden", "The form has expired. Reload the page and try again.");
}
