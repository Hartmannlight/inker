import { Injectable } from '@nestjs/common';
import { AdminSessionService } from './admin-session.service';

/**
 * Deprecated compatibility adapter for code that still imports the historical
 * service name. It never validates configuration secrets or owns sessions.
 */
@Injectable()
export class PinAuthService {
  constructor(private readonly sessions: AdminSessionService) {}

  async validateSession(token: string): Promise<boolean> {
    return (await this.sessions.validate(token)) !== null;
  }
}
