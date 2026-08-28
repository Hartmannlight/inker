import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isIP } from 'node:net';
import type { Request, Response } from 'express';

export function federationProxyAddresses(value: string): Set<string> {
  const addresses = value === '' ? [] : value.split(',').map(address => address.trim());
  if (addresses.length > 32 || addresses.some(address => !isIP(address))) throw new Error('Invalid FEDERATION_TRUSTED_PROXIES');
  return new Set(addresses);
}

@Injectable()
export class FederationTransportGuard implements CanActivate {
  private readonly proxies: Set<string>;
  constructor(config: ConfigService) {
    this.proxies = federationProxyAddresses(config.get<string>('federation.trustedProxies', ''));
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    response.setHeader('Cache-Control', 'no-store');
    const encrypted = (request.socket as Request['socket'] & { encrypted?: boolean }).encrypted === true;
    const peer = request.socket.remoteAddress ?? '';
    // Express request.secure can trust spoofed headers when a global trustProxy
    // setting is enabled. Only the real socket or an explicit immediate peer
    // with one sanitized forwarding value establishes this security boundary.
    const trusted = this.proxies.has(peer) && request.headers['x-forwarded-proto'] === 'https';
    if (!encrypted && !trusted) throw new ForbiddenException('FEDERATION_HTTPS_REQUIRED');
    return true;
  }
}
