# Task and step naming — the closed verb set

Peter, twice: *"you will NOT use things like B3 and F11, you will use human
readable tags"*, and again on section numbers — **no `§7`, no `B3`, no `4a`, no
"step 3"**.

Anyone reading a line must know what kind of thing it is without a decoder ring,
and must be able to find it by searching for its name.

## The verbs

Every task title, every step title, and every heading in a handover starts with
one of these:

| verb | means |
|---|---|
| `BUG` | broken; the fix is known or findable |
| `GAP` | missing; never built |
| `VERIFY` | built but unproven — needs a measurement before it is trusted |
| `MEASURE` | a number we do not have and need |
| `DISCUSS` | needs agreement before anything is built |
| `DECIDE` | Peter's call; blocked until he makes it |
| `AGREE` | blocked on another session or repo |
| `TOOL` | tooling, harness or script work |
| `TIDY` | housekeeping — closing tasks, deleting junk |

Then plain English:

```
BUG - the callout toggle shows "off" while transmitting
VERIFY - re-measure first-hop-in-beam now the boom is aligned
DECIDE - doors list, shrink hero, or accept in-card scroll below 1000px
```

Never `B7`. Never `step 3`. Never `§4`.

## Handover sections are NAMED

`STATE`, `SHIPPED`, `REMAINS`, `GOT WRONG`, `AVOID`, `TASKS`, `CHECKS`.
Cross-references use the name — "see REMAINS / Snapshot layout" — because a
number breaks the moment a section is inserted and cannot be grepped.

## Retro-fitting existing tasks

`plan_task_rename` and `plan_step_retitle` exist as of 2026-08-05 — shipped by
the mcpp-plan session in response to `[rename-task-step]` on the xsession
channel. Both preserve history: the tool contract says "Preserves all history"
and "without affecting its status, completed_at, or order", and that was checked
rather than trusted — a completed task retitled kept all five steps `complete`
with its goal and plan notes intact.

**So there is no longer an excuse.** Retitle existing tasks and steps to the verb
set as you touch them. Completed steps included: renaming one costs nothing now,
where before it meant delete-and-recreate and losing `completed_at`.

`plan_task_rename` changes the DISPLAY TITLE, not the slug — cross-references and
`plan_task_switch` keep working.

`plan_step_retitle` acts on the ACTIVE task, so switch to it first.

## Scope

**This repo.** node-dash tasks, node-dash steps, node-dash handovers.

Other projects have their own conventions and their own sessions to set them.
Peter has said the same convention elsewhere (`device-open-work`: "you will NOT
use things like B3 and F11"), but that is his instruction to those sessions, not
this repo's to legislate. If another project should adopt it, that is raised on
its xsession channel — not asserted here.
