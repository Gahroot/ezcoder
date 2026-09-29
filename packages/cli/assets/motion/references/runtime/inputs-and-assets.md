# GG runtime inputs and assets

This is implementation support, not a creative workflow. The selected recipe
controls choreography and permitted adaptations. Bind approved text, fonts,
colours, logos and media without adding a second look-selection process.

`hf` in these references is shorthand for the exact bundled launcher command
in the system prompt; expand it, never run bare `hf` or `npx hyperframes`.
`<node>` and `<motion bin>` also come from that prompt. No self-updates,
package installs, cloud rendering or publishing without explicit permission.

## Local inputs

- Keep original captures/uploads in `sources/`; use local `assets/` for the
  files consumed by the composition. Never overwrite originals or finished renders.
- A reusable kit lives at `brand-kits/<slug>/Motion.md` in the Motion workspace.
  Keep it read-only for ordinary video work. Record the selected kit and permitted
  bindings in `frame.md`; preserve legacy briefs rather than duplicating plans.
- The recipe defines fit/crop/in-point policies. Record approved choices. A
  different asset aspect ratio or title length does not authorize new choreography.
- Root output duration is a static composition contract. If a permitted input
  changes duration, update the authored root explicitly; a runtime variable
  cannot silently change the compiled video length.

## Existing helpers (only when needed)

```sh
<node> "<motion bin>/fonts.mjs" list
<node> "<motion bin>/fonts.mjs" add <project> <Family>...
<node> "<motion bin>/pdf-extract.mjs" <file.pdf> <output-dir>
<node> "<motion bin>/three.mjs" add <project>
<node> "<motion bin>/library.mjs" list
<node> "<motion bin>/reveal.mjs" <delivered-file>
```

Inspect helper help for less common operations; do not guess options. Fonts,
Three.js and library assets remain available offline, but their existence does
not require using them. Respect actual licenses and required brand typography.

Shared music and SFX are at `../../assets/music/` and `../../assets/sfx/` relative
to this document. Upstream metadata can retain historical `skills/brag/` paths;
resolve its filenames under these shared asset roots, not the removed skill.
Those provenance notes are not instructions to invoke an old workflow.
Preserve credits, cue maps and SFX analysis. Copy only used
assets into the video project. The selected recipe or user determines whether
sound belongs in the video; do not automatically add music or hits.

Use `motion_check` once on the current render as specified by `video-qa`; it
runs the media helpers and returns images for this agent to inspect. Do not
repeat its checks as a separate checklist. Request permission before
installing missing FFmpeg/browser software; a detector setup failure does not
justify skipping validation. Never upload user files to resolve a local blocker.
