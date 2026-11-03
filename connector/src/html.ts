export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** A minimal, unframeable HTML page. `title` is escaped; `body` must already be safe HTML. */
export function htmlPage(status: number, title: string, body: string, headers: Headers = new Headers()): Response {
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
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem">
${body}
</body>
</html>`,
    { status, headers },
  );
}
