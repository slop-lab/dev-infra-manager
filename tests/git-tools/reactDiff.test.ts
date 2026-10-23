import { expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GitDiff, type DiffLineContext } from "@slop-lab/react-git-diff";
import { parseGitDiff } from "@slop-lab/git-diff";
const snapshot = parseGitDiff('diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+<img src=x onerror=alert(1)>\n', { baseCommit: "a".repeat(40), headCommit: "b".repeat(40) });
it("renders untrusted source as text and supplies exact anchors to independent extensions", () => {
  const contexts: DiffLineContext[] = [];
  const html = renderToStaticMarkup(h(GitDiff, { snapshot,
    renderFileToolbar: ({ file }) => h("button", null, `Blame ${file.newPath}`),
    renderLineGutter: context => { contexts.push(context); return h("span", null, "1 comment"); },
    renderBelowLine: context => context.headAnchor ? h("p", null, "Independent comment") : null,
    onSelectLine() { /* rendering must not call action */ throw new Error("unexpected action"); }
  }));
  expect(html).not.toContain("style=");
  expect(html).toContain("git-diff__source");
  expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;"); expect(html).not.toContain("<img");
  expect(html).toContain("Independent comment"); expect(html).toContain("Blame file");
  expect(html).toContain("Select base line 1 of file"); expect(html).toContain("Select head line 1 of file");
  expect(contexts.map(item => [item.baseAnchor?.side ?? null, item.headAnchor?.side ?? null])).toEqual([["base", null], [null, "head"]]);
});
it("shows binary, metadata-only and empty changes without creating line anchors", () => {
  expect(renderToStaticMarkup(h(GitDiff, { snapshot: { ...snapshot, files: [] } }))).toContain("No changes.");
  expect(renderToStaticMarkup(h(GitDiff, { snapshot: { ...snapshot, files: [{ ...snapshot.files[0]!, hunks: [], binary: true }] } }))).toContain("Binary file changed.");
  expect(renderToStaticMarkup(h(GitDiff, { snapshot: { ...snapshot, files: [{ ...snapshot.files[0]!, hunks: [] }] } }))).toContain("File metadata changed.");
});
