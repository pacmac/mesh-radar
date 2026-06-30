#!/usr/bin/env python3
"""
check_specs.py — verify module specs are current with their source files.

Reads docs/modules/*.md (excluding _TEMPLATE.md), parses YAML frontmatter,
computes SHA-256 of each spec's source file(s), and compares against
the stored source_hash.

Usage:
    python scripts/check_specs.py              # check all module specs
    python scripts/check_specs.py <module>     # check one module by name

Exit codes:
    0 — all specs current
    1 — one or more specs stale, missing source, or malformed
"""

import hashlib
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SPECS_DIR = REPO_ROOT / "docs" / "modules"


def sha256_of_files(paths: list[Path]) -> str:
    h = hashlib.sha256()
    for p in paths:
        h.update(p.read_bytes())
    return h.hexdigest()


def parse_frontmatter(text: str) -> dict | None:
    """Extract YAML frontmatter from a markdown file. Returns None if absent."""
    if not text.startswith("---"):
        return None
    end = text.find("\n---", 3)
    if end == -1:
        return None
    import yaml
    try:
        return yaml.safe_load(text[3:end])
    except Exception:
        return None


def check_spec(spec_path: Path) -> tuple[str, str, str | None]:
    """
    Returns (status, module_name, detail).
    status: 'ok' | 'stale' | 'error'
    """
    text = spec_path.read_text()
    fm = parse_frontmatter(text)

    module = spec_path.stem

    if not fm:
        return "error", module, "no frontmatter"

    stored_hash = fm.get("source_hash")
    source_field = fm.get("source")

    if not source_field:
        return "error", module, "frontmatter missing 'source'"
    if not stored_hash:
        return "error", module, "frontmatter missing 'source_hash'"
    if stored_hash == "REPLACE_WITH_SHA256":
        return "error", module, "source_hash not yet set"

    sources = [source_field] if isinstance(source_field, str) else source_field
    paths = [REPO_ROOT / s for s in sources]

    missing = [str(p.relative_to(REPO_ROOT)) for p in paths if not p.exists()]
    if missing:
        return "error", module, f"source file(s) not found: {', '.join(missing)}"

    actual_hash = sha256_of_files(paths)
    if actual_hash != stored_hash:
        return "stale", module, f"stored={stored_hash[:12]}…  actual={actual_hash[:12]}…"

    return "ok", module, None


def main():
    filter_module = sys.argv[1] if len(sys.argv) > 1 else None

    specs = sorted(
        p for p in SPECS_DIR.glob("*.md")
        if p.name != "_TEMPLATE.md"
    )

    if filter_module:
        specs = [p for p in specs if p.stem == filter_module]
        if not specs:
            print(f"No spec found for module '{filter_module}'")
            sys.exit(1)

    if not specs:
        print("No module specs found.")
        sys.exit(0)

    width = max(len(p.stem) for p in specs)
    failures = 0

    for spec_path in specs:
        status, module, detail = check_spec(spec_path)
        if status == "ok":
            print(f"  ok      {module}")
        else:
            tag = "STALE  " if status == "stale" else "ERROR  "
            print(f"  {tag} {module:{width}}  {detail}")
            failures += 1

    print()
    if failures:
        print(f"{failures} spec(s) need updating.")
        sys.exit(1)
    else:
        print("All specs current.")
        sys.exit(0)


if __name__ == "__main__":
    main()
