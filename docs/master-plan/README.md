# n8n-uno-q — Master plan

> **Instructions for Claude Code:** read this index first, then read each section file in order before any other action in this repo. Together they capture all architectural decisions, verified facts about the target hardware, and the rationale behind them. Treat them as the source of truth. When you make a decision that contradicts anything in these files, update the relevant section file in the same commit — don't let it drift.

This master plan was originally a single `CONTEXT.md` at the repo root. It grew to ~1250 lines and was split into one file per top-level section so individual chapters can be read, edited, and cross-linked without scrolling through unrelated material. The contents are otherwise identical — see [verification](#verification) below.

## Sections

| # | Section | File |
|---|---|---|
| 1 | What we're building | [01-what-were-building.md](01-what-were-building.md) |
| 2 | Architecture decision: direct to router, no Python proxy | [02-architecture-decision.md](02-architecture-decision.md) |
| 3 | Verified facts about my UNO Q (`linucs.local`) | [03-verified-uno-q-facts.md](03-verified-uno-q-facts.md) |
| 4 | Protocol reference | [04-protocol-reference.md](04-protocol-reference.md) |
| 5 | Package 1 — `@raasimpact/arduino-uno-q-bridge` | [05-package-bridge.md](05-package-bridge.md) |
| 6 | Package 2 — `n8n-nodes-uno-q` | [06-package-n8n-nodes.md](06-package-n8n-nodes.md) |
| 7 | Dev workflow architecture: decisions | [07-dev-workflow.md](07-dev-workflow.md) |
| 8 | Open items and risks | [08-open-items-risks.md](08-open-items-risks.md) |
| 9 | Test log — what's already verified on my Q | [09-test-log.md](09-test-log.md) |
| 10 | References | [10-references.md](10-references.md) |
| 11 | Project-level decisions | [11-project-decisions.md](11-project-decisions.md) |
| 12 | Multi-Q support | [12-multi-q.md](12-multi-q.md) |
| 13 | Arduino Cloud integration (`n8n-nodes-arduino-cloud`) | [13-arduino-cloud.md](13-arduino-cloud.md) |
| 14 | Reverse-SSH relay (`deploy/relay-ssh/`) — *new feature plan* | [14-relay-ssh.md](14-relay-ssh.md) |

Section numbering matches the original `CONTEXT.md` — internal cross-references like *"see §12.5.3"* still resolve, they just live in [12-multi-q.md](12-multi-q.md) now.

## How to read

- **Onboarding to the project:** start at section 1 and read in order through section 11. That gives you the full why and what of the v1 stack.
- **Multi-Q work:** sections 7, 12, and (new) 14 are the relevant chapters.
- **Arduino Cloud package:** section 13 is self-contained — read it after section 6 (which establishes the Method node patterns it reuses).
- **Reverse-SSH NAT-traversal feature:** section 14 — depends on the Multi-Q context in section 12, especially §12.5 (relay container variants).

