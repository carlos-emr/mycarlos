# Persistent CPU pool prototype

This is an experimental source backup. It has not been built or evaluated, and no
speedup or adoption is claimed. The helper calls `enable_cpu_threadpool`, which is
absent from the published dependency. This branch does **not** compile against its
unchanged registry dependency until the binding patch below is integrated.

The prototype creates a context-owned CPU worker pool on the first generation
after answer confinement. Rebuilt contexts receive their own pool. The binding
synchronizes work, destroys the context and its backend, then frees and joins the
workers. It uses public native APIs and retains default affinity, priority and
polling. Persistent idle polling could offset any saved worker setup time.

The helper change is commit `53bbe025f3f3094860482772fb5bc0e2feb8b48b` and builds
on the separate timing candidate `3026be44422a8b504f8b526025175ee2eed017ae`.
The accompanying patch preserves the required binding change to
`llama-cpp-2` version `0.1.160`, licensed upstream as MIT OR Apache-2.0.
Only `src/context.rs` changes; the sys crate and native sources are unchanged.

| Artifact | SHA-256 |
| --- | --- |
| Published `llama-cpp-2-0.1.160.crate` archive | `b98e9f0971b7454a25a550f0bd4577f35b94570be32f8f8dc08d94f4cb2873fe` |
| `llama-cpp-2-owned-pool.patch` | `b60dee91c33dd284af067c8091f21b468d96315031742c511db63d2f3a8ce446` |
| Patched `src/context.rs` | `d66dadbe044fd00ae2205d20ea058f62568e21d069a9f827cb2e7a576b0a8985` |

To recover the experimental binding, obtain the exact published crate archive,
verify its checksum, and extract it into a separate working directory. Apply
`patch -p1 --fuzz=0` from that extracted crate directory using the accompanying
patch, then verify the patched file checksum. Do not patch Cargo's shared registry.

Before any build, integrate the recovered crate using a local
`patch.crates-io.llama-cpp-2.path` override or a reviewed repository dependency
change. Resolve and inspect the lockfile change in this experimental checkout.
Dependency provenance, licensing, audit and packaging checks need to cover that
integration. This backup intentionally leaves the manifest and lockfile unchanged.

Source review, Rust formatting and exact patch reconstruction passed. Compilation,
the existing sandbox and context-reconstruction tests, actual worker lifetime and
cleanup checks, Windows checks, and controlled speed and quality comparisons are
still required. A successful patch application establishes source reproducibility
only.
