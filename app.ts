// A standalone GitHub-compatible git forge: git smart HTTP (upload-pack v2,
// receive-pack v0), REST v3, GraphQL v4 and MCP, from one in-memory store.
// Node 22 stdlib only. Deterministic: no wall clock, no randomness in state;
// ids come from counters, timestamps are a fixed constant, and the token
// owner's login is derived from the sealed scenario seed at startup.

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------------------------

const JSON_TYPE = 'application/json; charset=utf-8';
const REQUEST_ID = 'req-00000000000000000000000000000001';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const NOW_ISO = '2026-10-28T00:00:00.000Z';
const EPOCH_SEC = 1_700_000_000;
const AGENT_NAME = 'github-core-forge/1.0';
const SERVER_NAME = 'github-core-forge';
const SERVER_VERSION = '1.0.0';
const ZERO_OID = '0'.repeat(40);
const PKT_LINE_MAX = 65520;
const IDENTITY = 'Conformance <conformance@make.fun>';

const V2_ADVERTISEMENT = buildV2Advertisement();

function buildV2Advertisement(): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine('# service=git-upload-pack\n'));
  parts.push(pktLine('version 2\n'));
  parts.push(pktLine(`agent=${AGENT_NAME}\n`));
  parts.push(pktLine('ls-refs\n'));
  parts.push(pktLine('fetch=shallow thin-pack\n'));
  parts.push(pktLine('object-format=sha1\n'));
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// the token owner's login, derived from the sealed scenario seed (wire.ts buildScenario)
// ---------------------------------------------------------------------------------------------

const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

/** The scenario viewer's login: users[0] of the seeded generator (wire.ts). */
function scenarioViewerLogin(): string {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  let firstLogin = '';
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    if (i === 0) firstLogin = login;
  }
  return firstLogin;
}

const VIEWER_LOGIN = scenarioViewerLogin();
const VIEWER_ID = 1000;
const VIEWER_EMAIL = `${VIEWER_LOGIN}@example.invalid`;

// ---------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------

function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function hashObject(type: string, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1(Buffer.concat([head, data]));
}

/** Git order for object ids: plain lexicographic order of the hex strings. */
function sortOids(oids: readonly string[]): string[] {
  return [...oids].sort();
}

function isHex40(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function b64encode(data: Buffer | string): string {
  return Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data, 'utf8').toString('base64');
}

function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) lines += 1;
  if (data[data.length - 1] !== 0x0a) lines += 1;
  return lines;
}

// ---------------------------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------------------------

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

function flushPacket(): Buffer {
  return PKT_FLUSH;
}

function delimPacket(): Buffer {
  return PKT_DELIM;
}

function jsonBody(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

const AUTHOR_NAME = 'Conformance';
const AUTHOR_EMAIL = 'conformance@make.fun';

/** Decode a whole buffer of pkt-lines; returns data payloads and the offset just past the flush. */
function decodePktLines(buffer: Buffer, start = 0): { payloads: Buffer[]; next: number } {
  const payloads: Buffer[] = [];
  let offset = start;
  while (offset + 4 <= buffer.length) {
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`invalid pkt-line header ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length === 1 || length === 2) {
      offset += 4;
      continue;
    }
    if (length > PKT_LINE_MAX || offset + length > buffer.length) {
      throw new Error('pkt-line overrun');
    }
    payloads.push(buffer.subarray(offset + 4, offset + length));
    offset += length;
  }
  return { payloads, next: offset };
}

// ---------------------------------------------------------------------------------------------
// git object model
// ---------------------------------------------------------------------------------------------

type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

interface CommitView {
  tree: string;
  parents: string[];
  message: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('bad tree object');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
  }
  return { tree, parents, message };
}

function buildCommit(tree: string, parents: readonly string[], message: string): Buffer {
  const who = `${IDENTITY} ${EPOCH_SEC} +0000`;
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

function parseTagTarget(data: Buffer): { object: string; type: string } {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  let object = '';
  let type = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'object') object = value;
    else if (key === 'type') type = value;
  }
  return { object, type };
}

// ---------------------------------------------------------------------------------------------
// packfile read/write (plain objects only, no deltas)
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Serialise the repo objects in `oids` (git-sorted) into a pack. */
function writePackForRepo(repo: Repo, oids: ReadonlySet<string>): Buffer {
  const objects: GitObject[] = [];
  for (const oid of sortOids([...oids])) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  return writePack(objects);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++] as number;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++] as number;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++] as number;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += (delta[offset++] as number) * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

/** Parse a packfile (v2/v3, with OFS/REF deltas) into resolved objects keyed by oid. */
function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  if (sha1(pack.subarray(0, trailerStart)) !== trailer) throw new Error('pack checksum mismatch');
  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type ${typeCode}`);
    }
    const inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (inflated.buffer.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.buffer;
    offset += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack trailing bytes');
  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): { type: GitObjectType; data: Buffer; oid: string } => {
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error('ref-delta base missing');
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as GitObjectType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

// ---------------------------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------------------------

interface Label {
  name: string;
  color: string;
}

interface Comment {
  id: number;
  body: string;
}

interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number;
  json: Buffer | null;
}

interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  files: PullFile[];
  seq: number;
}

let nextRepoId = 1;
let nextObjectId = 1;
let nextCommentSeq = 1;

function globalId(kind: string, ...parts: (string | number)[]): string {
  return b64encode(`${kind}:${parts.join(':')}`);
}

function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

class Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  priv: boolean;
  defaultBranch = 'main';
  refs = new Map<string, string>();
  objects = new Map<string, GitObject>();
  commitCache = new Map<string, CommitView>();
  treeCache = new Map<string, TreeEntry[]>();
  issues = new Map<number, Issue>();
  pulls = new Map<number, Pull>();
  labels = new Map<string, Label>();
  seq = 0;
  rev = 0;
  advV0: Buffer | null = null;
  advReceive: Buffer | null = null;
  packCache = new Map<string, { pack: Buffer; shallow: string[]; unshallow: string[] }>();
  fetchCache = new Map<string, Buffer>();
  closureCache = new Map<string, string[]>();

  constructor(owner: string, name: string, description: string, priv: boolean) {
    this.id = nextRepoId++;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.priv = priv;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  get globalId(): string {
    return globalId('Repository', this.id);
  }

  bump(): void {
    this.rev += 1;
    this.advV0 = null;
    this.advReceive = null;
    this.packCache.clear();
    this.fetchCache.clear();
    this.closureCache.clear();
  }

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  commitView(oid: string): CommitView | undefined {
    let view = this.commitCache.get(oid);
    if (view !== undefined) return view;
    const object = this.objects.get(oid);
    if (!object || object.type !== 'commit') return undefined;
    view = parseCommit(object.data);
    this.commitCache.set(oid, view);
    return view;
  }

  treeEntries(oid: string): TreeEntry[] {
    let entries = this.treeCache.get(oid);
    if (entries !== undefined) return entries;
    const object = this.objects.get(oid);
    if (!object || object.type !== 'tree') return [];
    entries = parseTree(object.data);
    this.treeCache.set(oid, entries);
    return entries;
  }

  /** Peel a ref target through annotated tags to its commit. */
  peelToCommit(oid: string): string {
    let current = oid;
    for (let i = 0; i < 16; i += 1) {
      const object = this.objects.get(current);
      if (!object || object.type !== 'tag') return current;
      current = parseTagTarget(object.data).object;
    }
    return current;
  }

  /** Is `ancestor` an ancestor of (or equal to) `descendant`? Walks parents. */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue: string[] = [descendant];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const view = this.commitView(oid);
      if (!view) continue;
      for (const parent of view.parents) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  /** All objects reachable from `roots`, following commit->tree/parents, tag->target, tree->entries. */
  reachable(roots: readonly string[]): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [...roots];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      const object = this.objects.get(oid);
      if (!object) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const view = this.commitView(oid);
        if (view) {
          queue.push(view.tree);
          for (const parent of view.parents) queue.push(parent);
        }
      } else if (object.type === 'tag') {
        queue.push(parseTagTarget(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of this.treeEntries(oid)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      }
    }
    return seen;
  }

  /** Commits reachable from `tip`, newest first (DFS pre-order). Cached per tip. */
  commitList(tip: string): string[] {
    const cached = this.closureCache.get(tip);
    if (cached !== undefined) return cached;
    const out: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const view = this.commitView(oid);
      if (!view) continue;
      out.push(oid);
      for (let i = view.parents.length - 1; i >= 0; i -= 1) stack.push(view.parents[i] as string);
    }
    this.closureCache.set(tip, out);
    return out;
  }

  /** Flatten a tree to path -> {oid, mode}. */
  flattenTree(rootOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (treeOid: string, prefix: string): void => {
      for (const entry of this.treeEntries(treeOid)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(rootOid, '');
    return out;
  }

  /** Blob oid at `path` in the tree rooted at `rootOid`, or null. */
  blobAt(rootOid: string | null, path: string): { oid: string; data: Buffer } | null {
    if (rootOid === null) return null;
    const segments = path.split('/').filter((s) => s !== '');
    let treeOid = rootOid;
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i] as string;
      const entry = this.treeEntries(treeOid).find((e) => e.name === segment);
      if (!entry) return null;
      if (i === segments.length - 1) {
        if (entry.mode === '40000') return null;
        const object = this.objects.get(entry.oid);
        if (!object || object.type !== 'blob') return null;
        return { oid: entry.oid, data: object.data };
      }
      if (entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    return null;
  }

  /** Tree oid of the directory at `path` in `rootOid`, or null. */
  dirAt(rootOid: string | null, path: string): string | null {
    if (rootOid === null) return null;
    const segments = path.split('/').filter((s) => s !== '');
    let treeOid = rootOid;
    for (const segment of segments) {
      const entry = this.treeEntries(treeOid).find((e) => e.name === segment);
      if (!entry || entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    return treeOid;
  }

  /**
   * A new root tree with `path` set to `blobOid` (or removed when null), based on
   * `rootOid` (null = empty tree). Creates the intermediate tree objects.
   */
  updateTree(rootOid: string | null, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((s) => s !== '');
    const build = (treeOid: string | null, depth: number): string => {
      const entries = treeOid === null ? [] : [...this.treeEntries(treeOid)];
      const name = segments[depth] as string;
      const index = entries.findIndex((e) => e.name === name);
      if (depth === segments.length - 1) {
        if (blobOid === null) {
          if (index >= 0) entries.splice(index, 1);
        } else if (index >= 0) {
          entries[index] = { mode: '100644', name, oid: blobOid };
        } else {
          entries.push({ mode: '100644', name, oid: blobOid });
        }
      } else {
        const child = index >= 0 ? entries[index] : undefined;
        const childTree = child && child.mode === '40000' ? child.oid : null;
        const newChild = build(childTree, depth + 1);
        if (index >= 0) entries[index] = { mode: '40000', name, oid: newChild };
        else entries.push({ mode: '40000', name, oid: newChild });
      }
      return this.putObject('tree', buildTree(entries));
    };
    return build(rootOid, 0);
  }

  /** Diff base tree vs head tree: the changed files with line counts. */
  diffFiles(baseTip: string, headTip: string): PullFile[] {
    const baseView = this.commitView(baseTip);
    const headView = this.commitView(headTip);
    if (!baseView || !headView) return [];
    const baseMap = this.flattenTree(baseView.tree);
    const headMap = this.flattenTree(headView.tree);
    const files: PullFile[] = [];
    const paths = new Set([...baseMap.keys(), ...headMap.keys()]);
    for (const path of [...paths].sort()) {
      const b = baseMap.get(path);
      const h = headMap.get(path);
      if (b && h && b.oid === h.oid) continue;
      let status: PullFile['status'];
      let additions = 0;
      let deletions = 0;
      if (!b && h) {
        status = 'added';
        additions = countLines(this.objects.get(h.oid)?.data ?? Buffer.alloc(0));
      } else if (b && !h) {
        status = 'removed';
        deletions = countLines(this.objects.get(b.oid)?.data ?? Buffer.alloc(0));
      } else {
        status = 'modified';
        additions = countLines(this.objects.get((h as { oid: string }).oid)?.data ?? Buffer.alloc(0));
        deletions = countLines(this.objects.get((b as { oid: string }).oid)?.data ?? Buffer.alloc(0));
      }
      files.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    return files;
  }

  /** Would merging `headTip` onto `baseTip` conflict, given the PR was opened at `baseSha`? */
  mergeConflict(baseSha: string, headSha: string, baseTip: string): boolean {
    const baseView = this.commitView(baseSha);
    const headView = this.commitView(headSha);
    const tipView = this.commitView(baseTip);
    if (!baseView || !headView || !tipView) return true;
    const baseMap = this.flattenTree(baseView.tree);
    const headMap = this.flattenTree(headView.tree);
    const tipMap = this.flattenTree(tipView.tree);
    const paths = new Set([...baseMap.keys(), ...headMap.keys()]);
    for (const path of paths) {
      const b = baseMap.get(path)?.oid ?? null;
      const h = headMap.get(path)?.oid ?? null;
      const t = tipMap.get(path)?.oid ?? null;
      if (h === b) continue;
      if (t === b) continue;
      if (h === t) continue;
      return true;
    }
    return false;
  }

  mergeableOf(pull: Pull): string {
    const tip = this.tipOfBranch(pull.baseRef);
    if (!tip) return 'UNKNOWN';
    if (pull.state !== 'open') return 'UNKNOWN';
    return this.mergeConflict(pull.baseSha, pull.headSha, tip) ? 'CONFLICTING' : 'MERGEABLE';
  }

  tipOfBranch(branch: string): string | null {
    const oid = this.refs.get(`refs/heads/${branch}`);
    return oid === undefined ? null : this.peelToCommit(oid);
  }

  refTip(ref: string): string | null {
    const oid = ref.startsWith('refs/')
      ? this.refs.get(ref)
      : (this.refs.get(`refs/heads/${ref}`) ?? this.refs.get(ref));
    return oid === undefined ? null : this.peelToCommit(oid);
  }
}

const repos = new Map<string, Repo>();

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function findRepo(owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return repos.get(repoKey(owner, name));
}

function createRepo(owner: string, name: string, description: string, priv: boolean): Repo {
  const repo = new Repo(owner, name, description, priv);
  repos.set(repoKey(owner, name), repo);
  return repo;
}

// ---------------------------------------------------------------------------------------------
// JSON shapes (issue JSON is cached per issue for the read workload)
// ---------------------------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.globalId,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.priv,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.invalid/${repo.fullName}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

function issueJsonObject(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: '' };
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    html_url: `https://github.invalid/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
    assignee: null,
    locked: false,
  };
}

function issueJsonBuffer(issue: Issue, repo: Repo): Buffer {
  if (issue.json === null) issue.json = Buffer.from(`${JSON.stringify(issueJsonObject(issue, repo))}\n`, 'utf8');
  return issue.json;
}

function pullJsonObject(pull: Pull, repo: Repo): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: repo.mergeableOf(pull),
    mergeable_state: pull.merged ? 'clean' : repo.mergeableOf(pull) === 'MERGEABLE' ? 'clean' : 'dirty',
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
    html_url: `https://github.invalid/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    draft: false,
  };
}

function createIssueInRepo(repo: Repo, title: string, body: string, labels: string[]): Issue {
  repo.seq += 1;
  const issue: Issue = {
    id: nextObjectId++,
    number: repo.seq,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    seq: repo.seq,
    json: null,
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

function createPullInRepo(repo: Repo, title: string, body: string, headRef: string, headSha: string, baseRef: string, baseSha: string): Pull | null {
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) return null;
  }
  repo.seq += 1;
  const pull: Pull = {
    id: nextObjectId++,
    number: repo.seq,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef,
    headSha,
    baseRef,
    baseSha,
    files: repo.diffFiles(baseSha, headSha),
    seq: repo.seq,
  };
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** Squash-merge a pull request onto its base branch. Returns the merge commit sha or null. */
function mergePullInRepo(repo: Repo, pull: Pull): string | null {
  const baseTip = repo.tipOfBranch(pull.baseRef);
  const headView = repo.commitView(pull.headSha);
  if (!baseTip || !headView) return null;
  if (repo.mergeConflict(pull.baseSha, pull.headSha, baseTip)) return null;
  const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
  const commitData = buildCommit(headView.tree, [baseTip], message);
  const commitOid = repo.putObject('commit', commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  repo.bump();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = NOW_ISO;
  pull.mergeCommitSha = commitOid;
  return commitOid;
}

// ---------------------------------------------------------------------------------------------
// git HTTP handlers
// ---------------------------------------------------------------------------------------------

interface FetchResult {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
}

function gitAdvertisementV0(repo: Repo): Buffer {
  if (repo.advV0 !== null) return repo.advV0;
  const out: Buffer[] = [pktLine(Buffer.from('# service=git-upload-pack\n', 'utf8')), flushPacket()];
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const uploadCaps = 'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta multi_ack shallow';
  if (refs.length === 0) {
    out.push(pktLine(Buffer.from(`${ZERO_OID} capabilities^{}\0${uploadCaps}\n`, 'utf8')));
  } else {
    out.push(
      pktLine(
        Buffer.from(
          `${repo.peelToCommit(repo.refs.get('refs/heads/main') ?? refs[0]?.[1] ?? ZERO_OID)} HEAD\0${uploadCaps}\n`,
          'utf8',
        ),
      ),
    );
    for (const [ref, oid] of refs) {
      out.push(pktLine(Buffer.from(`${oid} ${ref}\n`, 'utf8')));
      const object = repo.objects.get(oid);
      if (object && object.type === 'tag') {
        out.push(pktLine(Buffer.from(`${repo.peelToCommit(oid)} ${ref}^{}\n`, 'utf8')));
      }
    }
  }
  out.push(flushPacket());
  const buffer = Buffer.concat(out);
  repo.advV0 = buffer;
  return buffer;
}

function handleLsRefs(repo: Repo, body: Buffer): Buffer {
  const lines = decodePktLines(body).payloads;
  let peel = false;
  let symrefs = false;
  let prefix: string | null = null;
  for (const line of lines) {
    const text = line.toString('utf8').trim();
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text.startsWith('ref-prefix ')) prefix = text.slice('ref-prefix '.length);
  }
  const out: Buffer[] = [];
  const matches = (name: string): boolean => prefix === null || name.startsWith(prefix);
  const headTarget = repo.refs.get('refs/heads/main') ?? null;
  if (headTarget !== null && matches('HEAD')) {
    let line = `${headTarget} HEAD`;
    if (symrefs) line += ` symref-target:refs/heads/main`;
    out.push(pktLine(Buffer.from(`${line}\n`, 'utf8')));
  }
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [ref, oid] of refs) {
    if (!matches(ref)) continue;
    // v2 reports the peel as an attribute on the same line, not a ^{} line.
    let line = `${oid} ${ref}`;
    const object = repo.objects.get(oid);
    if (peel && object && object.type === 'tag') {
      line += ` peeled:${repo.peelToCommit(oid)}`;
    }
    out.push(pktLine(Buffer.from(`${line}\n`, 'utf8')));
  }
  out.push(flushPacket());
  return Buffer.concat(out);
}

/** Commit generation (depth) within `allowed` closure, from `tips`, stopping at `stopAt`. */
function computeDepths(
  repo: Repo,
  tips: string[],
  allowed: Set<string>,
  stopAt: Set<string>,
): Map<string, number> {
  const depths = new Map<string, number>();
  const queue: string[] = [];
  for (const tip of tips) {
    if (allowed.has(tip) && !depths.has(tip)) {
      depths.set(tip, 0);
      queue.push(tip);
    }
  }
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    const depth = depths.get(oid) as number;
    if (stopAt.has(oid)) continue;
    const view = repo.commitView(oid);
    if (!view) continue;
    for (const parent of view.parents) {
      if (!allowed.has(parent)) continue;
      if (!depths.has(parent) || (depths.get(parent) as number) > depth + 1) {
        depths.set(parent, depth + 1);
        queue.push(parent);
      }
    }
  }
  return depths;
}

/**
 * Compute the object set for a fetch: closure(wants) minus closure(haves) within `depth`.
 * `shallowBoundaries` are commits the client already holds as shallow boundaries: they
 * count as held, but their parents are NOT held (the client never received them).
 * Returns pack bytes plus shallow/unshallow oid lists (already git-sorted).
 */
function computeFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | null,
  shallowBoundaries: string[] = [],
): FetchResult {
  const cacheKey = `${wants.slice().sort().join(',')}|${haves.slice().sort().join(',')}|${shallowBoundaries.slice().sort().join(',')}|${depth ?? 0}`;
  const packKey = `${cacheKey}:pack`;
  const packCached = repo.packCache.get(packKey);
  if (packCached) return { pack: packCached.pack, shallow: packCached.shallow, unshallow: packCached.unshallow };

  const wantCommits = wants.map((w) => repo.peelToCommit(w)).filter((w) => repo.commitView(w) !== undefined);
  const haveCommits = haves.map((h) => repo.peelToCommit(h)).filter((h) => repo.commitView(h) !== undefined);
  const boundaryCommits = shallowBoundaries.map((h) => repo.peelToCommit(h)).filter((h) => repo.commitView(h) !== undefined);
  const boundarySet = new Set(boundaryCommits);
  // Held set: walk from haves and boundaries, but never descend past a boundary.
  const haveSet = new Set<string>();
  const heldQueue: string[] = [...haveCommits, ...boundaryCommits];
  const heldSeen = new Set<string>();
  while (heldQueue.length > 0) {
    const oid = heldQueue.pop() as string;
    if (heldSeen.has(oid)) continue;
    heldSeen.add(oid);
    haveSet.add(oid);
    if (boundarySet.has(oid)) continue;
    const view = repo.commitView(oid);
    if (!view) continue;
    for (const parent of view.parents) heldQueue.push(parent);
  }
  const wantSet = new Set<string>();
  for (const want of wantCommits) {
    for (const oid of repo.commitList(want)) wantSet.add(oid);
  }

  // Depths run over the whole wanted closure (a deepen must see past the held tip).
  const depths = computeDepths(repo, wantCommits, wantSet, new Set());
  const sendCommits = new Set<string>();
  const shallow: string[] = [];
  // Depth D includes generations 0..D-1; the boundary (shallow) commits are those
  // at generation D-1. A depth-1 clone carries only the tip, whose parents are cut.
  for (const oid of wantSet) {
    if (haveSet.has(oid)) continue;
    if (depth !== null) {
      const d = depths.get(oid);
      if (d === undefined) continue;
      if (d >= depth) continue;
      if (d === depth - 1) shallow.push(oid);
    }
    sendCommits.add(oid);
  }
  // Objects the client already holds: the held commits plus everything reachable
  // from their trees (never descend past a shallow boundary's parents).
  const heldObjects = new Set<string>();
  {
    const seenCommits = new Set<string>();
    const stack: string[] = [...haveCommits, ...boundaryCommits];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seenCommits.has(oid)) continue;
      seenCommits.add(oid);
      const view = repo.commitView(oid);
      if (!view) continue;
      heldObjects.add(oid);
      for (const treeOid of repo.reachable([view.tree])) heldObjects.add(treeOid);
      if (boundarySet.has(oid)) continue;
      for (const parent of view.parents) stack.push(parent);
    }
  }
  // Boundary commits are included with their trees/blobs but parents are not traversed.
  const include = new Set<string>();
  for (const commit of sendCommits) {
    const view = repo.commitView(commit);
    if (!view) continue;
    include.add(commit);
    const treeReach = repo.reachable([view.tree]);
    for (const oid of treeReach) include.add(oid);
  }
  // Annotated tags whose target is a newly sent commit travel with the fetch
  // (clone follows tags pointing into the fetched history), plus any tag asked
  // for directly. Tags pointing at already-held commits stay behind.
  for (const [oid, object] of repo.objects) {
    if (object.type !== 'tag') continue;
    const target = repo.peelToCommit(oid);
    if (sendCommits.has(target) || wants.includes(oid)) include.add(oid);
  }
  for (const oid of heldObjects) include.delete(oid);
  const pack = writePackForRepo(repo, include);

  const shallowSet = new Set(shallow);
  const unshallow: string[] = [];
  for (const held of [...haveCommits, ...boundaryCommits]) {
    if (shallowSet.has(held)) continue;
    if (!wantSet.has(held)) continue;
    if (!unshallow.includes(held)) unshallow.push(held);
  }
  const result: FetchResult = {
    pack,
    shallow: sortOids(shallow),
    unshallow: sortOids(unshallow),
  };
  repo.packCache.set(packKey, { pack, shallow: result.shallow, unshallow: result.unshallow });
  return result;
}

function sidebandPack(pack: Buffer): Buffer {
  if (pack.length === 0) return flushPacket();
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < pack.length) {
    const size = Math.min(65515, pack.length - offset);
    const payload = Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + size)]);
    chunks.push(pktLine(payload));
    offset += size;
  }
  chunks.push(flushPacket());
  return Buffer.concat(chunks);
}

function parseFetchV2(repo: Repo, body: Buffer): { wants: string[]; haves: string[]; shallow: string[]; depth: number | null } {
  const lines = decodePktLines(body).payloads;
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    const text = line.toString('utf8').trim();
    if (text === 'command=fetch') continue;
    if (text === 'object-format=sha1') continue;
    if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0] as string);
    else if (text.startsWith('have ')) haves.push(text.slice(5).split(' ')[0] as string);
    else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) depth = parseInt(text.slice(7), 10);
    else if (text === 'done') break;
  }
  return { wants, haves, shallow, depth };
}

function handleFetchV2(repo: Repo, body: Buffer): Buffer {
  const { wants, haves, shallow, depth } = parseFetchV2(repo, body);
  const wanted = wants.length === 0 ? [repo.refs.get('refs/heads/main') ?? ''] : wants;
  const validWants = wanted.filter((w) => repo.commitView(repo.peelToCommit(w)) !== undefined);
  const cacheKey = `v2|${validWants.slice().sort().join(',')}|${haves.slice().sort().join(',')}|${shallow.slice().sort().join(',')}|${depth ?? ''}`;
  const cachedResponse = repo.fetchCache.get(cacheKey);
  if (cachedResponse !== undefined) return cachedResponse;
  const result = computeFetch(repo, validWants, haves, depth, shallow);
  const out: Buffer[] = [];
  // acknowledgments
  out.push(pktLine(Buffer.from('acknowledgments\n', 'utf8')));
  const wantSet = new Set<string>();
  for (const want of validWants) {
    for (const oid of repo.commitList(repo.peelToCommit(want))) wantSet.add(oid);
  }
  let acked = false;
  for (const have of haves) {
    const peeled = repo.peelToCommit(have);
    if (wantSet.has(peeled)) {
      out.push(pktLine(Buffer.from(`ACK ${peeled}\n`, 'utf8')));
      acked = true;
    }
  }
  out.push(pktLine(Buffer.from(acked ? 'ready\n' : 'NAK\n', 'utf8')));
  out.push(delimPacket());
  // shallow-info
  out.push(pktLine(Buffer.from('shallow-info\n', 'utf8')));
  if (depth !== null) {
    for (const oid of result.shallow) out.push(pktLine(Buffer.from(`shallow ${oid}\n`, 'utf8')));
    for (const oid of result.unshallow) out.push(pktLine(Buffer.from(`unshallow ${oid}\n`, 'utf8')));
  }
  out.push(delimPacket());
  // packfile
  out.push(pktLine(Buffer.from('packfile\n', 'utf8')));
  out.push(sidebandPack(result.pack));
  const response = Buffer.concat(out);
  repo.fetchCache.set(cacheKey, response);
  return response;
}

function parseFetchV0(repo: Repo, body: Buffer): { wants: string[]; haves: string[]; shallow: string[]; depth: number | null } {
  // v0 sends two sections separated by flush packets: wants (+shallow/deepen), then
  // haves (+done). decodePktLines stops at each flush, so decode twice.
  const first = decodePktLines(body);
  const second = decodePktLines(body, first.next);
  const lines = [...first.payloads, ...second.payloads];
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    const text = line.toString('utf8').trim();
    const [verb, rest] = text.split(' ');
    if (verb === 'want' && rest) wants.push(rest);
    else if (verb === 'have' && rest) haves.push(rest);
    else if (verb === 'shallow' && rest) shallow.push(rest);
    else if (verb === 'deepen' && rest) depth = parseInt(rest, 10);
    else if (text === 'done') break;
  }
  return { wants, haves, shallow, depth };
}

function handleFetchV0(repo: Repo, body: Buffer): Buffer {
  const { wants, haves, shallow, depth } = parseFetchV0(repo, body);
  const validWants = wants.filter((w) => repo.commitView(repo.peelToCommit(w)) !== undefined);
  const result = computeFetch(repo, validWants, haves, depth, shallow);
  const out: Buffer[] = [];
  const wantSet = new Set<string>();
  for (const want of validWants) {
    for (const oid of repo.commitList(repo.peelToCommit(want))) wantSet.add(oid);
  }
  let acked = false;
  for (const have of haves) {
    const peeled = repo.peelToCommit(have);
    if (wantSet.has(peeled)) {
      out.push(pktLine(Buffer.from(`ACK ${peeled}\n`, 'utf8')));
      acked = true;
    }
  }
  if (!acked) out.push(pktLine(Buffer.from('NAK\n', 'utf8')));
  for (const oid of result.shallow) out.push(pktLine(Buffer.from(`shallow ${oid}\n`, 'utf8')));
  for (const oid of result.unshallow) out.push(pktLine(Buffer.from(`unshallow ${oid}\n`, 'utf8')));
  out.push(sidebandPack(result.pack));
  return Buffer.concat(out);
}

/** Receive-pack: apply a client push. Returns the report-status body. */
function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const lines = decodePktLines(body).payloads;
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i]?.toString('utf8').trim() ?? '';
    const parts = text.split(' ');
    if (parts.length >= 3 && isHex40(parts[0] as string) && isHex40(parts[1] as string) && (parts[2] as string).startsWith('refs/')) {
      // The first command line carries the capability list after a NUL byte.
      const ref = (parts[2] as string).split('\0')[0] as string;
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref });
    }
  }
  // The pack begins right after the final flush packet of the command section.
  // Find the first 'PACK' magic after the commands.
  const packIndex = body.indexOf(Buffer.from('PACK', 'ascii'));
  if (packIndex >= 0 && commands.length > 0) {
    const objects = readPack(body.subarray(packIndex));
    for (const object of objects.values()) {
      repo.objects.set(hashObject(object.type, object.data), object);
    }
  }

  const results: { ref: string; ok: boolean; error: string | null }[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.newOid === ZERO_OID) {
      if (command.oldOid === ZERO_OID || command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, error: 'stale reference' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, error: null });
      }
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== ZERO_OID) {
        results.push({ ref: command.ref, ok: false, error: 'already exists' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, error: null });
      }
      continue;
    }
    if (command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, error: 'stale reference' });
      continue;
    }
    // Fast-forward check applies to branch updates (both sides peel to commits);
    // tag refs move freely once the old value matches.
    if (command.ref.startsWith('refs/heads/')) {
      const oldCommit = repo.peelToCommit(command.oldOid);
      const newCommit = repo.peelToCommit(command.newOid);
      if (!repo.isAncestor(oldCommit, newCommit)) {
        results.push({ ref: command.ref, ok: false, error: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, error: null });
  }
  if (commands.length > 0) repo.bump();

  // Real git pkt-frames the report lines *inside* band 1 as well (double framing).
  const reportLines: Buffer[] = [pktLine(Buffer.from('unpack ok\n', 'utf8'))];
  for (const result of results) {
    const text = result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.error ?? 'failed'}\n`;
    reportLines.push(pktLine(Buffer.from(text, 'utf8')));
  }
  const inner = Buffer.concat(reportLines);
  const out: Buffer[] = [];
  let offset = 0;
  while (offset < inner.length) {
    const size = Math.min(65515, inner.length - offset);
    out.push(pktLine(Buffer.concat([Buffer.from([1]), inner.subarray(offset, offset + size)])));
    offset += size;
  }
  out.push(flushPacket());
  return Buffer.concat(out);
}

function handleGit(repo: Repo, action: 'upload-pack' | 'receive-pack', isInfoRefs: boolean, query: URLSearchParams, body: Buffer): { status: number; contentType: string; body: Buffer } {
  if (isInfoRefs) {
    const service = query.get('service');
    if (action === 'upload-pack' && service === 'git-upload-pack') {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: gitAdvertisementV0(repo) };
    }
    if (action === 'receive-pack' && service === 'git-receive-pack') {
      if (repo.advReceive !== null) {
        return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: repo.advReceive };
      }
      const caps = 'report-status side-band-64k delete-refs ofs-delta';
      const headOid = repo.refs.get('refs/heads/main') ?? null;
      const out: Buffer[] = [pktLine(Buffer.from('# service=git-receive-pack\n', 'utf8')), flushPacket()];
      if (headOid === null) {
        out.push(pktLine(Buffer.from(`${ZERO_OID} capabilities^{}\0${caps}\n`, 'utf8')));
      } else {
        out.push(pktLine(Buffer.from(`${repo.peelToCommit(headOid)} HEAD\0${caps}\n`, 'utf8')));
        const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        for (const [ref, oid] of refs) out.push(pktLine(Buffer.from(`${oid} ${ref}\n`, 'utf8')));
      }
      out.push(flushPacket());
      const buffer = Buffer.concat(out);
      repo.advReceive = buffer;
      return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: buffer };
    }
    return { status: 400, contentType: 'application/json', body: jsonBody({ message: 'unknown service' }) };
  }
  if (action === 'upload-pack') {
    // v2 requests start with a `command=` pkt-line; v0 requests start with `want`.
    const lines = decodePktLines(body).payloads;
    const first = lines[0]?.toString('utf8').trim() ?? '';
    if (first.startsWith('command=')) {
      if (first === 'command=ls-refs') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleLsRefs(repo, body) };
      }
      if (first === 'command=fetch') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleFetchV2(repo, body) };
      }
      return { status: 400, contentType: 'application/json', body: jsonBody({ message: 'unknown command' }) };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleFetchV0(repo, body) };
  }
  // receive-pack
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: handleReceivePack(repo, body) };
}

// ---------------------------------------------------------------------------------------------
// REST handlers
// ---------------------------------------------------------------------------------------------

interface Ctx {
  method: string;
  url: URL;
  segments: string[];
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  bodyText: string;
  body: unknown;
  req: IncomingMessage;
  res: ServerResponse;
  host: string;
}

function sendJson(ctx: Ctx, status: number, payload: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  ctx.res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': body.length,
    'X-GitHub-Request-Id': REQUEST_ID,
    ...extraHeaders,
  });
  ctx.res.end(body);
}

function sendBuffer(ctx: Ctx, status: number, contentType: string, body: Buffer, extraHeaders: Record<string, string> = {}): void {
  ctx.res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'X-GitHub-Request-Id': REQUEST_ID,
    ...extraHeaders,
  });
  ctx.res.end(body);
}

function sendError(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

function parseBody(ctx: Ctx): { ok: boolean; value: unknown } {
  if (ctx.bodyText === '') return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(ctx.bodyText) };
  } catch {
    return { ok: false, value: null };
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function intParam(ctx: Ctx, name: string, fallback: number): number {
  const raw = ctx.query.get(name);
  if (raw === null) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function paginate<T>(ctx: Ctx, items: T[]): { page: T[]; link: string | null } {
  const perPage = Math.max(1, Math.min(100, intParam(ctx, 'per_page', 30)));
  const page = Math.max(1, intParam(ctx, 'page', 1));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const next = new URL(ctx.url);
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    link = `<${next.toString()}>; rel="next"`;
  }
  return { page: slice, link };
}

function withLink(ctx: Ctx, link: string | null): Record<string, string> {
  return link === null ? {} : { Link: link };
}

function handleRest(ctx: Ctx): void {
  const s = ctx.segments;
  // Root and top-level
  if (s.length === 0) {
    if (ctx.method === 'GET') {
      sendJson(ctx, 200, { current_user_url: '/api/v3/user' }, { 'X-OAuth-Scopes': 'repo, read:org' });
    } else sendError(ctx, 404, 'Not Found');
    return;
  }
  if (s[0] === 'meta' && s.length === 1) {
    if (ctx.method === 'GET') sendJson(ctx, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    else sendError(ctx, 404, 'Not Found');
    return;
  }
  if (s[0] === 'user' && s.length === 1) {
    if (ctx.method === 'GET') {
      sendJson(ctx, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', email: VIEWER_EMAIL });
    } else sendError(ctx, 404, 'Not Found');
    return;
  }
  if (s[0] === 'user' && s[1] === 'repos') {
    if (ctx.method === 'GET') {
      const all = [...repos.values()]
        .filter((r) => r.owner === VIEWER_LOGIN)
        .sort((a, b) => a.id - b.id)
        .map((r) => repoJson(r));
      const { page, link } = paginate(ctx, all);
      sendJson(ctx, 200, page, withLink(ctx, link));
      return;
    }
    if (ctx.method === 'POST') {
      const parsed = parseBody(ctx);
      if (!parsed.ok) {
        sendError(ctx, 400, 'Bad Request');
        return;
      }
      const body = asObject(parsed.value) ?? {};
      const name = asString(body.name);
      if (name === '') {
        sendError(ctx, 422, 'name is required');
        return;
      }
      if (findRepo(VIEWER_LOGIN, name)) {
        sendError(ctx, 422, 'name already exists on this account');
        return;
      }
      const repo = createRepo(VIEWER_LOGIN, name, asString(body.description), body.private === true);
      sendJson(ctx, 201, repoJson(repo));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  // /repos/{owner}/{repo}/...
  if (s[0] === 'repos' && s.length >= 3) {
    const owner = decodeURIComponent(s[1] as string);
    const name = decodeURIComponent(s[2] as string);
    const repo = findRepo(owner, name);
    if (!repo) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    const rest = s.slice(3);
    handleRepoRest(ctx, repo, rest);
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

function handleRepoRest(ctx: Ctx, repo: Repo, rest: string[]): void {
  // /repos/{owner}/{repo}
  if (rest.length === 0) {
    if (ctx.method === 'GET') {
      sendJson(ctx, 200, repoJson(repo));
      return;
    }
    if (ctx.method === 'PATCH') {
      const parsed = parseBody(ctx);
      if (!parsed.ok) {
        sendError(ctx, 400, 'Bad Request');
        return;
      }
      const body = asObject(parsed.value) ?? {};
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.priv = body.private;
      sendJson(ctx, 200, repoJson(repo));
      return;
    }
    if (ctx.method === 'DELETE') {
      repos.delete(repoKey(repo.owner, repo.name));
      ctx.res.writeHead(204, { 'X-GitHub-Request-Id': REQUEST_ID });
      ctx.res.end();
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  const head = rest[0] as string;

  if (head === 'branches' && rest.length === 1) {
    if (ctx.method === 'GET') {
      const list = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, oid]) => ({
          name: ref.slice('refs/heads/'.length),
          commit: { sha: oid, url: '' },
          protected: false,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      const { page, link } = paginate(ctx, list);
      sendJson(ctx, 200, page, withLink(ctx, link));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (head === 'branches' && rest.length === 2) {
    if (ctx.method === 'GET') {
      const branch = decodeURIComponent(rest[1] as string);
      const tip = repo.tipOfBranch(branch);
      if (!tip) {
        sendError(ctx, 404, 'Not Found');
        return;
      }
      sendJson(ctx, 200, {
        name: branch,
        commit: { sha: tip, url: '' },
        protected: false,
      });
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (head === 'commits' && rest.length === 1) {
    if (ctx.method === 'GET') {
      const sha = ctx.query.get('sha');
      const tip = sha ? repo.refTip(sha) : repo.tipOfBranch(repo.defaultBranch);
      if (!tip) {
        sendError(ctx, 404, 'Not Found');
        return;
      }
      const list = repo.commitList(tip).map((oid) => {
        const view = repo.commitView(oid) as CommitView;
        return {
          sha: oid,
          commit: { message: view.message.replace(/\n$/, ''), author: { name: AUTHOR_NAME, email: AUTHOR_EMAIL, date: NOW_ISO }, committer: { name: AUTHOR_NAME, email: AUTHOR_EMAIL, date: NOW_ISO }, tree: { sha: view.tree } },
          parents: view.parents.map((p) => ({ sha: p })),
          url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
        };
      });
      const { page, link } = paginate(ctx, list);
      sendJson(ctx, 200, page, withLink(ctx, link));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (head === 'git' && rest[1] === 'refs') {
    if (ctx.method === 'POST') {
      const parsed = parseBody(ctx);
      if (!parsed.ok) {
        sendError(ctx, 400, 'Bad Request');
        return;
      }
      const body = asObject(parsed.value) ?? {};
      const ref = asString(body.ref);
      const sha = asString(body.sha);
      if (!ref.startsWith('refs/') || !isHex40(sha) || repo.refs.has(ref)) {
        sendError(ctx, 422, 'Invalid ref');
        return;
      }
      repo.refs.set(ref, sha);
      repo.bump();
      sendJson(ctx, 201, { ref, sha, url: '', object: { sha, type: 'commit', url: '' } });
      return;
    }
    if (ctx.method === 'GET' && rest.length === 3) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const tip = repo.refs.get(ref);
      if (!tip) {
        sendError(ctx, 404, 'Not Found');
        return;
      }
      sendJson(ctx, 200, { ref, sha: tip, url: '' });
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (head === 'contents') {
    handleContents(ctx, repo, rest.slice(1));
    return;
  }

  if (head === 'labels' && rest.length === 1) {
    if (ctx.method === 'POST') {
      const parsed = parseBody(ctx);
      if (!parsed.ok) {
        sendError(ctx, 400, 'Bad Request');
        return;
      }
      const body = asObject(parsed.value) ?? {};
      const name = asString(body.name);
      const color = asString(body.color, 'ededed');
      if (name === '') {
        sendError(ctx, 422, 'name is required');
        return;
      }
      const label: Label = { name, color };
      repo.labels.set(name, label);
      sendJson(ctx, 201, { name, color, description: '' });
      return;
    }
    if (ctx.method === 'GET') {
      const list = [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: '' }));
      sendJson(ctx, 200, list);
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (head === 'issues') {
    handleIssues(ctx, repo, rest.slice(1));
    return;
  }

  if (head === 'pulls') {
    handlePulls(ctx, repo, rest.slice(1));
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

function handleContents(ctx: Ctx, repo: Repo, pathParts: string[]): void {
  const path = pathParts.map((p) => decodeURIComponent(p)).join('/');
  const ref = ctx.query.get('ref') ?? repo.defaultBranch;
  const tip = repo.refTip(ref);
  if (ctx.method === 'GET') {
    if (!tip) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    const view = repo.commitView(tip);
    if (!view) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    if (path === '') {
      const entries = repo.treeEntries(view.tree).map((e) => ({
        type: e.mode === '40000' ? 'dir' : 'file',
        name: e.name,
        path: e.name,
        sha: e.oid,
        size: e.mode === '40000' ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0),
        url: '',
      }));
      sendJson(ctx, 200, entries);
      return;
    }
    const dirOid = repo.dirAt(view.tree, path);
    if (dirOid !== null) {
      const entries = repo.treeEntries(dirOid).map((e) => ({
        type: e.mode === '40000' ? 'dir' : 'file',
        name: e.name,
        path: `${path}/${e.name}`,
        sha: e.oid,
        size: e.mode === '40000' ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0),
        url: '',
      }));
      sendJson(ctx, 200, entries);
      return;
    }
    const blob = repo.blobAt(view.tree, path);
    if (!blob) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    sendJson(ctx, 200, {
      type: 'file',
      name: path.split('/').pop(),
      path,
      sha: blob.oid,
      size: blob.data.length,
      content: blob.data.toString('base64'),
      encoding: 'base64',
      url: '',
    });
    return;
  }

  if (ctx.method === 'PUT') {
    const parsed = parseBody(ctx);
    if (!parsed.ok) {
      sendError(ctx, 400, 'Bad Request');
      return;
    }
    const body = asObject(parsed.value) ?? {};
    const message = asString(body.message, 'Update file');
    const content = asString(body.content);
    const branch = asString(body.branch, repo.defaultBranch);
    const contentBuffer = content === '' ? Buffer.alloc(0) : Buffer.from(content, 'base64');
    let tipOid = repo.tipOfBranch(branch);
    let baseTree: string | null = null;
    if (tipOid !== null) {
      const view = repo.commitView(tipOid);
      if (!view) {
        sendError(ctx, 404, 'Not Found');
        return;
      }
      baseTree = view.tree;
      const existing = repo.blobAt(baseTree, path);
      if (existing && asString(body.sha) !== '' && asString(body.sha) !== existing.oid) {
        sendError(ctx, 409, 'sha does not match');
        return;
      }
      if (!existing && asString(body.sha) !== '') {
        sendError(ctx, 409, 'sha does not match');
        return;
      }
    } else {
      const defaultTip = repo.tipOfBranch(repo.defaultBranch);
      if (defaultTip !== null) {
        const view = repo.commitView(defaultTip);
        if (view) baseTree = view.tree;
      }
    }
    const isCreate = tipOid === null || repo.blobAt(baseTree, path) === null;
    const blobOid = repo.putObject('blob', contentBuffer);
    const newTree = repo.updateTree(baseTree, path, blobOid);
    const parents = tipOid === null ? [] : [tipOid];
    const commitOid = repo.putObject('commit', buildCommit(newTree, parents, `${message}\n`));
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    repo.bump();
    sendJson(ctx, isCreate ? 201 : 200, {
      content: { name: path.split('/').pop(), path, sha: blobOid, size: contentBuffer.length, type: 'file', encoding: 'base64' },
      commit: { sha: commitOid, message },
    });
    return;
  }

  if (ctx.method === 'DELETE') {
    const parsed = parseBody(ctx);
    if (!parsed.ok) {
      sendError(ctx, 400, 'Bad Request');
      return;
    }
    const body = asObject(parsed.value) ?? {};
    const message = asString(body.message, 'Delete file');
    const branch = asString(body.branch, repo.defaultBranch);
    const tipOid = repo.tipOfBranch(branch);
    if (!tipOid) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    const view = repo.commitView(tipOid);
    if (!view) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    const existing = repo.blobAt(view.tree, path);
    if (!existing || asString(body.sha) !== existing.oid) {
      sendError(ctx, 409, 'sha does not match');
      return;
    }
    const newTree = repo.updateTree(view.tree, path, null);
    const commitOid = repo.putObject('commit', buildCommit(newTree, [tipOid], `${message}\n`));
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    repo.bump();
    sendJson(ctx, 200, { commit: { sha: commitOid, message } });
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

function handleIssues(ctx: Ctx, repo: Repo, rest: string[]): void {
  if (rest.length === 0) {
    if (ctx.method === 'POST') {
      const parsed = parseBody(ctx);
      if (!parsed.ok) {
        sendError(ctx, 400, 'Bad Request');
        return;
      }
      const body = asObject(parsed.value) ?? {};
      const title = asString(body.title);
      if (title === '') {
        sendError(ctx, 422, 'title is required');
        return;
      }
      const labels = Array.isArray(body.labels) ? (body.labels as unknown[]).filter((l) => typeof l === 'string') as string[] : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) {
          sendError(ctx, 422, `label does not exist: ${label}`);
          return;
        }
      }
      const issue = createIssueInRepo(repo, title, asString(body.body), labels);
      sendBuffer(ctx, 201, 'application/json', issueJsonBuffer(issue, repo));
      return;
    }
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => {
        const byNumber = sort === 'created' ? a.number - b.number : a.number - b.number;
        return direction === 'asc' ? byNumber : -byNumber;
      });
      const { page, link } = paginate(ctx, list);
      const payload = `[${page.map((i) => JSON.stringify(issueJsonObject(i, repo))).join(',')}]`;
      sendBuffer(ctx, 200, 'application/json', Buffer.from(`${payload}\n`, 'utf8'), withLink(ctx, link));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  const number = parseInt(rest[0] as string, 10);
  if (Number.isNaN(number)) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const issue = repo.issues.get(number);
  if (!issue) {
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (rest.length === 1) {
    if (ctx.method === 'GET') {
      sendBuffer(ctx, 200, 'application/json', issueJsonBuffer(issue, repo));
      return;
    }
    if (ctx.method === 'PATCH') {
      const parsed = parseBody(ctx);
      if (!parsed.ok) {
        sendError(ctx, 400, 'Bad Request');
        return;
      }
      const body = asObject(parsed.value) ?? {};
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (Array.isArray(body.labels)) {
        issue.labels = (body.labels as unknown[]).filter((l) => typeof l === 'string') as string[];
      }
      issue.json = null;
      sendBuffer(ctx, 200, 'application/json', issueJsonBuffer(issue, repo));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (rest[1] === 'comments') {
    if (ctx.method === 'POST') {
      const parsed = parseBody(ctx);
      if (!parsed.ok) {
        sendError(ctx, 400, 'Bad Request');
        return;
      }
      const body = asObject(parsed.value) ?? {};
      const commentBody = asString(body.body);
      if (commentBody === '') {
        sendError(ctx, 422, 'body is required');
        return;
      }
      const comment: Comment = { id: nextCommentSeq++, body: commentBody };
      issue.comments.push(comment);
      issue.json = null;
      sendJson(ctx, 201, {
        id: comment.id,
        node_id: globalId('IssueComment', repo.id, issue.number, comment.id),
        body: comment.body,
        user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
        created_at: NOW_ISO,
        updated_at: NOW_ISO,
        html_url: `https://github.invalid/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
      });
      return;
    }
    if (ctx.method === 'GET') {
      const list = issue.comments.map((c) => ({
        id: c.id,
        node_id: globalId('IssueComment', repo.id, issue.number, c.id),
        body: c.body,
        user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
        created_at: NOW_ISO,
        updated_at: NOW_ISO,
      }));
      const { page, link } = paginate(ctx, list);
      sendJson(ctx, 200, page, withLink(ctx, link));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

function handlePulls(ctx: Ctx, repo: Repo, rest: string[]): void {
  if (rest.length === 0) {
    if (ctx.method === 'POST') {
      const parsed = parseBody(ctx);
      if (!parsed.ok) {
        sendError(ctx, 400, 'Bad Request');
        return;
      }
      const body = asObject(parsed.value) ?? {};
      const title = asString(body.title);
      const headRef = asString(body.head);
      const baseRef = asString(body.base, repo.defaultBranch);
      if (title === '' || headRef === '') {
        sendError(ctx, 422, 'title and head are required');
        return;
      }
      const headTip = repo.tipOfBranch(headRef);
      const baseTip = repo.tipOfBranch(baseRef);
      if (!headTip || !baseTip) {
        sendError(ctx, 422, 'unknown head or base branch');
        return;
      }
      const pull = createPullInRepo(repo, title, asString(body.body), headRef, headTip, baseRef, baseTip);
      if (!pull) {
        sendError(ctx, 422, 'a pull request already exists for this head and base');
        return;
      }
      sendJson(ctx, 201, pullJsonObject(pull, repo));
      return;
    }
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state !== 'all') list = list.filter((p) => p.state === state);
      list.sort((a, b) => b.number - a.number);
      const { page, link } = paginate(ctx, list);
      sendJson(ctx, 200, page.map((p) => pullJsonObject(p, repo)), withLink(ctx, link));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  const number = parseInt(rest[0] as string, 10);
  if (Number.isNaN(number)) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  const pull = repo.pulls.get(number);
  if (!pull) {
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (rest.length === 1) {
    if (ctx.method === 'GET') {
      sendJson(ctx, 200, pullJsonObject(pull, repo));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (rest[1] === 'files' && rest.length === 2) {
    if (ctx.method === 'GET') {
      const list = pull.files.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        patch: '',
      }));
      const { page, link } = paginate(ctx, list);
      sendJson(ctx, 200, page, withLink(ctx, link));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (rest[1] === 'merge' && rest.length === 2) {
    if (ctx.method === 'PUT') {
      if (pull.state !== 'open') {
        sendError(ctx, 405, 'pull request is not open');
        return;
      }
      const baseTip = repo.tipOfBranch(pull.baseRef);
      if (!baseTip) {
        sendError(ctx, 404, 'Not Found');
        return;
      }
      if (repo.mergeConflict(pull.baseSha, pull.headSha, baseTip)) {
        sendError(ctx, 405, 'merge conflict');
        return;
      }
      const sha = mergePullInRepo(repo, pull);
      if (!sha) {
        sendError(ctx, 405, 'merge conflict');
        return;
      }
      sendJson(ctx, 200, { sha, merged: true, message: `Merge pull request #${pull.number}` });
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------------------------

type GqlValue =
  | null
  | boolean
  | number
  | string
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Map<string, GqlValue> };

interface GqlSelection {
  name: string;
  alias: string | null;
  args: Map<string, GqlValue>;
  children: GqlSelection[] | null;
  inlineType: string | null;
  fragmentName: string | null;
}

interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  variableDefs: Map<string, GqlValue>;
  selections: GqlSelection[];
  fragments: Map<string, { type: string; selections: GqlSelection[] }>;
}

class GqlParser {
  private pos = 0;
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  private skipWhitespace(): void {
    while (this.pos < this.text.length) {
      const c = this.text[this.pos] as string;
      if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === ',') {
        this.pos += 1;
        continue;
      }
      if (c === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      break;
    }
  }

  private peek(): string {
    this.skipWhitespace();
    return this.text[this.pos] ?? '';
  }

  private readName(): string {
    this.skipWhitespace();
    const start = this.pos;
    while (this.pos < this.text.length && /[A-Za-z0-9_]/.test(this.text[this.pos] as string)) this.pos += 1;
    return this.text.slice(start, this.pos);
  }

  private expect(char: string): void {
    this.skipWhitespace();
    if (this.text[this.pos] === char) this.pos += 1;
  }

  private readString(): string {
    this.skipWhitespace();
    if (this.text[this.pos] !== '"') return '';
    this.pos += 1;
    let out = '';
    while (this.pos < this.text.length) {
      const c = this.text[this.pos] as string;
      if (c === '"') {
        this.pos += 1;
        break;
      }
      if (c === '\\' && this.pos + 1 < this.text.length) {
        const next = this.text[this.pos + 1] as string;
        const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
        out += escapes[next] ?? next;
        this.pos += 2;
        continue;
      }
      out += c;
      this.pos += 1;
    }
    return out;
  }

  parseValue(): GqlValue {
    this.skipWhitespace();
    const c = this.text[this.pos] ?? '';
    if (c === '"') return this.readString();
    if (c === '$') {
      this.pos += 1;
      return { kind: 'variable', name: this.readName() };
    }
    if (c === '[') {
      this.pos += 1;
      const items: GqlValue[] = [];
      while (this.peek() !== ']' && this.pos < this.text.length) items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (c === '{') {
      this.pos += 1;
      const fields = new Map<string, GqlValue>();
      while (this.peek() !== '}' && this.pos < this.text.length) {
        const name = this.readName();
        this.expect(':');
        fields.set(name, this.parseValue());
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      const start = this.pos;
      while (this.pos < this.text.length && /[0-9eE.+-]/.test(this.text[this.pos] as string)) this.pos += 1;
      return Number(this.text.slice(start, this.pos));
    }
    const name = this.readName();
    if (name === 'true') return true;
    if (name === 'false') return false;
    if (name === 'null') return null;
    return { kind: 'enum', value: name };
  }

  parseArguments(): Map<string, GqlValue> {
    const args = new Map<string, GqlValue>();
    this.skipWhitespace();
    if (this.text[this.pos] !== '(') return args;
    this.pos += 1;
    while (this.peek() !== ')' && this.pos < this.text.length) {
      const name = this.readName();
      this.expect(':');
      args.set(name, this.parseValue());
    }
    this.expect(')');
    return args;
  }

  parseSelections(): GqlSelection[] {
    this.skipWhitespace();
    if (this.text[this.pos] !== '{') return [];
    this.pos += 1;
    const selections: GqlSelection[] = [];
    while (this.pos < this.text.length) {
      this.skipWhitespace();
      if (this.text[this.pos] === '}') {
        this.pos += 1;
        break;
      }
      if (this.text[this.pos] === '.') {
        // Fragment spread or inline fragment
        this.pos += 3;
        this.skipWhitespace();
        if (this.text.slice(this.pos, this.pos + 2) === 'on') {
          this.pos += 2;
          const typeName = this.readName();
          const args = this.parseArguments();
          const children = this.parseSelections();
          selections.push({ name: '', alias: null, args, children, inlineType: typeName, fragmentName: null });
        } else {
          const name = this.readName();
          selections.push({ name: '', alias: null, args: new Map(), children: null, inlineType: null, fragmentName: name });
        }
        continue;
      }
      const first = this.readName();
      let alias: string | null = null;
      let name = first;
      this.skipWhitespace();
      if (this.text[this.pos] === ':') {
        this.pos += 1;
        alias = first;
        name = this.readName();
      }
      const args = this.parseArguments();
      const children = this.peek() === '{' ? this.parseSelections() : null;
      selections.push({ name, alias, args, children, inlineType: null, fragmentName: null });
    }
    return selections;
  }

  parseOperation(): GqlOperation {
    const fragments = new Map<string, { type: string; selections: GqlSelection[] }>();
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const variableDefs = new Map<string, GqlValue>();
    while (this.pos < this.text.length) {
      this.skipWhitespace();
      if (this.pos >= this.text.length) break;
      if (this.text[this.pos] === '{') {
        const selections = this.parseSelections();
        return { kind, name, variableDefs, selections, fragments };
      }
      const keyword = this.readName();
      if (keyword === 'fragment') {
        const fragName = this.readName();
        this.skipWhitespace();
        if (this.text.slice(this.pos, this.pos + 2) === 'on') this.pos += 2;
        const typeName = this.readName();
        const selections = this.parseSelections();
        fragments.set(fragName, { type: typeName, selections });
        continue;
      }
      if (keyword === 'query' || keyword === 'mutation') {
        kind = keyword;
        this.skipWhitespace();
        if (this.peek() !== '(' && this.peek() !== '{') name = this.readName();
        this.skipWhitespace();
        if (this.text[this.pos] === '(') {
          this.pos += 1;
          while (this.peek() !== ')' && this.pos < this.text.length) {
            if (this.peek() === '$') {
              this.pos += 1;
              const varName = this.readName();
              this.expect(':');
              const typeName = this.readName();
              variableDefs.set(varName, { kind: 'enum', value: typeName });
              if (this.peek() === '=') {
                this.pos += 1;
                this.parseValue();
              }
            } else {
              this.pos += 1;
            }
          }
          this.expect(')');
        }
        const selections = this.parseSelections();
        return { kind, name, variableDefs, selections, fragments };
      }
      // Unknown keyword: skip
      this.pos += 1;
    }
    return { kind, name, variableDefs, selections: [], fragments };
  }
}

function resolveGqlValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'object' && 'kind' in value) {
    if (value.kind === 'enum') return value.value;
    if (value.kind === 'variable') return variables[value.name] ?? null;
    if (value.kind === 'list') return value.items.map((item) => resolveGqlValue(item, variables));
    if (value.kind === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of value.fields) out[k] = resolveGqlValue(v, variables);
      return out;
    }
  }
  return null;
}

function argString(selection: GqlSelection, name: string, variables: Record<string, unknown>): string | null {
  const value = selection.args.get(name);
  if (value === undefined) return null;
  const resolved = resolveGqlValue(value, variables);
  return typeof resolved === 'string' ? resolved : null;
}

function argNumber(selection: GqlSelection, name: string, variables: Record<string, unknown>): number | null {
  const value = selection.args.get(name);
  if (value === undefined) return null;
  const resolved = resolveGqlValue(value, variables);
  return typeof resolved === 'number' ? resolved : null;
}

function argEnum(selection: GqlSelection, name: string, variables: Record<string, unknown>): string | null {
  return argString(selection, name, variables);
}

// ---------------------------------------------------------------------------------------------
// GraphQL type introspection data
// ---------------------------------------------------------------------------------------------

const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests',
  ],
  User: ['id', 'login'],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments',
    'createdAt', 'updatedAt', 'repository', 'url',
  ],
  PullRequest: [
    'id', 'number', 'title', 'state', 'body', 'author', 'mergeable', 'merged',
    'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files',
    'createdAt', 'updatedAt', 'repository', 'url',
  ],
  IssueConnection: ['edges', 'nodes', 'totalCount', 'pageInfo'],
  IssueEdge: ['node', 'cursor'],
  PullRequestConnection: ['edges', 'nodes', 'totalCount', 'pageInfo'],
  PullRequestEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Label: ['id', 'name', 'color'],
  IssueComment: ['id', 'body', 'author'],
  Ref: ['name', 'target'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

const GQL_TYPE_KINDS: Record<string, string> = {
  Query: 'OBJECT',
  Repository: 'OBJECT',
  User: 'OBJECT',
  Issue: 'OBJECT',
  PullRequest: 'OBJECT',
  IssueConnection: 'OBJECT',
  PullRequestConnection: 'OBJECT',
  PageInfo: 'OBJECT',
  Label: 'OBJECT',
  IssueComment: 'OBJECT',
  Ref: 'OBJECT',
  Mutation: 'OBJECT',
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
};

function gqlTypeInfo(name: string): Record<string, unknown> {
  const kind = GQL_TYPE_KINDS[name] ?? 'OBJECT';
  const fields = GQL_TYPE_FIELDS[name] ?? [];
  const info: Record<string, unknown> = {
    name,
    kind,
    description: null,
    fields: fields.map((f) => ({ name: f, description: null, args: [], type: { kind: 'SCALAR', name: 'String', ofType: null } })),
    interfaces: [],
    possibleTypes: null,
    enumValues: null,
    inputFields: null,
    ofType: null,
  };
  if (kind === 'ENUM') {
    const values: string[] =
      name === 'SearchType' ? ['ISSUE', 'REPOSITORY', 'USER'] : name === 'IssueState' ? ['OPEN', 'CLOSED'] : ['OPEN', 'CLOSED', 'MERGED'];
    info.enumValues = values.map((v) => ({ name: v, description: null, isDeprecated: false, deprecationReason: null }));
    info.fields = null;
  }
  return info;
}

// ---------------------------------------------------------------------------------------------
// GraphQL executor
// ---------------------------------------------------------------------------------------------

interface GqlContext {
  variables: Record<string, unknown>;
  fragments: Map<string, { type: string; selections: GqlSelection[] }>;
}

function executeSelections(
  typeName: string,
  source: unknown,
  selections: GqlSelection[],
  ctx: GqlContext,
): { data: Record<string, unknown>; error: string | null } {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.fragmentName !== null) {
      const fragment = ctx.fragments.get(selection.fragmentName);
      if (!fragment) continue;
      const result = executeSelections(typeName, source, fragment.selections, ctx);
      if (result.error !== null) return result;
      Object.assign(out, result.data);
      continue;
    }
    if (selection.inlineType !== null) {
      if (selection.inlineType !== typeName) continue;
      const result = executeSelections(typeName, source, selection.children ?? [], ctx);
      if (result.error !== null) return result;
      Object.assign(out, result.data);
      continue;
    }
    const key = selection.alias ?? selection.name;
    const result = executeField(typeName, source, selection, ctx);
    if (result.error !== null) return { data: {}, error: result.error };
    out[key] = result.value;
  }
  return { data: out, error: null };
}

function executeField(
  typeName: string,
  source: unknown,
  selection: GqlSelection,
  ctx: GqlContext,
): { value: unknown; error: string | null } {
  const name = selection.name;
  const children = selection.children ?? [];

  if (name === '__typename') return { value: typeName, error: null };

  if (typeName === 'Query') {
    if (name === 'viewer') {
      const result = executeSelections('User', { login: VIEWER_LOGIN, id: VIEWER_ID }, children, ctx);
      return { value: result.data, error: result.error };
    }
    if (name === 'repository') {
      const owner = argString(selection, 'owner', ctx.variables);
      const repoName = argString(selection, 'name', ctx.variables);
      const repo = owner !== null && repoName !== null ? findRepo(owner, repoName) : undefined;
      if (!repo) return { value: null, error: null };
      const result = executeSelections('Repository', repo, children, ctx);
      return { value: result.data, error: result.error };
    }
    if (name === 'node') {
      const id = argString(selection, 'id', ctx.variables);
      const decoded = id !== null ? decodeGlobalId(id) : null;
      if (!decoded || decoded.kind !== 'Repository') return { value: null, error: null };
      const repoId = parseInt(decoded.parts[0] as string, 10);
      const repo = [...repos.values()].find((r) => r.id === repoId);
      if (!repo) return { value: null, error: null };
      const result = executeSelections('Repository', repo, children, ctx);
      return { value: result.data, error: result.error };
    }
    if (name === '__type') {
      const typeNameArg = argString(selection, 'name', ctx.variables);
      if (typeNameArg === null) return { value: null, error: null };
      const result = executeSelections('__Type', gqlTypeInfo(typeNameArg), children, ctx);
      return { value: result.data, error: result.error };
    }
    return { value: null, error: `Cannot query field "${name}" on type "Query"` };
  }

  if (typeName === '__Type') {
    const info = source as Record<string, unknown>;
    if (name === 'name' || name === 'kind' || name === 'description' || name === 'fields' || name === 'enumValues' || name === 'interfaces' || name === 'possibleTypes' || name === 'inputFields' || name === 'ofType') {
      const value = info[name];
      if (Array.isArray(value)) {
        const mapped = value.map((item) => {
          const result = executeSelections('__Field', item, children, ctx);
          return result.error !== null ? null : result.data;
        });
        return { value: mapped, error: null };
      }
      if (value !== null && typeof value === 'object') {
        const result = executeSelections('__Type', value, children, ctx);
        return { value: result.data, error: result.error };
      }
      return { value: value ?? null, error: null };
    }
    return { value: null, error: `Cannot query field "${name}" on type "__Type"` };
  }

  if (typeName === '__Field') {
    const info = source as Record<string, unknown>;
    if (name === 'name' || name === 'description') return { value: info[name] ?? null, error: null };
    if (name === 'args') return { value: [], error: null };
    if (name === 'type') {
      const typeValue = info.type as Record<string, unknown> | undefined;
      if (typeValue) {
        const result = executeSelections('__Type', typeValue, children, ctx);
        return { value: result.data, error: result.error };
      }
      return { value: null, error: null };
    }
    return { value: null, error: `Cannot query field "${name}" on type "__Field"` };
  }

  if (typeName === 'Repository') {
    const repo = source as Repo;
    switch (name) {
      case 'id':
        return { value: repo.globalId, error: null };
      case 'databaseId':
        return { value: repo.id, error: null };
      case 'name':
        return { value: repo.name, error: null };
      case 'nameWithOwner':
        return { value: repo.fullName, error: null };
      case 'owner': {
        const result = executeSelections('User', { login: repo.owner, id: VIEWER_ID }, children, ctx);
        return { value: result.data, error: result.error };
      }
      case 'defaultBranchRef': {
        const tip = repo.tipOfBranch(repo.defaultBranch);
        const result = executeSelections('Ref', { name: repo.defaultBranch, target: tip }, children, ctx);
        return { value: result.data, error: result.error };
      }
      case 'viewerPermission':
        return { value: 'ADMIN', error: null };
      case 'hasIssuesEnabled':
        return { value: true, error: null };
      case 'issue': {
        const number = argNumber(selection, 'number', ctx.variables);
        const issue = number !== null ? repo.issues.get(number) : undefined;
        if (!issue) return { value: null, error: null };
        const result = executeSelections('Issue', { repo, issue }, children, ctx);
        return { value: result.data, error: result.error };
      }
      case 'issues': {
        const statesRaw = selection.args.get('states');
        const first = argNumber(selection, 'first', ctx.variables) ?? 100;
        const after = argString(selection, 'after', ctx.variables);
        let list = [...repo.issues.values()].sort((a, b) => b.number - a.number);
        if (statesRaw !== undefined) {
          const resolved = resolveGqlValue(statesRaw, ctx.variables);
          const wanted = (Array.isArray(resolved) ? resolved : [resolved]).filter(
            (v): v is string => typeof v === 'string',
          );
          if (wanted.length > 0) {
            list = list.filter((i) => wanted.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
          }
        }
        let startIndex = 0;
        if (after !== null) {
          const decoded = Buffer.from(after, 'base64').toString('utf8');
          const match = /^cursor:(\d+)$/.exec(decoded);
          if (match) {
            const cursorNumber = parseInt(match[1] as string, 10);
            const idx = list.findIndex((i) => i.number === cursorNumber);
            if (idx >= 0) startIndex = idx + 1;
          }
        }
        const window = list.slice(startIndex, startIndex + first);
        const edges = window.map((issue) => ({ node: { repo, issue }, cursor: Buffer.from(`cursor:${issue.number}`, 'utf8').toString('base64') }));
        const pageInfo = {
          hasNextPage: startIndex + first < list.length,
          hasPreviousPage: startIndex > 0,
          startCursor: edges.length > 0 ? (edges[0] as { cursor: string }).cursor : null,
          endCursor: edges.length > 0 ? (edges[edges.length - 1] as { cursor: string }).cursor : null,
        };
        const result = executeSelections('IssueConnection', { edges, pageInfo, totalCount: list.length }, children, ctx);
        return { value: result.data, error: result.error };
      }
      case 'pullRequest': {
        const number = argNumber(selection, 'number', ctx.variables);
        const pull = number !== null ? repo.pulls.get(number) : undefined;
        if (!pull) return { value: null, error: null };
        const result = executeSelections('PullRequest', { repo, pull }, children, ctx);
        return { value: result.data, error: result.error };
      }
      case 'pullRequests': {
        const first = argNumber(selection, 'first', ctx.variables) ?? 100;
        const list = [...repo.pulls.values()].sort((a, b) => b.number - a.number).slice(0, first);
        const edges = list.map((pull) => ({ node: { repo, pull }, cursor: Buffer.from(`cursor:${pull.number}`, 'utf8').toString('base64') }));
        const pageInfo = {
          hasNextPage: false,
          hasPreviousPage: false,
          startCursor: edges.length > 0 ? (edges[0] as { cursor: string }).cursor : null,
          endCursor: edges.length > 0 ? (edges[edges.length - 1] as { cursor: string }).cursor : null,
        };
        const result = executeSelections('PullRequestConnection', { edges, pageInfo, totalCount: repo.pulls.size }, children, ctx);
        return { value: result.data, error: result.error };
      }
      default:
        return { value: null, error: `Cannot query field "${name}" on type "Repository"` };
    }
  }

  if (typeName === 'User') {
    const user = source as { login: string; id: number };
    if (name === 'login') return { value: user.login, error: null };
    if (name === 'id') return { value: globalId('User', user.id), error: null };
    return { value: null, error: `Cannot query field "${name}" on type "User"` };
  }

  if (typeName === 'Issue') {
    const { repo, issue } = source as { repo: Repo; issue: Issue };
    switch (name) {
      case 'id':
        return { value: globalId('Issue', repo.id, issue.number), error: null };
      case 'number':
        return { value: issue.number, error: null };
      case 'title':
        return { value: issue.title, error: null };
      case 'body':
        return { value: issue.body, error: null };
      case 'state':
        return { value: issue.state === 'open' ? 'OPEN' : 'CLOSED', error: null };
      case 'author': {
        const result = executeSelections('User', { login: VIEWER_LOGIN, id: VIEWER_ID }, children, ctx);
        return { value: result.data, error: result.error };
      }
      case 'labels':
        return { value: issue.labels.map((l) => ({ name: l, color: repo.labels.get(l)?.color ?? 'ededed' })), error: null };
      case 'comments': {
        const first = argNumber(selection, 'first', ctx.variables) ?? 100;
        const window = issue.comments.slice(0, first);
        const edges = window.map((c) => ({
          node: { id: globalId('IssueComment', repo.id, issue.number, c.id), body: c.body },
          cursor: Buffer.from(`cursor:${c.id}`, 'utf8').toString('base64'),
        }));
        const pageInfo = {
          hasNextPage: issue.comments.length > first,
          hasPreviousPage: false,
          startCursor: edges.length > 0 ? (edges[0] as { cursor: string }).cursor : null,
          endCursor: edges.length > 0 ? (edges[edges.length - 1] as { cursor: string }).cursor : null,
        };
        const result = executeSelections('IssueCommentConnection', { edges, pageInfo, totalCount: issue.comments.length }, children, ctx);
        return { value: result.data, error: result.error };
      }
      case 'createdAt':
      case 'updatedAt':
        return { value: NOW_ISO, error: null };
      case 'repository': {
        const result = executeSelections('Repository', repo, children, ctx);
        return { value: result.data, error: result.error };
      }
      case 'url':
        return { value: `https://github.invalid/${repo.fullName}/issues/${issue.number}`, error: null };
      default:
        return { value: null, error: `Cannot query field "${name}" on type "Issue"` };
    }
  }

  if (typeName === 'PullRequest') {
    const { repo, pull } = source as { repo: Repo; pull: Pull };
    switch (name) {
      case 'id':
        return { value: globalId('PullRequest', repo.id, pull.number), error: null };
      case 'number':
        return { value: pull.number, error: null };
      case 'title':
        return { value: pull.title, error: null };
      case 'body':
        return { value: pull.body, error: null };
      case 'state':
        return { value: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED', error: null };
      case 'merged':
        return { value: pull.merged, error: null };
      case 'mergeable':
        return { value: repo.mergeableOf(pull), error: null };
      case 'author': {
        const result = executeSelections('User', { login: VIEWER_LOGIN, id: VIEWER_ID }, children, ctx);
        return { value: result.data, error: result.error };
      }
      case 'headRefName':
        return { value: pull.headRef, error: null };
      case 'baseRefName':
        return { value: pull.baseRef, error: null };
      case 'headRefOid':
        return { value: pull.headSha, error: null };
      case 'baseRefOid':
        return { value: pull.baseSha, error: null };
      case 'files': {
        const first = argNumber(selection, 'first', ctx.variables) ?? 100;
        const window = pull.files.slice(0, first);
        const edges = window.map((f, index) => ({
          node: f,
          cursor: Buffer.from(`cursor:${index}`, 'utf8').toString('base64'),
        }));
        const pageInfo = {
          hasNextPage: pull.files.length > first,
          hasPreviousPage: false,
          startCursor: edges.length > 0 ? (edges[0] as { cursor: string }).cursor : null,
          endCursor: edges.length > 0 ? (edges[edges.length - 1] as { cursor: string }).cursor : null,
        };
        const result = executeSelections('PullRequestFileConnection', { edges, pageInfo, totalCount: pull.files.length }, children, ctx);
        return { value: result.data, error: result.error };
      }
      case 'createdAt':
      case 'updatedAt':
        return { value: NOW_ISO, error: null };
      case 'repository': {
        const result = executeSelections('Repository', repo, children, ctx);
        return { value: result.data, error: result.error };
      }
      case 'url':
        return { value: `https://github.invalid/${repo.fullName}/pull/${pull.number}`, error: null };
      default:
        return { value: null, error: `Cannot query field "${name}" on type "PullRequest"` };
    }
  }

  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection') {
    const conn = source as { edges: { node: unknown; cursor: string }[]; pageInfo: Record<string, unknown>; totalCount: number };
    if (name === 'totalCount') return { value: conn.totalCount, error: null };
    if (name === 'pageInfo') {
      const result = executeSelections('PageInfo', conn.pageInfo, children, ctx);
      return { value: result.data, error: result.error };
    }
    if (name === 'edges') {
      const nodeType = typeName === 'IssueConnection' ? 'IssueEdge' : 'PullRequestEdge';
      const mapped = conn.edges.map((edge) => {
        const result = executeSelections(nodeType, edge, children, ctx);
        return result.error !== null ? null : result.data;
      });
      return { value: mapped, error: null };
    }
    if (name === 'nodes') {
      const nodeType = typeName === 'IssueConnection' ? 'Issue' : 'PullRequest';
      const mapped = conn.edges.map((edge) => {
        const result = executeSelections(nodeType, edge.node, children, ctx);
        return result.error !== null ? null : result.data;
      });
      return { value: mapped, error: null };
    }
    return { value: null, error: `Cannot query field "${name}" on type "${typeName}"` };
  }

  if (typeName === 'IssueEdge' || typeName === 'PullRequestEdge') {
    const edge = source as { node: unknown; cursor: string };
    if (name === 'cursor') return { value: edge.cursor, error: null };
    if (name === 'node') {
      const nodeType = typeName === 'IssueEdge' ? 'Issue' : 'PullRequest';
      const result = executeSelections(nodeType, edge.node, children, ctx);
      return { value: result.data, error: result.error };
    }
    return { value: null, error: `Cannot query field "${name}" on type "${typeName}"` };
  }

  if (typeName === 'PageInfo') {
    const info = source as Record<string, unknown>;
    if (name === 'hasNextPage' || name === 'hasPreviousPage' || name === 'startCursor' || name === 'endCursor') {
      return { value: info[name] ?? null, error: null };
    }
    return { value: null, error: `Cannot query field "${name}" on type "PageInfo"` };
  }

  if (typeName === 'Ref') {
    const ref = source as { name: string; target: string | null };
    if (name === 'name') return { value: ref.name, error: null };
    if (name === 'target') return { value: ref.target, error: null };
    return { value: null, error: `Cannot query field "${name}" on type "Ref"` };
  }

  if (typeName === 'Mutation') {
    const mutation = executeMutationField(selection, ctx);
    if (mutation.error !== null) return { value: null, error: mutation.error };
    const result = executeSelections(mutation.payloadType, mutation.payload, children, ctx);
    return { value: result.data, error: result.error };
  }

  if (
    typeName === 'IssueCreatePayload' ||
    typeName === 'IssueClosePayload'
  ) {
    const payload = source as { issue: { repo: Repo; issue: Issue } };
    if (name === 'issue') {
      const result = executeSelections('Issue', payload.issue, children, ctx);
      return { value: result.data, error: result.error };
    }
    return { value: null, error: `Cannot query field "${name}" on type "${typeName}"` };
  }

  if (
    typeName === 'PullRequestCreatePayload' ||
    typeName === 'PullRequestMergePayload'
  ) {
    const payload = source as { pullRequest: { repo: Repo; pull: Pull } };
    if (name === 'pullRequest') {
      const result = executeSelections('PullRequest', payload.pullRequest, children, ctx);
      return { value: result.data, error: result.error };
    }
    return { value: null, error: `Cannot query field "${name}" on type "${typeName}"` };
  }

  if (typeName === 'AddCommentPayload') {
    const payload = source as { commentEdge: { node: { id: string; body: string }; cursor: string } };
    if (name === 'commentEdge') {
      const result = executeSelections('IssueCommentEdge', payload.commentEdge, children, ctx);
      return { value: result.data, error: result.error };
    }
    return { value: null, error: `Cannot query field "${name}" on type "${typeName}"` };
  }

  if (typeName === 'IssueCommentEdge') {
    const edge = source as { node: { id: string; body: string }; cursor: string };
    if (name === 'cursor') return { value: edge.cursor, error: null };
    if (name === 'node') {
      const result = executeSelections('IssueComment', edge.node, children, ctx);
      return { value: result.data, error: result.error };
    }
    return { value: null, error: `Cannot query field "${name}" on type "IssueCommentEdge"` };
  }

  if (typeName === 'IssueComment') {
    const comment = source as { id: string; body: string };
    if (name === 'id') return { value: comment.id, error: null };
    if (name === 'body') return { value: comment.body, error: null };
    if (name === 'author') {
      const result = executeSelections('User', { login: VIEWER_LOGIN, id: VIEWER_ID }, children, ctx);
      return { value: result.data, error: result.error };
    }
    if (name === 'createdAt' || name === 'updatedAt') return { value: NOW_ISO, error: null };
    return { value: null, error: `Cannot query field "${name}" on type "IssueComment"` };
  }

  if (typeName === 'IssueCommentConnection') {
    const conn = source as { edges: { node: unknown; cursor: string }[]; pageInfo: Record<string, unknown>; totalCount: number };
    if (name === 'totalCount') return { value: conn.totalCount, error: null };
    if (name === 'pageInfo') {
      const result = executeSelections('PageInfo', conn.pageInfo, children, ctx);
      return { value: result.data, error: result.error };
    }
    if (name === 'edges') {
      const mapped = conn.edges.map((edge) => {
        const result = executeSelections('IssueCommentEdge', edge, children, ctx);
        return result.error !== null ? null : result.data;
      });
      return { value: mapped, error: null };
    }
    if (name === 'nodes') {
      const mapped = conn.edges.map((edge) => {
        const result = executeSelections('IssueComment', edge.node, children, ctx);
        return result.error !== null ? null : result.data;
      });
      return { value: mapped, error: null };
    }
    return { value: null, error: `Cannot query field "${name}" on type "IssueCommentConnection"` };
  }

  if (typeName === 'PullRequestFileConnection') {
    const conn = source as { edges: { node: PullFile; cursor: string }[]; pageInfo: Record<string, unknown>; totalCount: number };
    if (name === 'totalCount') return { value: conn.totalCount, error: null };
    if (name === 'pageInfo') {
      const result = executeSelections('PageInfo', conn.pageInfo, children, ctx);
      return { value: result.data, error: result.error };
    }
    if (name === 'edges') {
      const mapped = conn.edges.map((edge) => {
        const result = executeSelections('PullRequestFileEdge', edge, children, ctx);
        return result.error !== null ? null : result.data;
      });
      return { value: mapped, error: null };
    }
    if (name === 'nodes') {
      const mapped = conn.edges.map((edge) => {
        const result = executeSelections('PullRequestFile', edge.node, children, ctx);
        return result.error !== null ? null : result.data;
      });
      return { value: mapped, error: null };
    }
    return { value: null, error: `Cannot query field "${name}" on type "PullRequestFileConnection"` };
  }

  if (typeName === 'PullRequestFileEdge') {
    const edge = source as { node: PullFile; cursor: string };
    if (name === 'cursor') return { value: edge.cursor, error: null };
    if (name === 'node') {
      const result = executeSelections('PullRequestFile', edge.node, children, ctx);
      return { value: result.data, error: result.error };
    }
    return { value: null, error: `Cannot query field "${name}" on type "PullRequestFileEdge"` };
  }

  if (typeName === 'PullRequestFile') {
    const file = source as PullFile;
    if (name === 'path') return { value: file.filename, error: null };
    if (name === 'additions') return { value: file.additions, error: null };
    if (name === 'deletions') return { value: file.deletions, error: null };
    if (name === 'changeType') return { value: file.status.toUpperCase(), error: null };
    return { value: null, error: `Cannot query field "${name}" on type "PullRequestFile"` };
  }

  return { value: null, error: `Cannot query field "${name}" on type "${typeName}"` };
}

interface MutationOutcome {
  payloadType: string;
  payload: Record<string, unknown>;
  error: string | null;
}

function executeMutationField(
  selection: GqlSelection,
  ctx: GqlContext,
): MutationOutcome {
  const name = selection.name;
  const input = selection.args.get('input');
  const inputObj = input !== undefined ? resolveGqlValue(input, ctx.variables) : null;
  const inputRecord = inputObj !== null && typeof inputObj === 'object' && !Array.isArray(inputObj) ? (inputObj as Record<string, unknown>) : {};

  if (name === 'createIssue') {
    const repoId = inputRecord.repositoryId as string | undefined;
    const decoded = typeof repoId === 'string' ? decodeGlobalId(repoId) : null;
    const repo = decoded && decoded.kind === 'Repository' ? [...repos.values()].find((r) => r.id === parseInt(decoded.parts[0] as string, 10)) : undefined;
    if (!repo) return { payloadType: '', payload: {}, error: 'repository not found' };
    const issue = createIssueInRepo(repo, String(inputRecord.title ?? ''), String(inputRecord.body ?? ''), []);
    return { payloadType: 'IssueCreatePayload', payload: { issue: { repo, issue } }, error: null };
  }

  if (name === 'closeIssue') {
    const issueId = inputRecord.issueId as string | undefined;
    const decoded = typeof issueId === 'string' ? decodeGlobalId(issueId) : null;
    if (!decoded || decoded.kind !== 'Issue') return { payloadType: '', payload: {}, error: 'issue not found' };
    const repo = [...repos.values()].find((r) => r.id === parseInt(decoded.parts[0] as string, 10));
    const issue = repo?.issues.get(parseInt(decoded.parts[1] as string, 10));
    if (!repo || !issue) return { payloadType: '', payload: {}, error: 'issue not found' };
    issue.state = 'closed';
    issue.json = null;
    return { payloadType: 'IssueClosePayload', payload: { issue: { repo, issue } }, error: null };
  }

  if (name === 'createPullRequest') {
    const repoId = inputRecord.repositoryId as string | undefined;
    const decoded = typeof repoId === 'string' ? decodeGlobalId(repoId) : null;
    const repo = decoded && decoded.kind === 'Repository' ? [...repos.values()].find((r) => r.id === parseInt(decoded.parts[0] as string, 10)) : undefined;
    if (!repo) return { payloadType: '', payload: {}, error: 'repository not found' };
    const headRef = String(inputRecord.headRefName ?? '');
    const baseRef = String(inputRecord.baseRefName ?? repo.defaultBranch);
    const headTip = repo.tipOfBranch(headRef);
    const baseTip = repo.tipOfBranch(baseRef);
    if (!headTip || !baseTip) return { payloadType: '', payload: {}, error: 'unknown head or base branch' };
    const pull = createPullInRepo(repo, String(inputRecord.title ?? ''), String(inputRecord.body ?? ''), headRef, headTip, baseRef, baseTip);
    if (!pull) return { payloadType: '', payload: {}, error: 'a pull request already exists for this head and base' };
    return { payloadType: 'PullRequestCreatePayload', payload: { pullRequest: { repo, pull } }, error: null };
  }

  if (name === 'mergePullRequest') {
    const pullId = inputRecord.pullRequestId as string | undefined;
    const decoded = typeof pullId === 'string' ? decodeGlobalId(pullId) : null;
    if (!decoded || decoded.kind !== 'PullRequest') return { payloadType: '', payload: {}, error: 'pull request not found' };
    const repo = [...repos.values()].find((r) => r.id === parseInt(decoded.parts[0] as string, 10));
    const pull = repo?.pulls.get(parseInt(decoded.parts[1] as string, 10));
    if (!repo || !pull) return { payloadType: '', payload: {}, error: 'pull request not found' };
    if (pull.state !== 'open') return { payloadType: '', payload: {}, error: 'pull request is not open' };
    const baseTip = repo.tipOfBranch(pull.baseRef);
    if (!baseTip || repo.mergeConflict(pull.baseSha, pull.headSha, baseTip)) {
      return { payloadType: '', payload: {}, error: 'merge conflict' };
    }
    const sha = mergePullInRepo(repo, pull);
    if (!sha) return { payloadType: '', payload: {}, error: 'merge conflict' };
    return { payloadType: 'PullRequestMergePayload', payload: { pullRequest: { repo, pull } }, error: null };
  }

  if (name === 'addComment') {
    const subjectId = inputRecord.subjectId as string | undefined;
    const decoded = typeof subjectId === 'string' ? decodeGlobalId(subjectId) : null;
    if (!decoded || decoded.kind !== 'Issue') return { payloadType: '', payload: {}, error: 'issue not found' };
    const repo = [...repos.values()].find((r) => r.id === parseInt(decoded.parts[0] as string, 10));
    const issue = repo?.issues.get(parseInt(decoded.parts[1] as string, 10));
    if (!repo || !issue) return { payloadType: '', payload: {}, error: 'issue not found' };
    const comment: Comment = { id: nextCommentSeq++, body: String(inputRecord.body ?? '') };
    issue.comments.push(comment);
    issue.json = null;
    const node = { id: globalId('IssueComment', repo.id, issue.number, comment.id), body: comment.body };
    return {
      payloadType: 'AddCommentPayload',
      payload: { commentEdge: { node, cursor: Buffer.from(`cursor:${comment.id}`, 'utf8').toString('base64') } },
      error: null,
    };
  }

  return { payloadType: '', payload: {}, error: `Cannot query field "${name}" on type "Mutation"` };
}

function executeGraphQLOperation(operation: GqlOperation, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: GqlContext = { variables, fragments: operation.fragments };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const result = executeSelections(rootType, null, operation.selections, ctx);
  if (result.error !== null) {
    return { data: null, errors: [{ message: result.error }] };
  }
  return { data: result.data };
}

function handleGraphQL(ctx: Ctx): void {
  let payload: unknown;
  try {
    payload = JSON.parse(ctx.bodyText);
  } catch {
    sendJson(ctx, 400, { errors: [{ message: 'request body is not valid JSON' }] });
    return;
  }
  const requests = Array.isArray(payload) ? payload : [payload];
  const responses: Record<string, unknown>[] = [];
  for (const request of requests) {
    const record = asObject(request) ?? {};
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = asObject(record.variables) ?? {};
    if (query === '') {
      responses.push({ data: null, errors: [{ message: 'query is required' }] });
      continue;
    }
    try {
      const operation = new GqlParser(query).parseOperation();
      responses.push(executeGraphQLOperation(operation, variables as Record<string, unknown>));
    } catch (error) {
      responses.push({ data: null, errors: [{ message: error instanceof Error ? error.message : 'parse error' }] });
    }
  }
  const response = Array.isArray(payload) ? responses : responses[0];
  sendJson(ctx, 200, response as unknown);
}

// ---------------------------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------------------------

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        owner: { type: 'string', description: 'Owner login (defaults to the viewer)' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function mcpResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function mcpError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function mcpToolResult(id: unknown, data: unknown, isError = false): Record<string, unknown> {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  const result: Record<string, unknown> = {
    content: [{ type: 'text', text }],
    structuredContent: data,
  };
  if (isError) result.isError = true;
  return mcpResult(id, result);
}

function mcpCallTool(id: unknown, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (!tool) return mcpError(id, -32602, `unknown tool: ${name}`);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return mcpToolResult(id, { error: `missing required argument: ${required}` }, true);
    }
  }
  const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : VIEWER_LOGIN;
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (findRepo(owner, repoName)) return mcpToolResult(id, { error: 'name already exists on this account' }, true);
      const repo = createRepo(owner, repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
      return mcpToolResult(id, repoJson(repo));
    }
    case 'get_repo': {
      const repo = findRepo(owner, String(args.repo));
      if (!repo) return mcpToolResult(id, { error: 'Not Found' }, true);
      return mcpToolResult(id, repoJson(repo));
    }
    case 'create_issue': {
      const repo = findRepo(owner, String(args.repo));
      if (!repo) return mcpToolResult(id, { error: 'Not Found' }, true);
      const issue = createIssueInRepo(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      return mcpToolResult(id, issueJsonObject(issue, repo));
    }
    case 'list_issues': {
      const repo = findRepo(owner, String(args.repo));
      if (!repo) return mcpToolResult(id, { error: 'Not Found' }, true);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => b.number - a.number);
      return mcpToolResult(id, list.map((i) => issueJsonObject(i, repo)));
    }
    case 'create_pull_request': {
      const repo = findRepo(owner, String(args.repo));
      if (!repo) return mcpToolResult(id, { error: 'Not Found' }, true);
      const headTip = repo.tipOfBranch(String(args.head));
      const baseTip = repo.tipOfBranch(String(args.base));
      if (!headTip || !baseTip) return mcpToolResult(id, { error: 'unknown head or base branch' }, true);
      const pull = createPullInRepo(repo, String(args.title), typeof args.body === 'string' ? args.body : '', String(args.head), headTip, String(args.base), baseTip);
      if (!pull) return mcpToolResult(id, { error: 'a pull request already exists for this head and base' }, true);
      return mcpToolResult(id, pullJsonObject(pull, repo));
    }
    case 'merge_pull_request': {
      const repo = findRepo(owner, String(args.repo));
      if (!repo) return mcpToolResult(id, { error: 'Not Found' }, true);
      const pull = repo.pulls.get(Number(args.pull_number));
      if (!pull) return mcpToolResult(id, { error: 'Not Found' }, true);
      if (pull.state !== 'open') return mcpToolResult(id, { error: 'pull request is not open' }, true);
      const baseTip = repo.tipOfBranch(pull.baseRef);
      if (!baseTip || repo.mergeConflict(pull.baseSha, pull.headSha, baseTip)) {
        return mcpToolResult(id, { error: 'merge conflict' }, true);
      }
      const sha = mergePullInRepo(repo, pull);
      if (!sha) return mcpToolResult(id, { error: 'merge conflict' }, true);
      return mcpToolResult(id, { sha, merged: true, message: `Merge pull request #${pull.number}` });
    }
    default:
      return mcpError(id, -32602, `unknown tool: ${name}`);
  }
}

function handleMcp(ctx: Ctx): void {
  let payload: unknown;
  try {
    payload = JSON.parse(ctx.bodyText);
  } catch {
    sendJson(ctx, 400, mcpError(null, -32700, 'Parse error'));
    return;
  }
  const requests = Array.isArray(payload) ? payload : [payload];
  const responses: Record<string, unknown>[] = [];
  for (const request of requests) {
    const record = asObject(request) ?? {};
    const id = record.id ?? null;
    const method = typeof record.method === 'string' ? record.method : '';
    const params = asObject(record.params) ?? {};
    if (method === 'initialize') {
      responses.push(
        mcpResult(id, {
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'github-core-forge', version: '1.0.0' },
        }),
      );
      continue;
    }
    if (method === 'notifications/initialized') {
      responses.push(mcpResult(id, {}));
      continue;
    }
    if (method === 'server/discover') {
      responses.push(
        mcpResult(id, {
          supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'github-core-forge', version: '1.0.0' },
          _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'github-core-forge', version: '1.0.0' } },
        }),
      );
      continue;
    }
    if (method === 'tools/list') {
      responses.push(mcpResult(id, { tools: MCP_TOOLS }));
      continue;
    }
    if (method === 'tools/call') {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = asObject(params.arguments) ?? {};
      responses.push(mcpCallTool(id, toolName, args as Record<string, unknown>));
      continue;
    }
    if (method === 'ping') {
      responses.push(mcpResult(id, {}));
      continue;
    }
    responses.push(mcpError(id, -32601, `method not found: ${method}`));
  }
  const response = Array.isArray(payload) ? responses : responses[0];
  sendJson(ctx, 200, response as unknown);
}

// ---------------------------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------------------------

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

function createApp(): Server {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const body = await readRequestBody(req);
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
        const method = req.method ?? 'GET';
        const segments = url.pathname.split('/').filter((s) => s !== '');
        const ctx: Ctx = {
          method,
          url,
          segments,
          query: url.searchParams,
          headers: req.headers as Record<string, string | undefined>,
          bodyText: body.toString('utf8'),
          body: null,
          req,
          res,
          host: req.headers.host ?? '127.0.0.1',
        };

        if (url.pathname === '/healthz') {
          sendBuffer(ctx, 200, 'application/json', Buffer.from('{"ok":true}\n', 'utf8'));
          return;
        }

        if (segments[0] === 'api' && segments[1] === 'graphql') {
          if (method !== 'POST') {
            sendError(ctx, 404, 'Not Found');
            return;
          }
          const auth = req.headers.authorization;
          if (auth !== `Bearer ${TOKEN}`) {
            sendError(ctx, 401, 'Requires authentication');
            return;
          }
          handleGraphQL(ctx);
          return;
        }

        if (segments[0] === 'mcp') {
          if (method !== 'POST') {
            sendError(ctx, 404, 'Not Found');
            return;
          }
          const auth = req.headers.authorization;
          if (auth !== `Bearer ${TOKEN}`) {
            sendError(ctx, 401, 'Requires authentication');
            return;
          }
          handleMcp(ctx);
          return;
        }

        if (segments[0] === 'api' && segments[1] === 'v3') {
          const auth = req.headers.authorization;
          if (auth !== `Bearer ${TOKEN}`) {
            sendError(ctx, 401, 'Requires authentication');
            return;
          }
          handleRest({ ...ctx, segments: segments.slice(2) });
          return;
        }

        // Git smart-HTTP: /{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}
        if (segments.length >= 3 && (segments[1] as string).endsWith('.git')) {
          const owner = decodeURIComponent(segments[0] as string);
          const repoName = decodeURIComponent((segments[1] as string).slice(0, -4));
          const repo = findRepo(owner, repoName);
          if (!repo) {
            sendError(ctx, 404, 'Not Found');
            return;
          }
          const tail = segments.slice(2);
          if (tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
            const service = url.searchParams.get('service');
            if (service === 'git-upload-pack' && ctx.headers['git-protocol'] === 'version=2') {
              sendBuffer(ctx, 200, 'application/x-git-upload-pack-advertisement', V2_ADVERTISEMENT);
              return;
            }
            const action = service === 'git-receive-pack' ? 'receive-pack' : 'upload-pack';
            const result = handleGit(repo, action, true, url.searchParams, body);
            sendBuffer(ctx, result.status, result.contentType, result.body);
            return;
          }
          if (tail.length === 1 && tail[0] === 'git-upload-pack') {
            const result = handleGit(repo, 'upload-pack', false, url.searchParams, body);
            sendBuffer(ctx, result.status, result.contentType, result.body);
            return;
          }
          if (tail.length === 1 && tail[0] === 'git-receive-pack') {
            const result = handleGit(repo, 'receive-pack', false, url.searchParams, body);
            sendBuffer(ctx, result.status, result.contentType, result.body);
            return;
          }
          sendError(ctx, 404, 'Not Found');
          return;
        }

        sendError(ctx, 404, 'Not Found');
      } catch (error) {
        try {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: error instanceof Error ? error.message : 'internal error' }));
        } catch {
          // Response already sent.
        }
      }
    })();
  });
  return server;
}

export { createApp, createRepo, findRepo, repoJson, issueJsonObject, scenarioViewerLogin, VIEWER_LOGIN };
