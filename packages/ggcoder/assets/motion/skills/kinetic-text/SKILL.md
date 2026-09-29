---
name: kinetic-text
description: Kinetic typography pack — 21 bold text animations (zoom-throughs, typewriters, glow sweeps, word highlights, marquees) with protected intros and outros. Use for title cards, slogans, captions and punchy word-by-word moments. Editable text, colours, position and scale.
---

# Kinetic Text

**This is a working template: copy it, set its inputs, render.** All 21
animations are played by one shared renderer from compiled data. Do not rebuild
them from this description, and do not restyle them.

## What it contains

21 animations, 1920×1080 at 30 fps, black background by default. Each has an
intro, a settled hold in the middle, and an outro.

| ID | Length | Look (sample text) | Text slots | Colour inputs (in order) |
|---|---|---|---|---|
| 01 | 6 s | Word zooms through a tiled wall, then two lines merge ("MOTION", "TEXT HERE") | 2 | — |
| 02 | 6 s | Huge two-line zoom that settles small ("DYNAMIC STYLES") | 1 | Color 1, Color 2, Color 3 |
| 03 | 6 s | Typewriter with cursor, zoomed in, then pulls back ("Smooth Creative Workflow") | 1 | Color 1, Color 2 |
| 04 | 6 s | Repeating marquee of a multi-line block ("100% / Editable / Project") | 1 (≤3 lines) | Text Color 1, Text Color 2 |
| 05 | 5 s | Box-wipe reveal with a coloured glow fade ("FLEXIBLE") | 1 | Color 1, Color 2 (glow) |
| 06 | 6 s | Big word shrinks in with a speed trail of offset copies ("Fast & Easy") | 1 | Fill Color 2 |
| 07 | 6 s | Line slides into place ("Easy Text Editing") | 1 | Text Color 1, 2, 3 |
| 08 | 6 s | Three stacked phrases with a big zoom ("Creative", "Replace Text", "Export Instantly") | 3 | Text Color 1, 2, 3 |
| 09 | 6 s | Slide-in title ("Motion Control") | 1 | Shape Color, Text Color |
| 10 | 6 s | Three stacked copies, light–bold–light ("8K READY") | 1 | Text Color 1, Text Color 2 |
| 11 | 3 s | Very large single word ("ideas") | 1 | Text Color |
| 12 | 5 s | Word with an orange glow letter sweeping behind it ("Modern") | 1 | Fill Color, Glow Color |
| 13 | 5 s | Word with a wiggling glow ("Dynamic") | 1 | Fill Color, Glow Color |
| 14 | 6 s | Typewriter sentence with a coloured highlight box ("Designed for presentations…") | 1 | Text Color, Fade Text Color, Shape Color |
| 15 | 6 s | Red word, then a second line replaces it ("Build", "creative impact") | 2 | Text Color 1, Text Color 2 |
| 16 | 6 s | Four words cycle in turn ("DESIGN", "EXPLORE", "INSPIRE", "CREATE") | 4 | Color Control 1 |
| 17 | 6 s | Zoom-through, then a settled phrase ("Clean. Bold. Creative. Professional.") | 1 | Text Color 1 |
| 18 | 6 s | Scrolling line with a highlighted, underlined word ("Create stunning content in seconds.") | 1 | Text Color 1, 2, Shape Color, Glow Color |
| 19 | 6 s | Line slides so a boxed word sits centred, over a repeating band ("New", "Ultimate Motion Pack") | 2 | Text Color 1, 2, Shape Color |
| 20 | 6 s | Letters cascade into place ("Go Beyond") | 1 | Text Color 1, Text Color 2 |
| 21 | 6 s | Words step through one at a time, centred ("Professional animations with smooth transitions.") | 1 | Text Color 1, 2, Glow Color |

Variants 04, 18 and 19 run their line past the frame edges on purpose
(marquee or scroll). In 19, slot 2 is the centred boxed line and slot 1 fills
the repeating band.

## Use it

1. Copy everything in `template/` into the video project folder, keeping
   `assets/` beside `index.html`.
2. Set `data-duration` on `#composition` in the copied `index.html`:
   - the variant's length from the table plays it at its own timing;
   - longer (up to 60 s) lengthens the middle hold only. The intro and outro
     keep their timing.
   - shorter than the variant's length is rejected.
3. Set inputs as HyperFrames variables: edit their defaults in `index.html`, or
   pass `--variables '<json>'` when rendering.
4. Render, then check as usual:

```sh
hf render <project> --output <new versioned .mp4> --fps 30 --quality looks --workers 1 --strict --strict-variables --experimental-fast-capture=false
```

Keep `--experimental-fast-capture=false`: fast capture does not reproduce the
masked SVG text accurately. The template loads GSAP from its pinned CDN
address, so rendering needs a network connection.

To use one animation inside a longer video, render it on its own and place the
clip, or keep this template as its own sub-composition folder. HyperFrames
allows one root `index.html` per project folder.

## Inputs

Invalid input is rejected with a clear error, and nothing changes: the render
stops rather than silently adjusting a value.

- `variant`: `"01"`–`"21"` (a string). Default `"01"`.
- `text1`…`text4`: replacement text for the variant's slots, in table order.
  - `""` keeps the sample text.
  - Up to 40 characters per line, or the sample's own line length where that
    is longer (14: 52, 21: 48). Line breaks as `\n`, only where the slot
    allows more than one line (04).
  - `window.kineticText.variants()` lists each slot's `maxLineChars`.
  - Slots the variant doesn't have must stay `""`.
  - Allowed characters: Latin letters (including Latin-1 accents), digits,
    spaces and common punctuation (`. , : ; ! ? ' " & % $ € £ @ # ( ) - – — + * / = _ | < > « » ^ ~`).
    Emoji and other scripts are rejected because the bundled fonts cannot
    draw them.
- `x`, `y`: centre of the design in 1920×1080 pixels. Default 960, 540.
- `scale`: uniform size, 0.25–2. Default 1.
- Fit check, on the settled frame:
  - Text that would leave the frame is rejected. It must also stay as far from
    the edge as the sample does, up to 8 px.
  - 04, 18 and 19 overflow by design, so for them the limit is instead a line
    at most 1.5× the sample's width.
- `color1`…`color5`: `"#RRGGBB"`, or `""` to keep the built-in colour. They map
  to the variant's colour inputs in table order. Variants without colour
  inputs (01) take none.
- `weight`: `0` keeps the built-in weight. 100–900 sets the Inter weight on
  variants 09, 10 and 11 only.
- `background`: `"#RRGGBB"`. Default `"#000000"`.

In a preview, `window.kineticText.variants()` lists every variant with its
length, hold time, slot sample text, line limits and colour inputs.
`window.kineticText.setInputs({...})` returns `{ ok, error }`.

## Limits

- **Font:** every variant draws its text in Inter (bundled, OFL), Latin
  characters only. Use Inter for other text in the video to match.
- **No audio.** Add music or sound in the video project.
- **Intended:** 04, 18 and 19 run their line past the frame edges.
- **Differences from the original.** This is a reconstruction, never
  compared against an After Effects render. Preview these with the user's
  actual text before choosing them, and don't describe them as intended:
  - 06: the speed trail shows slivers of the word's first letter to its left
    (the sample reads like "FFFFast & Easy"). With some first letters they
    look like stray dashes.
  - 05: with text longer than the sample, the glow fade can stop before the
    last letter and leave it tinted. Best with short words.
  - 19: the selection box shows two small handle squares on its right edge,
    from the original's selection-box design.
  - 14: the cursor stays solid instead of blinking.
  - 16: the word boxes stay in place while the words change.

Known check results:
- `hf check` reports info-level `canvas_overflow` notes during 01's
  zoom-through. The giant letters are meant to sweep past the frame.
- `motion_check` flags each variant's middle hold as a freeze. The pause is
  part of the design: declare it as a hold with that reason, and don't retime
  the animation.
