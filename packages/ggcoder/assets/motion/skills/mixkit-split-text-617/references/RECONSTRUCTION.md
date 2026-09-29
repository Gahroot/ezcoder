# Reconstruction rules — preserve the mechanism

These rules describe the supplied project. They are not a new art direction.
For full numbers and property paths use the composition data and inspector.

## 1. Composition graph and fixed output

Root: `Final_1920x1080` (6936), containing `!Post_Production` (508).
The output is 1920×1080, square pixels, 30 fps, 361 frames. Its duration is
12.033333333333333 seconds, not a newly rounded 12-second edit. Frame times
are n/30 for n = 0 through 360; duration is the end of the last frame interval.

Assembly visibility intervals (seconds, rounded here **for reading only**):

| Source | In | Out |
|---|---:|---:|
| Scene_1 | 0.000000 | 2.166667 |
| Text_Design_1 | 1.000000 | 3.100000 |
| Scene_2 | 2.166667 | 4.500000 |
| Text_Design_2 | 3.633333 | 6.266667 |
| Scene_3 | 4.766667 | 7.033333 |
| Text_Design_3 | 6.000000 | 7.633333 |
| Scene_4 | 7.033333 | 9.066667 |
| Text_Design_4 | 8.233333 | 10.233333 |
| Text_Design_5 | 9.433333 | 12.033333 |

This is **not a sequence of hard cuts**. Source layers overlap and animate
inside these intervals. Their stack order and clipping determine what is seen.
The other seven assembly layers are decorative instances and background;
read all 16 assembly layers, not just this table.

Follow composition IDs rather than matching repeated layer names. The source
solid is a generated footage item in `manifest.footage_items`, not a missing
file. Its applied Fill effects can differ from its base solid colour.

## 2. Time, stretch and layer order

- Composition JSON `layers` and zero-based `index` preserve the source stack;
  index 0 is the top layer. Do not reverse compositing accidentally.
- `start_time`, `in_point`, `out_point` and exported keyframe `time` are in the
  **owning composition's seconds**, not all in the final composition's clock.
- At parent-composition time T, a layer with start B and stretch S percent
  maps into its source at U = (T - B) / (S/100), unless time remapping applies.
  The parsed live layers report no enabled time remapping here.
- Recurse this mapping at every precomposition boundary. Do not add the parent
  start twice, or subtract it from a keyframe that is already in parent time.
- Read stretch numerically. The assembly contains decorative instances at
  90% and approximately 137.99999952316284%, not only 100%.
- Keep negative starts and subframe times. Text echo copies deliberately start
  before zero. In/out clipping is separate from start/source-time mapping.
- Keep out-of-visible-range keys: they can affect interpolation of the visible
  interval. Do not crop the keyframe list to the layer's in/out points.
- Apply parent transforms, anchor points, layer transforms, shape-group
  transforms and precomposition clipping in their own coordinate systems.
  Preserve exported 3D/collapse/matte flags; a flat appearance is not permission
  to discard them. Do not invent a camera.

## 3. Easing: translate numbers, not adjectives

For each property preserve values, interpolation types and component order.
Use the exact keys rather than selecting an easing preset that feels similar.

- HOLD: retain the previous value until the next key; do not crossfade it.
- LINEAR: interpolate at constant rate on the correct time axis.
- BEZIER, **non-spatial scalar/component case**: use endpoint values, temporal
  speeds and influences to form the time/value cubic. Do not apply this simple
  component formula to spatial-position paths with arc-length-based speed.

Temporal speed is measured per layer second. If a layer is stretched, first
convert exported composition key times t0/t1 to layer times
u0 = (t0-B)/(S/100), u1 = (t1-B)/(S/100), and evaluate on that same axis.
For a non-spatial component with values v0/v1:

```text
D  = u1 - u0
A  = D * outgoing_influence / 100
B2 = D * incoming_influence / 100
P0 = (u0,       v0)
P1 = (u0 + A,  v0 + outgoing_speed * A)
P2 = (u1 - B2, v1 - incoming_speed * B2)
P3 = (u1,      v1)
```

Invert the cubic's time coordinate for the requested time before evaluating
its value coordinate. Cubic parameter is not elapsed-time fraction. Handle
constant components directly; do not divide by a zero value delta. Retain
per-component ease entries and precision. Endpoint conditions matter.

For spatial properties retain spatial tangents, continuity, auto-Bezier and
roving flags and translate their actual path semantics. An unvalidated spatial
approximation is not exact merely because the endpoint positions match.

Separated Position: inspect `is_separation_leader`,
`is_separation_follower` and `dimensions_separated`. The export can expose both
a combined leader and its followers. Select the active representation; do not
apply both or combine unrelated synthetic follower defaults.

## 4. Four footage mechanisms, not four generic wipes

Source IDs: Scene_1=76, Scene_2=480, Scene_3=6677, Scene_4=6736.
Each has its own shape matte, PH source layer and background. Preserve the
matte layer relationship and alpha interpretation, not just a visible white
rectangle drawn over the footage.

Rectangle sizes in each scene's local time (all at 0, 1 and 2 seconds):

| Scene | t=0 | t=1 | t=2 |
|---|---|---|---|
| 1 | [1920, 0] | [1920, 812] | [1920, 0] |
| 2 | [1920, 0] | [1920, 812] | [1920, 0] |
| 3 | [0, 812] | [1920, 812] | [0, 540] |
| 4 | [1920, 0] | [1920, 812] | [0, 0] |

Use each scene's own easing. Scene_3's media starts around 350% scale; the
other three start around 140%. They reach around 100% at 1 second and 143%
at 2 seconds. Use the exact per-component values from the data, not these
rounded descriptions.

Fast Blur is keyed from 0 at 1.3666666666666667 seconds to 214 at 2 seconds.
Read all effect settings, including direction/repeat-edge behaviour. AE's
214 is not automatically the CSS/Canvas blur radius. Match blur behaviour
against the reference before claiming equivalence.

The parent assembly also animates some scene positions and applies Tint.
The internal reveal alone does not reproduce the scene transition. Preserve
those parent effects/transforms and every scene's BG treatment as well.

### Replacing the four media slots

The supplied PH compositions are empty. Fill them with the selected media;
leave the surrounding matte, source-layer scale, position, blur and timing
unchanged. Still images are valid; moving footage supplies its own content
motion. Do not add a new Ken Burns move or a convenient dissolve.

A source crop/fit or clip in-point is a media-binding choice, not recovered
project information. Record it explicitly. Prefer media prepared to the slot's
1920×1080 bounds; resolve incompatible aspect ratios or insufficient duration
rather than silently introducing looping, stretching or new animation.

## 5. Typography: same animator system, different glyphs

Source text compositions: 6539, 6663, 6722, 6780, 6810.
Their original words are OPENER, INTRO, BOLD, FREE, MIXKIT. These are slot labels
and reference content, not mandatory copy.

Replace the source text and font **once per source composition**, so every
filled/outline copy derives from the same new glyph layout. Preserve the
source text-document alignment, tracking/leading, transforms and animator
structure unless the user explicitly changes the corresponding typography
input. Record any resulting layout change; do not present changed glyphs as
pixel-identical to the reference.

Read every applied animator, selector and nested setting in order:
- Position/scale/tracking animation is not the same for all five titles.
- Selector amount, range shape, ease and randomized-order seed are part of
  the mechanism. Do not substitute your own character order or delay formula.
- Preserve fill/stroke state and HOLD keys; the source's filled and outline
  portions are deliberately separated in time.
- The final title includes a source-layer scale animation from zero to about
  484%; this combines with surrounding transforms. It is not a new end card.

A new font or a different number of letters changes the glyph geometry and
selector population. Preserve the source selector algorithm and its settings,
not a guessed list of pixel coordinates for the old letters. The foreign
renderer implementation of that algorithm is currently unverified. If it
cannot be implemented/checked, mark that portion unresolved; do not silently
swap in a generic stagger and call it precise.

### The four outline echoes

Text-design compositions: 6525, 6647, 6706, 6764, 6794.
Each contains **five source instances**: one main filled copy and four echoes.
The four echoed instances start near -4.966666666666667, -4.933333333333334,
-4.9 and -4.866666666666666 seconds. Their visible starts are staggered by
one 30-fps frame, while their source time is already in the outline section.

At source time 5 seconds, text Fill Opacity switches to 0 with HOLD
interpolation. This, not a text-shadow filter, supplies the outlined copies.
Retain the actual instance stack, time offsets, clipping and transforms.
Do not replace it with arbitrary increasing stroke widths or opacity trails.

## 6. Decorative movement and background

`elements` (6823) and `elements 2` (6872) each contain 20 shape layers.
Their geometry, placements and temporal offsets differ. Reuse their source
instances as the assembly does; do not make a random particle generator.
Their separated vertical-position keys and timing are in the data. Preserve
shape fills/strokes and all instance rotation/scale/position/stretch settings.
The source duration of these compositions is longer than their visible parent
intervals; do not stretch the source to fill those intervals automatically.

## 7. Renderer identity and source/default provenance

`ADBE Advanced 3d` in the parser's `renderer` field is an internal scripting
identifier mapped from the Classic 3D renderer in this parser; it is not a
request to modernize the clip to a new 3D style.

Stored values, parser-synthesized defaults and renderer-specific calculations
are different evidence classes. Keep them distinct in implementation notes.
No expressions were reported by the parsed live property tree. Do not add
noise, procedural jitter or expression-driven motion to fill imagined gaps.
