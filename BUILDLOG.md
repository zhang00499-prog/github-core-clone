# BUILDLOG — github-core-clone-01

A single-process, dependency-free GitHub-compatible forge in TypeScript (Node ≥22.18,
type-stripping only — no enums, namespaces or parameter properties anywhere). `main.ts` is the
kit starter, unchanged; everything else was written for this contest:

| file | role |
| --- | --- |
| `app.ts` | HTTP assembly: auth (bearer, bound to `MAKEFUN_SHOP_TOKEN` when set), JSON body parsing (400 on malformed), `X-GitHub-Request-Id` on every reply, routing |
| `store.ts` | In-memory model: repos, refs, issues/PRs sharing one number sequence, labels, comments; deterministic logical clock; tree flatten/rebuild, ancestry, merge-base, three-way tree merge, LCS line diffs |
| `gitcore.ts` | Git object ids, tree/commit/tag codecs, pack write/read (incl. ofs/ref-delta apply), pkt-line framing, sideband wrap (≤65520 total line length) |
| `githttp.ts` | Smart HTTP: v0+v2 `info/refs`, v2 `ls-refs`, fetch (full, incremental, shallow, deepen — depth-mode pruning treats have/shallow as "commit + its tree", never ancestry), receive-pack with per-ref report-status |
| `rest.ts` | REST v3: repos CRUD + Link-header pagination, contents API backed by real commits (409 on stale sha), git refs/branches/commits, labels, issues, comments, pulls (files diff, squash/merge with 405 on conflict) |
| `graphql.ts` | A small GraphQL engine (tokenizer/parser/executor: variables, fragments, inline fragments, directives, batching) with the gh-probed schema, introspection field/enum lists, opaque stable global ids, cursor pagination |
| `mcp.ts` | MCP over JSON-RPC: `server/discover` (2026-07-28) and legacy `initialize`, six canonical tools sharing the REST store, byte-stable `tools/list`, -32602/-32700 semantics |

The scenario viewer (`adaiversen`, id 1000) is the contest's fixed seeded data
(`SCENARIO_SEED` in the kit's `wire.ts`: "Never change it: it is the contest's fixed data"),
so the forge answers as that viewer, and repositories under any other owner read as 404.

## Local conformance runs (kit `sdk/run.ts`, the sealed suite)

| round | result | notes |
| --- | --- | --- |
| 1 | 85/120 — git 1/30, repos 14/15, issues 15/15, pulls 20/20, protocol 5/5, graphql 15/20, mcp 15/15 | receive-pack decoded the pack bytes as pkt-lines; commit messages gained a trailing newline |
| 2 | 118/120 — git 28/30 | remaining: deepen pruning cut the parent commit; sideband pkt-lines were 4 bytes over the 65520 maximum |
| 3 | **120/120** | feature 600 + agent 200 |
| 4 | **120/120, perf 120/200** | push p50 1120 ms → 32 pts, clone 211 ms → 29, read 1968 ms → 31, write 300 ms → 28 (local shared VM; trial pods differ) |

Run it the same way:

```sh
node --experimental-strip-types /tmp/forge-harness.ts   # createApp() on 127.0.0.1:8791
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:8791 --token testtoken --perf
```

## Notes for the submission step

- `main.ts` is byte-identical to the starter (its header says to keep it as it is); all authored
  code lives in the seven files above (~3,600 lines).
- The trial is offline, read-only `/bot`, 1024 MB: the forge is pure in-memory, writes nothing,
  and makes no network calls of its own.
- Perf headroom, if wanted later: the read workload is dominated by JSON response size
  (full user objects nested in every issue); trimming shapes risks conformance, so it was left.
