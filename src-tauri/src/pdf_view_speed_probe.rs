// Scratch timing probe for the PDF reader (never committed). FAKE fixture PDFs only.
// Run: cargo test --offline --locked --lib pdf_view::speed_probe -- --ignored --nocapture --test-threads=1
use super::*;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::ImageEncoder;
use std::time::{Duration, Instant};

const RUNS: usize = 5;

fn fixture(path: &str) -> Vec<u8> {
    std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(path)).unwrap()
}

fn median(mut times: Vec<Duration>) -> f64 {
    times.sort();
    times[times.len() / 2].as_secs_f64() * 1000.0
}

fn time<T>(mut step: impl FnMut() -> T) -> (f64, T) {
    let mut times = Vec::with_capacity(RUNS);
    let mut last = None;
    for _ in 0..RUNS {
        let start = Instant::now();
        let value = step();
        times.push(start.elapsed());
        last = Some(value);
    }
    (median(times), last.unwrap())
}

fn encode(picture: &image::RgbaImage, compression: CompressionType, filter: FilterType) -> Vec<u8> {
    let mut png = Vec::new();
    PngEncoder::new_with_quality(&mut png, compression, filter)
        .write_image(picture.as_raw(), picture.width(), picture.height(), image::ExtendedColorType::Rgba8)
        .unwrap();
    png
}

fn decode(png: &[u8], width: u32, height: u32) -> image::DynamicImage {
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(width);
    limits.max_image_height = Some(height);
    limits.max_alloc = Some(MAX_SIDE as u64 * MAX_SIDE as u64 * 4);
    let mut reader = image::ImageReader::with_format(io::Cursor::new(png), image::ImageFormat::Png);
    reader.limits(limits);
    reader.decode().unwrap()
}

#[test]
#[ignore = "timing probe, run by hand"]
fn reader_speed_probe() {
    use hayro::hayro_interpret::InterpreterSettings;
    use hayro::hayro_syntax::Pdf;
    use hayro::{PixmapSettings, RenderCache, RenderSettings};
    let cases = [
        ("text", "locked-pdf/text-original.pdf"),
        ("image", "locked-pdf/image-original.pdf"),
        ("form", "locked-pdf/form-original.pdf"),
        ("imaging", "reader-lines/FAKE_Morgan_Patient_Imaging_Report.pdf"),
    ];
    let variants = [
        ("fast+adaptive (today)", CompressionType::Fast, FilterType::Adaptive),
        ("fast+up", CompressionType::Fast, FilterType::Up),
        ("fast+sub", CompressionType::Fast, FilterType::Sub),
        ("stored+none", CompressionType::Uncompressed, FilterType::NoFilter),
    ];
    println!("profile: debug_assertions={} (ms are medians of {RUNS})", cfg!(debug_assertions));
    for (name, path) in cases {
        let pdf = fixture(path);
        for width in [1350u32, 2700] {
            let (parse_ms, document) = time(|| Pdf::new(pdf.clone()).ok().expect("FAKE pdf parses"));
            let pages = document.pages();
            let page = pages.get(0).unwrap();
            let (page_width, page_height) = page.render_dimensions();
            let scale = (width as f32 / page_width).min(MAX_SIDE as f32 / page_height);
            let (raster_ms, pixmap) = time(|| {
                hayro::render(
                    page,
                    &RenderCache::new(),
                    &InterpreterSettings::default(),
                    &RenderSettings::default(),
                    &PixmapSettings { x_scale: scale, y_scale: scale, bg_color: hayro::vello_cpu::color::palette::css::WHITE },
                )
            });
            let (w, h) = (u32::from(pixmap.width()), u32::from(pixmap.height()));
            let picture = image::RgbaImage::from_raw(w, h, pixmap.data_as_u8_slice().to_vec()).unwrap();
            let (text_ms, _) = time(|| {
                let text = page_text(&pdf, 0);
                readable_page_text(&pdf, 0, &text)
            });
            let (load_ms, _) = time(|| lopdf::Document::load_mem(&pdf).unwrap());
            let (render_ms, _) = time(|| render(&pdf, "", 0, width).unwrap());
            println!(
                "\n{name} p1 {w}x{h} ({} KiB pdf): hayro parse {parse_ms:.1}, raster {raster_ms:.1}, text total {text_ms:.1} (one lopdf load {load_ms:.1}), whole render() {render_ms:.1}",
                pdf.len() / 1024
            );
            for (label, compression, filter) in variants {
                let (encode_ms, png) = time(|| encode(&picture, compression, filter));
                let (decode_ms, decoded) = time(|| decode(&png, w, h));
                assert_eq!(decoded.to_rgba8().as_raw(), picture.as_raw(), "{label}: lossless");
                let (reencode_ms, clean) = time(|| encode(&decoded.to_rgba8(), compression, filter));
                let (clean_today_ms, _) = time(|| clean_png(&png, w, h).unwrap());
                println!(
                    "  {label:<22} helper encode {encode_ms:7.1} | parent decode {decode_ms:7.1} + re-encode {reencode_ms:7.1} (clean_png today {clean_today_ms:7.1}) | {} KiB -> {} KiB",
                    png.len() / 1024,
                    clean.len() / 1024
                );
            }
        }
    }
}
