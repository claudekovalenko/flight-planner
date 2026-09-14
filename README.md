# Turnaround Ledger

A single-page planner for deciding which trips to say yes to. Put every event you're
considering on one calendar (with the ones you've already committed to), and it works out:

- **the legs you'd actually fly**, including whether to go home between events or hop
  straight to the next city;
- **airfare**, from Expedia quotes for the exact day, a fare you typed in, or a distance
  based estimate when nothing better exists;
- **strain**: hours door to door, connections, time-zone shift, red-eyes, and turnarounds
  shorter than your buffer at home;
- **the marginal cost of each event**: what saying *no* to a committed event saves, and
  what saying *yes* to a maybe adds, given everything else on the calendar;
- **who pays**: each event carries a covered percentage and payer (a school budget, a host); the
  legs to it and home from it count toward it, and out-of-pocket becomes the headline number;
- **every scenario side by side**: each yes/no combination of your maybes, auto-routed and
  ranked by airfare plus what you say a strain point is worth, with one click to load it;
- **a route map** (great-circle legs over Natural Earth land), cumulative travel time, journey
  span from first departure to last arrival, ticket details with Expedia and Google Flights
  links, and the fare in Chase Ultimate Rewards points at a rate you set.

No framework and no bundler. `index.html` + `plan.js` + `airports.js` + `world.js` is the whole
app; `index.html` is a document fragment so the same file can be published as a Claude artifact
or wrapped into a standalone page by `scripts/build-pwa.mjs`.

## Running it

### As an installed app (GitHub Pages)

The repo ships as an installable PWA. `.github/workflows/pages.yml` builds `dist/` and deploys
it on every push, so once Pages is switched on (**Settings → Pages → Source: GitHub Actions**)
the app lives at `https://<user>.github.io/flight-planner/`. Open it in a browser and use the
install prompt (or the **Install app** button) to put it on the home screen or dock.

Installed, it works with no connection: the airport table, the map, the routing and every
calculation run on the device, and a service worker caches the shell. A new deploy shows up as
a "new version is ready" banner rather than changing the page under you. The plan is kept in
the browser's storage on that device, so use **Export** and **Import** to move a plan between
the installed app and the Claude artifact.

Build it yourself with `node scripts/build-pwa.mjs`, then serve `dist/` over http (a service
worker needs http://localhost or https, not a `file://` path).

### Other ways

- **As a Claude artifact (recommended).** Published from claude.ai, the page saves the plan
  and quotes to your Claude account and can pull fares through your own Expedia connector
  (the "Quote" buttons in the routing table).
- **Locally.** Serve the folder (`python3 -m http.server`) and open `index.html`. The plan is
  kept in the browser's local storage; Expedia quoting needs the claude.ai runtime, so
  type fares in by hand or paste them into a plan file and use the CLI.

## CLI

The same engine runs in Node:

```
node cli/plan.mjs example-plan.json          # totals, legs, gaps, and the flip-it deltas
node cli/plan.mjs my-plan.json --legs        # legs that still lack a quote, as Expedia search inputs
node cli/plan.mjs my-plan.json --json        # everything, as JSON
```

A plan file looks like `example-plan.json`. Quotes live under `quotes`, keyed
`ORIGIN-DEST-YYYY-MM-DD`:

```json
"quotes": {
  "SFO-JFK-2026-10-05": { "price": 189, "currency": "USD", "durationMin": 325, "stops": 0,
                          "airline": "JetBlue", "depart": "7:05 AM", "arrive": "3:30 PM", "source": "expedia" }
}
```

`price` is the total for all travelers; set `"perTraveler": true` if it's a single fare.

## How the numbers are made

**Routing.** Committed events are sorted by date. Between two of them, the planner either
flies home (two legs) or straight to the next city (one leg). Gaps of at least the
*go-home threshold* (default 4 days) always go home; for shorter gaps the router scores
each choice as `fare + strainDollar × (strain + turnaround penalty)` (default $25 per
strain point) and takes the lower. So saying yes to an earlier city automatically re-routes
the next leg to depart from there, and dropping a city collapses the legs around it. Any
gap can be overridden. Events at the home airport need no legs. Travel days are
the event dates, extended by "fly in the day before" / "fly out the day after".

**Estimates.** Without a quote, a leg's flight time is `35 min + miles / 8` and its fare is
`$45 + $0.09/mile` domestically or `$120 + $0.10/mile` across a border. These are only
placeholders so the deltas have something to work with; quote the leg for a real number.

**Strain** (points, configurable in the page):

| factor | default |
|---|---|
| door-to-door hours (flight + 2.5 h airport overhead) | 1.0 / hour |
| connection | 1.5 each |
| time-zone shift | 0.6 / hour |
| red-eye (departs 21:00+ or lands before 06:00 next day) | 2.0 |
| each day short of the home buffer (default 2 days) | 3.0 |
| event-to-event hop with no home time | 1.5 |

Bands: under 15 light, under 35 moderate, under 60 heavy, above that brutal.

## Data

`world.js` holds Natural Earth 1:110m land polygons (public domain) for the map.
`icons/` is generated by `scripts/make-icons.mjs`.
`airports.js` is generated from the [OpenFlights](https://openflights.org/data.html) airport
database (ODbL) by `scripts/build-airports.mjs`. Time-zone shift uses each airport's IANA
zone on the travel date, so DST is handled.
