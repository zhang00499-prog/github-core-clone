// The forge's data model: repositories with their git objects, refs, issues, pull requests,
// comments and labels, all in memory. Deterministic timestamps (a logical clock) keep object ids
// stable across identical operation sequences.

import {
  buildCommit,
  buildTree,
  objectId,
  parseCommit,
  parseTree,
  peelToCommit,
  storeObject,
  type GitObject,
  type ObjectMap,
  type TreeEntry,
} from './gitcore.ts';

export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  type: 'User',
} as const;

let logicalTick = 0;
/** The next deterministic timestamp: whole seconds, strictly increasing per call. */
export function nextTimestamp(): number {
  logicalTick += 1;
  return 1_760_000_000 + logicalTick * 61;
}

export function isoOf(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

export function authorLine(seconds: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${seconds} +0000`;
}

export interface CommentRecord {
  id: number;
  body: string;
  createdAt: number;
}

export interface IssueRecord {
  kind: 'issue';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRecord[];
  createdAt: number;
  updatedAt: number;
}

export interface PullRecord {
  kind: 'pull';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: number | null;
  mergeCommitSha: string | null;
  comments: CommentRecord[];
  createdAt: number;
  updatedAt: number;
}

export interface LabelRecord {
  id: number;
  name: string;
  color: string;
  description: string;
}

export class Repo {
  readonly id: number;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch = 'main';
  readonly createdAt: number;
  updatedAt: number;
  readonly objects: ObjectMap = new Map();
  readonly refs = new Map<string, string>();
  readonly issues = new Map<number, IssueRecord>();
  readonly pulls = new Map<number, PullRecord>();
  readonly labels = new Map<string, LabelRecord>();
  private nextNumber = 1;
  private nextRecordId: number;
  private nextCommentId = 1;
  private nextLabelId = 1;

  constructor(id: number, name: string, description: string, isPrivate: boolean) {
    this.id = id;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    const now = nextTimestamp();
    this.createdAt = now;
    this.updatedAt = now;
    this.nextRecordId = id * 100000 + 1;
  }

  get fullName(): string {
    return `${VIEWER.login}/${this.name}`;
  }

  allocateNumber(): number {
    const n = this.nextNumber;
    this.nextNumber += 1;
    return n;
  }

  allocateRecordId(): number {
    const id = this.nextRecordId;
    this.nextRecordId += 1;
    return id;
  }

  allocateCommentId(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }

  addLabel(name: string, color: string, description: string): LabelRecord {
    const record: LabelRecord = { id: this.nextLabelId, name, color, description };
    this.nextLabelId += 1;
    this.labels.set(name, record);
    return record;
  }

  refTip(ref: string): string | null {
    return this.refs.get(ref) ?? null;
  }

  branchTip(branch: string): string | null {
    return this.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** Resolve a branch name, a full ref, HEAD, or a raw object id to a commit id. */
  resolveCommit(ref: string): string | null {
    if (ref === 'HEAD') {
      const tip = this.branchTip(this.defaultBranch);
      return tip;
    }
    const byBranch = this.branchTip(ref);
    if (byBranch !== null) return peelToCommit(this.objects, byBranch);
    const byRef = this.refs.get(ref);
    if (byRef !== undefined) return peelToCommit(this.objects, byRef);
    const obj = this.objects.get(ref);
    if (obj !== undefined) return peelToCommit(this.objects, ref);
    return null;
  }

  /** Store a commit object authored by the viewer at the next logical time. */
  writeCommit(tree: string, parents: string[], message: string): string {
    const line = authorLine(nextTimestamp());
    const data = buildCommit(tree, parents, line, line, message);
    return storeObject(this.objects, 'commit', data);
  }

  commitInfo(sha: string) {
    const obj = this.objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') return null;
    return parseCommit(obj.data);
  }

  /** Flatten a tree (recursively) into path -> {sha, mode}. */
  flattenTree(treeSha: string, prefix = '', out = new Map<string, { sha: string; mode: string }>()): Map<string, { sha: string; mode: string }> {
    const obj = this.objects.get(treeSha);
    if (obj === undefined || obj.type !== 'tree') return out;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.flattenTree(entry.sha, path, out);
      else out.set(path, { sha: entry.sha, mode: entry.mode });
    }
    return out;
  }

  /** Rebuild (and store) a tree hierarchy from a flattened path map; answers the root tree id. */
  buildTreeFromFlat(flat: Map<string, { sha: string; mode: string }>): string {
    interface Node { files: Array<{ name: string; sha: string; mode: string }>; dirs: Map<string, Node> }
    const root: Node = { files: [], dirs: new Map() };
    for (const [path, entry] of flat) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const part = parts[i] as string;
        let child = node.dirs.get(part);
        if (child === undefined) {
          child = { files: [], dirs: new Map() };
          node.dirs.set(part, child);
        }
        node = child;
      }
      node.files.push({ name: parts[parts.length - 1] as string, sha: entry.sha, mode: entry.mode });
    }
    const emit = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const file of node.files) entries.push({ mode: file.mode, name: file.name, sha: file.sha });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, sha: emit(child) });
      return storeObject(this.objects, 'tree', buildTree(entries));
    };
    return emit(root);
  }

  /** The tree of a commit, or the empty tree id for null. */
  treeOf(commitSha: string | null): string {
    if (commitSha === null) return storeObject(this.objects, 'tree', Buffer.alloc(0));
    const info = this.commitInfo(commitSha);
    return info === null ? storeObject(this.objects, 'tree', Buffer.alloc(0)) : info.tree;
  }

  /** All ancestors of a commit (including itself), via every parent edge. */
  ancestorsOf(sha: string): Set<string> {
    const seen = new Set<string>();
    const queue = [sha];
    while (queue.length > 0) {
      const current = queue.pop() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      const info = this.commitInfo(current);
      if (info !== null) queue.push(...info.parents);
    }
    return seen;
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    return this.ancestorsOf(descendant).has(ancestor);
  }

  /** A merge base of two commits: a common ancestor that is not an ancestor of another common one. */
  mergeBase(a: string, b: string): string | null {
    const ancestorsA = this.ancestorsOf(a);
    const queue = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      if (ancestorsA.has(current)) return current;
      const info = this.commitInfo(current);
      if (info !== null) queue.push(...info.parents);
    }
    return null;
  }

  /** Commits reachable from `tip`, newest first (committer time, then discovery order). */
  listCommits(tip: string, limit: number): string[] {
    const all = [...this.ancestorsOf(tip)];
    all.sort((x, y) => {
      const tx = this.commitInfo(x)?.committerTime ?? 0;
      const ty = this.commitInfo(y)?.committerTime ?? 0;
      return ty - tx;
    });
    return all.slice(0, limit);
  }
}

export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const repo = new Repo(this.nextRepoId, name, description, isPrivate);
    this.nextRepoId += 1;
    this.repos.set(name, repo);
    return repo;
  }

  /** Repositories belong to the viewer alone: any other owner reads as not found. */
  getRepo(owner: string, name: string): Repo | null {
    if (owner !== VIEWER.login) return null;
    return this.repos.get(name) ?? null;
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER.login) return false;
    return this.repos.delete(name);
  }

  renameRepo(repo: Repo, newName: string): void {
    this.repos.delete(repo.name);
    repo.name = newName;
    this.repos.set(newName, repo);
  }
}

// ------------------------------------------------------------------------------------------------
// Merging and diffing.
// ------------------------------------------------------------------------------------------------

export type FlatTree = Map<string, { sha: string; mode: string }>;

export interface MergeOutcome {
  ok: boolean;
  tree: FlatTree;
  conflicts: string[];
}

/** Three-way merge of flattened trees; per path, a side that alone changed wins, else conflict. */
export function mergeFlatTrees(base: FlatTree, ours: FlatTree, theirs: FlatTree): MergeOutcome {
  const result: FlatTree = new Map();
  const conflicts: string[] = [];
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path)?.sha ?? null;
    const o = ours.get(path)?.sha ?? null;
    const t = theirs.get(path)?.sha ?? null;
    let winner: { sha: string; mode: string } | undefined;
    if (o === t) winner = ours.get(path) ?? theirs.get(path);
    else if (b === o) winner = theirs.get(path);
    else if (b === t) winner = ours.get(path);
    else {
      conflicts.push(path);
      continue;
    }
    if (winner !== undefined) result.set(path, winner);
  }
  return { ok: conflicts.length === 0, tree: result, conflicts };
}

export interface FileDiff {
  filename: string;
  status: 'added' | 'deleted' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** Line counts of a minimal line diff (LCS dynamic program; inputs here are small text files). */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  if (oldText === newText) return { additions: 0, deletions: 0 };
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  // Guard the quadratic table: for very large files fall back to a whole-file estimate.
  if (oldLines.length * newLines.length > 4_000_000) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  const dp: number[] = new Array(newLines.length + 1).fill(0);
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    let diagonal = 0;
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      const saved = dp[j] ?? 0;
      dp[j] = oldLines[i] === newLines[j] ? diagonal + 1 : Math.max(dp[j] ?? 0, dp[j + 1] ?? 0);
      diagonal = saved;
    }
  }
  const lcs = dp[0] ?? 0;
  return { additions: newLines.length - lcs, deletions: oldLines.length - lcs };
}

/** The changed files between two flattened trees, with line-diff counts read from the object map. */
export function diffFlatTrees(objects: ObjectMap, from: FlatTree, to: FlatTree): FileDiff[] {
  const diffs: FileDiff[] = [];
  const paths = new Set<string>([...from.keys(), ...to.keys()]);
  const textOf = (sha: string | undefined): string => {
    if (sha === undefined) return '';
    const obj = objects.get(sha);
    return obj === undefined ? '' : obj.data.toString('utf8');
  };
  for (const path of [...paths].sort()) {
    const before = from.get(path);
    const after = to.get(path);
    if (before?.sha === after?.sha) continue;
    const counts = lineDiffCounts(textOf(before?.sha), textOf(after?.sha));
    diffs.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'deleted' : 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    });
  }
  return diffs;
}

/**
 * Merge a pull request into its base branch. Answers the new commit id, or null on conflict.
 * 'squash' makes one single-parent commit; 'merge' makes a two-parent merge commit.
 */
export function mergePull(repo: Repo, pull: PullRecord, method: 'squash' | 'merge'): string | null {
  const baseTip = repo.branchTip(pull.baseRef);
  const headTip = repo.branchTip(pull.headRef);
  if (baseTip === null || headTip === null) return null;
  const baseCommit = repo.resolveCommit(pull.baseRef);
  const headCommit = repo.resolveCommit(pull.headRef);
  if (baseCommit === null || headCommit === null) return null;
  const mergeBase = repo.mergeBase(baseCommit, headCommit);
  const baseTree = repo.flattenTree(repo.treeOf(mergeBase));
  const oursTree = repo.flattenTree(repo.treeOf(baseCommit));
  const theirsTree = repo.flattenTree(repo.treeOf(headCommit));
  const outcome = mergeFlatTrees(baseTree, oursTree, theirsTree);
  if (!outcome.ok) return null;
  const treeSha = repo.buildTreeFromFlat(outcome.tree);
  const parents = method === 'merge' ? [baseCommit, headCommit] : [baseCommit];
  const message = method === 'merge'
    ? `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`
    : `${pull.title} (#${pull.number})\n${pull.body ? `\n${pull.body}\n` : ''}`;
  const sha = repo.writeCommit(treeSha, parents, message);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  return sha;
}

/** Whether a pull request would merge cleanly right now. */
export function pullMergeable(repo: Repo, pull: PullRecord): boolean {
  if (pull.merged) return true;
  const baseCommit = repo.resolveCommit(pull.baseRef);
  const headCommit = repo.resolveCommit(pull.headRef);
  if (baseCommit === null || headCommit === null) return false;
  const mergeBase = repo.mergeBase(baseCommit, headCommit);
  const outcome = mergeFlatTrees(
    repo.flattenTree(repo.treeOf(mergeBase)),
    repo.flattenTree(repo.treeOf(baseCommit)),
    repo.flattenTree(repo.treeOf(headCommit)),
  );
  return outcome.ok;
}

/** The files a pull request changes: merge-base tree versus head tree. */
export function pullFiles(repo: Repo, pull: PullRecord): FileDiff[] {
  const baseCommit = repo.resolveCommit(pull.baseRef);
  const headCommit = repo.resolveCommit(pull.headRef);
  if (headCommit === null) return [];
  const mergeBase = baseCommit === null ? null : repo.mergeBase(baseCommit, headCommit);
  const from = repo.flattenTree(repo.treeOf(mergeBase));
  const to = repo.flattenTree(repo.treeOf(headCommit));
  return diffFlatTrees(repo.objects, from, to);
}

export { objectId };
export type { GitObject };
