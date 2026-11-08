import { MAX_EXPIRY_DAYS, type ServiceTokenRow } from "../auth/service-tokens";
import { EXPIRY_WARN_DAYS, type GraphRecord, daysUntilExpiry } from "../graphs";
import { escapeHtml, htmlPage } from "../html";

// Server-rendered pages for the "Connect a graph" wizard. Every dynamic value is escaped, and no
// page ever takes a token as input: token fields are always rendered empty.

/** Fields the confirm and edit forms show again after a validation error. Never a token. */
export interface GraphFormValues {
  alias: string;
  mode: string;
  permission: string;
  expires: string;
  expiresUnknown: boolean;
}

function page(status: number, title: string, body: string, nav = ""): Response {
  return htmlPage(status, title, body, new Headers(), nav);
}

function signOut(csrf: string): string {
  return `<form method="post" action="/logout">${csrfField(csrf)}<button class="quiet">Sign out</button></form>`;
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

function choice(name: string, value: string, current: string, label: string, detail: string, required = false): string {
  return `<label class="choice"><input type="radio" name="${name}" value="${value}"${checked(current === value)}${required ? " required" : ""}>
    <span>${label}<small>${detail}</small></span></label>`;
}

function modeFields(mode: string): string {
  return `<fieldset><legend>What Claude may do</legend>
  <div class="choices">
  ${choice("mode", "read", mode, "Read only", "Search and read pages and blocks.", true)}
  ${choice("mode", "write", mode, "Read and write", "Also create and change pages, blocks and properties.")}
  </div>
</fieldset>`;
}

function permissionFields(permission: string): string {
  return `<fieldset><legend>Token permission (as chosen in Logseq)</legend>
  <div class="choices">
  ${choice("permission", "both", permission, "both", "The token can read and write.", true)}
  ${choice("permission", "read", permission, "read", "The token can only read.")}
  </div>
</fieldset>`;
}

function expiryFields(expires: string, unknown: boolean): string {
  return `<fieldset><legend>Token expiry</legend>
  <label class="field"><input type="date" name="expires" value="${escapeHtml(expires)}" pattern="\\d{4}-\\d{2}-\\d{2}" placeholder="YYYY-MM-DD">
    <small>Expiry date shown in Logseq (YYYY-MM-DD)</small></label>
  <label class="check"><input type="checkbox" name="expires_unknown" value="1"${checked(unknown)}> I don't know the expiry date</label>
</fieldset>`;
}

function editStampsField(on: boolean): string {
  return `<fieldset><legend>Edit stamps</legend>
  <label class="check"><input type="checkbox" name="edit_stamps" value="1"${checked(on)}> Mark Claude's edits in the graph</label>
  <small>Blocks Claude creates or changes get the hidden properties editedBy and claudeEditedAt, listed on the Claude Activity page. Unticking stops new stamps; existing ones stay.</small>
</fieldset>`;
}

function tokenField(): string {
  return `<label class="field"><span>Personal access token</span>
  <input type="password" name="token" autocomplete="off" spellcheck="false" required></label>`;
}

function aliasField(value: string): string {
  return `<label class="field"><span>Alias</span>
  <input name="alias" value="${value}" required maxlength="40" spellcheck="false">
  <small>How Claude names this graph: lowercase letters, digits and hyphens.</small></label>`;
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

/** `2026-11-03T09:41:07.123Z` → `2026-11-03 09:41 UTC`. */
function lastUsedText(lastUsedAt: string | null): string {
  if (lastUsedAt === null) return "never";
  return `${escapeHtml(lastUsedAt.slice(0, 10))} ${escapeHtml(lastUsedAt.slice(11, 16))} UTC`;
}

function graphSection(graph: GraphRecord, csrf: string, now: number): string {
  const alias = escapeHtml(graph.alias);
  const action = (name: string) => `/graphs/${encodeURIComponent(graph.alias)}/${name}`;
  const expires = graph.expiresAt === null ? "" : graph.expiresAt.slice(0, 10);
  const write = graph.mode === "write";
  return `<section class="block" id="graph-${alias}">
<div class="block-title"><h2>${alias}</h2><span class="tag${write ? " write" : ""}">${write ? "read-write" : "read-only"}</span></div>
<div class="children">
<dl class="props">
  <dt>Logseq graph</dt><dd>${escapeHtml(graph.graphName)}</dd>
  <dt>Token permission</dt><dd>${escapeHtml(graph.permission)}</dd>
  <dt>Token expires</dt><dd>${expiryText(graph.expiresAt, now)}</dd>
  <dt>Last used</dt><dd>${lastUsedText(graph.lastUsedAt)}</dd>
</dl>
<details><summary>Edit</summary>
<form method="post" action="${action("edit")}">
  ${csrfField(csrf)}
  ${aliasField(alias)}
  ${modeFields(graph.mode)}
  ${expiryFields(expires, graph.expiresAt === null)}
  ${editStampsField(graph.editStamps)}
  <button>Save changes</button>
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
<details class="disconnect"><summary>Disconnect</summary>
<form method="post" action="${action("disconnect")}">
  ${csrfField(csrf)}
  <p>Claude loses access to this graph immediately and the stored token is deleted.</p>
  <button class="danger">Disconnect ${alias}</button>
</form>
</details>
</div>
</section>`;
}

/** GET /graphs. */
export function graphListPage(graphs: GraphRecord[], csrf: string, now: number): Response {
  const list =
    graphs.length === 0
      ? `<div class="empty"><p>No graphs are connected yet. Connect one with a personal access token from Logseq, and Claude can start using it.</p>
<a class="button" href="/graphs/new">Connect a graph</a></div>`
      : `<div class="outline">${graphs.map((graph) => graphSection(graph, csrf, now)).join("\n")}</div>`;
  return page(
    200,
    "Connected graphs",
    `<div class="page-head"><h1>Connected graphs</h1>${graphs.length === 0 ? "" : '<a class="button" href="/graphs/new">Connect a graph</a>'}</div>
<p class="lede">Claude can use these graphs when you prompt it in claude.ai or Claude Code.</p>
${list}
<p class="footer-links"><a href="/tokens">Service tokens</a> for unattended Claude Code sessions and scheduled tasks</p>`,
    signOut(csrf),
  );
}

/** GET /graphs/new, and the same form again after a refused token. */
export function newGraphPage(csrf: string, status = 200, error?: string): Response {
  return page(
    status,
    "Connect a graph",
    `<h1>Connect a graph</h1>
${errorBox(error)}
<ol class="steps">
  <li>In Logseq (nightly), open <strong>Settings → Personal Access Tokens</strong>.</li>
  <li>Create a token for the graph you want Claude to use. Choose permission <strong>both</strong>,
    or <strong>read</strong> if Claude should only read it. Note the expiry date Logseq shows.</li>
  <li>Paste the token below. It is checked with your sync server, stored encrypted, and never shown again.</li>
</ol>
<form class="card" method="post" action="/graphs/new">
  ${csrfField(csrf)}
  ${tokenField()}
  <p class="hint">Only unencrypted graphs can be connected.</p>
  <div class="actions"><button>Check token</button><a class="button quiet" href="/graphs">Cancel</a></div>
</form>`,
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
<p class="lede">The token works. Choose how Claude refers to this graph and what it may do.</p>
${errorBox(error)}
<form class="card" method="post" action="/graphs/confirm">
  ${csrfField(csrf)}
  <input type="hidden" name="pending" value="${escapeHtml(pending)}">
  ${aliasField(escapeHtml(values.alias))}
  ${modeFields(values.mode)}
  ${permissionFields(values.permission)}
  ${expiryFields(values.expires, values.expiresUnknown)}
  <div class="actions"><button>Connect</button><a class="button quiet" href="/graphs">Cancel</a></div>
</form>
<p class="hint">This form expires 10 minutes after the token was checked.</p>`,
  );
}

/** A short message page with a link onwards. */
export function messagePage(status: number, title: string, message: string): Response {
  return page(
    status,
    title,
    `<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<p class="footer-links"><a href="/graphs">Back to connected graphs</a></p>`,
  );
}

/** After a disconnect: the token still works in Logseq until the owner revokes it there. */
export function disconnectedPage(alias: string, revokedTokens = 0): Response {
  const tokens =
    revokedTokens > 0
      ? `\n<p>${revokedTokens} service ${revokedTokens === 1 ? "token that covered it was" : "tokens that covered it were"} revoked. If you reconnect this graph, create new ones on the <a href="/tokens">service tokens</a> page.</p>`
      : "";
  return page(
    200,
    "Graph disconnected",
    `<h1>Disconnected <span class="alias">${escapeHtml(alias)}</span></h1>
<p>Claude can no longer use this graph, and the stored token has been deleted.</p>${tokens}
<p class="callout"><strong>Also revoke the token in Logseq</strong> (Settings → Personal Access Tokens), so it stops working everywhere.</p>
<p class="footer-links"><a href="/graphs">Back to connected graphs</a></p>`,
  );
}

export function forbiddenPage(): Response {
  return messagePage(403, "Forbidden", "The form has expired. Reload the page and try again.");
}

// Service tokens (design docs/superpowers/specs/2026-11-07-service-token-cloud-sessions-design.md §3.7).
// Only tokenCreatedPage ever receives a token, and it is the create response itself.

/** Fields the create form shows again after a refusal. Never a token. */
export interface TokenFormValues {
  name: string;
  graphIds: string[];
  access: string;
  expiresDays: string;
}

/** `ms` since the epoch as `YYYY-MM-DD HH:MM UTC`. */
function utc(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function tokenStatus(token: ServiceTokenRow, now: number): "active" | "expired" | "revoked" {
  if (token.revokedAt !== null) return "revoked";
  return token.expiresAt <= now ? "expired" : "active";
}

function tokenSection(token: ServiceTokenRow, aliases: ReadonlyMap<string, string>, csrf: string, now: number): string {
  const name = escapeHtml(token.name);
  const status = tokenStatus(token, now);
  const graphs = token.graphIds
    .map((id) => {
      const alias = aliases.get(id);
      return alias === undefined ? `<span class="warning">${escapeHtml(id)} (not connected)</span>` : escapeHtml(alias);
    })
    .join(", ");
  const write = token.access === "write";
  const revoke =
    status === "active"
      ? `<form method="post" action="/tokens/${escapeHtml(token.id)}/revoke">
  ${csrfField(csrf)}
  <button class="danger">Revoke ${name}</button>
</form>`
      : "";
  const ended = status === "revoked" ? ` on ${utc(token.revokedAt!)}` : "";
  return `<section class="block" id="token-${name}">
<div class="block-title"><h2>${name}</h2><span class="tag${write ? " write" : ""}">${write ? "read-write" : "read-only"}</span></div>
<div class="children">
<dl class="props">
  <dt>Status</dt><dd>${status}${ended}</dd>
  <dt>Graphs</dt><dd>${graphs}</dd>
  <dt>Expires</dt><dd>${utc(token.expiresAt)}</dd>
  <dt>Last used</dt><dd>${token.lastUsedAt === null ? "never" : utc(token.lastUsedAt)}</dd>
</dl>
${revoke}
</div>
</section>`;
}

/** GET /tokens. */
export function tokenListPage(tokens: ServiceTokenRow[], graphs: GraphRecord[], csrf: string, now: number): Response {
  const aliases = new Map(graphs.map((graph) => [graph.graphId, graph.alias]));
  const list =
    tokens.length === 0
      ? `<div class="empty"><p>No service tokens yet.</p></div>`
      : `<div class="outline">${tokens.map((token) => tokenSection(token, aliases, csrf, now)).join("\n")}</div>`;
  return page(
    200,
    "Service tokens",
    `<div class="page-head"><h1>Service tokens</h1><a class="button" href="/tokens/new">New token</a></div>
<p class="lede">A service token lets an unattended Claude Code session or scheduled task use the chosen graphs without signing in.
Revoked and expired tokens stay listed.</p>
${list}
<p class="footer-links"><a href="/graphs">Back to connected graphs</a></p>`,
    signOut(csrf),
  );
}

/** A box per connected graph, with its own mode, ticked when its id is in `ticked`. */
function graphBoxes(graphs: GraphRecord[], ticked: readonly string[]): string {
  if (graphs.length === 0) return `<p class="hint">No graphs are connected. <a href="/graphs/new">Connect a graph</a> first.</p>`;
  return graphs
    .map((graph) => {
      const mode = graph.mode === "write" ? "read-write" : "read-only";
      return `<label class="check"><input type="checkbox" name="graph" value="${escapeHtml(graph.graphId)}"${checked(ticked.includes(graph.graphId))}> ${escapeHtml(graph.alias)} <small>(${mode})</small></label>`;
    })
    .join("\n  ");
}

/** GET /tokens/new, and the same form again after a refusal. */
export function newTokenPage(csrf: string, graphs: GraphRecord[], values: TokenFormValues, status = 200, error?: string): Response {
  const boxes = graphBoxes(graphs, values.graphIds);
  return page(
    status,
    "New service token",
    `<h1>New service token</h1>
${errorBox(error)}
<form class="card" method="post" action="/tokens/new">
  ${csrfField(csrf)}
  <label class="field"><span>Name</span>
  <input name="name" value="${escapeHtml(values.name)}" required maxlength="40" spellcheck="false">
  <small>Shown in the audit log as service:name. Lowercase letters, digits and hyphens.</small></label>
  <fieldset><legend>Graphs</legend>
  ${boxes}
  <small>A token's access never exceeds a graph's own mode.</small>
  </fieldset>
  <fieldset><legend>What the token may do</legend>
  <div class="choices">
  ${choice("access", "read", values.access, "Read only", "Search and read pages and blocks.", true)}
  ${choice("access", "write", values.access, "Read and write", "Also write to graphs connected read-write.")}
  </div>
  </fieldset>
  <label class="field"><span>Expires after (days)</span>
  <input type="number" name="expires_days" value="${escapeHtml(values.expiresDays)}" min="1" max="${MAX_EXPIRY_DAYS}" required>
  <small>1 to ${MAX_EXPIRY_DAYS} days.</small></label>
  <div class="actions"><button>Create token</button><a class="button quiet" href="/tokens">Cancel</a></div>
</form>`,
  );
}

/** Fields the edit form shows: the stored scope on GET, the valid submitted values after a refusal. Never a token. */
export interface TokenEditValues {
  graphIds: string[];
  access: string;
  expiresDays: string;
}

/**
 * GET /tokens/:id/edit, and the same form again after a refusal (spec 2026-11-08 §3.4). The name is
 * shown, not edited. A graph the token lists that is no longer connected has no box, so saving drops it.
 */
export function editTokenPage(
  csrf: string,
  token: ServiceTokenRow,
  graphs: GraphRecord[],
  values: TokenEditValues,
  status = 200,
  error?: string,
): Response {
  const name = escapeHtml(token.name);
  const connected = new Set(graphs.map((graph) => graph.graphId));
  const gone = token.graphIds
    .filter((id) => !connected.has(id))
    .map((id) => `<p class="hint"><span class="warning">${escapeHtml(id)} (not connected; saving removes it)</span></p>`)
    .join("\n  ");
  return page(
    status,
    "Edit service token",
    `<h1>Edit <span class="alias">${name}</span></h1>
${errorBox(error)}
<form class="card" method="post" action="/tokens/${escapeHtml(token.id)}/edit">
  ${csrfField(csrf)}
  <fieldset><legend>Graphs</legend>
  ${graphBoxes(graphs, values.graphIds)}
  ${gone}
  <small>A token's access never exceeds a graph's own mode.</small>
  </fieldset>
  <fieldset><legend>What the token may do</legend>
  <div class="choices">
  ${choice("access", "read", values.access, "Read only", "Search and read pages and blocks.", true)}
  ${choice("access", "write", values.access, "Read and write", "Also write to graphs connected read-write.")}
  </div>
  </fieldset>
  <label class="field"><span>Shorten expiry to N days from now</span>
  <input type="number" name="expires_days" value="${escapeHtml(values.expiresDays)}" min="1" max="${MAX_EXPIRY_DAYS}">
  <small>Expires ${utc(token.expiresAt)}. Leave blank to keep it. An expiry can only be shortened.</small></label>
  <p class="hint">Removing graphs, read-only and a shorter expiry apply at once, from the token's next request. Adding a graph or raising to read-write is not available yet.</p>
  <p class="hint">Editing does not change the token. If it may have leaked, revoke it and issue a new one.</p>
  <div class="actions"><button>Save changes</button><a class="button quiet" href="/tokens">Cancel</a></div>
</form>`,
  );
}

/** The create response: the only page that ever holds the token, once, never cached. */
export function tokenCreatedPage(name: string, token: string): Response {
  return page(
    200,
    "Service token created",
    `<h1>Created <span class="alias">${escapeHtml(name)}</span></h1>
<p class="callout"><strong>Copy this token now.</strong> It is shown only on this page and can't be shown again.</p>
<label class="field"><span>Token</span>
<input readonly value="${escapeHtml(token)}" autocomplete="off" spellcheck="false"></label>
<p>Select the token, copy it, and store it as the secret <code>LOGSEQ_SERVICE_TOKEN</code> in your Claude Code cloud environment.</p>
<p class="hint">This page is not cached, but a screenshot, a restored browser tab or the clipboard can still hold the token. Close this tab when you're done. If it leaks, revoke it.</p>
<p class="footer-links"><a href="/tokens">Back to service tokens</a></p>`,
  );
}
