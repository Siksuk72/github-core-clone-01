# Siksuk72/github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Siksuk72/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Siksuk72/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

# AFTERGLOW Forge — a GitHub-compatible git forge in one process

A standalone git forge that speaks the GitHub-compatible surface from a single
Node 22 process with **zero dependencies** (stdlib only, no git binary):

- **Git smart HTTP** — `info/refs` advertisement, `git-upload-pack` (protocol v2
  with ls-refs/fetch incl. unborn repos, symrefs, ref-prefix negotiation, ACK +
  ready, shallow clone) and `git-receive-pack` (report-status, sideband,
  thin/ofs-delta/ref-delta packfiles, non-fast-forward refusal, ref delete).
- **REST v3** — repos, contents (create/get/update/delete with stale-sha 409),
  labels, issues (validation 422, pagination), pulls (create/list/merge with
  conflict 405), `X-GitHub-Request-Id` on every reply, Bearer auth.
- **GraphQL v4** — mini parser + evaluator, introspection, typed field args,
  multi-operation batches.
- **MCP** — JSON-RPC 2.0 streamable transport, 6 tools mapped from the REST
  surface, byte-stable `tools/list`, proper `-32602/-32700/401` errors.

## Run

```
node main.ts
```

Binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL/register`
(`{"port": N}`), then long-polls `$MAKEFUN_ENV_URL/done` and exits 0 when the
scoring suite answers `done: true`. Auth: `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.

## Layout

```
main.ts          boot, routing (REST / GraphQL / MCP / git smart HTTP), wire contract
src/store.ts     in-memory repos/objects/refs/issues/pulls, caches, JSON shapes
src/pack.ts      packfile parse (ofs/ref deltas) + deterministic write, reachability
src/gitproto.ts  pkt-line codec, v0+v2 advertisement, ls-refs, upload/receive-pack
src/rest.ts      REST v3 surface
src/graphql.ts   GraphQL evaluator
src/mcp.ts       MCP JSON-RPC server
test-forge.mjs   45-check conformance suite (REST + GraphQL + MCP + real git client)
run-tests.mjs    one-shot harness: spawn forge, run the suite, kill
```

## Test

```
node run-tests.mjs
```

45/45 checks pass, including real `git clone` (empty + full + `--depth 1`),
`git push` (new branch, non-fast-forward refusal, ref deletion), and fetch
negotiation with ACK/ready — all against the real Git for Windows client.

Design notes: object ids are content SHA-1 (deterministic, so two runs export
byte-identical state); issue/pull numbers are sequential; pack + pre-serialized
issue-JSON caches keep the 2000-read / 200-write / push-heavy workloads fast;
no clock, no randomness anywhere in scored state.

## Run it

```
node main.ts
```

<sub>Entered on [make.fun](https://make.fun/?ref=hz26ha21&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
