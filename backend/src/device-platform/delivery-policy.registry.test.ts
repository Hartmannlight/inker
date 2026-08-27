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
});
