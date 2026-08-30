import { describe, expect, it } from 'bun:test';
import { BadRequestException } from '@nestjs/common';
import {
  ConnectedDeliveryPolicy,
  ResponsivePullDeliveryPolicy,
  SleepyDeliveryPolicy,
} from './delivery-policies';
import { DeliveryPolicyRegistry } from './delivery-policy.registry';

const capabilities = (modes: string[]) => ({
  transport: { modes },
  energy: {},
}) as any;

describe('DeliveryPolicy strategies', () => {
  const registry = new DeliveryPolicyRegistry([
    new SleepyDeliveryPolicy(),
    new ResponsivePullDeliveryPolicy(),
    new ConnectedDeliveryPolicy(),
  ]);

  it('keeps energy policy independent from transport selection', () => {
    expect(registry.get('sleepy').selectTransport(capabilities(['http-pull']))).toBe('http-pull');
    expect(registry.get('responsive-pull').selectTransport(capabilities(['http-pull']))).toBe('http-pull');
    expect(registry.get('connected').selectTransport(capabilities(['http-pull', 'websocket']))).toBe('websocket');
  });

  it('rejects a policy when its transport capability is absent', () => {
    expect(() => registry.get('connected').selectTransport(capabilities(['http-pull']))).toThrow(
      BadRequestException,
    );
  });

  it('marks only connected delivery for immediate transport dispatch', () => {
    expect(registry.get('sleepy').dispatchOnRefresh).toBe(false);
    expect(registry.get('responsive-pull').dispatchOnRefresh).toBe(false);
    expect(registry.get('connected').dispatchOnRefresh).toBe(true);
  });

  it('provides bounded pull fallback hints for connected embedded devices', () => {
    const policy = registry.get('connected');
    expect(policy.pullHints?.(capabilities(['http-pull', 'websocket']), {
      protocolVersion: '1.0', policyId: 'connected-test', mode: 'connected',
      pollIntervalSeconds: 30, heartbeatSeconds: 30, reconnectBackoffSeconds: 5,
      telemetryIntervalSeconds: 60, maxStaleSeconds: 3600,
    })).toEqual({ refreshAfterSeconds: 30, telemetryIntervalSeconds: 60 });
    expect(() => policy.pullHints?.(capabilities(['websocket']), {
      protocolVersion: '1.0', policyId: 'connected-test', mode: 'connected',
      pollIntervalSeconds: 30, heartbeatSeconds: 30, reconnectBackoffSeconds: 5,
      telemetryIntervalSeconds: 60, maxStaleSeconds: 3600,
    })).toThrow(BadRequestException);
  });
});
