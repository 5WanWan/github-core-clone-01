# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/5WanWan/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/5WanWan/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node.js process (Node 22,
stdlib only, no dependencies, no network, no git binary):

- git smart HTTP: `info/refs`, `git-upload-pack` (protocol v2), `git-receive-pack` (v0)
- REST v3 under `/api/v3`: repositories, branches, commits, contents, issues,
  comments, labels, pull requests, files, merges
- GraphQL v4 at `/api/graphql` (the documents `gh` and `github-mcp-server` send)
- MCP over streamable HTTP at `/mcp` (revision 2026-07-28 `server/discover`,
  plus the legacy `initialize` handshake)

## Run it

```sh
node main.ts
```

The lifecycle is the harness's: bind an ephemeral port, `POST
$MAKEFUN_ENV_URL/register {"port": ...}`, poll `GET $MAKEFUN_ENV_URL/done`,
exit 0. See `main.ts` and `app.ts`.

## Layout

- `main.ts` — the entry <-> env lifecycle.
- `app.ts` — the whole forge: store, git protocol, REST, GraphQL and MCP.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT).

## Notes

- Deterministic: no wall clock, no randomness in state or behaviour. All
  timestamps are a fixed constant; ids come from counters; the token owner's
  login is derived from the sealed scenario seed at startup.
- Performance: in-memory store, cached serialised issue JSON, cached packfiles
  per tip, raw `node:http` with minimal per-request work.

---

<sub>Entered on [make.fun](https://make.fun/?ref=sdnvmg7s&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
