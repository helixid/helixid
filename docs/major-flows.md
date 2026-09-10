# Major Application Flows

This document maps major Helix ID flows to the public surfaces in [public-surfaces.md](./public-surfaces.md).

## 1. Enrollment, VC Issuance, VP Issuance, Verification

Brief flow:

1. Operator creates enrollment token.
2. Agent completes onboarding and stores wallet + VC.
3. Agent signs a VP for a target service.
4. Verifier checks VP, VC, scopes, delegation chain, and revocation status.

Surfaces used:

| Step | Surfaces |
| --- | --- |
| Create enrollment token | `POST /v1/enrollment-tokens`, or operator-side setup with `helix vc issue` in CLI flows. |
| Onboard agent | `HelixClient.requestOnboardingChallenge()`, `HelixClient.completeOnboarding()`, `POST /v1/onboard`, `POST /v1/onboard/verify`, `AgentWallet.save()`. |
| Store/read credential | `AgentWallet.addCredential()`, `AgentWallet.credentials`, `AgentWallet.load()`. |
| Issue VP | `VPBuilder.sign()`, `HelixIDMiddleware()`, `HelixIDToolWrapper()`, or `attachHelixVP()`. |
| Verify VP | `POST /v1/vp/verify`, `verifyVP()`, `helixidMCPMiddleware()`. |
| Enforce scope | `requireScope()`, `checkScope()`, `filterToolsByScope()`, MCP `requiredScopes`. |
| Optional session | `POST /v1/vp/verify` with `session: true`, `GET /v1/sessions/public-key`, `HelixClient.fetchSessionPublicKey()`, `HelixClient.verifySessionToken()`. |

## 2. Delegation

Brief flow:

1. Existing credential holder delegates a reduced set of scopes to another DID.
2. Delegate uses the delegated VC to create a VP.
3. Verifier validates the full delegation chain.

Surfaces used:

| Step | Surfaces |
| --- | --- |
| Load parent credential | `AgentWallet.load()`, `AgentWallet.credentials`. |
| Create delegated VC | `delegate(options, wallet)`. |
| Store delegated VC | `AgentWallet.addCredential()`, `AgentWallet.updateCredential()`. |
| Issue VP from delegated VC | `VPBuilder.sign()`, LangChain `HelixIDMiddleware()`, MCP `attachHelixVP()`. |
| Verify delegation chain | `verifyVP()`, `POST /v1/vp/verify`, `helixidMCPMiddleware()`. |
| Enforce delegated scopes | `requireScope()`, `checkScope()`, `filterToolsByScope()`, MCP `requiredScopes`. |

## 3. Enrollment, VC Issuance, Revoking

Brief flow:

1. Agent enrolls and receives a VC.
2. Issuer revokes the VC.
3. Later verification fails because the status-list bit is set.

Surfaces used:

| Step | Surfaces |
| --- | --- |
| Enroll and issue VC | `POST /v1/enrollment-tokens`, `POST /v1/onboard`, `POST /v1/onboard/verify`, `HelixClient.requestOnboardingChallenge()`, `HelixClient.completeOnboarding()`. |
| Direct issue alternative | `POST /v1/vcs`, `HelixClient.issueVC()`, or `helix vc issue`. |
| Publish/read status list | `GET /v1/status-list/:listId`, `POST /v1/status-list`, `HelixClient.getStatusList()`, `HelixClient.createStatusList()`, `helix status-list create`. |
| Revoke VC | `POST /v1/vcs/:vcId/revoke`, `HelixClient.revokeVC()`, or `helix revoke`. |
| Check VC status | `HelixClient.checkVCStatus()`. |
| Verification after revoke | `verifyVP()`, `POST /v1/vp/verify`, `helixidMCPMiddleware()`. |

## 4. DID Lifecycle

Brief flow:

1. Create DID and wallet.
2. Resolve DID when needed.
3. Add or remove service endpoints.
4. Deactivate DID when it should no longer be used.

Surfaces used:

| Step | Surfaces |
| --- | --- |
| Create DID | `POST /v1/dids`, `HelixClient.createDID()`, `AgentWallet.createDID()`, `helix did create`. |
| Resolve DID | `GET /v1/dids/:did`, `HelixClient.resolveDID()`, `HelixDidResolver.resolve()`. |
| Add service endpoint | `POST /v1/dids/:did/services`, `HelixClient.addServiceEndpoint()`, `AgentWallet.addService()`. |
| Remove service endpoint | `DELETE /v1/dids/:did/services/:endpointId`, `HelixClient.removeServiceEndpoint()`, `AgentWallet.removeService()`. |
| Deactivate DID | `POST /v1/dids/:did/deactivate`, `HelixClient.deactivateDID()`, `AgentWallet.deactivate()`. |

## 5. Credential Renewal

Brief flow:

1. Issuer renews an existing VC.
2. Agent stores the renewed VC.
3. Verifiers use the latest VC and status list as usual.

Surfaces used:

| Step | Surfaces |
| --- | --- |
| Renew VC | `POST /v1/vcs/:vcId/renew`, `HelixClient.renewVC()`. |
| Store renewed VC | `AgentWallet.addCredential()`, `AgentWallet.updateCredential()`. |
| Read latest VC | `AgentWallet.getLatestCredential()`, `AgentWallet.getCredential()`. |

## 6. User DID Challenge Verification

Brief flow:

1. Verifier requests a challenge for a user DID.
2. User signs the challenge.
3. API confirms the signature.

Surfaces used:

| Step | Surfaces |
| --- | --- |
| Request challenge | `POST /v1/challenges`, `HelixClient.requestUserChallenge()`. |
| Verify challenge | `POST /v1/challenges/:challengeId/verify`, `HelixClient.verifyUserChallenge()`. |

## 7. Session Bridge

Brief flow:

1. Verifier checks a VP once.
2. API optionally returns a short-lived session token.
3. Verifier reuses the token for later calls.

Surfaces used:

| Step | Surfaces |
| --- | --- |
| Issue session on VP verify | `POST /v1/vp/verify` with `session: true`. |
| Fetch session key | `GET /v1/sessions/public-key`, `HelixClient.fetchSessionPublicKey()`. |
| Verify session token | `HelixClient.verifySessionToken()`. |

## 8. Local Dev Credential Flow

**Retired** by the agent self-custody retirement (CHANGELOG `0.2.0`) — step 2 below
(`selfIssueVC`) no longer exists in the SDK or CLI, and `verifyVP` no longer has a local
verification path (step 4), so this flow can no longer run with no server involved. Kept here
for historical reference only.

Brief flow (as it worked pre-retirement):

1. Create or load a local wallet.
2. Self-issue a dev VC.
3. Build a VP from that wallet.
4. Verify with self-signed support only in non-production paths.

Surfaces used (pre-retirement):

| Step | Surfaces |
| --- | --- |
| Create/load wallet | `AgentWallet.create()`, `AgentWallet.load()`. |
| Self-issue VC | ~~`selfIssueVC()`, `helix vc self-issue`~~ — removed. |
| Build VP | `VPBuilder.sign()`, `HelixIDMiddleware()`, `HelixIDToolWrapper()`, `attachHelixVP()`. |
| Verify self-signed VC | `verifyVP(vp, client, { allowSelfSigned: true })` — now requires a `HelixClient`; no local fallback. |

## 9. Wallet Management

Brief flow:

1. Inspect wallet contents.
2. Add or remove credentials.
3. Query stored credentials by id or recency.

Surfaces used:

| Step | Surfaces |
| --- | --- |
| Inspect wallet | `helix wallet inspect`. |
| Add or update credential | `AgentWallet.addCredential()`, `AgentWallet.updateCredential()`. |
| Remove credential | `AgentWallet.removeCredential()`. |
| List credentials | `AgentWallet.listCredentials()`. |
| Get credential | `AgentWallet.getCredential()`. |
| Get latest credential | `AgentWallet.getLatestCredential()`. |
