# Decision: CLI and MCP scope across `helix-sdk-js` / `helix-sdk-py`

Status: **Decided.**

## Question

Should the CLI tool and the MCP integration be duplicated per SDK language
(JS and Python), the way `helix_langchain`/`helix_crewai` are?

## Decision

Split the two "MCP" concerns apart — they aren't the same kind of artifact —
and land on different answers for each:

**CLI (`helix-sdk-js`'s `cli` package, Python's `helix_cli`) — one canonical
implementation, JS only.**
The CLI is a standalone consumer tool (same category as `gh`, the Stripe
CLI, the AWS CLI) — nobody imports it as a library, so a JS-vs-Python split
is a false split, not a real capability boundary. `helix_cli` is removed
from `helix-sdk-py`.

**MCP middleware (`@helixid/mcp-middleware`, Python's
`helix_mcp_middleware`) — stays duplicated per language, same bucket as
`helix_langchain`/`helix_crewai`.**
This is not a standalone tool — it's a peer-dependency library that other
people's MCP servers/clients import to verify inbound VPs
(`helixid_mcp_middleware`) and attach outbound ones (`attach_helix_vp`).
MCP-in-JS and MCP-in-Python are genuinely different runtime SDKs
(`@modelcontextprotocol/sdk` vs `mcp`), so JS and Python versions are real,
not duplicated, work — exactly the same reasoning that already applied to
`helix_langchain`/`helix_crewai`.

**Renamed** from `@helixid/mcp` / `helix_mcp` to `@helixid/mcp-middleware`
/ `helix_mcp_middleware` (package directory, package name, pip extra
`mcp-middleware`, and all internal references) as part of this decision —
the bare `mcp` name was what caused the original ambiguity with "a
standalone Helix MCP server," and the rename makes the distinction
unambiguous without relying on a doc to explain it.

**Standalone Helix MCP server** (Helix's own operations — `did create`,
`issuer init`, `status-list create`, `vc issue`/`vc self-issue` (**Superseded:**
`vc self-issue` was later removed by the agent self-custody retirement,
CHANGELOG `0.2.0`), `revoke`,
`wallet inspect` — exposed as MCP tools so an agent can drive Helix
conversationally, the MCP analogue of what the CLI does for a human) — one
canonical implementation, JS only, built as `@helixid/mcp-server` alongside
`cli` and `mcp-middleware`. Same reasoning as the CLI: it's a standalone
tool (an MCP client connects to it and calls tools; nobody imports it as a
library), so a JS-vs-Python split would be a false split. Built on
`helix-sdk-js` because that's the SDK that stabilizes first, per the
existing CLI/MCP tooling decision.

## Reasoning

- **CLI and the future Helix-MCP-server are consumer tools; MCP middleware
  is infrastructure.** The test that matters is "does anyone import this as
  a library." CLI and a hypothetical Helix MCP server both fail that test
  (people run them, not import them) — duplicating them per language adds
  a second maintenance surface with zero capability gained.
  `helix_mcp_middleware` passes that test (it's `pip install`/
  `npm install`-ed into someone else's
  server code) — same as the LangChain/CrewAI adapters, where a real
  capability gap (`handleToolStart`) was already found between the JS and
  Python versions, confirming they're genuinely separate implementations,
  not copies.
- **Don't conflate "exposes Helix's own ops as tools" with "lets other
  tools verify Helix identity."** These are different products: the first
  makes Helix usable *by* an agent; the second makes Helix's identity model
  usable *by anyone else's* MCP server, regardless of what that server does.
  The middleware is closer to Helix's core value proposition (decentralized
  agent identity/authorization) than the hypothetical server is — it's not
  a shortcut version of the server, and shouldn't be justified as one.

## Applied

**`helix-sdk-py`:**
- Removed `src/helix_cli/`, `tests/test_cli.py`, the `[project.scripts]`
  `helix` entry, and the `cli` extra (and `click`) from `pyproject.toml`.
  CLI section of `README.md` now points to `helix-sdk-js`'s `cli` package
  instead of documenting a Python one.
- Renamed `src/helix_mcp/` → `src/helix_mcp_middleware/`, the `mcp` extra →
  `mcp-middleware`, and updated all internal imports
  (`tests/test_langchain_crewai.py`, `src/helix_sdk/tool_vp.py`) and
  `README.md` accordingly. No functional change.

**`helix-sdk-js`:**
- Renamed `mcp/` → `mcp-middleware/`, package name `@helixid/mcp` →
  `@helixid/mcp-middleware` (`package.json` `name` and `repository.directory`,
  `pnpm-workspace.yaml`, root `package.json`'s `test:unit` filter, and the
  `@helixid/mcp` mention in `helix-sdk-js/src/errors/index.ts`). No change
  to the `cli` package's own behavior — it was already the sole
  implementation.
- **Refactored `cli`'s internals to throw instead of `process.exit`**
  (`lib/output.ts#error()`, `lib/env.ts`'s `requirePassphrase()`/
  `requireHederaOperator()`, `lib/wallet.ts#loadWallet()`), with
  `bin/helix.ts` catching and exiting at the single true entry point so CLI
  behavior is unchanged (now with red-colored error output there too, closing
  a small pre-existing inconsistency). This was required, not optional: the
  new `mcp-server` package reuses this same internal logic, and an
  uncaught `process.exit(1)` deep in a reused function would kill the whole
  MCP server on a single bad tool call instead of failing just that call.
  Also fixed one latent control-flow bug this surfaced in
  `commands/did.ts` (a wallet-already-exists check whose `error()` call sat
  inside the same `try` its `catch` swallowed — harmless while `error()`
  exited the process, but would have silently no-op'd once it threw
  instead), and removed a large set of stale, git-tracked, pre-`process.exit`-refactor
  compiled `.js`/`.d.ts` files that had been committed directly under
  `cli/src/` and `cli/tests/` (contradicting the package's own
  `outDir: "./dist"`) — they were shadowing the `.ts` sources during test
  runs and had to go for the refactor to even be verifiable. All 14 existing
  CLI tests updated where they asserted the old exit-based behavior and
  re-verified green; `cli/tests/hedera-missing.test.ts`'s title/setup
  updated to match.
- **Added `@helixid/mcp-server`**, a new workspace package (`mcp-server/`)
  implementing the standalone MCP server above: 7 tools
  (`did_create`, `issuer_init`, `status_list_create`, `vc_issue`,
  `vc_self_issue`, `revoke`, `wallet_inspect`) (**Superseded:** `vc_self_issue`
  was later removed by the agent self-custody retirement, CHANGELOG `0.2.0`,
  leaving 6 tools) via the high-level
  `McpServer`/`registerTool` API from `@modelcontextprotocol/sdk`, served
  over stdio (`bin/server.ts`, exposed as the `helix-mcp-server` CLI). Each
  tool wraps `@helixid/cli`'s non-printing internals
  (`@helixid/cli/lib/*`, `@helixid/cli/core/*`, exposed via new subpath
  `exports` entries added to `cli/package.json`) rather than its
  `commands/*.ts` layer, because that layer's `console.log`-based human
  output would corrupt the MCP stdio JSON-RPC stream. The thin
  per-command orchestration (e.g. "did:web also creates a status list
  unless opted out") is intentionally reimplemented rather than shared,
  since it lives inline in `cli`'s command functions alongside the
  print statements — only the actual crypto/wallet logic underneath is
  reused, not duplicated. Covered by `tests/operations.test.ts` (the
  operations layer directly) and `tests/server.test.ts` (a real MCP
  client/server round-trip over `InMemoryTransport`, including asserting
  that a failing tool call comes back as `isError: true` rather than
  killing the server — the exact failure mode the `process.exit` refactor
  above exists to prevent). Wired into `pnpm-workspace.yaml` and the root
  `test:unit` script.

## What this means for sequencing

`next-steps-sequencing.md` did not have standalone Helix MCP server work
scheduled; it was built directly per this decision rather than being queued.
No further sequencing entry is needed — `@helixid/mcp-server` exists now.

**Approved by:** [founder]
