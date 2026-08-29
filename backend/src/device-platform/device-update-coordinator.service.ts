import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EventsService } from '../events/events.service';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxStore } from '../events/outbox.store';
import {
  OUTBOX_POLICY as POLICY,
  parseOutboxEvent,
  type DeliveryContext,
} from '../events/outbox.types';
import { DeliveryPolicyRegistry } from './delivery-policy.registry';
import { ProfileResolverService } from './profile-resolver.service';
import { TransportAdapterRegistry } from './transport-adapter.registry';
import { outboxCorrelation } from '../events/outbox-correlation';
import { createCorrelationContext, currentCorrelation, runWithCorrelation } from '../observability/correlation-context';
import { emitStructuredEvent } from '../observability/runtime-observability';
import { sqliteWrite } from '../sources/source-writes';

class ConsumerLeaseRenewalError extends Error {
  constructor(readonly failure: unknown) { super('OUTBOX_CONSUMER_LEASE_RENEWAL_FAILED'); }
}

@Injectable()
export class DeviceUpdateCoordinator {
  private readonly logger = new Logger(DeviceUpdateCoordinator.name);
  readonly consumerId = randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  private active = false;
  private running?: Promise<void>;
  private leaseUntil = 0;
  private renewAt = 0;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly aborts = new Set<AbortController>();

  constructor(
    private readonly events: EventsService,
    private readonly prisma: PrismaService,
    private readonly profiles: ProfileResolverService,
    private readonly deliveryPolicies: DeliveryPolicyRegistry,
    private readonly transports: TransportAdapterRegistry,
    private readonly store: OutboxStore,
  ) {}

  async start() {
    await this.registerLease();
    this.active = true;
    this.timer = setInterval(() => this.wake(), POLICY.pollMs);
    this.timer.unref?.();
  }

  async stop() {
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    // Close sockets before relinquishing durable ownership of delivery targets.
    this.expireConnections();
    for (const abort of this.aborts) abort.abort();
    await this.running;
    await sqliteWrite(this.prisma, () => this.store.unregister(this.consumerId));
  }

  wake() {
    if (this.active && Date.now() >= this.leaseUntil) this.expireConnections();
    if (!this.active || this.running) return;
    this.running = this.poll()
      .catch(() => {
        this.logger.warn({
          code: 'OUTBOX_CONSUMER_FAILED',
          correlationId: this.consumerId,
        });
        this.expireConnections();
      })
      .finally(() => {
        this.running = undefined;
      });
  }

  private expireConnections() {
    for (const adapter of this.transports.list())
      adapter.deliveryLeaseExpired?.();
  }

  private async renewLeaseIfDue() {
    if (Date.now() < this.renewAt) return;
    await this.registerLease();
  }

  private async registerLease() {
    let registeredAt = new Date(Date.now());
    await sqliteWrite(this.prisma, () => {
      registeredAt = new Date(Date.now());
      return this.store.register(this.consumerId, registeredAt);
    });
    const persistedUntil = registeredAt.getTime() + POLICY.consumerLeaseMs;
    if (Date.now() >= persistedUntil) throw new Error('OUTBOX_CONSUMER_LEASE_EXPIRED');
    this.leaseUntil = persistedUntil;
    this.renewAt = registeredAt.getTime() + 5000;
  }

  async poll() {
    if (Date.now() >= this.leaseUntil) this.expireConnections();
    await this.renewLeaseIfDue();
    for (const target of await this.store.pendingTargets(this.consumerId)) {
      if (!this.active) break;
      await this.renewLeaseIfDue();
      const event = await this.prisma.outboxEvent.findUnique({
        where: { eventId: target.effect.eventId },
      });
      if (!event) continue;
      await runWithCorrelation(outboxCorrelation(event), async () => {
        if (!(await sqliteWrite(this.prisma, () => this.store.beginTarget(
            target.effectKey,
            this.consumerId,
            event,
          )))) return;
        const abort = new AbortController();
        this.aborts.add(abort);
        const timer = setTimeout(
          () => abort.abort(),
          POLICY.dispatchTimeoutMs - 1000,
        );
        try {
          const parsed = parseOutboxEvent(event);
          for (const delivery of target.effect.deliveries) {
            abort.signal.throwIfAborted();
            try { await this.renewLeaseIfDue(); }
            catch (error) { throw new ConsumerLeaseRenewalError(error); }
            await this.refreshDevices([delivery.deviceId], {
              ...outboxCorrelation(event),
              deliveryId: delivery.deliveryId,
              signal: abort.signal,
              ...(parsed.stateChange ? { stateTopic: parsed.stateChange.topic } : {}),
            });
          }
          abort.signal.throwIfAborted();
          try { await this.renewLeaseIfDue(); }
          catch (error) { throw new ConsumerLeaseRenewalError(error); }
          if (
            await sqliteWrite(this.prisma, () => this.store.finishTarget(
              target.effectKey,
              this.consumerId,
              event,
              true,
            ))
          ) {
            if (parsed.notification) this.events.emit(parsed.notification);
          }
        } catch (error) {
          if (error instanceof ConsumerLeaseRenewalError) throw error.failure;
          await sqliteWrite(this.prisma, () => this.store.finishTarget(
            target.effectKey,
            this.consumerId,
            event,
            false,
          ));
          emitStructuredEvent('DEVICE_DELIVERY_FAILED', { role: 'api', outcome: abort.signal.aborted ? 'aborted' : 'failure' });
        } finally {
          clearTimeout(timer);
          this.aborts.delete(abort);
        }
      });
    }
  }

  async refreshDevices(deviceIds: number[], context?: DeliveryContext) {
    const devices = await this.prisma.device.findMany({
      where: { id: { in: deviceIds }, isActive: true },
      include: { profile: true, deliveryPolicy: true },
    });
    for (const device of devices) {
      const configuration = this.profiles.resolvePersisted(device);
      const policy = this.deliveryPolicies.get(
        configuration.deliveryPolicy.mode,
      );
      if (!policy.dispatchOnRefresh) continue;
      const adapter = this.transports.get(
        policy.selectTransport(configuration.capabilities),
      );
      const correlation = createCorrelationContext({ ...currentCorrelation(),
        ...(context?.correlationId ? { correlationId: context.correlationId } : {}),
        ...(context?.eventId ? { eventId: context.eventId } : {}),
        ...(context ? { deliveryId: context.deliveryId } : {}), deviceId: device.id });
      await runWithCorrelation(correlation, async () => {
        const started = performance.now();
        try {
        if (context) {
          context.signal.throwIfAborted();
          if (this.inFlight.size >= 4) throw new Error('OUTBOX_ADAPTER_LIMIT');
          const operation = adapter.dispatchRefresh(device.id, context);
          this.inFlight.add(operation);
          void operation
            .finally(() => this.inFlight.delete(operation))
            .catch(() => {});
          await new Promise<void>((resolve, reject) => {
            const abort = () => reject(new Error('OUTBOX_ADAPTER_TIMEOUT'));
            context.signal.addEventListener('abort', abort, { once: true });
            operation
              .then(resolve, reject)
              .finally(() => context.signal.removeEventListener('abort', abort));
          });
        } else await adapter.dispatchRefresh(device.id);
        } catch (error) {
          emitStructuredEvent('DEVICE_DELIVERY_FAILED', { role: 'api', outcome: context?.signal.aborted ? 'aborted' : 'failure',
            durationMs: Math.min(86_400_000, Math.max(0, performance.now() - started)) });
          throw error;
        }
      });
    }
  }
}
