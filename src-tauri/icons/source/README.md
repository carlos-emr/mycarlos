# CARLOS app icon sources

Every platform's icon is the CARLOS logo, made from one picture: `carlos-logo-460.jpg`, the
carlos-emr GitHub organisation's picture (https://avatars.githubusercontent.com/u/123763729?v=4,
460 x 460 px JPEG, white background), kept byte for byte. The old heart icon (`app-icon.svg`) was
removed from the repository: nothing referenced it once macOS and iOS also moved to the logo (it is
in git history).

Rules used, so no file has the figure stretched:

- **direct**: the 460 px picture scaled down (Lanczos) to the file's size; nothing is enlarged.
- **padded**: the unscaled 460 px picture on a white canvas of the file's size, even margin
  (`icon.png` 512 px: 26 px each side; the `.icns` 512 px entry the same).
- **upscaled (soft)**: only where padding would leave the figure too small: the 1,024 px macOS
  entry and the 1,024 px iOS marketing icon place the picture at 800 px (x1.74) on a white
  1,024 px canvas. These are soft until a larger original exists.
- Android: the picture is scaled to 0.623 and centred on white so that its farthest point sits
  about 8% inside the adaptive icon's 66 dp safe circle, then `tauri icon` makes the files.
- iOS files have no alpha channel (white background, RGB PNG).
- At 16 px the figure is mush and only the blue hexagon reads; a simplified small-size mark would
  be a separate design job.

## Commands

    # Windows, Linux PNGs, Square/Store logos, iOS (<= 180 px), from the picture itself
    npx tauri icon src-tauri/icons/source/carlos-logo-460.jpg -o <empty dir>
    # Android, from the safe-zone master (android-master-safe-zone.png, made from the picture with Pillow)
    npx tauri icon src-tauri/icons/source/android-master-safe-zone.png -o <empty dir>
    # copy only <dir>/android/* into src-tauri/icons/android/

`icon.png`, the `.icns` 512 and 1,024 px entries and `ios/AppIcon-512@2x.png` were composed with
Pillow as described above (the `.icns` is written entry by entry, ten PNG entries as before);
the iOS files were flattened onto white so they carry no alpha.
`scripts/configure-android-security.mjs` (run by `npm run android:secure` after
`tauri android init`) copies `src-tauri/icons/android/` into the generated project's `res` folder.

## Every icon file

| File | Size (px) | How |
|---|---|---|
| `128x128.png` | 128x128 | direct |
| `128x128@2x.png` | 256x256 | direct |
| `32x32.png` | 32x32 | direct |
| `64x64.png` | 64x64 | direct |
| `Square107x107Logo.png` | 107x107 | direct |
| `Square142x142Logo.png` | 142x142 | direct |
| `Square150x150Logo.png` | 150x150 | direct |
| `Square284x284Logo.png` | 284x284 | direct |
| `Square30x30Logo.png` | 30x30 | direct |
| `Square310x310Logo.png` | 310x310 | direct |
| `Square44x44Logo.png` | 44x44 | direct |
| `Square71x71Logo.png` | 71x71 | direct |
| `Square89x89Logo.png` | 89x89 | direct |
| `StoreLogo.png` | 50x50 | direct |
| `icon.png` | 512x512 | padded |
| `icon.ico` | 16, 24, 32, 48, 64, 256 | direct |
| `icon.icns` | 16, 32 (x1, x2), 128, 256 (x1, x2), 512 (x1, x2 = 1024) | 16 to 256: direct; 512: padded; 1024 (512@2x): upscaled (soft) |
| `ios/AppIcon-20x20@1x.png` | 20x20 | direct |
| `ios/AppIcon-20x20@2x-1.png` | 40x40 | direct |
| `ios/AppIcon-20x20@2x.png` | 40x40 | direct |
| `ios/AppIcon-20x20@3x.png` | 60x60 | direct |
| `ios/AppIcon-29x29@1x.png` | 29x29 | direct |
| `ios/AppIcon-29x29@2x-1.png` | 58x58 | direct |
| `ios/AppIcon-29x29@2x.png` | 58x58 | direct |
| `ios/AppIcon-29x29@3x.png` | 87x87 | direct |
| `ios/AppIcon-40x40@1x.png` | 40x40 | direct |
| `ios/AppIcon-40x40@2x-1.png` | 80x80 | direct |
| `ios/AppIcon-40x40@2x.png` | 80x80 | direct |
| `ios/AppIcon-40x40@3x.png` | 120x120 | direct |
| `ios/AppIcon-512@2x.png` | 1024x1024 | upscaled (soft) |
| `ios/AppIcon-60x60@2x.png` | 120x120 | direct |
| `ios/AppIcon-60x60@3x.png` | 180x180 | direct |
| `ios/AppIcon-76x76@1x.png` | 76x76 | direct |
| `ios/AppIcon-76x76@2x.png` | 152x152 | direct |
| `ios/AppIcon-83.5x83.5@2x.png` | 167x167 | direct |
| `android/mipmap-hdpi/ic_launcher.png` | 49x49 | direct (logo scaled to 0.623 into the safe zone, then downscaled) |
| `android/mipmap-hdpi/ic_launcher_foreground.png` | 162x162 | direct (logo scaled to 0.623 into the safe zone, then downscaled) |
| `android/mipmap-hdpi/ic_launcher_round.png` | 49x49 | direct (logo scaled to 0.623 into the safe zone, then downscaled) |
| `android/mipmap-mdpi/ic_launcher.png` | 48x48 | direct (logo scaled to 0.623 into the safe zone, then downscaled) |
| `android/mipmap-mdpi/ic_launcher_foreground.png` | 108x108 | direct (logo scaled to 0.623 into the safe zone, then downscaled) |
| `android/mipmap-mdpi/ic_launcher_round.png` | 48x48 | direct (logo scaled to 0.623 into the safe zone, then downscaled) |
| `android/mipmap-xhdpi/ic_launcher.png` | 96x96 | direct (logo scaled to 0.623 into the safe zone, then downscaled) |
| `android/mipmap-xhdpi/ic_launcher_foreground.png` | 216x216 | direct (logo scaled to 0.623 into the safe zone, then downscaled) |
| `android/mipmap-xhdpi/ic_launcher_round.png` | 96x96 | direct (logo scaled to 0.623 into the safe zone, then downscaled) |
| `android/mipmap-xxhdpi/ic_launcher.png` | 144x144 | direct (logo scaled to 0.623 into the safe zone, then downscaled) |
| `android/mipmap-xxhdpi/ic_launcher_foreground.png` | 324x324 | direct (logo scaled to 0.623 into the safe zone, then downscaled) |
| `android/mipmap-xxhdpi/ic_launcher_round.png` | 144x144 | direct (logo scaled to 0.623 into the safe zone, then downscaled) |
| `android/mipmap-xxxhdpi/ic_launcher.png` | 192x192 | direct (logo scaled to 0.623 into the safe zone, then downscaled) |
| `android/mipmap-xxxhdpi/ic_launcher_foreground.png` | 432x432 | direct (logo scaled to 0.623 into the safe zone, then downscaled) |
| `android/mipmap-xxxhdpi/ic_launcher_round.png` | 192x192 | direct (logo scaled to 0.623 into the safe zone, then downscaled) |
| `android/mipmap-anydpi-v26/ic_launcher.xml, android/values/ic_launcher_background.xml` | white background | generated |
