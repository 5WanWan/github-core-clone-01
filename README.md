# github-core-clone-01 — a standalone GitHub-compatible git forge

One process, Python 3.13 standard library only, no dependencies, no git
binary, no network beyond the trial suite. It serves, from its own
in-memory store:

- **git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2
  (plus a v0 fallback) and receive-pack v0, with a from-scratch object
  store and packfile reader/writer (pkt-line framing, deltas, shallow
  clones, fast-forward-only pushes with per-ref report-status).
- **REST v3** at `/api/v3` — repositories, contents, labels, issues,
  pull requests and merges.
- **GraphQL v4** at `/api/graphql` — the documents `gh` and
  `github-mcp-server` send, including introspection, Relay-style global
  ids, cursor pagination and batched operations.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP, revision
  `2026-07-28` (via `server/discover`) with a legacy `initialize`
  handshake fallback, and tools that act on the same store as REST.

## Run

```sh
python3 main.py
```

The process binds an ephemeral port, registers it with the suite at
`$MAKEFUN_ENV_URL/register`, serves until `GET $MAKEFUN_ENV_URL/done`
answers `{"done": true}`, then exits 0. `MAKEFUN_SHOP_TOKEN` is the
bearer token every API call must carry; `/healthz` takes none.

## Layout

- `main.py` — the whole forge: lifecycle, HTTP server, git protocol,
  REST, GraphQL and MCP. Written from the kit's sealed suite sources
  (`program/env/src/`) and the competition rules.
- `LICENSE` — MIT.
- `.makefun/owner.json` — claim file naming the entrant's wallet.

## Determinism

No wall clock and no unseeded randomness in any request path: commit
timestamps come from `MAKEFUN_TRIAL_NOW` (falling back to the scenario
epoch), ids and ordering derive from the trial seed
(`MAKEFUN_TRIAL_SEED`). Two runs on the same instance leave the same
state.

## Notes on the viewer

The bearer token names the scenario viewer (`adaiversen`, id 1000 in
the kit's seeded scenario, `wire.ts` `SCENARIO_SEED`). The forge
recomputes that login from the same public seed at startup, so
repository ownership, `viewer.login` and owner-scoped 404s match what
the suite expects. No token is ever decoded or stored.
