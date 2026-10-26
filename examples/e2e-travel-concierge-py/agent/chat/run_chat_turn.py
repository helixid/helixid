# The one non-deterministic file. A real LLM decides, from the conversation,
# which tool to call. The agent never authors the outcome sentence -- the model
# does, from the real tool result -- so the reply reflects a cryptographically
# enforced decision, not a canned string.
#
# Every tool call is made *as the selected persona*, and -- when the UI picks
# a traveler -- on that traveler's behalf. History is keyed by
# (conversation_id, persona_id, traveler) so one agent's context can never
# silently leak into another's.

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from agent.chat.providers.index import get_provider
from agent.chat.types import LLMMessage
from agent.tools.protected_call import call_protected_tool
from config import TOOLS, USERS
from personas.types import Persona

_conversations: Dict[str, List[LLMMessage]] = {}

# The model sees plain business arguments; only these keys are forwarded to each tool.
TOOL_ARGS: Dict[str, List[str]] = {
    TOOLS["SEARCH"]: ["origin", "destination", "date"],
    TOOLS["BOOK"]: ["flightId", "passengerName"],
    TOOLS["SEARCH_HOTELS"]: ["city", "checkIn"],
    TOOLS["BOOK_HOTEL"]: ["hotelId", "guestName"],
}


def run_chat_turn(persona: Persona, message: str, conversation_id: str, user_id: Optional[str] = None) -> Dict[str, Any]:
    key = f"{conversation_id}::{persona.id}::{user_id or 'self'}"
    history = _conversations.get(key, [])
    context = f"(Context: you are acting on behalf of traveler {USERS[user_id]['name']}.) " if user_id else ""
    history.append(LLMMessage(role="user", content=f"{context}{message}"))

    provider = get_provider()
    trace: List[Dict[str, Any]] = []
    consent_required: Optional[Dict[str, Any]] = None

    def finish(reply: str) -> Dict[str, Any]:
        _conversations[key] = history
        out: Dict[str, Any] = {"reply": reply, "trace": trace}
        if consent_required:
            out["consentRequired"] = consent_required
        return out

    for _ in range(5):
        response = provider.complete(history)

        if response.type == "text":
            history.append(LLMMessage(role="assistant", content=response.content))
            return finish(response.content)

        # Record the assistant's tool-call turn so the provider history stays valid.
        history.append(
            LLMMessage(
                role="assistant",
                content="",
                tool_call_id=response.tool_call_id,
                tool_name=response.tool_name,
                tool_args=response.args,
                gemini_thought_signature=response.gemini_thought_signature,
            )
        )

        allowed = TOOL_ARGS.get(response.tool_name)
        if allowed is None:
            tool_result: Dict[str, Any] = {"error": f"Unknown tool: {response.tool_name}"}
        else:
            args = {name: str(response.args[name]) for name in allowed if response.args.get(name) is not None}
            result = call_protected_tool(persona, response.tool_name, args, user_id=user_id)
            trace.append({"tool": response.tool_name, "args": args, "success": result["success"], "code": result.get("code"), "detail": result["detail"]})
            if result.get("consentRequired") and consent_required is None:
                consent_required = result["consentRequired"]
            tool_result = {"success": result["success"], "code": result.get("code"), "detail": result["detail"]}

        history.append(
            LLMMessage(role="tool", tool_call_id=response.tool_call_id, tool_name=response.tool_name, content=json.dumps(tool_result))
        )

    return finish("Sorry, I wasn't able to complete that — could you rephrase?")
