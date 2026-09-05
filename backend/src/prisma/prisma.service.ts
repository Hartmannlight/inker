import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

type PrismaLoggingOptions = {
  log: [
    { level: 'query'; emit: 'event' },
    { level: 'error'; emit: 'stdout' },
    { level: 'warn'; emit: 'stdout' },
  ];
};

/**
 * Prisma service that manages database connection lifecycle.
 * Implements OnModuleInit to connect when the module initializes
 * and OnModuleDestroy to disconnect when the module is destroyed.
 */
@Injectable()
export class PrismaService extends PrismaClient<PrismaLoggingOptions> implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: [
        { level: 'query', emit: 'event' },
        { level: 'error', emit: 'stdout' },
        { level: 'warn', emit: 'stdout' },
      ],
    });

    // Log queries in development mode
    if (process.env.NODE_ENV === 'development') {
      this.$on('query', (e) => {
        this.logger.debug(`Query: ${e.query} | Duration: ${e.duration}ms`);
      });
    }
  }

  /**
   * Connect to the database when the module initializes
   */
  async onModuleInit() {
    try {
      await this.$connect();

      // WAL persists in the database file; busy_timeout is connection-local. Both
      // settings are required by ADR-001, so startup must fail if SQLite rejects them.
      await this.$queryRawUnsafe('PRAGMA journal_mode = WAL');
      await this.$queryRawUnsafe('PRAGMA busy_timeout = 5000');

      this.logger.log('Database connection established');
    } catch (error) {
      this.logger.error('Failed to connect to database', error);
      throw error;
    }
  }

  /**
   * Disconnect from the database when the module is destroyed
   * This ensures graceful shutdown and proper cleanup of connections
   */
  async onModuleDestroy() {
    try {
      await this.$disconnect();
      this.logger.log('Database connection closed');
    } catch (error) {
      this.logger.error('Error disconnecting from database', error);
    }
  }
}
