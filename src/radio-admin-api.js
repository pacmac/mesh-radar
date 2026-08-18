// radio-admin-api — the browser-facing surface for radio config writes.
//
// Spec: docs/modules/radio-admin.md.
//
// THE BROWSER DECIDES NOTHING (docs/BROWSER_CONTRACT.md). It posts the form
// values and renders what comes back. It composes no AdminMessage, picks no
// section order, and never names an admin field. Everything protocol-shaped lives
// behind here.
//
// This replaces the five deleted op-manager ops. It is deliberately NOT mounted
// on the old paths: the old surface wrote through mesh-gw's cooked PUT endpoints,
// which reported {"verified": true} without verifying anything, and reusing its
// routes would let a stale caller keep working and hide the cutover.

import { Router } from 'express';
import {
  setConfig, setModuleConfig, setChannel, setOwner,
  setFixedPosition, removeFixedPosition,
} from './radio-admin.js';

const router = Router();

// Sections are passed straight through as the AdminMessage field name. There is
// deliberately NO allowlist of section names here: mesh-gw's /schema is generated
// from ITS installed protobuf package (2.7.9) and not from the connected firmware
// (2.8.0), which is exactly how a role write came to be offered ROUTER_CLIENT and
// silently refused by the radio. An allowlist built from the same stale source
// would reproduce that bug one layer up. The radio is the authority on what it
// accepts, and it answers with ADMIN_BAD_SESSION_KEY / BAD_REQUEST when it does
// not.
const need = (res, cond, msg) => {
  if (cond) return false;
  res.status(400).json({ error: msg });
  return true;
};

router.post('/config', async (req, res) => {
  const { device, section, values } = req.body ?? {};
  if (need(res, device, 'device required')) return;
  if (need(res, section, 'section required')) return;
  if (need(res, values && typeof values === 'object', 'values object required')) return;
  try { res.json(await setConfig(device, section, values)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

router.post('/module-config', async (req, res) => {
  const { device, section, values } = req.body ?? {};
  if (need(res, device, 'device required')) return;
  if (need(res, section, 'section required')) return;
  if (need(res, values && typeof values === 'object', 'values object required')) return;
  try { res.json(await setModuleConfig(device, section, values)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

router.post('/channel', async (req, res) => {
  const { device, index, settings } = req.body ?? {};
  if (need(res, device, 'device required')) return;
  // Number.isInteger, not a truthiness test: index 0 is the PRIMARY channel and
  // `!0` is true. The 2026-08-16 outage came from a primary channel nobody meant
  // to touch, so index 0 must be expressible and must never arrive by default.
  if (need(res, Number.isInteger(index), 'index must be an integer')) return;
  if (need(res, settings && typeof settings === 'object', 'settings object required')) return;
  try { res.json(await setChannel(device, index, settings)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

router.post('/owner', async (req, res) => {
  const { device, user } = req.body ?? {};
  if (need(res, device, 'device required')) return;
  if (need(res, user && typeof user === 'object', 'user object required')) return;
  try { res.json(await setOwner(device, user)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

router.post('/fixed-position', async (req, res) => {
  const { device, position } = req.body ?? {};
  if (need(res, device, 'device required')) return;
  if (need(res, position && typeof position === 'object', 'position object required')) return;
  try { res.json(await setFixedPosition(device, position)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

router.delete('/fixed-position', async (req, res) => {
  const { device } = req.body ?? {};
  if (need(res, device, 'device required')) return;
  try { res.json(await removeFixedPosition(device)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

export default router;
