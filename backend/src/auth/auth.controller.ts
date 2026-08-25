import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus,
  Param, Post, Req, Res, UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { AdminCredentialService } from './admin-credential.service';
import { AdminSessionService } from './admin-session.service';
import { LoginDto } from './dto/login.dto';
import { clearSessionCookie, setSessionCookie } from './session-cookie';

interface AuthenticatedRequest extends Request {
  adminSession: {
    sessionId: string;
    adminId: string;
    authentication: 'cookie' | 'legacy-bearer';
  };
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly credentials: AdminCredentialService,
    private readonly sessions: AdminSessionService,
  ) {}

  @Public()
  @Post('login')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Create a server-side administrator session' })
  @ApiResponse({ status: 200, description: 'Successfully authenticated' })
  async login(
    @Body() loginDto: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const password = loginDto.password ?? loginDto.pin;
    if (!password) throw new BadRequestException('Password is required');
    const adminId = await this.credentials.authenticate(password);
    if (!adminId) throw new UnauthorizedException('Invalid credentials');
    const session = await this.sessions.create(adminId, {
      userAgent: request.headers['user-agent'],
      ipAddress: request.ip,
    });
    setSessionCookie(response, request, session.token);
    response.setHeader('X-CSRF-Token', session.csrfToken);
    response.setHeader('Cache-Control', 'no-store');
    return { message: 'Login successful', sessionId: session.sessionId, expiresAt: session.expiresAt };
  }

  @Get('session')
  async currentSession(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const csrfToken = await this.sessions.rotateCsrf(request.adminSession.sessionId);
    response.setHeader('X-CSRF-Token', csrfToken);
    response.setHeader('Cache-Control', 'no-store');
    return { authenticated: true, sessionId: request.adminSession.sessionId };
  }

  @Post('validate')
  @HttpCode(HttpStatus.OK)
  validate() {
    return { valid: true };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.sessions.revoke(request.adminSession.sessionId, request.adminSession.adminId);
    clearSessionCookie(response, request);
    return { message: 'Logout successful' };
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.OK)
  async logoutAll(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const revokedSessions = await this.sessions.revokeAll(request.adminSession.adminId);
    clearSessionCookie(response, request);
    return { message: 'All sessions logged out', revokedSessions };
  }

  @Get('sessions')
  listSessions(@Req() request: AuthenticatedRequest) {
    return this.sessions.list(request.adminSession.adminId, request.adminSession.sessionId);
  }

  @Delete('sessions/:sessionId')
  @HttpCode(HttpStatus.OK)
  async revokeSession(
    @Param('sessionId') sessionId: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.sessions.revoke(sessionId, request.adminSession.adminId);
    if (sessionId === request.adminSession.sessionId) clearSessionCookie(response, request);
    return { message: 'Session revoked' };
  }
}
