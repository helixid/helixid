# HelixID — E2E Demo, Console & README/Website: Decision Log

Living document. Append/update as decisions are made. Keep entries dated if it
helps track when something changed. Superseded decisions should be struck
through or moved to a "Superseded" section rather than deleted, so we don't
lose the reasoning.

---

## Console

- Console is a **real, general-purpose open-source product**, not a
  demo-only feature and not tied to travel/any vertical.
- Lives in the main HelixID repo, versioned and released independently of
  any sample app.
- It's a UI layer over SDK methods and API endpoints already catalogued in
  `public-surfaces.md`:
  - Enroll agents (`/v1/enrollment-tokens`, `/v1/onboard`)
  - Browse DIDs (`/v1/dids`, `/v1/dids/:did`)
  - View issued VCs (`/v1/vcs`, `/v1/vcs/:vcId`)
  - Inspect VPs as they're presented / verified
  - Watch the audit log (issuance, verification, revocation events)
- Not everything depends on it — VP creation/verification works standalone
  (agent ↔ backend, no UI needed). Console is observability + operator
  actions layered on top.

---

## Sample app structure

Modeled on Wayfinder's shape (structural pattern kept; ThunderID-specific
naming/references removed — we are not building on/for ThunderID).

| Folder | Role |
|---|---|
| `frontend/` | Booking UI + chat widget |
| `backend/` | Business logic + booking data + **verifier** (calls `verifyVP()`, checks scope) |
| `ai-agent/` | Chat/tool orchestration + LLM calls, plus enrolls and requests server-signed VPs before calling backend |
| `helixid-config/` | Scope definitions, service registration policy, enrollment token policy |

Console is **not** a folder inside the sample app. Same relationship pattern
as Wayfinder had with its identity product: separate codebase, but the
sample's own `docker-compose.yml` brings it up as one of its services,
pre-seeded, and prints the Console URL when ready.

`e2e-travel-concierge-v2` stays where it currently is in the repo for now.

**Decision update — 2026-07-02:** `examples/e2e-travel-concierge` in the
main repo is the **source of truth** for the demo example. The downloadable
zip must be generated automatically from that folder by CI/release packaging,
not maintained as a separate copy.

---

## docker-compose service list (final shape)

```
services:
  helixid-api:        # issuer/verifier backend — DIDs, VCs, status list, /v1/vp/verify
  helixid-console:     # general-purpose UI — enroll, browse DIDs/VCs/VPs, audit
  helixid-setup:       # one-shot seeder (see below)
  ai-agent:            # sample agent — enrolls, requests server-signed VPs
  backend:             # booking logic + verifier (calls verifyVP())
  frontend:            # booking UI + chat widget
```

---

## Image strategy (locked decision)

`helixid-api` and `helixid-console` are pulled as **pre-built, versioned
images from a registry** (e.g. `ghcr.io/nicedigverse/helixid-api:x.y.z`,
`ghcr.io/nicedigverse/helixid-console:x.y.z`) — **not** local `build:`
contexts.

Why:
- One `docker-compose.yml` works identically for both the clone path and
  the zip path — no relative-path breakage in the zip (a `build: ../../helix-api`
  context has nothing to point to once source is outside the zip).
- Version-pinned to a release tag, so the demo doesn't silently break when
  core repo code changes on `main`.
- Zip stays lightweight — no need to vendor core source into `examples/`.

Escape hatch: devs who want to hack on `helix-api`/Console itself while
running the demo get a separate `docker-compose.override.yml` with a local
build context — documented in the **sample app's own README**, not the main
one.

---

## `helixid-setup` (the seeder) — responsibilities

- Pre-registers the booking `backend` as a known VP-eligible service via
  `POST /v1/services`
- Seeds scopes
- Pre-onboards the demo agents (agents + VCs already sitting in Console)
- Seeds an initial status list
- Prints the Console URL once done

---

## Onboarding — two tracks in the demo

1. **Pre-onboarded agents** — zero-friction, seeded by `helixid-setup`.
   E.g. Concierge Agent already holding `flights:book`, Search Agent already
   holding only `flights:read`. Reader jumps straight to "watch these
   behave differently."
2. **Guided live onboarding** — reader mints an enrollment token in
   Console, `ai-agent` (or a CLI) presents it, and they watch a new VC land
   in Console's agent list in real time. This is the one scenario that
   actually teaches the enrollment mechanism rather than showing a finished
   state.

---

## Demo scenarios — final set of 4

1. **Search vs. Book** — Search Agent (`flights:read`) vs Concierge Agent
   (`flights:book`). Scope enforcement, not a role flag in application code.
2. **Delegate to a Sub-Agent** — Concierge delegates a reduced, time-boxed
   credential; sub-agent can search but not book, despite inheriting from an
   agent that could.
3. **Revoke Mid-Flight** — operator revokes an active agent's VC from
   Console; next request fails immediately, no key rotation needed.
4. **Onboard a New Agent, Live** — the guided-onboarding track above; the
   only scenario that isn't pre-seeded.

Audit trail is a **persistent panel/rail visible across all scenarios** in
Console — not a 5th scenario.

**Explicitly excluded from the demo:** cross-org trust and
session-bridge/JWT. (Cross-org needs two real orgs to demo honestly; session
bridge is a performance story, not a trust story.)

---

## Distribution

- **Two options only** (clone dropped — see below):
  1. **Website try-it link** (no local setup) — offered first.
  2. **Zip download** (pre-filled `.env`, LLM key still manual) — the only
     local-run path.
- **Clone removed as an option.** Cloning the whole monorepo just to `cd`
  into `examples/e2e-travel-concierge` was unnecessary friction, and it also
  risked confusing users into thinking the example builds `helix-api`/Console
  from source sitting right next to it, when it actually pulls pre-built
  registry images (see Image strategy above). Fewer options, less confusion.
- **Source of truth stays in the main repo's `examples/` folder** — not
  spun out into its own repo. The zip is an **auto-packaged release
  artifact**, built from that folder via CI/release pipeline, so:
  - **Q: Where should the `e2e-travel-concierge` example live as source of
    truth? A:** In the main repo's `examples/` folder. The zip is
    auto-packaged from it via CI/release.
  - The example folder remains the single place to maintain the demo.
  - Zip users never see or need to know about the monorepo structure — they
    unzip and it's self-contained at the root (no subfolder `cd` needed).
  - Versioned and hosted via GitHub Releases (e.g.
    `sample-app-helixid-0.46.0.zip` style), packaged automatically whenever
    `examples/e2e-travel-concierge` changes as part of a release.
- Getting an LLM key (Anthropic Console / OpenAI Platform) is a manual step
  regardless of path — can't be pre-filled even in the zip. Kept as an
  explicit early step, before the zip download.

---

## README content (approved base version — do not regenerate until asked)

The following is the **current locked draft** for the "Full Demo" README
section. Structure/content approved; only pending edits are the ones listed
in "Open items" below (4th scenario, Console naming, pre-registration
mention — these still need to be folded into this draft on request).

> Kept as prose reference here so we don't lose it, but the actual
> integration/edit pass into the README happens only when explicitly
> requested.

- Intro: what the demo shows (scoped access, delegation, revocation, live
  audit trail) — **liked as-is, keep this framing**.
- Website link offered first as the no-setup alternative.
- Step 1 — Get an LLM API key (Anthropic / OpenAI links).
- Step 2 — Get the demo — **needs update**: drop the clone column, zip-only
  local path (see Distribution decision above). `.env` setup instructions
  stay, since the zip still ships with a pre-filled `.env` (LLM key manual).
- Step 3 — Run it (`docker-compose up`) — **needs update**: mention Console
  coming up as its own service + printing its URL, mention backend
  pre-registration via `helixid-setup`, per decisions above.
- Step 4 — Try the security patterns (scenario table) — **needs update**:
  expand from 3 to 4 scenarios (add "Onboard a New Agent, Live"), and
  attribute the audit panel to Console explicitly.

---

## Website "Try the Demo" prompt

**Status: on hold.** Drafted once already but paused per instruction — do
not regenerate or revisit until explicitly asked. When resumed, it should:
- Mirror the README content decisions above (same facts, marketing voice).
- Reflect the final 4-scenario list, not the earlier 3-scenario draft.
- Reference Console by name once its role is finalized in the README pass.

---

## Master task list (current, in dependency order)

1. Sample app README — Wayfinder-equivalent structure (what it is, how
   organized, project structure, quick start).
2. Full example content — README + website content, now that Console is a
   real open-source UI product.
3. Coding spec: example end-to-end — folder structure, which APIs used
   where, orchestration (`docker-compose.yml`, service startup/dependency
   order), seeder script (`helixid-setup`), distribution via GitHub
   Releases.
4. Coding spec: Console — enroll flow, agent list, VC/VP history, audit
   trail view, etc.
5. Coding spec: `helix-api` changes — service registry unification
   (Option A). Design decisions (seed migration, endpoint auth) being
   resolved separately, outside this thread.

---

## Open / unresolved items

- Service registry Option A sub-decisions:
  - Whether `amazon`/`helix-delegation` (current in-memory seeded services)
    become seeded DB rows or get dropped.
  - Whether `POST /v1/services` moves behind `x-admin-api-key` now that
    it's a trust boundary, not just metadata publication.
  - *(Owner: you, resolving separately.)*
- Whether `HelixClient.registerService()` SDK method gets added, or
  `POST /v1/services` stays a direct admin-authenticated API call.
- "Register your service" step placement in the **Production path**
  section of the main README (currently placed right after API config) —
  not yet reconfirmed against the new Console/seeder context, since the
  sample app now does registration automatically via `helixid-setup`
  rather than the manual `curl` step shown in Production path.
- Main README's "Full Demo" section: pending edits listed above (4th
  scenario, Console attribution, pre-registration mention) not yet applied
  — waiting on explicit go-ahead.

---

## Superseded / discarded

- **ThunderID as a reference model** — earlier comparisons used ThunderID
  terminology (`thunderid-setup`, `thunderid-config`) as a stand-in while
  reasoning about structure. The *structural pattern* (external identity
  product, brought up via the sample's own compose file, seeded, prints a
  Console URL) is kept and generalized above under "Sample app structure" /
  "docker-compose service list" — but ThunderID itself is no longer part of
  the plan and shouldn't appear in any output copy.
- Earlier 3-scenario list (Search vs. Book, Delegate, Revoke only) —
  superseded by the 4-scenario list above, which adds "Onboard a New Agent,
  Live."

# examples/e2e-travel-concierge is repalced with examples/e2e-travel-concierge-v2