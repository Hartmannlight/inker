import { resolve } from 'node:path';
import {
  DEFAULT_INSTANCE_SECRET_PATH,
  initializeInstanceSecrets,
  loadInstanceSecrets,
  resolveSqlitePath,
  validateAdminPin,
} from '../src/config/instance-secrets';
import { redactSecretText } from '../src/config/secret-redaction';

function main(): void {
  validateAdminPin(process.env.ADMIN_PIN);
  const secretPath = resolve(
    process.env.INKER_INSTANCE_SECRET_PATH || DEFAULT_INSTANCE_SECRET_PATH,
  );
  const initializeExisting = process.argv.includes('--initialize-existing');
  const initialize = initializeExisting || process.argv.includes('--initialize');

  if (initialize) {
    const databasePath = resolveSqlitePath(process.env.DATABASE_URL);
    const result = initializeInstanceSecrets({
      secretPath,
      databasePath,
      allowExistingDatabase: initializeExisting,
    });
    if (result.created) {
      console.info(`Created instance secret version ${result.secrets.version} (${result.secrets.keyId})`);
    } else {
      console.info(`Instance secret is ready (${result.secrets.keyId})`);
    }
    return;
  }

  const secrets = loadInstanceSecrets(secretPath);
  console.info(`Instance secret is ready (${secrets.keyId})`);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fatal instance secret setup error: ${redactSecretText(message)}`);
  process.exit(1);
}
