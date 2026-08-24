import { describe, expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const manifest = (await Bun.file(
  new URL('../package.json', import.meta.url),
).json()) as PackageManifest;

describe('@inker/contracts package boundary', () => {
  it('has no runtime dependencies', () => {
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(manifest.peerDependencies ?? {}).toEqual({});
  });

  it('does not depend on application frameworks or Prisma', () => {
    const dependencyNames = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
    });

    expect(
      dependencyNames.some(
        (name) => name === 'react' || name === '@prisma/client' || name.startsWith('@nestjs/'),
      ),
    ).toBe(false);
  });

  it('does not import frameworks or define widget-specific contracts', async () => {
    const sourceDirectory = fileURLToPath(new URL('../src/', import.meta.url));
    const sourceFiles = Array.from(
      new Bun.Glob('**/*.ts').scanSync({ cwd: sourceDirectory, absolute: true }),
    );
    const sources = await Promise.all(sourceFiles.map((file) => Bun.file(file).text()));
    const combined = sources.join('\n');

    expect(combined).not.toMatch(/from\s+['"](?:react|@prisma\/client|@nestjs\/)/);
    expect(combined.toLowerCase()).not.toContain('widget');
  });
});
