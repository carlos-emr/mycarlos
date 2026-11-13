#!/bin/bash
# SOURCE ONLY. Root admits the outer command; no production/model files are touched.
set -euo pipefail
umask 077
screen_out="${1:?new absolute output directory required}"
case "$screen_out" in /*) ;; *) exit 2 ;; esac
mkdir -m 700 -- "$screen_out"
screen_source="/workspace/codex-astra-first-best-screen-source-20261113/first_best_screen.rs"
screen_rustc="/root/.rustup/toolchains/1.98.0-x86_64-unknown-linux-gnu/bin/rustc"
"$screen_rustc" --version > "$screen_out/rustc-version.txt"
screen_common=(--edition=2021 -C debuginfo=2 -C debug-assertions=yes -C overflow-checks=yes -C panic=unwind -C lto=off -C codegen-units=1)
"$screen_rustc" "${screen_common[@]}" -C opt-level=1 "$screen_source" -o "$screen_out/o1" > "$screen_out/o1-compile.stdout" 2> "$screen_out/o1-compile.stderr"
"$screen_rustc" "${screen_common[@]}" -C opt-level=3 "$screen_source" -o "$screen_out/o3" > "$screen_out/o3-compile.stdout" 2> "$screen_out/o3-compile.stderr"
/usr/bin/sha256sum -- "$screen_source" "$screen_out/o1" "$screen_out/o3" > "$screen_out/artifact-sha256.txt"
"$screen_out/o1" > "$screen_out/o1-A1.jsonl"
"$screen_out/o3" > "$screen_out/o3-B1.jsonl"
"$screen_out/o3" > "$screen_out/o3-B2.jsonl"
"$screen_out/o1" > "$screen_out/o1-A2.jsonl"
