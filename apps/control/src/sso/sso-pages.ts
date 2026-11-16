/**
 * Die kleinen HTML-Antworten des SSO-Callbacks.
 *
 * Der Callback ist eine Navigation des Browsers und kein Aufruf der
 * Oberfläche; er antwortet deshalb mit einer Seite statt mit JSON. Die Seiten
 * leiten per `<meta refresh>` weiter — absichtlich KEIN 302: Eine
 * Weiterleitung nach einer seitenübergreifenden Navigation (Portal → hier)
 * gilt für `SameSite=Strict`-Cookies noch als seitenübergreifend, und die
 * Oberfläche bekäme ihr frisch gesetztes Sitzungs-Cookie nicht mit. Die
 * Weiterleitung per Meta-Refresh ist dagegen eine eigene, gleichseitige
 * Navigation.
 *
 * In die Seiten fließt nur ein Pfad, der zuvor `assertAllowedReturnPath`
 * passiert hat bzw. eine feste Zeichenkette.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Eine schlichte, eigenständige Seite mit Weiterleitung. */
export function redirectPage(
  title: string,
  message: string,
  target: string,
): string {
  const safe = escapeHtml(target);
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0;url=${safe}">
<title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;margin:3rem auto;max-width:32rem;padding:0 1rem;color:#222}a{color:#0b5cad}</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<p><a href="${safe}">Weiter</a></p>
</body>
</html>
`;
}

/** Die leere Seite des Front-Channel-Logouts (läuft in einem unsichtbaren iframe). */
export function emptyPage(): string {
  return '<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Abgemeldet</title></head><body></body></html>\n';
}
