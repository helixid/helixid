# The Travel Planner chat surface. Python port of agent/web.ts -- the same
# markup/CSS/client JS (all browser-side, calling only the /api/* routes this
# agent's server.py reimplements with identical shapes), emitted from Python
# instead of a JS template literal.
#
# KYA-OS story L3-H: the consent page is Helix's (the challenge's signed
# authorizationUrl). The page opens it, then waits on POST
# /api/consent/complete while the agent polls for the root hop the user's
# did:key signed; no message crosses windows.

from __future__ import annotations

_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Travel Planner — HelixID</title>
<style>
  :root{
    color-scheme:dark;
    --bg:#0b0e14; --surface:#121722; --surface-2:#161c29; --raised:#1b2334;
    --border:#232c3d; --border-soft:#1b2233;
    --text:#e6e9ef; --muted:#8b95a8; --dim:#5f6a7d;
    --accent:#4f7cff; --accent-2:#7c5cff;
    --ok:#3fb950; --ok-dim:#1f6f33; --warn:#d29922; --danger:#f85149;
    --radius:14px;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{
    background:var(--bg); color:var(--text); min-height:100vh;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  button{font:inherit;cursor:pointer;border:0;background:none;color:inherit}
  .hidden{display:none!important}

  /* ── Login ─────────────────────────────────────────────── */
  .login-wrap{position:fixed;inset:0;z-index:20;display:grid;place-items:center;
    background:radial-gradient(1200px 600px at 50% -10%,#17223a 0%,var(--bg) 60%)}
  .login{width:min(400px,92vw);background:var(--surface);border:1px solid var(--border);
    border-radius:18px;padding:32px;box-shadow:0 24px 70px #0009}
  .mark{width:44px;height:44px;border-radius:13px;display:grid;place-items:center;
    background:linear-gradient(135deg,var(--accent),var(--accent-2));font-weight:800;font-size:18px}
  .login h1{font-size:20px;margin:18px 0 6px;letter-spacing:-.01em}
  .login p{color:var(--muted);font-size:13px;margin-bottom:22px;line-height:1.5}
  .field{margin-bottom:12px}
  .field label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.07em;
    color:var(--dim);margin-bottom:6px;font-weight:600}
  input{width:100%;padding:11px 13px;border-radius:10px;border:1px solid var(--border);
    background:var(--bg);color:var(--text);font:inherit;outline:none;transition:border-color .15s}
  input:focus{border-color:var(--accent)}
  .btn-primary{width:100%;padding:12px;border-radius:10px;font-weight:650;
    background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;margin-top:6px;
    transition:opacity .15s}
  .btn-primary:hover{opacity:.9}
  .btn-primary:disabled{opacity:.45;cursor:not-allowed}
  .err{color:var(--danger);font-size:12.5px;margin-top:12px;min-height:16px}

  /* ── Shell ─────────────────────────────────────────────── */
  .app{display:grid;grid-template-columns:1fr 320px;height:100vh;max-width:1240px;margin:0 auto}
  .chat{display:flex;flex-direction:column;min-width:0;border-right:1px solid var(--border-soft)}

  .head{display:flex;align-items:center;gap:12px;padding:16px 22px;border-bottom:1px solid var(--border-soft)}
  .head .mark{width:36px;height:36px;border-radius:11px;font-size:15px}
  .head h1{font-size:15px;font-weight:650;letter-spacing:-.01em}
  .head .sub{font-size:12px;color:var(--muted);margin-top:2px}
  .badge{display:flex;align-items:center;gap:6px;font-size:11.5px;
    color:var(--muted);background:var(--surface-2);border:1px solid var(--border);
    padding:5px 10px;border-radius:99px;white-space:nowrap}
  .dot{width:6px;height:6px;border-radius:50%;background:var(--ok)}
  .dot.warn{background:var(--warn)}

  .log{flex:1;overflow-y:auto;padding:24px 22px;display:flex;flex-direction:column;gap:16px;scroll-behavior:smooth}
  .turn{display:flex;gap:11px;max-width:92%}
  .turn.user{align-self:flex-end;flex-direction:row-reverse}
  .av{width:28px;height:28px;border-radius:9px;flex:0 0 28px;display:grid;place-items:center;
    font-size:11px;font-weight:700;margin-top:2px}
  .av.bot{background:linear-gradient(135deg,var(--accent),var(--accent-2))}
  .av.user{background:var(--raised);color:var(--muted);border:1px solid var(--border)}
  .bubble{background:var(--surface);border:1px solid var(--border-soft);border-radius:var(--radius);
    padding:12px 15px;font-size:14px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
  .turn.user .bubble{background:rgba(79,124,255,.13);border-color:rgba(79,124,255,.3)}
  .thinking{display:flex;gap:4px;align-items:center;padding:13px 15px}
  .thinking i{width:5px;height:5px;border-radius:50%;background:var(--dim);animation:blink 1.3s infinite}
  .thinking i:nth-child(2){animation-delay:.18s} .thinking i:nth-child(3){animation-delay:.36s}
  @keyframes blink{0%,80%,100%{opacity:.25}40%{opacity:1}}

  /* ── Result cards ──────────────────────────────────────── */
  .stack{display:flex;flex-direction:column;gap:9px;margin-top:11px}
  .opt{display:flex;align-items:center;gap:13px;background:var(--surface-2);
    border:1px solid var(--border);border-radius:12px;padding:12px 14px;transition:border-color .15s}
  .opt:hover{border-color:#33405a}
  .opt .idx{width:22px;height:22px;border-radius:7px;background:var(--raised);color:var(--muted);
    display:grid;place-items:center;font-size:11px;font-weight:700;flex:0 0 22px}
  .opt .body{flex:1;min-width:0}
  .opt .t{font-size:13.5px;font-weight:600}
  .opt .m{font-size:12px;color:var(--muted);margin-top:2px}
  .opt .price{font-size:13px;font-weight:700;white-space:nowrap;margin-right:2px}
  .opt .cta{padding:7px 13px;border-radius:9px;background:var(--raised);border:1px solid var(--border);
    font-size:12.5px;font-weight:600;white-space:nowrap;transition:background .15s}
  .opt .cta:hover{background:#26314a}
  .answers{display:flex;flex-wrap:wrap;gap:7px;margin-top:11px}
  .answer{font-size:12.5px;padding:7px 13px;border-radius:99px;background:var(--raised);
    border:1px solid var(--border);font-weight:550;transition:all .15s}
  .answer:hover{border-color:var(--accent);background:#26314a}
  .trip{margin-left:auto;display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--muted);
    background:var(--surface-2);border:1px solid var(--border);padding:5px 11px;border-radius:99px;
    max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

  .receipt{margin-top:11px;border:1px solid rgba(63,185,80,.32);background:rgba(63,185,80,.07);
    border-radius:12px;padding:14px}
  .receipt .r1{display:flex;align-items:center;gap:9px}
  .receipt .tick{width:20px;height:20px;border-radius:50%;background:var(--ok);color:#0b0e14;
    display:grid;place-items:center;font-size:12px;font-weight:800;flex:0 0 20px}
  .receipt .code{font-size:15px;font-weight:700;letter-spacing:.02em}
  .receipt .note{font-size:12px;color:var(--muted);margin-top:8px;line-height:1.5}
  .receipt .auth{display:inline-flex;align-items:center;gap:5px;margin-top:9px;font-size:11px;
    padding:4px 9px;border-radius:99px;background:rgba(63,185,80,.13);color:#7ee08a;font-weight:600}

  .consent{margin-top:11px;border:1px solid rgba(210,153,34,.35);background:rgba(210,153,34,.06);
    border-radius:12px;padding:14px}
  .consent .r1{display:flex;align-items:center;gap:10px}
  .consent .sp{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;
    font-size:11px;font-weight:800;background:var(--raised);border:1px solid var(--border);flex:0 0 30px}
  .consent .t{font-size:13.5px;font-weight:650}
  .consent .m{font-size:12px;color:var(--muted);margin-top:2px;line-height:1.5}
  .consent .cta{margin-top:12px;width:100%;padding:10px;border-radius:9px;font-weight:650;font-size:13px;
    background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff}

  /* ── Composer ──────────────────────────────────────────── */
  .composer{border-top:1px solid var(--border-soft);padding:14px 22px 18px}
  .chips{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:10px}
  .chip{font-size:12px;padding:6px 11px;border-radius:99px;background:var(--surface-2);
    border:1px solid var(--border);color:var(--muted);transition:all .15s}
  .chip:hover{color:var(--text);border-color:#33405a}
  .composer form{display:flex;gap:9px}
  .composer input{flex:1}
  .send{padding:0 18px;border-radius:10px;font-weight:650;
    background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff}
  .send:disabled{opacity:.4;cursor:not-allowed}

  /* ── Trust rail ────────────────────────────────────────── */
  .rail{background:var(--surface);overflow-y:auto;padding:20px 18px;display:flex;flex-direction:column;gap:20px}
  .rail h2{font-size:10.5px;text-transform:uppercase;letter-spacing:.09em;color:var(--dim);
    font-weight:700;margin-bottom:11px}
  .idcard{background:var(--surface-2);border:1px solid var(--border);border-radius:12px;padding:13px}
  .idrow+.idrow{margin-top:11px;padding-top:11px;border-top:1px solid var(--border-soft)}
  .idrow .k{font-size:11px;color:var(--dim);margin-bottom:3px}
  .idrow .v{font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    word-break:break-all;line-height:1.45;color:#c9d2e3}
  .sprow{background:var(--surface-2);border:1px solid var(--border);border-radius:12px;
    padding:13px;margin-bottom:9px}
  .sprow .top{display:flex;align-items:center;gap:9px}
  .sprow .nm{font-size:13px;font-weight:640;flex:1}
  .pill{font-size:10.5px;font-weight:700;padding:3px 8px;border-radius:99px;letter-spacing:.02em}
  .pill.on{background:rgba(63,185,80,.15);color:#7ee08a}
  .pill.off{background:var(--raised);color:var(--dim)}
  .scopes{display:flex;flex-wrap:wrap;gap:5px;margin-top:10px}
  .scope{font-size:10.5px;font-family:ui-monospace,Menlo,monospace;padding:3px 7px;border-radius:6px;
    background:var(--raised);color:#9fb0cc;border:1px solid var(--border)}
  .dur{font-size:11px;color:var(--dim);margin-top:8px}
  .foot{margin-top:auto;font-size:11px;color:var(--dim);line-height:1.6;padding-top:14px;
    border-top:1px solid var(--border-soft)}

  @media(max-width:900px){
    .app{grid-template-columns:1fr}
    .rail{display:none}
  }
</style>
</head>
<body>

<div class="login-wrap" id="loginWrap">
  <form class="login" id="login">
    <div class="mark">H</div>
    <h1>Travel Planner</h1>
    <p>Sign in to the demo agent. It will act on your behalf, but only within the permissions you explicitly grant.</p>
    <div class="field"><label for="username">Username</label><input id="username" value="traveler" autocomplete="username" /></div>
    <div class="field"><label for="password">Password</label><input id="password" type="password" value="demo123" autocomplete="current-password" /></div>
    <button class="btn-primary" type="submit">Sign in</button>
    <div class="err" id="loginError"></div>
  </form>
</div>

<div class="app hidden" id="app">
  <main class="chat">
    <header class="head">
      <div class="mark">H</div>
      <div>
        <h1>Travel Planner Agent</h1>
        <div class="sub" id="identity">HelixID consent demo</div>
      </div>
      <span class="trip hidden" id="tripChip"></span>
      <span class="badge" id="plannerBadge"><span class="dot"></span><span id="plannerText">Connecting</span></span>
    </header>

    <div class="log" id="log"></div>

    <div class="composer">
      <div class="chips" id="chips"></div>
      <form id="chat">
        <input id="message" autocomplete="off" placeholder="Ask for a flight or a hotel…" />
        <button class="send" type="submit">Send</button>
      </form>
    </div>
  </main>

  <aside class="rail">
    <section>
      <h2>Identity</h2>
      <div class="idcard">
        <div class="idrow"><div class="k">Agent DID</div><div class="v" id="agentDid">—</div></div>
        <div class="idrow"><div class="k">Acting for</div><div class="v" id="userDid">—</div></div>
      </div>
    </section>
    <section>
      <h2>Service permissions</h2>
      <div id="sps"></div>
    </section>
    <div class="foot">
      Each permission is a <strong>DelegationCredential</strong> (the root hop of
      the agent's chain) signed by your own did:key on Helix's consent page, one
      per Service Provider. Verification intersects it with the agent's own
      credential, so your consent can never widen what the agent may do.
    </div>
  </aside>
</div>

<script>
const log = document.getElementById('log');
const input = document.getElementById('message');
const sendBtn = document.querySelector('.send');

let pending = null;
let flightOptions = [], hotelOptions = [];
let lastFlight = null, lastHotel = null, itinerary = null;
// Conversation state: whether the last agent turn was a question, and which
// search the gathering currently belongs to.
let awaitingAnswer = false, currentTrack = 'flight';

function showTrip(summary) {
  const el = document.getElementById('tripChip');
  if (!el) return;
  el.textContent = summary || '';
  el.classList.toggle('hidden', !summary);
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? {} : await res.json();
  // data.error is usually { message } (see server.ts's error responses),
  // but a couple of routes still send a bare string -- handle both so a
  // non-2xx never surfaces as the unhelpful "[object Object]".
  if (!res.ok) throw new Error((data.error && data.error.message) || data.error || 'Request failed');
  return data;
}

function turn(kind, html) {
  const el = document.createElement('div');
  el.className = 'turn ' + kind;
  el.innerHTML =
    '<div class="av ' + kind + '">' + (kind === 'bot' ? 'H' : 'You') + '</div>' +
    '<div class="bubble">' + html + '</div>';
  log.append(el);
  log.scrollTop = log.scrollHeight;
  return el;
}
const say = (text, extra) => turn('bot', esc(text) + (extra || ''));
const said = (text) => turn('user', esc(text));

function thinking() {
  const el = document.createElement('div');
  el.className = 'turn bot';
  el.innerHTML = '<div class="av bot">H</div><div class="bubble thinking"><i></i><i></i><i></i></div>';
  log.append(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

function optionList(items) {
  return '<div class="stack">' + items.map((it, i) =>
    '<div class="opt">' +
      '<div class="idx">' + (i + 1) + '</div>' +
      '<div class="body"><div class="t">' + esc(it.title) + '</div><div class="m">' + esc(it.meta) + '</div></div>' +
      (it.price ? '<div class="price">' + esc(it.price) + '</div>' : '') +
      '<button class="cta" data-action="' + esc(it.action) + '">Select</button>' +
    '</div>').join('') + '</div>';
}

const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
const duration = (m) => Math.floor((m || 0) / 60) + 'h ' + ((m || 0) % 60) + 'm';

function renderFlights(data, returnTrip) {
  const flights = data.flights || [], q = data.query || {};
  flightOptions = flights;
  lastFlight = flights[0] || null;
  if (!flights.length) {
    say('I could not find any flights from ' + (q.origin || 'that origin') + ' to ' +
        (q.destination || 'that destination') + (q.departureDate ? ' on ' + q.departureDate : '') +
        '. Would you like to try another date?');
    return;
  }
  if (!returnTrip && lastFlight) {
    itinerary = { origin: lastFlight.origin, destination: lastFlight.destination, departureDate: lastFlight.departureDate };
  }
  const who = q.travelers > 1 ? ' for ' + q.travelers + ' travellers' : '';
  say('I found ' + flights.length + (returnTrip ? ' return option' : ' option') +
      (flights.length > 1 ? 's' : '') + ' from ' + lastFlight.origin + ' to ' +
      lastFlight.destination + ' on ' + lastFlight.departureDate + who +
      '. Which one would you like?',
    optionList(flights.map((f) => ({
      title: f.carrier + ' ' + f.flightId,
      meta: f.departs + ' → ' + f.arrives + ' · ' + duration(f.durationMinutes) + ' · ' +
            (f.stops ? f.stops + ' stop' : 'Non-stop'),
      price: money(f.totalFare || f.fare) + (q.travelers > 1 ? ' total' : ''),
      action: 'book-flight:' + f.flightId,
    }))));
}

function renderHotels(data) {
  const hotels = data.hotels || [], q = data.query || {};
  hotelOptions = hotels;
  lastHotel = hotels[0] || null;
  if (!hotels.length) { say('I could not find hotels matching that. Shall I widen the budget?'); return; }
  const cap = q.maxNightlyRate ? ' under ' + money(q.maxNightlyRate) + ' a night' : '';
  say('Here ' + (hotels.length > 1 ? 'are' : 'is') + ' ' + hotels.length + ' stay' +
      (hotels.length > 1 ? 's' : '') + ' in ' + lastHotel.city + cap + '. Which would you prefer?',
    optionList(hotels.map((h) => ({
      title: h.name,
      meta: '★ ' + h.rating + ' · ' + h.area + ' · ' + (h.amenities || []).slice(0, 2).join(', '),
      price: money(h.nightlyRate) + '/night',
      action: 'book-hotel:' + h.hotelId,
    }))));
}

/** Renders a follow-up question with tappable answers. */
function renderAsk(plan) {
  const chips = (plan.suggestions || []).length
    ? '<div class="answers">' + plan.suggestions.map((s) =>
        '<button class="answer" data-answer="' + esc(s) + '">' + esc(s) + '</button>').join('') + '</div>'
    : '';
  say(plan.message, chips);
}

function renderBooking(sp, data, source) {
  const reused = source === 'standing_grant';
  say(sp === 'airline' ? 'Your flight is confirmed.' : 'Your hotel is confirmed.',
    '<div class="receipt">' +
      '<div class="r1"><div class="tick">✓</div><div class="code">' +
        (sp === 'airline' ? 'PNR ' : 'Booking ') + esc(data.bookingId) + '</div></div>' +
      '<div class="note">' + esc(data.status) + ' · ' +
        esc(sp === 'airline' ? data.flightId : data.hotelId) + '</div>' +
      '<div class="auth">' + (reused
        ? '↻ Reused your standing permission — no new consent needed'
        : '✓ Authorized with the permission you just granted') + '</div>' +
    '</div>');
}

function renderConsent(result, call) {
  pending = { ...call, consentUrl: result.consentUrl, pendingId: result.pendingId };
  const name = result.sp === 'airline' ? 'Helix Air' : 'Helix Stay';
  say('I need your permission first.',
    '<div class="consent">' +
      '<div class="r1"><div class="sp">' + (result.sp === 'airline' ? 'HA' : 'HS') + '</div>' +
      '<div><div class="t">' + esc(name) + '</div>' +
      '<div class="m">Review exactly what this agent may do at ' + esc(name) + ' on your behalf. Approving signs it with a key that is yours at ' + esc(name) + ' only.</div></div></div>' +
      '<button class="cta" data-action="consent">Review permissions</button>' +
    '</div>');
}

// KYA-OS story L3-H: the consent page is Helix's (the challenge's signed
// authorizationUrl). The agent waits for the user's decision there and retries
// with the root hop the user's did:key signed; no message crosses windows.
async function openConsent() {
  if (!pending) return;
  const call = pending;
  pending = null;
  window.open(call.consentUrl, 'helixid-consent', 'popup,width=560,height=760');
  try {
    const result = await api('/api/consent/complete', { pendingId: call.pendingId });
    if (result.status === 'declined') { say('Permission was declined, so I did not make the booking.'); return; }
    if (result.status !== 'ok') throw new Error((result.error && result.error.message) || 'Call failed');
    renderBooking(call.sp, result.data, 'fresh_consent');
    refreshTrust();
  } catch (err) { say('I could not complete that after your approval: ' + err.message); }
}

async function refreshTrust() {
  try {
    const s = await api('/api/state');
    document.getElementById('agentDid').textContent = s.agentDid;
    document.getElementById('userDid').textContent = s.serviceUser;
    document.getElementById('sps').innerHTML = (s.grants || []).map((g) =>
      '<div class="sprow">' +
        '<div class="top"><div class="nm">' + esc(g.displayName) + '</div>' +
        '<span class="pill ' + (g.hasGrant ? 'on' : 'off') + '">' +
          (g.hasGrant ? 'Authorized' : 'No permission') + '</span></div>' +
        (g.scopes && g.scopes.length
          ? '<div class="scopes">' + g.scopes.map((sc) => '<span class="scope">' + esc(sc) + '</span>').join('') + '</div>'
          : '') +
        (g.windowUntil ? '<div class="dur">Consented until ' + esc(new Date(g.windowUntil).toLocaleDateString()) + '</div>' : '') +
        (g.userDid ? '<div class="dur" title="Your pairwise key at this service">Signed by ' + esc(g.userDid.slice(0, 20)) + '…</div>' : '') +
      '</div>').join('');
  } catch { /* rail is informational; never block the chat on it */ }
}

async function runCall(call) {
  const result = await api('/api/call', {
    sp: call.sp, tool: call.tool, args: call.args,
    ...(call.authorizationSource ? { authorizationSource: call.authorizationSource } : {}),
  });
  if (result.status === 'consent_required') { renderConsent(result, call); return; }
  if (result.status !== 'ok') throw new Error((result.error && result.error.message) || 'Call failed');

  if (call.tool === 'search_flights') renderFlights(result.data, call.args.origin === 'DEL' || call.args.origin === 'BOM');
  else if (call.tool === 'search_hotels') renderHotels(result.data);
  else { renderBooking(call.sp, result.data, result.authorizationSource); refreshTrust(); }
}

async function handle(text, opts) {
  said(text);
  const wait = thinking();
  sendBtn.disabled = true;
  try {
    const plan = await api('/api/plan', {
      // The answering flag tells the server this is a reply to its own
      // question, so a bare "2 travellers" continues the current search
      // rather than being treated as a brand-new request.
      answering: (opts && opts.answering) || awaitingAnswer,
      track: currentTrack,
      message: text,
      context: {
        ...(lastFlight ? { selectedFlight: { flightId: lastFlight.flightId, origin: lastFlight.origin, destination: lastFlight.destination } } : {}),
        ...(flightOptions.length ? { flightOptions: flightOptions.map((f) => ({ flightId: f.flightId, origin: f.origin, destination: f.destination, departureDate: f.departureDate, departs: f.departs })) } : {}),
        ...(lastHotel ? { selectedHotel: { hotelId: lastHotel.hotelId, city: lastHotel.city } } : {}),
        ...(hotelOptions.length ? { hotelOptions: hotelOptions.map((h) => ({ hotelId: h.hotelId, name: h.name, city: h.city })) } : {}),
        ...(itinerary ? { itinerary } : {}),
      },
    });
    wait.remove();
    // The server may have fallen back to the scripted planner if the provider
    // was unavailable — reflect that in the badge rather than failing silently.
    if (plan.planner) showPlanner(plan.planner);
    if (plan.summary !== undefined) showTrip(plan.summary);
    if (plan.track) currentTrack = plan.track;

    if (plan.kind === 'ask') { awaitingAnswer = true; renderAsk(plan); return; }
    awaitingAnswer = false;
    if (plan.kind === 'message') { say(plan.message); return; }

    const sp = (plan.tool === 'search_hotels' || plan.tool === 'book_hotel') ? 'hotel' : 'airline';
    if (plan.tool === 'search_hotels') currentTrack = 'hotel';
    if (plan.tool === 'book_flight') { lastFlight = null; flightOptions = []; }
    if (plan.tool === 'book_hotel') { lastHotel = null; hotelOptions = []; }
    await runCall({ sp, tool: plan.tool, args: plan.args });
  } catch (e) {
    say('I could not complete that: ' + e.message);
  } finally {
    wait.remove();
    sendBtn.disabled = false;
    input.focus();
  }
}

log.onclick = (e) => {
  const answer = e.target.dataset && e.target.dataset.answer;
  if (answer) { handle(answer, { answering: true }); return; }
  const a = e.target.dataset && e.target.dataset.action;
  if (!a) return;
  if (a.startsWith('book-flight:')) handle('Yes, book flight ' + a.slice('book-flight:'.length));
  else if (a.startsWith('book-hotel:')) handle('Yes, book hotel ' + a.slice('book-hotel:'.length));
  else if (a === 'consent' && pending) openConsent();
};

const CHIPS = [
  'I want to plan a trip',
  'Find me a hotel',
  'Book my return flight',
];
document.getElementById('chips').innerHTML =
  CHIPS.map((c) => '<button class="chip" type="button">' + esc(c) + '</button>').join('');
document.getElementById('chips').onclick = (e) => {
  if (e.target.classList.contains('chip')) handle(e.target.textContent);
};

document.getElementById('chat').onsubmit = (e) => {
  e.preventDefault();
  const v = input.value.trim();
  if (v) { input.value = ''; handle(v); }
};

function showPlanner(p) {
  if (!p) return;
  const scripted = p.provider === 'deterministic';
  document.getElementById('plannerText').textContent = scripted ? 'Scripted planner' : p.provider + ' · ' + p.model;
  document.querySelector('#plannerBadge .dot').className = 'dot' + (scripted ? ' warn' : '');
}

function enterApp(s) {
  document.getElementById('loginWrap').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('identity').textContent = s.username + ' · ' + s.serviceUser;
  showPlanner(s.planner);
  refreshTrust();
  input.focus();
}

document.getElementById('login').onsubmit = async (e) => {
  e.preventDefault();
  const err = document.getElementById('loginError');
  err.textContent = '';
  try {
    const s = await api('/api/login', {
      username: document.getElementById('username').value,
      password: document.getElementById('password').value,
    });
    enterApp(s);
    say("Hi! I'm your travel planner. I can book flights and hotels on your behalf — I'll ask for your approval before anything is confirmed. What trip can I help you plan?");
  } catch (e2) { err.textContent = e2.message; }
};

// ── Unattended demo mode ────────────────────────────────────────────────
// Visit /?demo=1 and the whole journey plays itself at presentation pace, so a
// screen recording needs no operator, except the two consent clicks: Helix's
// consent page never approves by itself (Helix signs as the user only on the
// user's click), so the demo waits there for the presenter. Nothing here
// bypasses the credential flow.
const DEMO = new URLSearchParams(location.search).get('demo') === '1';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < (timeoutMs || 25000)) {
    if (predicate()) return true;
    await pause(220);
  }
  return false;
}

const answerChip = (value) =>
  [...document.querySelectorAll('[data-answer]')].find((b) => b.dataset.answer === value);
const optionButton = (prefix) =>
  [...document.querySelectorAll('[data-action^="' + prefix + '"]')];

async function tapAnswer(value) {
  await waitFor(() => answerChip(value));
  await pause(950);
  answerChip(value)?.click();
}

async function runDemo() {
  await pause(1400);
  await handle('I want to plan a trip');

  await tapAnswer('Delhi');
  await tapAnswer('Thiruvananthapuram');
  const dateChip = () => [...document.querySelectorAll('[data-answer]')]
    .map((b) => b.dataset.answer).find((v) => /^\\d{4}-\\d{2}-\\d{2}$/.test(v));
  await waitFor(() => dateChip());
  await tapAnswer(dateChip());
  await tapAnswer('2 travellers');
  await tapAnswer('Helix Air');

  // Flight results — pick the cheaper evening departure.
  await waitFor(() => optionButton('book-flight:').length >= 2);
  await pause(1900);
  optionButton('book-flight:')[1].click();

  // Consent hand-off: open Helix's consent page and wait for the presenter's click.
  await waitFor(() => document.querySelector('[data-action="consent"]'));
  await pause(1500);
  demoOpenConsent();

  // Booking confirms once the user's signed root hop returns.
  await waitFor(() => document.querySelector('.receipt'), 300000);
  await pause(2400);

  // Hotel at the second, independent SP.
  await handle('Find me a hotel');
  await waitFor(() => answerChip('Around ₹8,000'));
  await tapAnswer('Around ₹8,000');
  await waitFor(() => optionButton('book-hotel:').length >= 1);
  await pause(1900);
  optionButton('book-hotel:')[0].click();

  await waitFor(() => document.querySelector('[data-action="consent"]'));
  await pause(1500);
  demoOpenConsent();
  await waitFor(() => document.querySelectorAll('.receipt').length >= 2, 300000);
  await pause(2400);

  // The payoff: same Airline SP again — no prompt, the stored hop is reused.
  await handle('Book my return flight');
  const returnDate = () => [...document.querySelectorAll('[data-answer]')]
    .map((b) => b.dataset.answer).find((v) => /^\\d{4}-\\d{2}-\\d{2}$/.test(v));
  await waitFor(() => returnDate());
  await tapAnswer(returnDate());
  await waitFor(() => optionButton('book-flight:').length >= 1);
  await pause(1900);
  optionButton('book-flight:')[0].click();
  await waitFor(() => document.querySelectorAll('.receipt').length >= 3, 45000);
}

function demoOpenConsent() {
  openConsent();
}

(async () => {
  try {
    const s = await api('/api/session');
    showPlanner(s.planner);
    if (s.authenticated) { enterApp(s); say('Welcome back. Ask me for a flight or a hotel.'); }
    if (DEMO) {
      if (!s.authenticated) {
        await pause(900);
        const signedIn = await api('/api/login', { username: 'traveler', password: 'demo123' });
        enterApp(signedIn);
        say("Hi! I'm your travel planner. I can book flights and hotels on your behalf — I'll ask for your approval before anything is confirmed. What trip can I help you plan?");
      }
      runDemo();
    }
  } catch { /* not signed in yet */ }
})();
</script>
</body>
</html>"""


def agent_page_html() -> str:
    return _TEMPLATE
