# Proposal: retire `@helixid/core` as a published package — fold into `helix-api`, duplicate primitives into `helix-sdk-js`

Status: **Proposal.** Extends `proposal-sdk-api-only.md`; supersedes the
"`helix-core` → own repo, published to npm, `helix-server` consumes as
versioned dependency" line from the Item #3 monorepo-split decision.

## Why revisit this now

`proposal-sdk-api-only.md` established that `helix-sdk-js` stops importing
`verifyVP()` and delegation-building from `@helixid/core` and calls the API
instead. That leaves `@helixid/core` with exactly two consumers for
everything else: `helix-api` and `helix-sdk-js` — both TypeScript, both in
reach of the same source. Publishing a separately versioned npm package for
code with two in-house consumers, one of which (Python) can't even import
it, is overhead without payoff. Simpler: pick one canonical source location
per file, and copy verbatim where a second copy is genuinely needed.

## Decided: where each file goes

**Folds entirely into `helix-api`** (only consumer left — no dependents in
any SDK, current or future):

- `vp-verifier.ts` — verification logic, already exposed at
  `POST /v1/vp/verify`.
- `did-resolver.ts`, `did-hedera-loader.ts` — DID resolution against the
  ledger.
- `delegation.ts` — becomes the implementation behind the new
  `POST /v1/vcs/delegation/prepare` endpoint (per `proposal-sdk-api-only.md`).
- `grant.ts`
- `status-list/*` — status list creation/bit-setting is issuer-side, i.e.
  API-side, already.

**Duplicated as whole files into `helix-sdk-js`** — copied verbatim, not
adapted or re-split. Canonical/edited copy lives in `helix-api`'s source
tree; changes get hand-copied into `helix-sdk-js`, checked by the golden
vector CI from `proposal-sdk-api-only.md` so a missed copy fails loudly
instead of silently:

- `crypto/keys.ts` — `generateKeyPair`, `derivePublicKey`,
  `publicKeyToMultibase`, `signData`/`signBytes`.
- `crypto/vp.ts` — `hashCanonicalPayload` and the canonical-JSON logic.
- `proof.ts` — `createEd25519Proof`.
- `vp-builder.ts` — `VPBuilder`, per the accepted local-signing exception.
- `self-signed.ts` — `selfIssueVC`. This has to stay local regardless: the
  Local Dev Credential Flow (#8) self-issues a VC with no server involved
  at all, by design. Not a candidate for folding into the API.
  **Superseded:** the agent self-custody retirement (CHANGELOG `0.2.0`,
  "Agent self-custody retired across the SDK/CLI/MCP/LangChain surface")
  later reversed this — `selfIssueVC` was removed from `helix-sdk-js`
  entirely rather than kept local. No zero-setup local self-issuance path
  currently exists.
- `errors/index.ts`'s error classes (`HelixError`, `ErrorCode`, and the
  specific typed errors) — so the SDK can throw typed errors matching the
  API's error codes.
- The type-only shapes currently imported from core (`SignedVC`,
  `SignedVP`, `DIDDocument`, `KeyPair`, `ServiceEndpoint`, `DelegationLink`,
  `DelegationGrantVC`, `HelixJWTPayload`, `StatusListCredential`,
  `SelfIssueOptions`, `VerifyVPOptions`/`VerifyVPResult`). These are
  compile-time only — a drifted type causes a build error at the usage
  site, not a silent runtime bug, so this duplication is lower-risk than
  the crypto files above and doesn't need golden-vector coverage.
- `AuditEvents` constants (currently imported in `HelixClient.ts`).

**Removed from `helix-sdk-js` entirely** (already decided in
`proposal-sdk-api-only.md`, restated here for completeness):

- `verifyVP` — becomes a call to `POST /v1/vp/verify`.
- `buildDelegationVC` — becomes a call to
  `POST /v1/vcs/delegation/prepare`, then local signing.

## Decided: `getBit` / `checkVCStatus()`

`HelixClient.checkVCStatus()` moves to a single API call — e.g.
`GET /v1/vcs/:vcId/status` — returning the resolved status directly, rather
than the SDK fetching the raw status list credential and checking a bit
locally with `getBit`. No duplication needed for this piece.

Reasoning: `verifyVP()` already became a full API call under this
proposal, meaning the client already trusts the API's verdict on a bigger
question than a single VC's status bit — this is the same trust posture,
not a new concession. `checkVCStatus()` is a one-off inspection call
(Flow #3, revocation checking), not a hot path like `VPBuilder.sign()`, so
the extra round-trip has no meaningful cost.

Trade-off accepted: this loses the batch-efficiency case — fetching one
status list once and checking many bits locally against it is cheaper than
one API round-trip per VC when scanning a large population (e.g. an audit
job). Not a known requirement today; revisit if that use case shows up.

## What happens to `@helixid/core` as a package

It stops being published. The files in the "folds into `helix-api`" list
move into `helix-api`'s own source tree. The files in the "duplicated"
list live canonically inside `helix-api` too (so there's one obvious place
to edit first), with `helix-sdk-js` holding its own verbatim copy.

This reverses the Item #3 decision to publish `helix-core` to npm as
`@helixid/core` and have `helix-server` consume it as a versioned
dependency. That decision was made when `@helixid/core` had a real second
consumer (`helix-sdk-js`, at the time importing it directly for
everything). With that dependency gone, the independent-versioning
rationale no longer applies to what's left.

## Accepted trade-off

Whole-file copy-paste instead of a shared package means manual sync
discipline — someone has to remember to copy the file after editing the
canonical one. This is accepted specifically because the golden vector CI
(from `proposal-sdk-api-only.md`) catches drift in the crypto files
automatically, and the type-only files fail at compile time on drift. The
duplication is intentionally scoped to files small and stable enough that
this is a low-frequency, low-cost manual step, not a maintenance burden.
