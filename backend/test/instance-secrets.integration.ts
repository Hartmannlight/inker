import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const backendRoot = resolve(import.meta.dir, '..');
const repositoryRoot = resolve(backendRoot, '..');
const script = join(backendRoot, 'scripts', 'prepare-instance-secrets.ts');
const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'inker-secret-startup-'));
  directories.push(directory);
  return directory;
}

async function prepare(
  directory: string,
  mode: '--initialize' | '--initialize-existing' = '--initialize',
): Promise<{ exitCode: number; output: string }> {
  const secretPath = join(directory, 'secrets', 'instance.json');
  const databasePath = join(directory, 'uploads', 'inker.db');
  const subprocess = Bun.spawn({
    cmd: [process.execPath, script, mode],
    cwd: backendRoot,
    env: {
      ...process.env,
      ADMIN_PIN: 'local-admin-passphrase',
      DATABASE_URL: `file:${databasePath.replaceAll('\\', '/')}`,
      INKER_INSTANCE_SECRET_PATH: secretPath,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  return { exitCode, output: stdout + stderr };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('instance secret startup integration', () => {
  test('initializes once and validates the same secret on restart', async () => {
    const directory = temporaryDirectory();
    const first = await prepare(directory);
    const secretPath = join(directory, 'secrets', 'instance.json');
    const initialDocument = readFileSync(secretPath, 'utf8');

    const restart = await prepare(directory);

    expect(first.exitCode).toBe(0);
    expect(first.output).toContain('Created instance secret');
    expect(first.output).not.toContain(JSON.parse(initialDocument).encryptionKey);
    expect(restart.exitCode).toBe(0);
    expect(restart.output).toContain('Instance secret is ready');
    expect(readFileSync(secretPath, 'utf8')).toBe(initialDocument);
  });

  test('fails closed when only an existing SQLite file is present', async () => {
    const directory = temporaryDirectory();
    const uploads = join(directory, 'uploads');
    mkdirSync(uploads, { recursive: true });
    writeFileSync(join(uploads, 'inker.db'), 'copied without its secret volume');

    const result = await prepare(directory);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('instance secret is missing for an existing database');
    expect(result.output).not.toContain('local-admin-passphrase');
  });

  test('requires an explicit migration mode to initialize an existing installation', async () => {
    const directory = temporaryDirectory();
    const uploads = join(directory, 'uploads');
    mkdirSync(uploads, { recursive: true });
    writeFileSync(join(uploads, 'inker.db'), 'legacy database with no instance secret');

    const result = await prepare(directory, '--initialize-existing');

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Created instance secret');
    expect(readFileSync(join(directory, 'secrets', 'instance.json'), 'utf8')).toContain('"keyId"');
  });

  test('keeps setup and backup documentation aligned with the two-volume contract', () => {
    const readme = readFileSync(join(repositoryRoot, 'README.md'), 'utf8');
    const backup = readFileSync(
      join(repositoryRoot, 'docs', 'operations', 'DATABASE_BACKUP.md'),
      'utf8',
    );
    const compose = readFileSync(join(repositoryRoot, 'docker-compose.yml'), 'utf8');

    expect(readme).toContain('/app/secrets');
    expect(readme).toContain('ADMIN_PIN');
    expect(backup).toContain('/app/secrets');
    expect(backup).toContain('keyId');
    expect(compose).toContain('secrets_data:/app/secrets');
    expect(compose).not.toContain('ADMIN_PIN: "${ADMIN_PIN:-1111}"');
  });
});
