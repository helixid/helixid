// The one non-deterministic file. A real LLM decides, from the conversation,
// which tool to call. The agent never authors the outcome sentence — the model
// does, from the real tool result — so the reply reflects a cryptographically
// enforced decision, not a canned string.
//
// Every tool call is made *as the selected persona*: its own key signs the request proof.
// History is keyed by (conversationId, personaId) so one agent's context can
// never silently leak into another's.
import { getProvider } from './providers/index.js';
import { bookFlight } from '../tools/bookFlight.js';
import { searchFlights } from '../tools/searchFlights.js';
import { TOOLS } from '../../config.js';
import type { Persona } from '../../personas/types.js';
import type { LLMMessage } from './providers/types.js';

const conversations = new Map<string, LLMMessage[]>();

const TOOL_IMPLS: Record<string, (persona: Persona, args: Record<string, unknown>) => Promise<unknown>> = {
  [TOOLS.BOOK]: (persona, args) =>
    bookFlight(persona, {
      flightId: String(args.flightId ?? ''),
      passengerName: String(args.passengerName ?? ''),
    }),
  [TOOLS.SEARCH]: (persona, args) =>
    searchFlights(persona, {
      origin: String(args.origin ?? ''),
      destination: String(args.destination ?? ''),
      date: args.date ? String(args.date) : undefined,
    }),
};

export interface ChatTurnInput {
  persona: Persona;
  message: string;
  conversationId: string;
}

export async function runChatTurn({ persona, message, conversationId }: ChatTurnInput): Promise<string> {
  const key = `${conversationId}::${persona.id}`;
  const history = conversations.get(key) ?? [];
  history.push({ role: 'user', content: message });

  const provider = getProvider();

  for (let i = 0; i < 4; i += 1) {
    const response = await provider.complete(history);

    if (response.type === 'text') {
      history.push({ role: 'assistant', content: response.content });
      conversations.set(key, history);
      return response.content;
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

    const impl = TOOL_IMPLS[response.toolName];
    const result = impl
      ? await impl(persona, response.args)
      : { error: `Unknown tool: ${response.toolName}` };

    history.push({
      role: 'tool',
      toolCallId: response.toolCallId,
      toolName: response.toolName,
      content: JSON.stringify(result),
    });
  }

  conversations.set(key, history);
  return "Sorry, I wasn't able to complete that — could you rephrase?";
}
