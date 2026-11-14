#!/bin/bash
# Execute only after a separately issued bounded scheduling grant.
# Args: fresh absolute scratch directory, Cargo1.98 toolchain bin directory.
set -euo pipefail
if [ "$#" -ne 2 ]; then
  printf 'usage: %s FRESH_SCRATCH_DIR CARGO198_TOOLCHAIN_BIN\n' "$0" >&2
  exit 64
fi
source_dir=$(cd -- "$(dirname -- "$0")" && pwd -P)
exec /usr/bin/timeout --signal=TERM --kill-after=1s 14s /usr/bin/taskset -c 0 /usr/bin/nice -n 19 /usr/bin/python3 -I -B "$source_dir/run-toy.py" --run-dir "$1" --toolchain-bin "$2" --root-authorized-15s
