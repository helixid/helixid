import { describe, expect, it } from 'vitest';
import {
  extractDate,
  extractSlots,
  mentionsBookingConfirmation,
  nextFlightQuestion,
  nextHotelQuestion,
  nextReturnQuestion,
  resolveTrack,
  summariseProfile,
  type ConversationTrack,
  type TripProfile,
} from '../agent/conversation.js';

const TODAY = new Date('2026-08-03T00:00:00.000Z');

describe('slot extraction', () => {
  it('reads origin and destination from a directional phrase', () => {
    expect(extractSlots('I want to fly from Trivandrum to Delhi', {})).toMatchObject({
      origin: 'TVM',
      destination: 'DEL',
    });
  });

  it('treats a lone city as the answer to whichever question is open', () => {
    expect(extractSlots('Delhi', {})).toMatchObject({ destination: 'DEL' });
    expect(extractSlots('Trivandrum', { destination: 'DEL' })).toMatchObject({
      destination: 'DEL',
      origin: 'TVM',
    });
  });

  it('understands several date forms', () => {
    expect(extractDate('on 2026-08-15')).toBe('2026-08-15');
    expect(extractDate('15 Aug 2026', TODAY)).toBe('2026-08-15');
    expect(extractDate('Aug 15th 2026', TODAY)).toBe('2026-08-15');
    expect(extractDate('tomorrow', TODAY)).toBe('2026-08-04');
  });

  it('reads party size from words, digits, and bare replies', () => {
    expect(extractSlots('2 travellers', {}).travelers).toBe(2);
    expect(extractSlots('three people', {}).travelers).toBe(3);
    expect(extractSlots('just me', {}).travelers).toBe(1);
    expect(extractSlots('4', {}).travelers).toBe(4);
  });

  it('reads airline preference including an explicit no-preference', () => {
    expect(extractSlots('I prefer Helix Air', {}).airlinePreference).toBe('Helix Air');
    expect(extractSlots('no preference', {}).airlinePreference).toBe('any');
  });

  it('reads a hotel budget from tiers and explicit amounts', () => {
    expect(extractSlots('something budget friendly', {}).hotelBudget).toBe(5500);
    expect(extractSlots('around ₹8,000 per night', {}).hotelBudget).toBe(8000);
    expect(extractSlots('no limit', {}).hotelBudget).toBe(0);
  });

  it('routes a date to the return leg without disturbing the outbound one', () => {
    const outbound: TripProfile = { origin: 'TVM', destination: 'DEL', departureDate: '2026-08-15' };
    const after = extractSlots('2026-08-20', outbound, { forReturn: true });
    expect(after.departureDate).toBe('2026-08-15');
    expect(after.returnDate).toBe('2026-08-20');
  });

  it('lets a later mention correct an earlier one', () => {
    const first = extractSlots('a flight to Delhi', {});
    const corrected = extractSlots('actually make it Mumbai', first);
    expect(corrected.destination).toBe('BOM');
  });
});

describe('question ordering', () => {
  it('asks for each missing flight detail in turn, then stops', () => {
    // Answers the agent's own question each round, exactly as the UI's
    // suggestion chips would, and records the order it asked in.
    const answers: Record<string, (p: TripProfile) => void> = {
      destination: (p) => { p.destination = 'DEL'; },
      origin: (p) => { p.origin = 'TVM'; },
      departureDate: (p) => { p.departureDate = '2026-08-15'; },
      travelers: (p) => { p.travelers = 2; },
      airlinePreference: (p) => { p.airlinePreference = 'Helix Air'; },
    };

    const profile: TripProfile = {};
    const asked: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const question = nextFlightQuestion(profile);
      if (!question) break;
      asked.push(question.field);
      answers[question.field]?.(profile);
    }

    expect(asked).toEqual([
      'destination',
      'origin',
      'departureDate',
      'travelers',
      'airlinePreference',
    ]);
    expect(nextFlightQuestion(profile)).toBeNull();
  });

  it('every question offers tappable answers', () => {
    const question = nextFlightQuestion({});
    expect(question?.suggestions.length).toBeGreaterThan(0);
  });

  it('asks only for a budget once the destination is known', () => {
    expect(nextHotelQuestion({ destination: 'DEL' })?.field).toBe('hotelBudget');
    expect(nextHotelQuestion({ destination: 'DEL', hotelBudget: 0 })).toBeNull();
  });

  it('the return leg only needs its own date', () => {
    const booked: TripProfile = {
      origin: 'TVM', destination: 'DEL', departureDate: '2026-08-15',
      travelers: 2, airlinePreference: 'Helix Air',
    };
    expect(nextReturnQuestion(booked)?.field).toBe('returnDate');
    expect(nextReturnQuestion({ ...booked, returnDate: '2026-08-20' })).toBeNull();
  });
});

describe('track resolution', () => {
  it('keeps a bare reply on the leg the agent asked about', () => {
    // The reported loop: "2026-08-09" answering "when would you like to fly
    // back?" names no leg, so only the carried track can place it. Reading the
    // leg from the message alone sent it to the outbound date instead.
    expect(resolveTrack({ message: '2026-08-09', answering: true, track: 'return' })).toBe('return');
    expect(resolveTrack({ message: 'Around ₹8,000', answering: true, track: 'hotel' })).toBe('hotel');
  });

  it('does not inherit a stale leg from an unprompted new request', () => {
    expect(resolveTrack({ message: 'I want to plan a trip', answering: false, track: 'return' })).toBe('flight');
  });

  it('lets the message override the carried leg when it names one', () => {
    expect(resolveTrack({ message: 'Find me a hotel', answering: true, track: 'return' })).toBe('hotel');
    expect(resolveTrack({ message: 'Book my return flight', answering: false, track: 'flight' })).toBe('return');
  });

  it('starts on the outbound leg', () => {
    expect(resolveTrack({ message: 'I want to fly to Delhi', answering: false })).toBe('flight');
  });

  it('lands the return date instead of looping — end to end', () => {
    // Replays the exact transcript that looped: destination, origin, then a
    // bare date answering the return question.
    let track: ConversationTrack = 'return';
    let profile: TripProfile = { destination: 'BOM' };
    const asked: string[] = [];

    for (const reply of ['Thiruvananthapuram', '2026-08-09']) {
      track = resolveTrack({ message: reply, answering: true, track });
      profile = extractSlots(reply, profile, { forReturn: track === 'return' });
      const question = nextReturnQuestion(profile);
      if (question) asked.push(question.field);
    }

    expect(asked).toEqual(['returnDate']);
    expect(profile.returnDate).toBe('2026-08-09');
    expect(nextReturnQuestion(profile)).toBeNull();
  });
});

describe('booking confirmation vs. new search', () => {
  it('treats a named option as a booking, not a search', () => {
    expect(mentionsBookingConfirmation('Yes, book flight HA733')).toBe(true);
    expect(mentionsBookingConfirmation('Yes, book hotel HS-DEL-2')).toBe(true);
    expect(mentionsBookingConfirmation('Book option 2')).toBe(true);
  });

  it('treats an unqualified request as a search, so gathering still runs', () => {
    expect(mentionsBookingConfirmation('Book my return flight')).toBe(false);
    expect(mentionsBookingConfirmation('I want to plan a trip')).toBe(false);
    expect(mentionsBookingConfirmation('Find me a hotel')).toBe(false);
  });
});

describe('trip summary', () => {
  it('reads as a compact recap of what was gathered', () => {
    expect(
      summariseProfile({
        origin: 'TVM', destination: 'DEL', departureDate: '2026-08-15',
        travelers: 2, airlinePreference: 'Helix Air', hotelBudget: 8000,
      }),
    ).toBe('Thiruvananthapuram → Delhi · 2026-08-15 · 2 travellers · Helix Air · ≤ ₹8,000/night');
  });

  it('is empty before anything is known', () => {
    expect(summariseProfile({})).toBe('');
  });
});
