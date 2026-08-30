import { Injectable } from '@nestjs/common';
import type { PublishedArtifact } from '../publications/publication-content';

type Lease = { artifact: PublishedArtifact; expiresAt: number };

/** Bridges the manifest/artifact request pair across a fast playlist transition. */
@Injectable()
export class PullArtifactLeaseService {
  private readonly leases = new Map<number, Lease>();

  issue(deviceId: number, artifact: PublishedArtifact) {
    if (this.leases.size >= 512 && !this.leases.has(deviceId)) {
      const oldest = this.leases.keys().next().value;
      if (oldest !== undefined) this.leases.delete(oldest);
    }
    this.leases.set(deviceId, { artifact, expiresAt: Date.now() + 20_000 });
  }

  read(deviceId: number, sha256: string): PublishedArtifact | undefined {
    const lease = this.leases.get(deviceId);
    if (!lease || lease.expiresAt < Date.now()) {
      this.leases.delete(deviceId);
      return undefined;
    }
    return lease.artifact.sha256 === sha256 ? lease.artifact : undefined;
  }
}
