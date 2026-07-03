import { describe, expect, it } from "vitest";
import { formatBytes, parseBytes } from "../src/size.js";

describe("size parsing", () => {
  it("parses binary units", () => {
    expect(parseBytes("1KiB")).toBe(1024);
    expect(parseBytes("2 MiB")).toBe(2 * 1024 * 1024);
    expect(parseBytes("1.5GiB")).toBe(Math.floor(1.5 * 1024 ** 3));
  });

  it("formats exact binary units", () => {
    expect(formatBytes(1024)).toBe("1KiB");
    expect(formatBytes(2 * 1024 ** 3)).toBe("2GiB");
  });
});
