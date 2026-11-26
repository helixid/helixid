// The agent's conversational layer.
//
// A real assistant does not act on the first sentence — it gathers what it
// needs first. This module owns that: it pulls whatever details it can out of
// each message, works out what is still missing, and produces the next
// question. Only when a request is fully specified does the caller run a search.
//
// It is deliberately independent of any LLM. The same slot state drives the
// hosted-model path and the offline path, so the demo asks the same questions
// in the same order whether or not a provider key is configured — which is what
// makes the flow reproducible enough to record.

/** Everything the agent tries to learn before searching. */
export interface TripProfile {
  origin?: string;
  destination?: string;
  departureDate?: string;
  returnDate?: string;
  travelers?: number;
  airlinePreference?: string;
  hotelBudget?: number;
}

export type SlotField =
  | 'destination'
  | 'origin'
  | 'departureDate'
  | 'returnDate'
  | 'travelers'
  | 'airlinePreference'
  | 'hotelBudget';

/** Which leg of the trip the conversation is currently gathering for. */
export type ConversationTrack = 'flight' | 'hotel' | 'return';

export interface SlotQuestion {
  field: SlotField;
  question: string;
  /** Tappable answers, so the demo can be driven without typing. */
  suggestions: string[];
}

const CITY_ALIASES: Array<{ code: string; label: string; match: RegExp }> = [
  { code: 'TVM', label: 'Thiruvananthapuram', match: /\b(tvm|trivandrum|thiruvananthapuram)\b/i },
  { code: 'DEL', label: 'Delhi', match: /\b(del|delhi|new delhi)\b/i },
  { code: 'BOM', label: 'Mumbai', match: /\b(bom|bombay|mumbai)\b/i },
];

export function cityLabel(code: string | undefined): string {
  return CITY_ALIASES.find((c) => c.code === code)?.label ?? code ?? '';
}

function cityIn(text: string): string | undefined {
  return CITY_ALIASES.find((c) => c.match.test(text))?.code;
}

/** Pulls `from X to Y` / `X to Y` when both endpoints appear in one phrase. */
/**
 * Scans every `to …` / `from …` phrase and keeps the first that names a city
 * we know. Taking only the first match would break on ordinary sentences like
 * "I want **to** fly from Trivandrum to Delhi", where the leading "to" belongs
 * to the verb rather than the destination.
 */
const PHRASE_BOUNDARY = new Set([
  'to', 'from', 'on', 'for', 'next', 'this', 'in', 'at', 'with', 'and',
  'departing', 'leaving', 'returning', 'flying',
]);

function firstCityAfter(text: string, preposition: 'to' | 'from'): string | undefined {
  // Capture at most three words. An unbounded capture would swallow the rest
  // of the sentence, leaving no later "to …" phrase for matchAll to find.
  const pattern = new RegExp(`\\b${preposition}\\s+([a-z]+(?:\\s+[a-z]+){0,2})`, 'gi');
  for (const match of text.matchAll(pattern)) {
    if (!match[1]) continue;
    // Stop at the next preposition, so "to fly from Trivandrum" does not read
    // Trivandrum as the destination.
    const words: string[] = [];
    for (const word of match[1].split(/\s+/)) {
      if (PHRASE_BOUNDARY.has(word.toLowerCase())) break;
      words.push(word);
    }
    const code = cityIn(words.join(' '));
    if (code) return code;
  }
  return undefined;
}

function directionalCities(text: string): { origin?: string; destination?: string } {
  const out: { origin?: string; destination?: string } = {};
  const originCode = firstCityAfter(text, 'from');
  const destCode = firstCityAfter(text, 'to');
  if (originCode) out.origin = originCode;
  // "from X to Y" must not resolve both endpoints to the same city.
  if (destCode && destCode !== originCode) out.destination = destCode;
  return out;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Understands `2026-08-15`, `15 Aug`, `Aug 15`, `tomorrow`, `next friday`. */
export function extractDate(text: string, today = new Date()): string | undefined {
  const explicit = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (explicit?.[1]) return explicit[1];

  const lower = text.toLowerCase();
  if (/\btomorrow\b/.test(lower)) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() + 1);
    return isoDate(d);
  }
  const weekday = lower.match(/\bnext\s+(sun|mon|tue|wed|thu|fri|sat)/);
  if (weekday?.[1]) {
    const target = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(weekday[1]);
    const d = new Date(today);
    const delta = ((target - d.getUTCDay() + 7) % 7) || 7;
    d.setUTCDate(d.getUTCDate() + delta);
    return isoDate(d);
  }

  // "15 Aug" / "Aug 15" / "August 15th", optionally with a year.
  const dayFirst = lower.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\b/);
  const monthFirst = lower.match(/\b([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  const parts = dayFirst
    ? { day: Number(dayFirst[1]), month: dayFirst[2] }
    : monthFirst
      ? { day: Number(monthFirst[2]), month: monthFirst[1] }
      : null;
  if (parts?.month) {
    const monthIndex = MONTHS.indexOf(parts.month.slice(0, 3));
    if (monthIndex >= 0 && parts.day >= 1 && parts.day <= 31) {
      const year = Number(lower.match(/\b(20\d{2})\b/)?.[1] ?? today.getUTCFullYear());
      const candidate = new Date(Date.UTC(year, monthIndex, parts.day));
      // A bare month/day that has already passed means next year.
      if (candidate.getTime() < Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) {
        candidate.setUTCFullYear(year + 1);
      }
      return isoDate(candidate);
    }
  }
  return undefined;
}

function extractTravelers(text: string): number | undefined {
  const lower = text.toLowerCase();
  if (/\b(just me|solo|myself|only me|alone)\b/.test(lower)) return 1;
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  const word = lower.match(/\b(one|two|three|four|five|six)\b\s*(?:people|persons?|travell?ers?|adults?|of us|passengers?)?/);
  if (word?.[1] && (/(people|persons?|travell?ers?|adults?|of us|passengers?)/.test(lower) || /^\s*(one|two|three|four|five|six)\s*$/.test(lower))) {
    return words[word[1]];
  }
  const digits = lower.match(/\b(\d{1,2})\s*(?:people|persons?|travell?ers?|adults?|guests?|passengers?|of us)\b/);
  if (digits?.[1]) return Number(digits[1]);
  // A bare number in reply to "how many travellers?".
  const bare = lower.trim().match(/^(\d{1,2})$/);
  if (bare?.[1]) return Number(bare[1]);
  return undefined;
}

function extractAirline(text: string): string | undefined {
  const lower = text.toLowerCase();
  if (/\b(no preference|any airline|any carrier|doesn'?t matter|no pref|any)\b/.test(lower)) return 'any';
  if (/\bhelix\s*air\b/.test(lower)) return 'Helix Air';
  if (/\bskyline\b/.test(lower)) return 'Skyline';
  return undefined;
}

function extractBudget(text: string): number | undefined {
  const lower = text.toLowerCase();
  if (/\b(no budget|any budget|no limit|doesn'?t matter)\b/.test(lower)) return 0;
  if (/\b(luxury|premium|best available)\b/.test(lower)) return 12000;
  if (/\b(mid|moderate|standard|mid-range)\b/.test(lower)) return 8000;
  if (/\b(budget|cheap|economical|affordable)\b/.test(lower)) return 5500;
  // The currency marker is required, not optional: an optional prefix here
  // used to match *any* bare 3+ digit run in the message, including the
  // year in an already-answered ISO travel date (e.g. "2026-10-15" reads as
  // "₹2026/night"), silently hijacking hotelBudget before the budget
  // question was ever asked.
  const amount = lower.match(/(?:₹|rs\.?|inr)\s*(\d[\d,]{2,})\s*(?:per night|a night|\/night|nightly)?/);
  if (amount?.[1]) {
    const value = Number(amount[1].replace(/,/g, ''));
    if (value >= 1000) return value;
  }
  return undefined;
}

/**
 * Folds anything the message reveals into the running profile. Later mentions
 * win, so a user can correct themselves mid-conversation.
 */
export function extractSlots(
  message: string,
  profile: TripProfile,
  options: { forReturn?: boolean } = {},
): TripProfile {
  const next: TripProfile = { ...profile };
  const text = message.trim();

  const directional = directionalCities(text);
  if (directional.origin) next.origin = directional.origin;
  if (directional.destination) next.destination = directional.destination;

  // A lone city name answers whichever city question is outstanding — unless
  // the user is visibly correcting themselves, in which case it replaces the
  // destination they already gave.
  if (!directional.origin && !directional.destination) {
    const single = cityIn(text);
    const correcting = /\b(actually|instead|change (?:it )?to|make it|rather|no,)\b/i.test(text);
    if (single) {
      if (correcting) next.destination = single;
      else if (!next.destination) next.destination = single;
      else if (!next.origin && single !== next.destination) next.origin = single;
      else next.destination = single;
    }
  }

  const date = extractDate(text);
  // While planning the way home, a date the user gives is the return date —
  // it must not overwrite the outbound leg they already chose.
  if (date) {
    if (options.forReturn) next.returnDate = date;
    else next.departureDate = date;
  }

  const travelers = extractTravelers(text);
  if (travelers) next.travelers = travelers;

  const airline = extractAirline(text);
  if (airline) next.airlinePreference = airline;

  const budget = extractBudget(text);
  if (budget !== undefined) next.hotelBudget = budget;

  return next;
}

/** The next thing the agent still needs before it can search for flights. */
export function nextFlightQuestion(profile: TripProfile): SlotQuestion | null {
  if (!profile.destination) {
    return {
      field: 'destination',
      question: 'Happy to help you plan this trip. Where would you like to fly to?',
      suggestions: ['Delhi', 'Mumbai'],
    };
  }
  if (!profile.origin) {
    return {
      field: 'origin',
      question: `Great — ${cityLabel(profile.destination)} it is. Which city are you flying from?`,
      suggestions: ['Thiruvananthapuram'],
    };
  }
  if (!profile.departureDate) {
    return {
      field: 'departureDate',
      question: 'What date would you like to travel?',
      suggestions: [nextMonthDay(14), nextMonthDay(21)],
    };
  }
  if (!profile.travelers) {
    return {
      field: 'travelers',
      question: 'How many travellers are going?',
      suggestions: ['Just me', '2 travellers', '3 travellers'],
    };
  }
  if (!profile.airlinePreference) {
    return {
      field: 'airlinePreference',
      question: 'Do you have an airline preference? We fly Helix Air and Skyline on this route.',
      suggestions: ['Helix Air', 'Skyline', 'No preference'],
    };
  }
  return null;
}

/** The next thing the agent still needs before it can search for hotels. */
export function nextHotelQuestion(profile: TripProfile): SlotQuestion | null {
  if (!profile.destination) {
    return {
      field: 'destination',
      question: 'Which city should I look for hotels in?',
      suggestions: ['Delhi', 'Mumbai'],
    };
  }
  if (profile.hotelBudget === undefined) {
    return {
      field: 'hotelBudget',
      question: `What is your nightly budget for ${cityLabel(profile.destination)}?`,
      suggestions: ['Under ₹5,500', 'Around ₹8,000', 'No limit'],
    };
  }
  return null;
}

/** The return leg reuses the outbound details and only needs its own date. */
export function nextReturnQuestion(profile: TripProfile): SlotQuestion | null {
  if (!profile.origin || !profile.destination) return nextFlightQuestion(profile);
  if (!profile.returnDate) {
    const base = profile.departureDate ? new Date(profile.departureDate) : new Date();
    base.setUTCDate(base.getUTCDate() + 5);
    const suggested = isoDate(base);
    return {
      // Naming this 'departureDate' — the outbound field — is what let a reply
      // to this question be filed against the wrong leg. It gathers the return
      // date, so it says so.
      field: 'returnDate',
      question: `When would you like to fly back to ${cityLabel(profile.origin)}?`,
      suggestions: [suggested],
    };
  }
  return null;
}

function nextMonthDay(daysAhead: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  return isoDate(d);
}

/** One-line recap of what the agent has gathered, for the UI's trip chip. */
export function summariseProfile(profile: TripProfile): string {
  const bits: string[] = [];
  if (profile.origin && profile.destination) {
    bits.push(`${cityLabel(profile.origin)} → ${cityLabel(profile.destination)}`);
  } else if (profile.destination) {
    bits.push(`to ${cityLabel(profile.destination)}`);
  }
  if (profile.departureDate) bits.push(profile.departureDate);
  if (profile.travelers) bits.push(`${profile.travelers} traveller${profile.travelers > 1 ? 's' : ''}`);
  if (profile.airlinePreference && profile.airlinePreference !== 'any') bits.push(profile.airlinePreference);
  if (profile.hotelBudget) bits.push(`≤ ₹${profile.hotelBudget.toLocaleString('en-IN')}/night`);
  return bits.join(' · ');
}

/** True when the message is asking about hotels rather than flights. */
export function mentionsHotel(message: string): boolean {
  return /\b(hotel|stay|accommodation|room|lodging)\b/i.test(message);
}

export function mentionsFlight(message: string): boolean {
  return /\b(flight|fly|flights|airline|air)\b/i.test(message);
}

/**
 * Opening a trip-planning conversation. Kept separate from mentionsFlight so
 * "plan a trip" starts the gathering flow without pretending the user named a
 * flight.
 */
export function mentionsTripPlanning(message: string): boolean {
  return /\b(trip|travel|travelling|traveling|journey|vacation|holiday|getaway|plan)\b/i.test(message);
}

export function mentionsReturn(message: string): boolean {
  return /\b(return|back home|coming back|way back)\b/i.test(message);
}

/**
 * Works out which leg the conversation is gathering for.
 *
 * This has to be resolved before any slot is read, because a bare reply like
 * "2026-08-09" carries nothing that says which leg it belongs to. The only
 * thing that can place it is the question the agent just asked, which is what
 * `track` carries forward. Reading the leg from the message alone files every
 * answer to "when would you like to fly back?" as the *outbound* date — so the
 * return date never lands, and the agent asks the same question forever.
 */
export function resolveTrack(input: {
  message: string;
  answering: boolean;
  track?: ConversationTrack;
}): ConversationTrack {
  if (mentionsHotel(input.message)) return 'hotel';
  if (mentionsReturn(input.message)) return 'return';
  // Only a direct reply stays on the previous leg. An unprompted new request
  // starts a fresh outbound search instead of inheriting a stale track, which
  // would otherwise reverse the route long after the return leg was booked.
  if (input.answering && input.track) return input.track;
  return 'flight';
}

/**
 * A confirmation of a specific already-offered option, e.g. "book flight
 * HA733" or "book option 2".
 *
 * This has to be distinguishable from a request to search. "Book my return
 * flight" starts a new gathering conversation, while "Yes, book flight HA733"
 * must go straight to the booking path — both contain the word "flight", so
 * naming a concrete option is what separates them.
 */
export function mentionsBookingConfirmation(message: string): boolean {
  if (!/\b(book|reserve|confirm|select|take)\b/i.test(message)) return false;
  return (
    /\b[A-Z]{2}\d{3}\b/.test(message) ||
    /\bHS-[A-Z]+-\d+\b/i.test(message) ||
    /\boption\s*\d+\b/i.test(message)
  );
}
