# The agent's consent-aware tool call -- the whole of Part D's behaviour in
# one function. Python port of agent/consentAwareCall.ts.
#
# The agent itself has no consent logic: it never decides what the user may
# authorize, it only notices when an SP says "not without a grant" and hands
# off to that SP's own consent page. What makes step 5 of the demo work is
# the first line of call_sp_tool(): before requesting any presentation, ask
# whether a grant for THIS (service, user) pair already exists.
#
# Agent self-custody is retired, so "ask" now means asking the platform rather
# than a local wallet: the SP's grant is persisted when it finalizes it, and
# the VP is signed by the API on the agent's behalf.

from __future__ import annotations

import json
from typing import Any, Callable, Dict, Optional

import requests

from helix_sdk.client import HelixClient


class ConsentDeclinedError(Exception):
    def __init__(self, service_did: str) -> None:
        super().__init__(f"User declined consent for {service_did}")
        self.name = "ConsentDeclinedError"


def _find_existing_grant(
    client: HelixClient, agent_did: str, service_did: str, user_did: str
) -> Optional[Dict[str, Any]]:
    """The platform's standing grant for this SP and this user, if any.

    There is no wallet to ask any more: the SP's DelegationGrantCredential is
    persisted by the platform when the SP finalizes it. list_vcs() returns
    summaries without a credentialSubject, so each active credential is read
    back in full to match on (service, user). That is a read per credential,
    which is fine at demo scale.
    """
    for summary in client.list_vcs(subject_did=agent_did, status="active"):
        vc = (client.get_vc(summary["vcId"]) or {}).get("vc")
        if not vc or "DelegationGrantCredential" not in (vc.get("type") or []):
            continue
        subject = vc.get("credentialSubject") or {}
        if subject.get("userDid") == user_did and (subject.get("serviceDid") or vc.get("issuer")) == service_did:
            return vc
    return None


def _build_vp(
    client: HelixClient,
    agent_did: str,
    service_did: str,
    user_did: str,
    grant: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    """Signed by the API on the agent's behalf -- with self-custody retired
    the agent has no key of its own. The server looks up the agent's own
    HelixAgentCredential; the grant travels as a separate, independent
    credential and is never merged into that credential's delegation chain.
    """
    return client.sign_vp(agent_did, service_did, user_did=user_did, grant_vc=grant)


def _post_tool_call(
    sp_mcp_url: str, tool_name: str, args: Dict[str, Any], vp: Dict[str, Any], correlation_id: Optional[str] = None
) -> Dict[str, Any]:
    arguments = {**args, "_helixVP": vp}
    if correlation_id is not None:
        arguments["_helixCorrelationId"] = correlation_id
    response = requests.post(
        sp_mcp_url,
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": tool_name, "arguments": arguments}},
        timeout=15,
    )
    return response.json()


# Called with {serviceDid, consentUrl, requiredScope}; returns the grant VC
# or None if the user declined. In the browser demo this always returns
# None -- the server never blocks; the browser drives the SP consent popup
# and retries POST /api/call itself.
ConsentHandler = Callable[[Dict[str, str]], Optional[Dict[str, Any]]]


def call_sp_tool(
    client: HelixClient,
    agent_did: str,
    user_did: str,
    sp_mcp_url: str,
    service_did: str,
    tool_name: str,
    on_consent_required: ConsentHandler,
    args: Optional[Dict[str, Any]] = None,
    correlation_id: Optional[str] = None,
) -> Dict[str, Any]:
    args = args or {}

    # Step 5 hinges on this: reuse a standing grant if the platform already
    # holds one for this (service, user) pair.
    existing_grant = _find_existing_grant(client, agent_did, service_did, user_did)
    first = _post_tool_call(
        sp_mcp_url,
        tool_name,
        args,
        _build_vp(client, agent_did, service_did, user_did, existing_grant),
        correlation_id,
    )

    if not first.get("error"):
        result = {"ok": True, "consentPrompted": False}
        content = (first.get("result") or {}).get("structuredContent")
        if content is not None:
            result["data"] = content
        return result

    error = first["error"]
    error_data = error.get("data") or {}
    if error_data.get("code") != "CONSENT_REQUIRED":
        return {
            "ok": False,
            "consentPrompted": False,
            "error": {
                "code": error_data.get("code", "CALL_FAILED"),
                "reason": error_data.get("reason"),
                "message": error.get("message", "Tool call failed"),
            },
        }

    # The SP wants a grant. Hand off to its consent page.
    grant_vc = on_consent_required(
        {
            "serviceDid": service_did,
            "consentUrl": error_data.get("consentUrl", ""),
            "requiredScope": error_data.get("requiredScope", ""),
        }
    )
    if not grant_vc:
        raise ConsentDeclinedError(service_did)

    # No agent-side store to put it in, and none needed: the platform recorded
    # this grant when the SP finalized it, so the next call's
    # _find_existing_grant() will see it. Passed straight through here to
    # avoid re-reading it.
    retry = _post_tool_call(
        sp_mcp_url,
        tool_name,
        args,
        _build_vp(client, agent_did, service_did, user_did, grant_vc),
        correlation_id,
    )

    if retry.get("error"):
        retry_error = retry["error"]
        retry_data = retry_error.get("data") or {}
        return {
            "ok": False,
            "consentPrompted": True,
            "error": {
                "code": retry_data.get("code", "CALL_FAILED"),
                "reason": retry_data.get("reason"),
                "message": retry_error.get("message", "Tool call failed after consent"),
            },
        }

    result = {"ok": True, "consentPrompted": True}
    content = (retry.get("result") or {}).get("structuredContent")
    if content is not None:
        result["data"] = content
    return result
