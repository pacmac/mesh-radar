#!/usr/bin/env node
// Is a chunk transfer LIVE right now? Exit 0 = safe to edit src/, exit 1 = DO NOT.
//
// Any write under src/ restarts node-dash (pm2 watch), and the push receiver's chunk map
// lives in memory — so an edit mid-transfer destroys it. That happened twice on
// 2026-07-20: once at 20/32, once at 22:27:58 with a transfer the device had already
// accepted (cnt:32).
//
// WHY A SCRIPT AND NOT A DATABASE QUERY. The check I used before asked the `messages`
// table for recent traffic from the device. `messages` holds TEXT only — commands and
// replies. The 261 binary chunk frames are never written there, and during the streaming
// phase there is no text traffic at all. So it read ZERO exactly when a transfer was most
// active: a detector that reports "safe" during the dangerous state.
//
// This subscribes to /events and watches for the signals a live transfer actually emits:
// chunk_progress (~1/s from onProgress) and raw 261 packets. Absence is only concluded
// after a full window, and a connection failure is NOT treated as quiet.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const HOST   = process.argv.includes('--host') ? process.argv[process.argv.indexOf('--host') + 1] : 'localhost:8000';
const WINDOW = Number(process.argv.includes('--window') ? process.argv[process.argv.indexOf('--window') + 1] : 6000);

let live = false, sawAnything = false;
const ws = new WebSocket(`ws://${HOST}/events`);

ws.on('message', (m) => {
  let ev; try { ev = JSON.parse(m); } catch { return; }
  sawAnything = true;
  if (ev.type === 'chunk_progress') { live = true; }
  if (ev.type === 'packet' && Number(ev?.data?.packet?.decoded?.portnum) === 261) live = true;
  if (ev.type === 'private_app' && Number(ev.portnum) === 261) live = true;
});

ws.on('error', (e) => {
  // Cannot observe => cannot claim safe.
  console.log(`UNKNOWN — could not reach ${HOST}: ${e.message}. Treating as UNSAFE.`);
  process.exit(1);
});

setTimeout(() => {
  try { ws.close(); } catch {}
  if (live) {
    console.log(`TRANSFER LIVE — do NOT edit src/. A restart destroys the in-memory chunk map.`);
    process.exit(1);
  }
  if (!sawAnything) {
    console.log('UNKNOWN — no events at all in the window; the relay may be down. Treating as UNSAFE.');
    process.exit(1);
  }
  console.log(`no transfer signals in ${WINDOW} ms — safe to edit src/`);
  process.exit(0);
}, WINDOW);
