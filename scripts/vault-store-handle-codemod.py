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
  3. (PR 3) the pin:        a function taking `State<'_, StoreHandle>` begins with
     `let store = store.pin();`, so every step of it, either side of an `await`, acts on the one
     vault that was current when it began (a switch cannot move it to another vault halfway).

Only the lines of the files under `src-tauri/src/` that carry one of these are touched; it prints how many it
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

SRC = Path(__file__).resolve().parent.parent / "src-tauri" / "src"
# vault_source.rs holds the old spellings as test data and is never rewritten.
SKIP = {"vault_source.rs"}

# (pattern, replacement, what it is)
RULES = [
    (
        re.compile(r"State<'(\w+),\s*(?:std::sync::)?Arc<(?:crate::vault::|vault::)?VaultStore>>"),
        r"State<'\1, StoreHandle>",
        "command parameter type",
    ),
    (re.compile(r"\bstore\.inner\(\)"), "store.arc()", "borrow of the managed store"),
]
# Not rewritten, only reported: the app's own wiring owns these.
REPORT = [
    re.compile(r"state::<\s*Arc<VaultStore>"),
    re.compile(r"manage\(Arc::clone\(&store\)\)"),
    re.compile(r"manage\(store\)"),
]


# A parameter whose type is the handle: `State<'_, StoreHandle>` (any path before `State`, any
# lifetime name, any alias for `State`, a qualified handle type), `&StoreHandle`, `StoreHandle`.
PIN_PARAM = re.compile(
    r"(\w+):\s*(?:&\s*(?:'\w+\s+)?(?:mut\s+)?|(?:[\w:]+::)?\w+<\s*'\w+\s*,\s*)?(?:[\w:]+::)?StoreHandle\b"
)


def signature_end(text, start):
    """The offset of the `(` of a `fn name<..>(` whose name starts at `start`, or None."""
    i = start
    while i < len(text) and text[i].isspace():
        i += 1
    if i < len(text) and text[i] == "<":
        depth = 0
        while i < len(text):
            if text[i] == "-" and text[i + 1 : i + 2] == ">":
                i += 2
                continue
            if text[i] == "<":
                depth += 1
            elif text[i] == ">":
                depth -= 1
                if depth == 0:
                    i += 1
                    break
            i += 1
        while i < len(text) and text[i].isspace():
            i += 1
    return i if i < len(text) and text[i] == "(" else None


def add_pins(text):
    """Inserts `let <p> = <p>.pin();` as the first statement of each function taking the handle."""
    out = []
    last = 0
    added = 0
    for match in re.finditer(r"\bfn\s+\w+", text):
        open_at = signature_end(text, match.end())
        if open_at is None:
            continue
        depth = 0
        close = None
        for index in range(open_at, len(text)):
            if text[index] == "(":
                depth += 1
            elif text[index] == ")":
                depth -= 1
                if depth == 0:
                    close = index
                    break
        if close is None:
            continue
        param = PIN_PARAM.search(text[open_at:close])
        if not param:
            continue
        brace = text.find("{", close)
        if brace < 0 or brace < last:
            continue
        semicolon = text.find(";", close)
        if 0 <= semicolon < brace:
            continue  # a declaration with no body
        name = param.group(1)
        wanted = f"let {name} = {name}.pin();"
        after = text[brace + 1 :]
        if after.lstrip().startswith(wanted):
            continue
        indent = re.match(r"\n?([ \t]*)", after).group(1) or "    "
        out.append(text[last : brace + 1])
        out.append(f"\n{indent}{wanted}")
        last = brace + 1
        added += 1
    out.append(text[last:])
    return "".join(out), added


def main(argv):
    check = "--check" in argv
    changed = 0
    for path in sorted(SRC.rglob("*.rs")):
        if path.name in SKIP:
            continue
        text = path.read_text(encoding="utf-8")
        out = []
        file_changed = 0
        for number, line in enumerate(text.split("\n"), 1):
            new = line
            for pattern, replacement, _ in RULES:
                new = pattern.sub(replacement, new)
            if new != line:
                file_changed += 1
            for pattern in REPORT:
                if pattern.search(new):
                    print(f"{path.name}:{number}: wiring to do by hand: {new.strip()}")
            out.append(new)
        new_text, pins = add_pins("\n".join(out))
        changed += file_changed + pins
        if (file_changed or pins) and not check:
            path.write_text(new_text, encoding="utf-8")
    print(f"{changed} line(s) {'need' if check else 'rewritten'}")
    if check:
        return 1 if changed else 0
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
