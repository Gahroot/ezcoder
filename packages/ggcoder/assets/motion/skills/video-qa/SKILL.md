---
name: video-qa
description: Check the current Motion draft and delivered file against the selected recipe, approved inputs and technical requirements. Use after rendering or relevant edits; do not impose a different style, repeat unchanged reviews or claim fidelity from technical checks alone.
---

# Video QA — inspect the result, not paperwork

Use this after a rendered draft and relevant edits. Standard permits up to two
targeted revisions; quick is for an explicit small test/edit with one revision.
Keep the bounded production/chapter API when resuming existing long work; do not
create a production planning packet for an ordinary recipe-driven video. No compulsory three rounds or endless polishing. Diagnose
repeated failures; never rerun unchanged input, invent evidence or raise thresholds.
Missing evidence is unverified, not PASS. A self-assigned 8/10 is not evidence.
When the budget is spent, report remaining defects as draft/unverified.

## 1. Source and design fidelity

Compare the actual scene source and rendered frames with the selected recipe,
its invariant mechanisms and approved content/brand bindings in frame.md.
Fix invented UI, unsupported claims, unapproved font substitutions and departures
from the source choreography. User-approved dynamic content is not a fidelity
failure; a different mask, easing curve or echo mechanism can be.
Inspect the existing composition, not a separate stills implementation.
A concise verification summary in `frame.md` is enough; no required REVIEW.md,
scorecard, storyboard packet or duplicate design contract.

## 2. Technical checks — choose the right signal

```bash
hf lint --json
hf check --json --at-transitions
<node> "<motion bin>/motion-check.mjs" renders/draft-v1.mp4
```

Run from the project, expanding `hf` to the full bundled command. Check every
exit status. `hf check` covers runtime, media, layout and contrast. Fix actual
errors; do not dismiss them merely because the video can render.

**Motion is checked from rendered pixels**, not DOM geometry. The helper
uses installed FFmpeg to decode the whole file, sampling at 8 fps and detecting
frozen spans of at least one second. It reports timestamps, sample count and
elapsed time. It works for HTML, canvas/WebGL and mixed compositions. No motion
sidecar or project-specific checking script is needed.

HyperFrames DOM liveness cannot see changing pixels inside a stationary canvas.
Do not add its `keepsMoving` assertion as a universal prerequisite. For legacy
canvas projects, replace only that inapplicable assertion with pixel validation;
retain other meaningful assertions and all runtime/layout checks. Disabled DOM
motion is not motion evidence, but it does not invalidate a successful pixel
analysis. Do not retry an unsupported detector for 15 minutes.

The pixel helper rejects missing/undecodable files, incomplete analysis and
unexplained freezes. An intentional reading pause or resolved hold is not a
slideshow and should not acquire decorative motion just to pass this check.
Use the scoped hold process below; do not change detector thresholds.
Missing FFmpeg is a setup blocker: use `hf doctor`, ask before
installing, or supply the known installed binary via `HYPERFRAMES_FFMPEG_PATH`.
Do not write a second checker, forge a report or disable verification.

Only when the user explicitly requests a slideshow: record the request in
the brief and append `--slideshow-requested`. The helper still decodes the
video and reports all freezes; it never turns missing evidence into a pass.

### Intentional holds — explicit, narrow and tied to this render

Plan the pause's timing and purpose in the existing `frame.md` while directing
it. Run the normal pixel check first; it reports every detected freeze and the
render's `videoSha256`, including on a freeze failure. Inspect the relevant
interval, its incoming/outgoing motion, reading time and the surrounding piece.
Do not retroactively call an accidental freeze intentional to get a pass.

Only for intentional holds of at least a second, write `holds.json` with the
exact render hash from that report and the planned, visually reviewed windows:

```json
{
  "version": 1,
  "videoSha256": "<64-character SHA-256 from the current pixel report>",
  "holds": [
    { "start": 7, "end": 9, "reason": "Read the resolved final phrase" }
  ]
}
```

```bash
<node> "<motion bin>/motion-check.mjs" renders/draft-v1.mp4 --holds holds.json
```

Times are seconds; use ascending, non-overlapping windows inside the video.
Every window needs a specific purpose. The helper still decodes the whole file,
reports all freezes, and fails any freeze not contained in a declared window
(with one 8fps sample of timing tolerance). It rejects stale/unmatched windows,
wrong-render hashes, invalid plans and declarations covering the whole video.
Do not combine holds with slideshow mode or widen windows to hide defects.

This passes only the automated liveness gate, not recipe-fidelity review.
Judge holds and scene structure against the selected recipe and user request;
do not require decorative movement or a redesign of legitimate source pacing. Report intentional holds in the delivery summary. Recheck
changed exports with their own hash and reviewed windows; never reuse a draft's
plan on a different render. Videos without intentional holds need no new file.

## 3. Creative review — current rendered evidence

Use the `motion_review` tool, not a builder-authored verdict:

```json
{"action":"prepare","production":{"project":"my-film","output":"renders/draft-v1.mp4","depth":"standard","references":["Selected recipe and invariant motion mechanisms recorded in frame.md"],"windows":[{"label":"signal handoff","start":1.5,"end":2.2}]}}
```

Supply explicit windows for every major focal action/handoff in `frame.md`, then
`{"action":"submit"}`. The host runs technical checks and supplies actual overview,
phone and consecutive-frame images, brief, preferences, reference/plan context
and technical results to a fresh critique on the active image-capable model.
It does not send the builder's praise or force a different model/effort/provider.
An image merely generated on disk has not been reviewed.

The video's `qa/` contains a versioned manifest bound to video/image SHA-256,
timestamps and labeled strips. Concise results record model/settings, source and
evidence identity, plus timestamped criterion/problem/correction findings.
Missing imagery, malformed replies, unsupported vision, unavailable renderer or
timeout is unverified, not a clean pass. Creative readiness never waives technical
failure. This is model judgment, not certification of taste.

Long films use production `range: {start, end}` batches (≤180s each; up to 20
chapters/3600s, with 1–12 action windows per chapter). All intervals of the same
current artifact must be reviewed before final-ready; no first-page-only sampling.
Changes to source/media/render invalidate readiness even if the old MP4 remains.
Keep composition inputs outside `qa/` and `renders/` (outputs only). Source symlinks
need local contained copies for review. For a checkpoint/no delivery use
`no_delivery` with a concrete reason and state the draft/blocker honestly.
Pass `holds` as a project-local declarations file for scoped intentional holds.
Only when the user explicitly requested a slideshow, pass `slideshowRequested:
true` instead of holds; this preserves the existing helper's slideshow mode,
not permission to waive failed animation checks.

Judge **adherence to the selected recipe**, not an alternative creative direction.
Compare the extracted/defined timing, transitions, overlaps, masks, text behaviour
and permitted adaptation rules with what was actually rendered. Fixed framing,
outline echoes, intentional holds or repeated structure are not defects merely
because a generic motion guideline prefers another style. Conversely, a pixel
liveness pass does not excuse a missing source mechanism or unsupported AE effect.

Source data can be precise while its renderer translation remains unverified.
Record unsupported selectors, effects or layout changes with affected intervals.
Do not call a source-grounded draft visually matched without a real comparison.
No extra review document, design research loop or approval round is required.

Inspect prepared overview/phone sheets and consecutive-frame strips at the
start, middle and end of each action window, not only isolated midpoints.
Review at normal speed and listen when tools support it. Distinguish technical
readiness, frame-based judgment, full playback and audio listening; never claim
one from another. Share the playable file, not only stills.

Fail concrete mismatches with the selected recipe or explicit user instructions,
not generic style preferences. Inspect text readability, source accuracy, framing,
actual easing and scene transitions. Do not let decorative loops or audio mask
missing recipe behaviour. Report evidence gaps rather than inferring fidelity
from the existence of a render or a successful pixel check.

Correct the biggest visible defects in the existing composition. Do not
restart design research or commission separate stills. Rerender and recheck
affected output after changes; reuse unchanged assets and evidence appropriately.
Ask for approval only when the user requested a preview checkpoint or a real
unresolved choice blocks progress—not automatically for every draft/render.

## Gate 4 — audio (only when present)

Listen/inspect the actual mix where tools allow; keep speech intelligible,
use intentional sync points and avoid harsh/clipped effects. Every HyperFrames
`<audio>` must have an id or it will not mix. Don't re-score the whole video
because one hit is too loud. Verify the delivered file's loudness; normalize
when needed to integrated −14 ± 1 LUFS and true peak ≤ −1 dBTP:

```bash
ffmpeg -n -i renders/<file>.mp4 -map 0 -c:v copy \
  -af "loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000" \
  -c:a aac -b:a 320k -movflags +faststart renders/<file>.loud.mp4
ffmpeg -i renders/<file>.loud.mp4 -af ebur128=peak=true -f null -
```

Inspect both exit statuses and the measurements, not just a log tail. Choose
an unused output filename; don't overwrite a finished render. If the peak is
over, correct the mix/ceiling and verify again. Silent videos skip audio work.

## Delivery

Render the same composition at delivery quality when the draft is not already
suitable. Apply Gate 4's loudness step to this render. Check decoded-pixel motion
on the delivered file and confirm duration, dimensions and fps with `ffprobe`.
If only audio changed with `-c:v copy`, the prior visual observations may still
be relevant, but the delivered artifact has a new hash: prepare its current
evidence/audio measurements before claiming review-ready. Never rerender unchanged
video merely to add a poster or report.

Do not bake an unrequested poster into frame zero, generate share copy or make
extra formats unless asked. Open the actual delivered file:

```bash
<node> "<motion bin>/reveal.mjs" renders/<file>.mp4
```

Report its path, duration/format, checks performed and any unresolved limit.
A draft with a failed check is a draft, not verified final output. Don't claim
aesthetic quality or a performance improvement from passing technical checks.
