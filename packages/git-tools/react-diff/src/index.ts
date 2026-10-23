import { createElement as h, Fragment, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { lineAnchor, type DiffFile, type DiffHunk, type DiffLine, type DiffLineAnchor, type DiffSnapshot } from "@slop-lab/git-diff";

export interface DiffFileContext {
  readonly snapshot: DiffSnapshot;
  readonly file: DiffFile;
}
export interface DiffLineContext extends DiffFileContext {
  readonly hunk: DiffHunk;
  readonly line: DiffLine;
  readonly baseAnchor: DiffLineAnchor | null;
  readonly headAnchor: DiffLineAnchor | null;
}
/** Fixed presentation slots. Fetching, authorization and extension state stay with the caller. */
export interface GitDiffProps {
  readonly snapshot: DiffSnapshot;
  readonly className?: string;
  readonly renderFileToolbar?: (context: DiffFileContext) => ReactNode;
  readonly renderLineGutter?: (context: DiffLineContext) => ReactNode;
  readonly renderBelowLine?: (context: DiffLineContext) => ReactNode;
  readonly onSelectLine?: (anchor: DiffLineAnchor) => void;
}
function numberCell(anchor: DiffLineAnchor | null, onSelectLine: GitDiffProps["onSelectLine"]): ReactNode {
  return h("td", { className: "git-diff__number-cell" }, anchor && (onSelectLine ? h("button", {
    type: "button", className: "git-diff__line-number",
    "aria-label": `Select ${anchor.side} line ${anchor.line} of ${anchor.path}`,
    onClick: () => onSelectLine(anchor)
  }, anchor.line) : h("span", { className: "git-diff__line-number" }, anchor.line)));
}
function renderLine(props: GitDiffProps, file: DiffFile, hunk: DiffHunk, line: DiffLine, index: number): ReactNode {
  const context: DiffLineContext = { snapshot: props.snapshot, file, hunk, line,
    baseAnchor: lineAnchor(props.snapshot, file, line, "base"), headAnchor: lineAnchor(props.snapshot, file, line, "head") };
  const below = props.renderBelowLine?.(context);
  return h(Fragment, { key: index },
    h("tr", { "data-diff-line": line.kind, className: `git-diff__line git-diff__line--${line.kind}` },
      numberCell(context.baseAnchor, props.onSelectLine), numberCell(context.headAnchor, props.onSelectLine),
      h("td", { className: "git-diff__gutter" }, props.renderLineGutter?.(context)),
      h("td", { className: "git-diff__source" },
        h("span", { "aria-hidden": true, className: "git-diff__marker" }, line.kind === "addition" ? "+ " : line.kind === "deletion" ? "- " : "  "),
        line.text, line.noNewline ? h("span", { className: "git-diff__no-newline" }, "\\ No newline at end of file") : null)),
    below === undefined || below === null || below === false ? null : h("tr", { "data-diff-below-line": "" }, h("td", { colSpan: 4, className: "git-diff__below-line" }, below)));
}
export function GitDiff(props: GitDiffProps): ReactNode {
  return h("div", { className: ["git-diff", props.className].filter(Boolean).join(" "), "data-git-diff": "" },
    props.snapshot.files.length === 0 ? h("p", null, "No changes.") : props.snapshot.files.map((file, fileIndex) => {
      const path = file.newPath ?? file.oldPath ?? "Unknown file";
      return h("section", { key: fileIndex, "aria-label": `Diff for ${path}`, className: "git-diff__file" },
        h("header", { className: "git-diff__file-header" },
          h("strong", { className: "git-diff__path" }, file.status === "renamed" || file.status === "copied" ? `${file.oldPath} → ${file.newPath}` : path),
          h("span", null, file.status), props.renderFileToolbar?.({ snapshot: props.snapshot, file })),
        file.binary ? h("p", { className: "git-diff__metadata" }, "Binary file changed.") : file.hunks.length === 0 ? h("p", { className: "git-diff__metadata" }, "File metadata changed.") :
          h("div", { className: "git-diff__scroll" }, h("table", { "aria-label": `Changes in ${path}`, className: "git-diff__table" },
            h("tbody", null, file.hunks.map((hunk, index) => h(Fragment, { key: index },
              h("tr", null, h("td", { colSpan: 4, className: "git-diff__hunk" }, hunk.header)),
              hunk.lines.map((line, lineIndex) => renderLine(props, file, hunk, line, lineIndex))))))));
    }));
}
/** Optional bridge for DOM applications; owns only its supplied container. */
export function mountGitDiff(container: Element, props: GitDiffProps): { update(next: GitDiffProps): void; unmount(): void } {
  const root = createRoot(container);
  root.render(h(GitDiff, props));
  return { update(next) { root.render(h(GitDiff, next)); }, unmount() { root.unmount(); } };
}
export type { DiffSnapshot, DiffFile, DiffHunk, DiffLine, DiffLineAnchor } from "@slop-lab/git-diff";
