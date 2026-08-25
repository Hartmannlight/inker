const CROCKFORD_ALPHABET = /^[0-9A-HJKMNP-TV-Z]{10}$/;

export type PairingErrorKind =
  | 'validation'
  | 'invalid'
  | 'forbidden'
  | 'rate-limited'
  | 'offline'
  | 'server';

export class PairingExchangeError extends Error {
  readonly kind: PairingErrorKind;
  readonly status?: number;

  constructor(
    kind: PairingErrorKind,
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = 'PairingExchangeError';
    this.kind = kind;
    this.status = status;
  }
}

export interface DeviceEnrollmentExchange {
  credential: string;
  credentialId: string;
  device: {
    id: number;
    name: string;
    externalId: string;
    profileId: string;
  };
}

export function normalizePairingCode(value: string): string | null {
  const normalized = value
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return CROCKFORD_ALPHABET.test(normalized) ? normalized : null;
}

export function formatPairingCode(value: string): string {
  const normalized = normalizePairingCode(value);
  return normalized ? `${normalized.slice(0, 5)}-${normalized.slice(5)}` : value;
}

export function normalizePairingBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new PairingExchangeError('validation', 'Enter a valid server base URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new PairingExchangeError('validation', 'Enter an HTTP or HTTPS server base URL without credentials.');
  }
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function appendPath(baseUrl: string, path: string): string {
  const normalized = normalizePairingBaseUrl(baseUrl);
  return `${normalized}${path}`;
}

export function buildPairingBootstrapUrl(baseUrl: string, code: string): string {
  const normalizedCode = normalizePairingCode(code);
  if (!normalizedCode) {
    throw new PairingExchangeError('validation', 'Pairing code must contain ten Crockford Base32 characters.');
  }
  const url = new URL(appendPath(baseUrl, '/display/pair'));
  url.searchParams.set('code', formatPairingCode(normalizedCode));
  return url.toString();
}

export async function exchangeDeviceEnrollment(
  baseUrl: string,
  code: string,
): Promise<DeviceEnrollmentExchange> {
  const normalizedCode = normalizePairingCode(code);
  if (!normalizedCode) {
    throw new PairingExchangeError('validation', 'Pairing code must contain ten Crockford Base32 characters.');
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new PairingExchangeError('offline', 'The browser is offline.');
  }

  let response: Response;
  try {
    response = await fetch(appendPath(baseUrl, '/api/device-enrollments/exchange'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: normalizedCode }),
    });
  } catch {
    throw new PairingExchangeError('offline', 'The pairing server is not reachable.');
  }

  if (!response.ok) {
    const kind: PairingErrorKind = response.status === 400
      ? 'invalid'
      : response.status === 403
        ? 'forbidden'
        : response.status === 429
          ? 'rate-limited'
          : 'server';
    throw new PairingExchangeError(kind, 'Pairing failed.', response.status);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PairingExchangeError('server', 'The pairing server returned an invalid response.', response.status);
  }
  const result = body && typeof body === 'object' && 'data' in body
    ? (body as { data: unknown }).data
    : body;
  if (!isExchangeResult(result)) {
    throw new PairingExchangeError('server', 'The pairing server returned an invalid response.', response.status);
  }
  return result;
}

function isExchangeResult(value: unknown): value is DeviceEnrollmentExchange {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<DeviceEnrollmentExchange>;
  const device = result.device as Partial<DeviceEnrollmentExchange['device']> | undefined;
  return typeof result.credential === 'string' && result.credential.length > 0 &&
    typeof result.credentialId === 'string' && result.credentialId.length > 0 &&
    !!device && typeof device.id === 'number' && typeof device.name === 'string' &&
    typeof device.externalId === 'string' && device.externalId.length > 0 &&
    typeof device.profileId === 'string' && device.profileId.length > 0;
}
