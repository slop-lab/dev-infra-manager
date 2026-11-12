import { createHash } from "node:crypto";
import type { RepositoryAccess, RepositoryReadService } from "@slop-lab/gs-repository-service";

type ReviewTree = { readonly objectId: string; readonly content: Buffer };
type TreeEntry = { readonly mode: string; readonly objectId: string };
type ReadTree = (objectId: string, maximumBytes: number) => Promise<Buffer>;

export async function readVerifiedReviewObject(input: {
  readonly reader: RepositoryReadService;
  readonly access: RepositoryAccess;
  readonly objectId: string;
  readonly type: "commit" | "tree" | "blob";
  readonly signal: AbortSignal;
  readonly maximumBytes: number;
}): Promise<Buffer> {
  const content = Buffer.from(await input.reader.readBytes({
    access: input.access,
    args: ["cat-file", input.type, input.objectId],
    signal: input.signal,
    maximumBytes: input.maximumBytes,
  }));
  const algorithm = input.objectId.length === 40 ? "sha1" : "sha256";
  const digest = createHash(algorithm)
    .update(`${input.type} ${content.length}\0`)
    .update(content)
    .digest("hex");
  if (digest !== input.objectId) {
    throw new AuthoritativeReviewGitError(`review ${input.type} content conflicts with its identity`);
  }
  return content;
}

export async function assertDifferingReviewTrees(input: {
  readonly left: ReviewTree;
  readonly right: ReviewTree;
  readonly maximumBytes: number;
  readonly readTree: ReadTree;
}): Promise<void> {
  const state = treeState(input.maximumBytes, input.readTree, [input.left, input.right]);
  await compareTrees(input.left, input.right, state, new Set());
}

export async function assertReviewPathTrees(input: {
  readonly root: ReviewTree;
  readonly path: Uint8Array;
  readonly maximumBytes: number;
  readonly readTree: ReadTree;
}): Promise<void> {
  const state = treeState(input.maximumBytes, input.readTree, [input.root]);
  const parts = splitPath(Buffer.from(input.path));
  let current = input.root;
  for (const part of parts.slice(0, -1)) {
    const entry = treeEntries(current).get(part.toString("base64"));
    if (entry === undefined || entry.mode !== "40000") {
      throw new AuthoritativeReviewGitError("review path conflicts with its selected tree");
    }
    current = { objectId: entry.objectId, content: await state.read(entry.objectId) };
  }
}

function treeState(maximumBytes: number, readTree: ReadTree, roots: readonly ReviewTree[]) {
  const cache = new Map(roots.map((tree) => [tree.objectId, tree.content]));
  const rootBytes = [...cache.values()].reduce((total, content) => total + content.length, 0);
  if (rootBytes > maximumBytes) throw new AuthoritativeReviewGitError("review selected trees exceed output limit");
  let remainingBytes = maximumBytes - rootBytes;
  return {
    async read(objectId: string): Promise<Buffer> {
      const cached = cache.get(objectId);
      if (cached !== undefined) return cached;
      if (remainingBytes <= 0) throw new AuthoritativeReviewGitError("review selected trees exceed output limit");
      const content = await readTree(objectId, remainingBytes);
      remainingBytes -= content.length;
      cache.set(objectId, content);
      return content;
    },
  };
}

async function compareTrees(
  left: ReviewTree,
  right: ReviewTree,
  state: ReturnType<typeof treeState>,
  visited: Set<string>,
): Promise<void> {
  const pair = `${left.objectId}:${right.objectId}`;
  if (visited.has(pair)) return;
  visited.add(pair);
  const leftEntries = treeEntries(left);
  const rightEntries = treeEntries(right);
  for (const name of new Set([...leftEntries.keys(), ...rightEntries.keys()])) {
    const leftEntry = leftEntries.get(name);
    const rightEntry = rightEntries.get(name);
    if (leftEntry?.mode === rightEntry?.mode && leftEntry?.objectId === rightEntry?.objectId) continue;
    const leftTree = leftEntry?.mode === "40000"
      ? { objectId: leftEntry.objectId, content: await state.read(leftEntry.objectId) }
      : undefined;
    const rightTree = rightEntry?.mode === "40000"
      ? { objectId: rightEntry.objectId, content: await state.read(rightEntry.objectId) }
      : undefined;
    if (leftTree !== undefined && rightTree !== undefined) {
      await compareTrees(leftTree, rightTree, state, visited);
    } else if (leftTree !== undefined) {
      await verifyTreeDescendants(leftTree, state, visited);
    } else if (rightTree !== undefined) {
      await verifyTreeDescendants(rightTree, state, visited);
    }
  }
}

async function verifyTreeDescendants(
  tree: ReviewTree,
  state: ReturnType<typeof treeState>,
  visited: Set<string>,
): Promise<void> {
  const key = `tree:${tree.objectId}`;
  if (visited.has(key)) return;
  visited.add(key);
  for (const entry of treeEntries(tree).values()) {
    if (entry.mode !== "40000") continue;
    const child = { objectId: entry.objectId, content: await state.read(entry.objectId) };
    await verifyTreeDescendants(child, state, visited);
  }
}

function treeEntries(tree: ReviewTree): ReadonlyMap<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>();
  const objectBytes = tree.objectId.length / 2;
  let offset = 0;
  while (offset < tree.content.length) {
    const space = tree.content.indexOf(32, offset);
    const nul = tree.content.indexOf(0, space + 1);
    const objectEnd = nul + 1 + objectBytes;
    if (space < 0 || nul < 0 || objectEnd > tree.content.length) {
      throw new AuthoritativeReviewGitError("review tree content is malformed");
    }
    const mode = tree.content.subarray(offset, space).toString("ascii");
    const name = tree.content.subarray(space + 1, nul).toString("base64");
    if (!/^(?:40000|100644|100755|120000|160000)$/.test(mode) || name.length === 0 || entries.has(name)) {
      throw new AuthoritativeReviewGitError("review tree entry is invalid");
    }
    entries.set(name, { mode, objectId: tree.content.subarray(nul + 1, objectEnd).toString("hex") });
    offset = objectEnd;
  }
  return entries;
}

function splitPath(path: Buffer): readonly Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (let index = 0; index <= path.length; index += 1) {
    if (index !== path.length && path[index] !== 47) continue;
    if (index === start) throw new AuthoritativeReviewGitError("review path is not normalized");
    parts.push(path.subarray(start, index));
    start = index + 1;
  }
  return parts;
}

export class AuthoritativeReviewGitError extends Error {
  readonly name = "AuthoritativeReviewGitError";
}
