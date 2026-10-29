import {
  GitCiPlanFileVersionError,
  sameGitCiPlanFileVersion,
  type GitCiPlanFileVersion
} from "./plan-file-version.js";

const attestationOverheadBytes = 128;

export class PlanPathAttestations {
  readonly #versions = new Map<string, GitCiPlanFileVersion>();
  #bytes = 0;

  constructor(
    readonly maximumEntries: number,
    readonly maximumBytes: number
  ) {}

  expected(path: string): GitCiPlanFileVersion | undefined {
    return this.#versions.get(path);
  }

  attest(path: string, version: GitCiPlanFileVersion): void {
    const existing = this.#versions.get(path);
    if (existing !== undefined) {
      if (!sameGitCiPlanFileVersion(existing, version)) {
        throw new GitCiPlanFileVersionError("Git CI plan path version changed");
      }
      return;
    }
    const bytes = Buffer.byteLength(path, "utf8") + attestationOverheadBytes;
    if (this.#versions.size >= this.maximumEntries || this.#bytes + bytes > this.maximumBytes) {
      throw new GitCiPlanFileVersionError("Git CI plan path attestation capacity is exhausted");
    }
    this.#versions.set(path, version);
    this.#bytes += bytes;
  }
}
