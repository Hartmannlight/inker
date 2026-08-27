import * as Joi from 'joi';

export const validationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test', 'staging')
    .default('development'),
  PORT: Joi.number().default(3000),

  // Database
  DATABASE_URL: Joi.string().required(),
  OUTBOX_REDIS_PORT: Joi.number().integer().min(1).max(65535).default(6379),
  REDIS_PASSWORD: Joi.string().allow('').default('inker_redis'),

  // Instance security
  ADMIN_PIN: Joi.string().min(4).max(128).invalid('1111').required()
    .messages({
      'any.invalid': 'ADMIN_PIN must not use a known default',
      'any.required': 'ADMIN_PIN is required',
      'string.empty': 'ADMIN_PIN is required',
    }),
  INKER_INSTANCE_SECRET_PATH: Joi.string().default('./secrets/instance.json'),
  ENCRYPTION_KEY: Joi.forbidden().messages({
    'any.unknown': 'ENCRYPTION_KEY is no longer accepted; use the instance secret file',
  }),

  // Rate limiting
  THROTTLE_TTL: Joi.number().default(60),
  THROTTLE_LIMIT: Joi.number().default(100),
  PAIRING_ALLOW_INSECURE_HTTP: Joi.boolean()
    .truthy('true')
    .falsy('false')
    .default(false),
  PAIRING_TRUST_PROXY: Joi.boolean()
    .truthy('true')
    .falsy('false')
    .default(false),

  // File uploads
  MAX_FILE_SIZE: Joi.number().default(10485760),
  SCREENS_DIR: Joi.string().default('./uploads/screens'),
  FIRMWARE_DIR: Joi.string().default('./uploads/firmware'),

  // Device configuration
  DEVICE_POLLING_INTERVAL: Joi.number().default(60000),
  DEVICE_OFFLINE_THRESHOLD: Joi.number().default(300000),

  // Logging
  LOG_LEVEL: Joi.string()
    .valid('error', 'warn', 'info', 'debug', 'verbose')
    .default('info'),
  LOG_FORMAT: Joi.string().valid('json', 'simple').default('json'),
});
