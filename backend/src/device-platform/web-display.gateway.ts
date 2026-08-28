import { HttpAdapterHost } from '@nestjs/core';
import { BeforeApplicationShutdown, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown, UnauthorizedException } from '@nestjs/common';
import { IncomingMessage, Server as HttpServer } from 'http';
import { Socket } from 'net';
import { randomBytes } from 'node:crypto';
import { RawData, WebSocket, WebSocketServer } from 'ws';
import { DEVICE_WEBSOCKET_LIMITS as LIMITS, comparePresentationRevisions, parseDeviceClientMessage, parseDeviceServerMessage, type DeviceClientMessage, type DeviceServerMessage, type WebDisplayManifest } from '@inker/contracts';
import { PresentationService } from './presentation.service';
import { WebDisplayAuthService, type DeviceConnectionSession } from './web-display-auth.service';
import { WebSocketTelemetryService } from './websocket-telemetry.service';
import { isDeviceOriginAllowed } from './websocket-origin';
import type { DeliveryContext } from '../events/outbox.types';

interface Connection {
  client: WebSocket;
  session?: DeviceConnectionSession;
  authDeadline: number;
  nextPing: number;
  nextCheck: number;
  pong?: { nonce: string; deadline: number };
  checking?: Promise<boolean>;
  queue: DeviceClientMessage[];
  draining: boolean;
  closed: boolean;
  lastRevision?: Pick<WebDisplayManifest, 'revision' | 'renderRevision'>;
  tokens: number;
  tokenTime: number;
  onMessage: (raw: RawData, binary: boolean) => void;
  onClose: () => void;
  onError: () => void;
  operations: Map<ReturnType<typeof setTimeout>, () => void>;
}

@Injectable()
export class WebDisplayGateway implements OnApplicationBootstrap, OnApplicationShutdown, BeforeApplicationShutdown {
  private readonly logger = new Logger(WebDisplayGateway.name);
  private server?: WebSocketServer;
  private httpServer?: HttpServer;
  private heartbeat?: ReturnType<typeof setInterval>;
  private closing = false;
  private readonly clients = new Map<WebSocket, Connection>();
  private readonly connections = new Map<number, Set<Connection>>();
  private readonly transitionTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly pushes = new Map<number, Promise<void>>();
  private readonly requestedPushes = new Set<number>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly terminating = new Map<WebSocket, ReturnType<typeof setTimeout>>();
  private readonly counters = { accepted: 0, authenticated: 0, authRejected: 0, protocolRejected: 0, rateLimited: 0, livenessTimeouts: 0, operationErrors: 0, closed: 0, pongs: 0, telemetryMessages: 0 };

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly auth: WebDisplayAuthService,
    private readonly presentations: PresentationService,
    private readonly telemetry: WebSocketTelemetryService,
  ) {}

  onApplicationBootstrap() {
    this.closing = false;
    this.httpServer = this.adapterHost.httpAdapter.getHttpServer() as HttpServer;
    this.server = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxMessageBytes, perMessageDeflate: false });
    this.server.on('error', () => this.logger.warn('Device WebSocket server error'));
    this.httpServer.on('upgrade', this.handleUpgrade);
    this.heartbeat = setInterval(() => this.tick(), 1000);
    this.heartbeat.unref?.();
    this.logger.log('Web display transport listening on /api/device-connect');
  }

  onApplicationShutdown() {
    this.closing = true;
    this.httpServer?.off('upgrade', this.handleUpgrade);
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const state of this.clients.values()) this.disconnect(state, 1001, 'Server restarting');
    for (const [client, timer] of this.terminating) { clearTimeout(timer); client.terminate(); }
    this.terminating.clear();
    for (const timer of this.transitionTimers.values()) clearTimeout(timer);
    this.transitionTimers.clear();
    this.server?.close();
  }

  // Nest disposes the HTTP listener before onApplicationShutdown. Close upgraded
  // sockets first so a graceful application shutdown cannot wait on live displays.
  beforeApplicationShutdown() { this.onApplicationShutdown(); }

  metrics() { return { ...this.counters, connections: this.clients.size, authenticatedConnections: [...this.connections.values()].reduce((sum, set) => sum + set.size, 0), devices: this.connections.size }; }
  isConnected(deviceId: number): boolean { return (this.connections.get(deviceId)?.size ?? 0) > 0; }

  expireDeliveryConnections() {
    for (const state of this.clients.values()) this.disconnect(state, 1011, 'Delivery lease expired');
  }

  async pushPresentation(deviceId: number, context?: DeliveryContext): Promise<void> {
    if (!this.isConnected(deviceId) || this.closing) return;
    if (context) {
      context.signal.throwIfAborted();
      return this.deliver(deviceId, context);
    }
    this.requestedPushes.add(deviceId);
    const existing = this.pushes.get(deviceId);
    if (existing) return existing;
    const run = (async () => {
      do {
        this.requestedPushes.delete(deviceId);
        await this.deliver(deviceId);
      } while (this.requestedPushes.has(deviceId) && this.isConnected(deviceId) && !this.closing);
    })().finally(() => { this.pushes.delete(deviceId); this.requestedPushes.delete(deviceId); });
    this.pushes.set(deviceId, run);
    return run;
  }

  /** A tiny invalidation only: the authenticated feed owns timer visibility/data. */
  async pushTimersChanged(deviceId: number, context?: DeliveryContext): Promise<void> {
    context?.signal.throwIfAborted();
    if (this.closing || !this.isConnected(deviceId)) return;
    const states = [...(this.connections.get(deviceId) ?? [])];
    const deliver = async () => {
      for (const state of states) {
        context?.signal.throwIfAborted();
        if (!await this.check(state)) continue;
        context?.signal.throwIfAborted();
        await this.operation(state, () => this.sendConfirmed(state, { protocolVersion: '1.0', type: 'timers.changed' }));
        context?.signal.throwIfAborted();
      }
    };
    try {
      if (!context) { await deliver(); return; }
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new Error('OUTBOX_ADAPTER_ABORTED'));
        context.signal.addEventListener('abort', abort, { once: true });
        if (context.signal.aborted) abort();
        void deliver().then(resolve, reject).finally(() => context.signal.removeEventListener('abort', abort));
      });
    } catch {
      // Abort closes pending sends and releases bounded per-connection operations.
      for (const state of states) this.fail(state);
      if (context) throw new Error('OUTBOX_ADAPTER_FAILED');
    }
  }

  private async deliver(deviceId: number, context?: DeliveryContext): Promise<void> {
    const states = [...(this.connections.get(deviceId) ?? [])];
    try {
      const authorized = (await Promise.all(states.map(async state => await this.check(state) ? state : undefined)))
        .filter((state): state is Connection => !!state && !state.closed);
      if (!authorized.length) return;
      const presentation = await this.operation(authorized[0], () => this.presentations.getForDevice(deviceId, context));
      // Recheck after asynchronous work, including rotation during rendering.
      for (const state of authorized) if (await this.check(state)) {
        context?.signal.throwIfAborted();
        if (state.lastRevision && comparePresentationRevisions(presentation, state.lastRevision) <= 0) continue;
        if (context) await this.operation(state, () => this.sendConfirmed(state, { protocolVersion: '1.0', type: 'presentation.changed', presentation }));
        else this.send(state, { protocolVersion: '1.0', type: 'presentation.changed', presentation });
        // A slower send callback must not roll back a newer concurrent delivery.
        if (!state.lastRevision || comparePresentationRevisions(presentation, state.lastRevision) > 0) {
          state.lastRevision = { revision: presentation.revision, renderRevision: presentation.renderRevision };
        }
      }
      this.scheduleTransition(deviceId, presentation.nextTransitionAt);
    } catch {
      this.logger.warn('Device presentation delivery failed');
      for (const state of states) this.fail(state);
      if (context) throw new Error('OUTBOX_ADAPTER_FAILED');
    }
  }

  private readonly handleUpgrade = (request: IncomingMessage, socket: Socket, head: Buffer) => {
    // No credentials (or any query parameters) are accepted in the upgrade URL.
    if (request.url?.split('?')[0] !== '/api/device-connect') return;
    if (this.closing || this.clients.size + this.terminating.size >= LIMITS.maxConnections || request.url !== '/api/device-connect' || !isDeviceOriginAllowed(request)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroySoon();
      return;
    }
    try { this.server?.handleUpgrade(request, socket, head, client => this.accept(client)); }
    catch { socket.destroy(); }
  };

  private accept(client: WebSocket) {
    if (this.closing || this.clients.size + this.terminating.size >= LIMITS.maxConnections) { client.close(4429, 'Connection limit'); return; }
    const now = Date.now();
    const state: Connection = {
      client, authDeadline: now + LIMITS.authTimeoutMs, nextPing: now + LIMITS.heartbeatIntervalMs,
      nextCheck: now + LIMITS.credentialCheckIntervalMs, queue: [], draining: false, closed: false,
      tokens: LIMITS.burstMessages, tokenTime: now, operations: new Map(),
      onMessage: (raw, binary) => this.receive(state, raw, binary),
      onClose: () => this.cleanup(state), onError: () => this.disconnect(state, 1011, 'Transport failed'),
    };
    this.clients.set(client, state);
    this.counters.accepted++;
    client.on('message', state.onMessage);
    client.on('close', state.onClose);
    client.on('error', state.onError);
  }

  private receive(state: Connection, raw: RawData, binary: boolean) {
    if (state.closed) return;
    const now = Date.now();
    state.tokens = Math.min(LIMITS.burstMessages, state.tokens + Math.max(0, now - state.tokenTime) * LIMITS.messagesPerSecond / 1000);
    state.tokenTime = now;
    if (state.tokens < 1 || state.queue.length >= LIMITS.maxPendingMessages) {
      this.counters.rateLimited++; this.disconnect(state, 4429, 'Message rate exceeded'); return;
    }
    state.tokens--;
    const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
    if (binary || bytes.length > LIMITS.maxMessageBytes) { this.disconnect(state, binary ? 4400 : 1009, 'Invalid message'); return; }
    let value: unknown;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { this.disconnect(state, 4400, 'Invalid message'); return; }
    const parsed = parseDeviceClientMessage(value);
    if (!parsed.success) { this.counters.protocolRejected++; this.disconnect(state, 4400, 'Invalid device protocol'); return; }
    if (!state.session && (state.draining || parsed.data.type !== 'authenticate')) {
      this.disconnect(state, 4401, 'Authenticate first'); return;
    }
    state.queue.push(parsed.data);
    if (!state.draining) void this.drain(state);
  }

  private async drain(state: Connection) {
    state.draining = true;
    try {
      while (!state.closed && state.queue.length) await this.handle(state, state.queue.shift()!);
    } catch (error) {
      if (error instanceof UnauthorizedException) { this.counters.authRejected++; this.disconnect(state, 4401, 'Invalid device credentials'); }
      else this.fail(state);
    } finally { state.draining = false; }
  }

  private async handle(state: Connection, message: DeviceClientMessage) {
    if (!state.session) {
      if (message.type !== 'authenticate') return;
      const session = await this.operation(state, () => this.auth.authenticateConnection(message.externalId, message.token));
      if (state.closed) return;
      const clients = this.connections.get(session.device.id) ?? new Set<Connection>();
      if (clients.size >= LIMITS.maxConnectionsPerDevice) { this.disconnect(state, 4429, 'Device connection limit'); return; }
      state.session = session;
      clients.add(state); this.connections.set(session.device.id, clients);
      this.counters.authenticated++;
      state.nextPing = Date.now() + LIMITS.heartbeatIntervalMs;
      state.nextCheck = Date.now() + LIMITS.credentialCheckIntervalMs;
      this.telemetry.observe(session.device, session.telemetryIntervalSeconds, message.viewport);
      this.send(state, { protocolVersion: '1.0', type: 'connected', deviceId: session.device.id,
        heartbeatInterval: LIMITS.heartbeatIntervalMs, pongTimeout: LIMITS.pongTimeoutMs, telemetryInterval: session.telemetryIntervalSeconds * 1000 });
      await this.pushPresentation(session.device.id);
    } else if (message.type === 'pong') {
      if (!state.pong || state.pong.nonce !== message.nonce || Date.now() >= state.pong.deadline) {
        this.disconnect(state, 4400, 'Unexpected pong'); return;
      }
      state.pong = undefined;
      this.counters.pongs++;
      this.telemetry.observe(state.session.device, state.session.telemetryIntervalSeconds);
    } else if (message.type === 'telemetry') {
      this.counters.telemetryMessages++;
      if (await this.check(state)) this.telemetry.observe(state.session.device, state.session.telemetryIntervalSeconds, message.payload);
    } else this.disconnect(state, 4400, 'Already authenticated');
  }

  private tick() {
    const now = Date.now();
    for (const state of this.clients.values()) {
      if (!state.session) {
        if (now >= state.authDeadline) this.disconnect(state, 4408, 'Authentication timeout');
        continue;
      }
      if (state.pong && now >= state.pong.deadline) {
        this.counters.livenessTimeouts++; this.disconnect(state, 4408, 'Heartbeat timeout'); continue;
      }
      if (now >= state.nextCheck) { state.nextCheck = now + LIMITS.credentialCheckIntervalMs; void this.check(state); }
      if (!state.pong && now >= state.nextPing) {
        const nonce = randomBytes(12).toString('base64url');
        state.pong = { nonce, deadline: now + LIMITS.pongTimeoutMs };
        state.nextPing = now + LIMITS.heartbeatIntervalMs;
        this.send(state, { protocolVersion: '1.0', type: 'ping', nonce, timestamp: now });
      }
    }
  }

  private check(state: Connection): Promise<boolean> {
    if (state.closed || !state.session) return Promise.resolve(false);
    if (state.checking) return state.checking;
    state.checking = this.operation(state, () => this.auth.revalidateConnection(state.session!)).then(session => {
      if (state.closed) return false;
      state.session = session; return true;
    }).catch(error => {
      if (error instanceof UnauthorizedException) { this.counters.authRejected++; this.disconnect(state, 4401, 'Invalid device credentials'); }
      else this.fail(state);
      return false;
    }).finally(() => { state.checking = undefined; });
    return state.checking;
  }

  private async operation<T>(state: Connection, work: () => Promise<T>): Promise<T> {
    if (state.closed || this.inFlight.size >= LIMITS.maxConnections) throw new Error('Device operation unavailable');
    // A timed-out DB call is not cancellable. It keeps its slot until it settles.
    const pending = Promise.resolve().then(work);
    this.inFlight.add(pending);
    void pending.then(() => this.inFlight.delete(pending), () => this.inFlight.delete(pending));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([pending, new Promise<never>((_, reject) => {
        const cancel = () => reject(new Error('Device operation cancelled'));
        timer = setTimeout(cancel, LIMITS.operationTimeoutMs);
        state.operations.set(timer, cancel);
      })]);
    } finally { if (timer) { clearTimeout(timer); state.operations.delete(timer); } }
  }

  private scheduleTransition(deviceId: number, value: string | null) {
    const previous = this.transitionTimers.get(deviceId);
    if (previous) clearTimeout(previous);
    this.transitionTimers.delete(deviceId);
    if (!value || !this.isConnected(deviceId) || !Number.isFinite(Date.parse(value))) return;
    const delay = Math.max(250, Math.min(Date.parse(value) - Date.now() + 25, 2_147_000_000));
    this.transitionTimers.set(deviceId, setTimeout(() => { void this.pushPresentation(deviceId); }, delay));
  }

  private send(state: Connection, message: DeviceServerMessage) {
    if (state.closed || state.client.readyState !== WebSocket.OPEN) return;
    try {
      const parsed = parseDeviceServerMessage(message);
      if (!parsed.success) throw new Error();
      const payload = JSON.stringify(parsed.data);
      if (Buffer.byteLength(payload) > LIMITS.maxMessageBytes || state.client.bufferedAmount > LIMITS.maxBufferedBytes) throw new Error();
      state.client.send(payload, error => { if (error) this.fail(state); });
    } catch { this.fail(state); }
  }

  private sendConfirmed(state: Connection, message: DeviceServerMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const fail = () => reject(new Error('OUTBOX_SEND_FAILED'));
      if (state.closed || state.client.readyState !== WebSocket.OPEN) { fail(); return; }
      try {
        const parsed = parseDeviceServerMessage(message);
        if (!parsed.success) throw new Error();
        const payload = JSON.stringify(parsed.data);
        if (Buffer.byteLength(payload) > LIMITS.maxMessageBytes || state.client.bufferedAmount > LIMITS.maxBufferedBytes) throw new Error();
        state.client.send(payload, error => error ? fail() : resolve());
      } catch { fail(); }
    });
  }

  private fail(state: Connection) {
    if (state.closed) return;
    this.counters.operationErrors++;
    this.logger.warn('Device connection operation failed');
    this.disconnect(state, 1011, 'Device operation failed');
  }

  private cleanup(state: Connection) {
    if (state.closed) return;
    state.closed = true; state.queue.length = 0;
    this.clients.delete(state.client); this.counters.closed++;
    state.client.off('message', state.onMessage);
    state.client.off('close', state.onClose);
    // Keep the error sink until the transport is fully closed; ws may still emit errors.
    if (state.client.readyState === WebSocket.CLOSED) state.client.off('error', state.onError);
    for (const [timer, cancel] of state.operations) { clearTimeout(timer); cancel(); }
    state.operations.clear();
    const deviceId = state.session?.device.id;
    if (deviceId !== undefined) {
      const clients = this.connections.get(deviceId); clients?.delete(state);
      if (!clients?.size) {
        this.connections.delete(deviceId);
        const timer = this.transitionTimers.get(deviceId); if (timer) clearTimeout(timer);
        this.transitionTimers.delete(deviceId); this.telemetry.release(deviceId);
      }
    }
  }

  private disconnect(state: Connection, code: number, reason: string) {
    if (state.closed) return;
    this.cleanup(state);
    const client = state.client;
    const finish = () => {
      const timer = this.terminating.get(client); if (timer) clearTimeout(timer);
      this.terminating.delete(client); client.off('error', state.onError);
    };
    client.once('close', finish);
    const timer = setTimeout(() => { client.terminate(); finish(); }, 1000);
    timer.unref?.(); this.terminating.set(client, timer);
    try { client.close(code, reason); } catch { client.terminate(); finish(); }
  }
}
