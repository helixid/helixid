# Major Application Flows

This document maps major Helix ID flows to the public surfaces in [public-surfaces.md](./public-surfaces.md).

## 1. Enrollment, VC Issuance, VP Issuance, Verification

Brief flow:

1. Operator creates enrollment token.
2. Agent redeems it; the server generates and holds the agent's key, creates its DID, and issues its VC (agent self-custody is retired — there is no wallet file).
3. Agent signs a VP for a target service.
4. Verifier checks VP, VC, scopes, delegation chain, and revocation status.

Surfaces used:

| Step | Surfaces |
| --- | --- |
| Create enrollment token | `POST /v1/enrollment-tokens`, or operator-side setup with `helix vc issue` in CLI flows. |
| Onboard agent | `HelixClient.onboardAgent()`, `POST /v1/onboard`. |
| Issue VP | `HelixClient.signVP()`, `POST /v1/agents/:did/vp`, or (for local signing by other actors, e.g. issuers/SPs) `VPBuilder.sign()`, `HelixIDMiddleware()`, `HelixIDToolWrapper()`, `attachHelixVP()`. |
| Verify VP | `POST /v1/vp/verify`, `verifyVP()`, `helixidMCPMiddleware()`. |
| Enforce scope | `requireScope()`, `checkScope()`, `filterToolsByScope()`, MCP `requiredScopes`. |
| Optional session | `POST /v1/vp/verify` with `session: true`, `GET /v1/sessions/public-key`, `HelixClient.fetchSessionPublicKey()`, `HelixClient.verifySessionToken()`. |

## 2. Delegation

Brief flow:

1. A server-custody agent delegates a reduced set of scopes to another DID; the server signs the delegated VC on the delegator's behalf (agent self-custody is retired, so the delegator never holds or uses its own key directly).
2. Delegate uses the delegated VC to create a VP.
3. Verifier validates the full delegation chain.

Surfaces used:

| Step | Surfaces |
| --- | --- |
| Create delegated VC | `HelixClient.delegateAuthority()`, `POST /v1/agents/:did/delegate`. |
| Issue VP from delegated VC | `HelixClient.signVP()`, `POST /v1/agents/:did/vp`, or (for local signing by other actors) `VPBuilder.sign()`, LangChain `HelixIDMiddleware()`, MCP `attachHelixVP()`. |
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
| Enroll and issue VC | `POST /v1/enrollment-tokens`, `POST /v1/onboard`, `HelixClient.onboardAgent()`. |
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
2. The renewed VC is stored server-side alongside the agent's custodial key; `signVP()` picks the active one (or pin it with `vcId`).
3. Verifiers use the latest VC and status list as usual.

Surfaces used:

| Step | Surfaces |
| --- | --- |
| Renew VC | `POST /v1/vcs/:vcId/renew`, `HelixClient.renewVC()`. |
| Find active VC | `GET /v1/vcs?subjectDid=...&status=active`, `HelixClient.listVCs()`. |
| Present renewed VC | `POST /v1/agents/:did/vp`, `HelixClient.signVP()` (optional `vcId`). |

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

## 8. Wallet Management

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
