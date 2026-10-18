---
"@kenkaiiii/ggcoder": patch
---

The bash tool no longer appends a "Verification evidence rejected" note to checks whose exit status can't prove success (e.g. `npm test | grep x; git diff`). The model almost always re-ran the suite after it, and the output it already had was correct. Such checks still don't count as verification: run status reports the turn as incomplete, as before. On Claude Haiku 5.5 this cut model requests about 7% and input tokens about 9%, with no change in pass rate.
