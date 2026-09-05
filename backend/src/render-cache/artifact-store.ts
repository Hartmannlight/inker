import { Injectable } from '@nestjs/common';
import { link, mkdir, open, readFile, unlink, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PublishedArtifact } from '../publications/publication-content';
import { sha256 } from '../common/utils/content-hash.util';

/** Private content-addressed files. Only authenticated delivery services expose bytes. */
@Injectable()
export class ArtifactStore {
  readonly root = resolve(process.env.INKER_RENDER_CACHE_PATH || '.render-cache');

  private path(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('ARTIFACT_INVALID_HASH');
    return resolve(this.root, hash);
  }

  async read(hash: string, size: number): Promise<Buffer> {
    const file = this.path(hash);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== size || size > 16 * 1024 * 1024)
      throw new Error('ARTIFACT_INVALID_FILE');
    const bytes = await readFile(file);
    if (sha256(bytes) !== hash) throw new Error('ARTIFACT_HASH_MISMATCH');
    return bytes;
  }

  async publish(artifact: PublishedArtifact) {
    if (!artifact.bytes.length || artifact.bytes.length > 16 * 1024 * 1024 || sha256(artifact.bytes) !== artifact.sha256)
      throw new Error('ARTIFACT_INVALID_BYTES');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = resolve(this.root, `${randomUUID()}.partial`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(artifact.bytes);
      await handle.sync();
    } finally { await handle.close(); }
    try {
      // Same-filesystem hard link publishes complete bytes without replacing an
      // existing artifact. An interrupted writer leaves only an unreferenced file.
      try { await link(temporary, this.path(artifact.sha256)); }
      catch (error) { if ((error as { code?: string }).code !== 'EEXIST') throw error; }
      await this.read(artifact.sha256, artifact.bytes.length);
      if (process.platform !== 'win32') {
        const directory = await open(this.root, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally { await unlink(temporary); }
  }
}
