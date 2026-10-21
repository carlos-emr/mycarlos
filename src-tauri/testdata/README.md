# Test data

- `corrupt-object-regressions.json`: damaged encrypted objects the vault must refuse (vault.rs).
- `canvas-photo.jpg`: a 16 x 8 JPEG that Chromium 151 encoded with `canvas.toBlob("image/jpeg",
  0.9)` from a canvas painted half `#1d6fb8`, half `#f2c14e`, as the camera dialog encodes a
  photo. It is SOI, a JFIF header, an sRGB colour profile (APP2), two quantization tables, one
  baseline frame, four Huffman tables, one scan and EOI (777 bytes). The photo tests (photo.rs,
  lib.rs) build every metadata-carrying variant from it. It holds no personal information.
