import type { AdmissionVerifier } from "../../../../core/packages/native-git/src/index.js";
import { descriptorDigest } from "../../../../core/packages/native-git/src/candidate-execution.js";

export type TestAdmissionVerifier = {
  readonly verifier: AdmissionVerifier;
  setGeneration(generation: string): void;
  setAvailable(available: boolean): void;
  hang(method: "admitted" | "current"): void;
  release(): void;
};

export function createTestAdmissionVerifier(): TestAdmissionVerifier {
  let admissionGeneration = "generation-7";
  let available = true;
  let hanging: "admitted" | "current" | undefined;
  let releaseHang: (() => void) | undefined;
  const admittedDigests = new Set<string>();
  const waitIfHanging = async (method: "admitted" | "current"): Promise<void> => {
    if (hanging !== method) return;
    await new Promise<void>((resolve) => { releaseHang = resolve; });
  };
  return {
    verifier: {
      async assertAdmitted(input) {
        await waitIfHanging("admitted");
        if (!available) throw new Error("test admission verifier unavailable");
        if (input.descriptor.admissionGeneration !== admissionGeneration
          || input.hostId !== "host-a" || input.capacity !== "primary"
          || input.descriptorDigest !== descriptorDigest(input.descriptor)) {
          throw new Error("test admission is not current");
        }
        admittedDigests.add(input.descriptorDigest);
      },
      async assertCurrentAttempt(input) {
        await waitIfHanging("current");
        if (!available) throw new Error("test admission verifier unavailable");
        if (input.admissionGeneration !== admissionGeneration
          || input.hostId !== "host-a" || input.capacity !== "primary"
          || input.reviewId.length === 0 || input.attemptId.length === 0
          || !admittedDigests.has(input.descriptorDigest)) {
          throw new Error("test attempt is not current");
        }
      }
    },
    setGeneration(generation) {
      admissionGeneration = generation;
    },
    setAvailable(nextAvailable) {
      available = nextAvailable;
    },
    hang(method) {
      hanging = method;
    },
    release() {
      hanging = undefined;
      releaseHang?.();
      releaseHang = undefined;
    }
  };
}
