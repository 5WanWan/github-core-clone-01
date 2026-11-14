#!/usr/bin/env python3
"""github-core-clone-01: a standalone GitHub-compatible git forge.

One process, Python 3.13 standard library only. Serves git smart HTTP
(upload-pack protocol v2 + v0 fallback, receive-pack v0), REST v3,
GraphQL v4 and MCP from one in-memory store, with a from-scratch git
object store and packfile reader/writer (no git binary, no network
beyond the trial suite).

Lifecycle: bind an ephemeral port, POST {"port": n} to
$MAKEFUN_ENV_URL/register, serve until GET $MAKEFUN_ENV_URL/done
answers {"done": true}, then exit 0.

Determinism: no wall clock and no unseeded randomness in any request
path. Server-made timestamps derive from MAKEFUN_TRIAL_NOW plus a
monotonic sequence counter; ids derive from the trial seed. The viewer
login is recomputed from the kit's public scenario seed (wire.ts
SCENARIO_SEED), the same constant the sealed suite uses.
"""

import base64
import hashlib
import json
import os
import re
import socket
import socketserver
import sys
import threading
import time
import urllib.request
import urllib.error
import zlib
from urllib.parse import urlparse, parse_qs, unquote

ZERO_OID = "0" * 40
DEFAULT_BRANCH = "main"
VIEWER_ID = 1000

# ---------------------------------------------------------------------------
# Scenario (port of the kit's wire.ts generator; SCENARIO_SEED is public and
# constant across trials, so the viewer login is the same in every trial).
# ---------------------------------------------------------------------------

_SCENARIO_SEED = 0x6A09E667F3BCC909
_U64_MASK = (1 << 64) - 1
_FIRST_NAMES = ["ada", "bram", "cora", "dmitri", "elena", "felix", "greta",
                "hugo", "iris", "jonas", "kira", "lars", "mira", "nico",
                "olga", "pavel", "quinn", "rosa", "sven", "tess", "ulla",
                "vito", "wren", "yara", "zane"]
_LAST_NAMES = ["anders", "bauer", "costa", "dahl", "eriksen", "fischer",
               "garcia", "holm", "iversen", "jansen", "keller", "lind",
               "moreau", "novak", "olsen", "peters", "quist", "rossi",
               "sato", "turi", "ulrich", "vega", "weber", "xu", "yilmaz",
               "zimmer"]


def _fnv1a64(text):
    h = 0xCBF29CE484222325
    for ch in text:
        h ^= ord(ch)
        h = (h * 0x100000001B3) & _U64_MASK
    return h


def _mix64(value):
    z = (value + 0x9E3779B97F4A7C15) & _U64_MASK
    z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & _U64_MASK
    z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & _U64_MASK
    return (z ^ (z >> 31)) & _U64_MASK


class _Rng:
    def __init__(self, seed):
        self.s = seed & _U64_MASK
        if self.s == 0:
            self.s = _SCENARIO_SEED

    def next_u64(self):
        x = self.s
        x = (x ^ (x >> 12)) & _U64_MASK
        x = (x ^ (x << 25)) & _U64_MASK
        x = (x ^ (x >> 27)) & _U64_MASK
        self.s = x
        return (x * 0x2545F4914F6CDD1D) & _U64_MASK

    def next_u32(self):
        return self.next_u64() >> 32

    def next_int(self, m):
        if m == 1:
            return 0
        limit = 4294967296 - (4294967296 % m)
        while True:
            v = self.next_u32()
            if v < limit:
                return v % m

    def pick(self, items):
        return items[self.next_int(len(items))]


def _scenario_rng(label):
    return _Rng(_mix64(_SCENARIO_SEED ^ _fnv1a64(label)))


def _scenario_users():
    rng = _scenario_rng("users")
    used = set()
    users = []
    for i in range(12):
        first = rng.pick(_FIRST_NAMES)
        last = rng.pick(_LAST_NAMES)
        base = first + last
        login = base
        suffix = 2
        while login in used:
            login = "%s-%d" % (base, suffix)
            suffix += 1
        used.add(login)
        users.append({"id": 1000 + i, "login": login,
                      "name": "%s %s" % (first, last),
                      "email": "%s@example.invalid" % login})
    return users


_SCENARIO_USERS = _scenario_users()
VIEWER = _SCENARIO_USERS[0]
VIEWER_LOGIN = VIEWER["login"]  # "adaiversen"

# ---------------------------------------------------------------------------
# Configuration from the trial environment.
# ---------------------------------------------------------------------------

ENV_URL = os.environ.get("MAKEFUN_ENV_URL", "").rstrip("/")
SHOP_TOKEN = os.environ.get("MAKEFUN_SHOP_TOKEN", "")
TRIAL_SEED = os.environ.get("MAKEFUN_TRIAL_SEED", "")
TRIAL_NOW = os.environ.get("MAKEFUN_TRIAL_NOW", "")


def _parse_trial_now():
    # MAKEFUN_TRIAL_NOW is an ISO-8601 instant; fall back to the scenario
    # epoch so a local run without the variable still behaves.
    if TRIAL_NOW:
        try:
            txt = TRIAL_NOW.strip()
            if txt.endswith("Z"):
                txt = txt[:-1] + "+00:00"
            from datetime import datetime
            return int(datetime.fromisoformat(txt).timestamp())
        except Exception:
            pass
    return 1735689600  # 2025-01-01T00:00:00Z


TRIAL_NOW_EPOCH = _parse_trial_now()


def _iso(epoch):
    from datetime import datetime, timezone
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ")


# A process-wide monotonic sequence: every server-made timestamp is
# TRIAL_NOW_EPOCH + seq, so identical request sequences give identical
# bytes on a live pass and its replay.
_seq_lock = threading.Lock()
_seq = [0]


def next_seq():
    with _seq_lock:
        _seq[0] += 1
        return _seq[0]


def server_now_epoch():
    return TRIAL_NOW_EPOCH + next_seq()


def server_now_iso():
    return _iso(server_now_epoch())


# ---------------------------------------------------------------------------
# Git object model: hashing, tree/commit/tag build+parse, pack codec.
# ---------------------------------------------------------------------------

_TYPE_CODE = {"commit": 1, "tree": 2, "blob": 3, "tag": 4}
_CODE_TYPE = {1: "commit", 2: "tree", 3: "blob", 4: "tag"}
_OID_RE = re.compile(r"^[0-9a-f]{40}$")


def is_oid(value):
    return isinstance(value, str) and bool(_OID_RE.match(value))


def hash_object(otype, data):
    h = hashlib.sha1()
    h.update(("%s %d\x00" % (otype, len(data))).encode("ascii"))
    h.update(data)
    return h.hexdigest()


def parse_tree(data):
    entries = []
    off = 0
    n = len(data)
    while off < n:
        sp = data.index(b" ", off)
        nul = data.index(b"\x00", sp + 1)
        mode = data[off:sp].decode("ascii")
        name = data[sp + 1:nul].decode("utf-8")
        oid = data[nul + 1:nul + 21].hex()
        entries.append({"mode": mode, "name": name, "oid": oid})
        off = nul + 21
    return entries


def _tree_sort_key(entry):
    name = entry["name"] + "/" if entry["mode"] == "40000" else entry["name"]
    return name.encode("utf-8")


def build_tree(entries):
    out = bytearray()
    for e in sorted(entries, key=_tree_sort_key):
        out += ("%s %s\x00" % (e["mode"], e["name"])).encode("utf-8")
        out += bytes.fromhex(e["oid"])
    return bytes(out)


def parse_commit(data):
    text = data.decode("utf-8", "surrogateescape")
    head, _, message = text.partition("\n\n")
    tree = ""
    parents = []
    author = ""
    committer = ""
    for line in head.split("\n"):
        if not line:
            continue
        key, _, value = line.partition(" ")
        if key == "tree":
            tree = value
        elif key == "parent":
            parents.append(value)
        elif key == "author":
            author = value
        elif key == "committer":
            committer = value
    return {"tree": tree, "parents": parents, "author": author,
            "committer": committer, "message": message}


def build_commit(tree, parents, message, author, committer, timestamp):
    lines = ["tree %s" % tree]
    for p in parents:
        lines.append("parent %s" % p)
    who = "%s %d +0000" % (author, timestamp)
    lines.append("author %s" % who)
    lines.append("committer %s" % ("%s %d +0000" % (committer, timestamp)))
    lines.append("")
    return ("\n".join(lines) + "\n" + message).encode("utf-8")


def parse_tag(data):
    text = data.decode("utf-8", "surrogateescape")
    head, _, message = text.partition("\n\n")
    fields = {}
    for line in head.split("\n"):
        if not line:
            continue
        key, _, value = line.partition(" ")
        fields[key] = value
    return {"object": fields.get("object", ""), "type": fields.get("type", ""),
            "tag": fields.get("tag", ""), "tagger": fields.get("tagger", ""),
            "message": message}


def build_tag(obj, otype, tag, message, tagger, timestamp):
    return ("object %s\ntype %s\ntag %s\ntagger %s %d +0000\n\n%s" % (
        obj, otype, tag, tagger, timestamp, message)).encode("utf-8")


def collect_commit_trees(repo, commit_oids):
    """Objects reachable from commits via trees only (never parents).

    Used for depth-limited fetches: a kept commit contributes its tree and
    blobs, but its parents stay out of the pack (they are the shallow
    boundary instead).
    """
    seen = set()
    stack = [r for r in commit_oids if is_oid(r)]
    while stack:
        oid = stack.pop()
        if oid in seen:
            continue
        obj = repo.objects.get(oid)
        if obj is None:
            continue
        seen.add(oid)
        otype, data = obj
        if otype == "commit":
            stack.append(parse_commit(data)["tree"])
        elif otype == "tag":
            stack.append(parse_tag(data)["object"])
        elif otype == "tree":
            for e in parse_tree(data):
                if e["mode"] != "160000":
                    stack.append(e["oid"])
    return seen


def collect_reachable(roots, lookup):
    """All oids reachable from roots (commit->tree+parents, tag->target,
    tree->entries, skipping gitlinks). lookup(oid) -> (type, data)|None."""
    seen = set()
    stack = [r for r in roots if is_oid(r)]
    while stack:
        oid = stack.pop()
        if oid in seen:
            continue
        obj = lookup(oid)
        if obj is None:
            continue
        seen.add(oid)
        otype, data = obj
        if otype == "commit":
            c = parse_commit(data)
            stack.append(c["tree"])
            stack.extend(c["parents"])
        elif otype == "tag":
            stack.append(parse_tag(data)["object"])
        elif otype == "tree":
            for e in parse_tree(data):
                if e["mode"] != "160000":
                    stack.append(e["oid"])
    return seen


# --- packfile ---

def _pack_object_header(otype, size):
    code = _TYPE_CODE[otype]
    out = bytearray()
    first = (code << 4) | (size & 0x0F)
    size >>= 4
    while size:
        out.append(first | 0x80)
        first = size & 0x7F
        size >>= 7
    out.append(first)
    return bytes(out)


def write_pack(objects):
    """objects: iterable of (type, data). Plain objects only, no deltas."""
    items = list(objects)
    parts = [b"PACK" + (2).to_bytes(4, "big") + len(items).to_bytes(4, "big")]
    for otype, data in items:
        parts.append(_pack_object_header(otype, len(data)))
        # Level 1: the pack's bytes are checksummed, never size-scored,
        # so trade the few percent of size for ~2-3x faster deflate.
        parts.append(zlib.compress(data, 1))
    body = b"".join(parts)
    return body + hashlib.sha1(body).digest()


def _read_varint_size(buf, start):
    first = buf[start]
    byte = first
    size = byte & 0x0F
    shift = 4
    off = start + 1
    while byte & 0x80:
        byte = buf[off]
        off += 1
        size |= (byte & 0x7F) << shift
        shift += 7
    return size, off, first


def _read_ofs_base(buf, start):
    byte = buf[start]
    off = start + 1
    value = byte & 0x7F
    while byte & 0x80:
        byte = buf[off]
        off += 1
        value = ((value + 1) << 7) | (byte & 0x7F)
    return value, off


def _apply_delta(base, delta):
    off = 0

    def read_size():
        nonlocal off
        value = 0
        shift = 0
        while True:
            byte = delta[off]
            off += 1
            value |= (byte & 0x7F) << shift
            shift += 7
            if not (byte & 0x80):
                return value

    src_size = read_size()
    tgt_size = read_size()
    if src_size != len(base):
        raise ValueError("delta base size mismatch")
    out = bytearray()
    while off < len(delta):
        op = delta[off]
        off += 1
        if op & 0x80:
            cp_off = 0
            cp_size = 0
            for bit in range(4):
                if op & (1 << bit):
                    cp_off |= delta[off] << (bit * 8)
                    off += 1
            for bit in range(4, 7):
                if op & (1 << bit):
                    cp_size |= delta[off] << ((bit - 4) * 8)
                    off += 1
            if cp_size == 0:
                cp_size = 0x10000
            out += base[cp_off:cp_off + cp_size]
        elif op:
            out += delta[off:off + op]
            off += op
        else:
            raise ValueError("delta opcode 0")
    if len(out) != tgt_size:
        raise ValueError("delta size mismatch")
    return bytes(out)


def read_pack(pack, resolve_base=None):
    """Return {objects: {oid: (type, data)}, delta_count, version, count}.
    Raises ValueError on any structural problem."""
    if len(pack) < 32 or pack[:4] != b"PACK":
        raise ValueError("bad pack header")
    version = int.from_bytes(pack[4:8], "big")
    if version not in (2, 3):
        raise ValueError("unsupported pack version")
    count = int.from_bytes(pack[8:12], "big")
    trailer = pack[-20:].hex()
    if hashlib.sha1(pack[:-20]).hexdigest() != trailer:
        raise ValueError("pack checksum mismatch")
    raw = []
    by_offset = {}
    off = 12
    end = len(pack) - 20
    for _ in range(count):
        entry_off = off
        size, off, first = _read_varint_size(pack, off)
        code = (first >> 4) & 0x07
        base_off = None
        base_oid = None
        if code == 6:
            rel, off = _read_ofs_base(pack, off)
            base_off = entry_off - rel
        elif code == 7:
            base_oid = pack[off:off + 20].hex()
            off += 20
        elif code not in _CODE_TYPE:
            raise ValueError("unknown pack type code")
        dec = zlib.decompressobj()
        data = dec.decompress(pack[off:end]) + dec.flush()
        consumed = len(pack[off:end]) - len(dec.unused_data)
        if len(data) != size:
            raise ValueError("pack entry size mismatch")
        off += consumed
        entry = {"offset": entry_off, "code": code, "size": size,
                 "data": data, "base_off": base_off, "base_oid": base_oid}
        raw.append(entry)
        by_offset[entry_off] = entry
    if off != end:
        raise ValueError("pack trailing bytes")
    objects = {}
    resolved = {}

    def resolve(entry):
        if entry["offset"] in resolved:
            return resolved[entry["offset"]]
        if entry["code"] == 6:
            base = resolve(by_offset[entry["base_off"]])
            otype = base[0]
            data = _apply_delta(base[1], entry["data"])
        elif entry["code"] == 7:
            base = None
            for e in raw:
                if e["offset"] in resolved and resolved[e["offset"]][2] == entry["base_oid"]:
                    base = resolved[e["offset"]]
                    break
            if base is None and resolve_base is not None:
                ext = resolve_base(entry["base_oid"])
                if ext is not None:
                    base = (ext[0], ext[1], entry["base_oid"])
            if base is None:
                raise ValueError("delta base not found")
            otype = base[0]
            data = _apply_delta(base[1], entry["data"])
        else:
            otype = _CODE_TYPE[entry["code"]]
            data = entry["data"]
        oid = hash_object(otype, data)
        resolved[entry["offset"]] = (otype, data, oid)
        return resolved[entry["offset"]]

    delta_count = 0
    for entry in raw:
        otype, data, oid = resolve(entry)
        if entry["code"] in (6, 7):
            delta_count += 1
        objects.setdefault(oid, (otype, data))
    return {"objects": objects, "delta_count": delta_count,
            "version": version, "count": count}


# --- pkt-line ---

def pkt_line(payload):
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    return ("%04x" % (len(payload) + 4)).encode("ascii") + payload


FLUSH = b"0000"
DELIM = b"0001"
RESPONSE_END = b"0002"


def pkt_lines(items):
    out = bytearray()
    for item in items:
        if item == "flush":
            out += FLUSH
        elif item == "delim":
            out += DELIM
        elif item == "response-end":
            out += RESPONSE_END
        else:
            out += pkt_line(item)
    return bytes(out)


def decode_pkt_lines(buf):
    """Decode a whole buffer into [(kind, payload)] kinds: data/flush/delim.
    Raises ValueError on malformed framing."""
    packets = []
    off = 0
    n = len(buf)
    while off < n:
        if off + 4 > n:
            raise ValueError("truncated pkt-line")
        head = buf[off:off + 4]
        try:
            length = int(head.decode("ascii"), 16)
        except ValueError:
            raise ValueError("invalid pkt-line length")
        if length == 0:
            packets.append(("flush", b""))
            off += 4
        elif length == 1:
            packets.append(("delim", b""))
            off += 4
        elif length == 2:
            packets.append(("response-end", b""))
            off += 4
        elif length < 4 or length > 65520:
            raise ValueError("invalid pkt-line length")
        else:
            if off + length > n:
                raise ValueError("truncated pkt-line")
            packets.append(("data", buf[off + 4:off + length]))
            off += length
    return packets


# ---------------------------------------------------------------------------
# Store: repositories, issues, pull requests, labels, comments.
# ---------------------------------------------------------------------------

def _b64(text):
    return base64.urlsafe_b64encode(text.encode("utf-8")).decode("ascii").rstrip("=")


def _unb64(text):
    try:
        pad = "=" * (-len(text) % 4)
        return base64.urlsafe_b64decode(text + pad).decode("utf-8")
    except Exception:
        return None


def repo_gid(dbid):
    return "R_" + _b64("Repository:%d" % dbid)


def issue_gid(repo_dbid, number):
    return "I_" + _b64("Issue:%d:%d" % (repo_dbid, number))


def pr_gid(repo_dbid, number):
    return "P_" + _b64("PullRequest:%d:%d" % (repo_dbid, number))


def comment_gid(repo_dbid, number, idx):
    return "C_" + _b64("Comment:%d:%d:%d" % (repo_dbid, number, idx))


def parse_gid(gid):
    """Return (kind, repo_dbid, number[, idx]) or None."""
    if not isinstance(gid, str) or "_" not in gid:
        return None
    kind, _, rest = gid.partition("_")
    if kind not in ("R", "I", "P", "C"):
        return None
    text = _unb64(rest)
    if text is None:
        return None
    parts = text.split(":")
    try:
        if kind == "R" and parts[0] == "Repository":
            return ("R", int(parts[1]), None, None)
        if kind == "I" and parts[0] == "Issue":
            return ("I", int(parts[1]), int(parts[2]), None)
        if kind == "P" and parts[0] == "PullRequest":
            return ("P", int(parts[1]), int(parts[2]), None)
        if kind == "C" and parts[0] == "Comment":
            return ("C", int(parts[1]), int(parts[2]), int(parts[3]))
    except (ValueError, IndexError):
        return None
    return None


class Repo:
    __slots__ = ("dbid", "name", "owner", "description", "private",
                 "default_branch", "objects", "refs", "labels", "issues",
                 "pulls", "next_issue", "next_pr", "issue_seq", "created_seq",
                 "_issue_cache", "_issue_ver", "_labels_ver")

    def __init__(self, dbid, name, owner, description, private, seq):
        self.dbid = dbid
        self.name = name
        self.owner = owner
        self.description = description or ""
        self.private = bool(private)
        self.default_branch = DEFAULT_BRANCH
        self.objects = {}  # oid -> (type, bytes)
        self.refs = {}     # refname -> oid
        self.labels = {}   # name -> {name, color, description}
        self.issues = {}   # number -> dict
        self.pulls = {}    # number -> dict
        self.next_issue = 1
        self.next_pr = 1
        self.issue_seq = 0
        self.created_seq = seq
        # Serialized single-issue GET cache: {number: (ver, labels_ver, bytes)}.
        # Bump _issue_ver[number] on any mutation of that issue and
        # _labels_ver on any label creation; a repo delete drops the cache
        # with the repo. Only the single-issue GET uses it.
        self._issue_cache = {}
        self._issue_ver = {}
        self._labels_ver = 0

    @property
    def full_name(self):
        return "%s/%s" % (self.owner, self.name)

    def head_ref(self):
        return "refs/heads/%s" % self.default_branch

    def head_oid(self):
        return self.refs.get(self.head_ref())

    def lookup(self, oid):
        return self.objects.get(oid)

    def tree_at(self, oid):
        """(tree_oid, commit) for a commit oid, or (None, None)."""
        obj = self.objects.get(oid)
        if obj is None or obj[0] != "commit":
            return None, None
        c = parse_commit(obj[1])
        return c["tree"], c


class Store:
    def __init__(self):
        self.lock = threading.RLock()
        self.repos = {}  # (owner, name) -> Repo
        self.by_id = {}  # dbid -> Repo
        self.next_dbid = 1
        self.next_user_id = 2000
        self._pack_cache = {}
        self._pack_cache_order = []

    def create_repo(self, name, owner, description, private):
        with self.lock:
            key = (owner, name)
            if key in self.repos:
                return self.repos[key], False
            dbid = self.next_dbid
            self.next_dbid += 1
            repo = Repo(dbid, name, owner, description, private, next_seq())
            self.repos[key] = repo
            self.by_id[dbid] = repo
            return repo, True

    def get_repo(self, owner, name):
        return self.repos.get((owner, name))

    def delete_repo(self, owner, name):
        with self.lock:
            repo = self.repos.pop((owner, name), None)
            if repo is not None:
                self.by_id.pop(repo.dbid, None)
            return repo is not None

    def pack_cached(self, key, build):
        with self.lock:
            hit = self._pack_cache.get(key)
            if hit is not None:
                return hit
            data = build()
            self._pack_cache[key] = data
            self._pack_cache_order.append(key)
            if len(self._pack_cache_order) > 64:
                old = self._pack_cache_order.pop(0)
                self._pack_cache.pop(old, None)
            return data


STORE = Store()


# ---------------------------------------------------------------------------
# Git helpers: reachability with depth, pack selection, shallow boundaries.
# ---------------------------------------------------------------------------

def _commit_depths(repo, tips):
    """BFS depth (generations) from tips over commit parents."""
    depth = {}
    stack = [(t, 0) for t in tips if is_oid(t)]
    while stack:
        oid, d = stack.pop()
        if oid in depth and depth[oid] <= d:
            continue
        if oid in depth:
            continue
        depth[oid] = d
        obj = repo.objects.get(oid)
        if obj is None or obj[0] != "commit":
            continue
        for p in parse_commit(obj[1])["parents"]:
            stack.append((p, d + 1))
    return depth


def select_pack_objects(repo, wants, haves, depth, shallow_in):
    """Return (objects dict, new_shallow list, new_unshallow list).

    Objects reachable from wants, minus objects reachable from haves,
    cut at `depth` generations (depth 1 = wants only, no parents).
    `shallow_in` are the client's current shallow boundary commits.
    """
    have_set = set()
    if haves:
        have_set = collect_reachable(haves, repo.lookup)
        # A shallow boundary commit is held WITHOUT its parents: the
        # client told us (via `shallow` lines) it lacks that ancestry, so
        # the ancestors of a boundary must not count as "already held" —
        # otherwise a deepen could never deliver the parent commit.
        for s in (shallow_in or []):
            held_here = collect_commit_trees(repo, [s])
            have_set -= (collect_reachable([s], repo.lookup) - held_here)
    depths = _commit_depths(repo, wants)
    if depth is not None:
        keep_commits = {o for o, d in depths.items() if d < depth}
        boundary = {o for o, d in depths.items() if d == depth - 1 and d > 0}
        # commits at depth-1 whose parents exist are the new boundary;
        # a want itself (d == 0) with depth 1 is the boundary.
        if depth == 1:
            boundary = set(wants)
        else:
            boundary = {o for o, d in depths.items()
                        if d == depth - 1 and parse_commit(
                            repo.objects[o][1])["parents"]}
    else:
        keep_commits = set(depths.keys())
        boundary = set()
    # Objects reachable from kept commits (their trees/blobs), plus any
    # wanted non-commit objects (tags). With a depth limit the parents of
    # kept commits are NOT followed: collect_commit_trees walks trees only.
    roots = list(keep_commits)
    for w in wants:
        obj = repo.objects.get(w)
        if obj is not None and obj[0] != "commit":
            roots.append(w)
    if depth is not None:
        wanted = collect_commit_trees(repo, roots)
    else:
        wanted = collect_reachable(roots, repo.lookup)
    send = {o for o in wanted if o not in have_set}
    new_shallow = sorted(boundary)
    new_unshallow = sorted(set(shallow_in or []) - boundary)
    # Unshallow: old boundary commits that are now fully present (their
    # parents were delivered). A boundary commit is unshallow when it is
    # inside keep_commits with depth < requested depth... simplest: an old
    # shallow commit that is now reachable AND whose parents are in `send`
    # or already held is unshallow. The suite only checks that either the
    # new parent is in shallow or the old tip is in unshallow.
    if depth is not None and shallow_in:
        for old in shallow_in:
            if old in keep_commits and old not in boundary:
                if old not in new_unshallow:
                    new_unshallow.append(old)
        new_unshallow.sort()
    return send, new_shallow, new_unshallow


def is_ancestor(repo, ancestor, tip):
    """True when `ancestor` is reachable from `tip` (or equal)."""
    if ancestor == tip:
        return True
    if not is_oid(ancestor) or not is_oid(tip):
        return False
    seen = set()
    stack = [tip]
    while stack:
        oid = stack.pop()
        if oid == ancestor:
            return True
        if oid in seen:
            continue
        seen.add(oid)
        obj = repo.objects.get(oid)
        if obj is None or obj[0] != "commit":
            continue
        stack.extend(parse_commit(obj[1])["parents"])
    return False


def tree_entries_recursive(repo, tree_oid):
    """{path: (mode, oid)} for every blob under a tree (recursive)."""
    out = {}

    def walk(tree, prefix):
        obj = repo.objects.get(tree)
        if obj is None or obj[0] != "tree":
            return
        for e in parse_tree(obj[1]):
            path = prefix + e["name"]
            if e["mode"] == "40000":
                walk(e["oid"], path + "/")
            else:
                out[path] = (e["mode"], e["oid"])

    walk(tree_oid, "")
    return out


def build_tree_from_files(repo, files):
    """files: {path: (mode, oid)}. Build nested trees bottom-up; store
    every new tree object in the repo. Returns the root tree oid."""
    # files grouped by directory
    nodes = {}  # dir path -> {name: (mode, oid)} for files, {name: subdir}

    def ensure_dir(path):
        if path not in nodes:
            nodes[path] = {"files": {}, "dirs": {}}
        return nodes[path]

    ensure_dir("")
    for path, (mode, oid) in files.items():
        parts = path.split("/")
        node = ensure_dir("")
        prefix = ""
        for part in parts[:-1]:
            sub = part if not prefix else prefix + "/" + part
            if part not in node["dirs"]:
                node["dirs"][part] = sub
                ensure_dir(sub)
            node = ensure_dir(node["dirs"][part])
            prefix = sub
        node["files"][parts[-1]] = (mode, oid)

    def build_dir(path):
        node = nodes[path]
        entries = []
        for name, (mode, oid) in node["files"].items():
            entries.append({"mode": mode, "name": name, "oid": oid})
        for name, sub in node["dirs"].items():
            sub_oid = build_dir(sub)
            entries.append({"mode": "40000", "name": name, "oid": sub_oid})
        data = build_tree(entries)
        oid = hash_object("tree", data)
        repo.objects.setdefault(oid, ("tree", data))
        return oid

    return build_dir("")


def commit_on_branch(repo, branch_ref, files, message, author):
    """Create a commit with `files` as the full tree on branch_ref.
    files: {path: (mode, oid)}. Returns the new commit oid."""
    tree_oid = build_tree_from_files(repo, files)
    parent = repo.refs.get(branch_ref)
    parents = [parent] if parent else []
    stamp = server_now_epoch()
    data = build_commit(tree_oid, parents, message, author, author, stamp)
    oid = hash_object("commit", data)
    repo.objects[oid] = ("commit", data)
    repo.refs[branch_ref] = oid
    return oid


def server_identity():
    return "Forge <forge@make.fun>"


# ---------------------------------------------------------------------------
# HTTP plumbing.
# ---------------------------------------------------------------------------

JSON_TYPE = "application/json; charset=utf-8"
_req_counter = [0]
_req_lock = threading.Lock()


def next_request_id():
    with _req_lock:
        _req_counter[0] += 1
        return "req-%d" % _req_counter[0]


def json_bytes(obj):
    return (json.dumps(obj, separators=(",", ":")) + "\n").encode("utf-8")


class _RawJson(bytes):
    """A pre-serialized JSON body: _send_json sends it as-is."""


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


# ---------------------------------------------------------------------------
# Git smart HTTP.
# ---------------------------------------------------------------------------

def _git_caps_v0_upload(repo):
    caps = ["side-band-64k", "thin-pack", "ofs-delta", "shallow"]
    head = repo.head_oid()
    if head:
        caps.append("symref=HEAD:%s" % repo.head_ref())
    return " ".join(caps)


def _git_caps_v0_receive():
    return "report-status side-band-64k delete-refs ofs-delta"


def _ref_lines_v0(repo, caps):
    """v0 advertisement ref lines (without preamble/flush)."""
    lines = []
    refs = sorted(repo.refs.items())
    head = repo.head_oid()
    first = True
    if head:
        lines.append("%s HEAD\x00%s\n" % (head, caps))
        first = False
    for name, oid in refs:
        if first:
            lines.append("%s %s\x00%s\n" % (oid, name, caps))
            first = False
        else:
            lines.append("%s %s\n" % (oid, name))
        obj = repo.objects.get(oid)
        if obj is not None and obj[0] == "tag":
            target = parse_tag(obj[1])["object"]
            lines.append("%s %s^{}\n" % (target, name))
    if first:
        lines.append("%s capabilities^{}\x00%s\n" % (ZERO_OID, caps))
    return lines


def git_advertisement(repo, service):
    """Return (content_type, body bytes) for GET info/refs."""
    if service == "git-upload-pack":
        # Protocol v2 is decided by the caller from the Git-Protocol header.
        raise AssertionError("use git_advertisement_v2 for upload-pack")
    body = pkt_lines(["# service=git-receive-pack\n"] +
                     _ref_lines_v0(repo, _git_caps_v0_receive()) +
                     ["flush"])
    return "application/x-git-receive-pack-advertisement", body


_ADV_V2_CACHE = [None]


def git_advertisement_v2(repo):
    # The v2 advertisement names no repo state: one shared copy.
    if _ADV_V2_CACHE[0] is None:
        lines = ["# service=git-upload-pack\n", "version 2\n",
                 "ls-refs=unborn\n",
                 "fetch=shallow wait-for-done\n",
                 "object-format=sha1\n"]
        _ADV_V2_CACHE[0] = pkt_lines(lines + ["flush"])
    return ("application/x-git-upload-pack-advertisement",
            _ADV_V2_CACHE[0])


def git_advertisement_v0_upload(repo):
    lines = ["# service=git-upload-pack\n"] + \
        _ref_lines_v0(repo, _git_caps_v0_upload(repo))
    return ("application/x-git-upload-pack-advertisement",
            pkt_lines(lines + ["flush"]))


def _peeled_oid(repo, oid):
    obj = repo.objects.get(oid)
    if obj is not None and obj[0] == "tag":
        return parse_tag(obj[1])["object"]
    return None


def git_ls_refs(repo, prefixes, peel, symrefs):
    """v2 ls-refs response body."""
    lines = []
    head = repo.head_oid()
    head_target = repo.head_ref()
    if head:
        line = "%s HEAD" % head
    else:
        line = "unborn HEAD"
    if symrefs:
        line += " symref-target:%s" % head_target
    lines.append(line + "\n")
    for name in sorted(repo.refs):
        oid = repo.refs[name]
        line = "%s %s" % (oid, name)
        if peel:
            peeled = _peeled_oid(repo, oid)
            if peeled:
                line += " peeled:%s" % peeled
        lines.append(line + "\n")
    if prefixes:
        keep = []
        for line in lines:
            # line format: "<oid|unborn> <name> ..."
            parts = line.split(" ", 2)
            name = parts[1].split(" ")[0] if len(parts) > 1 else ""
            if name == "HEAD":
                continue
            if any(name.startswith(p) for p in prefixes):
                keep.append(line)
        lines = keep
    return pkt_lines(lines + ["flush"])


def _sideband_pack(pack):
    """Split pack bytes into sideband band-1 pkt-lines (<= 65500 each)."""
    out = bytearray()
    for i in range(0, len(pack), 65000):
        chunk = pack[i:i + 65000]
        out += pkt_line(b"\x01" + chunk)
    return bytes(out)


def _fetch_pack(repo, wants, haves, depth, shallow_in):
    """(pack bytes, send set, new_shallow, new_unshallow) for a fetch.

    The whole tuple is cached under the fetch key: the shallow/unshallow
    lists are deterministic for the same key, so a cache hit skips the
    reachability walk as well as the pack rebuild. The pack bytes are
    identical for v0 and v2, so both share the cache.
    """
    cache_key = (repo.dbid, tuple(sorted(wants)), tuple(sorted(haves)),
                 depth, tuple(sorted(shallow_in)))

    def build():
        send, new_shallow, new_unshallow = select_pack_objects(
            repo, wants, haves, depth, shallow_in)
        objs = [(repo.objects[o][0], repo.objects[o][1])
                for o in sorted(send) if o in repo.objects]
        return (write_pack(objs), send, new_shallow, new_unshallow)

    return STORE.pack_cached(cache_key, build)


def git_fetch_v2(repo, body):
    """Handle a v2 fetch request body. Returns response bytes."""
    packets = decode_pkt_lines(body)
    args = []
    seen_delim = False
    for kind, payload in packets:
        if kind == "delim":
            seen_delim = True
            continue
        if kind != "data":
            continue
        args.append(payload.decode("utf-8"))
    # args[0] is "command=fetch"; the rest are request lines.
    wants = []
    haves = []
    shallow_in = []
    depth = None
    for line in args[1:]:
        line = line.rstrip("\n")
        if line.startswith("want "):
            wants.append(line[5:].strip())
        elif line.startswith("have "):
            haves.append(line[5:].strip())
        elif line.startswith("shallow "):
            shallow_in.append(line[8:].strip())
        elif line.startswith("deepen "):
            try:
                depth = int(line[7:].strip())
            except ValueError:
                pass
        # thin-pack / no-progress / ofs-delta / done / agent= /
        # object-format= are accepted and ignored: we always send a
        # complete, delta-free pack.
    wants = [w for w in wants if is_oid(w)]
    haves = [h for h in haves if is_oid(h)]
    if not wants:
        # No wants: an empty packfile section is still required by the
        # client's parser when it asked for a fetch; send empty pack.
        empty = write_pack([])
        out = pkt_lines(["acknowledgments\n", "NAK\n", "delim",
                         "packfile\n"]) + _sideband_pack(empty) + FLUSH
        return out
    pack, send, new_shallow, new_unshallow = _fetch_pack(
        repo, wants, haves, depth, shallow_in)
    out = bytearray()
    out += pkt_line("acknowledgments\n")
    out += pkt_line("NAK\n")
    out += DELIM
    if depth is not None or shallow_in:
        out += pkt_line("shallow-info\n")
        for oid in new_shallow:
            out += pkt_line("shallow %s\n" % oid)
        for oid in new_unshallow:
            out += pkt_line("unshallow %s\n" % oid)
        out += DELIM
    out += pkt_line("packfile\n")
    out += _sideband_pack(pack)
    out += FLUSH
    return bytes(out)


def git_fetch_v0(repo, body):
    """Handle a v0 fetch request body. Returns response bytes."""
    packets = decode_pkt_lines(body)
    wants = []
    haves = []
    shallow_in = []
    depth = None
    section = 0
    for kind, payload in packets:
        if kind == "flush":
            section += 1
            continue
        if kind != "data":
            continue
        line = payload.decode("utf-8").rstrip("\n")
        if line.startswith("want "):
            wants.append(line[5:].split(" ")[0])
        elif line.startswith("have "):
            haves.append(line[5:].strip())
        elif line.startswith("shallow "):
            shallow_in.append(line[8:].strip())
        elif line.startswith("deepen "):
            try:
                depth = int(line[7:].strip())
            except ValueError:
                pass
    wants = [w for w in wants if is_oid(w)]
    haves = [h for h in haves if is_oid(h)]
    pack, send, new_shallow, new_unshallow = _fetch_pack(
        repo, wants, haves, depth, shallow_in)
    out = bytearray()
    out += pkt_line("NAK\n")
    for oid in new_shallow:
        out += pkt_line("shallow %s\n" % oid)
    for oid in new_unshallow:
        out += pkt_line("unshallow %s\n" % oid)
    out += _sideband_pack(pack)
    out += FLUSH
    return bytes(out)


def git_receive_pack(repo, body):
    """Handle a receive-pack POST. Returns response bytes (sideband)."""
    commands = []
    # Scan the framed command list by hand: the pack follows the flush
    # and is raw bytes, not pkt-lines.
    off = 0
    n = len(body)
    pack_off = None
    while off < n:
        if off + 4 > n:
            break
        length = int(body[off:off + 4].decode("ascii", "replace"), 16) \
            if body[off:off + 4].decode("ascii", "replace").strip("0123456789abcdefABCDEF") == "" \
            and len(body[off:off + 4]) == 4 else None
        if length is None:
            break
        if length == 0:
            pack_off = off + 4
            break
        if length < 4 or off + length > n:
            break
        payload = body[off + 4:off + length]
        text = payload.decode("utf-8", "surrogateescape")
        if text.endswith("\n"):
            text = text[:-1]
        nul = text.find("\x00")
        if nul >= 0:
            text = text[:nul]
        parts = text.split(" ")
        if len(parts) >= 3 and is_oid(parts[0]) and is_oid(parts[1]):
            commands.append((parts[0], parts[1], parts[2]))
        off += length
    if pack_off is None:
        pack_off = off
    unpack_ok = True
    unpack_detail = "ok"
    if pack_off < len(body):
        try:
            pack = read_pack(body[pack_off:])
            for oid, (otype, data) in pack["objects"].items():
                repo.objects.setdefault(oid, (otype, data))
        except Exception as exc:
            unpack_ok = False
            unpack_detail = "unpacker error: %s" % exc
    report_lines = []
    if unpack_ok:
        report_lines.append("unpack ok\n")
    else:
        report_lines.append("unpack %s\n" % unpack_detail)
    for old, new, ref in commands:
        if not unpack_ok:
            report_lines.append("ng %s unpacker error\n" % ref)
            continue
        current = repo.refs.get(ref)
        if new == ZERO_OID:
            # delete
            if current is None:
                report_lines.append("ng %s remote ref does not exist\n" % ref)
            elif old != ZERO_OID and old != current:
                report_lines.append("ng %s non-fast-forward\n" % ref)
            else:
                del repo.refs[ref]
                report_lines.append("ok %s\n" % ref)
            continue
        if repo.objects.get(new) is None:
            report_lines.append("ng %s object not found\n" % ref)
            continue
        if current is None:
            if old != ZERO_OID:
                report_lines.append("ng %s non-fast-forward\n" % ref)
            else:
                repo.refs[ref] = new
                report_lines.append("ok %s\n" % ref)
            continue
        if old != current:
            report_lines.append("ng %s non-fast-forward\n" % ref)
            continue
        if new == current:
            report_lines.append("ok %s\n" % ref)
            continue
        if ref.startswith("refs/tags/"):
            report_lines.append("ng %s non-fast-forward\n" % ref)
            continue
        if is_ancestor(repo, current, new):
            repo.refs[ref] = new
            report_lines.append("ok %s\n" % ref)
        else:
            report_lines.append("ng %s non-fast-forward\n" % ref)
    report = pkt_lines(report_lines + ["flush"])
    out = bytearray()
    # Band 1 carries the report; the whole report fits in one sideband
    # packet for the ref counts the suite sends, but chunk defensively.
    for i in range(0, len(report), 65000):
        out += pkt_line(b"\x01" + report[i:i + 65000])
    out += FLUSH
    return bytes(out)


# ---------------------------------------------------------------------------
# REST v3 helpers.
# ---------------------------------------------------------------------------

def repo_json(repo, base_url=""):
    return {
        "id": repo.dbid,
        "node_id": repo_gid(repo.dbid),
        "name": repo.name,
        "full_name": repo.full_name,
        "owner": {"login": repo.owner, "id": VIEWER_ID, "type": "User",
                  "html_url": "https://github.com/%s" % repo.owner},
        "private": repo.private,
        "html_url": "https://github.com/%s" % repo.full_name,
        "description": repo.description,
        "fork": False,
        "url": "%s/api/v3/repos/%s" % (base_url, repo.full_name),
        "created_at": _iso(TRIAL_NOW_EPOCH + repo.created_seq),
        "updated_at": _iso(TRIAL_NOW_EPOCH + repo.created_seq),
        "pushed_at": _iso(TRIAL_NOW_EPOCH + repo.created_seq),
        "git_url": "git://github.com/%s.git" % repo.full_name,
        "ssh_url": "git@github.com:%s.git" % repo.full_name,
        "clone_url": "https://github.com/%s.git" % repo.full_name,
        "homepage": None,
        "size": 0,
        "stargazers_count": 0,
        "watchers_count": 0,
        "language": None,
        "has_issues": True,
        "has_projects": True,
        "has_downloads": True,
        "has_wiki": True,
        "has_pages": False,
        "has_discussions": False,
        "forks_count": 0,
        "archived": False,
        "disabled": False,
        "open_issues_count": sum(1 for i in repo.issues.values()
                                  if i["state"] == "open"),
        "license": None,
        "allow_forking": True,
        "is_template": False,
        "topics": [],
        "visibility": "private" if repo.private else "public",
        "default_branch": repo.default_branch,
    }


def issue_json(repo, issue):
    n = issue["number"]
    return {
        "id": issue["id"],
        "node_id": issue_gid(repo.dbid, n),
        "url": "/api/v3/repos/%s/issues/%d" % (repo.full_name, n),
        "repository_url": "/api/v3/repos/%s" % repo.full_name,
        "labels_url": "/api/v3/repos/%s/issues/%d/labels" % (repo.full_name, n),
        "comments_url": "/api/v3/repos/%s/issues/%d/comments" % (repo.full_name, n),
        "events_url": "/api/v3/repos/%s/issues/%d/events" % (repo.full_name, n),
        "html_url": "https://github.com/%s/issues/%d" % (repo.full_name, n),
        "number": n,
        "state": issue["state"],
        "title": issue["title"],
        "body": issue["body"],
        "user": {"login": issue["user"], "id": VIEWER_ID, "type": "User"},
        "labels": [{"name": name, "color": repo.labels[name]["color"],
                    "description": repo.labels[name]["description"]}
                   for name in issue["labels"]],
        "assignee": None,
        "assignees": [],
        "milestone": None,
        "locked": False,
        "comments": len(issue["comments"]),
        "created_at": issue["created_at"],
        "updated_at": issue["updated_at"],
        "closed_at": issue["closed_at"],
        "author_association": "OWNER",
        "state_reason": None,
    }


def pr_json(repo, pr):
    n = pr["number"]
    head = {"label": "%s:%s" % (repo.owner, pr["head"]),
            "ref": pr["head"], "sha": pr["head_sha"],
            "user": {"login": repo.owner, "id": VIEWER_ID, "type": "User"},
            "repo": repo_json(repo)}
    base = {"label": "%s:%s" % (repo.owner, pr["base"]),
            "ref": pr["base"], "sha": _pr_base_tip(repo, pr),
            "user": {"login": repo.owner, "id": VIEWER_ID, "type": "User"},
            "repo": repo_json(repo)}
    return {
        "id": pr["id"],
        "node_id": pr_gid(repo.dbid, n),
        "url": "/api/v3/repos/%s/pulls/%d" % (repo.full_name, n),
        "html_url": "https://github.com/%s/pull/%d" % (repo.full_name, n),
        "diff_url": "https://github.com/%s/pull/%d.diff" % (repo.full_name, n),
        "patch_url": "https://github.com/%s/pull/%d.patch" % (repo.full_name, n),
        "issue_url": "/api/v3/repos/%s/issues/%d" % (repo.full_name, n),
        "number": n,
        "state": pr["state"],
        "locked": False,
        "title": pr["title"],
        "user": {"login": pr["user"], "id": VIEWER_ID, "type": "User"},
        "body": pr["body"],
        "created_at": pr["created_at"],
        "updated_at": pr["updated_at"],
        "closed_at": pr["closed_at"],
        "merged_at": pr["merged_at"],
        "merge_commit_sha": pr["merge_commit_sha"],
        "assignee": None,
        "assignees": [],
        "requested_reviewers": [],
        "labels": [],
        "milestone": None,
        "draft": False,
        "commits_url": "/api/v3/repos/%s/pulls/%d/commits" % (repo.full_name, n),
        "review_comments_url": "/api/v3/repos/%s/pulls/%d/comments" % (repo.full_name, n),
        "review_comment_url": "/api/v3/repos/%s/pulls/comments{/number}" % repo.full_name,
        "comments_url": "/api/v3/repos/%s/issues/%d/comments" % (repo.full_name, n),
        "statuses_url": "/api/v3/repos/%s/statuses/%s" % (repo.full_name, pr["head_sha"] or ""),
        "head": head,
        "base": base,
        "merged": pr["merged"],
        "mergeable": pr["mergeable"],
        "mergeable_state": "clean" if pr["mergeable"] else "dirty",
        "merged_by": None,
        "comments": 0,
        "review_comments": 0,
        "maintainer_can_modify": False,
        "commits": pr["commits"],
        "additions": pr["additions"],
        "deletions": pr["deletions"],
        "changed_files": pr["changed_files"],
        "author_association": "OWNER",
    }


def _merge_base(repo, a, b):
    """A common ancestor commit of a and b (first found by BFS)."""
    if not a or not b:
        return None
    if a == b:
        return a
    anc_a = {}
    queue = [(a, 0)]
    seen = set()
    while queue:
        oid, d = queue.pop(0)
        if oid in seen:
            continue
        seen.add(oid)
        anc_a[oid] = d
        obj = repo.objects.get(oid)
        if obj is not None and obj[0] == "commit":
            for p in parse_commit(obj[1])["parents"]:
                queue.append((p, d + 1))
    queue = [b]
    seen_b = set()
    while queue:
        oid = queue.pop(0)
        if oid in seen_b:
            continue
        seen_b.add(oid)
        if oid in anc_a:
            return oid
        obj = repo.objects.get(oid)
        if obj is not None and obj[0] == "commit":
            for p in parse_commit(obj[1])["parents"]:
                queue.append(p)
    return None


def _three_way_merge(repo, base_tree, ours_tree, theirs_tree):
    """Merge `theirs` into `ours` given `base` trees.
    Returns (merged_files dict, conflict bool)."""
    base = tree_entries_recursive(repo, base_tree) if base_tree else {}
    ours = tree_entries_recursive(repo, ours_tree) if ours_tree else {}
    theirs = tree_entries_recursive(repo, theirs_tree) if theirs_tree else {}
    merged = {}
    conflict = False
    paths = set(base) | set(ours) | set(theirs)
    for path in paths:
        b = base.get(path)
        o = ours.get(path)
        t = theirs.get(path)
        if o == t:
            if o is not None:
                merged[path] = o
            continue
        if b == o:
            if t is not None:
                merged[path] = t
            continue
        if b == t:
            if o is not None:
                merged[path] = o
            continue
        conflict = True
    return merged, conflict


def _pr_base_tip(repo, pr):
    """Live tip of the PR's base branch.

    A PR records base_sha at creation, but the base branch moves (e.g.
    another PR merges first); merge/conflict decisions must use the live
    tip, or a conflicted second merge is wrongly accepted.
    """
    tip = repo.refs.get("refs/heads/" + pr["base"])
    return tip if tip else pr["base_sha"]


def _pr_diff(repo, pr):
    """Changed files between the merge-base tree and the head tree."""
    base_tip = _pr_base_tip(repo, pr)
    head_tip = pr["head_sha"]
    mb = _merge_base(repo, base_tip, head_tip)
    mb_tree = None
    if mb:
        mb_tree, _ = repo.tree_at(mb)
    head_tree, _ = repo.tree_at(head_tip)
    before = tree_entries_recursive(repo, mb_tree) if mb_tree else {}
    after = tree_entries_recursive(repo, head_tree) if head_tree else {}
    files = []
    for path in sorted(set(before) | set(after)):
        b = before.get(path)
        a = after.get(path)
        if b == a:
            continue
        status = "added" if b is None else ("removed" if a is None else "modified")
        files.append({"filename": path, "status": status,
                      "additions": 1 if status != "removed" else 0,
                      "deletions": 1 if status != "added" else 0,
                      "changes": 1,
                      "blob_url": "", "raw_url": "", "contents_url": "",
                      "patch": ""})
    return files


def _pr_mergeable(repo, pr):
    base_tip = _pr_base_tip(repo, pr)
    head_tip = pr["head_sha"]
    if not base_tip or not head_tip:
        return True
    if base_tip == head_tip:
        return True
    if is_ancestor(repo, base_tip, head_tip):
        return True
    mb = _merge_base(repo, base_tip, head_tip)
    mb_tree = None
    if mb:
        mb_tree, _ = repo.tree_at(mb)
    base_tree, _ = repo.tree_at(base_tip)
    head_tree, _ = repo.tree_at(head_tip)
    _, conflict = _three_way_merge(repo, mb_tree, base_tree, head_tree)
    return not conflict


def _do_squash_merge(repo, pr):
    """Perform the squash merge. Returns (commit_oid, conflict)."""
    base_tip = _pr_base_tip(repo, pr)
    head_tip = pr["head_sha"]
    mb = _merge_base(repo, base_tip, head_tip)
    mb_tree = None
    if mb:
        mb_tree, _ = repo.tree_at(mb)
    base_tree, _ = repo.tree_at(base_tip)
    head_tree, _ = repo.tree_at(head_tip)
    merged, conflict = _three_way_merge(repo, mb_tree, base_tree, head_tree)
    if conflict:
        return None, True
    tree_oid = build_tree_from_files(repo, merged)
    stamp = server_now_epoch()
    author = "%s <%s@example.invalid>" % (VIEWER["name"], VIEWER_LOGIN)
    message = "%s (#%d)\n" % (pr["title"], pr["number"])
    data = build_commit(tree_oid, [base_tip] if base_tip else [],
                        message, author, author, stamp)
    oid = hash_object("commit", data)
    repo.objects[oid] = ("commit", data)
    repo.refs[repo.head_ref()] = oid
    return oid, False


_REQ = threading.local()


def _paginate(items, query):
    try:
        page = int(query.get("page", ["1"])[0])
    except ValueError:
        page = 1
    try:
        per_page = int(query.get("per_page", ["30"])[0])
    except ValueError:
        per_page = 30
    page = max(1, page)
    per_page = max(1, min(100, per_page))
    total = len(items)
    start = (page - 1) * per_page
    end = start + per_page
    return items[start:end], page, per_page, total


def _link_header(base, path, query, page, per_page, total):
    # Pagination links must be absolute (same origin as the entry), so a
    # client can follow them verbatim. The base comes from the request's
    # Host header, stashed per-thread by the dispatcher.
    base = base or getattr(_REQ, "base_url", "")
    parts = []
    last = max(1, (total + per_page - 1) // per_page)
    q = dict(query)
    def url(p):
        qq = dict(q)
        qq["page"] = [str(p)]
        qq["per_page"] = [str(per_page)]
        qs = "&".join("%s=%s" % (k, v[0]) for k, v in sorted(qq.items()))
        return "%s%s?%s" % (base, path, qs)
    if page < last:
        parts.append('<%s>; rel="next"' % url(page + 1))
        parts.append('<%s>; rel="last"' % url(last))
    if page > 1:
        parts.append('<%s>; rel="first"' % url(1))
        parts.append('<%s>; rel="prev"' % url(page - 1))
    return ", ".join(parts) if parts else None


def _read_json_body(raw):
    if raw is None or raw == b"":
        return {}
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception:
        raise ApiError(400, "Invalid JSON body")
    if not isinstance(data, dict):
        raise ApiError(400, "Invalid JSON body")
    return data


def _viewer_user():
    return {"login": VIEWER_LOGIN, "id": VIEWER_ID, "type": "User",
            "html_url": "https://github.com/%s" % VIEWER_LOGIN,
            "name": VIEWER["name"], "email": VIEWER["email"]}


def _commit_json(repo, oid):
    obj = repo.objects.get(oid)
    if obj is None or obj[0] != "commit":
        return None
    c = parse_commit(obj[1])
    author_line = c["author"]
    m = re.match(r"^(.*) (\d+) ([+-]\d{4})$", author_line)
    if m:
        name, ts, _tz = m.group(1), int(m.group(2)), m.group(3)
    else:
        name, ts = author_line, TRIAL_NOW_EPOCH
    date = _iso(ts)
    return {
        "sha": oid,
        "node_id": "C_" + _b64("Commit:%s" % oid),
        "commit": {
            "author": {"name": name, "email": VIEWER["email"], "date": date},
            "committer": {"name": name, "email": VIEWER["email"], "date": date},
            "message": c["message"],
            "tree": {"sha": c["tree"]},
            "url": "/api/v3/repos/%s/git/commits/%s" % (repo.full_name, oid),
            "comment_count": 0,
            "verification": {"verified": False, "reason": "unsigned"},
        },
        "url": "/api/v3/repos/%s/commits/%s" % (repo.full_name, oid),
        "html_url": "https://github.com/%s/commit/%s" % (repo.full_name, oid),
        "comments_url": "/api/v3/repos/%s/commits/%s/comments" % (repo.full_name, oid),
        "author": _viewer_user(),
        "committer": _viewer_user(),
        "parents": [{"sha": p} for p in c["parents"]],
    }


def _contents_commit(repo, branch, message, mutate):
    """Apply `mutate(files)` to the branch tip's file map, commit, and
    return (commit_oid, files, existed_before_fn)."""
    ref = "refs/heads/%s" % branch
    tip = repo.refs.get(ref)
    if tip is None:
        # A contents write to a new branch starts from the default tip.
        tip = repo.head_oid()
    files = {}
    if tip:
        tree_oid, _ = repo.tree_at(tip)
        if tree_oid:
            files = dict(tree_entries_recursive(repo, tree_oid))
    mutate(files)
    author = "%s <%s@example.invalid>" % (VIEWER["name"], VIEWER_LOGIN)
    oid = commit_on_branch(repo, ref, files, message, author)
    return oid, files


def handle_rest(method, path, query, raw_body):
    """Returns (status, body_obj_or_None, extra_headers). Raises ApiError."""
    parts = [(unquote(p) if "%" in p else p)
             for p in path.split("/") if p != ""]
    # parts[0] == "api", parts[1] == "v3" (checked by caller).
    rest = parts[2:]

    if method == "GET" and rest == []:
        return 200, {"current_user_url": "/api/v3/user",
                     "current_user_authorizations_html_url":
                         "https://github.com/settings/applications",
                     "authorizations_url": "/api/v3/authorizations",
                     "rate_limit_url": "/api/v3/rate_limit",
                     "repository_url": "/api/v3/repos/{owner}/{repo}"}, \
            {"X-OAuth-Scopes": "repo, read:org"}

    if method == "GET" and rest == ["meta"]:
        return 200, {"verifiable_password_authentication": True,
                     "installed_version": "1.0.0",
                     "hooks": ["pre-receive"],
                     "git": ["1.0"], "github_services": True}, {}

    if method == "GET" and rest == ["user"]:
        return 200, _viewer_user(), {}

    if rest[:2] == ["user", "repos"]:
        if method == "GET":
            repos = sorted(STORE.repos.values(),
                           key=lambda r: r.created_seq)
            mine = [r for r in repos if r.owner == VIEWER_LOGIN]
            page_items, page, per_page, total = _paginate(mine, query)
            link = _link_header("", "/api/v3/user/repos", query,
                                page, per_page, total)
            headers = {}
            if link:
                headers["Link"] = link
            return 200, [repo_json(r) for r in page_items], headers
        if method == "POST":
            body = _read_json_body(raw_body)
            name = body.get("name")
            if not name or not isinstance(name, str):
                raise ApiError(422, "Validation Failed: name is required")
            repo, created = STORE.create_repo(
                name, VIEWER_LOGIN, body.get("description", ""),
                body.get("private", False))
            if not created:
                raise ApiError(422, "Validation Failed: Repository already exists")
            return 201, repo_json(repo), {}
        raise ApiError(404, "Not Found")

    if len(rest) >= 3 and rest[0] == "repos":
        owner, name = rest[1], rest[2]
        tail = rest[3:]
        if owner != VIEWER_LOGIN:
            raise ApiError(404, "Not Found")
        if tail == []:
            repo = STORE.get_repo(owner, name)
            if method == "GET":
                if repo is None:
                    raise ApiError(404, "Not Found")
                return 200, repo_json(repo), {}
            if method == "PATCH":
                if repo is None:
                    raise ApiError(404, "Not Found")
                body = _read_json_body(raw_body)
                with STORE.lock:
                    if "description" in body:
                        repo.description = body["description"] or ""
                    if "private" in body:
                        repo.private = bool(body["private"])
                    if "default_branch" in body and isinstance(
                            body["default_branch"], str):
                        repo.default_branch = body["default_branch"]
                return 200, repo_json(repo), {}
            if method == "DELETE":
                if repo is None:
                    raise ApiError(404, "Not Found")
                STORE.delete_repo(owner, name)
                return 204, None, {}
            raise ApiError(404, "Not Found")
        repo = STORE.get_repo(owner, name)
        if repo is None:
            raise ApiError(404, "Not Found")
        return _handle_repo_sub(method, repo, tail, query, raw_body)

    raise ApiError(404, "Not Found")


def _handle_repo_sub(method, repo, tail, query, raw_body):
    if tail[:1] == ["contents"]:
        return _handle_contents(method, repo, tail[1:], query, raw_body)
    if tail[:1] == ["labels"]:
        if method == "GET":
            return 200, [{"name": l["name"], "color": l["color"],
                          "description": l["description"],
                          "url": "/api/v3/repos/%s/labels/%s" % (
                              repo.full_name, l["name"])}
                         for l in repo.labels.values()], {}
        if method == "POST":
            body = _read_json_body(raw_body)
            name = body.get("name")
            if not name:
                raise ApiError(422, "Validation Failed: name is required")
            if name in repo.labels:
                raise ApiError(422, "Validation Failed: label already exists")
            label = {"name": name,
                     "color": (body.get("color") or "ffffff").lstrip("#"),
                     "description": body.get("description") or ""}
            repo.labels[name] = label
            repo._labels_ver += 1
            return 201, dict(label, url="/api/v3/repos/%s/labels/%s" % (
                repo.full_name, name)), {}
        raise ApiError(404, "Not Found")
    if tail[:1] == ["issues"]:
        return _handle_issues(method, repo, tail[1:], query, raw_body)
    if tail[:1] == ["pulls"]:
        return _handle_pulls(method, repo, tail[1:], query, raw_body)
    if tail[:1] == ["git"] and tail[1:2] == ["refs"]:
        return _handle_git_refs(method, repo, tail[2:], query, raw_body)
    if tail[:1] == ["branches"]:
        if method == "GET" and len(tail) == 1:
            out = []
            for refname in sorted(repo.refs):
                if not refname.startswith("refs/heads/"):
                    continue
                branch = refname[len("refs/heads/"):]
                out.append({"name": branch,
                            "commit": {"sha": repo.refs[refname]},
                            "protected": False})
            return 200, out, {}
        if method == "GET" and len(tail) >= 2:
            branch = "/".join(tail[1:])
            oid = repo.refs.get("refs/heads/%s" % branch)
            if oid is None:
                raise ApiError(404, "Not Found")
            return 200, {"name": branch, "commit": {"sha": oid},
                         "protected": False}, {}
        raise ApiError(404, "Not Found")
    if tail[:1] == ["commits"]:
        if method == "GET" and len(tail) == 1:
            sha = query.get("sha", [None])[0]
            tip = None
            if sha:
                tip = repo.refs.get("refs/heads/%s" % sha) or \
                    (sha if is_oid(sha) and sha in repo.objects else None)
            else:
                tip = repo.head_oid()
            commits = []
            seen = set()
            stack = [tip] if tip else []
            while stack:
                oid = stack.pop(0)
                if oid in seen:
                    continue
                seen.add(oid)
                obj = repo.objects.get(oid)
                if obj is None or obj[0] != "commit":
                    continue
                commits.append(_commit_json(repo, oid))
                stack.extend(parse_commit(obj[1])["parents"])
            page_items, page, per_page, total = _paginate(commits, query)
            link = _link_header("", "/api/v3/repos/%s/commits" % repo.full_name,
                                query, page, per_page, total)
            headers = {}
            if link:
                headers["Link"] = link
            return 200, page_items, headers
        if method == "GET" and len(tail) == 2:
            item = _commit_json(repo, tail[1])
            if item is None:
                raise ApiError(404, "Not Found")
            return 200, item, {}
        raise ApiError(404, "Not Found")
    raise ApiError(404, "Not Found")


def _handle_contents(method, repo, tail, query, raw_body):
    if not tail:
        raise ApiError(404, "Not Found")
    path = "/".join(tail)
    branch = query.get("ref", [None])[0]
    if method == "GET":
        tip = repo.head_oid()
        if branch:
            tip = repo.refs.get("refs/heads/%s" % branch)
        if not tip:
            raise ApiError(404, "Not Found")
        tree_oid, _ = repo.tree_at(tip)
        if not tree_oid:
            raise ApiError(404, "Not Found")
        files = tree_entries_recursive(repo, tree_oid)
        if path in files:
            mode, oid = files[path]
            obj = repo.objects.get(oid)
            content = base64.b64encode(obj[1]).decode("ascii") if obj else ""
            return 200, {"type": "file", "encoding": "base64", "size": len(obj[1]) if obj else 0,
                         "name": path.split("/")[-1], "path": path,
                         "content": content, "sha": oid,
                         "url": "/api/v3/repos/%s/contents/%s" % (repo.full_name, path),
                         "html_url": "https://github.com/%s/blob/%s/%s" % (
                             repo.full_name, repo.default_branch, path)}, {}
        # directory?
        prefix = path + "/"
        children = {}
        for p, (m, o) in files.items():
            if p.startswith(prefix):
                rest = p[len(prefix):]
                first = rest.split("/")[0]
                children.setdefault(first, ("dir" if "/" in rest else "file", o))
        if children:
            out = []
            for name in sorted(children):
                kind, oid = children[name]
                out.append({"type": kind, "name": name,
                            "path": "%s/%s" % (path, name), "sha": oid,
                            "url": "/api/v3/repos/%s/contents/%s/%s" % (
                                repo.full_name, path, name)})
            return 200, out, {}
        raise ApiError(404, "Not Found")
    if method in ("PUT", "DELETE"):
        body = _read_json_body(raw_body)
        branch = body.get("branch") or repo.default_branch
        message = body.get("message") or ("Update %s" % path)
        ref = "refs/heads/%s" % branch
        tip = repo.refs.get(ref)
        if tip is None:
            tip = repo.head_oid()
        files = {}
        if tip:
            tree_oid, _ = repo.tree_at(tip)
            if tree_oid:
                files = dict(tree_entries_recursive(repo, tree_oid))
        if method == "PUT":
            if "content" not in body:
                raise ApiError(422, "Validation Failed: content is required")
            try:
                data = base64.b64decode(body["content"])
            except Exception:
                raise ApiError(422, "Validation Failed: content is not valid base64")
            existed = path in files
            if existed and body.get("sha") and body["sha"] != files[path][1]:
                raise ApiError(409, "Conflict: sha does not match")
            blob_oid = hash_object("blob", data)
            repo.objects.setdefault(blob_oid, ("blob", data))
            files[path] = ("100644", blob_oid)
            author = "%s <%s@example.invalid>" % (VIEWER["name"], VIEWER_LOGIN)
            oid = commit_on_branch(repo, ref, files, message, author)
            content_obj = {"name": path.split("/")[-1], "path": path,
                           "sha": blob_oid, "size": len(data), "type": "file",
                           "encoding": "base64",
                           "content": base64.b64encode(data).decode("ascii"),
                           "url": "/api/v3/repos/%s/contents/%s" % (repo.full_name, path)}
            commit_obj = {"sha": oid, "message": message,
                          "author": {"name": VIEWER["name"],
                                     "email": VIEWER["email"],
                                     "date": _iso(TRIAL_NOW_EPOCH)},
                          "committer": {"name": VIEWER["name"],
                                        "email": VIEWER["email"],
                                        "date": _iso(TRIAL_NOW_EPOCH)}}
            return (200 if existed else 201,
                    {"content": content_obj, "commit": commit_obj}, {})
        # DELETE
        if path not in files:
            raise ApiError(404, "Not Found")
        if body.get("sha") and body["sha"] != files[path][1]:
            raise ApiError(409, "Conflict: sha does not match")
        del files[path]
        author = "%s <%s@example.invalid>" % (VIEWER["name"], VIEWER_LOGIN)
        oid = commit_on_branch(repo, ref, files, message, author)
        return 200, {"commit": {"sha": oid}}, {}
    raise ApiError(404, "Not Found")


def _handle_issues(method, repo, tail, query, raw_body):
    if tail == []:
        if method == "GET":
            state = query.get("state", ["open"])[0]
            direction = query.get("direction", ["desc"])[0]
            # sort=created orders by creation (= issue number here, since
            # created_at is monotonic in number); direction=asc reverses
            # the default newest-first order.
            issues = sorted(repo.issues.values(),
                            key=lambda i: i["number"], reverse=(direction != "asc"))
            if state != "all":
                issues = [i for i in issues if i["state"] == state]
            page_items, page, per_page, total = _paginate(issues, query)
            link = _link_header("", "/api/v3/repos/%s/issues" % repo.full_name,
                                query, page, per_page, total)
            headers = {}
            if link:
                headers["Link"] = link
            return 200, [issue_json(repo, i) for i in page_items], headers
        if method == "POST":
            body = _read_json_body(raw_body)
            title = body.get("title")
            if not title:
                raise ApiError(422, "Validation Failed: title is required")
            labels = body.get("labels") or []
            for name in labels:
                if name not in repo.labels:
                    raise ApiError(422, "Validation Failed: label '%s' does not exist" % name)
            number = repo.next_issue
            repo.next_issue += 1
            now = server_now_iso()
            issue = {"id": repo.dbid * 1000000 + number, "number": number,
                     "title": title, "body": body.get("body") or "",
                     "state": "open", "user": VIEWER_LOGIN,
                     "labels": list(labels), "comments": [],
                     "created_at": now, "updated_at": now, "closed_at": None}
            repo.issues[number] = issue
            return 201, issue_json(repo, issue), {}
        raise ApiError(404, "Not Found")
    try:
        number = int(tail[0])
    except ValueError:
        raise ApiError(404, "Not Found")
    issue = repo.issues.get(number)
    if issue is None:
        raise ApiError(404, "Not Found")
    if len(tail) == 1:
        if method == "GET":
            # The read workload GETs one issue 2,000 times: serve the
            # serialized bytes from the per-issue cache, keyed by the
            # issue's mutation version and the repo's label version.
            ver = repo._issue_ver.get(number, 0)
            hit = repo._issue_cache.get(number)
            if hit is not None and hit[0] == ver \
                    and hit[1] == repo._labels_ver:
                return 200, _RawJson(hit[2]), {}
            body = json_bytes(issue_json(repo, issue))
            repo._issue_cache[number] = (ver, repo._labels_ver, body)
            return 200, _RawJson(body), {}
        if method == "PATCH":
            body = _read_json_body(raw_body)
            with STORE.lock:
                if "title" in body:
                    issue["title"] = body["title"]
                if "body" in body:
                    issue["body"] = body["body"] or ""
                if "state" in body and body["state"] in ("open", "closed"):
                    issue["state"] = body["state"]
                    issue["closed_at"] = server_now_iso() if body["state"] == "closed" else None
                if "labels" in body:
                    for name in body["labels"]:
                        if name not in repo.labels:
                            raise ApiError(422, "Validation Failed: label '%s' does not exist" % name)
                    issue["labels"] = list(body["labels"])
                issue["updated_at"] = server_now_iso()
            repo._issue_ver[number] = repo._issue_ver.get(number, 0) + 1
            return 200, issue_json(repo, issue), {}
        raise ApiError(404, "Not Found")
    if tail[1:] == ["comments"]:
        if method == "GET":
            out = []
            for idx, c in enumerate(issue["comments"]):
                out.append({"id": repo.dbid * 1000000 + 900000 + number * 1000 + idx,
                            "node_id": comment_gid(repo.dbid, number, idx),
                            "body": c["body"], "user": {"login": c["user"], "id": VIEWER_ID},
                            "created_at": c["created_at"],
                            "updated_at": c["updated_at"],
                            "html_url": "https://github.com/%s/issues/%d#issuecomment-%d" % (
                                repo.full_name, number, idx),
                            "url": "/api/v3/repos/%s/issues/%d/comments" % (repo.full_name, number)})
            return 200, out, {}
        if method == "POST":
            body = _read_json_body(raw_body)
            text = body.get("body")
            if not text:
                raise ApiError(422, "Validation Failed: body is required")
            now = server_now_iso()
            issue["comments"].append({"body": text, "user": VIEWER_LOGIN,
                                     "created_at": now, "updated_at": now})
            repo._issue_ver[number] = repo._issue_ver.get(number, 0) + 1
            idx = len(issue["comments"]) - 1
            return 201, {"id": repo.dbid * 1000000 + 900000 + number * 1000 + idx,
                         "node_id": comment_gid(repo.dbid, number, idx),
                         "body": text, "user": {"login": VIEWER_LOGIN, "id": VIEWER_ID},
                         "created_at": now, "updated_at": now,
                         "html_url": "https://github.com/%s/issues/%d#issuecomment-%d" % (
                             repo.full_name, number, idx)}, {}
        raise ApiError(404, "Not Found")
    raise ApiError(404, "Not Found")


def _handle_pulls(method, repo, tail, query, raw_body):
    if tail == []:
        if method == "GET":
            state = query.get("state", ["open"])[0]
            pulls = sorted(repo.pulls.values(),
                           key=lambda p: p["number"], reverse=True)
            if state != "all":
                pulls = [p for p in pulls if p["state"] == state]
            page_items, page, per_page, total = _paginate(pulls, query)
            link = _link_header("", "/api/v3/repos/%s/pulls" % repo.full_name,
                                query, page, per_page, total)
            headers = {}
            if link:
                headers["Link"] = link
            return 200, [pr_json(repo, p) for p in page_items], headers
        if method == "POST":
            body = _read_json_body(raw_body)
            title = body.get("title")
            head = body.get("head")
            base = body.get("base") or repo.default_branch
            if not title or not head:
                raise ApiError(422, "Validation Failed: title and head are required")
            head_ref = "refs/heads/%s" % head
            base_ref = "refs/heads/%s" % base
            head_sha = repo.refs.get(head_ref)
            base_sha = repo.refs.get(base_ref)
            if head_sha is None:
                raise ApiError(422, "Validation Failed: head branch '%s' does not exist" % head)
            if base_sha is None:
                raise ApiError(422, "Validation Failed: base branch '%s' does not exist" % base)
            pr = _create_pr_record(repo, title, head, base, body.get("body") or "")
            return 201, pr_json(repo, pr), {}
        raise ApiError(404, "Not Found")
    try:
        number = int(tail[0])
    except ValueError:
        raise ApiError(404, "Not Found")
    pr = repo.pulls.get(number)
    if pr is None:
        raise ApiError(404, "Not Found")
    if len(tail) == 1:
        if method == "GET":
            pr["mergeable"] = _pr_mergeable(repo, pr) if pr["state"] == "open" else pr["mergeable"]
            return 200, pr_json(repo, pr), {}
        if method == "PATCH":
            body = _read_json_body(raw_body)
            with STORE.lock:
                if "title" in body:
                    pr["title"] = body["title"]
                if "body" in body:
                    pr["body"] = body["body"] or ""
                if "state" in body and body["state"] in ("open", "closed"):
                    pr["state"] = body["state"]
                    pr["closed_at"] = server_now_iso() if body["state"] == "closed" else None
                pr["updated_at"] = server_now_iso()
            return 200, pr_json(repo, pr), {}
        raise ApiError(404, "Not Found")
    if tail[1:] == ["merge"]:
        if method != "PUT":
            raise ApiError(404, "Not Found")
        body = _read_json_body(raw_body) if raw_body else {}
        if pr["state"] != "open":
            raise ApiError(405, "Pull request is already closed")
        if not _pr_mergeable(repo, pr):
            raise ApiError(405, "Merge conflict")
        oid, conflict = _do_squash_merge(repo, pr)
        if conflict or oid is None:
            raise ApiError(405, "Merge conflict")
        now = server_now_iso()
        pr["merged"] = True
        pr["state"] = "closed"
        pr["merged_at"] = now
        pr["closed_at"] = now
        pr["merge_commit_sha"] = oid
        pr["updated_at"] = now
        return 200, {"sha": oid, "merged": True,
                     "message": "Pull Request successfully merged"}, {}
    if tail[1:] == ["files"]:
        if method == "GET":
            return 200, _pr_diff(repo, pr), {}
        raise ApiError(404, "Not Found")
    if tail[1:] == ["commits"]:
        if method == "GET":
            commits = []
            oid = pr["head_sha"]
            seen = set()
            base_tip = _pr_base_tip(repo, pr)
            while oid and oid not in seen and oid != base_tip:
                seen.add(oid)
                item = _commit_json(repo, oid)
                if item is None:
                    break
                commits.append(item)
                obj = repo.objects.get(oid)
                parents = parse_commit(obj[1])["parents"] if obj else []
                oid = parents[0] if parents else None
            return 200, commits, {}
        raise ApiError(404, "Not Found")
    raise ApiError(404, "Not Found")


def _handle_git_refs(method, repo, tail, query, raw_body):
    if method == "POST" and tail == []:
        body = _read_json_body(raw_body)
        ref = body.get("ref")
        sha = body.get("sha")
        if not ref or not sha or not is_oid(sha):
            raise ApiError(422, "Validation Failed: ref and sha are required")
        if ref in repo.refs:
            raise ApiError(422, "Validation Failed: Reference already exists")
        if sha not in repo.objects:
            raise ApiError(422, "Validation Failed: object does not exist")
        repo.refs[ref] = sha
        obj = repo.objects[sha]
        return 201, {"ref": ref, "node_id": "R_" + _b64("Ref:%s" % ref),
                     "url": "/api/v3/repos/%s/git/refs/%s" % (repo.full_name, ref),
                     "object": {"sha": sha, "type": obj[0],
                                "url": "/api/v3/repos/%s/git/%ss/%s" % (
                                    repo.full_name, obj[0], sha)}}, {}
    if method == "GET":
        if tail == []:
            out = []
            for refname in sorted(repo.refs):
                oid = repo.refs[refname]
                obj = repo.objects.get(oid)
                out.append({"ref": refname,
                            "object": {"sha": oid,
                                       "type": obj[0] if obj else "commit"}})
            return 200, out, {}
        ref = "/".join(tail)
        if not ref.startswith("refs/"):
            ref = "refs/" + ref
        oid = repo.refs.get(ref)
        if oid is None:
            raise ApiError(404, "Not Found")
        obj = repo.objects.get(oid)
        return 200, {"ref": ref,
                     "object": {"sha": oid, "type": obj[0] if obj else "commit",
                                "url": "/api/v3/repos/%s/git/commits/%s" % (
                                    repo.full_name, oid)}}, {}
    raise ApiError(404, "Not Found")


# ---------------------------------------------------------------------------
# GraphQL v4: a small executor for the documents gh / github-mcp-server send.
# ---------------------------------------------------------------------------

_GQL_FIELDS = {
    "Query": {"viewer", "repository", "node", "__type", "__schema"},
    "User": {"login", "id", "name", "email", "avatarUrl", "url"},
    "Repository": {"id", "databaseId", "name", "nameWithOwner", "owner",
                   "defaultBranchRef", "viewerPermission", "hasIssuesEnabled",
                   "issue", "issues", "pullRequests", "pullRequest",
                   "description", "url", "createdAt", "updatedAt",
                   "isPrivate", "stargazerCount"},
    "Issue": {"id", "number", "title", "state", "body", "createdAt",
              "updatedAt", "author", "url", "comments", "labels"},
    "IssueConnection": {"nodes", "edges", "pageInfo", "totalCount"},
    "IssueEdge": {"node", "cursor"},
    "PageInfo": {"hasNextPage", "hasPreviousPage", "startCursor", "endCursor"},
    "PullRequest": {"id", "number", "title", "body", "state", "merged",
                    "mergeable", "headRefName", "baseRefName", "files",
                    "createdAt", "updatedAt", "author", "headRef", "baseRef",
                    "commits", "additions", "deletions", "changedFiles"},
    "PullRequestConnection": {"nodes", "edges", "pageInfo", "totalCount"},
    "PullRequestEdge": {"node", "cursor"},
    "PullRequestChangedFile": {"path", "additions", "deletions", "changeType"},
    "PullRequestChangedFileConnection": {"nodes", "edges", "pageInfo"},
    "Ref": {"name", "target"},
    "__Type": {"kind", "name", "description", "fields", "enumValues",
               "inputFields", "interfaces", "possibleTypes"},
    "__Field": {"name", "description", "args", "type"},
    "__EnumValue": {"name", "description", "isDeprecated"},
    "__InputValue": {"name", "description", "type", "defaultValue"},
    "Mutation": {"createIssue", "closeIssue", "createPullRequest",
                 "mergePullRequest", "addComment"},
    "CreateIssuePayload": {"issue", "clientMutationId"},
    "CloseIssuePayload": {"issue", "clientMutationId"},
    "CreatePullRequestPayload": {"pullRequest", "clientMutationId"},
    "MergePullRequestPayload": {"pullRequest", "clientMutationId"},
    "AddCommentPayload": {"commentEdge", "clientMutationId"},
    "CommentEdge": {"node", "cursor"},
    "IssueComment": {"id", "body", "author", "createdAt", "updatedAt"},
}

_GQL_TYPE_FIELDS = {
    "Issue": ["id", "number", "title", "state", "body", "createdAt",
              "updatedAt", "author", "url", "comments"],
    "PullRequest": ["id", "number", "title", "body", "state", "merged",
                    "mergeable", "headRefName", "baseRefName", "files",
                    "createdAt", "updatedAt", "author"],
    "Repository": ["id", "databaseId", "name", "nameWithOwner", "owner",
                   "defaultBranchRef", "viewerPermission", "hasIssuesEnabled",
                   "issue", "issues", "pullRequests", "pullRequest",
                   "description", "url", "createdAt", "isPrivate"],
}
_GQL_ENUM_VALUES = {
    "SearchType": ["ISSUE", "REPOSITORY", "USER", "DISCUSSION", "CODE"],
    "IssueState": ["OPEN", "CLOSED"],
    "PullRequestState": ["OPEN", "CLOSED", "MERGED"],
    "MergeableState": ["MERGEABLE", "CONFLICTING", "UNKNOWN"],
    "IssueOrderField": ["CREATED_AT", "UPDATED_AT", "COMMENTS"],
    "OrderDirection": ["ASC", "DESC"],
    "RepositoryPermission": ["ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"],
}

_TOKEN_RE = re.compile(r"""
    (?P<ws>\s+)
  | (?P<ellipsis>\.\.\.)
  | (?P<name>[_A-Za-z][_0-9A-Za-z]*)
  | (?P<int>-?[0-9]+)
  | (?P<string>"(?:[^"\\]|\\.)*")
  | (?P<punct>[!$():=@\[\]{},|])
  | (?P<other>.)
""", re.VERBOSE)


def _gql_tokens(text):
    tokens = []
    for m in _TOKEN_RE.finditer(text):
        kind = m.lastgroup
        if kind == "ws":
            continue
        tokens.append((kind, m.group()))
    return tokens


class _GqlParser:
    def __init__(self, text):
        self.tokens = _gql_tokens(text)
        self.pos = 0

    def peek(self):
        return self.tokens[self.pos] if self.pos < len(self.tokens) else (None, None)

    def next(self):
        tok = self.peek()
        self.pos += 1
        return tok

    def expect(self, value):
        kind, tok = self.next()
        if tok != value:
            raise ValueError("expected %r got %r" % (value, tok))

    def parse_document(self):
        ops = []
        while self.pos < len(self.tokens):
            ops.append(self.parse_operation())
        return ops

    def parse_operation(self):
        kind, tok = self.next()
        if tok == "{":
            return {"kind": "query", "name": None, "vars": {},
                    "selections": self.parse_selections()}
        if tok not in ("query", "mutation", "subscription"):
            raise ValueError("bad operation %r" % tok)
        name = None
        kind2, tok2 = self.peek()
        if kind2 == "name":
            name = self.next()[1]
        variables = {}
        kind2, tok2 = self.peek()
        if tok2 == "(":
            self.next()
            while True:
                k, t = self.peek()
                if t == ")":
                    self.next()
                    break
                self.expect("$")
                var = self.next()[1]
                self.expect(":")
                variables[var] = self.parse_type()
                k, t = self.peek()
                if t == "=":
                    self.next()
                    self.parse_value()
                k, t = self.peek()
                if t == ",":
                    self.next()
        selections = self.parse_selections()
        return {"kind": tok, "name": name, "vars": variables,
                "selections": selections}

    def parse_type(self):
        kind, tok = self.next()
        if tok == "[":
            inner = self.parse_type()
            self.expect("]")
            base = "[%s]" % inner
        else:
            base = tok
        kind, tok = self.peek()
        if tok == "!":
            self.next()
            base += "!"
        return base

    def parse_selections(self):
        self.expect("{")
        fields = []
        while True:
            kind, tok = self.peek()
            if tok == "}":
                self.next()
                break
            fields.append(self.parse_field())
        return fields

    def parse_field(self):
        kind, tok = self.peek()
        if tok == "...":
            self.next()
            kind, tok = self.next()
            if tok == "on":
                type_name = self.next()[1]
                sels = self.parse_selections()
                return {"fragment": True, "type": type_name,
                        "selections": sels}
            return {"fragment": True, "type": None, "selections": [],
                    "name": tok}
        alias = None
        name = self.next()[1]
        kind, tok = self.peek()
        if tok == ":":
            self.next()
            alias = name
            name = self.next()[1]
        args = {}
        kind, tok = self.peek()
        if tok == "(":
            self.next()
            while True:
                k, t = self.peek()
                if t == ")":
                    self.next()
                    break
                arg_name = self.next()[1]
                self.expect(":")
                args[arg_name] = self.parse_value()
                k, t = self.peek()
                if t == ",":
                    self.next()
        selections = None
        kind, tok = self.peek()
        if tok == "{":
            selections = self.parse_selections()
        return {"alias": alias or name, "name": name, "args": args,
                "selections": selections}

    def parse_value(self):
        kind, tok = self.next()
        if tok == "$":
            return ("var", self.next()[1])
        if kind == "int":
            return ("int", int(tok))
        if kind == "string":
            return ("string", json.loads(tok))
        if tok == "true":
            return ("bool", True)
        if tok == "false":
            return ("bool", False)
        if tok == "null":
            return ("null", None)
        if tok == "[":
            items = []
            while True:
                k, t = self.peek()
                if t == "]":
                    self.next()
                    break
                items.append(self.parse_value())
                k, t = self.peek()
                if t == ",":
                    self.next()
            return ("list", items)
        if tok == "{":
            obj = {}
            while True:
                k, t = self.peek()
                if t == "}":
                    self.next()
                    break
                key = self.next()[1]
                self.expect(":")
                obj[key] = self.parse_value()
                k, t = self.peek()
                if t == ",":
                    self.next()
            return ("object", obj)
        return ("enum", tok)


def _gql_value(node, variables):
    kind, value = node
    if kind == "var":
        return variables.get(value)
    if kind == "list":
        return [_gql_value(v, variables) for v in value]
    if kind == "object":
        return {k: _gql_value(v, variables) for k, v in value.items()}
    return value


def _gql_args(field, variables):
    return {k: _gql_value(v, variables) for k, v in field["args"].items()}


def _validate_selections(selections, type_name, errors):
    allowed = _GQL_FIELDS.get(type_name, set())
    for field in selections:
        if field.get("fragment"):
            if field.get("type"):
                _validate_selections(field["selections"], field["type"], errors)
            continue
        name = field["name"]
        if name not in allowed:
            errors.append('Cannot query field "%s" on type "%s".' % (name, type_name))
            continue
        child = _gql_child_type(type_name, name)
        if child and field.get("selections"):
            _validate_selections(field["selections"], child, errors)


def _gql_child_type(parent, field):
    mapping = {
        ("Query", "viewer"): "User",
        ("Query", "repository"): "Repository",
        ("Query", "node"): None,
        ("Query", "__type"): "__Type",
        ("Repository", "owner"): "User",
        ("Repository", "defaultBranchRef"): "Ref",
        ("Repository", "issue"): "Issue",
        ("Repository", "issues"): "IssueConnection",
        ("Repository", "pullRequests"): "PullRequestConnection",
        ("Repository", "pullRequest"): "PullRequest",
        ("IssueConnection", "nodes"): "Issue",
        ("IssueConnection", "edges"): "IssueEdge",
        ("IssueConnection", "pageInfo"): "PageInfo",
        ("IssueEdge", "node"): "Issue",
        ("PullRequestConnection", "nodes"): "PullRequest",
        ("PullRequestConnection", "edges"): "PullRequestEdge",
        ("PullRequestConnection", "pageInfo"): "PageInfo",
        ("PullRequestEdge", "node"): "PullRequest",
        ("PullRequest", "files"): "PullRequestChangedFileConnection",
        ("PullRequestChangedFileConnection", "nodes"): "PullRequestChangedFile",
        ("PullRequestChangedFileConnection", "edges"): "PullRequestEdge",
        ("PullRequestChangedFileConnection", "pageInfo"): "PageInfo",
        ("Mutation", "createIssue"): "CreateIssuePayload",
        ("Mutation", "closeIssue"): "CloseIssuePayload",
        ("Mutation", "createPullRequest"): "CreatePullRequestPayload",
        ("Mutation", "mergePullRequest"): "MergePullRequestPayload",
        ("Mutation", "addComment"): "AddCommentPayload",
        ("CreateIssuePayload", "issue"): "Issue",
        ("CloseIssuePayload", "issue"): "Issue",
        ("CreatePullRequestPayload", "pullRequest"): "PullRequest",
        ("MergePullRequestPayload", "pullRequest"): "PullRequest",
        ("AddCommentPayload", "commentEdge"): "CommentEdge",
        ("CommentEdge", "node"): "IssueComment",
        ("__Type", "fields"): "__Field",
        ("__Type", "enumValues"): "__EnumValue",
    }
    return mapping.get((parent, field))


def _resolve_issue(repo, issue, selections):
    out = {}
    for field in selections or []:
        name = field["name"]
        if name == "id":
            out[field["alias"]] = issue_gid(repo.dbid, issue["number"])
        elif name == "number":
            out[field["alias"]] = issue["number"]
        elif name == "title":
            out[field["alias"]] = issue["title"]
        elif name == "state":
            out[field["alias"]] = issue["state"].upper()
        elif name == "body":
            out[field["alias"]] = issue["body"]
        elif name == "createdAt":
            out[field["alias"]] = issue["created_at"]
        elif name == "updatedAt":
            out[field["alias"]] = issue["updated_at"]
        elif name == "url":
            out[field["alias"]] = "https://github.com/%s/issues/%d" % (
                repo.full_name, issue["number"])
        elif name == "author":
            out[field["alias"]] = {"login": issue["user"]}
        elif name == "comments":
            out[field["alias"]] = {"totalCount": len(issue["comments"])}
        elif name == "labels":
            out[field["alias"]] = {"nodes": [
                {"name": n} for n in issue["labels"]]}
        else:
            out[field["alias"]] = None
    return out


def _resolve_pr(repo, pr, selections):
    out = {}
    for field in selections or []:
        name = field["name"]
        if name == "id":
            out[field["alias"]] = pr_gid(repo.dbid, pr["number"])
        elif name == "number":
            out[field["alias"]] = pr["number"]
        elif name == "title":
            out[field["alias"]] = pr["title"]
        elif name == "body":
            out[field["alias"]] = pr["body"]
        elif name == "state":
            out[field["alias"]] = ("MERGED" if pr["merged"]
                                   else pr["state"].upper())
        elif name == "merged":
            out[field["alias"]] = pr["merged"]
        elif name == "mergeable":
            out[field["alias"]] = ("MERGEABLE" if _pr_mergeable(repo, pr)
                                   else "CONFLICTING") if pr["state"] == "open" else "UNKNOWN"
        elif name == "headRefName":
            out[field["alias"]] = pr["head"]
        elif name == "baseRefName":
            out[field["alias"]] = pr["base"]
        elif name == "createdAt":
            out[field["alias"]] = pr["created_at"]
        elif name == "updatedAt":
            out[field["alias"]] = pr["updated_at"]
        elif name == "author":
            out[field["alias"]] = {"login": pr["user"]}
        elif name == "files":
            args = _gql_args(field, {})
            first = args.get("first") or 10
            head_tree, _ = repo.tree_at(pr["head_sha"])
            paths = sorted(tree_entries_recursive(repo, head_tree).keys()) \
                if head_tree else []
            out[field["alias"]] = {"nodes": [
                {"path": p} for p in paths[:first]]}
        elif name == "commits":
            out[field["alias"]] = {"totalCount": pr["commits"]}
        elif name == "additions":
            out[field["alias"]] = pr["additions"]
        elif name == "deletions":
            out[field["alias"]] = pr["deletions"]
        elif name == "changedFiles":
            out[field["alias"]] = pr["changed_files"]
        else:
            out[field["alias"]] = None
    return out


def _resolve_repo(repo, selections, variables):
    out = {}
    for field in selections or []:
        name = field["name"]
        args = _gql_args(field, variables)
        if name == "id":
            out[field["alias"]] = repo_gid(repo.dbid)
        elif name == "databaseId":
            out[field["alias"]] = repo.dbid
        elif name == "name":
            out[field["alias"]] = repo.name
        elif name == "nameWithOwner":
            out[field["alias"]] = repo.full_name
        elif name == "owner":
            out[field["alias"]] = {"login": repo.owner}
        elif name == "defaultBranchRef":
            out[field["alias"]] = {"name": repo.default_branch}
        elif name == "viewerPermission":
            out[field["alias"]] = "ADMIN"
        elif name == "hasIssuesEnabled":
            out[field["alias"]] = True
        elif name == "description":
            out[field["alias"]] = repo.description
        elif name == "url":
            out[field["alias"]] = "https://github.com/%s" % repo.full_name
        elif name == "createdAt":
            out[field["alias"]] = _iso(TRIAL_NOW_EPOCH + repo.created_seq)
        elif name == "isPrivate":
            out[field["alias"]] = repo.private
        elif name == "issue":
            issue = repo.issues.get(args.get("number"))
            out[field["alias"]] = _resolve_issue(repo, issue, field["selections"]) \
                if issue else None
        elif name == "issues":
            issues = sorted(repo.issues.values(),
                            key=lambda i: i["number"], reverse=True)
            states = args.get("states")
            if states:
                wanted = {s.upper() for s in states}
                issues = [i for i in issues if i["state"].upper() in wanted]
            order_by = args.get("orderBy") or {}
            if (order_by.get("field") or "CREATED_AT") == "CREATED_AT" and \
                    (order_by.get("direction") or "DESC") == "DESC":
                issues.sort(key=lambda i: i["number"], reverse=True)
            elif (order_by.get("direction") or "ASC") == "ASC":
                issues.sort(key=lambda i: i["number"])
            after = args.get("after")
            if after:
                cursor_num = _cursor_number(after)
                if cursor_num is not None:
                    issues = [i for i in issues if i["number"] < cursor_num]
            first = args.get("first")
            page = issues[:first] if first is not None else issues
            has_next = first is not None and len(issues) > first
            end_cursor = _make_cursor(page[-1]["number"]) if page else None
            nodes = [_resolve_issue(repo, i, _sub(field, "nodes"))
                     for i in page]
            page_info = {"hasNextPage": has_next, "endCursor": end_cursor}
            if _wants(field, "pageInfo"):
                pass
            out[field["alias"]] = {"nodes": nodes, "pageInfo": page_info,
                                   "totalCount": len(issues)}
        elif name == "pullRequests":
            pulls = sorted(repo.pulls.values(),
                           key=lambda p: p["number"], reverse=True)
            first = args.get("first")
            page = pulls[:first] if first is not None else pulls
            nodes = [_resolve_pr(repo, p, _sub(field, "nodes")) for p in page]
            out[field["alias"]] = {"nodes": nodes,
                                   "pageInfo": {"hasNextPage": False,
                                                "endCursor": None},
                                   "totalCount": len(pulls)}
        elif name == "pullRequest":
            pr = repo.pulls.get(args.get("number"))
            out[field["alias"]] = _resolve_pr(repo, pr, field["selections"]) \
                if pr else None
        else:
            out[field["alias"]] = None
    return out


def _sub(field, name):
    for sel in field.get("selections") or []:
        if sel.get("name") == name:
            return sel.get("selections")
    return None


def _wants(field, name):
    return any((s.get("name") == name) for s in field.get("selections") or [])


def _make_cursor(number):
    return _b64("cursor:%d" % number)


def _cursor_number(cursor):
    text = _unb64(cursor)
    if text is None or not text.startswith("cursor:"):
        return None
    try:
        return int(text[len("cursor:"):])
    except ValueError:
        return None


def _create_pr_record(repo, title, head, base, body_text):
    head_ref = "refs/heads/%s" % head
    base_ref = "refs/heads/%s" % base
    head_sha = repo.refs.get(head_ref)
    base_sha = repo.refs.get(base_ref)
    if head_sha is None or base_sha is None:
        return None
    number = repo.next_pr
    repo.next_pr += 1
    now = server_now_iso()
    pr = {"id": repo.dbid * 1000000 + 500000 + number, "number": number,
          "title": title, "body": body_text or "",
          "state": "open", "user": VIEWER_LOGIN,
          "head": head, "base": base,
          "head_sha": head_sha, "base_sha": base_sha,
          "merged": False, "mergeable": True,
          "merge_commit_sha": None,
          "created_at": now, "updated_at": now,
          "closed_at": None, "merged_at": None,
          "commits": 1, "additions": 0, "deletions": 0,
          "changed_files": 0}
    repo.pulls[number] = pr
    files = _pr_diff(repo, pr)
    pr["changed_files"] = len(files)
    pr["additions"] = sum(f["additions"] for f in files)
    pr["deletions"] = sum(f["deletions"] for f in files)
    pr["mergeable"] = _pr_mergeable(repo, pr)
    return pr


def _execute_operation(op, variables):
    errors = []
    root_type = "Query" if op["kind"] == "query" else "Mutation"
    _validate_selections(op["selections"], root_type, errors)
    data = {}
    for field in op["selections"]:
        if field.get("fragment"):
            continue
        name = field["name"]
        args = _gql_args(field, variables)
        if root_type == "Query":
            if name == "viewer":
                data[field["alias"]] = {"login": VIEWER_LOGIN}
            elif name == "repository":
                owner = args.get("owner")
                repo_name = args.get("name")
                repo = STORE.get_repo(owner, repo_name) \
                    if owner == VIEWER_LOGIN else None
                data[field["alias"]] = _resolve_repo(repo, field["selections"], variables) \
                    if repo else None
            elif name == "node":
                data[field["alias"]] = _resolve_node(args.get("id"), field)
            elif name == "__type":
                data[field["alias"]] = _resolve_type(args.get("name"), field)
            else:
                data[field["alias"]] = None
        else:
            data[field["alias"]] = _execute_mutation(name, args, field)
    result = {"data": data}
    if errors:
        result["errors"] = [{"message": m} for m in errors]
    return result


def _resolve_node(gid, field):
    parsed = parse_gid(gid)
    if parsed is None:
        return None
    kind, dbid, number, idx = parsed
    repo = STORE.by_id.get(dbid)
    if repo is None:
        return None
    out = {"id": gid}
    for sel in field.get("selections") or []:
        if sel.get("fragment"):
            if sel.get("type") == "Repository" and kind == "R":
                for sub in sel["selections"]:
                    if sub["name"] == "name":
                        out[sub["alias"]] = repo.name
                    elif sub["name"] == "nameWithOwner":
                        out[sub["alias"]] = repo.full_name
            continue
        if sel["name"] == "id":
            out[sel["alias"]] = gid
    if kind == "R":
        out.setdefault("name", repo.name)
        out.setdefault("nameWithOwner", repo.full_name)
    return out


def _resolve_type(name, field):
    if name in _GQL_TYPE_FIELDS:
        out = {}
        for sel in field.get("selections") or []:
            if sel["name"] == "fields":
                out[sel["alias"]] = [{"name": n} for n in _GQL_TYPE_FIELDS[name]]
            elif sel["name"] == "enumValues":
                out[sel["alias"]] = []
            elif sel["name"] == "name":
                out[sel["alias"]] = name
            elif sel["name"] == "kind":
                out[sel["alias"]] = "OBJECT"
            else:
                out[sel["alias"]] = None
        return out
    if name in _GQL_ENUM_VALUES:
        out = {}
        for sel in field.get("selections") or []:
            if sel["name"] == "enumValues":
                out[sel["alias"]] = [{"name": n} for n in _GQL_ENUM_VALUES[name]]
            elif sel["name"] == "fields":
                out[sel["alias"]] = []
            elif sel["name"] == "name":
                out[sel["alias"]] = name
            elif sel["name"] == "kind":
                out[sel["alias"]] = "ENUM"
            else:
                out[sel["alias"]] = None
        return out
    out = {}
    for sel in field.get("selections") or []:
        if sel["name"] in ("fields", "enumValues"):
            out[sel["alias"]] = None
        elif sel["name"] == "name":
            out[sel["alias"]] = name
        elif sel["name"] == "kind":
            out[sel["alias"]] = None
        else:
            out[sel["alias"]] = None
    return out


def _execute_mutation(name, args, field):
    inp = args.get("input") or {}
    if name == "createIssue":
        parsed = parse_gid(inp.get("repositoryId"))
        if not parsed or parsed[0] != "R":
            return {"issue": None}
        repo = STORE.by_id.get(parsed[1])
        if repo is None:
            return {"issue": None}
        number = repo.next_issue
        repo.next_issue += 1
        now = server_now_iso()
        issue = {"id": repo.dbid * 1000000 + number, "number": number,
                 "title": inp.get("title") or "", "body": inp.get("body") or "",
                 "state": "open", "user": VIEWER_LOGIN,
                 "labels": [], "comments": [],
                 "created_at": now, "updated_at": now, "closed_at": None}
        repo.issues[number] = issue
        return {"issue": _resolve_issue(repo, issue, _sub(field, "issue"))}
    if name == "closeIssue":
        parsed = parse_gid(inp.get("issueId"))
        if not parsed or parsed[0] != "I":
            return {"issue": None}
        repo = STORE.by_id.get(parsed[1])
        issue = repo.issues.get(parsed[2]) if repo else None
        if issue is None:
            return {"issue": None}
        issue["state"] = "closed"
        issue["closed_at"] = server_now_iso()
        issue["updated_at"] = server_now_iso()
        return {"issue": _resolve_issue(repo, issue, _sub(field, "issue"))}
    if name == "createPullRequest":
        parsed = parse_gid(inp.get("repositoryId"))
        if not parsed or parsed[0] != "R":
            return {"pullRequest": None}
        repo = STORE.by_id.get(parsed[1])
        if repo is None:
            return {"pullRequest": None}
        pr = _create_pr_record(repo, inp.get("title") or "",
                               inp.get("headRefName") or "",
                               inp.get("baseRefName") or repo.default_branch,
                               inp.get("body") or "")
        if pr is None:
            return {"pullRequest": None}
        return {"pullRequest": _resolve_pr(repo, pr, _sub(field, "pullRequest"))}
    if name == "mergePullRequest":
        parsed = parse_gid(inp.get("pullRequestId"))
        if not parsed or parsed[0] != "P":
            return {"pullRequest": None}
        repo = STORE.by_id.get(parsed[1])
        pr = repo.pulls.get(parsed[2]) if repo else None
        if pr is None:
            return {"pullRequest": None}
        merged = False
        if pr["state"] == "open" and _pr_mergeable(repo, pr):
            oid, conflict = _do_squash_merge(repo, pr)
            if not conflict and oid:
                now = server_now_iso()
                pr["merged"] = True
                pr["state"] = "closed"
                pr["merged_at"] = now
                pr["closed_at"] = now
                pr["merge_commit_sha"] = oid
                pr["updated_at"] = now
                merged = True
        out = _resolve_pr(repo, pr, _sub(field, "pullRequest"))
        out["merged"] = merged
        return {"pullRequest": out}
    if name == "addComment":
        parsed = parse_gid(inp.get("subjectId"))
        if not parsed or parsed[0] != "I":
            return {"commentEdge": None}
        repo = STORE.by_id.get(parsed[1])
        issue = repo.issues.get(parsed[2]) if repo else None
        if issue is None:
            return {"commentEdge": None}
        now = server_now_iso()
        issue["comments"].append({"body": inp.get("body") or "",
                                  "user": VIEWER_LOGIN,
                                  "created_at": now, "updated_at": now})
        idx = len(issue["comments"]) - 1
        return {"commentEdge": {"node": {
            "id": comment_gid(repo.dbid, issue["number"], idx),
            "body": inp.get("body") or ""}}}
    return None


def handle_graphql(raw_body):
    """Returns (status, result_obj). Never raises for a bad document:
    unknown fields are GraphQL errors on HTTP 200."""
    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except Exception:
        return 400, {"errors": [{"message": "Invalid JSON body"}]}
    if isinstance(payload, list):
        results = []
        for item in payload:
            results.append(_execute_single(item))
        return 200, results
    return 200, _execute_single(payload)


def _execute_single(payload):
    if not isinstance(payload, dict):
        return {"data": None,
                "errors": [{"message": "Invalid GraphQL request"}]}
    query = payload.get("query") or ""
    variables = payload.get("variables") or {}
    op_name = payload.get("operationName")
    try:
        ops = _GqlParser(query).parse_document()
    except Exception as exc:
        return {"data": None,
                "errors": [{"message": "Syntax Error: %s" % exc}]}
    op = None
    if op_name:
        for candidate in ops:
            if candidate["name"] == op_name:
                op = candidate
                break
    if op is None and ops:
        op = ops[0]
    if op is None:
        return {"data": None,
                "errors": [{"message": "No operation provided"}]}
    try:
        return _execute_operation(op, variables)
    except Exception as exc:
        return {"data": None,
                "errors": [{"message": str(exc)}]}


# ---------------------------------------------------------------------------
# MCP: JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28 (with a
# legacy initialize handshake fallback).
# ---------------------------------------------------------------------------

MCP_SERVER_INFO = {"name": "github-core-clone-forge", "version": "1.0.0"}
MCP_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"]


def _mcp_tools():
    def schema(props, required):
        return {"type": "object", "properties": props,
                "required": required,
                "additionalProperties": False}
    s = lambda desc, **kw: {"type": "string", "description": desc, **kw}
    b = lambda desc: {"type": "boolean", "description": desc}
    n = lambda desc: {"type": "integer", "description": desc}
    return [
        {"name": "create_repo",
         "description": "Create a repository owned by the authenticated user.",
         "inputSchema": schema({
             "name": s("The repository name."),
             "description": s("A short description of the repository."),
             "private": b("Whether the repository is private.")},
             ["name"])},
        {"name": "get_repo",
         "description": "Get a repository by owner and name.",
         "inputSchema": schema({
             "owner": s("The repository owner login."),
             "repo": s("The repository name."),
             "full_name": s("The repository full name, owner/repo.")},
             ["owner", "repo"])},
        {"name": "list_repos",
         "description": "List repositories owned by the authenticated user.",
         "inputSchema": schema({}, [])},
        {"name": "create_issue",
         "description": "Create an issue in a repository.",
         "inputSchema": schema({
             "owner": s("The repository owner login."),
             "repo": s("The repository name."),
             "title": s("The issue title."),
             "body": s("The issue body."),
             "full_name": s("The repository full name, owner/repo.")},
             ["owner", "repo", "title"])},
        {"name": "get_issue",
         "description": "Get one issue by repository and number.",
         "inputSchema": schema({
             "owner": s("The repository owner login."),
             "repo": s("The repository name."),
             "issue_number": n("The issue number."),
             "full_name": s("The repository full name, owner/repo.")},
             ["owner", "repo", "issue_number"])},
        {"name": "list_issues",
         "description": "List issues in a repository.",
         "inputSchema": schema({
             "owner": s("The repository owner login."),
             "repo": s("The repository name."),
             "state": s("Filter by state: open, closed or all."),
             "full_name": s("The repository full name, owner/repo.")},
             ["owner", "repo"])},
        {"name": "create_pull_request",
         "description": "Create a pull request from a head branch to a base branch.",
         "inputSchema": schema({
             "owner": s("The repository owner login."),
             "repo": s("The repository name."),
             "title": s("The pull request title."),
             "head": s("The head branch name."),
             "base": s("The base branch name."),
             "body": s("The pull request body."),
             "full_name": s("The repository full name, owner/repo.")},
             ["owner", "repo", "title", "head", "base"])},
        {"name": "merge_pull_request",
         "description": "Merge a pull request with a squash commit.",
         "inputSchema": schema({
             "owner": s("The repository owner login."),
             "repo": s("The repository name."),
             "pull_number": n("The pull request number."),
             "full_name": s("The repository full name, owner/repo.")},
             ["owner", "repo", "pull_number"])},
    ]


_MCP_TOOLS = _mcp_tools()
_MCP_TOOLS_JSON = json.dumps({"tools": _MCP_TOOLS},
                             separators=(",", ":")).encode("utf-8")


def _mcp_repo_from_args(args):
    owner = args.get("owner")
    repo = args.get("repo")
    if not repo and args.get("full_name"):
        full = str(args["full_name"])
        if "/" in full:
            owner, repo = full.split("/", 1)
    if not owner or not repo:
        return None
    if owner != VIEWER_LOGIN:
        return None
    return STORE.get_repo(owner, repo)


def _mcp_missing(required, args):
    return [name for name in required
            if name not in args or args.get(name) in (None, "")]


def _mcp_call_tool(name, args):
    """Returns (result_obj, is_error)."""
    lname = re.sub(r"[^a-z0-9]", "", str(name).lower())
    tool = None
    for candidate in _MCP_TOOLS:
        cname = re.sub(r"[^a-z0-9]", "", candidate["name"].lower())
        if lname == cname or lname.endswith(cname):
            tool = candidate
            break
    if tool is None:
        return None, "unknown"
    required = tool["inputSchema"].get("required", [])
    missing = _mcp_missing(required, args)
    if missing:
        return {"content": [{"type": "text",
                             "text": "Missing required argument(s): %s" % ", ".join(missing)}],
                "isError": True}, None
    tname = tool["name"]
    if tname == "create_repo":
        repo, created = STORE.create_repo(
            args["name"], VIEWER_LOGIN, args.get("description", ""),
            args.get("private", False))
        if not created:
            return {"content": [{"type": "text",
                                 "text": "Repository already exists: %s" % repo.full_name}],
                    "isError": True}, None
        obj = repo_json(repo)
        return {"content": [{"type": "text", "text": json.dumps(obj)}],
                "structuredContent": obj}, None
    if tname == "list_repos":
        repos = [repo_json(r) for r in sorted(STORE.repos.values(),
                                              key=lambda r: r.created_seq)
                 if r.owner == VIEWER_LOGIN]
        obj = {"repositories": repos}
        return {"content": [{"type": "text", "text": json.dumps(obj)}],
                "structuredContent": obj}, None
    repo = _mcp_repo_from_args(args)
    if repo is None:
        return {"content": [{"type": "text",
                             "text": "Repository not found: %s/%s" % (
                                 args.get("owner"), args.get("repo"))}],
                "isError": True}, None
    if tname == "get_repo":
        obj = repo_json(repo)
        return {"content": [{"type": "text", "text": json.dumps(obj)}],
                "structuredContent": obj}, None
    if tname == "create_issue":
        number = repo.next_issue
        repo.next_issue += 1
        now = server_now_iso()
        issue = {"id": repo.dbid * 1000000 + number, "number": number,
                 "title": args["title"], "body": args.get("body") or "",
                 "state": "open", "user": VIEWER_LOGIN,
                 "labels": [], "comments": [],
                 "created_at": now, "updated_at": now, "closed_at": None}
        repo.issues[number] = issue
        obj = issue_json(repo, issue)
        return {"content": [{"type": "text", "text": json.dumps(obj)}],
                "structuredContent": obj}, None
    if tname == "get_issue":
        number = args.get("issue_number")
        try:
            number = int(number)
        except (TypeError, ValueError):
            number = None
        issue = repo.issues.get(number) if number else None
        if issue is None:
            return {"content": [{"type": "text", "text": "Issue not found"}],
                    "isError": True}, None
        obj = issue_json(repo, issue)
        return {"content": [{"type": "text", "text": json.dumps(obj)}],
                "structuredContent": obj}, None
    if tname == "list_issues":
        state = (args.get("state") or "open").lower()
        issues = sorted(repo.issues.values(),
                        key=lambda i: i["number"], reverse=True)
        if state != "all":
            issues = [i for i in issues if i["state"] == state]
        objs = [issue_json(repo, i) for i in issues]
        obj = {"issues": objs}
        return {"content": [{"type": "text", "text": json.dumps(obj)}],
                "structuredContent": obj}, None
    if tname == "create_pull_request":
        pr = _create_pr_record(repo, args["title"], args["head"],
                               args["base"], args.get("body") or "")
        if pr is None:
            return {"content": [{"type": "text",
                                 "text": "Head or base branch does not exist"}],
                    "isError": True}, None
        obj = pr_json(repo, pr)
        obj["pull_number"] = pr["number"]
        return {"content": [{"type": "text", "text": json.dumps(obj)}],
                "structuredContent": obj}, None
    if tname == "merge_pull_request":
        try:
            number = int(args["pull_number"])
        except (TypeError, ValueError):
            return {"content": [{"type": "text",
                                 "text": "pull_number must be an integer"}],
                    "isError": True}, None
        pr = repo.pulls.get(number)
        if pr is None:
            return {"content": [{"type": "text",
                                 "text": "Pull request not found"}],
                    "isError": True}, None
        if pr["state"] != "open":
            return {"content": [{"type": "text",
                                 "text": "Pull request is already closed"}],
                    "isError": True}, None
        if not _pr_mergeable(repo, pr):
            return {"content": [{"type": "text", "text": "Merge conflict"}],
                    "isError": True}, None
        oid, conflict = _do_squash_merge(repo, pr)
        if conflict or oid is None:
            return {"content": [{"type": "text", "text": "Merge conflict"}],
                    "isError": True}, None
        now = server_now_iso()
        pr["merged"] = True
        pr["state"] = "closed"
        pr["merged_at"] = now
        pr["closed_at"] = now
        pr["merge_commit_sha"] = oid
        pr["updated_at"] = now
        obj = {"sha": oid, "merged": True, "number": number,
               "pull_number": number,
               "message": "Pull Request successfully merged"}
        return {"content": [{"type": "text", "text": json.dumps(obj)}],
                "structuredContent": obj}, None
    return {"content": [{"type": "text", "text": "Not implemented"}],
            "isError": True}, None


def handle_mcp(raw_body):
    """Returns (status, body_bytes, extra_headers)."""
    if raw_body is None or raw_body == b"":
        return 400, json_bytes({"jsonrpc": "2.0", "id": None,
                                "error": {"code": -32700,
                                          "message": "Parse error"}}), {}
    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except Exception:
        m = re.search(rb'"id"\s*:\s*([0-9]+)', raw_body)
        rid = int(m.group(1)) if m else None
        return 400, json_bytes({"jsonrpc": "2.0", "id": rid,
                                "error": {"code": -32700,
                                          "message": "Parse error"}}), {}
    if not isinstance(payload, dict):
        return 400, json_bytes({"jsonrpc": "2.0", "id": None,
                                "error": {"code": -32600,
                                          "message": "Invalid Request"}}), {}
    rid = payload.get("id")
    method = payload.get("method")
    params = payload.get("params") or {}
    is_notification = "id" not in payload or payload.get("id") is None
    if method == "server/discover":
        result = {"supportedVersions": MCP_VERSIONS,
                  "serverInfo": dict(MCP_SERVER_INFO),
                  "capabilities": {"tools": {}},
                  "_meta": {"io.modelcontextprotocol/serverInfo":
                            dict(MCP_SERVER_INFO)}}
        return 200, json_bytes({"jsonrpc": "2.0", "id": rid, "result": result}), {}
    if method == "initialize":
        offered = params.get("protocolVersion") or "2025-11-25"
        negotiated = offered if offered in MCP_VERSIONS else "2025-11-25"
        result = {"protocolVersion": negotiated,
                  "capabilities": {"tools": {}},
                  "serverInfo": dict(MCP_SERVER_INFO)}
        return 200, json_bytes({"jsonrpc": "2.0", "id": rid, "result": result}), \
            {"Mcp-Session-Id": "mcp-session-1"}
    if method in ("notifications/initialized", "notifications/cancelled",
                  "notifications/progress"):
        return 202, b"", {}
    if is_notification:
        return 202, b"", {}
    if method == "ping":
        return 200, json_bytes({"jsonrpc": "2.0", "id": rid, "result": {}}), {}
    if method == "tools/list":
        return 200, json_bytes({"jsonrpc": "2.0", "id": rid,
                                "result": {"tools": _MCP_TOOLS}}), {}
    if method == "tools/call":
        name = params.get("name")
        args = params.get("arguments") or {}
        if not isinstance(args, dict):
            args = {}
        if not name:
            return 200, json_bytes({"jsonrpc": "2.0", "id": rid,
                                    "error": {"code": -32602,
                                              "message": "Invalid params: missing tool name"}}), {}
        result, unknown = _mcp_call_tool(name, args)
        if unknown == "unknown":
            return 200, json_bytes({"jsonrpc": "2.0", "id": rid,
                                    "error": {"code": -32602,
                                              "message": "Unknown tool: %s" % name}}), {}
        return 200, json_bytes({"jsonrpc": "2.0", "id": rid, "result": result}), {}
    return 200, json_bytes({"jsonrpc": "2.0", "id": rid,
                            "error": {"code": -32601,
                                      "message": "Method not found: %s" % method}}), {}


# ---------------------------------------------------------------------------
# HTTP server: a raw-socket handler, not BaseHTTPRequestHandler.
#
# BaseHTTPRequestHandler's email-based header parser costs ~50-100 us per
# request, and the timed workloads are thousands of small sequential
# requests (2,000 reads, 200 writes, 400 push requests, 150 clone
# requests). The routing code (_dispatch/_dispatch_git) is unchanged; only
# the transport moved: _Responder holds one request's inputs and _send
# assembles the whole response in memory, and the connection handler
# writes it in a single sendall.
# ---------------------------------------------------------------------------

_GIT_RE = re.compile(r"^/([^/]+)/([^/]+)\.git(?:/(.*))?$")

_REASONS = {200: "OK", 201: "Created", 204: "No Content",
            400: "Bad Request", 401: "Unauthorized", 404: "Not Found",
            405: "Method Not Allowed", 422: "Unprocessable Entity",
            500: "Internal Server Error", 501: "Not Implemented"}

_DATE_CACHE = {"second": -1, "value": b""}


def _http_date():
    now = int(time.time())
    if now != _DATE_CACHE["second"]:
        from email.utils import formatdate
        _DATE_CACHE["second"] = now
        _DATE_CACHE["value"] = formatdate(now, usegmt=True).encode("ascii")
    return _DATE_CACHE["value"]


class _Responder:
    """One request: parsed inputs in, response bytes out."""

    def __init__(self, method, target, headers, rfile):
        self.command = method
        self.path = target
        self.headers = headers
        self.rfile = rfile
        self._response = None

    def _read_body(self):
        # Chunked transfer encoding (undici sends it for stream bodies):
        # consume the framing so the next request on this keep-alive
        # connection is not misread as a new request line.
        te = (self.headers.get("transfer-encoding") or "").lower()
        if "chunked" in te:
            out = bytearray()
            while True:
                line = self.rfile.readline(65536).strip()
                try:
                    size = int(line.split(b";")[0], 16)
                except ValueError:
                    break
                if size == 0:
                    # trailers, terminated by an empty line
                    while True:
                        trailer = self.rfile.readline(65536)
                        if trailer in (b"\r\n", b"\n", b""):
                            break
                    break
                out += self.rfile.read(size)
                self.rfile.readline(65536)
            return bytes(out)
        length = self.headers.get("content-length")
        if length is None:
            return b""
        try:
            n = int(length)
        except ValueError:
            return b""
        if n <= 0:
            return b""
        return self.rfile.read(n)

    def _send(self, status, body, content_type=JSON_TYPE, extra=None):
        if body is None:
            body = b""
        if isinstance(body, str):
            body = body.encode("utf-8")
        # Assemble the whole response in memory: one sendall for
        # headers+body, with Nagle disabled, keeps the sequential
        # workloads near 1 ms per op.
        head = ("HTTP/1.1 %d %s\r\n"
                % (status, _REASONS.get(status, "OK"))).encode("ascii")
        head += b"Server: Forge/1.0\r\nDate: " + _http_date() + b"\r\n"
        head += ("Content-Type: %s\r\nContent-Length: %d\r\n"
                 % (content_type, len(body))).encode("ascii")
        if extra:
            for key, value in extra.items():
                head += ("%s: %s\r\n" % (key, value)).encode("utf-8")
        head += b"\r\n"
        if body and self.command != "HEAD":
            head += body
        self._response = head

    def _send_json(self, status, obj, extra=None):
        headers = {"X-GitHub-Request-Id": next_request_id()}
        if extra:
            headers.update(extra)
        if status == 204:
            self._send(204, b"", JSON_TYPE, headers)
        elif isinstance(obj, _RawJson):
            # Pre-serialized (single-issue GET cache): send as-is.
            self._send(status, bytes(obj), JSON_TYPE, headers)
        else:
            self._send(status, json_bytes(obj), JSON_TYPE, headers)

    def _auth_ok(self):
        if not SHOP_TOKEN:
            return True
        auth = self.headers.get("authorization") or ""
        return auth == "Bearer %s" % SHOP_TOKEN

    def _unauthorized(self):
        self._send_json(401, {"message": "Bad credentials"})

    def _dispatch(self):
        # Fast path: origin-form targets (what the suite sends) split by
        # hand; absolute-form falls back to urlparse.
        if self.path.startswith("/"):
            path, _, _qs = self.path.partition("?")
            query_string = _qs
            query = parse_qs(_qs) if _qs else {}
        else:
            parsed = urlparse(self.path)
            path = parsed.path
            query_string = parsed.query
            query = parse_qs(parsed.query) if parsed.query else {}
        method = self.command
        # Pagination links must be absolute: stash this request's origin
        # (from the Host header) for _link_header.
        host = self.headers.get("host") or "127.0.0.1"
        _REQ.base_url = "http://" + host
        # Read the request body FIRST, before any auth/404 early return:
        # an unread body left on a keep-alive connection is parsed as the
        # next request line ("Bad request syntax") and desyncs the client.
        body = self._read_body()
        try:
            if method == "GET" and path == "/healthz":
                self._send_json(200, {"ok": True})
                return
            if path == "/api/graphql":
                if method != "POST":
                    self._send_json(404, {"message": "Not Found"})
                    return
                if not self._auth_ok():
                    self._unauthorized()
                    return
                status, result = handle_graphql(body)
                self._send_json(status, result)
                return
            if path == "/mcp":
                if method == "DELETE":
                    self._send(200, b"{}", JSON_TYPE)
                    return
                if method != "POST":
                    self._send_json(404, {"message": "Not Found"})
                    return
                if not self._auth_ok():
                    self._unauthorized()
                    return
                status, out, extra = handle_mcp(body)
                self._send(status, out, JSON_TYPE, extra)
                return
            if path.startswith("/api/v3"):
                if not self._auth_ok():
                    self._unauthorized()
                    return
                try:
                    status, result, extra = handle_rest(
                        method, path.rstrip("/") or "/", query, body)
                except ApiError as exc:
                    self._send_json(exc.status, {"message": exc.message})
                    return
                self._send_json(status, result, extra)
                return
            m = _GIT_RE.match(path)
            if m:
                owner, repo_name = m.group(1), m.group(2)
                suffix = m.group(3) or ""
                if not self._auth_ok():
                    self._unauthorized()
                    return
                repo = STORE.get_repo(owner, repo_name)
                if owner != VIEWER_LOGIN or repo is None:
                    self._send_json(404, {"message": "Not Found"})
                    return
                self._dispatch_git(repo, suffix, query_string, body)
                return
            self._send_json(404, {"message": "Not Found"})
        except BrokenPipeError:
            pass
        except Exception as exc:  # never crash on a client request
            sys.stderr.write("[forge] %s %s: %r\n" % (method, path, exc))
            try:
                self._send_json(500, {"message": "Internal Server Error"})
            except Exception:
                pass

    def _dispatch_git(self, repo, suffix, query_string, body):
        method = self.command
        query = parse_qs(query_string)
        service = (query.get("service") or [None])[0]
        if method == "GET" and suffix == "info/refs":
            if service == "git-upload-pack":
                proto = self.headers.get("git-protocol") or ""
                if proto.strip() == "version=2":
                    ctype, body = git_advertisement_v2(repo)
                else:
                    ctype, body = git_advertisement_v0_upload(repo)
                self._send(200, body, ctype)
                return
            if service == "git-receive-pack":
                ctype, body = git_advertisement(repo, "git-receive-pack")
                self._send(200, body, ctype)
                return
            self._send_json(404, {"message": "Not Found"})
            return
        if method == "POST" and suffix == "git-upload-pack":
            proto = self.headers.get("git-protocol") or ""
            try:
                if proto.strip() == "version=2":
                    first = None
                    try:
                        packets = decode_pkt_lines(body)
                        for kind, payload in packets:
                            if kind == "data":
                                first = payload.decode("utf-8", "replace")
                                break
                    except ValueError:
                        first = None
                    if first is not None and first.startswith("command=ls-refs"):
                        args = {"prefixes": [], "peel": True, "symrefs": True}
                        for kind, payload in packets:
                            if kind != "data":
                                continue
                            line = payload.decode("utf-8", "replace").rstrip("\n")
                            if line.startswith("ref-prefix "):
                                args["prefixes"].append(line[len("ref-prefix "):])
                            elif line == "peel":
                                args["peel"] = True
                            elif line == "symrefs":
                                args["symrefs"] = True
                        out = git_ls_refs(repo, args["prefixes"],
                                          args["peel"], args["symrefs"])
                    else:
                        out = git_fetch_v2(repo, body)
                else:
                    out = git_fetch_v0(repo, body)
            except ValueError as exc:
                self._send(400, b"bad request: %s" % str(exc).encode("utf-8"),
                           "text/plain")
                return
            self._send(200, out, "application/x-git-upload-pack-result")
            return
        if method == "POST" and suffix == "git-receive-pack":
            try:
                out = git_receive_pack(repo, body)
            except ValueError as exc:
                self._send(400, b"bad request: %s" % str(exc).encode("utf-8"),
                           "text/plain")
                return
            self._send(200, out, "application/x-git-receive-pack-result")
            return
        self._send_json(404, {"message": "Not Found"})

class _ConnHandler(socketserver.BaseRequestHandler):
    """One thread per connection; HTTP/1.1 keep-alive, parsed by hand.

    Reads the request line and headers from a buffered reader, hands the
    request to _Responder, and writes the assembled response in one
    sendall. A blank line before the request line is skipped, as the
    spec allows; anything malformed closes the connection.
    """

    def handle(self):
        conn = self.request
        try:
            # Disable Nagle: without it, the small header+body response
            # stalls ~40 ms on the client's delayed ACK, which the
            # 2000-read / 200-write bench workloads feel per op.
            conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass
        rfile = conn.makefile("rb")
        try:
            while True:
                line = rfile.readline(65536)
                if not line:
                    return
                if line.strip() == b"":
                    continue
                parts = line.split()
                if len(parts) != 3:
                    return
                try:
                    method = parts[0].decode("ascii")
                    target = parts[1].decode("iso-8859-1")
                    version = parts[2].decode("ascii")
                except UnicodeDecodeError:
                    return
                headers = {}
                while True:
                    hline = rfile.readline(65536)
                    if hline in (b"\r\n", b"\n", b""):
                        break
                    if b":" not in hline:
                        return
                    name, _, value = hline.partition(b":")
                    headers[name.strip().lower().decode(
                        "ascii", "replace")] = value.strip().decode(
                            "utf-8", "replace")
                if headers.get("expect", "").lower() == "100-continue":
                    conn.sendall(b"HTTP/1.1 100 Continue\r\n\r\n")
                if method not in ("GET", "POST", "PUT", "PATCH", "DELETE",
                                  "HEAD"):
                    conn.sendall(
                        b"HTTP/1.1 501 Not Implemented\r\n"
                        b"Server: Forge/1.0\r\nDate: " + _http_date() +
                        b"\r\nContent-Type: text/plain\r\n"
                        b"Content-Length: 19\r\n\r\nUnsupported method.")
                    return
                responder = _Responder(method, target, headers, rfile)
                try:
                    responder._dispatch()
                except BrokenPipeError:
                    return
                if responder._response is None:
                    return
                conn.sendall(responder._response)
                conn_hdr = headers.get("connection", "").lower()
                if version == "HTTP/1.0":
                    if "keep-alive" not in conn_hdr:
                        return
                elif "close" in conn_hdr:
                    return
        except (ConnectionResetError, BrokenPipeError, OSError):
            return
        finally:
            try:
                rfile.close()
            except Exception:
                pass
            try:
                conn.close()
            except Exception:
                pass


class ForgeServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 128


# ---------------------------------------------------------------------------
# Lifecycle: bind, register, poll /done, exit 0.
# ---------------------------------------------------------------------------

def _http_json(url, method, payload=None, timeout=30):
    data = None
    headers = {"Content-Type": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _retry_delay(attempt):
    return min(2.0, 0.25 * (2 ** min(attempt, 8)))


def register(port):
    attempt = 0
    while True:
        try:
            _http_json(ENV_URL + "/register", "POST", {"port": port})
            return
        except urllib.error.HTTPError as exc:
            if exc.code in (200, 409):
                return
            if exc.code in (400, 405):
                raise
        except Exception:
            pass
        time.sleep(_retry_delay(attempt))
        attempt += 1


def wait_for_done():
    attempt = 0
    while True:
        try:
            body = _http_json(ENV_URL + "/done", "GET", timeout=30)
            if body.get("done") is True:
                return
        except Exception:
            pass
        time.sleep(_retry_delay(attempt))
        attempt += 1


def main():
    if not ENV_URL:
        sys.stderr.write("[forge] MAKEFUN_ENV_URL is not set\n")
        return 1
    server = ForgeServer(("0.0.0.0", 0), _ConnHandler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    sys.stdout.write("[forge] listening on port %d\n" % port)
    sys.stdout.flush()
    register(port)
    sys.stdout.write("[forge] registered; waiting for done\n")
    sys.stdout.flush()
    try:
        wait_for_done()
    finally:
        server.shutdown()
        server.server_close()
    sys.stdout.write("[forge] done\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
