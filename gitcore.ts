// Git object model primitives: hashing, zlib storage form, tree/commit codecs, pack read/write,
// pkt-line framing. Pure functions over Buffers plus a per-repository object map. No I/O here.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export type ObjectMap = Map<string, GitObject>;

export const ZERO_OID = '0'.repeat(40);

const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The git object id: sha1 of "<type> <len>\0" followed by the raw bytes. */
export function objectId(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Store an object in the map (idempotent) and answer its id. */
export function storeObject(map: ObjectMap, type: GitObjectType, data: Buffer): string {
  const id = objectId(type, data);
  if (!map.has(id)) map.set(id, { type, data });
  return id;
}

export interface TreeEntry {
  mode: string; // '100644', '100755', '120000', '40000', '160000'
  name: string;
  sha: string;
}

/** Parse a raw tree object body into entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('utf8', offset, space);
    const name = data.toString('utf8', space + 1, nul);
    const sha = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort key: directories compare as if their name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialize entries into a raw tree body, sorted by git's rule. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  authorLine: string;
  committerLine: string;
  message: string;
  /** Seconds since epoch from the committer line, 0 when unparsable. */
  committerTime: number;
}

/** Parse a raw commit object body. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let authorLine = '';
  let committerLine = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) committerLine = line.slice(10);
  }
  const timeMatch = / (\d+) [+-]\d{4}$/.exec(committerLine);
  return { tree, parents, authorLine, committerLine, message, committerTime: timeMatch ? Number(timeMatch[1]) : 0 };
}

/** Serialize a commit object body. */
export function buildCommit(tree: string, parents: string[], authorLine: string, committerLine: string, message: string): Buffer {
  let header = `tree ${tree}\n`;
  for (const parent of parents) header += `parent ${parent}\n`;
  header += `author ${authorLine}\ncommitter ${committerLine}\n\n`;
  return Buffer.from(header + message, 'utf8');
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
}

/** Parse a raw annotated tag object body (only what ref peeling needs). */
export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  let object = '';
  let type = '';
  let tag = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line === '') break;
  }
  return { object, type, tag };
}

/** Follow tag objects until a non-tag object; answers the final id (or the input when unknown). */
export function peelToCommit(map: ObjectMap, id: string): string {
  let current = id;
  for (let guard = 0; guard < 32; guard += 1) {
    const obj = map.get(current);
    if (obj === undefined || obj.type !== 'tag') return current;
    current = parseTag(obj.data).object;
  }
  return current;
}

// ------------------------------------------------------------------------------------------------
// Pack files.
// ------------------------------------------------------------------------------------------------

/** Write a version-2 pack holding the given objects whole (no deltas), with its sha1 trailer. */
export function writePack(objects: Array<{ type: GitObjectType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'utf8');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    // Variable-length size with the type in bits 4-6 of the first byte.
    let size = obj.data.length;
    const first = (TYPE_CODES[obj.type] << 4) | (size & 0x0f);
    size >>= 4;
    const bytes: number[] = [];
    if (size === 0) {
      bytes.push(first);
    } else {
      bytes.push(first | 0x80);
      while (size > 0) {
        const byte = size & 0x7f;
        size >>= 7;
        bytes.push(size > 0 ? byte | 0x80 : byte);
      }
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git delta (the format ofs-delta and ref-delta carry) to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] ?? 0;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size mismatch: ${sourceSize} vs ${base.length}`);
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset] ?? 0;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      if ((op & 0x01) !== 0) { copyOffset |= delta[offset] ?? 0; offset += 1; }
      if ((op & 0x02) !== 0) { copyOffset |= (delta[offset] ?? 0) << 8; offset += 1; }
      if ((op & 0x04) !== 0) { copyOffset |= (delta[offset] ?? 0) << 16; offset += 1; }
      if ((op & 0x08) !== 0) { copyOffset |= (delta[offset] ?? 0) << 24; offset += 1; }
      if ((op & 0x10) !== 0) { copySize |= delta[offset] ?? 0; offset += 1; }
      if ((op & 0x20) !== 0) { copySize |= (delta[offset] ?? 0) << 8; offset += 1; }
      if ((op & 0x40) !== 0) { copySize |= (delta[offset] ?? 0) << 16; offset += 1; }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta result size mismatch');
  return result;
}

export interface PackReadResult {
  objects: Array<{ type: GitObjectType; data: Buffer }>;
  /** Bytes consumed by the pack itself (header through trailer). */
  consumed: number;
}

/**
 * Read a pack from `buf` starting at `start`. Delta bases may live in the same pack (by offset or id)
 * or in `external`, the repository's existing objects. Mirrors the reference client's reader.
 */
export function readPack(buf: Buffer, start: number, external: ObjectMap): PackReadResult {
  if (buf.toString('utf8', start, start + 4) !== 'PACK') throw new Error('not a pack file');
  const count = buf.readUInt32BE(start + 8);
  let offset = start + 12;
  const byOffset = new Map<number, { type: GitObjectType; data: Buffer }>();
  const objects: Array<{ type: GitObjectType; data: Buffer }> = [];
  const inflateAt = (at: number): { data: Buffer; next: number } => {
    const view = buf.subarray(at);
    const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    return { data: Buffer.from(result.buffer), next: at + result.engine.bytesWritten };
  };
  for (let index = 0; index < count; index += 1) {
    const objectStart = offset;
    let byte = buf[offset] ?? 0;
    offset += 1;
    const code = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = buf[offset] ?? 0;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    void size;
    if (code === 6) {
      // ofs-delta: a negative offset varint back to the base object in this pack.
      let back = buf[offset] ?? 0;
      offset += 1;
      let baseOffset = back & 0x7f;
      while ((back & 0x80) !== 0) {
        back = buf[offset] ?? 0;
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (back & 0x7f);
      }
      const base = byOffset.get(objectStart - baseOffset);
      if (base === undefined) throw new Error('ofs-delta base is not in this pack');
      const inflated = inflateAt(offset);
      offset = inflated.next;
      const data = applyDelta(base.data, inflated.data);
      const resolved = { type: base.type, data };
      byOffset.set(objectStart, resolved);
      objects.push(resolved);
    } else if (code === 7) {
      // ref-delta: the base is named by id, in this pack or already in the repository.
      const baseId = buf.toString('hex', offset, offset + 20);
      offset += 20;
      const inflated = inflateAt(offset);
      offset = inflated.next;
      let base = external.get(baseId);
      if (base === undefined) {
        for (const candidate of byOffset.values()) {
          if (objectId(candidate.type, candidate.data) === baseId) { base = candidate; break; }
        }
      }
      if (base === undefined) throw new Error(`ref-delta base ${baseId} is unknown`);
      const data = applyDelta(base.data, inflated.data);
      const resolved = { type: base.type, data };
      byOffset.set(objectStart, resolved);
      objects.push(resolved);
    } else {
      const type = CODE_TYPES[code];
      if (type === undefined) throw new Error(`unknown pack object type code ${code}`);
      const inflated = inflateAt(offset);
      offset = inflated.next;
      const resolved = { type, data: inflated.data };
      byOffset.set(objectStart, resolved);
      objects.push(resolved);
    }
  }
  const trailerEnd = offset + 20;
  const expected = createHash('sha1').update(buf.subarray(start, offset)).digest('hex');
  const actual = buf.toString('hex', offset, trailerEnd);
  if (expected !== actual) throw new Error('pack checksum mismatch');
  return { objects, consumed: trailerEnd - start };
}

// ------------------------------------------------------------------------------------------------
// pkt-line framing.
// ------------------------------------------------------------------------------------------------

/** One pkt-line payload (without the 4-byte length), or the flush/delim markers. */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const prefix = Buffer.from(length.toString(16).padStart(4, '0'), 'utf8');
  return Buffer.concat([prefix, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'utf8');
export const PKT_DELIM = Buffer.from('0001', 'utf8');
export const PKT_RESPONSE_END = Buffer.from('0002', 'utf8');

export type PktToken =
  | { kind: 'line'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode every pkt-line in a buffer; throws on a malformed length (callers turn that into a 4xx). */
export function decodePktLines(buf: Buffer): PktToken[] {
  const tokens: PktToken[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
    const header = buf.toString('utf8', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`malformed pkt-line length "${header}"`);
    const length = parseInt(header, 16);
    if (length === 0) {
      tokens.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      tokens.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      tokens.push({ kind: 'response-end' });
      offset += 4;
    } else {
      if (length < 4 || offset + length > buf.length) throw new Error('pkt-line length out of bounds');
      tokens.push({ kind: 'line', payload: buf.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return tokens;
}

/** Wrap a payload stream in sideband band-1 pkt-lines (data chunks keep the whole line ≤ 65520). */
export function sidebandWrap(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  if (data.length === 0) return Buffer.alloc(0);
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const slice = data.subarray(offset, Math.min(offset + CHUNK, data.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return Buffer.concat(parts);
}
