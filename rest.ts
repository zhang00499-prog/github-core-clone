// The REST v3 surface: repositories, contents, git refs, commits, labels, issues, comments and
// pull requests, shaped the way api.github.com shapes them. Handlers are pure functions of a
// request context; app.ts owns auth, body parsing and the request-id header.

import { isoOf, mergePull, nextTimestamp, pullFiles, pullMergeable, VIEWER, type Forge, type IssueRecord, type PullRecord, type Repo } from './store.ts';
import { parseTree as parseTreeImpl, storeObject, ZERO_OID } from './gitcore.ts';

export interface RestContext {
  forge: Forge;
  method: string;
  /** Path segments after /api/v3, percent-decoded. */
  segments: string[];
  query: URLSearchParams;
  body: Record<string, unknown> | null;
  /** The request's own origin (scheme://host), for absolute Link headers. */
  origin: string;
  path: string;
}

export interface RestResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const notFound = (): RestResult => ({ status: 404, body: { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' } });
const validationFailed = (message: string): RestResult => ({ status: 422, body: { message, documentation_url: 'https://docs.github.com/rest' } });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(body: Record<string, unknown> | null, key: string): string | null {
  const value = body?.[key];
  return typeof value === 'string' ? value : null;
}

export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: `U_${Buffer.from(`User:${VIEWER.id}`).toString('base64url')}`,
    avatar_url: '',
    gravatar_id: '',
    type: VIEWER.type,
    site_admin: false,
    name: VIEWER.name,
    email: VIEWER.email,
    html_url: `https://forge.local/${VIEWER.login}`,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${Buffer.from(`Repository:${repo.id}`).toString('base64url')}`,
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(),
    private: repo.isPrivate,
    html_url: `https://forge.local/${repo.fullName}`,
    description: repo.description,
    fork: false,
    created_at: isoOf(repo.createdAt),
    updated_at: isoOf(repo.updatedAt),
    pushed_at: isoOf(repo.updatedAt),
    clone_url: `https://forge.local/${repo.fullName}.git`,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    language: null,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> | null {
  const label = repo.labels.get(name);
  if (label === undefined) return null;
  return { id: label.id, node_id: `L_${label.id}`, name: label.name, color: label.color, description: label.description, default: false, url: '' };
}

export function issueJson(repo: Repo, issue: IssueRecord): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${Buffer.from(`Issue:${issue.id}`).toString('base64url')}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)).filter((entry) => entry !== null),
    user: userJson(),
    author: userJson(),
    comments: issue.comments.length,
    created_at: isoOf(issue.createdAt),
    updated_at: isoOf(issue.updatedAt),
    closed_at: issue.state === 'closed' ? isoOf(issue.updatedAt) : null,
    html_url: `https://forge.local/${repo.fullName}/issues/${issue.number}`,
  };
}

export function pullJson(repo: Repo, pull: PullRecord): Record<string, unknown> {
  const headSha = repo.branchTip(pull.headRef);
  const baseSha = repo.branchTip(pull.baseRef);
  return {
    id: pull.id,
    node_id: `PR_${Buffer.from(`PullRequest:${pull.id}`).toString('base64url')}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    draft: false,
    user: userJson(),
    author: userJson(),
    head: {
      ref: pull.headRef,
      sha: headSha ?? ZERO_OID,
      label: `${VIEWER.login}:${pull.headRef}`,
      user: userJson(),
      repo: repoJson(repo),
    },
    base: {
      ref: pull.baseRef,
      sha: baseSha ?? ZERO_OID,
      label: `${VIEWER.login}:${pull.baseRef}`,
      user: userJson(),
      repo: repoJson(repo),
    },
    merged: pull.merged,
    merged_at: pull.mergedAt === null ? null : isoOf(pull.mergedAt),
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? pullMergeable(repo, pull) : null,
    mergeable_state: pull.merged ? 'clean' : pull.state === 'open' ? (pullMergeable(repo, pull) ? 'clean' : 'dirty') : 'unknown',
    comments: pull.comments.length,
    commits: 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    created_at: isoOf(pull.createdAt),
    updated_at: isoOf(pull.updatedAt),
    closed_at: pull.state === 'closed' ? isoOf(pull.updatedAt) : null,
    html_url: `https://forge.local/${repo.fullName}/pull/${pull.number}`,
  };
}

function commentJson(comment: { id: number; body: string; createdAt: number }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `C_${Buffer.from(`Comment:${comment.id}`).toString('base64url')}`,
    body: comment.body,
    user: userJson(),
    author: userJson(),
    created_at: isoOf(comment.createdAt),
    updated_at: isoOf(comment.createdAt),
    html_url: '',
  };
}

interface Page<T> {
  items: T[];
  link: string | null;
}

/** Slice a list by per_page/page and build the Link header the pagination checks walk. */
function paginate<T>(ctx: RestContext, items: T[]): Page<T> {
  const perPageRaw = Number(ctx.query.get('per_page') ?? '30');
  const pageRaw = Number(ctx.query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(Math.floor(perPageRaw), 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const links: string[] = [];
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  const urlFor = (p: number): string => {
    const params = new URLSearchParams(ctx.query);
    params.set('per_page', String(perPage));
    params.set('page', String(p));
    return `<${ctx.origin}${ctx.path}?${params.toString()}>`;
  };
  if (page < lastPage) links.push(`${urlFor(page + 1)}; rel="next"`, `${urlFor(lastPage)}; rel="last"`);
  if (page > 1) links.push(`${urlFor(1)}; rel="first"`, `${urlFor(page - 1)}; rel="prev"`);
  return { items: slice, link: links.length > 0 ? links.join(', ') : null };
}

function listResult<T>(ctx: RestContext, items: T[]): RestResult {
  const page = paginate(ctx, items);
  return { status: 200, body: page.items, headers: page.link === null ? {} : { link: page.link } };
}

// ------------------------------------------------------------------------------------------------
// Repository CRUD.
// ------------------------------------------------------------------------------------------------

function createRepo(ctx: RestContext): RestResult {
  const name = stringField(ctx.body, 'name');
  if (name === null || name === '') return validationFailed('Repository creation failed.');
  if (ctx.forge.getRepo(VIEWER.login, name) !== null) {
    return {
      status: 422,
      body: {
        message: 'Repository creation failed.',
        errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
      },
    };
  }
  const description = stringField(ctx.body, 'description') ?? '';
  const isPrivate = ctx.body?.private === true;
  const repo = ctx.forge.createRepo(name, description, isPrivate);
  return { status: 201, body: repoJson(repo) };
}

function patchRepo(ctx: RestContext, repo: Repo): RestResult {
  const body = ctx.body ?? {};
  const newName = stringField(body, 'name');
  if (newName !== null && newName !== '' && newName !== repo.name) {
    if (ctx.forge.getRepo(VIEWER.login, newName) !== null) return validationFailed('name already exists on this account');
    ctx.forge.renameRepo(repo, newName);
  }
  const description = stringField(body, 'description');
  if (description !== null) repo.description = description;
  if (typeof body.private === 'boolean') repo.isPrivate = body.private;
  const defaultBranch = stringField(body, 'default_branch');
  if (defaultBranch !== null && defaultBranch !== '') repo.defaultBranch = defaultBranch;
  repo.updatedAt = nextTimestamp();
  return { status: 200, body: repoJson(repo) };
}

// ------------------------------------------------------------------------------------------------
// Contents API, backed by real commits.
// ------------------------------------------------------------------------------------------------

function contentsGet(ctx: RestContext, repo: Repo, path: string): RestResult {
  const ref = ctx.query.get('ref') ?? repo.defaultBranch;
  const commit = repo.resolveCommit(ref);
  if (commit === null) return notFound();
  const flat = repo.flattenTree(repo.treeOf(commit));
  if (path === '') {
    const entries = directoryListing(repo, repo.treeOf(commit), '');
    return { status: 200, body: entries };
  }
  const file = flat.get(path);
  if (file !== undefined) {
    const obj = repo.objects.get(file.sha);
    const data = obj?.data ?? Buffer.alloc(0);
    return {
      status: 200,
      body: {
        type: 'file',
        encoding: 'base64',
        content: data.toString('base64'),
        name: path.split('/').pop(),
        path,
        sha: file.sha,
        size: data.length,
        url: '',
        html_url: '',
        download_url: '',
      },
    };
  }
  // A directory: list the subtree rooted at path.
  const prefix = `${path}/`;
  const exists = [...flat.keys()].some((key) => key.startsWith(prefix));
  if (!exists) return notFound();
  const subtree = subtreeSha(repo, repo.treeOf(commit), path);
  if (subtree === null) return notFound();
  return { status: 200, body: directoryListing(repo, subtree, path) };
}

function directoryListing(repo: Repo, treeSha: string, basePath: string): Array<Record<string, unknown>> {
  const obj = repo.objects.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return [];
  return parseTreeImpl(obj.data).map((entry) => {
    const entryPath = basePath === '' ? entry.name : `${basePath}/${entry.name}`;
    const isDir = entry.mode === '40000';
    const blob = isDir ? undefined : repo.objects.get(entry.sha);
    return {
      type: isDir ? 'dir' : 'file',
      name: entry.name,
      path: entryPath,
      sha: entry.sha,
      size: isDir ? 0 : (blob?.data.length ?? 0),
      url: '',
      html_url: '',
      download_url: null,
    };
  });
}

function subtreeSha(repo: Repo, treeSha: string, path: string): string | null {
  let current = treeSha;
  for (const part of path.split('/')) {
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTreeImpl(obj.data).find((candidate) => candidate.name === part);
    if (entry === undefined || entry.mode !== '40000') return null;
    current = entry.sha;
  }
  return current;
}

function contentsPut(ctx: RestContext, repo: Repo, path: string): RestResult {
  const body = ctx.body ?? {};
  const message = stringField(body, 'message') ?? 'Update file';
  const contentB64 = stringField(body, 'content');
  if (contentB64 === null) return validationFailed('content is required');
  const branch = stringField(body, 'branch') ?? repo.defaultBranch;
  const data = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
  const blobSha = storeObject(repo.objects, 'blob', data);
  const tip = repo.branchTip(branch);
  const flat = tip === null ? new Map<string, { sha: string; mode: string }>() : repo.flattenTree(repo.treeOf(tip));
  const existing = flat.get(path);
  const suppliedSha = stringField(body, 'sha');
  if (existing !== undefined) {
    if (suppliedSha !== null && suppliedSha !== existing.sha) {
      return { status: 409, body: { message: 'sha does not match', documentation_url: 'https://docs.github.com/rest' } };
    }
    if (suppliedSha === null) return validationFailed('sha is required when updating a file');
  }
  flat.set(path, { sha: blobSha, mode: existing?.mode ?? '100644' });
  const treeSha = repo.buildTreeFromFlat(flat);
  const commitSha = repo.writeCommit(treeSha, tip === null ? [] : [tip], message);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  repo.updatedAt = nextTimestamp();
  return {
    status: existing === undefined ? 201 : 200,
    body: {
      content: { type: 'file', encoding: 'base64', name: path.split('/').pop(), path, sha: blobSha, size: data.length },
      commit: commitJson(repo, commitSha),
    },
  };
}

function contentsDelete(ctx: RestContext, repo: Repo, path: string): RestResult {
  const body = ctx.body ?? {};
  const message = stringField(body, 'message') ?? 'Delete file';
  const branch = stringField(body, 'branch') ?? repo.defaultBranch;
  const tip = repo.branchTip(branch);
  if (tip === null) return notFound();
  const flat = repo.flattenTree(repo.treeOf(tip));
  const existing = flat.get(path);
  if (existing === undefined) return notFound();
  const suppliedSha = stringField(body, 'sha');
  if (suppliedSha !== null && suppliedSha !== existing.sha) {
    return { status: 409, body: { message: 'sha does not match' } };
  }
  flat.delete(path);
  const treeSha = repo.buildTreeFromFlat(flat);
  const commitSha = repo.writeCommit(treeSha, [tip], message);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return { status: 200, body: { content: null, commit: commitJson(repo, commitSha) } };
}

// ------------------------------------------------------------------------------------------------
// Commits, refs, branches.
// ------------------------------------------------------------------------------------------------

export function commitJson(repo: Repo, sha: string): Record<string, unknown> {
  const info = repo.commitInfo(sha);
  const ident = (line: string): Record<string, unknown> => {
    const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
    if (match === null) return { name: VIEWER.name, email: VIEWER.email, date: isoOf(repo.createdAt) };
    return { name: match[1], email: match[2], date: isoOf(Number(match[3])) };
  };
  return {
    sha,
    node_id: `C_${Buffer.from(`Commit:${sha}`).toString('base64url')}`,
    commit: {
      author: ident(info?.authorLine ?? ''),
      committer: ident(info?.committerLine ?? ''),
      message: info?.message ?? '',
      tree: { sha: info?.tree ?? ZERO_OID },
      comment_count: 0,
    },
    author: userJson(),
    committer: userJson(),
    parents: (info?.parents ?? []).map((parent) => ({ sha: parent })),
    html_url: `https://forge.local/${repo.fullName}/commit/${sha}`,
  };
}

function refJson(repo: Repo, ref: string): Record<string, unknown> {
  const sha = repo.refs.get(ref) as string;
  const obj = repo.objects.get(sha);
  return { ref, node_id: `REF_${Buffer.from(ref).toString('base64url')}`, object: { sha, type: obj?.type ?? 'commit' } };
}

function gitRefs(ctx: RestContext, repo: Repo): RestResult {
  const segments = ctx.segments; // repos, o, r, git, refs, ...
  const rest = segments.slice(5);
  if (ctx.method === 'GET' && rest.length === 0) {
    return { status: 200, body: [...repo.refs.keys()].sort().map((ref) => refJson(repo, ref)) };
  }
  if (ctx.method === 'POST' && rest.length === 0) {
    const ref = stringField(ctx.body, 'ref');
    const sha = stringField(ctx.body, 'sha');
    if (ref === null || sha === null) return validationFailed('ref and sha are required');
    if (repo.refs.has(ref)) return validationFailed('Reference already exists');
    if (!repo.objects.has(sha)) return validationFailed('Object does not exist');
    repo.refs.set(ref, sha);
    return { status: 201, body: refJson(repo, ref) };
  }
  const refName = `refs/${rest.join('/')}`;
  if (ctx.method === 'GET') {
    if (!repo.refs.has(refName)) return notFound();
    return { status: 200, body: refJson(repo, refName) };
  }
  if (ctx.method === 'PATCH') {
    const sha = stringField(ctx.body, 'sha');
    if (sha === null || !repo.objects.has(sha)) return validationFailed('Object does not exist');
    repo.refs.set(refName, sha);
    return { status: 200, body: refJson(repo, refName) };
  }
  if (ctx.method === 'DELETE') {
    if (!repo.refs.delete(refName)) return notFound();
    return { status: 204 };
  }
  return notFound();
}

function branches(ctx: RestContext, repo: Repo): RestResult {
  const rest = ctx.segments.slice(4); // after 'branches'
  const names = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).map((ref) => ref.slice('refs/heads/'.length)).sort();
  if (rest.length === 0 && ctx.method === 'GET') {
    return listResult(ctx, names.map((name) => ({ name, commit: { sha: repo.branchTip(name), type: 'commit' }, protected: false })));
  }
  const branch = rest.join('/');
  if (ctx.method === 'GET') {
    const tip = repo.branchTip(branch);
    if (tip === null) return notFound();
    return { status: 200, body: { name: branch, commit: commitJson(repo, tip), protected: false } };
  }
  return notFound();
}

// ------------------------------------------------------------------------------------------------
// Labels, issues, comments, pulls.
// ------------------------------------------------------------------------------------------------

function labelsRoute(ctx: RestContext, repo: Repo): RestResult {
  const rest = ctx.segments.slice(4);
  if (ctx.method === 'GET' && rest.length === 0) {
    return listResult(ctx, [...repo.labels.values()].map((label) => labelJson(repo, label.name)).filter((entry) => entry !== null));
  }
  if (ctx.method === 'POST' && rest.length === 0) {
    const name = stringField(ctx.body, 'name');
    if (name === null || name === '') return validationFailed('name is required');
    if (repo.labels.has(name)) return validationFailed('Label already exists');
    const color = (stringField(ctx.body, 'color') ?? 'ededed').replace(/^#/, '');
    const description = stringField(ctx.body, 'description') ?? '';
    repo.addLabel(name, color, description);
    return { status: 201, body: labelJson(repo, name) };
  }
  const name = decodeURIComponent(rest.join('/'));
  if (ctx.method === 'GET') {
    const label = labelJson(repo, name);
    return label === null ? notFound() : { status: 200, body: label };
  }
  if (ctx.method === 'DELETE') {
    return repo.labels.delete(name) ? { status: 204 } : notFound();
  }
  return notFound();
}

function sortIssues<T extends { number: number; createdAt: number }>(ctx: RestContext, items: T[]): T[] {
  const direction = ctx.query.get('direction') ?? 'desc';
  const sorted = [...items].sort((a, b) => a.number - b.number);
  return direction === 'asc' ? sorted : sorted.reverse();
}

function filterState<T extends { state: string }>(ctx: RestContext, items: T[]): T[] {
  const state = ctx.query.get('state') ?? 'open';
  if (state === 'all') return items;
  if (state === 'closed') return items.filter((item) => item.state === 'closed');
  return items.filter((item) => item.state === 'open');
}

function issuesRoute(ctx: RestContext, repo: Repo): RestResult {
  const rest = ctx.segments.slice(4); // after 'issues'
  if (rest.length === 0) {
    if (ctx.method === 'GET') {
      return listResult(ctx, sortIssues(ctx, filterState(ctx, [...repo.issues.values()])).map((issue) => issueJson(repo, issue)));
    }
    if (ctx.method === 'POST') {
      const title = stringField(ctx.body, 'title');
      if (title === null) return validationFailed('title is required');
      const labelNames = Array.isArray(ctx.body?.labels) ? (ctx.body?.labels as unknown[]).filter((entry): entry is string => typeof entry === 'string') : [];
      for (const name of labelNames) {
        if (!repo.labels.has(name)) return validationFailed(`label "${name}" does not exist`);
      }
      const now = nextTimestamp();
      const issue: IssueRecord = {
        kind: 'issue',
        id: repo.allocateRecordId(),
        number: repo.allocateNumber(),
        title,
        body: stringField(ctx.body, 'body') ?? '',
        state: 'open',
        labels: labelNames,
        comments: [],
        createdAt: now,
        updatedAt: now,
      };
      repo.issues.set(issue.number, issue);
      return { status: 201, body: issueJson(repo, issue) };
    }
    return notFound();
  }
  const number = Number(rest[0]);
  if (!Number.isInteger(number)) return notFound();
  const issue = repo.issues.get(number);
  const pull = repo.pulls.get(number);
  if (rest.length === 1) {
    if (ctx.method === 'GET') {
      if (issue !== undefined) return { status: 200, body: issueJson(repo, issue) };
      if (pull !== undefined) {
        const json = pullJson(repo, pull);
        json.pull_request = { url: '', html_url: json.html_url, merged_at: json.merged_at };
        return { status: 200, body: json };
      }
      return notFound();
    }
    if (ctx.method === 'PATCH') {
      if (issue === undefined) return notFound();
      const body = ctx.body ?? {};
      const title = stringField(body, 'title');
      if (title !== null) issue.title = title;
      const text = stringField(body, 'body');
      if (text !== null) issue.body = text;
      const state = stringField(body, 'state');
      if (state === 'closed' || state === 'open') issue.state = state;
      if (Array.isArray(body.labels)) {
        const names = (body.labels as unknown[]).filter((entry): entry is string => typeof entry === 'string');
        for (const name of names) if (!repo.labels.has(name)) return validationFailed(`label "${name}" does not exist`);
        issue.labels = names;
      }
      issue.updatedAt = nextTimestamp();
      return { status: 200, body: issueJson(repo, issue) };
    }
    return notFound();
  }
  if (rest[1] === 'comments') {
    const holder = issue ?? pull;
    if (holder === undefined) return notFound();
    if (ctx.method === 'GET') return listResult(ctx, holder.comments.map((comment) => commentJson(comment)));
    if (ctx.method === 'POST') {
      const text = stringField(ctx.body, 'body');
      if (text === null) return validationFailed('body is required');
      const comment = { id: repo.allocateCommentId(), body: text, createdAt: nextTimestamp() };
      holder.comments.push(comment);
      return { status: 201, body: commentJson(comment) };
    }
  }
  return notFound();
}

function pullsRoute(ctx: RestContext, repo: Repo): RestResult {
  const rest = ctx.segments.slice(4); // after 'pulls'
  if (rest.length === 0) {
    if (ctx.method === 'GET') {
      return listResult(ctx, sortIssues(ctx, filterState(ctx, [...repo.pulls.values()])).map((pull) => pullJson(repo, pull)));
    }
    if (ctx.method === 'POST') {
      const title = stringField(ctx.body, 'title');
      const head = stringField(ctx.body, 'head');
      const base = stringField(ctx.body, 'base');
      if (title === null || head === null || base === null) return validationFailed('title, head and base are required');
      const headBranch = head.includes(':') ? (head.split(':').pop() as string) : head;
      if (repo.branchTip(headBranch) === null || repo.branchTip(base) === null) {
        return validationFailed('head or base branch does not exist');
      }
      const duplicate = [...repo.pulls.values()].some((pull) => pull.state === 'open' && pull.headRef === headBranch && pull.baseRef === base);
      if (duplicate) return validationFailed('A pull request already exists for this branch combination');
      const now = nextTimestamp();
      const pull: PullRecord = {
        kind: 'pull',
        id: repo.allocateRecordId(),
        number: repo.allocateNumber(),
        title,
        body: stringField(ctx.body, 'body') ?? '',
        state: 'open',
        headRef: headBranch,
        baseRef: base,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        comments: [],
        createdAt: now,
        updatedAt: now,
      };
      repo.pulls.set(pull.number, pull);
      return { status: 201, body: pullJson(repo, pull) };
    }
    return notFound();
  }
  const number = Number(rest[0]);
  if (!Number.isInteger(number)) return notFound();
  const pull = repo.pulls.get(number);
  if (rest.length === 1) {
    if (ctx.method === 'GET') return pull === undefined ? notFound() : { status: 200, body: pullJson(repo, pull) };
    if (ctx.method === 'PATCH') {
      if (pull === undefined) return notFound();
      const body = ctx.body ?? {};
      const title = stringField(body, 'title');
      if (title !== null) pull.title = title;
      const text = stringField(body, 'body');
      if (text !== null) pull.body = text;
      const state = stringField(body, 'state');
      if ((state === 'closed' || state === 'open') && !pull.merged) pull.state = state;
      pull.updatedAt = nextTimestamp();
      return { status: 200, body: pullJson(repo, pull) };
    }
    return notFound();
  }
  if (pull === undefined) return notFound();
  if (rest[1] === 'files' && ctx.method === 'GET') {
    const files = pullFiles(repo, pull).map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      sha: '',
      blob_url: '',
      raw_url: '',
      contents_url: '',
    }));
    return listResult(ctx, files);
  }
  if (rest[1] === 'merge' && ctx.method === 'PUT') {
    if (pull.merged || pull.state !== 'open') {
      return { status: 405, body: { message: 'Pull Request is not mergeable', documentation_url: 'https://docs.github.com/rest' } };
    }
    const method = stringField(ctx.body, 'merge_method') ?? 'merge';
    const sha = mergePull(repo, pull, method === 'squash' ? 'squash' : 'merge');
    if (sha === null) {
      return { status: 405, body: { message: 'Pull Request is not mergeable' } };
    }
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = nextTimestamp();
    pull.mergeCommitSha = sha;
    pull.updatedAt = pull.mergedAt;
    return { status: 200, body: { sha, merged: true, message: 'Pull Request successfully merged' } };
  }
  return notFound();
}

// ------------------------------------------------------------------------------------------------
// Git data endpoints (blobs/trees/commits by id) — cheap completeness for API clients.
// ------------------------------------------------------------------------------------------------

function gitDataRoute(ctx: RestContext, repo: Repo): RestResult {
  const kind = ctx.segments[4];
  const sha = ctx.segments[5];
  if (ctx.method === 'GET' && kind === 'commits' && sha !== undefined) {
    if (repo.commitInfo(sha) === null) return notFound();
    return { status: 200, body: commitJson(repo, sha) };
  }
  if (ctx.method === 'GET' && kind === 'trees' && sha !== undefined) {
    const obj = repo.objects.get(sha);
    if (obj === undefined || obj.type !== 'tree') return notFound();
    const flat = repo.flattenTree(sha);
    return {
      status: 200,
      body: {
        sha,
        tree: [...flat.entries()].map(([path, entry]) => ({ path, mode: entry.mode, type: 'blob', sha: entry.sha })),
        truncated: false,
      },
    };
  }
  if (ctx.method === 'GET' && kind === 'blobs' && sha !== undefined) {
    const obj = repo.objects.get(sha);
    if (obj === undefined || obj.type !== 'blob') return notFound();
    return { status: 200, body: { content: obj.data.toString('base64'), encoding: 'base64', sha, size: obj.data.length } };
  }
  if (ctx.method === 'POST' && kind === 'blobs') {
    const content = stringField(ctx.body, 'content');
    if (content === null) return validationFailed('content is required');
    const data = ctx.body?.encoding === 'base64' ? Buffer.from(content.replace(/\s+/g, ''), 'base64') : Buffer.from(content, 'utf8');
    const sha2 = storeObject(repo.objects, 'blob', data);
    return { status: 201, body: { sha: sha2, url: '' } };
  }
  if (ctx.method === 'POST' && kind === 'commits') {
    const message = stringField(ctx.body, 'message');
    const tree = stringField(ctx.body, 'tree');
    if (message === null || tree === null) return validationFailed('message and tree are required');
    const parents = Array.isArray(ctx.body?.parents) ? (ctx.body?.parents as unknown[]).filter((entry): entry is string => typeof entry === 'string') : [];
    const sha2 = repo.writeCommit(tree, parents, message);
    return { status: 201, body: commitJson(repo, sha2) };
  }
  return notFound();
}

function commitsRoute(ctx: RestContext, repo: Repo): RestResult {
  if (ctx.method !== 'GET') return notFound();
  const shaParam = ctx.query.get('sha');
  if (ctx.segments.length === 5 && shaParam === null) {
    // /commits/{sha}
    const sha = ctx.segments[4] as string;
    if (repo.commitInfo(sha) === null) return notFound();
    return { status: 200, body: commitJson(repo, sha) };
  }
  const tip = repo.resolveCommit(shaParam ?? repo.defaultBranch);
  if (tip === null) return { status: 200, body: [] };
  const commits = repo.listCommits(tip, 1000).map((sha) => commitJson(repo, sha));
  return listResult(ctx, commits);
}

// ------------------------------------------------------------------------------------------------
// The router.
// ------------------------------------------------------------------------------------------------

export function routeRest(ctx: RestContext): RestResult {
  const segments = ctx.segments;
  const method = ctx.method;

  if (segments.length === 0) {
    if (method === 'GET') {
      return {
        status: 200,
        body: { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}', rate_limit_url: '/api/v3/rate_limit' },
        headers: { 'x-oauth-scopes': 'repo, read:org', 'x-accepted-oauth-scopes': 'repo' },
      };
    }
    return notFound();
  }

  if (segments[0] === 'meta' && method === 'GET') {
    return {
      status: 200,
      body: {
        verifiable_password_authentication: false,
        ssh_key_fingerprints: {},
        installed_version: '1.0.0-forge',
        github_services_sha: 'forge',
      },
    };
  }

  if (segments[0] === 'user' && segments.length === 1) {
    if (method === 'GET') return { status: 200, body: userJson() };
    if (method === 'PATCH') return { status: 200, body: userJson() };
    return notFound();
  }

  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') return listResult(ctx, ctx.forge.listRepos().map((repo) => repoJson(repo)));
    if (method === 'POST') return createRepo(ctx);
    return notFound();
  }

  if (segments[0] === 'users' && segments.length === 2 && method === 'GET') {
    return segments[1] === VIEWER.login ? { status: 200, body: userJson() } : notFound();
  }

  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const repo = ctx.forge.getRepo(owner, name);
    if (repo === null) return notFound();
    if (segments.length === 3) {
      if (method === 'GET') return { status: 200, body: repoJson(repo) };
      if (method === 'PATCH') return patchRepo(ctx, repo);
      if (method === 'DELETE') {
        ctx.forge.deleteRepo(owner, name);
        return { status: 204 };
      }
      return notFound();
    }
    const section = segments[3];
    if (section === 'contents') {
      const path = segments.slice(4).join('/');
      if (method === 'GET') return contentsGet(ctx, repo, path);
      if (method === 'PUT') return contentsPut(ctx, repo, path);
      if (method === 'DELETE') return contentsDelete(ctx, repo, path);
      return notFound();
    }
    if (section === 'git' && segments[4] === 'refs') return gitRefs(ctx, repo);
    if (section === 'git') return gitDataRoute(ctx, repo);
    if (section === 'branches') return branches(ctx, repo);
    if (section === 'commits') return commitsRoute(ctx, repo);
    if (section === 'labels') return labelsRoute(ctx, repo);
    if (section === 'issues') return issuesRoute(ctx, repo);
    if (section === 'pulls') return pullsRoute(ctx, repo);
    return notFound();
  }

  return notFound();
}

export { isRecord };
