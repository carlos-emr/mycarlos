//! The MP4 reader's refusals that `mp4_stream`'s own tests do not reach (coverage batch 1).
//!
//! A recording's bytes come from the webview's muxer, and the stored file is read back for
//! playback, so every length and every field in a `moov`, a `moof` and the trailing index is
//! treated as untrusted: a box that is too short, runs past its parent, or names a time the reader
//! cannot hold is refused with `Malformed` (or `TooLarge`/`Timeline`) and never read past its end.
//! FAKE movies built from the same boxes the other tests use.

use super::fake::*;
use super::*;

fn push_all(stream: &[u8]) -> Result<Mp4Normaliser, Mp4Error> {
    let mut normaliser = Mp4Normaliser::new();
    let mut out = Vec::new();
    normaliser.push(stream, &mut out)?;
    Ok(normaliser)
}

/// A `moov` made of the given children.
fn moov_of(children: &[Vec<u8>]) -> Vec<u8> {
    boxed(b"moov", &children.concat())
}

/// A `trak` whose parts are given (so a part can be left out or damaged).
fn trak_of(parts: &[Vec<u8>]) -> Vec<u8> {
    boxed(b"trak", &parts.concat())
}

fn tkhd(id: u32) -> Vec<u8> {
    let mut payload = vec![0; 8];
    payload.extend_from_slice(&id.to_be_bytes());
    payload.extend_from_slice(&[0; 68]);
    full(b"tkhd", 0, 0, &payload)
}

fn mdhd(timescale: u32) -> Vec<u8> {
    let mut payload = vec![0; 8];
    payload.extend_from_slice(&timescale.to_be_bytes());
    payload.extend_from_slice(&[0; 8]);
    full(b"mdhd", 0, 0, &payload)
}

fn hdlr(handler: &[u8; 4]) -> Vec<u8> {
    let mut payload = vec![0; 4];
    payload.extend_from_slice(handler);
    payload.extend_from_slice(&[0; 12]);
    full(b"hdlr", 0, 0, &payload)
}

fn mdia(parts: &[Vec<u8>]) -> Vec<u8> {
    boxed(b"mdia", &parts.concat())
}

/// A movie box is read when the next byte after it arrives (a box that is only its header has no
/// payload to complete it), so a box that follows is part of the stream here.
fn refused_moov(moov: Vec<u8>) -> Mp4Error {
    let after = boxed(b"free", &[0; 8]);
    push_all(&[ftyp(), moov, after].concat())
        .map(|_| ())
        .unwrap_err()
}

#[test]
fn a_movie_without_a_track_or_with_a_track_missing_a_part_is_malformed() {
    // No track at all, and nothing at all.
    assert_eq!(refused_moov(moov_of(&[])), Mp4Error::Malformed);
    assert_eq!(
        refused_moov(moov_of(&[boxed(b"mvex", &trex(1, 1000))])),
        Mp4Error::Malformed
    );
    // Each part of a track, left out in turn.
    let parts = [tkhd(1), mdia(&[mdhd(30000), hdlr(b"vide")])];
    assert!(push_all(&[ftyp(), moov_of(&[trak_of(&parts)])].concat()).is_ok());
    for without in [
        trak_of(&[mdia(&[mdhd(30000), hdlr(b"vide")])]), // no tkhd
        trak_of(&[tkhd(1)]),                             // no mdia
        trak_of(&[tkhd(1), mdia(&[hdlr(b"vide")])]),     // no mdhd
        trak_of(&[tkhd(1), mdia(&[mdhd(30000)])]),       // no hdlr
    ] {
        assert_eq!(refused_moov(moov_of(&[without])), Mp4Error::Malformed);
    }
}

#[test]
fn a_track_timescale_of_zero_is_malformed_and_a_wide_header_is_read_at_its_own_offset() {
    let zero = trak_of(&[tkhd(1), mdia(&[mdhd(0), hdlr(b"vide")])]);
    assert_eq!(refused_moov(moov_of(&[zero])), Mp4Error::Malformed);
    // Version 1 boxes put the id and the timescale 8 bytes further in.
    let mut wide_tkhd = vec![0; 16];
    wide_tkhd.extend_from_slice(&7_u32.to_be_bytes());
    wide_tkhd.extend_from_slice(&[0; 76]);
    let mut wide_mdhd = vec![0; 16];
    wide_mdhd.extend_from_slice(&90_000_u32.to_be_bytes());
    wide_mdhd.extend_from_slice(&[0; 12]);
    let wide = trak_of(&[
        full(b"tkhd", 1, 0, &wide_tkhd),
        mdia(&[full(b"mdhd", 1, 0, &wide_mdhd), hdlr(b"soun")]),
    ]);
    let normaliser = push_all(&[ftyp(), moov_of(&[wide])].concat()).unwrap();
    let track = &normaliser.init().unwrap().tracks[0];
    assert_eq!(
        (track.id, track.timescale, track.handler),
        (7, 90_000, *b"soun")
    );
}

#[test]
fn a_child_box_that_is_too_short_or_runs_past_its_parent_is_malformed() {
    // A child of size 4 (smaller than its own header).
    let too_short = [0, 0, 0, 4, b'f', b'r', b'e', b'e'];
    assert_eq!(
        refused_moov(boxed(b"moov", &too_short)),
        Mp4Error::Malformed
    );
    // A child that claims more than the parent holds.
    let past_end = [0, 0, 1, 0, b'f', b'r', b'e', b'e', 1, 2, 3, 4];
    assert_eq!(refused_moov(boxed(b"moov", &past_end)), Mp4Error::Malformed);
    // The same inside a track.
    let inner = trak_of(&[]);
    let mut damaged = inner.clone();
    damaged.extend_from_slice(&[0, 0, 0, 3, b'x', b'x', b'x', b'x']);
    let damaged = boxed(b"trak", &damaged[8..]);
    assert_eq!(refused_moov(moov_of(&[damaged])), Mp4Error::Malformed);
}

// ---- a fragment's own fields ------------------------------------------------------------------

fn good_prefix() -> Vec<u8> {
    [ftyp(), moov()].concat()
}

fn moof_of(parts: &[Vec<u8>]) -> Vec<u8> {
    [boxed(b"moof", &parts.concat()), boxed(b"mdat", &[0xAB; 8])].concat()
}

fn mfhd() -> Vec<u8> {
    full(b"mfhd", 0, 0, &1_u32.to_be_bytes())
}

fn tfhd(flags: u32, payload: &[u8]) -> Vec<u8> {
    let mut body = 1_u32.to_be_bytes().to_vec();
    body.extend_from_slice(payload);
    full(b"tfhd", 0, flags, &body)
}

fn tfdt_narrow(value: u32) -> Vec<u8> {
    full(b"tfdt", 0, 0, &value.to_be_bytes())
}

fn trun(flags: u32, count: u32, rest: &[u8]) -> Vec<u8> {
    let mut body = count.to_be_bytes().to_vec();
    body.extend_from_slice(rest);
    full(b"trun", 0, flags, &body)
}

fn refused_moof(parts: &[Vec<u8>]) -> Mp4Error {
    push_all(&[good_prefix(), moof_of(parts)].concat())
        .map(|_| ())
        .unwrap_err()
}

#[test]
fn a_fragment_header_that_is_too_short_or_a_fragment_with_no_track_is_malformed() {
    let traf = boxed(
        b"traf",
        &[tfhd(0, &[]), tfdt_narrow(0), trun(0x200, 1, &[0; 4])].concat(),
    );
    // The baseline passes.
    assert!(push_all(&[good_prefix(), moof_of(&[mfhd(), traf.clone()])].concat()).is_ok());
    // A sequence-number box of 12 bytes is shorter than a full box needs (16).
    assert_eq!(
        refused_moof(&[boxed(b"mfhd", &[0; 4]), traf.clone()]),
        Mp4Error::Malformed
    );
    // No mfhd, and no track fragment, are each refused.
    assert_eq!(
        refused_moof(std::slice::from_ref(&traf)),
        Mp4Error::Malformed
    );
    assert_eq!(refused_moof(&[mfhd()]), Mp4Error::Malformed);
    assert_eq!(
        refused_moof(&[mfhd(), boxed(b"free", &[0; 4])]),
        Mp4Error::Malformed
    );
}

#[test]
fn a_track_fragment_missing_its_header_or_time_or_with_one_cut_short_is_malformed() {
    let run = trun(0x200, 1, &[0; 4]);
    // No tfhd, no tfdt.
    assert_eq!(
        refused_moof(&[
            mfhd(),
            boxed(b"traf", &[tfdt_narrow(0), run.clone()].concat())
        ]),
        Mp4Error::Malformed
    );
    assert_eq!(
        refused_moof(&[
            mfhd(),
            boxed(b"traf", &[tfhd(0, &[]), run.clone()].concat())
        ]),
        Mp4Error::Malformed
    );
    // A wide time box that ends before its 8 bytes of time are all there (it is the last box of
    // the fragment, so there is nothing after it to read instead).
    let cut = full(b"tfdt", 1, 0, &[0; 4]);
    assert_eq!(
        refused_moof(&[
            mfhd(),
            boxed(b"traf", &[tfhd(0, &[]), run.clone(), cut].concat())
        ]),
        Mp4Error::Malformed
    );
}

#[test]
fn a_run_that_claims_more_samples_than_its_box_holds_is_malformed_and_not_read_past() {
    // 0x301: data offset and a duration and a size for each sample; the bytes held are one sample's.
    for count in [2_u32, 1000, u32::MAX] {
        let run = trun(0x301, count, &[0; 4 + 8]);
        let traf = boxed(b"traf", &[tfhd(0, &[]), tfdt_narrow(0), run].concat());
        assert_eq!(
            refused_moof(&[mfhd(), traf]),
            Mp4Error::Malformed,
            "{count}"
        );
    }
    // One sample with exactly its bytes is read.
    let run = trun(0x301, 1, &[0; 4 + 8]);
    let traf = boxed(b"traf", &[tfhd(0, &[]), tfdt_narrow(0), run].concat());
    assert!(push_all(&[good_prefix(), moof_of(&[mfhd(), traf])].concat()).is_ok());
}

// ---- the trailing index and the synthetic head --------------------------------------------------

fn entry(offset: u64, size: u64, start: u64, duration: u64) -> FragmentEntry {
    FragmentEntry {
        offset,
        size,
        start,
        duration,
    }
}

fn init_for_index() -> InitInfo {
    push_all(&good_prefix()).unwrap().init().unwrap().clone()
}

#[test]
fn an_index_trailer_must_be_exactly_the_shape_it_was_written_in() {
    let init = init_for_index();
    let entries = [entry(100, 50, 0, 1000), entry(150, 50, 1000, 1000)];
    let good = index_trailer(&init, &entries).unwrap();
    assert_eq!(parse_index_trailer(&good).unwrap().entries, entries);
    // Shorter than its own footer.
    for cut in [0, 1, 11] {
        assert_eq!(
            parse_index_trailer(&good[good.len() - cut..]),
            Err(Mp4Error::Malformed),
            "{cut}"
        );
    }
    // A timescale of zero, an entry count that does not fit the length, and a wrong box name.
    let mut zero_scale = good.clone();
    zero_scale[16..20].copy_from_slice(&0_u32.to_be_bytes());
    assert_eq!(parse_index_trailer(&zero_scale), Err(Mp4Error::Malformed));
    let mut more_entries = good.clone();
    more_entries[20..24].copy_from_slice(&3_u32.to_be_bytes());
    assert_eq!(parse_index_trailer(&more_entries), Err(Mp4Error::Malformed));
    let mut huge_count = good.clone();
    huge_count[20..24].copy_from_slice(&u32::MAX.to_be_bytes());
    assert_eq!(parse_index_trailer(&huge_count), Err(Mp4Error::Malformed));
    let mut renamed = good.clone();
    renamed[4..8].copy_from_slice(b"free");
    assert_eq!(parse_index_trailer(&renamed), Err(Mp4Error::Malformed));
    // A footer whose own size field is not 12, and one that is not the footer's name.
    let mut footer_size = good.clone();
    let at = footer_size.len() - 12;
    footer_size[at..at + 4].copy_from_slice(&13_u32.to_be_bytes());
    assert_eq!(parse_index_trailer(&footer_size), Err(Mp4Error::Malformed));
    let mut footer_name = good;
    let at = footer_name.len() - 8;
    footer_name[at..at + 4].copy_from_slice(b"mcvz");
    assert_eq!(parse_index_trailer(&footer_name), Err(Mp4Error::Malformed));
}

#[test]
fn an_index_that_a_trailer_cannot_hold_is_refused_when_it_is_written() {
    let init = init_for_index();
    // No movie header, so no primary track to name.
    assert_eq!(
        index_trailer(&InitInfo::default(), &[entry(0, 1, 0, 1)]),
        Err(Mp4Error::NoInit)
    );
    // A size or a duration past 32 bits does not fit an entry.
    let big = u64::from(u32::MAX) + 1;
    assert_eq!(
        index_trailer(&init, &[entry(0, big, 0, 1)]),
        Err(Mp4Error::TooLarge)
    );
    assert_eq!(
        index_trailer(&init, &[entry(0, 1, 0, big)]),
        Err(Mp4Error::TooLarge)
    );
}

fn parsed(entries: Vec<FragmentEntry>) -> ParsedIndex {
    ParsedIndex {
        track_id: 1,
        timescale: 30000,
        entries,
    }
}

#[test]
fn the_synthetic_head_is_refused_for_an_index_it_cannot_describe() {
    let stored = [ftyp(), moov()].concat();
    let head = stored.len() as u64;
    // No fragments at all.
    assert_eq!(
        build_virtual_head(&stored, &parsed(Vec::new())),
        Err(Mp4Error::Malformed)
    );
    // The first fragment starts past the bytes given, and past the most a head can be.
    assert_eq!(
        build_virtual_head(&stored, &parsed(vec![entry(head + 1, 10, 0, 10)])),
        Err(Mp4Error::Malformed)
    );
    let far = (MAX_FTYP + MAX_MOOV + 1) as u64;
    let long = vec![0; far as usize];
    assert_eq!(
        build_virtual_head(&long, &parsed(vec![entry(far, 10, 0, 10)])),
        Err(Mp4Error::Malformed)
    );
    // A fragment that ends past 64 bits, a start that does not fit the sidx, a reference too big
    // for its 31 bits, a duration past 32 bits.
    assert_eq!(
        build_virtual_head(&stored, &parsed(vec![entry(head, u64::MAX, 0, 10)])),
        Err(Mp4Error::TooLarge)
    );
    assert_eq!(
        build_virtual_head(
            &stored,
            &parsed(vec![entry(head, 10, u64::from(u32::MAX) + 1, 10)])
        ),
        Err(Mp4Error::Timeline)
    );
    assert_eq!(
        build_virtual_head(&stored, &parsed(vec![entry(head, 0x8000_0000, 0, 10)])),
        Err(Mp4Error::TooLarge)
    );
    assert_eq!(
        build_virtual_head(
            &stored,
            &parsed(vec![entry(head, 10, 0, u64::from(u32::MAX) + 1)])
        ),
        Err(Mp4Error::Timeline)
    );
    // And a sound one builds, so the refusals above are each the one change.
    assert!(build_virtual_head(&stored, &parsed(vec![entry(head, 10, 0, 10)])).is_ok());
}
