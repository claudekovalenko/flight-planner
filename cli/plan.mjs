#!/usr/bin/env node
// Usage: node cli/plan.mjs <plan.json> [--legs] [--json]
//   default  print the plan: totals, legs, gaps, and the say-yes / say-no deltas per event
//   --legs   print the legs still lacking a quote (as JSON) so quotes can be fetched and merged into plan.quotes
//   --json   print the full computed plan as JSON
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const FP = require(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'plan.js'));

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--')) || 'example-plan.json';
const state = JSON.parse(readFileSync(file, 'utf8'));
const plan = FP.buildPlan(state);
const { rows } = FP.marginal(state);
const cur = plan.settings.currency;

if (args.includes('--legs')) {
  const missing = plan.legs.filter((l) => l.source === 'estimate').map((l) => ({ key: l.key, origin: l.from, destination: l.to, departure_date: l.date, adult_count: plan.settings.travelers, cabin_class: plan.settings.cabin }));
  console.log(JSON.stringify(missing, null, 2));
  process.exit(0);
}
if (args.includes('--json')) { console.log(JSON.stringify({ plan, marginal: rows }, null, 2)); process.exit(0); }

const pad = (s, n, right) => { s = String(s); return right ? s.padStart(n) : s.padEnd(n); };
const byId = Object.fromEntries(state.events.map((e) => [e.id, e]));
console.log(`Home ${plan.settings.home} · ${plan.events.length} committed event(s) · ${plan.legs.length} leg(s)`);
console.log(`Airfare ${FP.fmtMoney(plan.totals.price, cur)} (${plan.totals.quotedLegs}/${plan.totals.legs} legs quoted) · ${FP.fmtDuration(plan.totals.blockMin)} in the air · ${plan.totals.nightsAway} nights away over ${plan.totals.trips} trip(s)`);
console.log(`Strain ${plan.totals.strain} (${plan.totals.band}) · ${plan.totals.tight} tight turnaround(s) · ${plan.totals.tzHours}h of time-zone shift · ${plan.totals.conflicts} conflict(s)\n`);
for (const w of plan.warnings) console.log(`! ${w.text}`);
if (plan.warnings.length) console.log('');

console.log('LEGS');
for (const l of plan.legs) {
  console.log(`  ${l.date}  ${l.from}→${l.to}  ${pad(FP.fmtDuration(l.durationMin), 7, true)}  ${l.stops ? l.stops + ' stop' : 'nonstop'}  tz ${l.tzShiftH}h  strain ${pad(l.strain, 5, true)}  ${pad(FP.fmtMoney(l.price, l.currency), 8, true)} ${l.source === 'estimate' ? '(est.)' : '(' + l.source + (l.airline ? ', ' + l.airline : '') + ')'}`);
}
console.log('\nGAPS');
for (const g of plan.gaps) {
  const alt = g.options.home && g.options.direct ? `  via home ${FP.fmtMoney(g.options.home.price, cur)} / direct ${FP.fmtMoney(g.options.direct.price, cur)}` : '';
  console.log(`  ${byId[g.from].name} → ${byId[g.to].name}: ${g.days} day(s), ${g.resolved}${g.tight ? ' TIGHT' : ''}${g.overlap ? ' OVERLAP' : ''}${alt}`);
}
const sc = FP.scenarios(state);
if (sc.toggled.length) {
  console.log(`\nSCENARIOS (every yes/no mix of: ${sc.toggled.map((id) => byId[id].name).join(', ')}) — best score first`);
  for (const r of sc.rows) {
    const t = r.totals;
    console.log(`  ${pad(r.yes.length ? r.yes.map((id) => byId[id].name).join(' + ') : '(none of them)', 30)} ${pad(t.route.join('→'), 26)} ${pad(FP.fmtMoney(t.price, cur), 7, true)} ${pad(t.points.toLocaleString() + ' pts', 11, true)} ${pad(FP.fmtDuration(t.blockMin), 8, true)} travel  span ${pad(FP.fmtSpan(t.spanMin), 6)} strain ${pad(t.strain, 5, true)} ${t.band}`);
  }
}
console.log('\nDECISIONS (delta of flipping each event)');
for (const r of rows) {
  const e = byId[r.id];
  if (!r.valid) { console.log(`  ${pad(e.name, 22)} ${e.status.toUpperCase().padEnd(5)}  (incomplete event)`); continue; }
  const d = r.delta, sign = (n) => (n > 0 ? '+' : '') + n;
  const verb = e.status === 'yes' ? 'saying NO saves' : 'saying YES adds';
  const dd = e.status === 'yes' ? { price: -d.price, blockMin: -d.blockMin, strain: -d.strain, nightsAway: -d.nightsAway, tight: -d.tight } : d;
  console.log(`  ${pad(e.name, 22)} ${e.status.toUpperCase().padEnd(5)} ${verb} ${FP.fmtMoney(Math.abs(dd.price), cur)}, ${FP.fmtDuration(Math.abs(dd.blockMin))} in air, strain ${sign(dd.strain)}, nights ${sign(dd.nightsAway)}, tight turnarounds ${sign(dd.tight)}${r.conflictsIfYes.length ? '  CONFLICTS with ' + r.conflictsIfYes.map((id) => byId[id].name).join(', ') : ''}`);
}
