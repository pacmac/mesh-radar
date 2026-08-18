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
import { bridge } from './bridge.js';
import { stmts } from './db.js';
import { macToNodeId } from './device-config.js';

const router = Router();

/** node_id (`!hex`) or BLE MAC -> node num, or null.
 *
 *  Both vocabularies are accepted for the same reason channels.js accepts both
 *  (docs/IDENTITY.md): callers legitimately hold different ones. Short forms are
 *  NOT accepted — last-4 hex collides 20 times across 1,056 nodes. */
function toNum(device) {
  if (!device) return null;
  const direct = /^!([0-9a-f]{8})$/i.exec(String(device));
  if (direct) return parseInt(direct[1], 16);
  const viaMac = /^!([0-9a-f]{8})$/i.exec(String(macToNodeId(device) ?? ''));
  return viaMac ? parseInt(viaMac[1], 16) : null;
}

/** THE OWNER READ, WITH A TRUTHFUL ROLE.
 *
 *  mesh-gw's cooked GET /{id}/owner returns short_name and long_name and SILENTLY
 *  DROPS role. The radio does answer with it — a genuine get_owner_request
 *  returns role: CLIENT_BASE — so the field is lost in the cooking, not missing
 *  from the device.
 *
 *  The form then fell back to a hard-coded 'CLIENT' and showed a role the radio
 *  does not have. It was harmless only by coincidence: saveOwner strips role when
 *  it equals `ownerData?.role ?? 'CLIENT'`, and with role undefined BOTH sides
 *  computed to 'CLIENT'. Change either half and saving the Owner tab demotes the
 *  radio from CLIENT_BASE to CLIENT.
 *
 *  role comes from nodeinfo, which node-dash fills from the radio's own NodeInfo
 *  announcements — first-hand, not a guess and not mesh-gw's cooked view. A role
 *  change reboots the radio, which re-announces, so it self-heals.
 *
 *  NULL WHEN WE DO NOT KNOW. The browser renders the field empty rather than
 *  inventing a default, because a form that guesses is how this defect existed. */
router.get('/owner/:device', async (req, res) => {
  const { device } = req.params;
  try {
    const owner = await bridge.get(`/${encodeURIComponent(device)}/owner`);
    const num   = toNum(device);
    const info  = num == null ? null : stmts.getNodeinfoByNum.get(num);
    res.json({
      ...owner,
      role: info?.role ?? null,
      // Says where role came from, so nobody later mistakes it for something the
      // cooked GET supplied.
      role_source: info?.role ? 'nodeinfo' : null,
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

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
