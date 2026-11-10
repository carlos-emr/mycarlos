//! Where a quoted span of a page's text is drawn on the page picture (#292), for "Show in
//! document". Runs only in the PDF helper, beside `pdf_view::render`.
//!
//! The page's text comes from `lopdf` (`pdf_view`'s `readable_text`, the text the AI helper
//! quoted), and its picture from `hayro`. Two libraries, so a span of the text is tied to
//! glyphs on the picture only when they agree, exactly:
//!
//! - hayro draws the page again into a `Device` that keeps, for each glyph, the Unicode text
//!   hayro gives it and its box. The page's own transform puts the boxes in the picture's
//!   space: rotation and the crop box included, so a box is a fraction of the picture at any
//!   width.
//! - Only characters that are not white space are compared (lopdf adds spaces and line
//!   breaks by its own rules), after NFKC (ligatures) and in lower case (small capitals read
//!   in different case). Each character of the span must be lined up with a glyph by a
//!   shortest edit script over the whole page.
//! - Occurrence guard: the span's characters must occur as often in the glyphs as in the
//!   text, and the span, the k-th occurrence in the text, must be lined up with the k-th in
//!   the glyphs, glyph after glyph. Text that hayro draws but lopdf leaves out (a header in a
//!   form XObject, a form field) can then never take the span's boxes, even when it repeats
//!   the span's words.
//! - Every glyph of the span has a known width, is upright or turned a quarter, and lies on
//!   the picture.
//!
//! Otherwise there is no box, and the reason why: never a guessed place (THREAT_MODEL AI-05).
//! The text below the picture still marks the words.
#![cfg_attr(mobile, allow(dead_code))] // Computers only: phones cannot start the helper.

use hayro::hayro_interpret::font::{Glyph, GlyphRun};
use hayro::hayro_interpret::hayro_cmap::BfString;
use hayro::hayro_interpret::util::TransformExt;
use hayro::hayro_interpret::{
    interpret_page, BlendMode, ClipPath, Context, Device, DrawMode, DrawProps, Image,
    ImageDrawProps, InterpreterCache, InterpreterSettings, SoftMask,
};
use hayro::hayro_syntax::page::Page;
use hayro::kurbo::{Affine, BezPath, Point, Rect};
use unicode_normalization::UnicodeNormalization;

/// The most bytes of quoted text a request carries.
pub(crate) const MAX_SPAN_TEXT_BYTES: usize = 64 * 1024;
/// The most rectangles one span may take: more is no box at all.
pub(crate) const MAX_LINES: usize = 256;
/// A side of a box, in 1/65,535 of the picture's width or height.
pub(crate) const UNIT: f64 = 65_535.0;
/// The most edits the two libraries' characters may differ by on one page. More, and the page
/// gets no boxes: the edit script's memory grows with its square (36 MB at this limit).
const MAX_EDITS: usize = 3_000;
/// A glyph's height, in its own 1000-unit space: about a line's ink, descender to ascender.
const DESCENT: f64 = -220.0;
const ASCENT: f64 = 800.0;

/// A rectangle on the page picture: x0, y0, x1, y1 in `UNIT`s, top-left origin, x0 < x1 and
/// y0 < y1.
pub(crate) type Rect16 = [u16; 4];

/// Why a span gets no box. The codes are the helper's answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Absent {
    /// The page has no text (a scan): nothing can be quoted from it.
    NoText,
    /// The span's text is not what the page's text holds there.
    TextDiffers,
    /// Some character of the span does not line up with exactly one glyph.
    Unaligned,
    /// A glyph of the span is set at an angle.
    Skewed,
    /// A glyph of the span lies outside the picture (the crop box cuts it).
    OutsidePage,
    /// A glyph of the span has no known width.
    NoWidth,
    /// The span would take more than `MAX_LINES` rectangles.
    TooManyLines,
    /// The span holds only white space.
    Empty,
}

impl Absent {
    pub(crate) fn code(self) -> u8 {
        match self {
            Absent::NoText => 1,
            Absent::TextDiffers => 2,
            Absent::Unaligned => 3,
            Absent::Skewed => 4,
            Absent::OutsidePage => 5,
            Absent::NoWidth => 6,
            Absent::TooManyLines => 7,
            Absent::Empty => 8,
        }
    }

    #[cfg_attr(mobile, allow(dead_code))]
    pub(crate) fn from_code(code: u8) -> Option<Self> {
        Some(match code {
            1 => Absent::NoText,
            2 => Absent::TextDiffers,
            3 => Absent::Unaligned,
            4 => Absent::Skewed,
            5 => Absent::OutsidePage,
            6 => Absent::NoWidth,
            7 => Absent::TooManyLines,
            8 => Absent::Empty,
            _ => return None,
        })
    }

    /// For the app's answer: a stable name, never shown to the patient.
    pub(crate) fn name(self) -> &'static str {
        match self {
            Absent::NoText => "noText",
            Absent::TextDiffers => "textDiffers",
            Absent::Unaligned => "unaligned",
            Absent::Skewed => "skewed",
            Absent::OutsidePage => "outsidePage",
            Absent::NoWidth => "noWidth",
            Absent::TooManyLines => "tooManyLines",
            Absent::Empty => "empty",
        }
    }
}

/// Which way a glyph's line runs across the picture.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Direction {
    Right,
    Left,
    Down,
    Up,
}

/// One glyph as hayro draws it.
struct GlyphBox {
    /// Its Unicode text; `None` when hayro cannot tell.
    text: Option<String>,
    /// x0, y0, x1, y1 in the picture's space at scale 1; NaN when its width is unknown.
    rect: [f64; 4],
    /// Which way its line runs; `None` when it is neither upright nor turned a quarter.
    direction: Option<Direction>,
}

#[derive(Default)]
struct Collector {
    glyphs: Vec<GlyphBox>,
    /// The last run's matrices: a fill-and-stroke run is drawn twice, and counted once.
    last_run: Vec<[f64; 6]>,
}

impl<'a> Device<'a> for Collector {
    fn draw_path(&mut self, _: &BezPath, _: DrawProps<'a>, _: &DrawMode) {}
    fn push_clip_path(&mut self, _: &ClipPath) {}
    fn push_transparency_group(&mut self, _: f32, _: Option<SoftMask<'a>>, _: BlendMode) {}
    fn draw_image(&mut self, _: Image<'a, '_>, _: ImageDrawProps<'a>) {}
    fn pop_clip(&mut self) {}
    fn pop_transparency_group(&mut self) {}

    fn draw_glyph_run(&mut self, run: &GlyphRun<'_, 'a>, props: DrawProps<'a>, _: &DrawMode) {
        let glyphs = run.glyphs();
        let matrices: Vec<[f64; 6]> = glyphs
            .iter()
            .map(|glyph| (props.transform * glyph.transform()).as_coeffs())
            .collect();
        if matrices == self.last_run {
            return;
        }
        for (index, glyph) in glyphs.iter().enumerate() {
            let matrix = Affine::new(matrices[index]);
            let advance = match &**glyph {
                Glyph::Outline(outline) => outline.advance_width().map(f64::from),
                Glyph::Type3(_) => None,
            }
            .filter(|width| width.is_finite() && *width > 0.0)
            .or_else(|| {
                // No width: the next glyph's origin on the same line, in this glyph's space.
                let next = matrices.get(index + 1)?;
                let origin = matrix.inverse() * Point::new(next[4], next[5]);
                (origin.x > 0.0 && origin.y.abs() < 1.0).then_some(origin.x)
            });
            // The glyph's own x axis on the picture (whose y runs down) is (a, b).
            let [a, b, c, d, _, _] = matrices[index];
            let small = |p: f64, q: f64| p.abs() <= 1e-6 * q.abs().max(1e-12);
            let direction = if small(b, a) && small(c, d) {
                Some(if a > 0.0 {
                    Direction::Right
                } else {
                    Direction::Left
                })
            } else if small(a, b) && small(d, c) {
                Some(if b > 0.0 {
                    Direction::Down
                } else {
                    Direction::Up
                })
            } else {
                None
            };
            let rect = match advance {
                Some(width) => {
                    let corners = [
                        matrix * Point::new(0.0, DESCENT),
                        matrix * Point::new(width, DESCENT),
                        matrix * Point::new(0.0, ASCENT),
                        matrix * Point::new(width, ASCENT),
                    ];
                    let (xs, ys) = (corners.map(|p| p.x), corners.map(|p| p.y));
                    [
                        xs.iter().copied().fold(f64::INFINITY, f64::min),
                        ys.iter().copied().fold(f64::INFINITY, f64::min),
                        xs.iter().copied().fold(f64::NEG_INFINITY, f64::max),
                        ys.iter().copied().fold(f64::NEG_INFINITY, f64::max),
                    ]
                }
                None => [f64::NAN; 4],
            };
            let text = glyph.as_unicode().map(|unicode| match unicode {
                BfString::Char(c) => c.to_string(),
                BfString::String(s) => s,
            });
            self.glyphs.push(GlyphBox {
                text,
                rect,
                direction,
            });
        }
        self.last_run = matrices;
    }
}

/// Every glyph hayro draws on `page`, in drawing order, and the picture's size at scale 1.
fn collect(page: &Page<'_>) -> (Vec<GlyphBox>, f64, f64) {
    let (width, height) = page.render_dimensions();
    let cache = InterpreterCache::new();
    let mut context = Context::new(
        page.initial_transform(true).to_kurbo(),
        Rect::new(0.0, 0.0, f64::from(width), f64::from(height)),
        &cache,
        page.xref(),
        InterpreterSettings::default(),
    );
    let mut collector = Collector::default();
    interpret_page(page, &mut context, &mut collector);
    (collector.glyphs, f64::from(width), f64::from(height))
}

/// A character as compared: NFKC, lower case.
fn fold(c: char) -> char {
    c.to_lowercase().next().unwrap_or(c)
}

/// The page text's characters that are not white space, each with where its source
/// character sits in the text, in UTF-16 units.
fn text_units(text: &str) -> Vec<(char, usize, usize)> {
    let mut units = Vec::new();
    let mut at = 0;
    for c in text.chars() {
        let end = at + c.len_utf16();
        for n in c.to_string().nfkc() {
            if !n.is_whitespace() {
                units.push((fold(n), at, end));
            }
        }
        at = end;
    }
    units
}

/// The glyphs' characters that are not white space, each with its glyph. A glyph hayro
/// cannot name is one character that matches nothing.
fn glyph_units(glyphs: &[GlyphBox]) -> Vec<(char, usize)> {
    let mut units = Vec::new();
    for (index, glyph) in glyphs.iter().enumerate() {
        match &glyph.text {
            None => units.push(('\u{FFFD}', index)),
            Some(text) => units.extend(
                text.nfkc()
                    .filter(|c| !c.is_whitespace() && *c != '\0')
                    .map(|c| (fold(c), index)),
            ),
        }
    }
    units
}

/// For each character of `a`, the character of `b` it equals in a shortest edit script
/// (Myers), or `None` where they differ. `None` overall past `max_d` edits.
fn edit_map(a: &[char], b: &[char], max_d: usize) -> Option<Vec<Option<usize>>> {
    let (n, m) = (a.len() as i64, b.len() as i64);
    let limit = max_d.min(a.len() + b.len()) as i64;
    let offset = limit + 1;
    let mut v = vec![0i64; (2 * limit + 3) as usize];
    // The frontier before each round d, for k in -d..=d: what the walk back needs.
    let mut trace: Vec<Vec<i64>> = Vec::new();
    let mut end = None;
    'rounds: for d in 0..=limit {
        trace.push(v[(offset - d) as usize..=(offset + d) as usize].to_vec());
        let mut k = -d;
        while k <= d {
            let at = (k + offset) as usize;
            let mut x = if k == -d || (k != d && v[at - 1] < v[at + 1]) {
                v[at + 1]
            } else {
                v[at - 1] + 1
            };
            let mut y = x - k;
            while x < n && y < m && a[x as usize] == b[y as usize] {
                x += 1;
                y += 1;
            }
            v[at] = x;
            if x >= n && y >= m {
                end = Some(d);
                break 'rounds;
            }
            k += 2;
        }
    }
    let end = end?;
    let mut map = vec![None; a.len()];
    let (mut x, mut y) = (n, m);
    for d in (0..=end).rev() {
        let before = &trace[d as usize];
        let get = |k: i64| before[(k + d) as usize];
        let k = x - y;
        let previous = if k == -d || (k != d && get(k - 1) < get(k + 1)) {
            k + 1
        } else {
            k - 1
        };
        let previous_x = if d == 0 { 0 } else { get(previous) };
        let previous_y = if d == 0 { 0 } else { previous_x - previous };
        while x > previous_x && y > previous_y {
            x -= 1;
            y -= 1;
            map[x as usize] = Some(y as usize);
        }
        x = previous_x;
        y = previous_y;
    }
    Some(map)
}

/// Every place `needle` starts in `hay`.
fn occurrences(hay: &[char], needle: &[char]) -> Vec<usize> {
    if needle.is_empty() || needle.len() > hay.len() {
        return Vec::new();
    }
    (0..=hay.len() - needle.len())
        .filter(|&at| hay[at..at + needle.len()] == *needle)
        .collect()
}

/// Whether glyph box `next`, running `direction`, carries on the line run `line` running the
/// same way: it shares most of the line's band across that direction and comes next along it,
/// a few character heights away at most (spaces have no glyph).
fn continues(line: &([f64; 4], Direction), next: &[f64; 4], direction: Direction) -> bool {
    let (rect, way) = line;
    if *way != direction {
        return false;
    }
    let overlap = |a0: f64, a1: f64, b0: f64, b1: f64| (a1.min(b1) - a0.max(b0)).max(0.0);
    let across = |r: &[f64; 4]| match direction {
        Direction::Right | Direction::Left => (r[1], r[3]),
        Direction::Down | Direction::Up => (r[0], r[2]),
    };
    let ((l0, l1), (n0, n1)) = (across(rect), across(next));
    let size = (l1 - l0).max(n1 - n0);
    if overlap(l0, l1, n0, n1) < 0.5 * (l1 - l0).min(n1 - n0) {
        return false;
    }
    // The gap from the line's end to the glyph, along the direction, and that it moves on.
    let (gap, onward) = match direction {
        Direction::Right => (next[0] - rect[2], next[0] >= rect[0]),
        Direction::Left => (rect[0] - next[2], next[2] <= rect[2]),
        Direction::Down => (next[1] - rect[3], next[1] >= rect[1]),
        Direction::Up => (rect[1] - next[3], next[3] <= rect[3]),
    };
    onward && gap <= 3.0 * size && gap >= -0.5 * size
}

/// The rectangles on `page`'s picture of the span `start..end` (UTF-16 units) of `text`, the
/// page's `readable_text`, which must hold `quoted` there. One rectangle per line run.
pub(crate) fn span_boxes(
    page: &Page<'_>,
    text: &str,
    start: usize,
    end: usize,
    quoted: &str,
) -> Result<Vec<Rect16>, Absent> {
    if text.trim().is_empty() {
        return Err(Absent::NoText);
    }
    let units16: Vec<u16> = text.encode_utf16().collect();
    if start >= end
        || end > units16.len()
        || units16[start..end] != *quoted.encode_utf16().collect::<Vec<_>>()
    {
        return Err(Absent::TextDiffers);
    }
    let text_units = text_units(text);
    let span: Vec<usize> = (0..text_units.len())
        .filter(|&i| text_units[i].1 >= start && text_units[i].2 <= end)
        .collect();
    let (Some(&first), Some(&last)) = (span.first(), span.last()) else {
        return Err(Absent::Empty);
    };
    let (glyphs, width, height) = collect(page);
    let glyph_units = glyph_units(&glyphs);
    let a: Vec<char> = text_units.iter().map(|unit| unit.0).collect();
    let b: Vec<char> = glyph_units.iter().map(|unit| unit.0).collect();
    let map = edit_map(&a, &b, MAX_EDITS).ok_or(Absent::Unaligned)?;
    // The occurrence guard: the k-th occurrence in the text is the k-th in the glyphs, and the
    // edit script ties each of its characters to that one, in order.
    let needle = &a[first..=last];
    let in_text = occurrences(&a, needle);
    let in_glyphs = occurrences(&b, needle);
    let k = in_text
        .iter()
        .position(|&at| at == first)
        .filter(|_| in_text.len() == in_glyphs.len())
        .ok_or(Absent::Unaligned)?;
    if (0..needle.len()).any(|i| map[first + i] != Some(in_glyphs[k] + i)) {
        return Err(Absent::Unaligned);
    }
    let mut chosen: Vec<usize> = Vec::new();
    for unit in &glyph_units[in_glyphs[k]..in_glyphs[k] + needle.len()] {
        if chosen.last() != Some(&unit.1) {
            chosen.push(unit.1);
        }
    }
    let mut lines: Vec<([f64; 4], Direction)> = Vec::new();
    for index in chosen {
        let glyph = &glyphs[index];
        let rect = glyph.rect;
        if rect.iter().any(|value| !value.is_finite()) {
            return Err(Absent::NoWidth);
        }
        let Some(direction) = glyph.direction else {
            return Err(Absent::Skewed);
        };
        const TOLERANCE: f64 = 0.5;
        if rect[0] < -TOLERANCE
            || rect[1] < -TOLERANCE
            || rect[2] > width + TOLERANCE
            || rect[3] > height + TOLERANCE
        {
            return Err(Absent::OutsidePage);
        }
        match lines.last_mut() {
            Some(line) if continues(line, &rect, direction) => {
                let union = &mut line.0;
                union[0] = union[0].min(rect[0]);
                union[1] = union[1].min(rect[1]);
                union[2] = union[2].max(rect[2]);
                union[3] = union[3].max(rect[3]);
            }
            _ => lines.push((rect, direction)),
        }
    }
    if lines.len() > MAX_LINES {
        return Err(Absent::TooManyLines);
    }
    // Rounded outwards, so a rectangle never cuts its words.
    let unit = |value: f64, size: f64, up: bool| {
        let scaled = (value / size).clamp(0.0, 1.0) * UNIT;
        (if up { scaled.ceil() } else { scaled.floor() }) as u16
    };
    Ok(lines
        .into_iter()
        .map(|(r, _)| {
            let (x0, y0) = (unit(r[0], width, false), unit(r[1], height, false));
            let (mut x1, mut y1) = (unit(r[2], width, true), unit(r[3], height, true));
            if x1 <= x0 {
                x1 = x0.saturating_add(1);
            }
            if y1 <= y0 {
                y1 = y0.saturating_add(1);
            }
            [x0.min(u16::MAX - 1), y0.min(u16::MAX - 1), x1, y1]
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chars(s: &str) -> Vec<char> {
        s.chars().collect()
    }

    #[test]
    fn the_edit_script_ties_only_equal_characters_in_order() {
        for (a, b) in [
            ("abcdef", "abcdef"),
            ("abcdef", "xxabcdefyy"),
            ("abXdef", "abYdef"),
            ("Page1ofbody", "body"),
            ("", "abc"),
            ("abc", ""),
            ("aaaa", "aa"),
        ] {
            let (a, b) = (chars(a), chars(b));
            let map = edit_map(&a, &b, 100).unwrap();
            let mut last = None;
            for (i, tied) in map.iter().enumerate() {
                if let Some(j) = tied {
                    assert_eq!(a[i], b[*j]);
                    assert!(last.is_none_or(|l| *j > l));
                    last = Some(*j);
                }
            }
        }
        let map = edit_map(&chars("abcdef"), &chars("abZZdef"), 100).unwrap();
        assert_eq!(map.iter().filter(|m| m.is_some()).count(), 5);
        // Past the limit: no map at all, never a partial guess.
        assert!(edit_map(&chars("abcdef"), &chars("uvwxyz"), 3).is_none());
    }

    #[test]
    fn absent_codes_round_trip() {
        for absent in [
            Absent::NoText,
            Absent::TextDiffers,
            Absent::Unaligned,
            Absent::Skewed,
            Absent::OutsidePage,
            Absent::NoWidth,
            Absent::TooManyLines,
            Absent::Empty,
        ] {
            assert_eq!(Absent::from_code(absent.code()), Some(absent));
        }
        assert_eq!(Absent::from_code(0), None);
        assert_eq!(Absent::from_code(9), None);
    }

    #[test]
    fn a_line_run_continues_only_along_its_own_line() {
        let right = ([10.0, 100.0, 50.0, 112.0], Direction::Right);
        assert!(continues(
            &right,
            &[52.0, 100.0, 58.0, 112.0],
            Direction::Right
        ));
        assert!(continues(
            &right,
            &[60.0, 101.0, 66.0, 112.0],
            Direction::Right
        )); // a space
        assert!(!continues(
            &right,
            &[10.0, 118.0, 16.0, 130.0],
            Direction::Right
        )); // next line
        assert!(!continues(
            &right,
            &[300.0, 100.0, 306.0, 112.0],
            Direction::Right
        )); // a cell on
        assert!(!continues(
            &right,
            &[52.0, 100.0, 58.0, 112.0],
            Direction::Down
        ));
        // A page turned half way: the line runs leftwards on the picture.
        let left = ([50.0, 100.0, 90.0, 112.0], Direction::Left);
        assert!(continues(
            &left,
            &[42.0, 100.0, 48.0, 112.0],
            Direction::Left
        ));
        assert!(!continues(
            &left,
            &[92.0, 100.0, 98.0, 112.0],
            Direction::Left
        ));
        // Turned a quarter: the line runs down, or up.
        let down = ([100.0, 10.0, 112.0, 50.0], Direction::Down);
        assert!(continues(
            &down,
            &[100.0, 52.0, 112.0, 58.0],
            Direction::Down
        ));
        assert!(!continues(
            &down,
            &[118.0, 10.0, 130.0, 16.0],
            Direction::Down
        ));
        let up = ([100.0, 50.0, 112.0, 90.0], Direction::Up);
        assert!(continues(&up, &[100.0, 42.0, 112.0, 48.0], Direction::Up));
    }
}
