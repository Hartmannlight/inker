export const configuration = () => ({
  port: parseInt(process.env.PORT || '3002', 10),
  environment: process.env.NODE_ENV || 'development',

  api: {
    url: process.env.API_URL || `http://localhost:${process.env.PORT || '3002'}`,
  },

  inkerPort: parseInt(process.env.INKER_PORT || '80', 10),

  database: {
    url: process.env.DATABASE_URL,
  },

  // External APIs
  models: {
    apiUrl: process.env.MODELS_API_URL,
  },

  github: {
    token: process.env.GITHUB_TOKEN, // Optional - increases rate limit from 60/hr to 5000/hr
  },

  throttle: {
    ttl: parseInt(process.env.THROTTLE_TTL || '60', 10),
    limit: parseInt(process.env.THROTTLE_LIMIT || '100', 10),
  },

  upload: {
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '10485760', 10), // 10MB
    screensDir: process.env.SCREENS_DIR || './uploads/screens',
    firmwareDir: process.env.FIRMWARE_DIR || './uploads/firmware',
  },

  device: {
    apiKeyLength: 32,
    pollingInterval: parseInt(process.env.DEVICE_POLLING_INTERVAL || '60000', 10), // 1 minute
    offlineThreshold: parseInt(process.env.DEVICE_OFFLINE_THRESHOLD || '300000', 10), // 5 minutes
  },

  admin: {
    pin: process.env.ADMIN_PIN || '1111',
  },

  encryption: {
    key: process.env.ENCRYPTION_KEY,
  },

  oauth: {
    providers: {
      google: {
        clientId: process.env.OAUTH_GOOGLE_CLIENT_ID,
        clientSecret: process.env.OAUTH_GOOGLE_CLIENT_SECRET,
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        scopes: 'https://www.googleapis.com/auth/calendar.readonly',
      },
      spotify: {
        clientId: process.env.OAUTH_SPOTIFY_CLIENT_ID,
        clientSecret: process.env.OAUTH_SPOTIFY_CLIENT_SECRET,
        authUrl: 'https://accounts.spotify.com/authorize',
        tokenUrl: 'https://accounts.spotify.com/api/token',
        scopes: 'user-read-currently-playing user-read-recently-played',
      },
      strava: {
        clientId: process.env.OAUTH_STRAVA_CLIENT_ID,
        clientSecret: process.env.OAUTH_STRAVA_CLIENT_SECRET,
        authUrl: 'https://www.strava.com/oauth/authorize',
        tokenUrl: 'https://www.strava.com/oauth/token',
        scopes: 'read,activity:read',
      },
    },
  },

  logging: {
    level: process.env.LOG_LEVEL || 'info',
    format: process.env.LOG_FORMAT || 'json',
  },

  // Default timezone for server-side rendering (e.g., clock/date widgets)
  // Docker containers default to UTC, so this provides a configurable default
  defaultTimezone: process.env.DEFAULT_TIMEZONE || 'UTC',
});