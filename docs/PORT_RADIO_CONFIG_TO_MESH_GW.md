---
document: port-radio-config-to-mesh-gw
audience: mesh-gw
updated: 2026-08-20
---

> **Not a module spec.** No `source_hash`: `scripts/check_specs.py` scans
> `docs/modules/` only, so a hash here would imply a validation that never runs.
> This is a handover document to another repo, and it goes stale the moment they
> build from it — which is the point. The modules it describes are
> `docs/modules/radio-admin.md`, `interval-options.md`, `interval-tables.md` and
> `app-config.md`, and those *are* hash-checked.

# Porting radio config save / load / verify to mesh-gw

**Status: a handover proposal, not a decision.** Peter is offloading radio-facing
work to mesh-gw plugins because the gateway knows its own radios. This is the
inventory, the contract the browser already speaks, and — more valuable than
either — **the things that cost us days, so they do not cost you the same days.**

node-dash keeps the UI. Everything that composes an `AdminMessage` or touches a
radio should end up with you.

Talk to us on `mesh-gw--node-dash` once you have read it. Nothing here is fixed;
where we got something wrong we would rather you told us than reproduced it.

---

## 1. What exists here now

| file | lines | fate |
|---|---|---|
| `src/radio-admin.js` | 174 | **port** — the seven verbs and the audit chain |
| `src/radio-admin-api.js` | 168 | **port or delete** — the routes below |
| `src/interval-options.js` | 125 | **port** — makes bad values unenterable |
| `src/interval-tables.js` | 74 | **port** — generated, do not hand-edit |
| `scripts/gen_interval_tables.mjs` | 217 | **port** — the generator |
| `vendor/meshtastic-android/FixedUpdateIntervals.kt` | 414 | **port** — vendored input |
| `public/app-config.js`, `public/app-forms.js` | — | **stays** — the UI |

**Do not leave two writers.** Whatever we keep must not compose an `AdminMessage`.
Two implementations of one radio rule is what cost us 16–18 August, and we removed
our channel resolver this week for exactly that reason.

---

## 2. The API the browser speaks today

This is the whole surface. Ours is Express; yours would be FastAPI. Shapes matter,
paths do not — rename freely, we will follow.

```
POST   /radio-admin/config           {device, section, values}
POST   /radio-admin/module-config    {device, section, values}
POST   /radio-admin/channel          {device, index, settings}
POST   /radio-admin/owner            {device, user}
POST   /radio-admin/fixed-position   {device, position}
DELETE /radio-admin/fixed-position   {device}
GET    /radio-admin/owner/{device}
GET    /radio-admin/schema/{section}
```

`device` is a node id `!hex` **or** a BLE MAC. Both are accepted deliberately —
callers legitimately hold different vocabularies. **Short forms are refused**:
last-4 hex collides 20 times across 1,056 nodes.

### Pseudo-code — the write path

```python
# The ONE place a config write happens. Every verb goes through it.
async def write(device: str, message: dict) -> dict:
    # BACKUP FIRST, ALWAYS. See §4 — if the backup fails, the save does NOT
    # proceed. An unrecorded change is the thing the chain exists to prevent.
    backup_path = await backup_before_save(device)
    result = await send_admin(device, message)          # want_response=False
    return {**result, "backup": backup_path}


async def send_admin(device: str, message: dict, want_response: bool = False):
    # want_response FALSE for every SETTER, matching the phone app exactly
    # (CommandSenderImpl.sendAdmin's default). Only GETTERS pass True.
    # We are not waiting on an ack the app does not wait on.
    return await post(f"/{quote(device)}/admin",
                      {"message": message, "want_response": want_response})


# ── the seven verbs ──────────────────────────────────────────────────────────
# One per AdminMessage field. No section ordering. No reboot command.
set_config          = lambda dev, section, values: write(dev, {"set_config":        {section: values}})
set_module_config   = lambda dev, section, values: write(dev, {"set_module_config": {section: values}})
set_channel         = lambda dev, index, settings: write(dev, {"set_channel":       {"index": index, "settings": settings}})
set_owner           = lambda dev, user:            write(dev, {"set_owner":         user})
set_fixed_position  = lambda dev, position:        write(dev, {"set_fixed_position": position})
remove_fixed_position = lambda dev:                write(dev, {"remove_fixed_position": True})

# The only getter. want_response TRUE here — getters are the one place the app
# sets it.
request_config      = lambda dev, config_type:     send_admin(dev, {"get_config_request": config_type}, True)
```

### Pseudo-code — the routes

```python
@router.post("/config")
async def post_config(body: dict):
    require(body.get("device"),  "device required")
    require(body.get("section"), "section required")
    require(isinstance(body.get("values"), dict), "values object required")
    return await set_config(body["device"], body["section"], body["values"])


@router.post("/channel")
async def post_channel(body: dict):
    require(body.get("device"), "device required")
    # isinstance(index, int) — NOT truthiness. Index 0 is the PRIMARY channel and
    # `not 0` is True. The 2026-08-16 outage came from a primary nobody meant to
    # touch, so 0 must be EXPRESSIBLE and must never arrive by default.
    # NB bool is a subclass of int in Python — exclude it explicitly.
    require(isinstance(body.get("index"), int) and not isinstance(body["index"], bool),
            "index must be an integer")
    require(isinstance(body.get("settings"), dict), "settings object required")
    return await set_channel(body["device"], body["index"], body["settings"])
```

### `GET /schema/{section}` — the decorated schema

Your `/schema` already generates the fields. We decorate interval fields into
closed choices before serving them (§5) and serve everything else untouched.

```python
@router.get("/schema/{section}")
async def get_schema(section: str):
    schema = await gw_schema(section)
    return decorate_schema(section, schema)     # §5
```

### `GET /owner/{device}` — and a bug of yours it works around

```python
@router.get("/owner/{device}")
async def get_owner(device: str):
    owner = await gw_get_owner(device)          # your cooked GET
    # YOUR COOKED GET DROPS `role`. The radio answers with it — a genuine
    # get_owner_request returns role: CLIENT_BASE — so it is lost in the cooking.
    # We refill it from nodeinfo, which we build from the radio's own NodeInfo
    # announcements.
    #
    # This mattered: the form fell back to a hard-coded 'CLIENT' and showed a role
    # the radio does not have. It was harmless only by coincidence — saveOwner
    # strips role when it equals the fallback, and with role undefined BOTH sides
    # computed 'CLIENT'. Change either half and saving the Owner tab DEMOTES the
    # radio from CLIENT_BASE to CLIENT.
    #
    # If you fix the cooked GET to carry role, delete this and tell us.
    return {**owner, "role": nodeinfo_role(device), "role_source": "nodeinfo"}
```

**NULL WHEN UNKNOWN, never a default.** A form that guesses is how that defect
existed.

---

## 3. The AdminMessage rules, from firmware and the phone app

Every one of these was checked against source, not assumed.

**No reboot command, ever.** `AdminModule.cpp` computes `requiresReboot` itself and
sets it false at six sites. `reboot_seconds` is a separate admin command and a
config write never sends it. The radio restarts itself when it needs to — we
observed OMNI go `RECONNECTING → READY` on every module-config write, including
one that changed nothing.

**No reply carries a reboot flag.** Every reboot field in `admin.proto` is a
*request* field. A SET's only possible reply is a bare Routing ACK, and only when
`want_response` is set.

**Single-section saves use NO edit transaction.** `RadioConfigUseCase` calls
`radioController.setConfig(destNum, config, packetId)` — a bare set.
`commit_edit_settings` calls `saveChanges` with `shouldReboot` defaulting TRUE
after clearing the transaction flag, so wrapping ONE section in a transaction
causes a reboot the firmware would have skipped.

**Bulk restore is the opposite.** `InstallProfileUseCase` uses
`AdminControllerImpl.editSettings` — `begin_edit_settings`, every section,
`commit_edit_settings`, awaiting acceptance of both boundaries. That collapses
13+ reboots into one. **The rule is about COUNT, not principle.**

**The session passkey is yours and we never see it.** The app attaches it at your
layer (`buildAdminMessagePacket`: `session_passkey = sessionManager.getPasskey(destNum)`).
Field 101 is never set by us. Peter: *"that secret is theirs to keep."*

---

## 4. The audit chain — the part we most want preserved

Peter's requirement, verbatim: *"by having a yymmddhis filename we have a full
record of all changes made to any device, if this is done before EVERY save."*

```
backups/<node_id>/<YYMMDDHHMMSS>.json
```

- **24-hour clock.** He wrote "yymmddhis", which is the PHP format where `h` is
  12-hour. Saves at 09:15:00 and 21:15:00 would both render `091500`, collide, and
  sort wrongly. A record that sorts wrongly is not a record. Lexical order must
  equal chronological order.
- **Collision suffix `-1`, `-2`, …** Our first version failed the save on
  collision, reasoning that two saves in one second was unreal. The test
  immediately disproved it: **three writes in one second is exactly what a
  multi-section form save does.** Never overwrite, never fail the save.
- **Before EVERY save, no exceptions.** No "small edit" shortcut — a chain with
  holes is not a record. ~2.6 KB per file measured; no retention policy, because
  silently deleting audit history is worse than the disk cost.
- **Content is your `radio_backup` verbatim** — `config`, `module_config`,
  `channels`. Verified: 8 config sections, 15 module sections, 8 channels.
  `sessionkey` is present and **empty** (`{}`), so no credential is stored.

```python
def stamp(now=None) -> str:
    d = now or datetime.now()
    return f"{d.year % 100:02d}{d.month:02d}{d.day:02d}{d.hour:02d}{d.minute:02d}{d.second:02d}"

async def backup_before_save(device: str) -> str:
    doc = await gw_radio_backup(device)          # your cache read, ~2.5 ms
    d = BACKUP_ROOT / device
    d.mkdir(parents=True, exist_ok=True)
    base = stamp()
    for n in count():
        p = d / (f"{base}.json" if n == 0 else f"{base}-{n}.json")
        try:
            with open(p, "x") as f:              # "x" = fail if exists
                json.dump(doc, f, indent=2)
            return str(p)
        except FileExistsError:
            continue
```

**If the backup fails, the save does not proceed.**

### Two things we got wrong here, so you do not

1. We reported *"the backup omits every module_config section"*. **False.** We had
   inspected `doc["config"]` only and reported what was not in it as missing from
   the file — the module sections were one level across in `doc["module_config"]`.
   Enumerate the container before declaring anything absent from it.
2. We claimed *"verified, matched on 6 of 6 sections"*. True and misleading — 6 of
   21 is a sample worded as a verification. Redone across all 21: **MATCH 20,
   differ 1**, and the one difference was the file holding the pre-save value,
   which is the mechanism working. **Strip keys beginning `__`** when comparing:
   `/config/{section}` adds `__reboot` and `__notes` for the form,
   `radio_backup` carries neither. Not stripping them reports 8 false mismatches.

### The open question we would put to Peter

If you own the write, **the backup must move with it** — otherwise a save happens
with no record whenever node-dash is down or another caller writes directly.
Atomicity beats convenience.

The cost: that chain is currently the only *independent* record of config changes.
Moving it makes one source where there were two. Peter has separately said he
wants a second verdict on device exchanges, so this is worth him deciding rather
than either of us assuming.

---

## 5. Making bad values unenterable

Peter: *"I can enter any value I like for things like send freq for metadata, node
dash allows it and saves it an breaks the radio because the vales sent are
invalid."* Then: *"that schema MUST exist in phoen app!"* and *"we should use that
becos it works 100% of the time."*

**It does, and the app's reliability is not validation.** It never lets an invalid
value be typed: a `DropDownPreference` over
`IntervalConfiguration.<NAME>.allowedIntervals`. There is no invalid state to
reject, so there is no rejection path to get wrong.

Source: `feature/settings/.../util/FixedUpdateIntervals.kt` — 34 named intervals,
17 configurations.

```python
def decorate_schema(section: str, schema: dict) -> dict:
    """Rewrite mapped interval fields into a closed choice list."""
    out = dict(schema)
    fields = []
    for f in schema.get("fields", []):
        options = options_for(section, f["name"])
        if not options:
            fields.append(f)                       # UNMAPPED = UNTOUCHED
            continue
        # min/max/hint/unit ALL go. An allowlist has no out-of-range state, and a
        # leftover advisory beside a closed set reads as an instruction. We shipped
        # dropdowns still captioned "min 1800 (firmware-enforced); 0 = use default
        # (3600 s)" over a list starting at 1800 that cannot express 0.
        g = {k: v for k, v in f.items() if k not in ("min", "max", "hint", "unit")}
        g["type"] = "choice"                       # NOT "enum" — see below
        g["options"] = options                     # [{"value": int, "label": str}]
        fields.append(g)
    out["fields"] = fields
    return out
```

- **`choice`, not `enum`.** Our enum options are bare strings used as both value
  and label; reusing it emits `"1800"` where the protobuf needs an int — a
  wrong-*typed* value shipped while fixing wrong-*valued* ones.
- **An unmapped field is left exactly as it was.** Inventing a constraint is the
  mirror of the bug being fixed and harder to notice.
- **A value the radio holds that is not in the allowlist stays visible**, marked
  `"1234 (not a standard value)"` and selected. Never silently replaced with the
  nearest legal one.

### Generate the tables, never transcribe them

We vendored `FixedUpdateIntervals.kt` and generate `interval-tables.js` from it,
with a `--check` mode that fails if the two disagree.

**This is not fastidiousness.** Our hand-port had `ALL` wrong: the app defines it
as `FixedUpdateIntervals.entries` — *declaration* order — and four members were
appended after `ALWAYS_ON`, so it really ends `…259200, 2147483647, 80, 90, 8, 40`.
We wrote it ascending. **The error was not a typo, it was a tidy-up** — we made the
data more sensible than its source, which review does not catch and no test caught,
because every test asserted the values we had typed.

The generator resolves names and never re-derives numbers: an unknown duration form
is a `raise`, not a plausible value.

---

## 6. Verify — please do not build what we built

We built read-back verification. **It cannot work synchronously**, and Peter caught
it with a real save: *"store forward did NOT match after saving — is_server: sent
false, radio has true."* His save had worked.

Two independent reasons, either fatal:

1. **The read-back races the reboot.** The radio restarts after a save and the
   cache serves pre-save values meanwhile — measured `RECONNECTING 14:50:35 →
   READY 14:50:51`, about 16 s. `?fresh=1` does not help while it is reconnecting.
2. **Turning a boolean OFF makes it vanish.** `false` is the protobuf default and
   the GET omits defaults, so "set to default" and "absent" are the same thing on
   the wire. The commonest edit anyone makes is the one case that can never be
   confirmed.

So the check fired on the **normal path**, and an alarm that fires on the normal
path is worse than no alarm. We deleted it.

**What the app does instead:** optimistic local update from what was *sent*,
`expectRestartIfLocal(config.saveRebootBehavior())` to declare the restart rather
than discover it as an error, and a re-read only *"when the screen is next
opened"* — and only for LoRa, where the firmware can clamp what you sent.

**You can do better than we can, and this is the real prize of the port.** You hold
the BLE link and see `RECONNECTING → READY`. So verification is genuinely available
to you — but **only asynchronously**:

> A save returns **accepted**. Verification arrives **later, as an event**, after
> the device is READY and re-read.

If it is designed as a return value, it will rebuild our mistake.

Related, already agreed on this channel: a post-dispatch GATT teardown is **not** a
failure. The app treats **queue acceptance** as success —
`CommandSenderImpl.enqueueOrThrow` throws only if the queue refuses the packet.

---

## 7. Traps that are not obvious from the code

**A section's KIND decides the admin field.** `set_config` and `set_module_config`
carry different protobuf types. We posted everything to `set_config` and **13 of 21
sections could not be saved at all** — mqtt, serial, external_notification,
store_forward, range_test, **telemetry**, canned_message, audio, remote_hardware,
neighbor_info, ambient_lighting, detection_sensor, paxcounter. It fails loudly
(`Config has no field named "ambient_lighting"`), which is the only mercy.

**Your `/schema` is generated from YOUR protobuf, not the connected firmware.**
2.7.9 vs 2.8.0 here. That is how a role write came to be offered `ROUTER_CLIENT`
and be silently refused by the radio. Moving this code does not fix the skew — it
moves it. Worth naming in whatever you build.

**A whole-section PUT can clobber.** Your GET returns only non-default fields while
a form submits every field it rendered, so a boolean the GET omitted comes back as
an explicit `false`. That is how a radio's `fixed_position` got turned off by an
unrelated edit in the same section. We now submit only fields the read carried or
the user touched. **A GET that cannot say "unchanged" means a whole-section PUT can
never be perfectly safe** — if the plugin can express partial updates, please do.

**`protect_primary_channel`** already lives in your `send_admin`, so it catches the
passthrough. Good — keep it. Renaming or re-keying channel 0 removes the radio from
the public mesh while it still hears public nodes and decrypts none. Two days,
16–18 August.

---

## 8. What node-dash keeps

- the forms (`app-config.js`, `app-forms.js`) — rendering a served schema
- which device and section the operator chose
- rendering the outcome
- `device-config.js` — our device identity map

The browser decides nothing (`docs/BROWSER_CONTRACT.md`). It posts form values and
renders what comes back. It composes no `AdminMessage`, picks no section order, and
names no admin field.

---

## 9. Acceptance — what would tell us the port worked

- every section in `/sections` saves, including all 13 module sections
- a backup file exists for every save, named `YYMMDDHHMMSS.json`, and the diff
  against the previous file shows exactly the fields that changed
- three saves inside one second produce three files, none overwritten
- a save that changes a boolean to `false` does not report a mismatch
- an interval field arrives at the browser as `type: "choice"` with integer
  option values and no `min`/`max`/`hint`/`unit`
- a value outside the allowlist is preserved and marked, not replaced
- `session_passkey` never appears in anything served to node-dash
- writing a name or PSK to channel 0 is refused

---

## 10. Where we are least sure

Told plainly, because a spec that hides its soft spots wastes your time:

1. **Whether the interval allowlists belong with you at all.** They are the *app's*
   curation of what a human may enter, not firmware limits. We think one
   fully-formed schema beats a schema plus a decorator — but it is arguable, and
   you may prefer to serve raw and let the UI decorate.
2. **Where the backup files should live**, per §4. Genuinely Peter's call.
3. **Whether the plugin boundary is the whole save or only transport.** If it is
   only transport, the write ends up split across two repos, which is worse than
   either of us owning it. We would rather you took all of it.
