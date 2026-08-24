import { describe, expect, it } from 'bun:test';

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
});
