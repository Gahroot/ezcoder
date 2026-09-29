---
name: mobile-notification
description: Animated iOS-style glass notification pack — 17 app notification cards, a phone lock-screen view and a scrolling showcase, with bounce entrances. Use for notification, message, incoming-call or app-alert moments. Editable text, placement, scale and local photos.
---

# Mobile Notification

**This is a working template: copy it, edit its inputs, render.** The
animation code is supplied. Do not rebuild the cards, glass or bounce from this
description, and do not restyle them.

## What it contains

17 notification designs, each with its original text, layout, icon and bounce
entrance:

| ID | Design | ID | Design |
|---|---|---|---|
| 01 | Messages | 10 | Maps |
| 02 | WhatsApp contact message | 11 | Find My |
| 03 | Stacked WhatsApp alerts with count | 12 | X |
| 04 | Gmail | 13 | PayPal |
| 05 | Mail | 14 | Calendar |
| 06 | Contact call/message | 15 | Notes |
| 07 | Instagram | 16 | FaceTime |
| 08 | Incoming call with buttons | 17 | YouTube |
| 09 | ChatGPT | | |

Five views, all 1920×1080 at 30 fps:

| View | What it shows | `data-duration` |
|---|---|---|
| `card` | One notification, movable and scalable | `10.01001001001` |
| `phone` | Phone lock screen (9:41 clock) with notifications | `10.01001001001` |
| `gallery` | All 17 designs in a grid, for choosing | `10.01001001001` |
| `presentation` | All 17 designs stacking and scrolling past | `8.341675008341675` |
| `showcase` | `phone`, then `presentation` | `18.351685018351684` |

## Use it

1. Copy everything in `template/` into the video project folder, keeping
   `assets/` beside `index.html`.
2. Choose the view. In the copied `index.html`, set the `view` variable's
   `"default"` and the `data-duration` on `#composition` to that view's value
   from the table. They must match: HyperFrames reads the duration before the
   script runs, and the template stops with an error naming the correct value
   if they differ.
3. Set inputs as HyperFrames variables: edit their defaults in `index.html`, or
   pass `--variables '<json>'` when rendering.
4. Copy any user photos into the project's `assets/` folder first; see `media`
   below.
5. Render, then check as usual:

```sh
hf render <project> --output <new versioned .mp4> --fps 30 --quality looks --workers 1 --strict --strict-variables --experimental-fast-capture=false
```

Keep `--experimental-fast-capture=false`: fast capture does not reproduce this
SVG glass accurately and falls back to screenshots anyway. The template loads
GSAP from its pinned CDN address, so rendering needs a network connection.

## Inputs

Invalid values stop the render with a clear error rather than being silently
changed.

- `view`: `card`, `phone`, `gallery`, `presentation` or `showcase`.
- `variant`: `"01"`–`"17"`; the notification shown in `card` view.
- `x`, `y`: centre of the card in `card` view, in 1920×1080 pixels. Default
  960, 460.
- `scale`: card size in `card` view, 0.2–1; default 0.7. Text, icon, corners and
  glass all scale together. Positions that would push the bounce outside the
  frame are rejected. Other views use their own fixed layout.
- `background`: `wallpaper` (blue gradient) or `grid` (checkerboard, which makes
  the glass distortion easy to see).
- `blur`: 0–24, default 8. `distortion`: 0–30, default 10.
- `texts`: a JSON **string** mapping text-slot keys to new text. Keys look like
  `"09:<id>"`; list all 56 slots with their original text by running
  `window.pack.textSlots()` in a preview. New text must fit the original slot's
  width and line count; there is no automatic wrapping, and text that is too
  long is rejected. The original copy is kept as supplied, including its typos
  (e.g. "fiveminutes") and PayPal's "You have a new follower". Replace it
  through `texts` when the user's content needs it.
- `media`: a JSON **string** such as
  `{"06":"assets/contact.png","phone":"assets/wallpaper.jpg"}`. Keys: `02`,
  `06` and `08` (contact photos, cropped to a circle) and `phone` (lock-screen
  wallpaper). Values must be PNG, JPEG or WebP files under 20 MB, named directly
  inside the project's `assets/` folder; no subfolders, `..` or web URLs. With
  no photo, cards 02, 06 and 08 show a full-size app or contact symbol; with a
  photo, the small app badge appears on its corner.
- `visible`: comma-separated card IDs shown in `phone` view; default
  `08,03,06`. Cards keep their original screen positions, and most share the
  same spot. Pick one card per position; this is not an auto-arranging stack.

## Limits

This is a close reconstruction of an After Effects design, not a pixel copy.

- The liquid glass is an SVG blur, distortion and edge highlight standing in for
  After Effects effects.
- Gmail, Mail, Instagram, the call buttons, Maps, Find My, Notes and FaceTime
  icons are simplified redraws. The others come from the original artwork.
- The big clock is plain text, without its glass effect.
- The presentation's fast-scroll motion blur is a simple blur with the original
  timing.
- Fonts: Manrope and Bebas Neue, Latin characters only, bundled with their OFL
  licenses. Text in other scripts may fall back to a system font.
- No audio.

Known check results: `motion_check` may flag the quiet end of the bounce and
the presentation's short pause as frozen frames. These come from the original
timing, not a broken render; review the frames, and report them rather than
retiming the animation. During the fast presentation scroll, text layers can
briefly overlap as cards pass each other.
