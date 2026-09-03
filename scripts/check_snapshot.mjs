// Every number on the Snapshot board, six windows, against SQL over the store.
//
// Spec: docs/modules/check-harness.md
//
// This asks the SOCKET, because that is what the page reads. It used to GET
// /snapshot/frontier|new-ground|productivity|distribution, which 2103e03
// deleted; unmatched paths return the SPA shell, so it crashed on `<` in
// JSON.parse. A check that reads a transport the page does not use proves
// nothing about the page and rots the moment the route goes.
import { askWsMany } from './ws-ask.mjs';
import { execSync } from 'node:child_process';
const DB = 'data/node-dash.db';
const q = sql => execSync(`sqlite3 -noheader "${DB}" "${sql.replace(/"/g,'\\"')}"`).toString().trim();
const HOME = `(SELECT CAST(value AS REAL) FROM config WHERE key='home.lat')`;
const HOML = `(SELECT CAST(value AS REAL) FROM config WHERE key='home.lon')`;
const KM = `6371*2*asin(sqrt(power(sin((radians(n.lat)-radians(${HOME}))/2),2)+cos(radians(${HOME}))*cos(radians(n.lat))*power(sin((radians(n.lon)-radians(${HOML}))/2),2)))`;
const since = d => d > 0 ? `strftime('%s','now')-${d*86400}` : '0';

// 0xFFFFFFFF — the broadcast address, which is not a node and is therefore not a
// door. Written out as a LITERAL rather than imported from src/reach.js, on
// purpose: this file exists to check the board against the store independently,
// and a check that imports the code it is checking asserts only that the code
// equals itself. It restates the RULE; reach.js implements it.
//
// It was absent here until 2026-08-23 and its absence was invisible, because
// snapshot-api.js made the same omission — two wrongs agreeing across 54 checks
// and six windows. It only went red when the board was fixed.
const BCAST = 4294967295;

let bad = 0, checks = 0;
const cmp = (win, field, live, sql) => {
  checks++;
  const a = live == null ? null : Number(live);
  const b = (sql === '' || sql == null) ? null : Number(sql);
  // numeric compare: sqlite ROUND yields "208.0" where JS gives 208
  const ok = (a == null && b == null) || (a != null && b != null && Math.abs(a-b) < 0.051);
  if (!ok) { bad++; console.log(`  MISMATCH  ${win.padEnd(4)} ${field.padEnd(16)} live=${a}  sql=${b}`); }
};

// One socket, six boards. Each connect costs a ~13.2 MB replay (ledger B92), so
// six connections would move 80 MB to ask six questions. `days` is echoed by the
// server, which is what lets a reply be matched back to its request.
const WINDOWS = [1,2,7,14,30,0];
const boards = await askWsMany(
  WINDOWS.map(d => ({ type: 'snapshot', days: d })),
  (msg, req) => msg.type === 'snapshot' && Number(msg.days) === Number(req.days));

for (const [i, d] of WINDOWS.entries()) {
  const w = d === 0 ? 'all' : `${d}d`;
  const s = boards[i];
  // board() returns {error, frontier:null, …} when a query fails
  // (src/ws-relay.js:1207-1213). Without this, b.bands.reduce throws a
  // TypeError that reads like a broken check rather than a broken board.
  if (s.error) { console.log(`  BOARD ERROR ${w.padEnd(4)} ${s.error}`); bad++; continue; }
  const f = s.frontier, g = s.new_ground, p = s.productivity, b = s.distribution;

  cmp(w,'furthest_km', f.furthest_km,
      q(`SELECT ROUND(MAX(${KM}),1) FROM nodes n WHERE n.lat IS NOT NULL AND n.lat!=0 AND n.last_heard>${since(d)} AND ${KM}<=500`));
  cmp(w,'heard', f.heard,
      q(`SELECT COUNT(*) FROM nodes n WHERE n.lat IS NOT NULL AND n.lat!=0 AND n.last_heard>${since(d)} AND ${KM}<=500`));
  cmp(w,'first_heard', g.first_heard,
      d>0 ? q(`SELECT COUNT(*) FROM nodeinfo WHERE first_heard>${since(d)}`)
          : q(`SELECT COUNT(*) FROM nodeinfo WHERE first_heard IS NOT NULL`));
  cmp(w,'new_doors', g.new_doors,
      q(`WITH x AS (SELECT json_extract(route,'$[0]') n2, MIN(ts) fs FROM traceroute_history WHERE status='ok' AND json_array_length(route)>0 GROUP BY 1) SELECT COUNT(*) FROM x WHERE n2 IS NOT NULL AND n2!=${BCAST} AND fs>${since(d)}`));
  cmp(w,'first_contacts', g.first_contacts,
      q(`WITH c AS (SELECT to_num, MIN(ts) fo FROM traceroute_history WHERE status='ok' GROUP BY 1) SELECT COUNT(*) FROM c WHERE fo>${since(d)}`));
  cmp(w,'attempts', p.attempts, q(`SELECT COUNT(*) FROM traceroute_history WHERE ts>${since(d)}`));
  cmp(w,'answered', p.answered, q(`SELECT COALESCE(SUM(status='ok'),0) FROM traceroute_history WHERE ts>${since(d)}`));
  cmp(w,'bands_total', b.bands.reduce((s,x)=>s+x.count,0),
      q(`SELECT COUNT(*) FROM nodes n WHERE n.lat IS NOT NULL AND n.lat!=0 AND n.last_heard>${since(d)} AND ${KM}<=500`));
  cmp(w,'doors_total', b.doors_total,
      q(`SELECT COUNT(DISTINCT json_extract(route,'$[0]')) FROM traceroute_history WHERE status='ok' AND json_array_length(route)>0 AND json_extract(route,'$[0]')!=${BCAST} AND ts>${since(d)}`));
}
console.log(`\n${checks} checks across 6 windows, ${bad} mismatches`);
process.exit(bad ? 1 : 0);
