const LEGACY_ADMIN_STORAGE_KEY = 'inker_session';
let csrfToken: string | null = null;

export function rememberCsrfFromHeaders(headers: Record<string, unknown> | { get?: (name: string) => unknown }): void {
  const value = typeof headers.get === 'function'
    ? headers.get('x-csrf-token')
    : (headers as Record<string, unknown>)['x-csrf-token'];
  if (typeof value === 'string' && value.length > 0) csrfToken = value;
}

export function csrfHeadersFor(method = 'get'): Record<string, string> {
  if (!csrfToken || ['get', 'head', 'options'].includes(method.toLowerCase())) return {};
  return { 'X-CSRF-Token': csrfToken };
}

export function resetCsrfToken(): void {
  csrfToken = null;
}

export function discardLegacyAdminToken(): void {
  // Deliberately do not read or migrate the bearer value. A prior token is a
  // secret and must stop influencing browser authentication immediately.
  localStorage.removeItem(LEGACY_ADMIN_STORAGE_KEY);
}
