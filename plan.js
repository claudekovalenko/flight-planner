/* Turnaround Ledger — planning engine.
 * Works as a browser global (window.FlightPlan, needs window.AIRPORTS from airports.js)
 * and as a CommonJS module (require('./plan.js')).
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./airports.js'));
  } else {
    root.FlightPlan = factory(root.AIRPORTS || []);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (AIRPORTS) {
  'use strict';

  // ---------- airports ----------
  const byCode = new Map();
  for (const a of AIRPORTS) byCode.set(a[0], a);

  function airport(code) {
    const a = byCode.get(String(code || '').trim().toUpperCase());
    return a ? { code: a[0], city: a[1], country: a[2], lat: a[3], lon: a[4], tz: a[5], name: a[6] } : null;
  }

  function searchAirports(q, limit) {
    q = String(q || '').trim().toLowerCase();
    if (!q) return [];
    limit = limit || 8;
    const exact = [], codePrefix = [], cityPrefix = [], other = [];
    for (const a of AIRPORTS) {
      const code = a[0].toLowerCase(), city = a[1].toLowerCase(), name = a[6].toLowerCase();
      if (code === q) exact.push(a);
      else if (code.startsWith(q)) codePrefix.push(a);
      else if (city.startsWith(q)) cityPrefix.push(a);
      else if (name.includes(q) || city.includes(q)) other.push(a);
      if (exact.length + codePrefix.length + cityPrefix.length >= limit * 3) break;
    }
    // Prefer big-name airports: "International" in the name floats up within each bucket.
    const rank = (a) => (/international/i.test(a[6]) ? 0 : 1);
    const sorted = [].concat(exact, codePrefix, cityPrefix.sort((x, y) => rank(x) - rank(y)), other.sort((x, y) => rank(x) - rank(y)));
    return sorted.slice(0, limit).map((a) => ({ code: a[0], city: a[1], country: a[2], name: a[6] }));
  }

  // ---------- dates ----------
  const DAY = 86400000;
  function parseISO(s) { const [y, m, d] = String(s).split('-').map(Number); return Date.UTC(y, m - 1, d); }
  function toISO(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function addDays(iso, n) { return toISO(parseISO(iso) + n * DAY); }
  function diffDays(a, b) { return Math.round((parseISO(b) - parseISO(a)) / DAY); }
  function validISO(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(parseISO(s)); }

  const dtfCache = new Map();
  function tzOffsetMin(tz, iso) {
    try {
      let f = dtfCache.get(tz);
      if (!f) {
        f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        dtfCache.set(tz, f);
      }
      const utc = parseISO(iso) + 12 * 3600000; // local noon-ish, avoids DST edge hours
      const p = {};
      for (const part of f.formatToParts(new Date(utc))) p[part.type] = part.value;
      const local = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute);
      return Math.round((local - utc) / 60000);
    } catch (e) { return 0; }
  }

  // ---------- geometry ----------
  function haversineMiles(a, b) {
    const R = 3958.8, toRad = (x) => (x * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  // ---------- defaults ----------
  const DEFAULT_WEIGHTS = {
    airportHours: 2.5,       // door-to-door overhead per leg (get there early, deplane, transit)
    perHour: 1.0,            // strain points per door-to-door hour
    perStop: 1.5,            // per connection
    perTzHour: 0.6,          // per hour of time-zone shift
    redEye: 2.0,             // overnight flight
    tightTurnaroundPerDay: 3, // per day short of minBufferDays at home
    noHomeGap: 1.5           // going event-to-event without touching home
  };
  const DEFAULT_SETTINGS = {
    home: 'SFO', travelers: 1, cabin: 'ECONOMY', currency: 'USD',
    minBufferDays: 2,      // days at home between trips before it counts as a tight turnaround
    homeReturnMinGap: 4,   // gaps at least this long default to "go home in between"
    weights: DEFAULT_WEIGHTS
  };
  const BANDS = [
    { max: 15, name: 'light' }, { max: 35, name: 'moderate' }, { max: 60, name: 'heavy' }, { max: Infinity, name: 'brutal' }
  ];
  function strainBand(score) { for (const b of BANDS) if (score < b.max) return b.name; return 'brutal'; }

  // ---------- legs ----------
  function quoteKey(from, to, date) { return `${from}-${to}-${date}`; }

  function parseClock(s) {
    // "8:00 PM" -> 20.0 ; "10:46 PM" -> 22.77
    const m = /(\d{1,2}):(\d{2})\s*([AP]M)?/i.exec(String(s || ''));
    if (!m) return null;
    let h = +m[1] % 12; const min = +m[2];
    if (m[3] && m[3].toUpperCase() === 'PM') h += 12;
    if (!m[3]) h = +m[1];
    return h + min / 60;
  }
  function parseDuration(s) {
    // "4h 25m" -> 265
    if (typeof s === 'number') return s;
    const h = /(\d+)\s*h/.exec(s || ''), m = /(\d+)\s*m/.exec(s || '');
    return (h ? +h[1] * 60 : 0) + (m ? +m[1] : 0);
  }

  function estimateLeg(A, B, date) {
    const miles = haversineMiles(A, B);
    const intl = A.country !== B.country;
    const durationMin = Math.round(35 + miles / 8); // ~480 mph plus taxi/climb
    const price = Math.round((intl ? 120 + 0.10 * miles : 45 + 0.09 * miles) / 5) * 5;
    return { miles: Math.round(miles), durationMin, price, stops: 0, intl };
  }

  function makeLeg(from, to, date, purpose, ctx) {
    const A = airport(from), B = airport(to);
    if (!A || !B) return null;
    const est = estimateLeg(A, B, date);
    const tzShiftH = Math.abs(tzOffsetMin(B.tz, date) - tzOffsetMin(A.tz, date)) / 60;
    const key = quoteKey(A.code, B.code, date);
    const q = ctx.quotes && ctx.quotes[key];
    const leg = {
      key, from: A.code, to: B.code, date, purpose,
      fromCity: A.city, toCity: B.city, miles: est.miles, tzShiftH: Math.round(tzShiftH * 10) / 10, intl: est.intl,
      source: 'estimate', price: est.price * ctx.travelers, currency: ctx.currency, durationMin: est.durationMin, stops: 0,
      redEye: false, airline: null, depart: null, arrive: null
    };
    if (q && typeof q.price === 'number') {
      leg.source = q.source || 'quoted';
      leg.price = q.perTraveler ? q.price * ctx.travelers : q.price;
      leg.currency = q.currency || ctx.currency;
      if (q.durationMin) leg.durationMin = q.durationMin;
      if (typeof q.stops === 'number') leg.stops = q.stops;
      leg.airline = q.airline || null; leg.depart = q.depart || null; leg.arrive = q.arrive || null;
      const dep = parseClock(q.depart), arr = parseClock(q.arrive);
      leg.redEye = (dep != null && dep >= 21) || ((q.dayDiff || 0) >= 1 && ((arr != null && arr <= 6) || (q.durationMin || 0) >= 480)); // overnight itineraries count too
      leg.fetchedAt = q.fetchedAt || null;
    }
    const w = ctx.weights;
    leg.strain = Math.round(((leg.durationMin / 60 + w.airportHours) * w.perHour + leg.stops * w.perStop + leg.tzShiftH * w.perTzHour + (leg.redEye ? w.redEye : 0)) * 10) / 10;
    return leg;
  }

  // ---------- plan ----------
  function normalizeEvent(e) {
    return Object.assign({ status: 'maybe', priority: 2, arriveDayBefore: true, leaveDayAfter: false }, e);
  }
  function arriveDate(e) { return e.arriveDayBefore ? addDays(e.start, -1) : e.start; }
  function leaveDate(e) { return e.leaveDayAfter ? addDays(e.end, 1) : e.end; }

  function buildPlan(state) {
    const settings = Object.assign({}, DEFAULT_SETTINGS, state.settings || {});
    settings.weights = Object.assign({}, DEFAULT_WEIGHTS, (state.settings && state.settings.weights) || {});
    const ctx = { quotes: state.quotes || {}, travelers: settings.travelers || 1, currency: settings.currency, weights: settings.weights };
    const home = airport(settings.home);
    const warnings = [];
    if (!home) warnings.push({ type: 'home', text: `Home airport "${settings.home}" is not a known IATA code.` });

    const events = (state.events || []).map(normalizeEvent)
      .filter((e) => e.status === 'yes' && validISO(e.start) && validISO(e.end) && airport(e.airport))
      .sort((a, b) => parseISO(a.start) - parseISO(b.start) || parseISO(a.end) - parseISO(b.end));

    const legs = [], gaps = [], conflicts = [];
    const policies = state.gapPolicies || {};

    if (home && events.length) {
      // first leg out
      const first = events[0];
      if (first.airport !== home.code) legs.push(Object.assign(makeLeg(home.code, first.airport, arriveDate(first), 'out', ctx), { eventTo: first.id }));

      for (let i = 0; i < events.length - 1; i++) {
        const a = events[i], b = events[i + 1];
        const gapDays = diffDays(leaveDate(a), arriveDate(b));
        const overlap = diffDays(a.end, b.start) < 0; // b starts before a ends
        const key = `${a.id}|${b.id}`;
        const policy = policies[key] || 'auto';
        const g = { key, from: a.id, to: b.id, fromAirport: a.airport, toAirport: b.airport, days: gapDays, policy, overlap };
        if (overlap) conflicts.push({ a: a.id, b: b.id, text: `${a.name} and ${b.name} overlap (${a.airport} ${a.start}–${a.end} vs ${b.airport} ${b.start}–${b.end}).` });

        const same = a.airport === b.airport;
        const homeOpt = a.airport === home.code ? null : {
          legs: [makeLeg(a.airport, home.code, leaveDate(a), 'home', ctx), b.airport === home.code ? null : makeLeg(home.code, b.airport, arriveDate(b), 'out', ctx)].filter(Boolean)
        };
        const directOpt = same ? { legs: [] } : { legs: [makeLeg(a.airport, b.airport, overlap ? arriveDate(b) : leaveDate(a), 'between', ctx)] };
        for (const opt of [homeOpt, directOpt].filter(Boolean)) {
          opt.price = opt.legs.reduce((s, l) => s + l.price, 0);
          opt.strain = opt.legs.reduce((s, l) => s + l.strain, 0);
        }
        let resolved;
        if (a.airport === home.code || b.airport === home.code) resolved = 'home';
        else if (same) resolved = 'stay';
        else if (policy === 'home' || policy === 'direct') resolved = policy;
        else resolved = gapDays >= settings.homeReturnMinGap ? 'home' : 'direct';
        if (overlap) resolved = same ? 'stay' : 'direct';
        g.resolved = resolved;
        g.options = { home: homeOpt, direct: directOpt };

        const chosen = resolved === 'home' ? homeOpt : directOpt;
        chosen.legs.forEach((l, idx) => legs.push(Object.assign(l, { eventFrom: a.id, eventTo: b.id, gapKey: key })));

        // buffer & penalties
        if (resolved === 'home' && a.airport !== home.code && b.airport !== home.code) {
          g.buffer = gapDays; // full days at home
          g.tight = gapDays < settings.minBufferDays;
          g.penalty = g.tight ? (settings.minBufferDays - gapDays) * settings.weights.tightTurnaroundPerDay : 0;
        } else if (resolved === 'direct') {
          g.buffer = gapDays; g.tight = gapDays <= 0;
          g.penalty = settings.weights.noHomeGap + (gapDays <= 0 ? settings.weights.tightTurnaroundPerDay : 0);
        } else {
          g.buffer = gapDays; g.tight = false; g.penalty = 0;
        }
        if (overlap) { g.tight = true; g.penalty += settings.weights.tightTurnaroundPerDay * 2; }
        gaps.push(g);
      }
      const last = events[events.length - 1];
      if (last.airport !== home.code) legs.push(Object.assign(makeLeg(last.airport, home.code, leaveDate(last), 'home', ctx), { eventFrom: last.id }));
    }

    // away intervals -> nights away & trips
    const intervals = [];
    for (const e of events) if (home && e.airport !== home.code) intervals.push([arriveDate(e), leaveDate(e)]);
    for (const g of gaps) if (g.resolved !== 'home') {
      const a = events.find((e) => e.id === g.from), b = events.find((e) => e.id === g.to);
      if (a && b && home && a.airport !== home.code) intervals.push([leaveDate(a), arriveDate(b)]);
    }
    intervals.sort((x, y) => parseISO(x[0]) - parseISO(y[0]));
    const trips = [];
    for (const [s, e] of intervals) {
      const t = trips[trips.length - 1];
      if (t && parseISO(s) <= parseISO(t.return)) { if (parseISO(e) > parseISO(t.return)) t.return = e; }
      else trips.push({ depart: s, return: e });
    }
    const nightsAway = trips.reduce((s, t) => s + Math.max(0, diffDays(t.depart, t.return)), 0);

    const totals = {
      price: Math.round(legs.reduce((s, l) => s + l.price, 0)),
      quotedPrice: Math.round(legs.filter((l) => l.source !== 'estimate').reduce((s, l) => s + l.price, 0)),
      quotedLegs: legs.filter((l) => l.source !== 'estimate').length,
      legs: legs.length,
      blockMin: legs.reduce((s, l) => s + l.durationMin, 0),
      stops: legs.reduce((s, l) => s + l.stops, 0),
      tzHours: Math.round(legs.reduce((s, l) => s + l.tzShiftH, 0) * 10) / 10,
      redEyes: legs.filter((l) => l.redEye).length,
      nightsAway, trips: trips.length,
      tight: gaps.filter((g) => g.tight).length,
      conflicts: conflicts.length,
      strain: Math.round((legs.reduce((s, l) => s + l.strain, 0) + gaps.reduce((s, g) => s + (g.penalty || 0), 0)) * 10) / 10
    };
    totals.band = strainBand(totals.strain);
    for (const c of conflicts) warnings.push({ type: 'conflict', text: c.text });
    return { settings, events, legs, gaps, trips, conflicts, totals, warnings, home };
  }

  function withStatus(state, id, status) {
    return Object.assign({}, state, { events: (state.events || []).map((e) => (e.id === id ? Object.assign({}, e, { status }) : e)) });
  }

  function diffTotals(on, off) {
    const d = {};
    for (const k of ['price', 'blockMin', 'strain', 'nightsAway', 'tight', 'legs', 'tzHours', 'conflicts', 'trips']) d[k] = Math.round((on[k] - off[k]) * 10) / 10;
    return d;
  }

  /** For every event: what changes if it flips. `yes` rows report the saving of saying no;
   *  `maybe`/`no` rows report the cost of saying yes. Both directions are returned. */
  function marginal(state) {
    const base = buildPlan(state);
    const rows = (state.events || []).map(normalizeEvent).map((e) => {
      const ok = validISO(e.start) && validISO(e.end) && !!airport(e.airport);
      if (!ok) return { id: e.id, status: e.status, valid: false };
      const on = buildPlan(withStatus(state, e.id, 'yes'));
      const off = buildPlan(withStatus(state, e.id, 'no'));
      const delta = diffTotals(on.totals, off.totals);
      const conflictsIfYes = on.conflicts.filter((c) => c.a === e.id || c.b === e.id).map((c) => (c.a === e.id ? c.b : c.a));
      const legsIfYes = on.legs.filter((l) => l.eventTo === e.id || l.eventFrom === e.id);
      return { id: e.id, status: e.status, valid: true, delta, conflictsIfYes, band: { on: on.totals.band, off: off.totals.band }, legsIfYes };
    });
    return { base, rows };
  }

  function fmtDuration(min) { const h = Math.floor(min / 60), m = Math.round(min % 60); return h ? `${h}h ${m ? m + 'm' : ''}`.trim() : `${m}m`; }
  function fmtMoney(n, currency) {
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0 }).format(n); }
    catch (e) { return `${currency || ''} ${Math.round(n)}`; }
  }

  /** Turn one Expedia search_flights result into a quote record (cheapest option first, as sorted by PRICE). */
  function quoteFromExpedia(payload, meta) {
    const opt = payload && payload.options && payload.options[0];
    if (!opt) return null;
    const slice = opt.slices && opt.slices[0];
    const price = +(opt.price && opt.price.total_price && opt.price.total_price.value);
    if (!isFinite(price)) return null;
    const legsArr = (slice && slice.legs) || [];
    const airlines = [...new Set(legsArr.map((l) => l.marketing_airline_name).filter(Boolean))];
    return {
      price, currency: (opt.price.total_price.currency) || 'USD', perTraveler: false,
      durationMin: parseDuration(slice && slice.flight_duration), stops: (slice && slice.number_of_stops) || 0,
      airline: airlines.join(' + ') || null, depart: slice && slice.departure_time, arrive: slice && slice.arrival_time,
      dayDiff: (slice && slice.departure_arrival_day_difference) || 0,
      source: 'expedia', fetchedAt: (meta && meta.fetchedAt) || new Date().toISOString(),
      optionsSeen: payload.options.length
    };
  }

  return {
    airport, searchAirports, addDays, diffDays, validISO, parseISO, toISO, tzOffsetMin, haversineMiles,
    DEFAULT_SETTINGS, DEFAULT_WEIGHTS, BANDS, strainBand, quoteKey, buildPlan, marginal, withStatus,
    arriveDate, leaveDate, normalizeEvent, fmtDuration, fmtMoney, quoteFromExpedia, parseDuration, parseClock, estimateLeg
  };
});
