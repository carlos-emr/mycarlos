#!/usr/bin/env python3
"""Moves vault commands from `State<'_, Arc<VaultStore>>` to `State<'_, StoreHandle>` (#357, PR 2).

The multi-vault design needs commands to ask a `StoreHandle` (src-tauri/src/vault_source.rs) for "the"
vault instead of holding one `Arc<VaultStore>`. The change to every command is the same two rewrites,
so it is made by this script and not by hand, and it can be run again over a command that another
change adds with the old type after this one merges (`no_command_takes_the_store_directly` in
vault_source.rs fails until it is):

  1. the parameter type:   State<'_, Arc<VaultStore>>   ->  State<'_, StoreHandle>
  2. the borrow of it:     store.inner()                 ->  store.arc()
     (`StoreHandle::arc` gives the same `&Arc<VaultStore>` that `State::inner` gave.)

Only the lines of `src-tauri/src/lib.rs` that carry one of these are touched; it prints how many it
changed and exits 0 when there is nothing to do, so it is safe to run twice. It does not touch the
app's setup, its idle thread, its shutdown hook or the test apps: those are the manual part of the PR,
and a command added with the old type through `app.state::<Arc<VaultStore>>()` is reported, not fixed.

Usage (from the repository root):
  python3 scripts/vault-store-handle-codemod.py [--check]   then   cargo fmt   (in src-tauri)
  --check  change nothing; exit 1 when a rewrite is still needed.
The shorter lines let rustfmt join some wrapped ones, so run `cargo fmt` after it.
"""
import re
import sys
from pathlib import Path

LIB = Path(__file__).resolve().parent.parent / "src-tauri" / "src" / "lib.rs"

# (pattern, replacement, what it is)
RULES = [
    (re.compile(r"State<'_,\s*Arc<VaultStore>>"), "State<'_, StoreHandle>", "command parameter type"),
    (re.compile(r"\bstore\.inner\(\)"), "store.arc()", "borrow of the managed store"),
]
# Not rewritten, only reported: the app's own wiring owns these.
REPORT = [re.compile(r"state::<Arc<VaultStore>>"), re.compile(r"manage\(Arc::clone\(&store\)\)")]


def main(argv):
    check = "--check" in argv
    text = LIB.read_text(encoding="utf-8")
    changed = 0
    out = []
    for number, line in enumerate(text.split("\n"), 1):
        new = line
        for pattern, replacement, _ in RULES:
            new = pattern.sub(replacement, new)
        if new != line:
            changed += 1
        for pattern in REPORT:
            if pattern.search(new):
                print(f"{LIB.name}:{number}: wiring to do by hand: {new.strip()}")
        out.append(new)
    print(f"{changed} line(s) {'need' if check else 'rewritten'}")
    if check:
        return 1 if changed else 0
    if changed:
        LIB.write_text("\n".join(out), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
