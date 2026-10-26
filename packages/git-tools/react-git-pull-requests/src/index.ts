import { createElement as h, useState, useEffect, useRef, useMemo, type ReactNode, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { GitDiff, type DiffSnapshot, type DiffLineAnchor, type DiffLineContext } from "@slop-lab/react-git-diff";
import type { GitLineAttribution } from "@slop-lab/git-blame";
import { commentIsOutdated, type DiscussionAnchor, type DiscussionComment } from "@slop-lab/git-discussions";
import { currentRevision, type PullRequest } from "@slop-lab/git-pull-requests";

export interface PullRequestDraft { readonly title: string; readonly body: string; readonly sourceRef: string; readonly targetRef: string }
export interface CommentDraft { readonly revisionId: string; readonly body: string; readonly anchor?: DiscussionAnchor }
export interface DiffInspection { readonly baseCommit: string; readonly headCommit: string }
export interface BlameInspection { readonly commit: string; readonly path: string; readonly line: number }
type Action<T = void> = (input: T) => void | Promise<void>;
export interface PullRequestPanelProps {
  readonly pullRequests: readonly PullRequest[];
  readonly selected: PullRequest | null;
  readonly snapshot: DiffSnapshot | null;
  readonly className?: string;
  readonly onSelect?: Action<string>;
  readonly onCreate?: Action<PullRequestDraft>;
  readonly createDraft?: PullRequestDraft;
  readonly onCreateDraftChange?: (draft: PullRequestDraft) => void;
  readonly createScopeKey?: string;
  readonly createDisabled?: boolean;
  readonly targetRefs?: readonly string[];
  readonly onRefresh?: () => void | Promise<void>;
  readonly onEdit?: Action<Pick<PullRequestDraft, "title" | "body">>;
  readonly onSetState?: Action<"open" | "closed">;
  readonly onComment?: Action<CommentDraft>;
  readonly onPrepareReview?: () => void | Promise<void>;
  readonly onApprove?: () => void | Promise<void>;
  readonly onRevoke?: () => void | Promise<void>;
  readonly onMerge?: () => void | Promise<void>;
  readonly prepareReviewDisabled?: boolean;
  readonly approveDisabled?: boolean;
  readonly revokeDisabled?: boolean;
  readonly mergeDisabled?: boolean;
  readonly reviewStatus?: string;
  readonly reviewContent?: ReactNode;
  readonly onBlame?: (anchor: DiffLineAnchor) => Promise<GitLineAttribution>;
  readonly onInspectDiff?: (input: DiffInspection) => Promise<DiffSnapshot>;
  readonly onInspectBlame?: (input: BlameInspection) => Promise<GitLineAttribution>;
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
function CreateForm({ action, draft, onChange, targetRefs, disabled = false, expanded }: { readonly action: NonNullable<PullRequestPanelProps["onCreate"]>; readonly draft?: PullRequestDraft; readonly onChange?: (draft: PullRequestDraft) => void; readonly targetRefs?: readonly string[]; readonly disabled?: boolean; readonly expanded: boolean }): ReactNode {
  const [local, setLocal] = useState<PullRequestDraft>({ title: "", body: "", sourceRef: "", targetRef: "" });
  const value = draft ?? local;
  const change = (patch: Partial<PullRequestDraft>) => { const next = { ...value, ...patch }; if (draft === undefined) setLocal(next); onChange?.(next); };
  const state = useAction();
  const pending = state.pending || disabled;
  return h("details", { open: expanded }, h("summary", null, "Create pull request"),
    h("p", null, "Choose the branch to merge, then inspect changes, CI and required approvals before merging."),
    h("form", { onSubmit: (event: FormEvent) => { event.preventDefault(); if (pending) return; void state.run(async () => {
      await action(value); if (draft === undefined) setLocal({ title: "", body: "", sourceRef: "", targetRef: value.targetRef });
    }); } },
    inputField("Source branch", value.sourceRef, sourceRef => change({ sourceRef }), false, true, pending),
    h("p", { className: "git-pr__hint" }, "Enter an existing pushed branch, for example development-tmp or feature/my-change. Full refs are also accepted."),
    targetRefs?.length ? h("label", { className: "git-pr__field" }, "Target branch", h("select", { "aria-label": "Target branch", className: "git-pr__input", value: value.targetRef, disabled: pending, required: true,
      onChange: (event: { currentTarget: { value: string } }) => change({ targetRef: event.currentTarget.value }) }, targetRefs.map(ref => h("option", { key: ref, value: ref }, ref.replace(/^refs\/heads\//, "")))))
      : inputField("Target branch", value.targetRef, targetRef => change({ targetRef }), false, true, pending),
    inputField("Pull request title", value.title, title => change({ title }), false, true, pending), inputField("Pull request description", value.body, body => change({ body }), true, false, pending),
    h("button", { type: "submit", disabled: pending }, "Create pull request"), state.feedback));
}
function Comment({ comment, outdated }: { readonly comment: DiscussionComment; readonly outdated: boolean }): ReactNode {
  return h("article", { "aria-label": `Comment by ${comment.actorId}`, className: "git-pr__comment" },
    h("strong", null, comment.actorId), " · ", h("time", { dateTime: comment.createdAt }, comment.createdAt), outdated ? h("span", null, " · Outdated revision") : null,
    comment.anchor ? h("p", null, `${comment.anchor.path} · ${comment.anchor.side} line ${comment.anchor.line}`) : null,
    h("p", { className: "git-pr__text" }, comment.body));
}
function DirectInspection(props: Pick<PullRequestPanelProps, "onInspectDiff" | "onInspectBlame">): ReactNode {
  const state = useAction();
  const [baseCommit, setBaseCommit] = useState(""), [headCommit, setHeadCommit] = useState("");
  const [commit, setCommit] = useState(""), [path, setPath] = useState(""), [line, setLine] = useState("1");
  const [snapshot, setSnapshot] = useState<DiffSnapshot | null>(null), [blame, setBlame] = useState<GitLineAttribution | null>(null);
  if (!props.onInspectDiff && !props.onInspectBlame) return null;
  return h("details", { className: "git-pr__inspection" }, h("summary", null, "Inspect commits"),
    props.onInspectDiff ? h("form", { "aria-label": "Inspect Git diff", onSubmit: (event: FormEvent) => { event.preventDefault(); void state.run(async () => {
      const result = await props.onInspectDiff?.({ baseCommit: baseCommit.trim(), headCommit: headCommit.trim() });
      if (result) setSnapshot(result);
    }); } }, inputField("Base commit", baseCommit, setBaseCommit, false, true, state.pending), inputField("Head commit", headCommit, setHeadCommit, false, true, state.pending),
    h("button", { type: "submit", disabled: state.pending }, "Inspect diff")) : null,
    snapshot ? h(GitDiff, { snapshot }) : null,
    props.onInspectBlame ? h("form", { "aria-label": "Inspect Git blame", onSubmit: (event: FormEvent) => { event.preventDefault(); void state.run(async () => {
      const result = await props.onInspectBlame?.({ commit: commit.trim(), path: path.trim(), line: Number(line) });
      if (result) setBlame(result);
    }); } }, inputField("Blame commit", commit, setCommit, false, true, state.pending), inputField("File path", path, setPath, false, true, state.pending),
    inputField("Line number", line, setLine, false, true, state.pending), h("button", { type: "submit", disabled: state.pending }, "Inspect blame")) : null,
    blame ? h("p", { role: "status" }, `${blame.author} · ${blame.commit} · ${blame.summary}`) : null,
    state.feedback);
}
function anchorKey(anchor: DiscussionAnchor): string { return JSON.stringify([anchor.path, anchor.side, anchor.line]); }
function Detail(props: PullRequestPanelProps & { readonly selected: PullRequest }): ReactNode {
  const pr = props.selected, revision = currentRevision(pr), state = useAction();
  const [title, setTitle] = useState(pr.title), [body, setBody] = useState(pr.body), [comment, setComment] = useState("");
  const [anchor, setAnchor] = useState<DiscussionAnchor | null>(null), [blames, setBlames] = useState<Record<string, GitLineAttribution>>({});
  useEffect(() => { setTitle(pr.title); setBody(pr.body); }, [pr.title, pr.body]);
  const snapshot = props.snapshot?.baseCommit === revision.targetCommit && props.snapshot.headCommit === revision.sourceCommit ? props.snapshot : null;
  const commentsByAnchor = useMemo(() => {
    const index = new Map<string, DiscussionComment[]>();
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
    const blame = anchors.map(item => blames[anchorKey(item)]).filter((item): item is GitLineAttribution => !!item);
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
      pr.state === "open" ? actionButton("Prepare review", props.onPrepareReview, props.prepareReviewDisabled) : null,
      pr.state === "open" ? actionButton("Approve revision", props.onApprove, props.approveDisabled) : null,
      pr.state === "open" ? actionButton("Revoke approval", props.onRevoke, props.revokeDisabled) : null,
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
    h("h4", null, "Discussion"), pr.comments.filter(item => !item.anchor || commentIsOutdated(item, revision.id) || !snapshot).map(item => h(Comment, { key: item.id, comment: item, outdated: commentIsOutdated(item, revision.id) })),
    props.onComment ? h("form", { "aria-label": "Add comment", onSubmit: (event: FormEvent) => { event.preventDefault(); void state.run(async () => {
      await props.onComment!({ revisionId: revision.id, body: comment, ...(anchor ? { anchor } : {}) }); setComment(""); setAnchor(null);
    }); } }, anchor ? h("p", null, `Comment on ${anchor.path} · ${anchor.side} line ${anchor.line} `, h("button", { type: "button", disabled: state.pending, onClick: () => setAnchor(null) }, "Use general comment")) : null,
      inputField("Comment", comment, setComment, true, true, state.pending), h("button", { type: "submit", disabled: state.pending || !comment.trim() }, "Post comment")) : null);
}
export function PullRequestPanel(props: PullRequestPanelProps): ReactNode {
  const state = useAction();
  const inspectionProps: Pick<PullRequestPanelProps, "onInspectDiff" | "onInspectBlame"> = {
    ...(props.onInspectDiff ? { onInspectDiff: props.onInspectDiff } : {}),
    ...(props.onInspectBlame ? { onInspectBlame: props.onInspectBlame } : {})
  };
  return h("div", { className: ["git-pr", props.className].filter(Boolean).join(" "), "data-git-pull-requests": "" }, props.onCreate ? h(CreateForm, { action: props.onCreate, expanded: props.selected === null, key: props.createScopeKey, ...(props.createDisabled === undefined ? {} : { disabled: props.createDisabled }), ...(props.createDraft ? { draft: props.createDraft } : {}), ...(props.onCreateDraftChange ? { onChange: props.onCreateDraftChange } : {}), ...(props.targetRefs ? { targetRefs: props.targetRefs } : {}) }) : null,
    h(DirectInspection, inspectionProps),
    !props.selected && props.onRefresh ? h("button", { type: "button", disabled: state.pending, onClick: () => { void state.run(props.onRefresh!); } }, "Refresh pull requests") : null, state.feedback,
    h("nav", { "aria-label": "Pull requests" }, props.pullRequests.length ? h("ul", null, props.pullRequests.map(pr => h("li", { key: pr.id },
      props.onSelect ? h("button", { type: "button", disabled: state.pending, "aria-current": props.selected?.id === pr.id ? "page" : undefined, onClick: () => { void state.run(() => props.onSelect!(pr.id)); } }, `${pr.title} · ${pr.state}`) : h("span", null, `${pr.title} · ${pr.state}`)))) : h("p", null, "No pull requests.")),
    props.selected ? h(Detail, { ...props, selected: props.selected, key: JSON.stringify([props.selected.id, currentRevision(props.selected).id]) }) : h("p", null, "Select a pull request to view changes and discussion."));
}
export function mountPullRequestPanel(container: Element, props: PullRequestPanelProps): { update(next: PullRequestPanelProps): void; unmount(): void } {
  const root = createRoot(container); root.render(h(PullRequestPanel, props));
  return { update(next) { root.render(h(PullRequestPanel, next)); }, unmount() { root.unmount(); } };
}
