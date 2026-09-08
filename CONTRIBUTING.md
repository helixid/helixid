# Contributing to HelixID

Thanks for your interest in contributing. HelixID is building the trust layer for AI agents — verifiable identity, scoped authority, and cryptographic delegation that replaces static API keys. We take contributions seriously because the code here will end up in production systems making trust decisions on behalf of autonomous software.

This document covers how we work, what we expect, and where you can plug in.

---

> **New to HelixID?** Read
> [docs.helixid.dev](https://docs.helixid.dev) first — it covers the concepts
> (DIDs, verifiable credentials, the two-issuer model, delegation, revocation)
> that the rest of this document assumes. This file is the authoritative
> process for *this* repository; the docs site is the orientation.

## Open-Source Scope

Everything in this repository is Apache 2.0 licensed and self-hostable.

If you're unsure where a feature belongs, open a Discussion before writing code. Rule of thumb: protocol primitives, SDK surface, standards conformance, and framework middleware belong in this repo.

---

## Ways to Contribute

In rough order of current priority:

1. **DID method implementations** — additional resolvers (`did:web`, `did:jwk`, `did:peer`, other ledger-anchored methods). Must conform to W3C DID 1.0 and pass the DID resolution test suite.
2. **Framework middleware** — integrations for new agent frameworks. Follow the pattern in `packages/langchain/` and `packages/mcp/`.
3. **Interop testing** — W3C VC 2.0 interop vectors, cross-library issuance/verification (e.g., Veramo, Sphereon, Spruce), DIF test suites.
4. **Documentation** — architecture deep-dives, tutorials, and runnable examples. Prefer working code over prose.
5. **Security hardening** — fuzzing, formal verification of critical paths, threat models for new features.

If you want to work on something not on this list, open a GitHub Discussion before writing code. We would rather align on scope early than ask you to redo work in review.

---

## Before You Start

**Open a Discussion or Issue first** for any non-trivial change. Trivial means: typos, obviously incorrect code, a missing test for existing behavior, a small doc improvement. Anything else — new features, new dependencies, API changes, performance optimizations that change behavior, new packages — needs a design sketch and sign-off from a maintainer before a PR lands.

This saves time on both sides. A rejected PR after two weeks of work is a worse outcome than a fifteen-minute design conversation.

---

## Development Setup

### Prerequisites

- Node.js `^20.19.0 || >=22.12.0` — note 20.0–20.18 will **not** work
- pnpm ≥ 9 (`corepack enable` — the repo pins `pnpm@9.15.2` via `packageManager`)
- Git
- Docker (for the E2E demos and live tests)

### Clone and Bootstrap

```bash
git clone https://github.com/helixid/helixid.git
cd helixid
pnpm install
pnpm build
```

### Run Tests

```bash
pnpm test:non-live     # the default suite — everything that needs no live infrastructure
pnpm test:all          # the whole suite, live tests included
pnpm test:live         # only the live tests (needs a configured .env)
pnpm test:e2e          # the end-to-end package
pnpm lint              # eslint
pnpm typecheck         # prisma generate + tsc --noEmit
```

`pnpm test:non-live` is the one to run before opening a PR. CI runs the
workspace variants (`pnpm workspace:test:non-live`, `pnpm workspace:typecheck`),
which also cover `examples/` and `e2e/`.

### Run E2E demo

```bash
cd examples/e2e-travel-concierge
docker compose up --build
```

### Environment Variables

For local development, copy `.env.example` to `.env` and adjust the values you need.

Never commit `.env` or any file containing private keys. `.gitignore` matches
`.env*` with a `!.env.example` negation, so variants like `.env-new` and
`.env.local` are covered too — but review your diff before committing rather
than relying on it.

---

## Repository Structure

This repository is the **HelixID API** (`@helixid/api`) — the issuer and
verifier service. It is a pnpm workspace, but a small one: the package at the
root plus `examples/` and `e2e/`.

```
helixid/
├── src/              # Fastify server entrypoint
├── prisma/           # schema and migrations
├── tests/            # unit + live suites (tests/live is the live-only set)
├── e2e/              # end-to-end package
├── examples/         # runnable demos (see examples/README.md)
├── scripts/          # setup and maintenance scripts
└── docs/             # design decisions and proposals
```

The rest of the system lives in **separate repositories** under the same org —
they are not directories here:

| Repository | What it is |
|---|---|
| [`helix-core`](https://github.com/helixid/helix-core) | `@helixid/core` — crypto, schemas, resolver, verification primitives |
| [`helix-sdk-js`](https://github.com/helixid/helix-sdk-js) | JS/TS SDK workspace — SDK, CLI, LangChain and MCP middleware, consent widget |
| [`helix-sdk-py`](https://github.com/helixid/helix-sdk-py) | `helixid-sdk-py` — the Python SDK |
| [`helix-console`](https://github.com/helixid/helix-console) | the operator Console SPA |
| [`helix-wiki`](https://github.com/helixid/helix-wiki) | the documentation site at [docs.helixid.dev](https://docs.helixid.dev) |

Changes in `helix-core` and `helix-sdk-js` are the highest-stakes — they ripple
through every integration. Expect stricter review and a higher test bar there.

---

## Branching and Commits

### Branch Names

```
<type>/<short-kebab-description>

feat/did-web-resolver
fix/statuslist-cache-invalidation
docs/delegation-tutorial
```

### Conventional Commits (required)

We use [Conventional Commits](https://www.conventionalcommits.org/). The release tooling parses commit messages to generate changelogs and bump versions.

```
<type>(<scope>): <summary>

[optional body]

[optional footer(s)]
```

Allowed types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `revert`.

Scope is the package or area: `core`, `api`, `sdk-js`, `mcp`, `langchain`, `cli`, `docs`.

Examples:

```
feat(sdk): add did:web resolver with HTTPS pinning

fix(api): invalidate status-list cache after credential revocation

perf(sdk): avoid re-parsing JWS on repeated verification

BREAKING CHANGE: verifyPresentation now returns DelegationChain,
not string[]. Migration: use result.delegationChain.dids.
```

**Breaking changes** must include a `BREAKING CHANGE:` footer and a migration note in the PR description.

### Sign Your Commits (DCO)

Every commit must be signed off under the [Developer Certificate of Origin](https://developercertificate.org/). We deliberately use DCO instead of a CLA — it's a lightweight attestation with no corporate-legal review tax. By signing off, you affirm that you have the right to submit the work under Apache 2.0.

```bash
git commit -s -m "feat(sdk): add did:web resolver"
```

This appends a `Signed-off-by: Your Name <your.email@example.com>` line. Our CI rejects PRs missing DCO on any commit. If you forget, rebase with `git rebase --signoff`.

---

## Pull Requests

### Before Opening a PR

- [ ] Rebase on the latest `main`
- [ ] Run `pnpm lint && pnpm test && pnpm build` locally and pass
- [ ] Add or update tests — no untested code merges
- [ ] Update docs if you changed public API
- [ ] Add a changeset (`pnpm changeset`) if your change is user-visible
- [ ] Every commit is DCO-signed

### PR Description

Use this template — it mirrors what reviewers and release notes need:

```markdown
## What
<short summary of the change>

## Why
<motivation, linked issue, relevant context>

## How
<implementation approach, trade-offs considered, alternatives rejected>

## Testing
<how you verified this works — unit, integration, manual scenarios>

## Risk & Rollback
<what could break, how to revert if this ships bad>

## Breaking Changes
<none | description + migration path>

Closes #<issue>
```

### Review Expectations

- Two maintainer approvals required for changes in `helix-core` or `helix-sdk-js`
- One maintainer approval for everything else
- Reviewers respond within 3 business days — if silent longer, ping in Discussions
- We squash-merge by default; commit history on `main` is one commit per PR

### Merging

Only maintainers merge. Do not merge your own PR even if you have permissions.

---

## Coding Standards

### TypeScript

- Strict mode on. No `any` without a justified comment.
- Public API surface is explicitly typed and exported from the package root.
- Prefer `unknown` + type narrowing over `any`.
- Async code uses `async/await`. Do not mix with `.then()` chains.
- No default exports from library code. Named exports only.

### Tooling

- ESLint + Prettier are enforced in CI. Run `pnpm lint:fix` before pushing.
- Do not disable lint rules inline without a comment explaining why.
- Keep dependencies minimal. Adding a new runtime dependency requires maintainer approval in the PR — size, audit status, and maintenance activity all matter.

### Cryptography and Security-Sensitive Code

- Never roll your own crypto. Use `@noble/curves`, `@noble/hashes`, or WebCrypto.
- Constant-time comparisons for anything touching keys, signatures, or credentials.
- No secrets in logs, errors, or stack traces. The linter enforces this for known-sensitive field names; it is not exhaustive — use judgment.
- Changes to verification logic (`packages/sdk/src/verify/`) require a second maintainer review and a threat-model note in the PR.

### Testing

- Unit tests: Vitest. Colocate as `*.test.ts` next to the source file.
- Integration tests: `tests/integration/` at the package root, with docker-compose fixtures.
- Interop tests: `tests/interop/` — use the official W3C VC and DID test vectors.
- Benchmarks: `benchmarks/` — use `mitata`. Include a baseline comparison in the PR when changing performance-sensitive paths.
- Target ≥ 85% line coverage for new code in `packages/sdk`. Lower is acceptable with justification for other packages.

### Documentation

- Every public API gets a TSDoc comment with at least one example.
- Architecture-level changes update `docs/architecture.md` in the same PR.
- New framework integrations include a runnable example in `examples/`.

---

## Security Disclosure

**Do not open public issues for security vulnerabilities.** Use one of:

- Email `hello@dgverse.in`
- [GitHub Security Advisory](https://github.com/helixid/helixid/security/advisories/new) (private)

We acknowledge within 48 hours, triage within 7 business days, and practice coordinated disclosure with a default 90-day embargo. Full scope, safe-harbor terms, and response policy: [`SECURITY.md`](SECURITY.md).

---

## Release Process

Maintainers only, documented here for transparency:

- Changesets accumulate on `main` via PRs
- Weekly release cadence, or out-of-band for security fixes
- `pnpm changeset version` bumps versions and writes changelogs
- Tag + push triggers publish to npm under `@helixid/*`
- GitHub release notes auto-generated from changesets
- Semver: breaking changes bump major, new features minor, fixes patch. Pre-1.0 we follow semver with the understanding that minor bumps may include breaking changes — we will call them out clearly.

---

## Community and Code of Conduct

- **Discussions:** [github.com/helixid/helixid/discussions](https://github.com/helixid/helixid/discussions) — design questions, use cases, show-and-tell
- **Issues:** [github.com/helixid/helixid/issues](https://github.com/helixid/helixid/issues) — bugs and concrete feature requests
- **Security:** `hello@dgverse.in`
- **General contact:** `hello@dgverse.in`

We follow the [Contributor Covenant v2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). Short version: be respectful, assume good faith, keep technical debate on technical merits, and escalate conduct concerns to `hello@dgverse.in`.

---

## Licensing of Contributions

Contributions are licensed under [Apache License 2.0](LICENSE), same as the project. DCO sign-off on each commit is the full legal attestation — no CLA, no separate agreement, no surprise relicensing. See the DCO section above.

---

## Quick Reference

| Task | Command |
|---|---|
| Install deps | `pnpm install` |
| Build all packages | `pnpm build` |
| Run unit tests | `pnpm test` |
| Run integration tests | `pnpm test:integration` |
| Run lint | `pnpm lint` |
| Auto-fix lint | `pnpm lint:fix` |
| Add a changeset | `pnpm changeset` |
| Run a benchmark | `pnpm bench` |
| Sign a commit | `git commit -s -m "..."` |

---

Thanks for contributing. The infrastructure we are building will outlast any individual product decision — that is the bar we are holding ourselves to, and we appreciate you holding us to it too.
