import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import {
  TRANSPORT_ADAPTER_METADATA,
  type TransportAdapter,
} from './device-extension.contracts';

@Injectable()
export class TransportAdapterRegistry implements OnModuleInit {
  private readonly adapters = new Map<string, TransportAdapter>();

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit(): void {
    this.adapters.clear();
    for (const wrapper of this.discovery.getProviders()) {
      if (!wrapper.instance || !wrapper.metatype) continue;
      if (!Reflect.getMetadata(TRANSPORT_ADAPTER_METADATA, wrapper.metatype)) continue;
      const adapter = wrapper.instance as TransportAdapter;
      if (!adapter.transportMode) continue;
      if (this.adapters.has(adapter.transportMode)) {
        throw new Error(`Duplicate transport adapter for mode: ${adapter.transportMode}`);
      }
      this.adapters.set(adapter.transportMode, adapter);
    }
  }

  get(transportMode: string): TransportAdapter {
    const adapter = this.adapters.get(transportMode);
    if (!adapter) throw new BadRequestException(`Unsupported transport adapter: ${transportMode}`);
    return adapter;
  }

  list(): TransportAdapter[] {
    return [...this.adapters.values()];
  }
}
