# The one non-deterministic file, Python port of
# ../../e2e-travel-concierge/agent/chat/runChatTurn.ts. A real LLM decides,
# from the conversation, which tool to call. The agent never authors the
# outcome sentence -- the model does, from the real tool result -- so the
# reply reflects a cryptographically enforced decision, not a canned string.
#
# Every tool call is made *as the selected persona*: the API signs its VP.
# History is keyed by (conversation_id, persona_id) so one agent's context
# can never silently leak into another's.

from __future__ import annotations

import dataclasses
import json
from typing import Dict, List

from agent.chat.providers.index import get_provider
from agent.chat.types import LLMMessage
from agent.tools.book_flight import book_flight
from agent.tools.search_flights import search_flights
from config import TOOLS
from personas.types import Persona

_conversations: Dict[str, List[LLMMessage]] = {}


def _run_tool(persona: Persona, tool_name: str, args: dict):
    if tool_name == TOOLS["BOOK"]:
        result = book_flight(persona, str(args.get("flightId", "")), str(args.get("passengerName", "")))
        return dataclasses.asdict(result)
    if tool_name == TOOLS["SEARCH"]:
        date = args.get("date")
        result = search_flights(persona, str(args.get("origin", "")), str(args.get("destination", "")), str(date) if date else None)
        return dataclasses.asdict(result)
    return {"error": f"Unknown tool: {tool_name}"}


def run_chat_turn(persona: Persona, message: str, conversation_id: str) -> str:
    key = f"{conversation_id}::{persona.id}"
    history = _conversations.get(key, [])
    history.append(LLMMessage(role="user", content=message))

    provider = get_provider()

    for _ in range(4):
        response = provider.complete(history)

        if response.type == "text":
            history.append(LLMMessage(role="assistant", content=response.content))
            _conversations[key] = history
            return response.content

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

        result = _run_tool(persona, response.tool_name, response.args)

        history.append(
            LLMMessage(
                role="tool",
                tool_call_id=response.tool_call_id,
                tool_name=response.tool_name,
                content=json.dumps(result),
            )
        )

    _conversations[key] = history
    return "Sorry, I wasn't able to complete that — could you rephrase?"
