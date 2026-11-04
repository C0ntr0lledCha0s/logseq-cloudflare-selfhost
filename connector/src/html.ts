export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

// One inline stylesheet for every page. The CSP allows inline styles only, so the pages use system
// fonts and draw everything (bullets, threads, icons) in CSS.
const STYLE = `<style>
:root {
  color-scheme: light dark;
  --paper: #f6f8f7;
  --surface: #ffffff;
  --ink: #15272c;
  --muted: #586d72;
  --thread: #cfdad9;
  --rule: #dfe6e5;
  --accent: #0b7480;
  --accent-ink: #ffffff;
  --accent-wash: #e3f1f1;
  --halo: #cfe4e4;
  --warn: #8a4b00;
  --warn-wash: #fbefd9;
  --danger: #b0261c;
  --danger-wash: #fbe5e2;
  --sans: "Seravek", "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", source-sans-pro, sans-serif;
  --mono: ui-monospace, "SF Mono", "Cascadia Mono", "Segoe UI Mono", "DejaVu Sans Mono", monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #0c2127;
    --surface: #102a31;
    --ink: #e2ecea;
    --muted: #8ea6a8;
    --thread: #2a4a52;
    --rule: #20414a;
    --accent: #5cc4cb;
    --accent-ink: #062126;
    --accent-wash: #143941;
    --halo: #23505a;
    --warn: #f2bb62;
    --warn-wash: #3a2f17;
    --danger: #ff8f84;
    --danger-wash: #3d1d1b;
  }
}
*, *::before, *::after { box-sizing: border-box; }
html { background: var(--paper); }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font: 16px/1.55 var(--sans);
  -webkit-font-smoothing: antialiased;
}
.masthead, main { max-width: 42rem; margin: 0 auto; padding: 0 1rem; }
.masthead {
  display: flex; align-items: center; justify-content: space-between; gap: 1rem;
  padding-top: 1.25rem; padding-bottom: 1.25rem;
}
.wordmark { display: flex; align-items: center; gap: .6rem; font-weight: 600; color: var(--muted); text-decoration: none; }
.wordmark::before {
  content: ""; width: .55rem; height: .55rem; border-radius: 50%;
  background: var(--accent); box-shadow: 0 0 0 .3rem var(--halo);
}
main { padding-bottom: 4rem; }
h1 { font-size: 2rem; line-height: 1.2; font-weight: 600; letter-spacing: -.015em; margin: 1.5rem 0 .75rem; }
h2 { font-size: 1.25rem; line-height: 1.3; font-weight: 600; margin: 0; }
p { margin: .75rem 0; max-width: 36rem; }
a { color: var(--accent); text-underline-offset: .2em; }
strong { font-weight: 600; }
code, .alias { font-family: var(--mono); font-size: .9em; }
.lede { color: var(--muted); margin-top: 0; }
.hint { color: var(--muted); font-size: .9rem; }
.page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
.page-head h1 { margin-bottom: 0; }
.page-head + .lede { margin-top: .5rem; }

/* Buttons and button-styled links */
button, .button {
  display: inline-flex; align-items: center; justify-content: center; gap: .4rem;
  font: inherit; font-weight: 600; line-height: 1.2;
  padding: .6rem 1rem; border-radius: .5rem; cursor: pointer; text-decoration: none;
  border: 1px solid var(--accent); background: var(--accent); color: var(--accent-ink);
}
button:hover, .button:hover { filter: brightness(1.08); }
.quiet { background: transparent; color: var(--ink); border-color: var(--rule); }
.quiet:hover { border-color: var(--muted); filter: none; }
.danger { background: var(--danger); border-color: var(--danger); color: var(--surface); }
.actions { display: flex; gap: .6rem; flex-wrap: wrap; margin-top: 1.25rem; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* Forms */
form { margin: 0; }
.field { display: block; margin: 1rem 0; }
.field > span { display: block; font-weight: 600; margin-bottom: .3rem; }
.field > small { display: block; color: var(--muted); font-size: .85rem; margin-top: .3rem; }
input[type="text"], input:not([type]), input[type="password"], input[type="date"] {
  width: 100%; font: inherit; color: var(--ink); background: var(--surface);
  border: 1px solid var(--rule); border-radius: .5rem; padding: .55rem .7rem;
}
input[type="password"] { font-family: var(--mono); }
input:focus-visible { outline: 2px solid var(--accent); outline-offset: 0; border-color: var(--accent); }
fieldset { border: 0; padding: 0; margin: 1.25rem 0; min-width: 0; }
legend { font-weight: 600; padding: 0; margin-bottom: .4rem; }
.choices { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: .5rem; }
.choice {
  display: flex; gap: .6rem; align-items: flex-start; cursor: pointer;
  padding: .65rem .8rem; border: 1px solid var(--rule); border-radius: .5rem; background: var(--surface);
}
.choice small { display: block; color: var(--muted); font-size: .85rem; }
.choice:has(input:checked) { border-color: var(--accent); background: var(--accent-wash); }
.choice input, .check input { accent-color: var(--accent); margin-top: .3rem; }
.check { display: flex; gap: .5rem; align-items: flex-start; margin-top: .5rem; color: var(--muted); }

/* Notices */
.error, .warning { border-radius: .5rem; padding: .7rem .9rem; }
.error { background: var(--danger-wash); color: var(--ink); border-left: 3px solid var(--danger); }
.callout { border-radius: .5rem; padding: .7rem .9rem; background: var(--warn-wash); border-left: 3px solid var(--warn); }
.warning { display: block; width: fit-content; margin-top: .3rem; padding: .25rem .6rem; background: var(--warn-wash); color: var(--warn); font-size: .9rem; }

/* Outline: each graph is a block with a bullet, a thread and child blocks, like Logseq's outliner */
.outline { margin: 2rem 0; }
.block { position: relative; padding-left: 1.75rem; margin-bottom: 2rem; }
.block::before {
  content: ""; position: absolute; left: .3rem; top: .55rem;
  width: .6rem; height: .6rem; border-radius: 50%; background: var(--accent);
}
.block-title { display: flex; align-items: baseline; gap: .75rem; flex-wrap: wrap; }
.block-title h2 { font-family: var(--mono); font-size: 1.15rem; }
.tag { font-size: .85rem; color: var(--muted); border: 1px solid var(--rule); border-radius: 1rem; padding: 0 .55rem; }
.tag.write { color: var(--accent); border-color: var(--accent); }
.children { position: relative; margin: .5rem 0 0 -1.15rem; padding-left: 1.15rem; border-left: 1px solid var(--thread); }
.props { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1.25rem; margin: 0 0 .5rem; padding: .25rem 0 .25rem .6rem; }
.props dt { color: var(--muted); }
.props dd { margin: 0; font-variant-numeric: tabular-nums; }
.children details { position: relative; padding-left: .6rem; }
.children summary {
  list-style: none; cursor: pointer; display: inline-block; padding: .2rem 0; color: var(--ink);
}
.children summary::-webkit-details-marker { display: none; }
.children summary::before {
  content: ""; position: absolute; left: -1.43rem; top: .7rem;
  width: .45rem; height: .45rem; border-radius: 50%; background: var(--muted);
  box-shadow: 0 0 0 .25rem var(--halo);
}
.children details[open] > summary::before { box-shadow: none; background: var(--accent); }
.children details[open] > summary { font-weight: 600; }
.children summary:hover { color: var(--accent); }
.children details > form, .children details > .panel { padding: .25rem 0 1rem; }
.children details.disconnect summary:hover, .children details.disconnect[open] > summary { color: var(--danger); }
.children details.disconnect[open] > summary::before { background: var(--danger); }
.empty { padding: 1.5rem; border: 1px dashed var(--thread); border-radius: .75rem; }
.empty p { margin-top: 0; }

/* Numbered steps: the connect flow really is a sequence */
.steps { list-style: none; counter-reset: step; padding: 0; margin: 1.5rem 0; }
.steps li { counter-increment: step; position: relative; padding-left: 2.5rem; margin-bottom: 1rem; }
.steps li::before {
  content: counter(step); position: absolute; left: 0; top: 0;
  width: 1.7rem; height: 1.7rem; border-radius: 50%; display: grid; place-items: center;
  font-size: .85rem; font-weight: 600; color: var(--accent); background: var(--accent-wash);
}
.card { background: var(--surface); border: 1px solid var(--rule); border-radius: .75rem; padding: 1.25rem; margin: 1.5rem 0; }
.card > :first-child, .card > input[type="hidden"] + * { margin-top: 0; }
.footer-links { margin-top: 2rem; }

@media (max-width: 30rem) {
  h1 { font-size: 1.6rem; }
  .props { grid-template-columns: 1fr; gap: 0; }
  .props dd { margin-bottom: .4rem; }
}
</style>`;

/**
 * A minimal, unframeable HTML page. `title` is escaped; `body` and `nav` must already be safe HTML.
 * `nav` goes on the right of the masthead (the wizard's sign-out button).
 */
export function htmlPage(
  status: number,
  title: string,
  body: string,
  headers: Headers = new Headers(),
  nav = "",
): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  // No form-action: the consent form's response redirects to GitHub or the client, which it would block.
  headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "no-referrer");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  return new Response(
    `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${STYLE}
<body>
<header class="masthead"><span class="wordmark">Logseq connector</span>${nav}</header>
<main>
${body}
</main>
</body>
</html>`,
    { status, headers },
  );
}
