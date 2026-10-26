// The one non-deterministic file. A real LLM decides, from the conversation,
// which tool to call. The agent never authors the outcome sentence — the model
// does, from the real tool result — so the reply reflects a cryptographically
// enforced decision, not a canned string.
//
// Every tool call is made *as the selected persona*, and -- when the UI picks
// a traveler -- on that traveler's behalf. History is keyed by
// (conversationId, personaId, traveler) so one agent's context can never
// silently leak into another's.
import { getProvider } from './providers/index.js';
import { callProtectedTool, type ConsentPrompt } from '../tools/protectedCall.js';
import { TOOLS, USERS, type UserId } from '../../config.js';
import type { Persona } from '../../personas/types.js';
import type { LLMMessage } from './providers/types.js';

const conversations = new Map<string, LLMMessage[]>();

/** The model sees plain business arguments; only these keys are forwarded to each tool. */
const TOOL_ARGS: Record<string, string[]> = {
  [TOOLS.SEARCH]: ['origin', 'destination', 'date'],
  [TOOLS.BOOK]: ['flightId', 'passengerName'],
  [TOOLS.SEARCH_HOTELS]: ['city', 'checkIn'],
  [TOOLS.BOOK_HOTEL]: ['hotelId', 'guestName'],
};

export interface ToolTrace {
  tool: string;
  args: Record<string, unknown>;
  success: boolean;
  code?: string;
  detail: string;
}

export interface ChatTurnInput {
  persona: Persona;
  message: string;
  conversationId: string;
  userId?: UserId;
}

export interface ChatTurnResult {
  reply: string;
  trace: ToolTrace[];
  consentRequired?: ConsentPrompt;
}

export async function runChatTurn({ persona, message, conversationId, userId }: ChatTurnInput): Promise<ChatTurnResult> {
  const key = `${conversationId}::${persona.id}::${userId ?? 'self'}`;
  const history = conversations.get(key) ?? [];
  const context = userId ? `(Context: you are acting on behalf of traveler ${USERS[userId].name}.) ` : '';
  history.push({ role: 'user', content: `${context}${message}` });

  const provider = getProvider();
  const trace: ToolTrace[] = [];
  let consentRequired: ConsentPrompt | undefined;

  for (let i = 0; i < 5; i += 1) {
    const response = await provider.complete(history);

    if (response.type === 'text') {
      history.push({ role: 'assistant', content: response.content });
      conversations.set(key, history);
      return { reply: response.content, trace, ...(consentRequired ? { consentRequired } : {}) };
    }

    // Record the assistant's tool-call turn so the provider history stays valid.
    history.push({
      role: 'assistant',
      content: '',
      toolCallId: response.toolCallId,
      toolName: response.toolName,
      toolArgs: response.args,
      geminiThoughtSignature: response.geminiThoughtSignature,
    });

    const allowed = TOOL_ARGS[response.toolName];
    let toolResult: unknown;
    if (!allowed) {
      toolResult = { error: `Unknown tool: ${response.toolName}` };
    } else {
      const args = Object.fromEntries(
        allowed.filter((name) => response.args[name] !== undefined).map((name) => [name, String(response.args[name])]),
      );
      const result = await callProtectedTool(persona, response.toolName, args, { userId });
      trace.push({ tool: response.toolName, args, success: result.success, code: result.code, detail: result.detail });
      if (result.consentRequired && !consentRequired) consentRequired = result.consentRequired;
      toolResult = { success: result.success, code: result.code, detail: result.detail };
    }

    history.push({
      role: 'tool',
      toolCallId: response.toolCallId,
      toolName: response.toolName,
      content: JSON.stringify(toolResult),
    });
  }

  conversations.set(key, history);
  return {
    reply: "Sorry, I wasn't able to complete that — could you rephrase?",
    trace,
    ...(consentRequired ? { consentRequired } : {}),
  };
}
