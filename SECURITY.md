# Security Policy

HelixID is infrastructure for cryptographic identity and authorization of AI agents. The code here makes trust decisions on behalf of autonomous software in production systems, so we treat security reports seriously and respond quickly.

This document covers how to report vulnerabilities, what is in scope, what you can expect from us, and our commitments to good-faith researchers.

---

## Supported Versions

HelixID is pre-1.0. Security patches are provided for the **latest minor release only**. We will publish a formal supported-versions table once we reach 1.0 and have at least one stable long-term branch.

| Version | Supported |
|---|---|
| Latest minor (`0.x`) | Yes |
| Any earlier release | No — upgrade to the latest minor |

If you operate HelixID in production on a pinned older release and need backport guidance, email us at the address below and we will work with you where feasible.

---

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Use one of these two channels — whichever you prefer:

1. **Email:** `hello@dgverse.in`
2. **GitHub Security Advisory:** Use the "Report a vulnerability" button under the **Security** tab of the [HelixID repository](https://github.com/helixid/helixid/security/advisories). This opens a private advisory visible only to repository maintainers.

Both channels are monitored. Use whichever fits your workflow.

### What to Include

A good report lets us reproduce and assess impact quickly:

- Affected component and version(s) — SDK, a specific package, a middleware, a policy
- Reproduction steps with a minimal, self-contained example
- Expected behavior vs. observed behavior
- Impact assessment — what can an attacker achieve?
- Any suggested mitigation, if you have one
- Your name or handle as you'd like it to appear in credit (or "anonymous")

If a reproducer involves cryptographic material, environment variables, or private network paths, please redact them or share out-of-band.

### Encrypted Reports

If you prefer to send encrypted reports, request our PGP public key in your initial email and we will provide it. We do not publish a long-lived PGP key because key rotation hygiene for a small team is worse than on-demand exchange.

---

## Response and Disclosure

### What You Can Expect From Us

| Stage | Target |
|---|---|
| Acknowledgement of your report | Within **48 hours** |
| Initial triage and assessment | Within **7 business days** |
| Mitigation plan for confirmed critical issues | Within **7 days of triage** |
| Security advisory and patch release | Coordinated with the reporter |
| Public disclosure | Default **90 days** from triage, or sooner if a fix ships |

These are targets, not SLAs. If we are unable to meet them, we will communicate proactively rather than go silent.

### Coordinated Disclosure

We practice coordinated disclosure. After confirmed triage:

- We will work with you on a fix and a disclosure timeline.
- Default embargo is 90 days from triage confirmation. We may shorten this if a fix ships and patched releases are available, or extend it by mutual agreement for unusually complex issues (e.g., protocol-level flaws requiring ecosystem coordination).
- We will request CVE assignment where appropriate and publish a GitHub Security Advisory with full details, workarounds, and patched versions.
- We will credit you in the advisory under your preferred name, unless you ask us not to.

If a vulnerability is already publicly known — disclosed elsewhere, under active exploitation, or accidentally leaked — email us immediately so we can expedite mitigation and communication.

---

## Scope

### In Scope

Vulnerabilities in any code within this repository, with particular priority for:

- **Credential verification** — VC signature validation, proof formats, JWS/Ed25519 handling, JSON-LD canonicalization edge cases
- **Delegation chain validation** — chain walking, depth enforcement, scope subset checking, delegation attack vectors
- **Revocation** — StatusList2021 bitstring handling, cache staleness leading to use-after-revocation, mirror node falsification attacks
- **Key handling** — key generation, storage recommendations, serialization, constant-time violations, side-channel leakage
- **OPA policy integration** — evaluation sandbox escape, input sanitization, policy bypass
- **Framework middleware** — credential extraction, injection vectors, bypass of policy enforcement in LangChain / MCP integrations
- **Supply-chain concerns** — tampered npm artifacts, typosquat risk on `@helixid/*` packages, release signing integrity

**Cryptographic and protocol-level flaws are explicitly in scope even without a working exploit.** Timing-channel violations, constant-time lapses, incorrect proof format handling, or deviations from W3C VC 2.0 / DID 1.0 / StatusList specifications are valid reports. We do not require proof-of-concept exploits for crypto-layer issues.

### Out of Scope

- Vulnerabilities in upstream dependencies — please report to the upstream project. If the upstream refuses or is unresponsive and HelixID users are at material risk, let us know and we will help triage.
- Issues in example code under `examples/` that would not affect SDK users who follow documented patterns
- DoS via unbounded policy input, unbounded delegation depth beyond sane configuration, or resource exhaustion from attacker-controlled cache keys at the edge — unless a default configuration enables the attack
- Social engineering, physical attacks, or attacks on personal infrastructure of maintainers
- Findings in forks, unreleased branches, or versions not listed as supported
- Missing security headers, informational TLS weaknesses, or SPF/DKIM findings on `dgverse.io` marketing infrastructure
- Automated scanner output without a demonstrated or credibly theorized security impact

### Key Compromise

If you suspect that a HelixID release signing key, a maintainer's signing key, or a published DID's keypair under our control is compromised, treat this as a **critical-severity report** and flag it in the subject line as `[KEY COMPROMISE]`. We will prioritize these above all other reports.

---

## Safe Harbor

We consider security research and vulnerability disclosure activities conducted consistent with this policy to be authorized conduct. We will not initiate or cooperate with legal action against researchers for good-faith security research that accidentally violates this policy, including:

- Accessing data that is not your own, only to the minimum extent necessary to demonstrate the vulnerability, and not copying, exfiltrating, or retaining it beyond what is required for the report
- Temporarily disrupting a test deployment, provided production systems and other users are not affected
- Reverse engineering, probing, or scanning HelixID binaries, packages, and source code

Activities that are **not** covered by safe harbor and remain prohibited:

- Attacking production infrastructure operated by DgVerse or by third parties running HelixID
- Accessing, modifying, or destroying data belonging to other users
- Publicly disclosing vulnerabilities before coordinated disclosure
- Social engineering, phishing, or physical attacks against DgVerse personnel or partners
- Violating any applicable law

If you are uncertain whether a specific test activity is authorized, email us first and we will clarify in writing.

---

## Recognition

We do not currently offer a monetary bug bounty. When a budget makes this credible, we will publish program terms — not before.

What we do offer:

- **CVE and GitHub Security Advisory credit** under your preferred name
- **Hall of Fame** in [`SECURITY_HALL_OF_FAME.md`](SECURITY_HALL_OF_FAME.md) for valid, impactful reports
- Direct acknowledgement in release notes for the patched version
- Our genuine thanks — the work you do protects everyone operating HelixID in production

---

## Security Best Practices for Operators

If you are running HelixID in production, these are the highest-leverage things to get right. Not a substitute for full guidance in [`docs/security-model.md`](docs/security-model.md), but a useful starting point:

- **Key custody:** Never store issuer or agent private keys in plaintext in source control, environment files committed to Git, or logs. Use a KMS, HSM, or at minimum encrypted-at-rest secret storage with IAM-scoped access.
- **Revocation caches:** Configure reasonable TTLs. Over-aggressive caching leads to use-after-revocation.
- **Policy checks:** Treat authorization rules as security-critical code; review and test them with the same rigor as application logic.
- **Delegation depth:** Set `maxDelegationDepth` explicitly on every credential. The default is conservative; do not disable the check.
- **Clock skew:** Ensure reasonable clock synchronization. Credential expiration checks depend on it.
- **Audit ingestion:** Treat audit logs as append-only evidence. Do not rely on a single datastore as the sole audit trail.
- **Subscribe to advisories:** Watch this repository with "Releases and security advisories" enabled, or subscribe via RSS to the [Security Advisories feed](https://github.com/nicedigverse/helixid/security/advisories).

---

## Related Documents

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — contribution process and coding standards
- [`docs/security-model.md`](docs/security-model.md) — threat model and architectural security assumptions
- [`docs/architecture.md`](docs/architecture.md) — full architecture overview

---

## Contact

- **Security reports:** `hello@dgverse.in`
- **GitHub Security Advisories:** [github.com/nicedigverse/helixid/security/advisories/new](https://github.com/nicedigverse/helixid/security/advisories/new)
- **General inquiries (non-security):** `hello@dgverse.in`

---

Thank you for helping keep HelixID and the systems built on it secure.
