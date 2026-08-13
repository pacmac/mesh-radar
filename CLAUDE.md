# node-dash

Real-time Meshtastic mesh network dashboard. Node.js backend consuming mesh-gw via
apiV2. Alpine.js/Tailwind frontend — presentation layer only.

---

## Scope boundary

**This repo only.** Do not read, reference, or modify anything outside
`/usr/share/pac/dev/projects/mt-radar/node-dash/`.

Awareness of mesh-gw APIs is permitted for reference via `docs/gw/` (symlink).
Cross-repo modification is never permitted.

---

## Two domains — never treated as one

Every spec, every test, every task belongs to exactly one domain.

### Domain 1 — Backend (`src/`)

- Owns: gw connection, event ingestion, SQLite storage, node tracking, rotator control,
  traceroute lifecycle, config, all business logic.
- Consumes: mesh-gw via apiV2 only. Reference: `docs/gw/`.
- Exposes: an API for the browser (defined in Phase 2, after Phase 1 is proven).
- Does not know: how the browser renders anything.

### Domain 2 — Browser (`public/`)

- Owns: rendering and user interaction only. Presentation layer.
- Consumes: node-dash backend API only.
- Does not know: that mesh-gw exists. Zero gw API knowledge.
- **Makes zero decisions.** See `docs/BROWSER_CONTRACT.md` — mandatory reading for every browser task.

Mixing these domains in a single spec, task, or test is forbidden.

---

## Development and testing gate

```
[mesh-gw] ←── apiV2 WS/REST ──→ [node-dash backend] ←── WS/REST (TBD) ──→ [browser]
                PHASE 1                                        PHASE 2
```

**Phase 1 must be complete and passing before any Phase 2 work begins.**

Phase 1 complete means:
- All backend modules that touch the gw have a current, passing spec
- Tests prove the backend correctly implements the apiV2 contract
- `python scripts/check_specs.py` exits 0 for all backend specs

No browser-facing spec, code, or test may be written until Phase 1 is complete.

Phase 2 begins by asking: **what does the browser need?**
The browser API is defined from UI requirements — never derived from what the backend
happens to emit.

---

## Failure diagnosis protocol

When something fails, the first question is: **which domain?**

1. Is this a backend fault (gw contract, storage, business logic)?
2. Is this a browser fault (rendering, state, UI logic)?
3. Is it both — a contract mismatch between domains?

Each domain is investigated and fixed independently via its own /idiot task.
No fix may span domains in a single task.

**No hacking. No patches.** If it does not work:
investigate → identify domain → write spec → implement → test → track.
Nothing is "fixed" until it passes a test that proves it.

---

## Workflow — no exceptions

- Responses must be terse unless the user explicitly asks for details.
- Every change goes through `/idiot`. No exceptions, no shortcuts.
- Every task and step is tracked in mcpp-plan. No exceptions.
- No `Edit`, `Write`, or file modification without an active mcpp task and an attached spec.
- `python scripts/check_specs.py` must exit 0 at the end of every `/idiot` task.
  Spec and code must not be out of sync when a task closes.
- If scope grows during implementation, stop. Open a new task. Do not expand in-flight.

---

## Skills

The standing set — `/idiot`, `/xsession`, `/terse`, `/park`, `/handover`,
`/playwright`, `/hallucinate` — plus the gate, absence-checking, tagging and
lead-with-the-defect rules live in **`~/.claude/CLAUDE.md`** and apply to every
project. They are not repeated here.

What is specific to node-dash:

| | |
|---|---|
| xsession channels | `node-dash--plugins`, `device--node-dash`, `mesh-gw--node-dash`, `mcpp-plan--node-dash`, `mt-transport--node-dash`, `mt-radar--node-dash`. **`node-dash--services` is FROZEN** — read it, never write to it; `plugins` succeeded it 2026-08-12. See `docs/PEER_SUCCESSION.md` |
| UI verification | ~1600x1000 **and** 1280x800, both themes. Layout is three checks: `.card-body scrollHeight > clientHeight` (cropped), `.card rect.bottom > innerHeight` (off screen), leaf `rect.bottom > innerHeight` (text cut). |
| page contract tests | `tests/test_page_snapshot.py` — presence, action, truth. One per page; add one when you add a page. |
| task vocabulary | `docs/TASK_VOCABULARY.md` (the global verb set, scoped to this repo's tasks) |
| deploys | pm2, **watch OFF** — `src/` edits need `pm2 restart node-dash`; `public/` is live immediately |

---

## Docs

- `docs/ALARM_TRANSPORT_BOUNDARY.md` — **Meshtastic is the alarm's TRANSPORT, never
  its application.** Alarm units run 100% custom firmware; they appear here as
  ordinary nodes because our radios hear them, but NOTHING about their behaviour
  follows from Meshtastic semantics. Read before touching anything alarm-shaped
- `docs/PEER_SUCCESSION.md` — **who to talk to now, and how to read the old names.**
  ~60 comments cite `services`, who are frozen; the attributions stay, ownership
  follows this file
- `docs/SPEC_INFRA.md` — spec rules and tooling
- `docs/OVERVIEW.md` — architecture (to be written)
- `docs/gw/` — symlink to mesh-gw docs (read-only reference, never modify)
- `docs/API_BACKEND.md` — browser-facing API (Phase 2 only, after Phase 1 proven)
- `docs/API_WS.md` — WebSocket between node-dash and browser (Phase 2 only)
- `docs/modules/` — per-module specs (one file per `src/` module)

---

## /idiot config

- `spec_dir`: `docs/modules/`
- `spec_format`: source_hash frontmatter (template: `docs/modules/_TEMPLATE.md`)
- `validation_cmd`: `python scripts/check_specs.py` — must print `All specs current.`
- `pure_doc_rule`: for files under `docs/` with no backing source file,
  set `source_hash` to the SHA-256 of the doc file itself
