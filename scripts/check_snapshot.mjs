import { execSync } from 'node:child_process';
const DB = 'data/node-dash.db';
const q = sql => execSync(`sqlite3 -noheader "${DB}" "${sql.replace(/"/g,'\\"')}"`).toString().trim();
const HOME = `(SELECT CAST(value AS REAL) FROM config WHERE key='home.lat')`;
const HOML = `(SELECT CAST(value AS REAL) FROM config WHERE key='home.lon')`;
const KM = `6371*2*asin(sqrt(power(sin((radians(n.lat)-radians(${HOME}))/2),2)+cos(radians(${HOME}))*cos(radians(n.lat))*power(sin((radians(n.lon)-radians(${HOML}))/2),2)))`;
const since = d => d > 0 ? `strftime('%s','now')-${d*86400}` : '0';
const get = async (p) => (await fetch(`http://localhost:8000${p}`)).json();

let bad = 0, checks = 0;
const cmp = (win, field, live, sql) => {
  checks++;
  const a = live == null ? null : Number(live);
  const b = (sql === '' || sql == null) ? null : Number(sql);
  // numeric compare: sqlite ROUND yields "208.0" where JS gives 208
  const ok = (a == null && b == null) || (a != null && b != null && Math.abs(a-b) < 0.051);
  if (!ok) { bad++; console.log(`  MISMATCH  ${win.padEnd(4)} ${field.padEnd(16)} live=${a}  sql=${b}`); }
};

for (const d of [1,2,7,14,30,0]) {
  const w = d === 0 ? 'all' : `${d}d`;
  const f = await get(`/snapshot/frontier?days=${d}`);
  const g = await get(`/snapshot/new-ground?days=${d}`);
  const p = await get(`/snapshot/productivity?days=${d}`);
  const b = await get(`/snapshot/distribution?days=${d}`);

  cmp(w,'furthest_km', f.furthest_km,
      q(`SELECT ROUND(MAX(${KM}),1) FROM nodes n WHERE n.lat IS NOT NULL AND n.lat!=0 AND n.last_heard>${since(d)} AND ${KM}<=500`));
  cmp(w,'heard', f.heard,
      q(`SELECT COUNT(*) FROM nodes n WHERE n.lat IS NOT NULL AND n.lat!=0 AND n.last_heard>${since(d)} AND ${KM}<=500`));
  cmp(w,'first_heard', g.first_heard,
      d>0 ? q(`SELECT COUNT(*) FROM nodeinfo WHERE first_heard>${since(d)}`)
          : q(`SELECT COUNT(*) FROM nodeinfo WHERE first_heard IS NOT NULL`));
  cmp(w,'new_doors', g.new_doors,
      q(`WITH x AS (SELECT json_extract(route,'$[0]') n2, MIN(ts) fs FROM traceroute_history WHERE status='ok' AND json_array_length(route)>0 GROUP BY 1) SELECT COUNT(*) FROM x WHERE n2 IS NOT NULL AND fs>${since(d)}`));
  cmp(w,'first_contacts', g.first_contacts,
      q(`WITH c AS (SELECT to_num, MIN(ts) fo FROM traceroute_history WHERE status='ok' GROUP BY 1) SELECT COUNT(*) FROM c WHERE fo>${since(d)}`));
  cmp(w,'attempts', p.attempts, q(`SELECT COUNT(*) FROM traceroute_history WHERE ts>${since(d)}`));
  cmp(w,'answered', p.answered, q(`SELECT COALESCE(SUM(status='ok'),0) FROM traceroute_history WHERE ts>${since(d)}`));
  cmp(w,'bands_total', b.bands.reduce((s,x)=>s+x.count,0),
      q(`SELECT COUNT(*) FROM nodes n WHERE n.lat IS NOT NULL AND n.lat!=0 AND n.last_heard>${since(d)} AND ${KM}<=500`));
  cmp(w,'doors_total', b.doors_total,
      q(`SELECT COUNT(DISTINCT json_extract(route,'$[0]')) FROM traceroute_history WHERE status='ok' AND json_array_length(route)>0 AND ts>${since(d)}`));
}
console.log(`\n${checks} checks across 6 windows, ${bad} mismatches`);
process.exit(bad ? 1 : 0);
