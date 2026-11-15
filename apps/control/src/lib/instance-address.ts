/**
 * Öffentliche Adresse einer Instanz.
 *
 * Die Basisdomain kommt aus `VITE_INSTANCE_BASE_DOMAIN` (Build-Zeit). Ohne sie
 * gibt es keine Domain, die die Oberfläche erfinden dürfte: Es bleibt bei der
 * Subdomain, und es entsteht kein Verweis.
 */
const BASE_DOMAIN = (
  (import.meta.env['VITE_INSTANCE_BASE_DOMAIN'] as string | undefined) ?? ''
).replace(/^\.+|\.+$/g, '');

export function instanceHost(subdomain: string): string {
  return BASE_DOMAIN ? `${subdomain}.${BASE_DOMAIN}` : subdomain;
}

/** URL der Instanz, oder null, wenn keine Basisdomain konfiguriert ist. */
export function instanceUrl(subdomain: string): string | null {
  return BASE_DOMAIN ? `https://${subdomain}.${BASE_DOMAIN}` : null;
}
