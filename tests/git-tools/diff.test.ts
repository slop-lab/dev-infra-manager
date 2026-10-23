import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lineAnchor, parseGitDiff, parseDiffSnapshot } from "@slop-lab/git-diff";
const baseCommit = "a".repeat(40), headCommit = "b".repeat(40);
const patch = 'diff --git a/a.txt b/a.txt\nindex 111..222 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@ title\n same\n-old\n+<script>alert(1)</script>\n\\ No newline at end of file\n';
describe("portable Git diff", () => {
  it("preserves source text, both coordinate systems and missing final newline", () => {
    const document = parseGitDiff(patch, { baseCommit, headCommit });
    const file = document.files[0]!, lines = file.hunks[0]!.lines;
    expect(lines).toEqual([
      { kind: "context", text: "same", oldLine: 1, newLine: 1 },
      { kind: "deletion", text: "old", oldLine: 2, newLine: null },
      { kind: "addition", text: "<script>alert(1)</script>", oldLine: null, newLine: 2, noNewline: true }
    ]);
    expect(lineAnchor(document, file, lines[1]!, "head")).toBeNull();
    expect(lineAnchor(document, file, lines[1]!, "base")).toEqual({ baseCommit, headCommit, path: "a.txt", side: "base", line: 2 });
    expect(parseDiffSnapshot(JSON.parse(JSON.stringify(document)))).toEqual(document);
  });
  it("parses real Git rename, quoted Unicode paths, binary and empty files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "portable-diff-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    try {
      git("init", "--quiet"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
      await writeFile(join(cwd, '한 글.txt'), "same\nsource\n"); await writeFile(join(cwd, "binary"), new Uint8Array([0, 1]));
      git("add", "."); git("commit", "-qm", "base"); const base = git("rev-parse", "HEAD");
      await rename(join(cwd, '한 글.txt'), join(cwd, 'renamed "file".txt'));
      await writeFile(join(cwd, "binary"), new Uint8Array([0, 2])); await writeFile(join(cwd, "empty"), "");
      git("add", "."); git("commit", "-qm", "head"); const head = git("rev-parse", "HEAD");
      const raw = execFileSync("git", ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--full-index", "-M", base, head, "--"], { cwd, encoding: "utf8" });
      const document = parseGitDiff(raw, { baseCommit: base, headCommit: head });
      expect(document.files.find(file => file.status === "renamed")).toMatchObject({ oldPath: "한 글.txt", newPath: 'renamed "file".txt', hunks: [] });
      expect(document.files.find(file => file.newPath === "binary")).toMatchObject({ binary: true, hunks: [] });
      expect(document.files.find(file => file.newPath === "empty")).toMatchObject({ status: "added", oldPath: null, hunks: [] });
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
  it("preserves mode-only paths containing an apparent unquoted header separator", () => {
    const document = parseGitDiff("diff --git a/x b/z b/x b/z\nold mode 100644\nnew mode 100755\n", { baseCommit, headCommit });
    expect(document.files[0]).toMatchObject({ oldPath: "x b/z", newPath: "x b/z", hunks: [] });
  });
  it("rejects malformed, truncated, combined and excessive diffs rather than dropping content", () => {
    for (const invalid of [patch.replace("+<script>alert(1)</script>\n", ""), patch.replace("@@ -1,2 +1,2", "@@ -1,9 +1,2"), "diff --cc file\n", "surprise\n", patch + "+++ surprise\n"]) {
      expect(() => parseGitDiff(invalid, { baseCommit, headCommit })).toThrow();
    }
    expect(() => parseGitDiff(patch, { baseCommit: "main", headCommit })).toThrow(/object IDs/);
    expect(() => parseGitDiff(patch, { baseCommit, headCommit, maxBytes: 10 })).toThrow(/byte limit/);
    expect(() => parseGitDiff(patch, { baseCommit, headCommit, maxLines: 2 })).toThrow(/line limit/);
    expect(() => parseGitDiff(patch + patch, { baseCommit, headCommit, maxFiles: 1 })).toThrow(/file limit/);
  });
  it("validates untrusted JSON anchors and coordinates without a service dependency", () => {
    const document = parseGitDiff(patch, { baseCommit, headCommit });
    const malformed = JSON.parse(JSON.stringify(document));
    malformed.files[0].hunks[0].lines[2].newLine = 99;
    expect(() => parseDiffSnapshot(malformed)).toThrow(/coordinates/);
    expect(() => parseDiffSnapshot({ ...document, headCommit: "main" })).toThrow(/object IDs/);
    expect(() => parseDiffSnapshot({ ...document, files: [{ ...document.files[0], binary: true }] })).toThrow(/Binary/);
    expect(parseGitDiff("", { baseCommit: "a".repeat(64), headCommit: "b".repeat(64) }).files).toEqual([]);
  });
});
