import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

@Injectable()
export class PairingTransportGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const forwardedProtocol = request.headers['x-forwarded-proto'];
    const proxyProtocol = Array.isArray(forwardedProtocol)
      ? forwardedProtocol[0]
      : forwardedProtocol?.split(',')[0]?.trim();
    const trustProxy = this.config.get<boolean>('pairing.trustProxy', false);
    const secure = request.secure || request.protocol === 'https' ||
      (trustProxy && proxyProtocol === 'https');

    if (secure || this.config.get<boolean>('pairing.allowInsecureHttp', false)) {
      return true;
    }

    throw new ForbiddenException('Pairing requires HTTPS');
  }
}
