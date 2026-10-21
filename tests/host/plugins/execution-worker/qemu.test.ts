import { expect, it } from "vitest";
import { qemuContainerArguments, qemuBackend } from "../../../../packages/host/plugins/execution-worker/src/backends/qemu.js";
import { assignment, grant, event } from "../../../contracts/ci/executionFixture.js";
it("routes QEMU through a bounded unprivileged KVM supervisor with public candidate mounts", () => {
  const selected = assignment(), authorized = grant({ ...selected, event: event("integration", "qemu") });
  const args = qemuContainerArguments({ grant: authorized, root: "/private/job" }, { uid: 1000, gid: 1000, kvmGroup: 108 });
  const option = (name: string) => args[args.indexOf(name) + 1];
  expect(qemuBackend.kind).toBe("qemu"); expect(option("--device")).toBe("/dev/kvm:/dev/kvm");
  expect(option("--network")).toBe("bridge"); expect(option("--cap-drop")).toBe("ALL");
  expect(option("--oom-score-adj")).toBe("500");
  expect(option("--cpus")).toBe(authorized.profile.bounds.cpu);
  expect(BigInt(option("--memory")!)).toBe(BigInt(authorized.profile.bounds.memoryBytes) + 256n * 1024n * 1024n);
  expect(args).toContain("type=bind,src=/private/job/job,dst=/run/dim/job,readonly");
  expect(args.join(" ")).not.toMatch(/docker\.sock|--privileged|--env|password|credential/);
});
