# Agent Memory — architecture decision record

Status: accepted 2026-06-11 (owner interview + research). Governs the memory layers across
workstreams: EP G2/G3.3 (Hindsight pack), EP G1.6 (session-memory provider), GA-R5
(profile memory), MC Caretaker (retention). Research base:
[code-intelligence-alternatives.md §7](code-intelligence-alternatives.md) + Hindsight
docs/best-practices (verified 2026-06-11).

## §1 Three layers, three jobs — sessions stay local

| Layer | What it is | Job | Lifetime |
|---|---|---|---|
| **Session transcripts** (local JSONL + FlexSearch) | the *system of record* | replay, debugging, flight recorder (MC), audit, exact-quote search | prunable by policy, never silently |
| **Markdown staff memory** (per-role/project files) | *curated, authoritative* procedural knowledge — conventions, gotchas, preferences | always-loaded context; human-auditable and editable | permanent, small |
| **Hindsight pack** (optional, EP G2) | *episodic recall* — distilled facts/experiences/entities/beliefs over high-volume history | "what did we decide about X in March", cross-session/cross-agent recall, temporal queries | grows; managed by the daemon |

**Do we still need local sessions if Hindsight is enabled? Yes — they are different
artifacts.** Hindsight stores *LLM-extracted distillations* (an LLM call per retain), not
transcripts; it is lossy by design and cannot replay a session, settle a "what exactly did
the agent run" dispute, or feed the MC flight recorder. The industry pattern matches:
Claude Code keeps transcripts AND auto-memory; Devin keeps sessions AND Knowledge. Memory
systems answer questions; transcripts prove them.

**Pruning (owner's instinct, adopted):** transcript retention becomes config
(`sessions.retention`: age/size/per-project caps), and the **Caretaker (MC) runs a
consolidation pass before pruning**: for transcripts past the threshold — ensure the
Hindsight retain happened (if pack enabled), write/refresh the markdown summary, then
prune. Order is the invariant: **distill → then delete; never silently drop unretained
history.** This lands as a Caretaker card under MC once EP G2 exists.

## §2 Is Hindsight the best daemon? Yes — comparison and reasons

(Condensed from the research annex §7; URLs there.)

| System | Verdict | Decisive reasons |
|---|---|---|
| **Hindsight** (vectorize-io) — **CHOSEN** | First-party memory pack | MIT; very active (v0.8.1 June 2026, 60+ releases); **official Node/TS SDK + REST + MCP**; hybrid recall (semantic + BM25 + graph + temporal) with reranking; self-hosted on Postgres+pgvector (no external vector-DB dependency); peer-reviewed design (arXiv:2512.12818); the Nous Hermes coding agent ships it as a native memory provider with daemon autostart + 5-min idle stop — the exact pack pattern EP G3.3 plans |
| mem0 | Rejected | Cloud-leaning OSS; benchmark claims disputed by third parties (LoCoMo rebuttals); weaker self-host story |
| Letta (MemGPT) | Rejected | It's a competing *agent harness* with memory inside, not a memory service for ours |
| Zep / Graphiti | Rejected | Zep discontinued its self-hosted CE; only the Graphiti library remains (bring-your-own graph DB + service layer = we'd build the daemon ourselves) |
| cognee | Rejected | Lightest self-host but Python-only SDK — wrong language for the gateway |
| LangMem | Rejected | Little value outside LangChain/LangGraph |
| File-based only | **Kept — as the default** | Zero ops, auditable, in-context; the 2026 production trend (Claude Code, Cursor, Devin are all text-first). It is layer 2, not a rejected option — Hindsight must *earn* its ops cost (Docker/Postgres, LLM call per retain), which is why the pack is optional and file memory stays authoritative for procedural knowledge |

Caveat recorded: many "Hindsight is #1" comparisons are published by vectorize.io itself;
the independent signals are the license, activity, SDK fit, and the Hermes adoption.

## §3 Bank topology: one shared bank, mandatory tags (owner instinct confirmed)

**Verified Hindsight facts (best-practices docs, 2026-06-11):** banks are fully isolated;
**all operations (retain/recall/reflect) target a single bank — cross-bank search is not
supported**; **tags are the filtering mechanism** (metadata is explicitly NOT filterable);
strict modes (`any_strict`/`all_strict`) exist to prevent cross-scope leakage; their docs
endorse "a shared bank with tags" as a standard pattern; banks carry mission/directives/
disposition (bank-level reasoning identity).

**Decision: one shared `bobbit` bank for the whole installation, tag-scoped.**

- Every retain auto-tagged by the pack from session context — agents never hand-tag:
  `project:<id>`, `agent:<role>`, `goal:<id>`, `kind:<decision|gotcha|preference|outcome>`.
  Worktrees get **no** tag dimension (ephemeral; their learnings belong to the project).
- Default recall = strict-scoped to `project:<current>` (+ untagged/org-wide). Explicit
  wider recall = the tool's `scope: project | global | all` arg mapped to tag filters —
  so "have we solved this anywhere before?" is **one native query**, which is the decisive
  argument: with per-project banks that query is impossible (no cross-bank search) short of
  pack-side fan-out across N banks with hand-rolled merging, and reflect could never span
  projects at all.
- One bank also means **one entity graph** (the same staff member, library, or convention
  resolves to one entity instead of N copies) and one mission/disposition to configure.
- **Costs, with mitigations:** (a) reflect/mental-models consolidate bank-wide, so beliefs
  can blend projects — mitigate with `observation_scopes` and project-scoped recall
  defaults; (b) project offboarding needs **delete-by-tag** — verify against the targeted
  Hindsight version at G2 implementation (checkpoint added to the EP plan's G2 notes; if
  absent, fall back to per-project banks for deletion-sensitive installs); (c) multi-tenant
  leakage — not our shape (single-operator installations), but strict tag matching is on
  by default anyway.
- **Escape hatch kept:** isolation-critical projects (client work under NDA) may opt into
  a dedicated bank via project config, accepting invisibility to `scope: all`. Default
  remains shared.

This **changes EP G2's earlier sketch** ("per-project banks", tool arg
`bank: current | global | all`): the manifest description and provider flow now say
*shared tag-scoped bank*, and the tool arg becomes `scope:` backed by tag filters, not
bank switching. Updated in [extension-platform.md](extension-platform.md) (manifest example,
Hindsight pack section).

## §4 Interaction with the other memory-adjacent plans

- **EP G1.6 session-memory provider** (FlexSearch over transcripts) is unaffected — it
  searches layer 1 and works with zero infrastructure; it is also the graceful degradation
  when the Hindsight pack is disabled.
- **GA-R5 profile memory** writes to layer 2 (markdown), optionally mirrored into Hindsight
  as `kind:preference` retains when the pack is on.
- **CI repo map / code intelligence** is spatial, not temporal — no overlap (layer table in
  [code-intelligence.md §1](code-intelligence.md)).
