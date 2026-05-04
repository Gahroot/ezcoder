---
name: youtube-end-to-end
description: Orchestrator for 'make me a YouTube video from this footage' in 1–3 prompts. Composes long-form-content-edit + short-form-content-edit + chapter-markers + retention pipeline + metadata bundle. Produces a finished long-form mp4 (16:9, captions, normalised, chapters, outro) AND 1–3 Shorts mp4s (9:16, face-tracked, hook-scored, keyword-captioned with emojis, SFX) AND a metadata bundle (3 candidate titles, description with timestamps, 15 tags, hashtags, A/B thumbnail variants). Auto-detects long vs short by source duration; uses .gg/brand.json defaults when present.
---

# youtube-end-to-end

**When to use:** the user gives a single broad ask like *"make me a YouTube video from this footage"*, *"turn this recording into something I can ship"*, or *"give me a YouTube cut and a Shorts cut"*. This is the orchestrator skill — it composes the existing per-pass skills (long-form, short-form, chapter-markers, retention) into a single end-to-end run that produces upload-ready files **plus** the metadata to upload them with.

**Goal:** in 1–3 prompts, deliver:

- a finished long-form mp4 (16:9, captioned, loudness-normalised, with chapter markers + outro card)
- 1–3 Shorts mp4s (9:16, face-tracked when possible, hook-scored, keyword-captioned with emojis, SFX on cuts)
- a metadata bundle (3 candidate titles, description with timestamps, 15 tags, 5 hashtags, thumbnail variants)

The user never has to say *"now make captions"* / *"now make a Shorts version"* / *"now write the description"*. Defaults handle that.

---

## Step 0 — Intent triage (ONE question max)

Look at the input and the user's prompt:

- **Input duration** via `probe_media`. Anything > 5 minutes → assume long-form is wanted. Anything ≤ 5 minutes → assume short-form is wanted.
- **Both** when the source is > 5 minutes AND the user's prompt is silent on format. Long-form gets the full edit; the agent ALSO produces 1–3 Shorts via `find_viral_moments` from the same source.
- **Brand kit:** call `loadBrandKit`-equivalent by reading `<cwd>/.gg/brand.json`. If present, all render-time tools inherit the channel's logo / fonts / colours / outro. If absent, defaults apply — do NOT pause to ask the user about typography.

If duration is borderline (4–6 min), and the user's prompt is silent on format, ask **once**: *"Long-form cut, Shorts highlight, or both?"*. Otherwise default per the rules above and just ship.

---

## Step 1 — Foundation pass (always runs)

```
probe_media(input)                                   → fps, duration, codecs
extract_audio(input, audio.wav, sampleRate=16000)
transcribe(audio.wav, transcript.json,
           wordTimestamps=true)                      → word-level transcript
```

Word timings are mandatory — every retention multiplier downstream needs them. If the source is multi-cam, also run `multicam_sync` first and pick the alignment.

---

## Step 2 — Long-form cut (when long-form is in the brief)

```
cut_filler_words(transcript, sourceVideo)            → EDL of keep ranges, stats
                                                       → import_edl(path)
add_marker(color="green", note="filler-cut: removed N (Ms)")
clean_audio(input, mode="denoise")                   → if hiss is audible
normalize_loudness(input, output, platform="youtube")→ -14 LUFS / -1 dBTP
write_srt(transcript, output, cues=...)              → sentence-level SRT
import_subtitles(srtPath)                            → sidecar caption track
```

Chapters: read the `chapter-markers` skill and follow it. 5–15 chapters, first at 00:00, ≥30 s apart, only at real topic shifts (verify each via `read_transcript`).

End-screen: `generate_outro(output="outro.mp4")` — picks up brand kit defaults if present. Splice via `concat_videos([main.mp4, outro.mp4], output="final.mp4")`.

---

## Step 3 — Shorts pass (when shorts are in the brief)

If the source is short-form already, skip the discovery step and use it whole.

```
find_viral_moments(transcript, maxClips=3,
                   durationRange=[20, 60])           → ranked candidate windows
```

For each candidate (top scoring first):

```
analyze_hook(input, startSec=startSec, endSec=startSec+3)
                                                     → score 0-100 + findings
```

If `score < 60`, drop a red marker and skip — bad hook = bad short. The score and `why` go into the marker note. Otherwise, build the short:

```
# Cut the window out (file-only)
text_based_cut(sourceVideo,
               cuts=[{startSec: 0, endSec: candidate.startSec},
                     {startSec: candidate.endSec, endSec: totalSec}])
                                                     → import_edl

# OR for file-only delivery: use ffmpeg trim via trim_dead_air-style approach
# already wrapped in render_multi_format step below.

face_reframe(input=clip.mp4, output=clip.9x16.mp4,
             aspect="9:16", strategy="face")         → vertical with face tracking

# Caption pass — burned, word-by-word, with emojis
write_keyword_captions(transcript, output=clip.ass,
                       startSec=..., endSec=...,
                       autoEmoji=true,
                       emojiDensity="med",
                       groupSize=2)
burn_subtitles(clip.9x16.mp4, clip.ass, clip.captioned.mp4)

# Energy pass
punch_in(input=clip.captioned.mp4, output=clip.punched.mp4,
         cutPoints=[…boundaries…], holdSec=1.5)
add_sfx_at_cuts(input=clip.punched.mp4, sfx=whoosh.wav,
                output=clip.final.mp4,
                cutPoints=[…boundaries…])

# Audio delivery
normalize_loudness(input=clip.final.mp4,
                   output=clip.delivery.mp4,
                   platform="tiktok")                # = -14 LUFS

# Seamless re-loop (Shorts loop rate is a confirmed ranking signal)
loop_match_short(input=clip.delivery.mp4,
                 output=clip.shipped.mp4,
                 crossfadeSec=0.3)

# Pre-flight audit — fail fast before declaring done
audit_first_frame(input=clip.shipped.mp4)            # Galloway: "treat intro like a thumbnail"
verify_thumbnail_promise(thumbnail=variants[0].path,
                         video=clip.shipped.mp4,
                         windowSec=15)               # short-form: 15s window is enough

add_marker(color="green",
           note="short ${i}: hook=${analyzeHook.score}, virality=${candidate.score}")
```

Gate at: `hook ≥ 60` AND `virality ≥ 50` AND `audit_first_frame.score ≥ 60` AND `verify_thumbnail_promise.matches ≥ 0.6`. If any fails, **don't ship**: surface the failing check + its `why` to the user. The agent CANNOT generate new footage — if the hook line itself is the problem, run `rewrite_hook` to produce 3 candidate rewrites, surface them, and let the user decide between (a) picking an alternative opener from the source, or (b) re-shooting.

---

## Step 4 — Multi-format render

```
render_multi_format(input=long-form.mp4,
                    outputDir="./out",
                    formats=["youtube-1080p"],
                    faceTracked=false)
render_multi_format(input=clip.delivery.mp4,
                    outputDir="./out/shorts",
                    formats=["shorts-9x16", "instagram-4x5"],
                    faceTracked=true)               # already face-reframed
```

`faceTracked=true` on vertical formats skips the dumb centre-crop because we already pre-cropped via `face_reframe`.

---

## Step 5 — Metadata bundle (REQUIRED before declaring done)

```
generate_youtube_metadata(transcript,
                          channelStyle="${brand.kit channel style or omit}",
                          videoTopic="${user prompt or omit}")
                                                     → titles[3], description,
                                                       tags[15], chapters[],
                                                       hashtags[]
```

Thumbnails — produce A/B variants using single-variable strategy:

```
compose_thumbnail_variants(input=long-form.mp4,
                           outputDir="./thumbs",
                           text="<distill best title to 2–4 words>",
                           count=3,
                           strategy="expression",     # vary expression, hold label
                           detail="low")             → 3 variants, ranked
```

If the source has only ONE expressive face / strong product frame: use `strategy="label"` to vary the 2–4-word label across 3 versions of the same image instead.

For Shorts, the same call with `count=3` per short — viewers can A/B at the Short level too.

**Brand kit auto-applied.** If `<cwd>/.gg/brand.json` exists, `compose_thumbnail_variants` already inherits `fonts.heading` and `colors.primary`. The agent does not pass these explicitly. The output reports `brandKitLoaded: true` so the agent can confirm.

**Test & Compare is user-action, not agent-action.** Tell the user: *"Upload all three thumbnails to YouTube Studio's Test & Compare. YouTube picks the winner by Watch Time Share over 1–14 days. The agent can't trigger this — there's no API."*

---

## Step 6 — Pre-render check + render

**Long-form audit chain (REQUIRED before final render):**

```
pre_render_check(timelineEmpty=false,
                 expectCaptions=true,
                 loudnessSource=long-form.mp4,
                 loudnessTarget="youtube")

audit_retention_structure(transcript=transcript.json,
                          checkpoints=[180, 360, 540])  # 3, 6, 9 min for >12min videos
                                                         # → weakest checkpoint + suggestion

verify_thumbnail_promise(thumbnail=thumbs/variant-1.jpg,
                         video=long-form.mp4,
                         windowSec=60)                  # MrBeast: match clickbait expectations in first minute
```

If `pre_render_check` returns `severity="block"`, OR `audit_retention_structure` returns a checkpoint with `score < 0.5`, OR `verify_thumbnail_promise.matches < 0.6` — **don't render past it.** Surface the issue + the tool's suggestion. For retention checkpoints, propose `cut_filler_words`, `text_based_cut`, `punch_in`, or `add_sfx_at_cuts` on the flat window.

For Resolve users:
```
list_render_presets()
render(preset="<from list>", output="...")
```

For everyone else, the file-only `render_multi_format` results from Step 4 ARE the deliverable.

---

## Final report to the user

End the run with a structured summary:

```
✅ Long-form ready:   ./out/long-form.mp4  (12:34, -14 LUFS, captions attached)
   Description:        ./out/long-form.description.txt
   Thumbnails:         ./thumbs/long-form.{1,2,3}.jpg  (best first)
   Chapters:           5 chapters from real topic shifts

✅ Shorts (3):
   1. ./out/shorts/short-1.mp4  hook=82, virality=71  "How I built X in 3 days"
   2. ./out/shorts/short-2.mp4  hook=76, virality=68  "The bug that cost me a week"
   3. ./out/shorts/short-3.mp4  hook=71, virality=63  "Why this framework wins"

⚠️  1 candidate dropped (hook score 54 < 60): 'And so basically what I learned was…' — silent open
```

User reads the summary, picks a title from the three options, uploads. Done.

---

## Defaults & tuning

- **Hook gate**: 60 (drops the bottom-tier candidates) — from `analyze_hook`.
- **Virality gate**: 50 — from `score_clip` total.
- **First-frame gate**: 60 — from `audit_first_frame` (Shorts only).
- **Thumbnail-promise gate**: 0.6 — from `verify_thumbnail_promise`.
- **Retention-checkpoint gate**: 0.5 per checkpoint — from `audit_retention_structure`.
- **Short duration range**: 20–45 s (Hoyos's 30–34 s sweet spot ± buffer) — already the `find_viral_moments` default.
- **Loudness**: -14 LUFS / -1 dBTP for YouTube + every short-form platform.
- **Caption style** (vertical): yellow keyword pop on white default, lower-third margin 220, `autoEmoji=true`.
- **SFX gain** on cuts: -8 dB (sits below voice).
- **Loop match**: 0.3 s crossfade on every Short before delivery (`loop_match_short`).

## What the agent CANNOT do (be honest with the user)

- **Generate new footage.** No re-shoots, no AI-generated scenes. Only re-cut from existing source.
- **Trigger YouTube Studio Test & Compare.** No public API. Agent produces 3 variants; user uploads them.
- **Read live channel metrics.** No public CTR / AVD feed. If the user wants a diagnosis based on real numbers, ASK them to paste from Studio (or paste a retention CSV they exported).
- **Re-record a hook line.** `rewrite_hook` proposes 3 rewrites; the user has to either pick an existing alternative opener from source (use `text_based_cut`) or re-shoot.

Override via the brand kit when present — `brand.json` can carry channel-level defaults.
