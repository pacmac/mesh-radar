---
module: app-config
source: public/app-config.js
source_hash: e8bfdc05105a97f0ed331a6725d25206d3fd8e5e76c6f06dcc69ee507da89b77
updated: 2026-09-03
---

# Module: app-config

## Purpose

Browser config mixin (Domain 2): Config-page tabs — Bridge, Modes, Radar,
Discovery, Callout, Alerts. Per-radio config editing (device/module sections,
channels, owner, fixed position) is gone — mesh-gw's own Radios page is the
only place any of that can be done now (2026-09-03, task
`devices-management-removed-meshgw-owns-it`). Rotator config (device switch,
firmware settings, calibration) is also gone (2026-09-04, task
`rotator-config-tab-removed-meshgw-owns-it`) — see `docs/modules/tab-cfg.md`
for that removal; this mixin's own `switchCfgTab` just dropped the
`'rotator'` branch.

## Removed 2026-09-03

`resetRadioCfg`, `loadSections`, `onSectionToggle`, `loadFixedPosition`,
`saveFixedPosition`, `clearFixedPosition`, `saveSection`, `loadChannels`,
`onChannelToggle`, `saveChannel`, `loadOwner`, `saveOwner`, and the exported
`channelWriteBody()` helper — 12 functions plus the PSK-safety helper this
module used to carry. All of the module's history below this section — the
bulk-channel-source fix, the PSK-never-guessed fix, the section-kind routing
fix, the optimistic-save-then-re-read design — describes that deleted code.
Left in place as a record rather than deleted: the reasoning (stale mesh-gw
caches, protobuf field mismatches, "save follows the phone app") may matter
again if any of this is ever rebuilt, even though the code it describes is
gone. The state these functions drove (`radioTab`, `cfgRadioId`, `allSections`,
`channels`, `channelSchema`, `ownerSchema`, `ownerData`, `fixedPosition`) is
also gone from `app.js`; `app-nav.js`'s `cd()` helper (built for these calls)
went with it.

## Exports (current)

```js
export function channelWriteBody(current, edited)   // ← REMOVED 2026-09-03; see above

export const configMixin = {
  switchCfgTab(name),                        // Bridge/Rotator/Modes/Radar/Callout/Alerts
  loadModesCfg(), saveModesCfg(),
  loadBridgeConfig(), saveBridgeConfig(),
  loadAlertRules(), saveSmtpAll(), saveSmtp(key, value), updateAlertRule(type, changes),
  loadCalloutCfg(), setCalloutEnabled(on), saveCalloutCfg(),
  addCalloutTemplate(), removeCalloutTemplate(i),
  loadDiscoveryCfg(), saveDiscoveryCfg(),
  loadRadarCfg(), saveRadarCfg(),
  sendTestAlert(),
}
```

(The `channelWriteBody` line above is shown struck for the reader's benefit —
it is not actually exported any more; see "Removed 2026-09-03".)

## `loadDiscoveryCfg` / `saveDiscoveryCfg`

Mirrors the radar pair. Fetched on first view rather than WS-pushed: this is a
**form flow**, which `BROWSER_CONTRACT` permits a GET for — the WS-only rule is
about display values, not the current contents of a settings form the user is
about to edit.

**Re-reads after saving** instead of trusting the form. The server clamps
(`docs/modules/config-api.md`), so what was typed and what was stored are not
always the same value.

## The callout transmit switch applies immediately

Peter, 2026-08-05: *"I switched off callout broadcasts but it's still
broadcasting."*

The toggle was `x-model="calloutCfg.enabled"` and nothing else. The server was
written **solely** by the Save button, so flipping the switch changed local Alpine
state and left the transmitter running: the UI read "off" while callouts went out
on the **public mesh** three times in the following two hours (last 17:23).

A UI that displays "off" over a live transmitter is worse than one with no switch
at all, and a kill switch that needs a second click on a different control is not
a kill switch.

`setCalloutEnabled(on)` therefore writes on `@change`:

- **sends only `enabled`.** The route treats absent keys as unchanged, so hitting
  the kill switch cannot commit a half-edited template or an in-progress number
  field as a side effect. Verified: an `enabled`-only write left all 5 templates
  and `min_km 50` intact.
- **re-reads** afterwards rather than trusting the click, and
- **reverts the toggle** if the write failed, so the switch can never disagree
  with the transmitter.

Everything else on the callout form still requires Save — the label says so,
because the two behaviours now differ and the difference matters.

## Test notes

- Playwright: Config tab renders Bridge/Rotator/Modes/Radar/Callout/Alerts
  sub-tabs, 0 console errors; no Radio/Channels/Owner sub-tabs exist.
- Callout kill switch: toggling `enabled` writes immediately and independently
  of Save; a failed write reverts the toggle.
- Discovery/Radar/Modes: save re-reads from the server rather than trusting
  the submitted form.

## History (describes deleted code — kept for the reasoning, not as a current spec)

The sections below this point — channel forms building from the bulk channel
set, the PSK-never-guessed fix, section-kind routing (`config` vs
`module-config`), and the optimistic-save-then-re-read design that mirrored
the Meshtastic Android app — all describe `onChannelToggle`, `saveChannel`,
`onSectionToggle`, `saveSection`, `loadOwner`, `saveOwner`, and
`channelWriteBody`, every one of them removed 2026-09-03. Full text preserved
in git history (this file, pre-2026-09-03) rather than reproduced here.
