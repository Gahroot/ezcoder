---
"@kenkaiiii/ggcoder": patch
---

Make replies answerable at a glance: the "How to Talk" section now reserves markdown blockquotes for the one thing only the user can decide (`> **<the ask>?** <what happens next>`) and forbids them everywhere else, so a `>` in a reply always means "you're up". Adds a compression rule (reasoning, findings, and history earn a clause only when they change the next move) and a plain-language rule: keep the exact term or identifier, but say what it does or risks in the same sentence the first time it appears, so a reply is answerable without knowing the codebase. Overlapping progress/scannability lines were folded together to pay for part of the added length.

The rules are also reconciled so they can't pull the model in two directions: the ask defers to How to Work's single stop list instead of publishing a second one, the sentence cap says what it counts (prose — not a step list or the ask), and mid-turn speech is gated on "the plan changes" so a bare finding can't both trigger a message and be cut for not changing the next move. A new test locks all four in place.
