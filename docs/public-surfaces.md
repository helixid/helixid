# Helix ID Public Surfaces

This document lists the outside-facing API, SDK, LangChain, MCP, and CLI surfaces. It is a quick reference, not a full protocol guide.

## helix-api HTTP APIs

Base paths are mounted from `helix-api/src/server.ts`.

| Method | Path | Purpose | Main input | Main output / notes |
| --- | --- | --- | --- | --- |
| `GET` | `/health` | Check API health and runtime adapters. | None. | Status, version, environment, storage, database, cache adapter. |
| `GET` | `/.well-known/did.json` | Serve issuer DID document for `did:web`. | None. | DID document or `DID_NOT_FOUND`. Cacheable for 1 hour. |
| `POST` | `/v1/dids` | Create a DID from an Ed25519 public key. | `publicKeyHex`, `subjectType`, optional HTTPS `domains`. | DID record, DID document, Hedera transaction id. |
| `GET` | `/v1/dids/:did` | Resolve DID to DID document. | DID path param, optional `?live=true`. | DID document. Returns `410` if deactivated. |
| `POST` | `/v1/dids/:did/services` | Add service endpoint to DID document. | `id`, `type`, HTTPS `serviceEndpoint`. | Updated DID document. |
| `DELETE` | `/v1/dids/:did/services/:endpointId` | Remove service endpoint. | DID and endpoint id path params. | Updated DID document. |
| `POST` | `/v1/dids/:did/deactivate` | Permanently deactivate DID. | DID path param. | `{ did, deactivated: true }`. |
| `POST` | `/v1/vcs` | Issue credential. | `subjectDid`, `subjectType`, scopes/name/user/expiry fields. | VC, VC id, status index, expiry. Requires `x-admin-api-key`. |
| `GET` | `/v1/vcs` | List credential summaries. | Optional `subjectDid`, `status`, `limit`. | Array of VC summaries with DID, scopes, status, issue/expiry time, and delegation parent. Requires `x-admin-api-key`. |
| `GET` | `/v1/vcs/:vcId` | Fetch credential details. | VC id path param. | Stored VC response. |
| `POST` | `/v1/vcs/:vcId/revoke` | Revoke credential by setting status-list bit. | VC id path param. | Updated VC status. Requires `x-admin-api-key`. |
| `POST` | `/v1/vcs/:vcId/renew` | Issue renewed credential from an existing VC. | VC id, optional `privilegeScopes`, `expiresInSeconds`. | New/renewed VC response. Requires `x-admin-api-key`. |
| `GET` | `/v1/status-list/:listId` | Serve public revocation status list credential. | Status list id. | Status list credential. Cacheable for 5 minutes. |
| `POST` | `/v1/status-list` | Create or replace a status list credential. | Optional `listId`, optional `length`. | Status list credential. Requires `x-admin-api-key`. |
| `POST` | `/v1/vp/verify` | Verify signed VP and optionally issue session token. | `signedVP`, optional `session: true`. | Verification result, optionally session data. |
| `GET` | `/v1/sessions/public-key` | Return API session JWT verification public key. | None. | Ed25519 public key metadata. Cacheable for 1 hour. |
| `POST` | `/v1/enrollment-tokens` | Create enrollment token for an agent. | `agentName`, `requestedScopes`, optional `requestedDomains`, `maxDelegationDepth`. | Enrollment token/challenge metadata. |
| `POST` | `/v1/enroll` | Legacy/direct enrollment proof flow. | `bootstrapToken`, `agentDid`, `timestamp`, `proofSignature`. | Issued VC for agent. |
| `POST` | `/v1/onboard` | Onboarding step 1: create challenge for generated key. | `enrollmentToken`, `publicKeyHex`, optional `domains`. | `challengeId`, nonce, expiry, optional DID-create signing payload. |
| `POST` | `/v1/onboard/verify` | Onboarding step 2: verify challenge and issue VC. | `challengeId`, `signature`, optional `didCreateSignature`. | `agentDid`, `vc`, `vcId`. |
| `POST` | `/v1/challenges` | Issue user verification challenge. | `did`, `purpose: "user_verification"`. | Challenge id, nonce, expiry. |
| `POST` | `/v1/challenges/:challengeId/verify` | Verify user challenge signature. | Challenge id, `signature`. | Verified DID and optional VC. |
| `GET` | `/v1/audit-log` | List audit events. | Optional `eventType`, `since`, `limit`. | Newest-first audit summaries, including derived `delegatedFrom`, `delegatedTo`, `parentVcId`, and `delegationDepth` for VP verification events when delegation context is available; `attemptedVcId`, `attemptedParentVcId`, `attemptedDelegatedFrom` for rejections; `issuer`, `userDid`, `scopes`, `durability` for consent events. Requires `x-admin-api-key`. |
| `POST` | `/v1/audit-log/vp-verification` | Record API-backed VP verification audit entry. | `vpId`, `agentDid`, `result`, optional `targetService`, `reason`, `delegatedFrom`, `delegatedTo`, `delegationChain`, `verifiedAt`, and on rejections `attemptedVcId`, `attemptedParentVcId`, `attemptedDelegatedFrom`. | Audit entry recorded. Requires `x-admin-api-key`. |
| `POST` | `/v1/audit-log/consent-granted` | Record an agent-side `CONSENT_GRANTED` entry when an SP-issued delegation grant lands in the wallet. | `vcId`, `agentDid`, optional `issuer`, `userDid`, `scopes`, `durability`, `grantedAt`. | Audit entry recorded. Requires `x-admin-api-key`. |
| `POST` | `/v1/audit-log/events` | Generic activity-trail ingestion, used by Service Providers and agents to record the identity → credential → presentation → verification → authorization → action → result chain. | `event` (one of `VC_ISSUED`, `VC_PRESENTED`, `VP_VERIFIED`, `VP_REJECTED`, `AUTHZ_GRANTED`, `AUTHZ_DENIED`, `TOOL_INVOKED`, `CONSENT_GRANTED`, `CONSENT_REVOKED`) plus at least one of `agentDid`/`serviceDid`; optional `correlationId`, `userDid`, `vcId`, `credentialType`, `issuer`, `scopes`, `validUntil`, `credentialStatus`, `serviceName`, `toolName`, `requiredScope`, `effectiveScopes`, `vpId`, `result`, `reason`, `resultSummary`, `timestamp`. | Audit entry recorded. Requires `x-admin-api-key`. |

## SDK Methods

Public SDK exports come from `helix-sdk-js/src/index.ts`.

### `HelixClient`

API-backed client. Construct with no args for SDK-only mode, or with API base URL and optional `{ adminApiKey }`.

| Method | Purpose |
| --- | --- |
| `createDID(options)` | Generate keypair and call `POST /v1/dids`. |
| `resolveDID(did, options?)` | Resolve DID through API, optionally live. |
| `addServiceEndpoint(did, endpoint)` | Add DID service endpoint. |
| `removeServiceEndpoint(did, endpointId)` | Remove DID service endpoint. |
| `deactivateDID(did, reason)` | Deactivate DID. |
| `issueVC(options)` | Issue VC through API. |
| `getVC(vcId)` | Fetch VC details. |
| `listVCs(filters?)` | List VC summaries through API. |
| `revokeVC(vcId)` | Revoke VC through API. |
| `renewVC(vcId, overrides?)` | Renew VC with optional scope/expiry overrides. |
| `getStatusList(listId)` | Fetch status list credential. |
| `createStatusList(options?)` | Create or replace the active status list credential through the API. |
| `getAuditLog(filters?)` | List API audit events. |
| `verifyVP(vp, options?)` | Verify VP locally and, when API credentials are configured, record `VP_VERIFIED` / `VP_REJECTED` audit entries. |
| `checkVCStatus(vc)` | Return `active`, `revoked`, or `expired`. |
| `fetchSessionPublicKey()` | Fetch public key for API-issued session JWTs. |
| `verifySessionToken(token, publicKeyHex)` | Verify API session token locally. |
| `enroll(bootstrapToken, wallet)` | Direct enrollment using wallet DID/signature; stores returned VC. |
| `requestOnboardingChallenge(token, domains?)` | Start two-step onboarding and hold pending keypair. |
| `completeOnboarding(challengeId, nonce, passphrase, path)` | Sign challenge, verify onboarding, save wallet. |
| `requestUserChallenge(userDid)` | Request user verification challenge. |
| `verifyUserChallenge(challengeId, signature)` | Verify user challenge signature. |

### `AgentWallet`

Local encrypted wallet and credential store.

| Method | Purpose |
| --- | --- |
| `credentials` | Getter returning parsed signed VCs. |
| `did` / `getDID()` | Return wallet DID. |
| `getPublicKey()` | Return public key hex. |
| `getPrivateKeyHex()` | Return private key hex in memory. |
| `createDID(subjectType)` | Create DID through attached `HelixClient`. |
| `addService(endpoint)` | Add service endpoint for wallet DID. |
| `removeService(endpointId)` | Remove service endpoint for wallet DID. |
| `deactivate(reason?)` | Deactivate wallet DID through client. |
| `sign(data)` | Sign string or bytes with wallet key. |
| `save(data, passphrase, filePath)` | Encrypt and write wallet file. |
| `load(passphrase, filePath)` | Decrypt wallet data. |
| `getPrivateKey(passphrase, filePath)` | Load and return private key. |
| `addCredential(vc)` / `addCredential(vcId, vcJson, path, passphrase)` | Add VC to in-memory/file wallet. |
| `updateCredential(vcId, vcJson, path, passphrase)` | Replace stored credential. |
| `removeCredential(vcId, path, passphrase)` | Remove stored credential. |
| `listCredentials(passphrase, path)` | List stored credential metadata. |
| `getCredential(vcId, passphrase, path)` | Fetch one stored credential metadata entry. |
| `getLatestCredential(options, passphrase, path)` | Fetch latest credential, optionally by VC type. |
| `AgentWallet.credentialFromVC(vcId, vc)` | Build wallet metadata from VC JSON. |
| `AgentWallet.generateKeypair()` | Generate a local keypair without creating a DID. |
| `AgentWallet.fromKeypairAndCredential(keypair, vc)` | Build an ephemeral in-memory wallet from a keypair and VC. |
| `AgentWallet.create(path, passphrase)` | Load wallet or create new `did:key` wallet file. |
| `AgentWallet.load(path, passphrase)` | Load wallet as an `AgentWallet` instance. |

### VP, delegation, scopes, sessions, resolver

| Export | Purpose |
| --- | --- |
| `new VPBuilder({ credentials, holderDid, targetService, userDid? }).sign(privateKeyHex, verificationMethodId)` | Build and sign a short-lived VP for a target service. `credentials` carries 1–2 entries: exactly one agent-authority VC, plus at most one consent grant VC. `userDid` is optional; when omitted, `delegatedBy` is absent from the payload. |
| `verifyVP(vp, options?)` | Verify VP signature, VC signature, expiry, revocation, target service, and delegation chain. |
| `delegate(options, wallet)` | Create delegated VC from wallet credential with scoped-down privileges. |
| `checkScope(result, requiredScope)` | Boolean scope check on `VerifyVPResult`. |
| `requireScope(result, requiredScope)` | Throw if required scope is missing. |
| `new SessionManager({ secret, ttl }).issue(input)` | Issue HMAC session JWT from verified agent/scopes. |
| `SessionManager.verify(token)` | Verify session JWT and return claims. |
| `new HelixDidResolver({ baseUrl }).resolve(did, options?)` | Resolve DID via Helix API into DID Resolution result. |
| `mapApiError(body)` | Convert API error response into SDK `HelixError`. |

## LangChain Adapter

Package: `@helixid/langchain`.

| Export | Purpose |
| --- | --- |
| `HelixIDMiddleware(options)` | Returns LangChain callback config that injects `_helixVP` into object tool input before tool start. |
| `HelixIDToolWrapper(tool, options)` | Wraps a structured tool and injects `_helixVP` before calling the original `_call`. |
| `filterToolsByScope(tools, walletFilePath, walletPassphrase)` | Filters tools by `tool.metadata.requiredScope` or tool name against wallet VC scopes. |
| `encodeBase64UrlJson(value)` | Encodes VP/object as base64url JSON. |
| `selectVC(wallet, targetService)` | Picks matching credential for target service, falling back to first VC. |
| `ensureObjectInput(input)` | Validates tool input is an object. |

Options: `walletPassphrase`, `walletFilePath`, `targetService`, optional `userDid`.

## MCP Adapter

Package: `@helixid/mcp`.

| Export | Purpose |
| --- | --- |
| `attachHelixVP(toolCall, options)` | Client-side helper that loads wallet, signs VP, and attaches `_helixVP` to MCP tool input. |
| `helixidMCPMiddleware(options)` | Server-side middleware that requires `_helixVP`, verifies it, and enforces optional scopes. |

Options:

- `AttachHelixVPOptions`: `walletPassphrase`, `walletFilePath`, `targetService`, optional `userDid`.
- `MCPMiddlewareOptions`: optional `requiredScopes`, optional `allowSelfSigned`.

## Consent Widget

Package: `@helixid/widget`. Two entry points — the server module must not be
bundled into the browser.

| Export | Entry point | Purpose |
| --- | --- | --- |
| `resolveConsentScopes(options)` | `@helixid/widget/server` | Resolves the SP's full grantable-scope catalog: curated fallback ∪ MCP `tools/list` scopes ∪ `accept-terms`. Takes no requested-scope or agent input. |
| `humanizeScope(scope)` | `@helixid/widget/server` | Last-resort label for a scope neither source describes (`book:flights` → `book flights`). |
| `createConsentController(props)` | `@helixid/widget` | Headless consent-selection state: scope checkboxes with required handling, durability choice, fetch/error state, `onAccept`/`onDecline`. |
| `DEFAULT_DURABILITY_OPTIONS` | `@helixid/widget` | The two durability choices offered by default. |

Options and types:

- `ResolveConsentScopesOptions`: optional `mcpServerUrl`, `curatedFallback` (SP-owned).
- `HelixConsentWidgetProps`: `agentDid`, `agentName`, `userIdentifier`, `serviceDid`, exactly one of `scopeOptions`/`scopesEndpoint`, optional `agentAvatarUrl`, `durabilityOptions`, `defaultDurability`, plus `onAccept`/`onDecline`.
- `ConsentSelection`: `scopes`, `durability`.

The SP owns the scope-resolution route itself (HelixID ships only its
contract): `GET <scopesEndpoint>?agentDid=<did>` → `{ scopeOptions }`, running
under the consent page's own session auth. `agentDid` is carried for audit
correlation only and must not change the returned catalog.

## CLI Commands

Binary: `helix`.

| Command | Purpose | Required options | Optional options |
| --- | --- | --- | --- |
| `helix did create` | Create DID and encrypted wallet. For `--method web`, also creates the SP's initial status list by default. | `--method <web|hedera|key>`, `--wallet <path>` | `--domain <domain>`, `--network <testnet|previewnet|mainnet>`, `--no-status-list`, `--status-list-length <bits>`, `--status-list-output <path>`, `--status-list-base-url <url>` |
| `helix issuer init` | Validate issuer wallet readiness. | `--wallet <path>` | None. |
| `helix status-list create` | Create signed BitstringStatusList credential file. | `--length <bits>`, `--output <path>`, `--base-url <url>`, `--wallet <path>` | None. |
| `helix vc issue` | Issue `HelixAgentCredential` to agent DID. | `--agent-did <did>`, `--scopes <csv>`, `--expires <duration>`, `--status-list <path>`, `--base-url <url>`, `--wallet <path>` | `--output <path>`, `--max-delegation-depth <depth>` |
| `helix revoke` | Revoke credential by flipping status-list bit. | `--vc-id <vcId>`, `--status-list <path>`, `--wallet <path>` | None. |
| `helix wallet inspect` | Inspect wallet without printing private key. | `--wallet <path>` | None. |
