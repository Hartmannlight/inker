import {
  HttpAdapterHost,
} from '@nestjs/core';
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { IncomingMessage, Server as HttpServer } from 'http';
import { Socket } from 'net';
import { RawData, WebSocket, WebSocketServer } from 'ws';
import { PrismaService } from '../prisma/prisma.service';
import { PresentationService } from './presentation.service';
import { WebDisplayAuthService } from './web-display-auth.service';

interface AuthenticateMessage {
  type: 'authenticate';
  externalId: string;
  token: string;
  viewport?: { width?: number; height?: number; userAgent?: string };
}

@Injectable()
export class WebDisplayGateway implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WebDisplayGateway.name);
  private server?: WebSocketServer;
  private httpServer?: HttpServer;
  private readonly connections = new Map<number, Set<WebSocket>>();
  private readonly transitionTimers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly auth: WebDisplayAuthService,
    private readonly presentations: PresentationService,
    private readonly prisma: PrismaService,
  ) {}

  onApplicationBootstrap() {
    this.httpServer = this.adapterHost.httpAdapter.getHttpServer() as HttpServer;
    this.server = new WebSocketServer({ noServer: true, maxPayload: 8192 });
    this.httpServer.on('upgrade', this.handleUpgrade);
    this.logger.log('Web display transport listening on /api/device-connect');
  }

  async onApplicationShutdown() {
    this.httpServer?.off('upgrade', this.handleUpgrade);
    for (const timer of this.transitionTimers.values()) clearTimeout(timer);
    for (const clients of this.connections.values()) {
      for (const client of clients) client.close(1001, 'Server shutting down');
    }
    this.server?.close();
  }

  async pushPresentation(deviceId: number): Promise<void> {
    const clients = this.connections.get(deviceId);
    if (!clients?.size) return;
    try {
      const presentation = await this.presentations.getForDevice(deviceId);
      this.broadcast(deviceId, { type: 'presentation.changed', presentation });
      this.scheduleTransition(deviceId, presentation.nextTransitionAt);
    } catch (error) {
      this.logger.warn(`Unable to create presentation for device ${deviceId}: ${error.message}`);
    }
  }

  isConnected(deviceId: number): boolean {
    return (this.connections.get(deviceId)?.size ?? 0) > 0;
  }

  private readonly handleUpgrade = (request: IncomingMessage, socket: Socket, head: Buffer) => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== '/api/device-connect') return;
    if (!this.isOriginAllowed(request)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.server?.handleUpgrade(request, socket, head, (client) => this.accept(client));
  };

  private accept(client: WebSocket) {
    let deviceId: number | null = null;
    const authTimeout = setTimeout(() => client.close(4401, 'Authentication timeout'), 10_000);

    client.on('message', async (raw: RawData) => {
      try {
        const message = JSON.parse(raw.toString());
        if (deviceId === null) {
          const authMessage = message as AuthenticateMessage;
          if (authMessage.type !== 'authenticate') throw new Error('Authenticate first');
          const device = await this.auth.authenticate(authMessage.externalId, authMessage.token);
          deviceId = device.id;
          clearTimeout(authTimeout);
          this.addConnection(deviceId, client);
          await this.updateTelemetry(deviceId, authMessage.viewport);
          this.send(client, { type: 'connected', deviceId, heartbeatInterval: 30_000 });
          await this.pushPresentation(deviceId);
          return;
        }
        if (message.type === 'pong') {
          await this.prisma.device.update({ where: { id: deviceId }, data: { lastSeenAt: new Date() } });
        } else if (message.type === 'telemetry') {
          await this.updateTelemetry(deviceId, message.payload);
        }
      } catch (error) {
        this.send(client, { type: 'error', message: error.message || 'Invalid message' });
        if (deviceId === null) client.close(4401, 'Authentication failed');
      }
    });

    const heartbeat = setInterval(() => {
      if (client.readyState === WebSocket.OPEN) this.send(client, { type: 'ping', timestamp: Date.now() });
    }, 30_000);

    client.on('close', () => {
      clearTimeout(authTimeout);
      clearInterval(heartbeat);
      if (deviceId !== null) this.removeConnection(deviceId, client);
    });
    client.on('error', () => client.close());
  }

  private addConnection(deviceId: number, client: WebSocket) {
    const clients = this.connections.get(deviceId) ?? new Set<WebSocket>();
    clients.add(client);
    this.connections.set(deviceId, clients);
  }

  private removeConnection(deviceId: number, client: WebSocket) {
    const clients = this.connections.get(deviceId);
    clients?.delete(client);
    if (!clients?.size) {
      this.connections.delete(deviceId);
      const timer = this.transitionTimers.get(deviceId);
      if (timer) clearTimeout(timer);
      this.transitionTimers.delete(deviceId);
    }
  }

  private scheduleTransition(deviceId: number, value: string | null) {
    const previous = this.transitionTimers.get(deviceId);
    if (previous) clearTimeout(previous);
    if (!value || !this.isConnected(deviceId)) return;
    const delay = Math.max(250, Math.min(new Date(value).getTime() - Date.now() + 25, 2_147_000_000));
    this.transitionTimers.set(deviceId, setTimeout(() => void this.pushPresentation(deviceId), delay));
  }

  private async updateTelemetry(deviceId: number, value?: Record<string, unknown>) {
    if (!value) return;
    const width = typeof value.width === 'number' ? Math.round(value.width) : undefined;
    const height = typeof value.height === 'number' ? Math.round(value.height) : undefined;
    const userAgent = typeof value.userAgent === 'string' ? value.userAgent.slice(0, 512) : undefined;
    const telemetry = { browser: { width, height, userAgent }, updatedAt: new Date().toISOString() };
    await this.prisma.device.update({
      where: { id: deviceId },
      data: { telemetry, lastSeenAt: new Date(), ...(width && height ? { width, height } : {}) },
    });
  }

  private broadcast(deviceId: number, payload: unknown) {
    for (const client of this.connections.get(deviceId) ?? []) this.send(client, payload);
  }

  private send(client: WebSocket, payload: unknown) {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(payload));
  }

  private isOriginAllowed(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (!origin) return true;
    if (process.env.CORS_ORIGINS === '*') return true;
    try {
      if (new URL(origin).host === request.headers.host) return true;
    } catch {
      return false;
    }
    const allowed = (process.env.CORS_ORIGINS ?? '').split(',').map((value) => value.trim());
    return allowed.includes(origin);
  }
}
