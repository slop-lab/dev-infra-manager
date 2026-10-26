import { describe, expect, it } from "vitest";
import { parseOperatorArguments, summarizePreflight } from "./preflight.js";

describe("parseOperatorArguments", () => {
  it("Given an image and Chromium path, when arguments are parsed, then execution is enabled", () => {
    const result = parseOperatorArguments(["reviewed/image:tag", "--chromium", "/opt/chromium"]);
    expect(result).toEqual({ image: "reviewed/image:tag", chromium: "/opt/chromium", preflightOnly: false, connectionOnly: false });
  });

  it("Given connection-only arguments, when parsed, then runtime creation is disabled", () => {
    const result = parseOperatorArguments(["reviewed/image:tag", "--chromium", "/opt/chromium", "--connection-only"]);
    expect(result.connectionOnly).toBe(true);
  });

  it("Given preflight-only arguments, when parsed, then runtime mutation is disabled", () => {
    const result = parseOperatorArguments(["reviewed/image:tag", "--chromium", "/opt/chromium", "--preflight-only"]);
    expect(result.preflightOnly).toBe(true);
  });

  it("Given a relative Chromium path, when parsed, then input is rejected", () => {
    expect(() => parseOperatorArguments(["reviewed/image:tag", "--chromium", "chromium"])).toThrow(/absolute/);
  });
});

describe("summarizePreflight", () => {
  it("Given unavailable Sysbox with otherwise ready prerequisites, when summarized, then failure is actionable", () => {
    const result = summarizePreflight([
      { name: "linux", ok: true, detail: "linux" },
      { name: "node", ok: true, detail: "26.0.0" },
      { name: "docker", ok: true, detail: "29.1.3" },
      { name: "sysbox-runc", ok: false, detail: "not listed by docker info" },
      { name: "image", ok: true, detail: "reviewed/image:tag" },
      { name: "chromium", ok: true, detail: "Chromium 140" }
    ]);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/sysbox-runc/);
    expect(result.message).toMatch(/before any workspace is created/);
  });
});
