// Git smart HTTP: info/refs advertisements (protocol v0 and v2), ls-refs, fetch (upload-pack)
// and push (receive-pack), over the same in-memory object store the REST surface writes.

import {
  decodePktLines,
  parseTag,
  parseTree as parseTreeImpl,
  pktLine,
  PKT_DELIM,
  PKT_FLUSH,
  readPack,
  sidebandWrap,
  storeObject,
  writePack,
  ZERO_OID,
  type GitObjectType,
} from './gitcore.ts';
import type { Forge, Repo } from './store.ts';
import { peelToCommit } from './gitcore.ts';

export interface GitHttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

const text = (status: number, body: string): GitHttpResult => ({ status, contentType: 'text/plain; charset=utf-8', body: Buffer.from(body, 'utf8') });

const UPLOAD_CAPS_V0 = 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not agent=forge/1.0';
const RECEIVE_CAPS_V0 = 'report-status delete-refs side-band-64k ofs-delta quiet agent=forge/1.0';

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** Refs as the wire shows them: HEAD first (in the caller's form), then every ref, with peeled lines. */
function advertisedRefs(repo: Repo): Array<{ name: string; oid: string; peeled?: string }> {
  const out: Array<{ name: string; oid: string; peeled?: string }> = [];
  for (const [name, oid] of sortedRefs(repo)) {
    const entry: { name: string; oid: string; peeled?: string } = { name, oid };
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'tag') entry.peeled = peelToCommit(repo.objects, oid);
    out.push(entry);
  }
  return out;
}

export function infoRefs(repo: Repo, service: string, protocolV2: boolean): GitHttpResult {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return text(400, 'unknown service');
  const isUpload = service === 'git-upload-pack';
  const contentType = `application/x-${service}-advertisement`;

  if (protocolV2 && isUpload) {
    const lines = [
      'version 2',
      'agent=forge/1.0',
      'ls-refs=unborn',
      'fetch=shallow',
      'object-format=sha1',
    ];
    const body = Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
    return { status: 200, contentType, body };
  }

  const caps = isUpload ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const symref = `symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = advertisedRefs(repo);
  const headTip = repo.branchTip(repo.defaultBranch);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps} ${symref}`));
  } else {
    let first = true;
    if (headTip !== null) {
      parts.push(pktLine(`${headTip} HEAD\0${caps} ${symref}`));
      first = false;
    }
    for (const ref of refs) {
      parts.push(pktLine(first ? `${ref.oid} ${ref.name}\0${caps} ${symref}` : `${ref.oid} ${ref.name}`));
      first = false;
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}`));
    }
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType, body: Buffer.concat(parts) };
}

// ------------------------------------------------------------------------------------------------
// Object selection for fetch.
// ------------------------------------------------------------------------------------------------

interface Selection {
  objects: Array<{ type: GitObjectType; data: Buffer }>;
  shallow: string[];
  unshallow: string[];
}

/**
 * The objects a fetch sends: the closure of the wants (depth-limited when deepen is given),
 * minus the closure of the haves. Boundary commits of a depth cut are reported as shallow.
 */
function selectObjects(repo: Repo, wants: string[], haves: string[], depth: number | null, clientShallow: Set<string>): Selection {
  /** Object closure (commits, trees, blobs, tags) of the given tips, ancestry limited to `limit` generations when given. */
  const closureOf = (tips: string[], limit: number | null, commitDepths?: Map<string, number>): Set<string> => {
    const out = new Set<string>();
    // First pass: commit ancestry (BFS so depths are minimal), honoring the generation limit.
    const commits = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = tips
      .filter((tip) => repo.objects.get(tip)?.type === 'commit' || repo.objects.get(tip)?.type === 'tag')
      .map((tip) => ({ id: peelToCommit(repo.objects, tip), depth: 1 }));
    while (queue.length > 0) {
      const { id, depth: d } = queue.shift() as { id: string; depth: number };
      const known = commitDepths?.get(id);
      if (known !== undefined && known <= d) continue;
      if (commits.has(id) && commitDepths === undefined) continue;
      commits.add(id);
      if (commitDepths !== undefined) commitDepths.set(id, Math.min(commitDepths.get(id) ?? Infinity, d));
      const info = repo.commitInfo(id);
      if (info === null) continue;
      if (limit === null || d < limit) {
        for (const parent of info.parents) queue.push({ id: parent, depth: d + 1 });
      }
    }
    // Second pass: every commit's tree closure, plus tag objects pointing into the set.
    const stack: string[] = [];
    for (const tip of tips) {
      const obj = repo.objects.get(tip);
      if (obj?.type === 'tag') stack.push(tip);
    }
    for (const commit of commits) {
      out.add(commit);
      const info = repo.commitInfo(commit);
      if (info !== null) stack.push(info.tree);
    }
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (out.has(id)) continue;
      const obj = repo.objects.get(id);
      if (obj === undefined) continue;
      out.add(id);
      if (obj.type === 'tree') {
        for (const entry of parseTreeImpl(obj.data)) stack.push(entry.sha);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
    return out;
  };

  // With a depth limit, "have" and "shallow" lines mark what a shallow client holds: those
  // commits and their trees, but NOT their ancestry — the ancestry is what deepen delivers.
  // Without a depth limit, haves prune their full closure as usual.
  const haveClosure = depth === null
    ? closureOf(haves, null)
    : closureOf([...haves, ...clientShallow], 1);
  const depthOf = new Map<string, number>();
  const wantSet = closureOf(wants, depth, depthOf);

  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const [id, d] of depthOf) {
      if (!wantSet.has(id)) continue;
      const info = repo.commitInfo(id);
      if (info !== null && d === depth && info.parents.length > 0) shallow.push(id);
    }
    for (const old of clientShallow) {
      if (wantSet.has(old) && depthOf.has(old) && !shallow.includes(old)) unshallow.push(old);
    }
  }

  const send: Array<{ type: GitObjectType; data: Buffer }> = [];
  for (const id of wantSet) {
    if (haveClosure.has(id)) continue;
    const obj = repo.objects.get(id);
    if (obj !== undefined) send.push({ type: obj.type, data: obj.data });
  }
  // Commits first, then trees, then blobs, then tags: a stable, readable pack order.
  const order: Record<GitObjectType, number> = { commit: 0, tree: 1, blob: 2, tag: 3 };
  send.sort((a, b) => order[a.type] - order[b.type]);
  return { objects: send, shallow, unshallow };
}

// ------------------------------------------------------------------------------------------------
// ls-refs (protocol v2).
// ------------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: string[] = [];
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const headTip = repo.branchTip(repo.defaultBranch);
  if (matches('HEAD')) {
    if (headTip !== null) {
      lines.push(`${headTip} HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}`);
    }
  }
  for (const ref of advertisedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    lines.push(line);
  }
  return Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
}

// ------------------------------------------------------------------------------------------------
// fetch (upload-pack), v2 and v0.
// ------------------------------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallowLines: string[];
  depth: number | null;
  done: boolean;
}

function buildFetchResponse(repo: Repo, request: FetchRequest, version2: boolean, noProgress: boolean): Buffer {
  const clientShallow = new Set(request.shallowLines);
  const selection = selectObjects(repo, request.wants, request.haves, request.depth, clientShallow);
  const pack = writePack(selection.objects);

  const knownHaves = request.haves.filter((have) => repo.objects.get(have)?.type === 'commit');
  // v2 acknowledgments: ACK lines, then 'ready' when the pack follows in the same response.
  const ackLinesV2: string[] = [];
  if (knownHaves.length > 0) {
    for (const have of knownHaves) ackLinesV2.push(`ACK ${have}`);
    if (request.done) ackLinesV2.push('ready');
  } else {
    ackLinesV2.push('NAK');
  }
  // v0 (multi_ack_detailed): 'ACK <oid> common' per common commit, one final bare ACK, or NAK.
  const ackLinesV0: string[] = [];
  if (knownHaves.length > 0) {
    for (const have of knownHaves.slice(0, -1)) ackLinesV0.push(`ACK ${have} common`);
    ackLinesV0.push(`ACK ${knownHaves[knownHaves.length - 1]}`);
  } else {
    ackLinesV0.push('NAK');
  }

  const shallowLines: string[] = [
    ...selection.shallow.map((oid) => `shallow ${oid}`),
    ...selection.unshallow.map((oid) => `unshallow ${oid}`),
  ];

  const packfilePkts = (): Buffer => {
    const parts: Buffer[] = [];
    const CHUNK = 65515;
    for (let offset = 0; offset < pack.length; offset += CHUNK) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(offset, Math.min(offset + CHUNK, pack.length))])));
    }
    if (parts.length === 0) parts.push(pktLine(Buffer.from([1])));
    void noProgress;
    return Buffer.concat(parts);
  };

  if (version2) {
    const parts: Buffer[] = [];
    const section = (name: string, content: Buffer[]): void => {
      parts.push(pktLine(`${name}\n`), ...content, PKT_FLUSH);
    };
    section('acknowledgments', ackLinesV2.map((line) => pktLine(`${line}\n`)));
    if (shallowLines.length > 0) section('shallow-info', shallowLines.map((line) => pktLine(`${line}\n`)));
    section('packfile', [packfilePkts()]);
    return Buffer.concat(parts);
  }

  const parts: Buffer[] = [];
  for (const line of shallowLines) parts.push(pktLine(`${line}\n`));
  for (const line of ackLinesV0) parts.push(pktLine(`${line}\n`));
  parts.push(packfilePkts());
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function uploadPack(repo: Repo, body: Buffer, protocolV2: boolean): GitHttpResult {
  let tokens;
  try {
    tokens = decodePktLines(body);
  } catch {
    return text(400, 'malformed pkt-line stream');
  }
  const lines: string[] = [];
  for (const token of tokens) {
    if (token.kind === 'line') lines.push(token.payload.toString('utf8').replace(/\n$/, ''));
  }
  const command = lines[0] ?? '';

  if (protocolV2 && command.startsWith('command=ls-refs')) {
    const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const line of lines.slice(1)) {
      if (line === 'peel') args.peel = true;
      else if (line === 'symrefs') args.symrefs = true;
      else if (line === 'unborn') args.unborn = true;
      else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefs(repo, args) };
  }

  if (protocolV2 && command.startsWith('command=fetch')) {
    const request: FetchRequest = { wants: [], haves: [], shallowLines: [], depth: null, done: false };
    let noProgress = false;
    for (const line of lines.slice(1)) {
      if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) request.shallowLines.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) request.depth = Number(line.slice(7).trim());
      else if (line === 'done') request.done = true;
      else if (line === 'no-progress') noProgress = true;
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: buildFetchResponse(repo, request, true, noProgress) };
  }

  if (protocolV2) return text(400, 'unsupported protocol v2 command');

  // Protocol v0: want lines (the first carries capabilities after a NUL), a flush, then have/done.
  const request: FetchRequest = { wants: [], haves: [], shallowLines: [], depth: null, done: false };
  for (const rawLine of lines) {
    const line = rawLine.split('\0')[0] as string;
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallowLines.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number(line.slice(7).trim());
    else if (line === 'done') request.done = true;
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: buildFetchResponse(repo, request, false, true) };
}

// ------------------------------------------------------------------------------------------------
// receive-pack (push), protocol v0.
// ------------------------------------------------------------------------------------------------

interface RefCommand {
  oldId: string;
  newId: string;
  ref: string;
}

export function receivePack(repo: Repo, body: Buffer): GitHttpResult {
  // The command block is pkt-lines up to a flush; everything after it is the pack file, whose
  // bytes are not pkt-lines. Parse the header words one at a time and stop at the flush.
  const commands: RefCommand[] = [];
  let capabilities = '';
  let packStart = -1;
  let offset = 0;
  let malformed = false;
  while (offset < body.length) {
    if (offset + 4 > body.length) { malformed = true; break; }
    const header = body.toString('utf8', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) { malformed = true; break; }
    const length = parseInt(header, 16);
    if (length === 0) {
      packStart = offset + 4;
      break;
    }
    if (length < 4 || offset + length > body.length) { malformed = true; break; }
    let line = body.toString('utf8', offset + 4, offset + length).replace(/\n$/, '');
    offset += length;
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length === 3) commands.push({ oldId: parts[0] as string, newId: parts[1] as string, ref: parts[2] as string });
  }
  if (malformed) return text(400, 'malformed pkt-line stream');
  if (packStart === -1) packStart = body.length;

  let unpackError: string | null = null;
  const needsPack = commands.some((command) => command.newId !== ZERO_OID);
  if (needsPack) {
    if (packStart === -1 || packStart >= body.length) {
      unpackError = 'no pack file received';
    } else {
      try {
        const pack = readPack(body, packStart, repo.objects);
        for (const obj of pack.objects) storeObject(repo.objects, obj.type, obj.data);
      } catch (error) {
        unpackError = error instanceof Error ? error.message : 'unpack failed';
      }
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  if (unpackError === null) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? ZERO_OID;
      if (command.newId === ZERO_OID) {
        // Delete.
        if (current === ZERO_OID) {
          results.push({ ref: command.ref, ok: false, reason: 'reference does not exist' });
        } else if (command.oldId !== current) {
          results.push({ ref: command.ref, ok: false, reason: 'stale info' });
        } else {
          repo.refs.delete(command.ref);
          results.push({ ref: command.ref, ok: true });
        }
        continue;
      }
      if (!repo.objects.has(command.newId)) {
        results.push({ ref: command.ref, ok: false, reason: 'unknown object' });
        continue;
      }
      if (command.oldId === ZERO_OID && current !== ZERO_OID) {
        results.push({ ref: command.ref, ok: false, reason: 'reference already exists' });
        continue;
      }
      if (command.oldId !== ZERO_OID && command.oldId !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'stale info' });
        continue;
      }
      if (command.oldId !== ZERO_OID) {
        const newCommit = peelToCommit(repo.objects, command.newId);
        const oldCommit = peelToCommit(repo.objects, command.oldId);
        if (newCommit !== oldCommit && !repo.isAncestor(oldCommit, newCommit)) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
      }
      repo.refs.set(command.ref, command.newId);
      results.push({ ref: command.ref, ok: true });
    }
  }

  const reportLines: string[] = [unpackError === null ? 'unpack ok' : `unpack ${unpackError}`];
  if (unpackError === null) {
    for (const result of results) {
      reportLines.push(result.ok ? `ok ${result.ref}` : `ng ${result.ref} ${result.reason ?? 'failed'}`);
    }
  }
  const report = Buffer.concat([...reportLines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
  const useSideband = capabilities.includes('side-band-64k');
  const payload = useSideband ? Buffer.concat([sidebandWrap(report), PKT_FLUSH]) : report;
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: payload };
}

// ------------------------------------------------------------------------------------------------
// Routing.
// ------------------------------------------------------------------------------------------------

/** Handle any /{owner}/{repo}.git/... request. Returns null when the path is not a git path. */
export function routeGitHttp(forge: Forge, method: string, segments: string[], query: URLSearchParams, headers: Record<string, string | string[] | undefined>, body: Buffer): GitHttpResult | null {  if (segments.length < 2) return null;
  const repoSegment = segments[1] as string;
  if (!repoSegment.endsWith('.git')) return null;
  const owner = segments[0] as string;
  const repo = forge.getRepo(owner, repoSegment.slice(0, -'.git'.length));
  if (repo === null) return text(404, 'repository not found');
  const rest = segments.slice(2).join('/');
  const protocolHeader = headers['git-protocol'];
  const protocolV2 = typeof protocolHeader === 'string' && protocolHeader.includes('version=2');

  if (method === 'GET' && rest === 'info/refs') {
    return infoRefs(repo, query.get('service') ?? '', protocolV2);
  }
  if (method === 'POST' && rest === 'git-upload-pack') {
    try {
      return uploadPack(repo, body, protocolV2);
    } catch {
      return text(400, 'bad upload-pack request');
    }
  }
  if (method === 'POST' && rest === 'git-receive-pack') {
    try {
      return receivePack(repo, body);
    } catch {
      return text(400, 'bad receive-pack request');
    }
  }
  return text(404, 'not found');
}

