# Spec Infrastructure

Defines the structure, tooling, and workflow for module specifications in node-dash.

## Rationale

- No code may be written without a spec that defines it
- Specs and code must match — staleness must be mechanically detectable
- Claude is the primary spec consumer; structure must be unambiguous
- Version control is handled by git; the spec file tracks a `source_hash` to detect drift

## Spec file location

All module specs live in `docs/modules/<module_name>.md`.
Template: `docs/modules/_TEMPLATE.md`

## Frontmatter

Every module spec must begin with YAML frontmatter:

```yaml
---
module: <module_name>
source: <repo-relative path(s) to the file(s) this spec describes>
source_hash: <sha256 of source file at time spec was last updated>
updated: <ISO date>
---
```

`source_hash` is the SHA-256 hex digest of the source file content.
For multi-file modules, it is the SHA-256 of all file contents concatenated in `source` order.

## Pure-doc rule

For spec files that have no backing source file (API references, architecture docs, OVERVIEW.md),
set `source_hash` to the SHA-256 of the spec file itself. This makes the file self-certifying:
any edit to the doc invalidates the hash and forces a deliberate update.

## Standard sections

```
## Purpose
What this module does and does not do. One paragraph, no ambiguity.

## Responsibilities
Concrete bullet list. Each item is something this module owns.

## Dependencies
Other modules this module imports or calls directly.

## Public interface
Every exported function, class, and constant with signature and behavioural contract.

## State
Key mutable state variables or state machine, if any. Omit if stateless.

## Events emitted
Exact event type strings and required fields this module produces. Omit if none.

## Invariants
Rules that must never be broken. Tests are derived from these.

## Test notes
What a test suite for this module must verify. Specific, not vague.

## Out of scope
What belongs in other modules. Prevents scope creep during implementation.
```

All sections are required. Use `_N/A_` for sections that genuinely do not apply.

## Staleness check script

`scripts/check_specs.py` computes the current SHA-256 of each spec's `source` file(s)
and compares against the `source_hash` frontmatter value.

```
Usage:
  python scripts/check_specs.py              # check all module specs
  python scripts/check_specs.py <module>     # check one module by name

Exit codes:
  0 — all specs current
  1 — one or more specs stale, missing source file, or malformed
```

Output flags each stale spec with the module name and both hashes.
Suitable for use as a pre-flight check in the /idiot workflow.

## Workflow integration

Before any Edit/Write to a source file:
1. Run `python scripts/check_specs.py <module>` — must exit 0
2. If stale: update the spec first, then update `source_hash`, then edit code
3. After editing code: re-run the check and update `source_hash` in the spec

`python scripts/check_specs.py` must exit 0 and print `All specs current.` before
any /idiot task may be closed.

## Scope

This file defines the spec system only.
Module specs are in `docs/modules/`.
This file does not specify any module's behaviour.
