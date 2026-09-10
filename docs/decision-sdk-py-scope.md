# Decision: `helix-sdk-py` — repo, package name, and scope

Status: **Decided.**

## Repo

New standalone repo, `helix-sdk-py`, created now rather than living inside
the `helixid/helixid` monorepo. Consistent with the Item #3 split's final
shape (`helix-sdk-py` was already planned as its own repo), and Python
tooling doesn't gain anything from sitting in the pnpm/Turborepo workspace.

## Package name

`helixid-sdk-py`, published to PyPI.

## Scope: full parity with `helix-sdk-js`, not a phased thin-client plan

Earlier plan (superseded): ship a thin client first (API calls only, no
local crypto) to unblock Python verifiers quickly, then backfill full
DID/VC signing parity as a v1 upgrade.

Revised: build full parity with `helix-sdk-js` from the start. This is
possible now, and isn't the scope increase it would have been earlier,
because of the architecture decided in `proposal-sdk-api-only.md` and
`proposal-retire-core-package.md` — most of what made "full parity"
expensive to port (`verifyVP`, delegation-chain building, DID resolution)
is API-only for every SDK now, including `helix-sdk-js`. There's no longer
a large body of complex logic to port into Python; there's a small,
well-bounded set of primitives plus a REST client.

**Local (ported from the canonical copy, covered by golden vectors from
`proposal-sdk-api-only.md`):**
- Keypair generation, sign, canonical-hash
- VP building/signing (`VPBuilder` equivalent)
- Self-issued dev VC (`selfIssueVC` equivalent) — Local Dev Credential Flow
  has no server involved by design, same as JS
  (**Superseded:** the agent self-custody retirement, CHANGELOG `0.2.0`,
  later removed `selfIssueVC` and the Local Dev Credential Flow from
  `helix-sdk-js` entirely; this JS-parity item never had a Python
  implementation to remove.)

**API calls (same endpoints `helix-sdk-js` uses post-refactor):**
- Onboarding (challenge/response)
- VC issuance and delegation, via the `prepare` endpoints
- `verifyVP`
- DID resolution
- VC status checks
- Sessions
- Audit logging

## Versioning

`helix-sdk-py` tracks `helix-sdk-js`'s version, not an independent semver
line — same version number means same feature/API surface across both.

## Error handling

Typed exceptions in `helix-sdk-py`, mirroring `helix-sdk-js`'s error
classes (`HelixError`, `ErrorCode`, and the specific typed errors) rather
than surfacing raw non-2xx responses. Same error taxonomy on both SDKs, not
just the same HTTP status codes.

## Duplicated-file sync (crypto primitives, per `proposal-retire-core-package.md`)

No tooling or checklist — keeping the duplicated copy in `helix-sdk-js` (and
eventually `helix-sdk-py`'s own port) in sync with the canonical copy in
`helix-api` is the responsibility of whoever edits the canonical file.
Golden vector CI is the safety net that catches a missed sync, not a
process that prevents one.

## CI / publish pipeline

Deferred — TestPyPI → PyPI flow and GitHub Actions setup for
`helix-sdk-py` will be decided closer to when the repo is actually being
built, not now.

## What this means for sequencing

No change to `next-steps-sequencing.md` / `work-order.md` — Item #4 still
comes after the `prepare` endpoints and the `helix-sdk-js` refactor land,
so Python is built against a settled API shape rather than one still
moving under it.
