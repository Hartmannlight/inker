import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Resolver } from 'node:dns/promises';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { assertRemoteOrigin, canonicalRemoteBaseUrl, newRemoteTransport, RemoteTransport } from './remote-transport';

const token = `sp_share_${'a'.repeat(64)}`;
const signal = () => new AbortController().signal;
const noData = () => Promise.reject(Object.assign(new Error('synthetic DNS failure'), { code: 'ENODATA' }));
type TestSocket = { write(data: string | Buffer): boolean; end(data?: string | Buffer): void };
type TestRequest = { url: string; headers: Record<string, string | undefined> };
type TestResponse = {
  writeHead(status: number, headers?: Record<string, string | number>): TestResponse;
  write(data: string | Buffer): boolean;
  end(data?: string | Buffer): void;
};

// Combined Windows host runs with Bun 1.3.14 showed native crashes/hangs;
// the cause is not established. Keep the real TLS peer in a separate Node
// process while the production transport under test still runs in Bun.
const TLS_PEER = String.raw`
const { createServer } = require('node:tls');
const { readFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
const sockets = new Map(), connections = new Set();
let nextId = 0;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const server = createServer({ key: readFileSync(process.argv[1]), cert: readFileSync(process.argv[2]) }, socket => {
  const id = ++nextId; sockets.set(id, socket);
  socket.on('close', () => sockets.delete(id)); socket.on('error', () => {}); socket.setNoDelay(true);
  let pending = '';
  const read = chunk => {
    pending += chunk.toString('ascii');
    if (pending.length > 4096) { socket.destroy(); return; }
    if (!pending.endsWith('\r\n\r\n')) return;
    socket.removeListener('data', read);
    const [line, ...fields] = pending.trimEnd().split('\r\n'), headers = {};
    for (const field of fields) {
      const index = field.indexOf(':'); headers[field.slice(0, index).toLowerCase()] = field.slice(index + 1).trim();
    }
    send({ type: 'request', id, request: { url: line.split(' ')[1], headers } });
  };
  socket.on('data', read);
});
server.on('connection', socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
server.on('tlsClientError', () => {});
server.listen(0, '127.0.0.1', () => send({ type: 'ready', port: server.address().port }));
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'reset' || message.type === 'shutdown') {
    for (const socket of connections) socket.destroy();
    if (message.type === 'reset') send({ type: 'reset' });
    else server.close(() => process.exit(0));
    return;
  }
  const socket = sockets.get(message.id);
  if (!socket || socket.destroyed) return;
  const bytes = Buffer.from(message.data, 'base64');
  if (message.type === 'write') socket.write(bytes); else socket.end(bytes);
});
process.stdin.on('end', () => process.exit(0));
`;

function responseWriter(socket: TestSocket): TestResponse {
  return {
    writeHead(status, headers = {}) {
      socket.write(`HTTP/1.1 ${status} Test\r\n${Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join('')}\r\n`);
      return this;
    },
    write(data) { return socket.write(data); },
    end(data) { if (data === undefined) socket.end(); else socket.end(data); },
  };
}

describe('WP-27 canonical remote origins', () => {
  test.each([
    ['https://EXAMPLE.com', 'https://example.com'], ['https://example.com/', 'https://example.com'],
    ['https://example.com:443', 'https://example.com'], ['https://example.com:8443', 'https://example.com:8443'],
    ['https://[2001:4860:4860:0:0:0:0:8888]', 'https://[2001:4860:4860::8888]'],
  ])('canonicalizes %s', (value, expected) => expect(canonicalRemoteBaseUrl(value)).toBe(expected));

  test.each(['http://example.com', '//example.com', ' https://example.com', 'https://example.com\n',
    'https://user:pass@example.com', 'https://example.com@evil.test', 'https://example.com/path',
    'https://example.com?token=secret', 'https://example.com#fragment', 'https://example.com/%2f',
    'https://example.com\\@evil.test', 'https://example.com.', 'https://example..com',
    'https://-example.com', 'https://example.com:0', 'https://example.com:65536',
    'https://2130706433', 'https://0x7f000001', 'https://127.1', 'https://0177.0.0.1',
    'https://[fe80::1%25eth0]', 'https://éxample.com', 'https://', 'https://example.com//'])(
    'rejects ambiguous/non-origin URL %s', value => expect(() => canonicalRemoteBaseUrl(value)).toThrow('REMOTE_URL_INVALID'));

  test('private exceptions must be an exact subset of allowed canonical origins', () => {
    expect(() => new RemoteTransport({ allowedOrigins: ['https://example.com'], privateOrigins: ['https://other.test'] }))
      .toThrow('REMOTE_POLICY_INVALID');
    expect(() => new RemoteTransport({ allowedOrigins: ['https://example.com/path'] })).toThrow('REMOTE_POLICY_INVALID');
    expect(() => new RemoteTransport({ allowedOrigins: Array(33).fill('https://example.com') })).toThrow('REMOTE_POLICY_INVALID');
  });
});

describe('WP-27 bounded HTTPS remote transport', () => {
  let directory: string, ca: string, origin: string, peer: ChildProcessWithoutNullStreams;
  let reset: (() => void) | undefined;
  let handler: (request: TestRequest, response: TestResponse) => void;
  let rawHandler: ((socket: TestSocket) => void | Promise<void>) | undefined;
  let received: { url: string | undefined; host: string | undefined; authorization: string | undefined; etag: string | undefined }[];
  let dns4: ReturnType<typeof spyOn<typeof Resolver.prototype, 'resolve4'>>;
  let dns6: ReturnType<typeof spyOn<typeof Resolver.prototype, 'resolve6'>>;

  async function boundedPeer<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { peer?.kill(); reject(new Error('TLS fixture process deadline')); }, 3000);
      });
      return await Promise.race([operation(), deadline]);
    } finally { clearTimeout(timer); }
  }

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'inker-remote-tls-'));
    const gitOpenSSL = 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe';
    const openssl = process.platform === 'win32' && existsSync(gitOpenSSL) ? gitOpenSSL : 'openssl';
    execFileSync(openssl, ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
      '-days', '1', '-subj', '/CN=remote.test', '-addext', 'subjectAltName=DNS:remote.test,IP:127.0.0.1',
      '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')],
    { windowsHide: true, timeout: 10_000, maxBuffer: 16_384, stdio: 'pipe' });
    ca = readFileSync(join(directory, 'cert.pem'), 'utf8');
    await boundedPeer(() => new Promise<void>((resolve, reject) => {
      peer = spawn('node', ['-e', TLS_PEER, join(directory, 'key.pem'), join(directory, 'cert.pem')],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      peer.on('error', reject);
      peer.stderr.resume();
      peer.once('exit', () => reject(new Error('TLS fixture exited before ready')));
      let output = '';
      peer.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        let end: number;
        while ((end = output.indexOf('\n')) >= 0) {
          const message = JSON.parse(output.slice(0, end)); output = output.slice(end + 1);
          if (message.type === 'ready') { origin = `https://remote.test:${message.port}`; resolve(); continue; }
          if (message.type === 'reset') { reset?.(); reset = undefined; continue; }
          const socket: TestSocket = {
            write(data) { return peer.stdin.write(JSON.stringify({ type: 'write', id: message.id, data: Buffer.from(data).toString('base64') }) + '\n'); },
            end(data = '') { peer.stdin.write(JSON.stringify({ type: 'end', id: message.id, data: Buffer.from(data).toString('base64') }) + '\n'); },
          };
          if (rawHandler) { void rawHandler(socket); continue; }
          const request = message.request as TestRequest;
          received.push({ url: request.url, host: request.headers.host, authorization: request.headers.authorization,
            etag: request.headers['if-none-match'] });
          handler(request, responseWriter(socket));
        }
      });
    }));
  });

  beforeEach(() => {
    received = [];
    rawHandler = undefined;
    handler = (_request, response) => response.writeHead(200, { 'Content-Type': 'application/json', ETag: '"revision-1"' }).end('{"ok":true}');
    dns4 = spyOn(Resolver.prototype, 'resolve4').mockImplementation((async () => ['127.0.0.1']) as unknown as typeof Resolver.prototype.resolve4);
    dns6 = spyOn(Resolver.prototype, 'resolve6').mockImplementation(noData as typeof Resolver.prototype.resolve6);
  });

  afterEach(async () => {
    dns4?.mockRestore(); dns6?.mockRestore();
    await new Promise<void>(resolve => setImmediate(resolve));
    if (!peer || peer.exitCode !== null) throw new Error('TLS fixture is not running');
    await boundedPeer(() => new Promise<void>(resolve => { reset = resolve; peer.stdin.write('{"type":"reset"}\n'); }));
  });
  afterAll(async () => {
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('inker-remote-tls-'))
      throw new Error('Unsafe TLS fixture cleanup path');
    try {
      if (peer && peer.exitCode === null) await boundedPeer(() => new Promise<void>(resolve => {
        peer.once('exit', () => resolve()); peer.stdin.write('{"type":"shutdown"}\n');
      }));
      expect(peer?.exitCode).toBe(0);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  const transport = (privateException = true, trust = true) => new RemoteTransport({ allowedOrigins: [origin],
    privateOrigins: privateException ? [origin] : [], ...(trust ? { ca } : {}) });
  const options = () => ({ token, maxBytes: 1024, signal: signal() });

  async function rawRequest(send: (socket: TestSocket) => void | Promise<void>, requestOptions = options()) {
    rawHandler = send;
    try {
      return await transport().get(origin, '/feed', requestOptions);
    } finally {
      rawHandler = undefined;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  test('real TLS preserves hostname/certificate verification and sends secrets only to the pinned origin', async () => {
    const result = await transport().get(origin, '/feed', options());
    expect(result).toEqual({ status: 200, etag: '"revision-1"', contentType: 'application/json', bytes: Buffer.from('{"ok":true}') });
    expect(received).toEqual([{ url: '/feed', host: new URL(origin).host, authorization: `Bearer ${token}`, etag: undefined }]);
    expect(dns4).toHaveBeenCalledTimes(1);
    expect(dns6).toHaveBeenCalledTimes(1);
    await expect(transport(true, false).get(origin, '/feed', options())).rejects.toThrow('REMOTE_REQUEST_FAILED');
    expect(received).toHaveLength(1);
  });

  test('a trusted CA does not bypass the original hostname check', async () => {
    const wrong = origin.replace('remote.test', 'wrong.test');
    const client = new RemoteTransport({ allowedOrigins: [wrong], privateOrigins: [wrong], ca });
    await expect(client.get(wrong, '/feed', options())).rejects.toThrow('REMOTE_REQUEST_FAILED');
    expect(received).toHaveLength(0);
  });

  test('DNS is resolved exactly once before connection and is refreshed for every subsequent request', async () => {
    dns4.mockImplementationOnce((async () => ['127.0.0.1']) as unknown as typeof Resolver.prototype.resolve4);
    dns4.mockImplementation((async () => ['169.254.169.254']) as unknown as typeof Resolver.prototype.resolve4);
    await transport().get(origin, '/feed', options());
    expect(dns4).toHaveBeenCalledTimes(1);
    await expect(transport().get(origin, '/feed', options())).rejects.toThrow('REMOTE_ADDRESS_DENIED');
    expect(dns4).toHaveBeenCalledTimes(2);
    expect(received).toHaveLength(1);
  });

  test('default deny and exact origin matching happen before DNS or credentials leave the process', async () => {
    await expect(new RemoteTransport({ allowedOrigins: [] }).get(origin, '/feed', options())).rejects.toThrow('REMOTE_ORIGIN_DENIED');
    await expect(transport().get(origin.replace('remote.test', 'sub.remote.test'), '/feed', options())).rejects.toThrow('REMOTE_ORIGIN_DENIED');
    await expect(transport(false).get(origin, '/feed', options())).rejects.toThrow('REMOTE_ADDRESS_DENIED');
    expect(dns4).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(0);
  });

  test('configuration helpers and the environment factory never perform DNS or HTTP', async () => {
    const allowed = process.env.FEDERATION_ALLOWED_ORIGINS, privateAllowed = process.env.FEDERATION_PRIVATE_ORIGINS;
    try {
      process.env.FEDERATION_ALLOWED_ORIGINS = origin;
      process.env.FEDERATION_PRIVATE_ORIGINS = origin;
      assertRemoteOrigin(origin);
      newRemoteTransport().assertOrigin(origin);
      expect(() => assertRemoteOrigin('https://other.test')).toThrow('REMOTE_ORIGIN_DENIED');
      process.env.FEDERATION_PRIVATE_ORIGINS = 'https://other.test';
      expect(() => newRemoteTransport()).toThrow('REMOTE_POLICY_INVALID');
      delete process.env.FEDERATION_ALLOWED_ORIGINS; delete process.env.FEDERATION_PRIVATE_ORIGINS;
      await expect(newRemoteTransport().get(origin, '/feed', options())).rejects.toThrow('REMOTE_ORIGIN_DENIED');
      expect(dns4).not.toHaveBeenCalled();
      expect(dns6).not.toHaveBeenCalled();
      expect(received).toHaveLength(0);
    } finally {
      if (allowed === undefined) delete process.env.FEDERATION_ALLOWED_ORIGINS;
      else process.env.FEDERATION_ALLOWED_ORIGINS = allowed;
      if (privateAllowed === undefined) delete process.env.FEDERATION_PRIVATE_ORIGINS;
      else process.env.FEDERATION_PRIVATE_ORIGINS = privateAllowed;
    }
  });

  test('IP literal uses the same policy and TLS certificate checks without DNS', async () => {
    const literal = origin.replace('remote.test', '127.0.0.1');
    const client = new RemoteTransport({ allowedOrigins: [literal], privateOrigins: [literal], ca });
    expect((await client.get(literal, '/feed', options())).status).toBe(200);
    expect(dns4).not.toHaveBeenCalled();
    expect(dns6).not.toHaveBeenCalled();
    expect(received[0].host).toBe(new URL(literal).host);
  });

  test('all DNS records are validated, including mixed-family and mixed public/private answers', async () => {
    dns4.mockImplementation((async () => ['93.184.216.34']) as unknown as typeof Resolver.prototype.resolve4);
    dns6.mockImplementation((async () => ['::ffff:127.0.0.1']) as unknown as typeof Resolver.prototype.resolve6);
    await expect(transport(false).get(origin, '/feed', options())).rejects.toThrow('REMOTE_ADDRESS_DENIED');
    dns4.mockImplementation((async () => ['127.0.0.1', '169.254.169.254']) as unknown as typeof Resolver.prototype.resolve4);
    await expect(transport().get(origin, '/feed', options())).rejects.toThrow('REMOTE_ADDRESS_DENIED');
    dns4.mockImplementation((async () => ['127.0.0.1', '127.0.0.1']) as unknown as typeof Resolver.prototype.resolve4);
    dns6.mockImplementation(noData as typeof Resolver.prototype.resolve6);
    await expect(transport().get(origin, '/feed', options())).rejects.toThrow('REMOTE_DNS_FAILED');
    expect(received).toHaveLength(0);
  });

  test.each(['0.0.0.0', '169.254.169.254', '100.100.100.200', '168.63.129.16', '224.0.0.1', '255.255.255.255',
    '192.0.2.1', '198.18.0.1', '203.0.113.1', '::', 'fe80::1', 'ff02::1', 'fd00:ec2::254',
    '::ffff:169.254.169.254', '64:ff9b::a9fe:a9fe', '2001:db8::1', '2002:7f00:1::', '3fff::1'])(
    'private exception never permits special-use or metadata address %s', async address => {
    const literal = `https://${address.includes(':') ? `[${address}]` : address}`;
    await expect(new RemoteTransport({ allowedOrigins: [literal], privateOrigins: [literal], ca })
      .get(literal, '/feed', options())).rejects.toThrow('REMOTE_ADDRESS_DENIED');
    expect(dns4).not.toHaveBeenCalled();
  });

  test.each([301, 302, 303, 307, 308])('rejects redirect %i without following or disclosing the bearer elsewhere', async status => {
    handler = (_request, response) => response.writeHead(status, { Location: 'https://other.test/private' }).end();
    await expect(transport().get(origin, '/redirect', options())).rejects.toThrow('REMOTE_REDIRECT_DENIED');
    expect(received).toHaveLength(1);
    expect(dns4).toHaveBeenCalledTimes(1);
  });

  test('returns bounded HTTP auth failures and allows 304 only for a conditional request', async () => {
    handler = (_request, response) => response.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"denied"}');
    expect((await transport().get(origin, '/feed', options())).status).toBe(401);
    handler = (_request, response) => response.writeHead(304, { ETag: '"revision-1"' }).end();
    await expect(transport().get(origin, '/feed', options())).rejects.toThrow('REMOTE_REDIRECT_DENIED');
    const result = await transport().get(origin, '/feed', { ...options(), etag: '"revision-1"' });
    expect(result.status).toBe(304);
    expect(result.bytes.length).toBe(0);
    expect(received[2].etag).toBe('"revision-1"');
  });

  test('bounds Content-Length and chunked bodies without trusting Content-Encoding', async () => {
    handler = (_request, response) => response.writeHead(200, { 'Content-Length': 1025 }).end();
    await expect(transport().get(origin, '/feed', options())).rejects.toThrow('REMOTE_RESPONSE_TOO_LARGE');
    handler = (_request, response) => {
      response.writeHead(200, { 'Transfer-Encoding': 'chunked' });
      response.write(Buffer.concat([Buffer.from('2bc\r\n'), Buffer.alloc(700), Buffer.from('\r\n2bc\r\n')]));
      response.end(Buffer.concat([Buffer.alloc(700), Buffer.from('\r\n0\r\n\r\n')]));
    };
    await expect(transport().get(origin, '/feed', options())).rejects.toThrow('REMOTE_RESPONSE_TOO_LARGE');
    handler = (_request, response) => response.writeHead(200, { 'Content-Encoding': 'gzip' }).end('compressed');
    await expect(transport().get(origin, '/feed', options())).rejects.toThrow('REMOTE_RESPONSE_INVALID');
    handler = (_request, response) => response.writeHead(200, { 'Content-Length': 1024, 'Content-Encoding': 'identity' }).end(Buffer.alloc(1024));
    expect((await transport().get(origin, '/feed', options())).bytes.length).toBe(1024);
  });

  test('bounds ETag, content type and total response headers', async () => {
    handler = (_request, response) => response.writeHead(200, { ETag: `"${'a'.repeat(200)}"` }).end();
    await expect(transport().get(origin, '/feed', options())).rejects.toThrow('REMOTE_RESPONSE_INVALID');
    handler = (_request, response) => response.writeHead(200, { 'Content-Type': 'a'.repeat(201) }).end();
    await expect(transport().get(origin, '/feed', options())).rejects.toThrow('REMOTE_RESPONSE_INVALID');
    handler = (_request, response) => response.writeHead(200, { 'X-Flood': 'a'.repeat(9000) }).end();
    await expect(transport().get(origin, '/feed', options())).rejects.toThrow('REMOTE_RESPONSE_INVALID');
  });

  test('incomplete oversized header blocks are stopped before waiting for the request deadline', async () => {
    const start = performance.now();
    await expect(rawRequest(socket => { socket.write('HTTP/1.1 200 OK\r\nX-Flood: ' + 'a'.repeat(131_072)); }))
      .rejects.toThrow('REMOTE_RESPONSE_INVALID');
    expect(performance.now() - start).toBeLessThan(2000);
  });

  test('a truncated body fails instead of returning partial artifact bytes', async () => {
    await expect(rawRequest(socket => { socket.end('HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort'); }))
      .rejects.toThrow('REMOTE_REQUEST_FAILED');
  });

  test('fragmented headers, chunk sizes, binary body and empty trailer terminator are parsed exactly', async () => {
    const body = Buffer.from([0, 1, 13, 10, 255, 254, 128]);
    const wire = Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nETag: "binary"\r\n\r\n3\r\n'),
      body.subarray(0, 3), Buffer.from('\r\n4\r\n'), body.subarray(3), Buffer.from('\r\n0\r\n\r\n')]);
    const result = await rawRequest(async socket => {
      for (const byte of wire) { socket.write(Buffer.from([byte])); await new Promise(resolve => setTimeout(resolve, 1)); }
    });
    expect(result.status).toBe(200);
    expect(result.etag).toBe('"binary"');
    expect(result.bytes).toEqual(body);
  });

  test('connection-close bodies are bounded and require a clean end', async () => {
    const result = await rawRequest(socket => { socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nclose-body'); });
    expect(result.bytes.toString()).toBe('close-body');
    await expect(rawRequest(socket => { socket.end('HTTP/1.1 200 OK\r\n\r\n' + 'x'.repeat(1025)); }))
      .rejects.toThrow('REMOTE_RESPONSE_TOO_LARGE');
  });

  test.each([
    'HTTP/1.1 100 Continue\r\n\r\n',
    'HTTP/1.1 200 OK\r\nContent-Length: 1\r\ncontent-length: 1\r\n\r\nx',
    'HTTP/1.1 200 OK\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n0\r\n\r\n',
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\n\r\n',
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n\r\n',
    'HTTP/1.1 200 OK\r\nContent-Length: +1\r\n\r\nx',
    'HTTP/1.1 200 OK\r\nContent-Length: 01\r\n\r\nx',
    'HTTP/1.1 200 OK\r\nContent-Length : 1\r\n\r\nx',
    'HTTP/1.1 200 OK\r\nX-Fold: value\r\n more\r\n\r\n',
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1;extension=x\r\nx\r\n0\r\n\r\n',
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n-1\r\n',
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx!\n0\r\n\r\n',
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nETag: "trailer"\r\n\r\n',
    'HTTP/1.1 204 No Content\r\nContent-Length: 1\r\n\r\nx',
  ])('rejects ambiguous or unsupported raw response %#', async wire => {
    await expect(rawRequest(socket => { socket.end(wire); })).rejects.toThrow('REMOTE_RESPONSE_INVALID');
  });

  test('chunk lengths are bounded before data arrives and incomplete chunks fail closed', async () => {
    await expect(rawRequest(socket => { socket.write('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n401\r\n'); }))
      .rejects.toThrow('REMOTE_RESPONSE_TOO_LARGE');
    await expect(rawRequest(socket => { socket.end('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nshort'); }))
      .rejects.toThrow('REMOTE_REQUEST_FAILED');
    await expect(rawRequest(socket => { socket.write('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n' + 'a'.repeat(128)); }))
      .rejects.toThrow('REMOTE_RESPONSE_INVALID');
  });

  test('non-ASCII chunk digits cannot be normalized into valid framing', async () => {
    const wire = Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n'),
      Buffer.from([0xb1]), Buffer.from('\r\nx\r\n0\r\n\r\n')]);
    await expect(rawRequest(socket => { socket.end(wire); })).rejects.toThrow('REMOTE_RESPONSE_INVALID');
  });

  test('header and artifact byte limits accept the exact boundary and reject one byte more', async () => {
    const prefix = 'HTTP/1.1 200 OK\r\nContent-Length: 0\r\nX-Pad: ', suffix = '\r\n\r\n';
    const header = prefix + 'a'.repeat(8192 - prefix.length - suffix.length) + suffix;
    expect((await rawRequest(socket => { socket.end(header); })).bytes.length).toBe(0);
    await expect(rawRequest(socket => { socket.end(header.replace('X-Pad: ', 'X-Pad: a')); }))
      .rejects.toThrow('REMOTE_RESPONSE_INVALID');
    const maxBytes = 2_097_152, bytes = Buffer.alloc(maxBytes, 0xaa);
    const result = await rawRequest(socket => {
      socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${maxBytes}\r\n\r\n`); socket.end(bytes);
    }, { ...options(), maxBytes });
    expect(result.bytes.equals(bytes)).toBe(true);
    await expect(rawRequest(socket => { socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${maxBytes + 1}\r\n\r\n`); },
      { ...options(), maxBytes })).rejects.toThrow('REMOTE_RESPONSE_TOO_LARGE');
  });

  test('validated request options remain fixed while DNS is pending', async () => {
    let finish: ((addresses: string[]) => void) | undefined;
    dns4.mockImplementation((() => new Promise<string[]>(resolve => { finish = resolve; })) as unknown as typeof Resolver.prototype.resolve4);
    const input = options();
    const result = transport().get(origin, '/feed', input);
    input.token = 'changed-invalid-token'; input.maxBytes = 2_097_153;
    finish?.(['127.0.0.1']);
    expect((await result).status).toBe(200);
    expect(received[0].authorization).toBe(`Bearer ${token}`);
  });

  test.each(['//other.test/feed', '/../secret', '/a/../secret', '/feed?token=x', '/feed#x', '/%2fsecret', '/a\\b', '/feed\r\nX: y'])(
    'rejects unsafe request path %s before DNS', async path => {
    await expect(transport().get(origin, path, options())).rejects.toThrow('REMOTE_REQUEST_INVALID');
    expect(dns4).not.toHaveBeenCalled();
  });

  test('rejects invalid bounds, bearer and conditional header before DNS', async () => {
    for (const patch of [{ maxBytes: 0 }, { maxBytes: 2_097_153 }, { maxBytes: 1.5 },
      { token: 'not-a-share' }, { token: token + '\r\nX: y' }, { etag: '"x"\r\nX: y' }, { etag: '"' + 'a'.repeat(201) + '"' }]) {
      await expect(transport().get(origin, '/feed', { ...options(), ...patch })).rejects.toThrow('REMOTE_REQUEST_INVALID');
    }
    expect(dns4).not.toHaveBeenCalled();
  });

  test('parent abort cancels pending DNS and ignores late resolver answers', async () => {
    let finish: ((addresses: string[]) => void) | undefined;
    dns4.mockImplementation((() => new Promise<string[]>(resolve => { finish = resolve; })) as unknown as typeof Resolver.prototype.resolve4);
    const cancel = spyOn(Resolver.prototype, 'cancel');
    try {
      const controller = new AbortController();
      const pending = transport().get(origin, '/feed', { ...options(), signal: controller.signal });
      controller.abort();
      await expect(pending).rejects.toThrow('REMOTE_ABORTED');
      expect(cancel).toHaveBeenCalled();
      finish?.(['127.0.0.1']);
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(received).toHaveLength(0);
    } finally { cancel.mockRestore(); }
  });

  test('pre-abort does not start DNS and resolver errors expose no raw hostname or secret', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(transport().get(origin, '/feed', { ...options(), signal: controller.signal })).rejects.toThrow('REMOTE_ABORTED');
    expect(dns4).not.toHaveBeenCalled();
    dns4.mockImplementation((() => Promise.reject(Object.assign(new Error(token + origin), { code: 'SERVFAIL' }))) as typeof Resolver.prototype.resolve4);
    try { await transport().get(origin, '/feed', options()); throw new Error('Expected failure'); }
    catch (error) { expect((error as Error).message).toBe('REMOTE_DNS_FAILED'); }
  });

  test('the total deadline also cancels DNS that never completes', async () => {
    dns4.mockImplementation((() => new Promise<string[]>(() => undefined)) as unknown as typeof Resolver.prototype.resolve4);
    const cancel = spyOn(Resolver.prototype, 'cancel');
    try {
      const start = performance.now();
      await expect(transport().get(origin, '/feed', options())).rejects.toThrow('REMOTE_TIMEOUT');
      expect(performance.now() - start).toBeLessThan(6000);
      expect(cancel).toHaveBeenCalled();
      expect(received).toHaveLength(0);
    } finally { cancel.mockRestore(); }
  }, 7000);

  test('parent abort destroys an active response and does not wait for the request deadline', async () => {
    const controller = new AbortController();
    handler = (_request, response) => { response.writeHead(200); response.write('partial'); controller.abort(); };
    await expect(transport().get(origin, '/feed', { ...options(), signal: controller.signal })).rejects.toThrow('REMOTE_ABORTED');
  });

  test('total deadline bounds a stalled response even after receiving headers', async () => {
    handler = (_request, response) => { response.writeHead(200); response.write('partial'); };
    const start = performance.now();
    await expect(transport().get(origin, '/feed', options())).rejects.toThrow('REMOTE_TIMEOUT');
    expect(performance.now() - start).toBeLessThan(6000);
  }, 7000);
});
