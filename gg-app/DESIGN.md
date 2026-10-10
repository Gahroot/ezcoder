# App motion

## Purpose

Preserve GG Coder's existing dense workspace and visual language. Motion should explain a change without competing with reading, scrolling, or the next interaction. These rules concern app interaction motion, not GG Motion video choreography.

- One action has one geometry owner. Keep existing duration/easing tokens in `src/App.css`; JavaScript equivalents are checked by `scripts/motion-tokens.test.mjs`.
- Existing conversation content does not enter again on Checklist return. New visible messages and streamed words use opacity, not blurred or vertically moving text.
- A reversal starts from the currently displayed geometry. Cancel the previous animation before measuring its replacement's natural destination.
- Use layout CSS pixels for keyframes. Convert viewport snapshots under CSS zoom; never mix scaled DOMRects with unscaled layout sizes.
- Reduced motion and missing animation APIs must leave the correct final geometry and working controls without a waiting interval.
- Exiting content is noninteractive immediately. Visual retention must not retain keyboard or accessibility access.
- Own and release animations, observers, and timers. No persistent animation frame loop, unbounded message-ID cache, or stale geometry snapshot.

## Motion roles and reuse map

| Role | Owner | Usage and boundaries |
| --- | --- | --- |
| One-time message entrance | `transcript-motion.ts`: `createEntranceLifetime`, `enterTranscriptRow`; `App.tsx` | Session-local high-water mark consumes eligibility before playback. Hidden arrivals settle on return. Paging and explicit question jumps retain their separate contracts. |
| Streamed word feedback | `useSmoothText.ts`, `StreamingMarkdown.tsx`, `Markdown.tsx` | Hidden/deactivated content returns fully revealed. Fresh visible growth may fade in; reading text is not blurred or scaled. |
| Send/tool layout transaction | `chat-layout-motion.ts`: `createChatLayoutMotion`; `App.tsx` | Capture before the update, commit final layout and scroll position before paint, then translate existing visible rows/surfaces back from their prior positions. Bounds capture to 80 visible rows. One expiry frame releases a capture that never commits; there is no persistent frame loop. |
| Scroll intent | `transcript-pin.ts`; transcript effects in `App.tsx` | These remain the authority. Explicit sends repin; an upward user scroll releases following during replies. Unpinned layout changes preserve row/offset. Do not separately animate `scrollTop`. |
| Composer sizing | `composer-autosize.ts` | Empty-on-send commits the final textarea size immediately. Do not restore an independent shrink animation that competes with the chat transaction. Preserve scheduled `keepInput` and newly typed drafts. |
| In-flow expansion | `animated-height.ts`: `useAnimatedHeight` | Capture displayed height before a toggle. Cancel before measuring natural height; own one reversible WAAPI animation. Pass content changes for retargeting. Used by Markdown code/output, error Details, and the queue list. |
| Retained disclosure/list exits | `usePresenceList.ts`; `ChatErrorNotice.tsx`, `QueuedBar.tsx` | Stable measured shell, padding inside that shell, distinct opacity entry/exit, immediate expanded-state updates. Retained exits are inert and hidden from accessibility navigation. Do not introduce guessed maximum heights. |
| Floating exit snapshots | `FloatingSurface.tsx`, `view-transition.ts`, `Dropdown.tsx` | Keep the boundary mounted while its child becomes absent. Retain inert content only until local snapshot capture, not an arbitrary delay. Selection callbacks run once without waiting for animation. Local exits exclude the root conversation snapshot; nested updates share an existing transition. |
| Equivalent dialog dismissal | `Modal.tsx`, `modal-embed.tsx`: `ModalDismissButton` | Footer Close/Cancel shares the dismissal path with ×/Escape. Preserve focus origin/restoration, nested-dialog semantics, and embedded-page hiding. Async elicitation cancellation sends immediately and animates actual removal when it settles. Save/Confirm/navigation handoffs remain distinct actions. |
| Zoom-aware settings navigation | `SettingsTabBar.tsx`, `motion-geometry.ts`: `viewportScale` | Pill snapshots and label deltas use one coordinate system. Retarget/cancel pill and labels together; resize, zoom, fonts-ready placement, and cleanup remain owned. The helper measures fractional border-box width rather than relying on rounded layout width. |

## Goal world (the one frame loop)

A started Goal's **Workers** view is a top-down pixel farm (`GoalWorld.tsx`, `goal-farm-*.ts`, art in `goal-map-*.ts`) that fills the window edge to edge, under a frosted, see-through header; the header's Chat | Workers switch flips to the conversation. It is the one deliberate exception to "no persistent animation frame loop", bounded like this:

- It loads on demand (`lazy`), so none of it is in the start-up bundle; it stays mounted while hidden (`Activity`), so switching views never rebuilds it.
- The static map (ground, buildings, trees, beds) is composed once per size into an offscreen canvas (~0.15s). A resize waits for the window to settle, and only rebuilds when the map's tile size or scale changes. A frame redraws only what moves: critters and their rides, the fire, steam, koi, falling petals, the cat, chickens and dragonfly.
- About 30fps while someone travels, arrives or leaves; about 10fps while the farm only idles.
- Window motion level decides the rest: `full` animates; `still` (unfocused) shows a picture repainted every 600ms with nobody travelling and the fire and water at rest; `off` (hidden) draws nothing. Unmounting releases the loop, the interval and the resize observer.
- `prefers-reduced-motion` behaves like `still`. The canvas is `aria-hidden`; a visually hidden live summary says who is doing what.
- One camera angle throughout: 3/4 from above, so for anything standing up its *top* is the biggest thing you see (a roof is mostly roof; a tub is mostly its rim and water). New art follows `goal-map-topdown.ts`.
- The whole farmstead is always in view: `farmScale` is the exact scale at which it fills the space below the header, so the farm shrinks and grows smoothly with the window. It is deliberately not a whole number (a whole-number scale jumped from 2× to 1× just below full screen, halving the farm); nearest-neighbour scaling keeps it crisp. Countryside fills any extra space. Speech bubbles use the 3x5 pixel font (`goal-world-font.ts`), never canvas text.

## Extending an interaction

1. Identify its existing geometry owner before adding animation.
2. Capture the visible starting state before the state update; measure the natural destination only after cancelling an old override.
3. Keep callbacks, focus, and accessibility state independent of visual completion.
4. Cover reversal, content change, hidden/reactivated views, unmount, reduced motion, and missing APIs in the existing tests.
5. Verify intermediate rendered geometry, not only final DOM state or screenshots.

Do not replace genuine in-flow expansion with scaled text merely to avoid animating height. Unrelated decorative effects and established paging/jump effects are not implicitly removed by these rules.

## Verification and evidence

`scripts/check-motion-continuity.mjs` bundles the real App and isolated production components once, with production CSS and a fictional local Tauri bridge. Unknown consequential bridge calls fail visibly. It needs the existing Playwright Chromium and WebKit installations; no provider or terminal task is required.

Run the acceptance check without `--record`:

```sh
pnpm --filter gg-app exec node scripts/check-motion-continuity.mjs
```

The runner samples intermediate geometry, uses controlled animation times for reversals, and saves normal-playback recordings and screenshots. Coverage includes 1280px/640px, Checklist states and hidden streaming, send/pinning, disclosures, tool-panel changes, menu/dialog dismissal, fallback modes, and CSS zoom at 50%, 95%, 100%, 125%, 150%, and 200%. `--record` only records a baseline; it is not acceptance.

Dated evidence and finding status live in the ignored `.gg/reports/app-motion-review-2026-10-07.md` and its adjacent artifact directory. Automated passes do not override an unresolved screenshot anomaly. Browser Chromium/WebKit is not native Tauri verification: native macOS smoke, Windows WebView2, and blocking cross-platform CI remain separate release gates.
