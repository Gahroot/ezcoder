---
"@kenkaiiii/ggcoder": minor
---

Add a bundled `bulletproof` skill that hardens what you are shipping against a real attacker, on any target — web, API, CLI, desktop, mobile, embedded, smart contract, ML pipeline, or game. It profiles the attack surface from the code, ranks by what actually breaches small teams (exposed secrets, missing authorization at the data layer, supply-chain and install-time execution) rather than by what is most interesting, builds the control instead of describing it, and leaves a regression test and CI gate behind. It never certifies software as secure and never produces exploit code.

Its references cover the 2026 threat landscape — AI-orchestrated intrusion, self-propagating registry worms, slopsquatted packages, CI cache poisoning — plus per-platform playbooks, agent/LLM/MCP surfaces, and the secure defaults to write the first time. Every dated claim carries a verified/snapshot/uncertain marker so stale advisories are not asserted as current.

**The `/bullet-proof` slash command is removed** — it is now the `bulletproof` skill. The skill routes itself, so security review no longer depends on remembering a command, and it also fires inline while you build instead of only after. One source of truth instead of a command prompt that drifts from it.

Security defaults are also always on: the system prompt now tells the agent to write the safe version during normal feature work — treat external input as hostile, parameterize queries, authorize at the data layer, never commit or log a secret, confirm a dependency exists before adding it, and never silently weaken a security control.
