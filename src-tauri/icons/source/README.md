# Android launcher icon sources

`carlos-logo-460.jpg` is the CARLOS logo (the carlos-emr organisation avatar, 460 x 460 px, white
background). It is too small for the 1,024 px desktop and iOS masters, so those icons stay on the
heart icon until a larger original exists.

`android-master-safe-zone.png` is the same picture, only scaled (Lanczos, 0.667) and centred on a
white 460 px square so that the farthest ink (the figure's foot) lies inside the adaptive icon's
66 dp safe circle (0.30 of the width). Nothing else was changed. The Android icons in
`../android/` come from it with the project's own tool, not by hand:

    npx tauri icon src-tauri/icons/source/android-master-safe-zone.png -o <empty dir>
    # then copy only <dir>/android/* over src-tauri/icons/android/

The adaptive background is white (`values/ic_launcher_background.xml`, `#fff`).
