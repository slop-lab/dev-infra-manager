import { createElement as h, useState, useEffect, useRef, useMemo, type ReactNode, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { GitDiff, type DiffSnapshot, type DiffLineAnchor, type DiffLineContext } from "@slop-lab/react-git-diff";
import { currentRevision, commentIsOutdated, type PullRequest, type PullRequestComment, type DiffAnchor } from "@slop-lab/git-pull-requests";

export interface PullRequestDraft { readonly title: string; readonly body: string; readonly sourceRef: string; readonly targetRef: string }
export interface CommentDraft { readonly revisionId: string; readonly body: string; readonly anchor?: DiffAnchor }
export interface BlameResult { readonly author: string; readonly summary: string; readonly commit: string }
type Action<T = void> = (input: T) => void | Promise<void>;
export interface PullRequestPanelProps {
  readonly pullRequests: readonly PullRequest[];
  readonly selected: PullRequest | null;
  readonly snapshot: DiffSnapshot | null;
  readonly className?: string;
  readonly onSelect?: Action<string>;
  readonly onCreate?: Action<PullRequestDraft>;
  readonly onRefresh?: () => void | Promise<void>;
  readonly onEdit?: Action<Pick<PullRequestDraft, "title" | "body">>;
  readonly onSetState?: Action<"open" | "closed">;
  readonly onComment?: Action<CommentDraft>;
  readonly onApprove?: () => void | Promise<void>;
  readonly onMerge?: () => void | Promise<void>;
  readonly approveDisabled?: boolean;
  readonly mergeDisabled?: boolean;
  readonly reviewStatus?: string;
  readonly reviewContent?: ReactNode;
  readonly onBlame?: (anchor: DiffLineAnchor) => Promise<BlameResult>;
}
function useAction() {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false), [message, setMessage] = useState("");
  async function run(action: () => void | Promise<void>): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true; setPending(true); setMessage("");
    try { await action(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "The operation failed. Refresh before retrying."); }
    finally { inFlight.current = false; setPending(false); }
  }
  return { pending, run, feedback: message ? h("p", { role: "alert" }, message) : pending ? h("p", { role: "status" }, "Working…") : null };
}
function inputField(label: string, value: string, set: (value: string) => void, multiline = false, required = true, disabled = false): ReactNode {
  return h("label", { className: "git-pr__field" }, label,
    h(multiline ? "textarea" : "input", { "aria-label": label, value, required, disabled, maxLength: label.includes("title") ? 240 : 3000,
      className: "git-pr__input", onChange: (event: { currentTarget: { value: string } }) => set(event.currentTarget.value) }));
}
function CreateForm({ action }: { readonly action: NonNullable<PullRequestPanelProps["onCreate"]> }): ReactNode {
  const [title, setTitle] = useState(""), [body, setBody] = useState(""), [sourceRef, setSource] = useState(""), [targetRef, setTarget] = useState("main");
  const state = useAction();
  return h("details", null, h("summary", null, "Create pull request"), h("form", { onSubmit: (event: FormEvent) => { event.preventDefault(); void state.run(async () => {
    await action({ title, body, sourceRef, targetRef }); setTitle(""); setBody(""); setSource("");
  }); } }, inputField("Pull request title", title, setTitle, false, true, state.pending), inputField("Pull request description", body, setBody, true, false, state.pending),
  inputField("Source ref", sourceRef, setSource, false, true, state.pending), inputField("Target ref", targetRef, setTarget, false, true, state.pending), h("button", { type: "submit", disabled: state.pending }, "Create pull request"), state.feedback));
}
function Comment({ comment, outdated }: { readonly comment: PullRequestComment; readonly outdated: boolean }): ReactNode {
  return h("article", { "aria-label": `Comment by ${comment.actorId}`, className: "git-pr__comment" },
    h("strong", null, comment.actorId), " · ", h("time", { dateTime: comment.createdAt }, comment.createdAt), outdated ? h("span", null, " · Outdated revision") : null,
    comment.anchor ? h("p", null, `${comment.anchor.path} · ${comment.anchor.side} line ${comment.anchor.line}`) : null,
    h("p", { className: "git-pr__text" }, comment.body));
}
function anchorKey(anchor: DiffAnchor): string { return JSON.stringify([anchor.path, anchor.side, anchor.line]); }
function Detail(props: PullRequestPanelProps & { readonly selected: PullRequest }): ReactNode {
  const pr = props.selected, revision = currentRevision(pr), state = useAction();
  const [title, setTitle] = useState(pr.title), [body, setBody] = useState(pr.body), [comment, setComment] = useState("");
  const [anchor, setAnchor] = useState<DiffAnchor | null>(null), [blames, setBlames] = useState<Record<string, BlameResult>>({});
  useEffect(() => { setTitle(pr.title); setBody(pr.body); }, [pr.title, pr.body]);
  const snapshot = props.snapshot?.baseCommit === revision.targetCommit && props.snapshot.headCommit === revision.sourceCommit ? props.snapshot : null;
  const commentsByAnchor = useMemo(() => {
    const index = new Map<string, PullRequestComment[]>();
    for (const item of pr.comments) {
      if (item.revisionId !== revision.id || !item.anchor) continue;
      const key = anchorKey(item.anchor), existing = index.get(key);
      if (existing) existing.push(item); else index.set(key, [item]);
    }
    return index;
  }, [pr.comments, revision.id]);
  function actionButton(label: string, action: (() => void | Promise<void>) | undefined, disabled = false): ReactNode {
    return action ? h("button", { type: "button", disabled: state.pending || disabled, onClick: () => { void state.run(action); } }, label) : null;
  }
  function threads(context: DiffLineContext): ReactNode {
    const anchors = [context.baseAnchor, context.headAnchor].filter((value): value is DiffLineAnchor => value !== null);
    const comments = anchors.flatMap(candidate => commentsByAnchor.get(anchorKey(candidate)) ?? []);
    const blame = anchors.map(item => blames[anchorKey(item)]).filter((item): item is BlameResult => !!item);
    if (!comments.length && !blame.length) return null;
    return h("div", null, comments.map(item => h(Comment, { key: item.id, comment: item, outdated: false })), blame.map((item, index) => h("p", { key: index }, `${item.author} · ${item.commit} · ${item.summary}`)));
  }
  return h("section", { "aria-label": "Pull request details" }, h("h3", null, pr.title),
    h("p", null, `${pr.state} · ${pr.sourceRef} → ${pr.targetRef}`),
    h("p", null, `Revision ${pr.revisions.length} · ${revision.targetCommit.slice(0, 12)} → ${revision.sourceCommit.slice(0, 12)}`), h("p", { className: "git-pr__text" }, pr.body),
    props.onEdit && pr.state !== "merged" ? h("details", null, h("summary", null, "Edit pull request"), h("form", { onSubmit: (event: FormEvent) => { event.preventDefault(); void state.run(() => props.onEdit!({ title, body })); } },
      inputField("Edit title", title, setTitle, false, true, state.pending), inputField("Edit description", body, setBody, true, false, state.pending), h("button", { type: "submit", disabled: state.pending }, "Save changes"))) : null,
    h("div", { role: "group", "aria-label": "Pull request actions" },
      actionButton("Refresh pull request", props.onRefresh),
      pr.state !== "merged" && props.onSetState ? actionButton(pr.state === "open" ? "Close pull request" : "Reopen pull request", () => props.onSetState!(pr.state === "open" ? "closed" : "open")) : null,
      pr.state === "open" ? actionButton("Approve revision", props.onApprove, props.approveDisabled) : null,
      pr.state === "open" ? actionButton("Merge pull request", props.onMerge, props.mergeDisabled) : null),
    props.reviewStatus ? h("p", { role: "status" }, props.reviewStatus) : null, props.reviewContent, state.feedback,
    h("h4", null, "Changes"), snapshot ? h(GitDiff, { snapshot,
      ...(props.onComment && !state.pending ? { onSelectLine: (selected: DiffLineAnchor) => { setAnchor({ path: selected.path, side: selected.side, line: selected.line }); } } : {}),
      renderBelowLine: threads,
      ...(props.onBlame ? { renderLineGutter: (context: DiffLineContext) => {
        const selected = context.headAnchor ?? context.baseAnchor;
        return selected ? h("button", { type: "button", disabled: state.pending, "aria-label": `Blame ${selected.side} line ${selected.line} of ${selected.path}`,
          onClick: () => { void state.run(async () => { const result = await props.onBlame!(selected); setBlames(previous => ({ ...previous, [anchorKey(selected)]: result })); }); } }, "Blame") : null;
      } } : {})
    }) : h("p", null, "Diff unavailable for this revision. Refresh to load its exact commits."),
    h("h4", null, "Discussion"), pr.comments.filter(item => !item.anchor || commentIsOutdated(pr, item) || !snapshot).map(item => h(Comment, { key: item.id, comment: item, outdated: commentIsOutdated(pr, item) })),
    props.onComment ? h("form", { "aria-label": "Add comment", onSubmit: (event: FormEvent) => { event.preventDefault(); void state.run(async () => {
      await props.onComment!({ revisionId: revision.id, body: comment, ...(anchor ? { anchor } : {}) }); setComment(""); setAnchor(null);
    }); } }, anchor ? h("p", null, `Comment on ${anchor.path} · ${anchor.side} line ${anchor.line} `, h("button", { type: "button", disabled: state.pending, onClick: () => setAnchor(null) }, "Use general comment")) : null,
      inputField("Comment", comment, setComment, true, true, state.pending), h("button", { type: "submit", disabled: state.pending || !comment.trim() }, "Post comment")) : null);
}
export function PullRequestPanel(props: PullRequestPanelProps): ReactNode {
  const state = useAction();
  return h("div", { className: ["git-pr", props.className].filter(Boolean).join(" "), "data-git-pull-requests": "" }, props.onCreate ? h(CreateForm, { action: props.onCreate }) : null,
    !props.selected && props.onRefresh ? h("button", { type: "button", disabled: state.pending, onClick: () => { void state.run(props.onRefresh!); } }, "Refresh pull requests") : null, state.feedback,
    h("nav", { "aria-label": "Pull requests" }, props.pullRequests.length ? h("ul", null, props.pullRequests.map(pr => h("li", { key: pr.id },
      props.onSelect ? h("button", { type: "button", disabled: state.pending, "aria-current": props.selected?.id === pr.id ? "page" : undefined, onClick: () => { void state.run(() => props.onSelect!(pr.id)); } }, `${pr.title} · ${pr.state}`) : h("span", null, `${pr.title} · ${pr.state}`)))) : h("p", null, "No pull requests.")),
    props.selected ? h(Detail, { ...props, selected: props.selected, key: JSON.stringify([props.selected.id, currentRevision(props.selected).id]) }) : h("p", null, "Select a pull request to view changes and discussion."));
}
export function mountPullRequestPanel(container: Element, props: PullRequestPanelProps): { update(next: PullRequestPanelProps): void; unmount(): void } {
  const root = createRoot(container); root.render(h(PullRequestPanel, props));
  return { update(next) { root.render(h(PullRequestPanel, next)); }, unmount() { root.unmount(); } };
}
