import {
  Injectable,
  ExecutionContext,
  CanActivate,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { AdminSessionService } from '../admin-session.service';
import { ADMIN_SESSION_COOKIE, readCookie, setSessionCookie } from '../session-cookie';

/**
 * Protects admin routes by default. Browser requests use the server-side
 * HttpOnly session cookie and a session-bound CSRF header. Bearer is retained
 * only as a controlled compatibility path for existing non-browser clients.
 */
@Injectable()
export class PinAuthGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private adminSessions: AdminSessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if route is marked as public
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const cookieToken = readCookie(request.headers.cookie, ADMIN_SESSION_COOKIE);
    const bearerToken = cookieToken ? null : this.extractBearerToken(request.headers.authorization);
    const token = cookieToken || bearerToken;

    if (!token) {
      throw new UnauthorizedException('No session token provided');
    }

    const session = await this.adminSessions.validate(token);
    if (!session) {
      throw new UnauthorizedException('Invalid or expired session');
    }

    request.adminSession = {
      sessionId: session.sessionId,
      adminId: session.adminId,
      expiresAt: session.expiresAt,
      authentication: cookieToken ? 'cookie' : 'legacy-bearer',
    };
    if (session.rotatedToken) setSessionCookie(response, request, session.rotatedToken);

    if (cookieToken && !['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) {
      const csrfToken = request.headers['x-csrf-token'];
      const validCsrf = typeof csrfToken === 'string'
        && await this.adminSessions.verifyCsrf(session.sessionId, csrfToken);
      if (!validCsrf) throw new ForbiddenException('CSRF validation failed');
    }

    return true;
  }

  private extractBearerToken(authHeader: string | undefined): string | null {
    if (!authHeader) {
      return null;
    }

    const [type, token] = authHeader.split(' ');
    if (type !== 'Bearer' || !token) {
      return null;
    }

    return token;
  }
}
