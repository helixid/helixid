# The agent's consent-aware tool call (KYA-OS stories C-C, L3-E, L3-H).
# Python port of examples/e2e-consent-demo/agent/consentAwareCall.ts.
#
# Every call carries a request proof signed by the agent's own key (self
# custody: the key helix_init generated, never sent to Helix) and, once the user consented
# at this SP, its chain: the root hop the user's did:key signed on Helix's
# consent page, renewed without a click before it expires. When the SP answers
# with the signed needs_authorization challenge, the agent first checks the
# SP's response proof (so the consent URL it shows is the one the SP sent),
# then hands the user the URL and waits; once the user approved, it retries
# with the resume token and the new hop.
#
# Step 4 of the demo (a second booking at the same SP, no prompt) is the
# stored hop: the SP verifies it on the first attempt.

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Mapping, Optional

import requests

from helix_sdk import consent as helix_consent
from helix_sdk.crypto.jws import Signer
from helix_sdk.needs_authorization import handle_needs_authorization, is_needs_authorization, with_resume
from helix_sdk.request_proof import with_request_proof

from agent.consent_store import ConsentStore

# Which of the SP's users the agent acts for (see helixid_config.DEMO_SERVICE_USER).
SERVICE_USER_META_KEY = "org.helixid/service-user"


@dataclass
class CallSpToolOptions:
    signer: Signer
    agent_did: str
    consents: ConsentStore
    service_user_id: str
    sp_mcp_url: str
    service_did: str
    tool_name: str
    # Resolves the SP's did:web document, to check its response proofs.
    resolve_did: Callable[[str], Any]
    args: Dict[str, Any] = field(default_factory=dict)
    correlation_id: Optional[str] = None


@dataclass
class ConsentPrompt:
    authorization_url: str
    resume_token: str
    scopes: List[str]


def _post(url: str, call: Mapping[str, Any]) -> Dict[str, Any]:
    response = requests.post(url, json={"jsonrpc": "2.0", "id": 1, **call}, timeout=60)
    return response.json()


def _current_hop(options: CallSpToolOptions) -> Optional[Dict[str, Any]]:
    """The stored consent's hop, renewed first when it nears its end inside the consented window."""
    stored = options.consents.get(options.service_did)
    if stored is None:
        return None
    now = time.time()
    # renew_before never answers a time before `now`, so it is asked from the epoch: when the 60 s margin starts.
    if now < helix_consent.renew_before(stored["hop"]["validUntil"], 60, 0):
        return stored["hop"]
    if now >= stored["windowUntil"]:
        # The consented window is over: the user is asked again on the next call.
        options.consents.drop(options.service_did)
        return None
    try:
        renewed = helix_consent.renew_consent_hop(stored["helixUrl"], stored["consentId"], options.signer, options.service_did)
    except Exception:  # noqa: BLE001 - withdrawn, or the window ended: ask again
        options.consents.drop(options.service_did)
        return None
    options.consents.put({**stored, "hop": renewed["hop"], "windowUntil": renewed["windowUntil"]})
    return renewed["hop"]


def _signed_call(options: CallSpToolOptions, hop: Optional[Dict[str, Any]], resume: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """The call as sent: arguments (with the resume control arguments on a retry), the proof over exactly that, and the chain."""
    arguments = dict(options.args or {})
    if options.correlation_id is not None:
        arguments["_helixCorrelationId"] = options.correlation_id
    params: Dict[str, Any] = {"name": options.tool_name, "arguments": arguments}
    if resume is not None:
        params = with_resume(params, resume["token"], resume["hop"])
    params["_meta"] = {SERVICE_USER_META_KEY: options.service_user_id}
    return with_request_proof(
        {"method": "tools/call", "params": params}, options.signer, audience=options.service_did, chain=None if hop is None else [hop]
    )


def _outcome(response: Mapping[str, Any], consent_reused: bool) -> Dict[str, Any]:
    error = response.get("error")
    if error:
        return {"status": "error", "error": {"code": (error.get("data") or {}).get("code", "CALL_FAILED"), "message": error.get("message", "Tool call failed")}}
    result = response.get("result") or {}
    if result.get("isError"):
        code = (result.get("structuredContent") or {}).get("error", "CALL_FAILED")
        content = result.get("content") or [{}]
        return {"status": "error", "error": {"code": code, "message": content[0].get("text", code)}}
    out: Dict[str, Any] = {"status": "ok", "consentReused": consent_reused}
    if result.get("structuredContent") is not None:
        out["data"] = result["structuredContent"]
    return out


def call_sp_tool(options: CallSpToolOptions) -> Dict[str, Any]:
    """{status: ok, data, consentReused} | {status: consent_required, prompt: ConsentPrompt} | {status: error, error}."""
    hop = _current_hop(options)
    call = _signed_call(options, hop)
    response = _post(options.sp_mcp_url, call)
    result = response.get("result")
    if result is not None and is_needs_authorization(result):
        # The SP's signature over the challenge, checked before its URL is trusted.
        challenge = handle_needs_authorization(result, options.service_did, options.resolve_did, request=call).challenge
        return {
            "status": "consent_required",
            "prompt": ConsentPrompt(authorization_url=challenge.authorization_url, resume_token=challenge.resume_token, scopes=list(challenge.scopes)),
        }
    return _outcome(response, hop is not None)


def complete_consent(options: CallSpToolOptions, prompt: ConsentPrompt) -> Dict[str, Any]:
    """After the user decided on Helix's page: waits for the root hop, keeps it, and retries the challenged
    call with the resume token and the hop. Raises ConsentFlowError (reason consent_not_approved) when the
    user declined."""
    approved = helix_consent.await_consent_hop(prompt.authorization_url, options.agent_did, options.service_did, timeout_seconds=300)
    options.consents.put(
        {"serviceDid": options.service_did, "consentId": approved["consentId"], "hop": approved["hop"], "windowUntil": approved["windowUntil"], "helixUrl": approved["helixUrl"]}
    )
    call = _signed_call(options, approved["hop"], {"token": prompt.resume_token, "hop": approved["hop"]})
    return _outcome(_post(options.sp_mcp_url, call), False)
