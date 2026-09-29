# Evidence, uncertainty and acceptance

## What is verified already

The user's AEP was parsed using `forticheprod/py-aep` at commit
`e12a451c35bacd3f34a080090265f9370e66162b`. All 194 fetched parser source files
were checked against that commit's Git blob hashes. The exporter reported
zero field/serialization errors. Repeating extraction returned the same
content except elapsed time. No expressions were evaluated.

The skill's JSON composition files preserve the full exported records,
including numeric values and flags marking parser-synthesized defaults.
They are not a handwritten approximation or a newly designed timeline.
`data/manifest.json` records their SHA-256 hashes and source AEP fingerprint.

Source counts:
- 22 compositions, 99 layers.
- 1,875 leaf properties backed by non-synthetic binary chunks.
- 17,795 parser-synthesized leaf properties. Do not call those authored values.
- Exported animation-key counts can duplicate separated Position data; do not
  describe every exported key entry as a distinct authored keyframe.

### Opening-reveal spot-check

The first scene's matte-height Bezier was independently evaluated from its
exported times, values, speeds and influences, without the parser's interpolator.
At ten timestamps the height was compared with a brightness-based edge
measurement of the real 640×360 Mixkit preview. Maximum absolute difference:
**1.728 pixels**. Actual preview frame timestamps were checked with ffprobe.
All samples are preserved in the manifest.

This is a **limited numeric spot-check**, not a full render comparison.
It is affected by compression and thresholded edge measurement. It does not
validate text animators, all scenes, all effects or the complete choreography.

## What is not verified

- No whole-video reconstruction has been generated or compared.
- No export/render inside After Effects has independently checked the full
  parser output. The parser is a reverse-engineered implementation, not AE.
- Per-letter selector weighting, randomized order, font layout and combination
  of text animators have not been reproduced and checked in another renderer.
- Fast Blur, stroke/outline rendering and other compositing semantics may differ
  from apparently similar browser/Canvas/SVG effects.
- Original footage is absent and intentionally replaceable. Font substitution
  is allowed. Neither asset substitution validates the surrounding motion.
- No reference audio was supplied. No sound timing was extracted.

A future agent must not turn "all data files passed integrity checks" into
"the video is visually verified."

## Acceptance procedure after a reconstruction exists

1. **Validate the data package.**
   Run `python3 "<skill-root>/tools/inspect_motion.py" verify`. This only validates
   bundled hashes, counts and links; it does not render anything.
2. **Record the implementation mapping.**
   For every used source composition/layer, record the target object and where
   its keyed properties, selectors, effects, matte, stack and clock are handled.
   Mark every unsupported or approximate semantic explicitly. Do not invent a
   coverage percentage from raw property counts (most exposed defaults are unused).
3. **Check actual technical output.**
   Confirm 1920×1080, 30 fps, 361 frames, complete layer/media/font loading,
   deterministic seeking, no render errors and no substituted silent fallbacks.
   In GG Motion, retain the existing HyperFrames validation and completion review.
4. **Check source timing, not only screenshots.**
   Sample exact keys and intermediate times, including steep Bezier sections,
   HOLD boundaries, negative-start echoes, overlapping scenes and stretched
   decorative instances. The source video's ~59.94 fps and the project's 30 fps
   are different: compare by seconds, not matching frame indices.
5. **Compare the entire sequence in motion.**
   Cover at least 0–2.2 s, 2.1–4.8 s, 4.7–7.2 s, 7.0–9.7 s and 9.4 s through
   the end. These overlapping review windows are for inspection, not new cuts.
   Compare reveal dimensions, zoom timing, directions, silhouettes, overlaps,
   outline echo spacing and final settling/hold. A contact sheet alone is not
   playback evidence. Report if the available tooling only inspected frames.
6. **Separate content differences from motion differences.**
   A different person/image or changed glyph silhouette is expected. A different
   reveal axis, easing shape, stagger rule, outline-copy count, scene overlap or
   duration is a reconstruction defect unless the user explicitly requested it.
   A raw pixel-diff score with different content is not a useful fidelity verdict.
7. **Resolve or disclose failures.**
   Fix concrete mismatches from the source data and recheck the affected interval.
   When semantics cannot be reproduced/validated, deliver an honestly labelled
   draft with the exact unresolved layer/interval. Do not replace it with a
   stylistically similar effect and claim fidelity.

Reference page:
https://mixkit.co/free-after-effects-templates/split-text-intro-617/

Known public preview URL (availability may change):
https://assets.mixkit.co/video-templates/617/mixkit-617-360.mp4

No reference video is bundled. Use the user's supplied/cached reference or an
otherwise authorized source through the host's normal media workflow. Access
failure does not authorize bypassing a site's restrictions.

## Reporting language

- **Source-grounded:** implemented from the recorded values and mechanisms.
- **Integrity checked:** data/hash/link checks passed, not visual verification.
- **Partially verified:** identify the actual tested intervals/mechanisms.
- **Visually compared:** state what was watched or which frames were inspected;
  list remaining deviations. Do not imply human approval or pixel identity.

This skill currently has source data and limited extraction evidence. It is
not a certificate of rendering correctness and should not claim otherwise.
