import { describe, expect, it } from "vitest";
import {
  GitBlameParseError,
  parseGitBlameRequest,
  parseLinePorcelain,
} from "@slop-lab/git-blame";

const request = {
  commit: "a".repeat(40),
  path: "src/index.ts",
  line: 7,
};

describe("portable Git blame parsing", () => {
  it("parses one bounded line-porcelain attribution", () => {
    const output = `${"b".repeat(40)} 3 7 1\nauthor Ada Lovelace\nsummary Explain the algorithm\n\tconst answer = 42;\n`;

    const result = parseLinePorcelain(output, request);

    expect(result).toEqual({
      commit: "b".repeat(40),
      path: "src/index.ts",
      line: 7,
      author: "Ada Lovelace",
      summary: "Explain the algorithm",
    });
  });

  it("accepts SHA-256 attribution object identifiers", () => {
    const output = `${"b".repeat(64)} 3 7\nauthor Ada Lovelace\nsummary Explain the algorithm\n`;

    expect(parseLinePorcelain(output, { ...request, commit: "a".repeat(64) }).commit).toBe("b".repeat(64));
  });

  it("rejects malformed or oversized porcelain", () => {
    expect(() => parseLinePorcelain(`${"b".repeat(40)} 3 7\nsummary Missing author\n`, request)).toThrow(GitBlameParseError);
    expect(() => parseLinePorcelain("x".repeat(256 * 1024 + 1), request)).toThrow(GitBlameParseError);
  });

  it("validates immutable request coordinates", () => {
    expect(() => parseGitBlameRequest({ ...request, path: "../secret" })).toThrow();
    expect(parseGitBlameRequest(request)).toEqual(request);
  });
});
