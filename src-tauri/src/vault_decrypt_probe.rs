// Scratch timing probe (never committed): how long `read_for_view` takes to decrypt an 11 MB
// FAKE object, as a page view does. Run:
// cargo test --offline --locked --lib vault::decrypt_probe -- --ignored --nocapture --test-threads=1
use super::*;
use std::time::Instant;

const SIZE: usize = 11 * 1024 * 1024;
const RUNS: usize = 5;

#[test]
#[ignore = "timing probe, run by hand"]
fn read_for_view_speed_probe() {
    let temp = tempfile::tempdir().unwrap();
    let store = VaultStore::new(temp.path().join("home").join("vault-v1"));
    store
        .create("river-azimuth-cobalt-sparrow-934", "FAKE Probe", 1)
        .unwrap();
    let profile = store.snapshot().unwrap().profiles[0].id;
    // Deterministic, incompressible-looking FAKE bytes behind a PDF header.
    let mut bytes = b"%PDF-1.7\n% FAKE scan for a timing probe\n".to_vec();
    let mut state = 0x2545_f491_4f6c_dd1d_u64;
    while bytes.len() < SIZE {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        bytes.extend_from_slice(&state.to_le_bytes());
    }
    bytes.truncate(SIZE);
    let started = Instant::now();
    let record = store
        .import(
            profile,
            vec![],
            vec![ImportSource {
                display_name: "FAKE scan.pdf".into(),
                reader: Box::new(io::Cursor::new(bytes.clone())),
            }],
            2,
        )
        .unwrap()
        .imported[0];
    let import_ms = started.elapsed().as_secs_f64() * 1000.0;
    let mut times = Vec::with_capacity(RUNS);
    for _ in 0..RUNS {
        let mut document = zeroize::Zeroizing::new(Vec::with_capacity(SIZE));
        let started = Instant::now();
        store.read_for_view(record, &mut *document).unwrap();
        times.push(started.elapsed().as_secs_f64() * 1000.0);
        assert_eq!(document.as_slice(), bytes.as_slice(), "the same bytes back");
    }
    times.sort_by(f64::total_cmp);
    let median = times[RUNS / 2];
    println!(
        "DECRYPT debug_assertions={} size={} MiB: read_for_view median {median:.1} ms ({:.0} MB/s), runs {:?}; import (encrypt) {import_ms:.1} ms",
        cfg!(debug_assertions),
        SIZE / (1024 * 1024),
        SIZE as f64 / 1e6 / (median / 1000.0),
        times.iter().map(|t| format!("{t:.0}")).collect::<Vec<_>>()
    );
}
