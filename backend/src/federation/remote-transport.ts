import { Resolver } from 'node:dns/promises';
import { connect as tlsConnect, checkServerIdentity, type TLSSocket } from 'node:tls';
import { isIP } from 'node:net';

const DEADLINE_MS = 5000;
const MAX_BYTES = 2_097_152;
class TransportError extends Error {
  constructor(readonly code: string) { super(`REMOTE_${code}`); }
}
const failure = (code: string) => new TransportError(code);

/** Origin only: no URL-parser repair of credentials, escapes or numeric IPv4 aliases. */
export function canonicalRemoteBaseUrl(input: string): string {
  try {
    if (typeof input !== 'string' || input.length > 512 || /[^\x21-\x7e]|[%\\@?#]/.test(input)) throw failure('URL_INVALID');
    const match = /^https:\/\/(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::([1-9][0-9]{0,4}))?\/?$/i.exec(input);
    if (!match || (match[2] && Number(match[2]) > 65535)) throw failure('URL_INVALID');
    const parsed = new URL(input);
    const rawHost = match[1].replace(/^\[|\]$/g, '');
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) {
      if (!isIP(rawHost) || (isIP(host) === 4 && rawHost !== host)) throw failure('URL_INVALID');
    } else if (host.length > 253 || host.endsWith('.') || host.split('.').some(label =>
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw failure('URL_INVALID');
    return parsed.origin;
  } catch { throw failure('URL_INVALID'); }
}

type Address = { address: string; family: 4 | 6 };
type AddressKind = 'public' | 'private' | 'blocked';

function ipv4Kind(address: string): AddressKind {
  const [a, b, c, d] = address.split('.').map(Number);
  if (a === 0 || a >= 224 || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
    || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113) || (a === 168 && b === 63 && c === 129 && d === 16)) return 'blocked';
  if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  return 'public';
}

function ipv6Number(address: string): bigint {
  // URL normalizes mixed dotted/hex IPv6, after net.isIP has validated its syntax.
  const canonical = new URL(`https://[${address}]`).hostname.slice(1, -1);
  const [head, tail] = canonical.split('::');
  const left = head ? head.split(':') : [], right = tail ? tail.split(':') : [];
  const words = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return words.reduce((value, word) => (value << 16n) | BigInt(`0x${word}`), 0n);
}

function addressKind(address: string): AddressKind {
  const family = isIP(address);
  if (family === 4) return ipv4Kind(address);
  if (family !== 6 || address.includes('%')) return 'blocked';
  const value = ipv6Number(address);
  // Mapped IPv4 must be classified as IPv4, never as a public IPv6 escape.
  if (value >> 32n === 0xffffn) {
    const v4 = Number(value & 0xffffffffn);
    return ipv4Kind([v4 >>> 24, (v4 >>> 16) & 255, (v4 >>> 8) & 255, v4 & 255].join('.'));
  }
  if (value === 1n) return 'private';
  if (value === ipv6Number('fd00:ec2::254')) return 'blocked'; // AWS instance metadata over IPv6.
  if (value >> 121n === 0x7en) return 'private'; // fc00::/7, excluding metadata above.
  // Public global unicast only; exclude special-use, documentation and 6to4 space.
  if (value >> 125n !== 1n || value >> 105n === ipv6Number('2001::') >> 105n
    || value >> 96n === ipv6Number('2001:db8::') >> 96n
    || value >> 112n === 0x2002n || value >> 108n === ipv6Number('3fff::') >> 108n) return 'blocked';
  return 'public';
}

export interface RemoteTransportPolicy {
  allowedOrigins: string[];
  privateOrigins?: string[];
  /** Test trust anchor only. Production uses the runtime's normal CA trust configuration. */
  ca?: string;
}
export interface RemoteResponse { status: number; etag: string | null; contentType: string | null; bytes: Buffer }
export interface RemoteRequestOptions { token?: string; etag?: string; maxBytes: number; signal: AbortSignal }

const etagValid = (value: unknown): value is string => typeof value === 'string' && value.length <= 200
  && /^(?:W\/)?"[\x21\x23-\x7e]*"$/.test(value);

/**
 * One narrow HTTP/1 response, with fixed buffers. Bun 1.3.14 node:https ignores
 * maxHeaderSize and does not expose its pre-parser socket bytes, so it cannot
 * bound an unfinished remote header. This parser accepts neither informational
 * responses, chunk extensions, nor trailer fields; no connection is reused.
 */
class RemoteResponseParser {
  private mode: 'headers' | 'length' | 'close' | 'chunkLine' | 'chunkData' | 'chunkCRLF' | 'trailers' | 'done' = 'headers';
  private readonly control = Buffer.allocUnsafe(8192);
  private used = 0;
  private body: Buffer | undefined;
  private total = 0;
  private remaining = 0;
  private crlf = 0;
  private metadata: Omit<RemoteResponse, 'bytes'> | undefined;

  constructor(private readonly maxBytes: number, private readonly conditional: boolean,
    private readonly complete: (response: RemoteResponse) => void) {}

  private headers(): void {
    const lines = this.control.toString('latin1', 0, this.used - 4).split('\r\n');
    const statusLine = /^HTTP\/1\.[01] ([2-5][0-9]{2})(?: [\x20-\x7e]*)?$/.exec(lines.shift() ?? '');
    if (!statusLine || lines.length > 64) throw failure('RESPONSE_INVALID');
    const status = Number(statusLine[1]);
    if (status >= 300 && status < 400 && !(status === 304 && this.conditional)) throw failure('REDIRECT_DENIED');
    const headers = new Map<string, string>();
    for (const line of lines) {
      const field = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([\x20-\x7e\t]*)$/.exec(line);
      if (!field) throw failure('RESPONSE_INVALID');
      const name = field[1].toLowerCase(), value = field[2].trim();
      // Reject duplicate semantic/framing fields, including differently cased names.
      if (headers.has(name) && ['content-length', 'transfer-encoding', 'content-encoding', 'content-type', 'etag'].includes(name))
        throw failure('RESPONSE_INVALID');
      headers.set(name, value);
    }
    const length = headers.get('content-length'), transfer = headers.get('transfer-encoding');
    const encoding = headers.get('content-encoding'), etag = headers.get('etag'), contentType = headers.get('content-type');
    if ((length !== undefined && !/^(?:0|[1-9][0-9]*)$/.test(length))
      || (transfer !== undefined && (transfer.toLowerCase() !== 'chunked' || length !== undefined))
      || (encoding !== undefined && encoding.toLowerCase() !== 'identity')
      || (etag !== undefined && !etagValid(etag))
      || (contentType !== undefined && (contentType.length > 200 || /[^\x20-\x7e]/.test(contentType))))
      throw failure('RESPONSE_INVALID');
    if (length !== undefined && (!Number.isSafeInteger(Number(length)) || Number(length) > this.maxBytes))
      throw failure('RESPONSE_TOO_LARGE');
    if ((status === 204 || status === 304) && (transfer !== undefined || (status === 204 && length !== undefined && length !== '0')))
      throw failure('RESPONSE_INVALID');
    this.metadata = { status, etag: etag ?? null, contentType: contentType ?? null };
    this.body = Buffer.allocUnsafe(this.maxBytes);
    this.used = 0;
    if (status === 204 || status === 304 || length === '0') { this.mode = 'length'; this.remaining = 0; }
    else if (transfer) this.mode = 'chunkLine';
    else if (length !== undefined) { this.mode = 'length'; this.remaining = Number(length); }
    else this.mode = 'close';
  }

  feed(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length && this.mode !== 'done') {
      if (this.mode === 'headers' || this.mode === 'chunkLine') {
        const headers = this.mode === 'headers', limit = headers ? 8192 : 64;
        if (this.used === limit) throw failure('RESPONSE_INVALID');
        this.control[this.used++] = chunk[offset++];
        const n = this.used;
        if (headers && n >= 4 && this.control[n - 4] === 13 && this.control[n - 3] === 10 && this.control[n - 2] === 13 && this.control[n - 1] === 10) {
          this.headers();
        } else if (!headers && n >= 2 && this.control[n - 2] === 13 && this.control[n - 1] === 10) {
          const line = this.control.toString('latin1', 0, n - 2);
          if (!/^[0-9a-fA-F]{1,8}$/.test(line)) throw failure('RESPONSE_INVALID');
          this.remaining = Number.parseInt(line, 16); this.used = 0;
          if (this.remaining > this.maxBytes - this.total) throw failure('RESPONSE_TOO_LARGE');
          this.mode = this.remaining === 0 ? 'trailers' : 'chunkData'; this.crlf = 0;
        }
      } else if (this.mode === 'chunkCRLF' || this.mode === 'trailers') {
        if (chunk[offset++] !== (this.crlf === 0 ? 13 : 10)) throw failure('RESPONSE_INVALID');
        if (++this.crlf === 2) {
          if (this.mode === 'trailers') { this.finish(offset === chunk.length); return; }
          this.mode = 'chunkLine'; this.crlf = 0;
        }
      } else {
        const count = this.mode === 'close' ? chunk.length - offset : Math.min(this.remaining, chunk.length - offset);
        if (this.total + count > this.maxBytes) throw failure('RESPONSE_TOO_LARGE');
        chunk.copy(this.body!, this.total, offset); offset += count; this.total += count;
        if (this.mode !== 'close') {
          this.remaining -= count;
          if (this.remaining === 0) {
            if (this.mode === 'length') { this.finish(offset === chunk.length); return; }
            this.mode = 'chunkCRLF'; this.crlf = 0;
          }
        }
      }
    }
    if (this.mode === 'length' && this.remaining === 0) this.finish(true);
  }

  end(): void {
    if (this.mode === 'done') return;
    if (this.mode !== 'close') throw failure('REQUEST_FAILED');
    this.finish(true);
  }

  private finish(noExtraBytes: boolean): void {
    if (!noExtraBytes || !this.metadata || !this.body) throw failure('RESPONSE_INVALID');
    this.mode = 'done';
    this.complete({ ...this.metadata, bytes: Buffer.from(this.body.subarray(0, this.total)) });
  }
}

/** Bounded worker-only GET. Every connection uses a fresh, validated DNS answer and no shared agent. */
export class RemoteTransport {
  private readonly allowed: Set<string>;
  private readonly privateAllowed: Set<string>;
  private readonly ca?: string;

  constructor(policy?: RemoteTransportPolicy) {
    try {
      const csv = (value: string | undefined) => !value ? [] : value.split(',').map(part => part.trim());
      const configuration = policy ?? { allowedOrigins: csv(process.env.FEDERATION_ALLOWED_ORIGINS),
        privateOrigins: csv(process.env.FEDERATION_PRIVATE_ORIGINS) };
      if (!Array.isArray(configuration.allowedOrigins) || !Array.isArray(configuration.privateOrigins ?? [])
        || configuration.allowedOrigins.length > 32 || (configuration.privateOrigins?.length ?? 0) > 32) throw failure('POLICY_INVALID');
      this.allowed = new Set(configuration.allowedOrigins.map(canonicalRemoteBaseUrl));
      this.privateAllowed = new Set((configuration.privateOrigins ?? []).map(canonicalRemoteBaseUrl));
      if ([...this.privateAllowed].some(origin => !this.allowed.has(origin))) throw failure('POLICY_INVALID');
      this.ca = configuration.ca;
    } catch { throw failure('POLICY_INVALID'); }
  }

  /** Configuration-only check for admin writes; it never resolves DNS or opens a connection. */
  assertOrigin(baseUrl: string): void {
    if (!this.allowed.has(canonicalRemoteBaseUrl(baseUrl))) throw failure('ORIGIN_DENIED');
  }

  async get(baseUrl: string, path: string, options: RemoteRequestOptions): Promise<RemoteResponse> {
    const { token, etag, maxBytes, signal } = options;
    const origin = canonicalRemoteBaseUrl(baseUrl);
    this.assertOrigin(origin);
    if (typeof path !== 'string' || path.length > 2048 || !/^\/[A-Za-z0-9._~/-]*$/.test(path)
      || path.includes('//') || path.split('/').some(part => part === '.' || part === '..')
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES
      || (token !== undefined && (typeof token !== 'string' || !/^sp_share_[A-Za-z0-9_-]{64}$/.test(token)))
      || (etag !== undefined && !etagValid(etag))) throw failure('REQUEST_INVALID');
    if (signal.aborted) throw failure('ABORTED');
    const parsed = new URL(origin), host = parsed.hostname.replace(/^\[|\]$/g, '');
    const resolver = new Resolver({ timeout: 2000, tries: 1 });

    return new Promise<RemoteResponse>((resolve, reject) => {
      let settled = false, socket: TLSSocket | undefined;
      const cleanup = () => {
        clearTimeout(timer); signal.removeEventListener('abort', abort); resolver.cancel();
      };
      // Do not free Bun's TLS handle inside its native data callback.
      const close = () => {
        const connected = socket;
        if (connected) setImmediate(() => { if (!connected.destroyed) connected.destroy(); });
      };
      const fail = (code: string) => {
        if (settled) return;
        settled = true; cleanup(); close(); reject(failure(code));
      };
      const abort = () => fail('ABORTED');
      const timer = setTimeout(() => fail('TIMEOUT'), DEADLINE_MS);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }

      const records = async (): Promise<Address[]> => {
        const family = isIP(host);
        if (family === 4 || family === 6) return [{ address: host, family }];
        const familyRecords = async (family: 4 | 6): Promise<Address[]> => {
          try {
            const values = family === 4 ? await resolver.resolve4(host) : await resolver.resolve6(host);
            return values.map(address => ({ address, family }));
          } catch (error) {
            if (['ENODATA', 'ENOTFOUND'].includes((error as { code?: string }).code ?? '')) return [];
            throw failure('DNS_FAILED');
          }
        };
        return (await Promise.all([familyRecords(4), familyRecords(6)])).flat();
      };

      void records().then(addresses => {
        if (settled) return;
        if (!addresses.length || addresses.length > 32) { fail('DNS_FAILED'); return; }
        if (addresses.some(entry => isIP(entry.address) !== entry.family || addressKind(entry.address) === 'blocked'
          || (addressKind(entry.address) === 'private' && !this.privateAllowed.has(origin)))) { fail('ADDRESS_DENIED'); return; }
        const unique = new Set(addresses.map(entry => entry.family === 6 ? ipv6Number(entry.address).toString() : entry.address));
        if (unique.size !== addresses.length) { fail('DNS_FAILED'); return; }
        const selected = addresses[0];
        try {
          const parser = new RemoteResponseParser(maxBytes, etag !== undefined, response => {
            if (settled) return;
            settled = true; cleanup(); close(); resolve(response);
          });
          const parse = (operation: () => void) => {
            if (settled) return;
            try { operation(); } catch (error) { fail(error instanceof TransportError ? error.code : 'RESPONSE_INVALID'); }
          };
          // Connect to the validated numeric address: no second DNS resolution,
          // proxy environment, pooled socket or HTTP/2 negotiation can intervene.
          socket = tlsConnect({ host: selected.address, port: Number(parsed.port) || 443,
            servername: isIP(host) ? undefined : host, rejectUnauthorized: true, minVersion: 'TLSv1.2', ca: this.ca,
            ALPNProtocols: ['http/1.1'], checkServerIdentity: (_serverName, cert) => checkServerIdentity(host, cert),
          });
          socket.on('error', () => fail('REQUEST_FAILED'));
          socket.on('data', (chunk: Buffer) => parse(() => parser.feed(chunk)));
          socket.on('end', () => parse(() => parser.end()));
          socket.on('close', () => { if (!settled) fail('REQUEST_FAILED'); });
          socket.once('secureConnect', () => {
            if (settled) { close(); return; }
            if (!socket?.authorized || (socket.alpnProtocol && socket.alpnProtocol !== 'http/1.1')) { fail('REQUEST_FAILED'); return; }
            const headers = [`GET ${path} HTTP/1.1`, `Host: ${parsed.host}`, 'Accept-Encoding: identity', 'Connection: close',
              ...(token ? [`Authorization: Bearer ${token}`] : []),
              ...(etag ? [`If-None-Match: ${etag}`] : [])];
            socket.write(headers.join('\r\n') + '\r\n\r\n');
          });
        } catch { fail('REQUEST_FAILED'); }
      }, () => fail('DNS_FAILED')).catch(() => fail('REQUEST_FAILED'));
    });
  }
}

export function newRemoteTransport(): RemoteTransport { return new RemoteTransport(); }

/** Pure allowlist validation, intentionally separate from the worker's DNS checks. */
export function assertRemoteOrigin(baseUrl: string, policy?: RemoteTransportPolicy): void {
  new RemoteTransport(policy).assertOrigin(baseUrl);
}
