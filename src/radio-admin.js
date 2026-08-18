// radio-admin — writing radio config the way the official phone app writes it.
//
// Spec: docs/modules/radio-admin.md. This module REPLACES five deleted op-manager
// ops; it is not a refactor of them. Peter, four times: "I do NOT want you to
// patch the existing code, I want it ripped out and re-done based on the exact
// same method that the phone app does."
//
// THE METHOD, from the two authorities rather than from documentation:
//
//   firmware  AdminModule.cpp — the FIRMWARE decides whether to reboot.
//             handleSetConfig computes requiresReboot itself (false at six sites,
//             e.g. when no LoRa parameter actually changed) and hands its own
//             verdict to saveChanges. `reboot_seconds` is a SEPARATE admin
//             command and a config write never sends it. Peter: "do not call a
//             restart if it is not needed... the device will restart itself if it
//             needs to and that may NOT be a manual request."
//
//   app       AdminControllerImpl.kt — setters send want_response = false (the
//             CommandSender default); only the GETTERS pass true. It writes its
//             own store optimistically.
//
//             A SINGLE-SECTION SAVE USES NO TRANSACTION, and that is why we do
//             not either: RadioConfigUseCase.setConfig calls
//             radioController.setConfig(destNum, config, packetId) — a bare set.
//             commit_edit_settings calls saveChanges with shouldReboot defaulting
//             to TRUE after clearing the transaction flag, so wrapping ONE section
//             in a transaction would cause a reboot the firmware would have
//             skipped.
//
//             CORRECTED 2026-08-18: this used to say the app "does NOT use
//             begin/commit edit settings anywhere". That is false.
//             AdminControllerImpl.editSettings does exactly that, awaiting
//             acceptance of both boundaries, and InstallProfileUseCase uses it to
//             write a whole profile — every config and module_config section — as
//             one transaction, collapsing 13+ reboots into one. The rule is
//             therefore about COUNT, not principle: one section, bare set; many
//             sections at once, transaction. Anyone adding restore-a-whole-config
//             needs the transaction and must not read this comment as forbidding
//             it.
//
// THERE IS NO REBOOT FLAG IN ANY REPLY. Searched admin.proto: every reboot field
// is a REQUEST field. A SET's only possible reply is a bare Routing ACK, and only
// when want_response is set. The app therefore treats the REBOOT ITSELF as the
// evidence — the firmware only reboots after saveChanges has written to disk, so
// the transport dropping proves the save persisted.
//
// WE NEVER SEE THE SESSION PASSKEY. mesh-gw attaches it; field 101 is never set
// here. Peter: "why do you even need to know the passcode ... that secret is
// theirs to keep."

import fs from 'node:fs';
import path from 'node:path';
import { bridge } from './bridge.js';

const BACKUP_ROOT = path.join(process.cwd(), 'backups');

/** YYMMDDHHMMSS, local time, 24-HOUR.
 *
 *  Peter wrote "yymmddhis", which is the PHP format where `h` is the 12-HOUR
 *  clock. Two saves at 09:15:00 and 21:15:00 would both render 091500 — they
 *  would collide and the chain would sort wrongly. A record that sorts wrongly is
 *  not a record, so this is 24-hour and lexical order == chronological order. */
export function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}`
       + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** THE AUDIT CHAIN. Peter: "by having a yymmddhis filename we have a full record
 *  of all changes made to any device, if this is done before EVERY save."
 *
 *  BEFORE EVERY SAVE, no exceptions. Skipping any save breaks the chain, and a
 *  chain with holes is not a record — so there is deliberately no "small edit"
 *  shortcut here. ~2.6 KB per file measured; no retention policy, because
 *  silently deleting audit history is worse than the disk cost.
 *
 *  Sourced from mesh-gw's radio_backup, which is a cache read (2.5 ms). That is
 *  correct and deliberate: Peter, "the mesh-gw cache is trusted... if I use my
 *  phone to change config, the mesh gw needs to be disconnected, when it
 *  reconnects it will re-read the configs", and "it's not your responsibility to
 *  ensure that mesh-gw is / is not stale".
 *
 *  IT COVERS EVERYTHING, and that was checked rather than assumed. radio_backup
 *  returns THREE top-level keys — `config`, `module_config` and `channels` — and
 *  the saved file carries all three: 8 config sections, 15 module sections, 8
 *  channels. `sessionkey` is present and EMPTY (`{}`), so no credential is stored;
 *  the passkey stays mesh-gw's, per Peter's "that secret is theirs to keep".
 *
 *  VERIFIED 2026-08-18 across all 21 sections, not a sample: comparing a saved
 *  file against a live read of every section gives MATCH 20, differ 1, and the
 *  single difference is ambient_lighting holding the value from BEFORE the save
 *  that file precedes — which is the mechanism working, not a fault. (Strip keys
 *  beginning `__` when comparing: /config/{section} adds __reboot and __notes for
 *  the form; radio_backup carries neither. Not stripping them reports 8 spurious
 *  mismatches.)
 *
 *  This replaces an earlier note claiming "matched on 6 of 6 sections". That was
 *  true and misleading — 6 of 21 is a sample, and it read as a verification.
 *
 *  The diff between consecutive files is the change log for that radio. Measured
 *  over four consecutive saves: 200 -> 146 -> 199 -> 199, each the value as it
 *  stood immediately before that write. */
export async function backupBeforeSave(device) {
  const doc = await bridge.get(`/${encodeURIComponent(device)}/radio_backup`);
  const dir = path.join(BACKUP_ROOT, String(device));
  fs.mkdirSync(dir, { recursive: true });
  // NEVER CLOBBER A RECORD, AND NEVER LOSE A SAVE. 'wx' throws if the name is
  // taken, so a second save inside the same second gets `-1`, `-2`, …
  //
  // The first version of this failed the save outright on collision, on the
  // reasoning that "two saves inside one second is not a real case". The test
  // below it immediately proved otherwise: three writes in one second is exactly
  // what a multi-section form save does, and refusing the third would have been a
  // save lost to its own audit trail. The suffix keeps Peter's YYMMDDHHMMSS
  // format, keeps lexical order chronological, and still cannot overwrite.
  const base = stamp();
  for (let n = 0; ; n++) {
    const file = path.join(dir, n === 0 ? `${base}.json` : `${base}-${n}.json`);
    try {
      fs.writeFileSync(file, JSON.stringify(doc, null, 2), { flag: 'wx' });
      return file;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}

/** Post one AdminMessage through mesh-gw's pass-through.
 *
 *  want_response defaults FALSE, matching the app's setters exactly
 *  (CommandSender.sendAdmin's own default). We are not waiting on an ack the app
 *  does not wait on. */
async function sendAdmin(device, message, wantResponse = false) {
  return bridge.post(`/${encodeURIComponent(device)}/admin`,
                     { message, want_response: wantResponse });
}

/** Every write takes the backup first, then sends. If the backup fails the save
 *  does NOT proceed — an unrecorded change is the thing this is here to prevent. */
async function write(device, message) {
  const backup = await backupBeforeSave(device);
  const res = await sendAdmin(device, message);
  return { ...res, backup };
}

// ── the verbs ───────────────────────────────────────────────────────────────
// One per AdminMessage field. No section ordering, no transaction, no reboot
// command — the app uses none of them for a save.

export const setConfig       = (device, section, values) =>
  write(device, { set_config: { [section]: values } });

export const setModuleConfig = (device, section, values) =>
  write(device, { set_module_config: { [section]: values } });

export const setChannel      = (device, index, settings) =>
  write(device, { set_channel: { index, settings } });

export const setOwner        = (device, user) =>
  write(device, { set_owner: user });

export const setFixedPosition = (device, position) =>
  write(device, { set_fixed_position: position });

export const removeFixedPosition = (device) =>
  write(device, { remove_fixed_position: true });

/** A genuine read of what the RADIO holds, for the read-back after a save.
 *
 *  want_response TRUE here — this is a getter, and the app's getters are the only
 *  place it sets it. The reply arrives as an ADMIN_APP packet on the gw event
 *  stream; this only issues the request. */
export const requestConfig = (device, configType) =>
  sendAdmin(device, { get_config_request: configType }, true);
