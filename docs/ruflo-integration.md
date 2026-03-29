# Ruflo Integration into Bobbit — Design Document

> **Status**: Research / Evaluation  
> **Date**: 2026-03-29  
> **Author**: Bobbit Team  

---

## 1. Executive Summary

**Bobbit** is a remote coding agent gateway built on Node.js that manages Claude Code sessions via HTTP + WebSocket, with team orchestration (team lead + role agents in git worktrees), a workflow/gate system, task management, and MCP tool integration.

**Ruflo** (formerly claude-flow) is an enterprise AI orchestration platform that layers on top of Claude Code, providing multi-agent swarm coordination, self-learning routing (SONA), vector memory (HNSW), token optimization, and 313 MCP-exposed tools.

The two systems solve related but distinct problems:
- **Bobbit** focuses on the *gateway* — session management, UI, workflow enforcement, and team coordination for goal-driven development
- **Ruflo** focuses on the *intelligence layer* — how agents learn, remember, coordinate at scale, and optimize token usage

This creates a natural integration opportunity: Bobbit provides the structured development workflow, ruflo provides the intelligence infrastructure. The key insight is that **the best integration path is composition via MCP, not code-level coupling**. Bobbit already auto-discovers MCP servers and exposes their tools — ruflo already exposes its capabilities as MCP tools. The integration can start with zero Bobbit code changes.

---

## 2. Overlap Analysis

### 2.1 Multi-Agent Orchestration

| Dimension | Bobbit | Ruflo |
|-----------|--------|-------|
| **Model** | Team Lead + role agents (coder, reviewer, tester) | Queen/worker hierarchies with specialized types |
| **Max agents** | Up to ~12 concurrent (practical limit from child processes) | Unlimited (claims hundreds) |
| **Isolation** | Git worktrees per agent — filesystem isolation | Shared memory space with agent scopes |
| **Coordination** | Team lead creates tasks, assigns work, reviews PRs | 4 topologies (mesh/hierarchical/ring/star), 5 consensus algorithms |
| **Communication** | Via gateway (WebSocket → RPC bridge → agent process) | Direct inter-agent messaging within swarm |

**Overlap**: Both spawn multiple specialized agents for coding tasks.  
**Complementary**: Bobbit excels at *structured workflow* (gates, verification, PR review). Ruflo excels at *dynamic coordination* (consensus, topology adaptation). Bobbit's team model is simpler but more predictable; ruflo's is more flexible but harder to reason about.  
**Winner**: For goal-driven development with quality gates, Bobbit's model is better suited. For large-scale parallel exploration without strict workflow, ruflo's swarms would win.

### 2.2 Task Routing

| Dimension | Bobbit | Ruflo |
|-----------|--------|-------|
| **Routing** | Team lead manually creates tasks and assigns to agents | Q-learning router + MoE with 8 experts |
| **Learning** | None — routing is prompt-driven | SONA learns from outcomes, adapts in <0.05ms |
| **Complexity detection** | None — all tasks go through same pipeline | 3-tier: WASM for simple, cheap models for medium, full models for complex |
| **History** | Task state tracked in `task-store.ts`, no outcome-based learning | ReasoningBank stores patterns, knowledge graph ranks insights |

**Overlap**: Both assign work to specialized agents.  
**Complementary**: Ruflo's learned routing could improve Bobbit's task assignment quality over time. Bobbit's structured task model (with dependencies, gate links, state machines) gives ruflo something to route *into*.  
**Winner**: Ruflo clearly excels here — intelligent routing is one of its core differentiators.

### 2.3 Memory and Context

| Dimension | Bobbit | Ruflo |
|-----------|--------|-------|
| **Session persistence** | Disk-based JSON stores, JSONL session files | SQLite with WAL, HNSW vector index |
| **Cross-session context** | Gate content injection (upstream gate content fed to downstream tasks) | Vector memory search across all sessions, knowledge graph with PageRank |
| **Context assembly** | `assembleSystemPrompt()` in `system-prompt.ts` — static parts + AGENTS.md + gate content | Dynamic context retrieval via `memory_search`, compressed by token optimizer |
| **Retrieval** | Exact match (gate IDs, task IDs) | Semantic similarity via HNSW (sub-millisecond, 384-dim embeddings) |

**Overlap**: Both persist session state.  
**Complementary**: Bobbit has *structured* context (gates, tasks, workflow state). Ruflo has *semantic* context (vector search, knowledge graph). Combining these would give agents both explicit workflow context and relevant historical patterns.  
**Winner**: For workflow-aware context, Bobbit. For discovering relevant patterns across history, ruflo.

### 2.4 Consensus and Coordination

| Dimension | Bobbit | Ruflo |
|-----------|--------|-------|
| **Decision authority** | Single team lead — authoritative decisions | 5 algorithms: Raft, BFT, Gossip, CRDT, Majority |
| **Conflict resolution** | Team lead resolves, reviewer gates block bad merges | Byzantine fault tolerance (f < n/3), weighted voting |
| **Drift prevention** | Workflow gates enforce quality, verification harness runs checks | Anti-drift config with hierarchical topology, frequent checkpoints |

**Overlap**: Both try to keep agents aligned.  
**Complementary**: Bobbit's approach is *structural* (gates must pass). Ruflo's is *dynamic* (consensus algorithms adapt). For Bobbit's use case (small teams, quality-focused), the team lead model is simpler and sufficient.  
**Assessment**: Ruflo's consensus algorithms solve a problem Bobbit doesn't really have — Bobbit's teams are small enough that single-authority works well. This is a low-priority integration vector.

### 2.5 MCP Support

| Dimension | Bobbit | Ruflo |
|-----------|--------|-------|
| **Role** | MCP *client* — discovers servers, exposes tools to agents | MCP *server* (313 tools) and *client* |
| **Discovery** | Auto-discovers from `~/.claude.json`, `.mcp.json`, `.bobbit/config/mcp.json` | Registers via `claude mcp add ruflo` |
| **Tool naming** | `mcp__<server>__<tool>` convention | Standard MCP tool names |
| **Transport** | stdio and HTTP | stdio |

**Overlap**: Both integrate with MCP.  
**Complementary**: This is the **primary integration vector**. Bobbit's MCP client infrastructure (`McpManager` in `src/server/mcp/mcp-manager.ts`) is designed to discover and connect to exactly the kind of server ruflo provides. No code changes needed.  
**Winner**: N/A — they play different roles. Together they form a complete MCP pipeline.

### 2.6 Security

| Dimension | Bobbit | Ruflo |
|-----------|--------|-------|
| **Auth** | TLS + bearer token (per-project, mode 0600) | AIDefence module with threat detection |
| **Input validation** | Token validation on HTTP/WS, rate limiting | Path traversal prevention, command injection blocking, prompt injection detection |
| **Scope** | Gateway-level (who can connect) | Agent-level (what agents can do) |

**Overlap**: Both address security but at different levels.  
**Complementary**: Bobbit secures the gateway perimeter; ruflo secures agent behavior. Combining them would provide defense in depth.

---

## 3. Integration Vectors

### 3.1 Ruflo as MCP Server (Recommended First Step)

**What it provides**: Immediate access to ruflo's 313 tools including `memory_search`, `memory_store`, `swarm_init`, `agent_spawn`, `hooks_route`, `neural_train`, and the full Agent Booster / Token Optimizer toolset.

**How it connects to Bobbit**: Add ruflo to the project's `.mcp.json`. Bobbit's `McpManager` auto-discovers it on startup, connects via stdio transport, and exposes all tools as `mcp__ruflo__<tool>` to agent sessions.

**Configuration** — add to `.mcp.json`:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    },
    "ruflo": {
      "command": "npx",
      "args": ["-y", "ruflo@latest", "mcp", "start"]
    }
  }
}
```

Or via `.bobbit/config/mcp.json` for Bobbit-specific config:

```json
{
  "mcpServers": {
    "ruflo": {
      "command": "npx",
      "args": ["-y", "ruflo@latest", "mcp", "start"]
    }
  }
}
```

**Bobbit code changes**: **Zero**. The `McpManager.discoverServers()` method in `src/server/mcp/mcp-manager.ts` already handles discovery from these config files. Tools appear automatically in the system prompt and Tools UI.

**What agents would see** — new tools available:

| Tool | Purpose | When useful |
|------|---------|-------------|
| `mcp__ruflo__memory_search` | Semantic search across stored patterns | Before starting any task — find similar past work |
| `mcp__ruflo__memory_store` | Save successful patterns with embeddings | After completing a task — remember what worked |
| `mcp__ruflo__swarm_init` | Initialize agent coordination | Complex multi-file changes |
| `mcp__ruflo__agent_spawn` | Register specialized agent roles | When the task needs expertise |
| `mcp__ruflo__hooks_route` | Intelligent task routing | Let ruflo suggest optimal handling |
| `mcp__ruflo__neural_train` | Train on accumulated patterns | Periodic improvement cycles |

**Effort**: 1-2 days (config + testing + documentation)  
**Value**: High — agents gain persistent memory and intelligent routing with no code changes  
**Risk**: Low — MCP is a standard protocol, ruflo is optional, failures are isolated

**Caveats**:
- The `npx ruflo@latest mcp start` command downloads ~45-340MB depending on install profile
- Ruflo's MCP server runs as a child process per Bobbit gateway instance — memory overhead
- The 313 tools claim needs verification — some may be stubs or low-maturity
- Tool quality varies; agents need guidance on which ruflo tools are production-ready

### 3.2 Swarm Coordination for Team Agents

**What it provides**: Replace or augment Bobbit's team lead + role agent model with ruflo's swarm topologies, queen/worker hierarchies, and consensus algorithms.

**How it would connect to Bobbit**: The team agent spawning logic in Bobbit lives in `src/server/agent/session-manager.ts` (session creation, agent process management) and the team orchestration is handled by team lead prompts and `team-manager`/`team-store`. Integrating swarm coordination would require:

1. Replacing the team lead's task-creation/assignment logic with ruflo's routing
2. Using ruflo's topology (hierarchical, mesh) instead of Bobbit's flat team structure
3. Mapping ruflo's consensus mechanisms to Bobbit's gate/verification system

**Bobbit code changes**:
- `src/server/agent/session-manager.ts` — new session spawning mode for swarm agents
- `src/server/ws/handler.ts` — new WS commands for swarm status/control
- `src/server/agent/team-store.ts` — extend to track swarm topology state
- Team lead system prompt — complete rewrite to delegate routing to ruflo
- UI components for swarm visualization

**Effort**: 4-8 weeks  
**Value**: Medium — could improve coordination for very large tasks, but Bobbit's current model works well for typical team sizes (3-6 agents)  
**Risk**: High — deep architectural coupling, ruflo becomes a hard dependency, debugging swarm behavior is significantly harder than debugging a team lead prompt

**Assessment**: This is the highest-risk integration with uncertain value. Bobbit's team model is simple, predictable, and works well within its design constraints. Swarm coordination solves a problem Bobbit doesn't strongly have today. **Recommend deferring to Phase 4 (research/POC).**

### 3.3 Self-Learning Task Router

**What it provides**: Use ruflo's SONA (Self-Optimizing Neural Architecture) to learn which agent types, personalities, and configurations perform best for different task types. Over time, task assignment becomes data-driven rather than prompt-driven.

**How it would connect to Bobbit**: The learning loop would sit between task creation and agent assignment:

```
Task created → SONA evaluates → Recommends agent type/personality → Team lead (or auto) assigns

After completion:
Task outcome → SONA trains → Improves future routing
```

**Integration approach (via MCP)**:
1. Before assigning a task, query `mcp__ruflo__hooks_route` with task description + metadata
2. Ruflo returns recommended agent type, suggested approach, and confidence score
3. Team lead uses recommendation (or overrides if confidence is low)
4. After task completes, call `mcp__ruflo__memory_store` with outcome data

This can be done **entirely via MCP** without code changes — it's a prompt engineering task for the team lead.

**More integrated approach** (code changes):
- `src/server/agent/system-prompt.ts` — inject routing recommendations into team lead prompt
- `src/server/agent/task-store.ts` — add outcome tracking (success/failure, time, cost)
- New module: `src/server/agent/learning-bridge.ts` — interface between task outcomes and ruflo's learning
- `src/server/ws/handler.ts` — new WS commands for routing insights

**Effort**: 1-2 weeks (MCP approach) or 3-4 weeks (integrated approach)  
**Value**: Medium-High — better routing = fewer failed tasks, lower costs, faster completion  
**Risk**: Medium — depends on ruflo's learning actually improving over time (needs measurement)

### 3.4 Vector Memory for Session Context

**What it provides**: Persistent semantic memory across all Bobbit sessions. Agents could search for patterns, solutions, and architectural decisions from past sessions before starting new work.

**How it would connect to Bobbit**: Enhance the system prompt assembly pipeline to include relevant retrieved context.

**MCP-only approach** (no code changes):
- Agents use `mcp__ruflo__memory_search` directly in their workflow
- Agents call `mcp__ruflo__memory_store` to save useful patterns
- Works immediately once ruflo MCP is configured

**Integrated approach** (code changes to `src/server/agent/system-prompt.ts`):

```typescript
// In assembleSystemPrompt(), after building base parts:
async function getRelevantContext(taskDescription: string): Promise<string> {
  // Call ruflo's memory_search via MCP
  const results = await mcpManager.callTool('ruflo', 'memory_search', {
    query: taskDescription,
    limit: 5,
    threshold: 0.7
  });
  if (!results?.length) return '';
  return `\n## Relevant Past Patterns\n${results.map(r => 
    `- **${r.key}** (score: ${r.score}): ${r.value}`
  ).join('\n')}`;
}
```

This would add a "Relevant Past Patterns" section to every agent's system prompt, populated by semantic search against ruflo's HNSW index.

**Bobbit code changes**:
- `src/server/agent/system-prompt.ts` — add optional context retrieval step
- `src/server/agent/session-manager.ts` — pass task context to prompt assembly
- Config: new `project.yaml` setting to enable/disable memory augmentation
- Ensure memory retrieval is non-blocking (with timeout) so it doesn't slow session startup

**Storage considerations**:
- Ruflo stores vectors in its own SQLite + HNSW index
- Bobbit doesn't need to store or manage the vectors — ruflo owns that
- Memory persists across Bobbit restarts (ruflo's storage is independent)

**Effort**: 1-2 weeks  
**Value**: High — cross-session learning is one of Bobbit's biggest gaps. Agents currently start fresh each session (except for gate content injection which is workflow-scoped, not semantic).  
**Risk**: Low-Medium — retrieval quality depends on what gets stored and embedding quality

### 3.5 Token Optimizer

**What it provides**: 30-50% token reduction via context compression, caching, and WASM transforms for simple code operations.

**How it would connect to Bobbit**: The optimizer would sit between Bobbit's RPC bridge and the LLM provider, intercepting messages to compress context and cache responses.

**Architecture**:
```
Agent session → RPC bridge → [Token Optimizer] → LLM API
                                ↓
                          Cache hit? → Return cached
                          Simple edit? → WASM transform (skip LLM)
                          Complex? → Compress context → Forward to LLM
```

**Bobbit code changes**:
- `src/server/agent/rpc-bridge.ts` — intercept outbound messages for compression
- New module: `src/server/agent/token-optimizer.ts` — compression pipeline
- `src/server/agent/cost-tracker.ts` — track savings from optimization
- Config: `project.yaml` settings for optimization levels

**MCP approach** (partial, no code changes):
- Agents can call `mcp__ruflo__hooks_route` which includes Agent Booster detection
- Simple edits get flagged with `[AGENT_BOOSTER_AVAILABLE]` — agent can use Edit tool directly
- This captures some savings but not the full compression pipeline

**Effort**: 2-4 weeks for full integration, or 0 for partial MCP approach  
**Value**: High if claims are verified — 30-50% cost reduction is significant at scale  
**Risk**: Medium-High — the savings claims need independent verification, compression could degrade output quality, WASM transforms may not match agent behavior

**Verification needed**: Before investing in integration, run controlled experiments:
1. Same set of tasks with and without token optimization
2. Measure actual token counts, completion quality, and error rates
3. Verify the 30-50% claim with Bobbit's actual workload patterns

---

## 4. Architecture Fit

### 4.1 Integration Impact by Approach

| Approach | Server changes | Client/UI changes | Config changes | New dependencies | Ruflo required? |
|----------|---------------|-------------------|----------------|-----------------|----------------|
| **MCP server** | None | None | `.mcp.json` only | ruflo npm package (runtime) | No — optional MCP server |
| **Swarm coordination** | Major (`session-manager`, `team-store`, `handler`) | New swarm UI components | Team topology config | ruflo core + swarm module | Yes — hard dependency |
| **Self-learning router** | Minor (`system-prompt`, `task-store`) | Optional routing UI | `project.yaml` settings | ruflo MCP (runtime) | No — degrades gracefully |
| **Vector memory** | Minor (`system-prompt`) | Optional memory UI | `project.yaml` settings | ruflo MCP (runtime) | No — degrades gracefully |
| **Token optimizer** | Moderate (`rpc-bridge`, new module) | Cost dashboard updates | Optimizer config | ruflo core + WASM | Ideally no — fallback to uncompressed |

### 4.2 Impact on Existing Features

**Sessions**: MCP approach has zero impact. Swarm approach would require rethinking session lifecycle. Memory and router approaches add optional context to existing sessions.

**Goals/Workflows/Gates**: No integration approach requires changes to the goal/gate system. The learning router could optionally use gate pass/fail outcomes as training signal, but this is additive.

**Task management**: Router integration would enhance task creation with recommendations. All other approaches are transparent to task management.

**MCP infrastructure**: Already designed for this. `McpManager` handles discovery, connection, tool routing. Adding ruflo is identical to adding any other MCP server (like the existing Playwright MCP config).

### 4.3 Dependency Sizing

| Install profile | Size | What you get |
|----------------|------|--------------|
| `ruflo --omit=optional` | ~45MB | CLI + MCP server, no ML/embeddings |
| `ruflo` (full) | ~340MB | Everything including ONNX, HNSW, WASM |

For the MCP-only approach, the minimal install (~45MB) is sufficient. Vector memory requires the full install for HNSW and embeddings.

### 4.4 Optionality Principle

A critical design constraint: **ruflo must remain optional**. Bobbit should function identically with or without ruflo installed. This rules out any approach that makes ruflo a hard dependency.

Achieved by:
- MCP integration: ruflo is just another MCP server — if not configured, nothing changes
- System prompt augmentation: memory retrieval wrapped in try/catch with timeout — if ruflo is unavailable, prompt assembly proceeds without it
- Learning router: recommendations are advisory — team lead can ignore them
- Token optimizer: if disabled or unavailable, messages pass through unmodified

---

## 5. Effort vs Value Matrix

| # | Integration | Effort | Value | Risk | Prerequisites |
|---|-------------|--------|-------|------|--------------|
| 1 | **Ruflo as MCP server** | 1-2 days | **High** — immediate access to 313 tools, memory, routing | Low | `npx ruflo` must work reliably |
| 2 | **Vector memory** | 1-2 weeks | **High** — cross-session learning fills Bobbit's biggest gap | Low-Med | Phase 1 (MCP server running) |
| 3 | **Self-learning router** | 1-2 weeks | **Medium-High** — better task assignment, fewer failures | Medium | Phase 1, outcome tracking |
| 4 | **Token optimizer** | 2-4 weeks | **Medium-High** — significant cost savings *if claims verified* | Med-High | Phase 1, benchmarking |
| 5 | **Swarm coordination** | 4-8 weeks | **Medium** — solves problem Bobbit doesn't strongly have | High | Deep architectural work |

**Recommended priority**: 1 → 2 → 3 → 4 → 5

The ordering follows two principles:
1. **Lowest coupling first** — MCP composition before code integration
2. **Highest certainty first** — memory search is a known-valuable capability; token savings need verification

---

## 6. Risks

### 6.1 Dependency Size

Ruflo's full install is ~340MB including ONNX runtime, HNSW index, and WASM modules. The minimal install (~45MB) covers the MCP server. For cloud deployments, this adds non-trivial image size. **Mitigation**: Start with `--omit=optional` for Phase 1-2; only go full for vector memory.

### 6.2 Maintenance Burden

Ruflo is actively developed (6,000+ commits, v3.5) but is a single-maintainer project. API stability is uncertain — tool names, parameters, and behaviors may change between versions. **Mitigation**: Pin ruflo version in `.mcp.json` args (`ruflo@3.5.0` not `ruflo@latest`). Wrap ruflo calls in abstraction layers. Integration tests that verify MCP tools return expected shapes.

### 6.3 Architectural Coupling

The deeper the integration, the more Bobbit's architecture depends on ruflo's internal design. Swarm coordination (Vector 3.2) is the highest-risk option — it would make ruflo a load-bearing dependency. **Mitigation**: Stick to MCP-based composition for Phases 1-3. Only consider code-level integration after extensive production experience with MCP.

### 6.4 Performance

Each MCP tool call adds latency: stdio transport overhead + ruflo processing + embedding computation. For vector memory search, expect 10-100ms per query (HNSW is fast but stdio adds overhead). For system prompt augmentation, this happens once per session — acceptable. For per-message optimization, the latency budget is tighter. **Mitigation**: Cache results aggressively. Use timeouts (500ms for prompt augmentation, fail open). Profile before optimizing.

### 6.5 Maturity

Ruflo's components are at different maturity levels:
- **MCP server**: Production-ready (widely used with Claude Code)
- **HNSW memory**: Solid (based on well-understood algorithms)
- **SONA learning**: Claims need verification (<0.05ms adaptation, 89% routing accuracy)
- **Token optimizer**: 30-50% savings claim needs independent measurement
- **Swarm consensus**: 5 algorithms implemented but unclear how battle-tested
- **Agent Booster (WASM)**: Limited to 6 transform types — useful but narrow

**Mitigation**: Phase 1 (MCP) lets us evaluate maturity empirically before committing to deeper integration.

### 6.6 Overlap Friction

Both Bobbit and ruflo manage agents, tasks, and coordination. If both systems try to control the same things, conflicts arise:
- Who decides which agent runs a task? (Bobbit's team lead vs ruflo's router)
- Who manages agent lifecycle? (Bobbit's `session-manager` vs ruflo's swarm)
- Where is the source of truth for task state? (Bobbit's `task-store` vs ruflo's internal state)

**Mitigation**: Clear boundary — Bobbit owns workflow, tasks, sessions, and UI. Ruflo owns memory, routing intelligence, and optimization. Ruflo advises, Bobbit decides.

### 6.7 Claims Verification

Ruflo's README makes aggressive performance claims. These should be independently verified before any investment beyond Phase 1:

| Claim | Verification approach |
|-------|----------------------|
| 313 MCP tools | Count actual tools returned by MCP `tools/list` |
| <0.05ms SONA adaptation | Benchmark with Bobbit's task patterns |
| 30-50% token savings | A/B test same tasks with/without optimizer |
| Sub-millisecond HNSW retrieval | Measure end-to-end including stdio transport |
| 89% routing accuracy | Define accuracy metric, measure against Bobbit tasks |
| 100+ agent types | Inventory actual agent definitions, assess quality |

---

## 7. Recommended Phased Approach

### Phase 1: Ruflo as MCP Server (1-2 days)

**Goal**: Get ruflo tools available to Bobbit agents with zero code changes.

**Steps**:
1. Add ruflo MCP server config to `.mcp.json`:
   ```json
   {
     "mcpServers": {
       "ruflo": {
         "command": "npx",
         "args": ["-y", "ruflo@3.5.0", "mcp", "start"]
       }
     }
   }
   ```
2. Restart Bobbit gateway — `McpManager` auto-discovers and connects
3. Verify tools appear: `GET /api/mcp-servers` should show `ruflo: connected`
4. Test from an agent session: call `mcp__ruflo__memory_store` and `mcp__ruflo__memory_search`
5. Document available tools, their parameters, and recommended usage patterns
6. Add ruflo tool guidance to relevant role prompts (e.g., tell coders to search memory before starting)
7. Pin the ruflo version once a stable release is confirmed

**Success criteria**:
- Ruflo MCP server starts reliably within 10 seconds
- `memory_store` and `memory_search` work correctly
- No impact on sessions that don't use ruflo tools
- Memory persists across gateway restarts

**Risks at this phase**: Minimal — if ruflo MCP doesn't work reliably, we just remove the config entry.

### Phase 2: Vector Memory Integration (1-2 weeks)

**Goal**: Give agents automatic access to relevant historical context via semantic search.

**Steps**:
1. Define a memory storage convention:
   - Namespace: `bobbit-<project>` to scope per project
   - Key format: `<goal-id>/<task-type>/<summary>` for traceability
   - Value: structured JSON with pattern, solution, outcome, file paths
2. Add optional memory retrieval to system prompt assembly:
   - In `src/server/agent/system-prompt.ts`, add a hook that queries `memory_search` via MCP before assembling the prompt
   - Include top 3-5 results (score > 0.7) as a "Relevant Past Patterns" section
   - Wrap in timeout (500ms) — fail open if ruflo is slow or unavailable
3. Add memory storage triggers:
   - When a task completes successfully, store the pattern via MCP
   - When a gate passes, store the approach that worked
   - When a goal completes, store the summary + key decisions
4. Add `project.yaml` config:
   ```yaml
   ruflo_memory:
     enabled: true
     search_threshold: 0.7
     max_results: 5
     timeout_ms: 500
   ```
5. Add memory usage telemetry to cost tracker

**Success criteria**:
- Agents receive relevant context from past sessions
- Memory retrieval doesn't slow session startup by more than 500ms
- Storage happens automatically on task/goal completion
- System works fine when ruflo is not configured (graceful degradation)

### Phase 3: Token Optimization (2-4 weeks)

**Goal**: Reduce LLM API costs by integrating ruflo's compression and caching pipeline.

**Steps**:
1. **Benchmark first**: Run identical task sets with and without ruflo's token optimizer. Measure:
   - Token counts (input + output)
   - Task completion quality (pass rate on gates)
   - Latency impact
   - Actual cost difference
2. Only proceed if benchmarks show >15% real savings with no quality loss
3. Integration points in `src/server/agent/rpc-bridge.ts`:
   - Intercept outbound context before LLM call
   - Apply compression (via ruflo MCP or direct integration)
   - Cache frequent patterns
   - Track savings in `cost-tracker.ts`
4. Agent Booster integration:
   - For simple code transforms (var→const, add types), detect via `hooks_route`
   - Skip LLM call entirely — apply transform via Edit tool
   - This is the highest-ROI optimization (free vs $0.0002-$0.015 per call)
5. Add optimization metrics to the Bobbit UI cost dashboard

**Success criteria**:
- Verified >15% token reduction with no quality regression
- Cost savings visible in the UI
- Optimization is fully optional (disabled by default until proven)

### Phase 4: Research / POC (Timeline TBD)

**Goal**: Evaluate whether deeper integration (swarm coordination, self-learning router) provides meaningful value for Bobbit's use cases.

**Steps**:
1. **Self-learning router POC**:
   - For 2 weeks, log all task assignments, outcomes, and timing
   - Feed historical data to ruflo's SONA via `neural_train`
   - Compare SONA's routing recommendations against actual team lead decisions
   - Measure: would SONA have picked a better agent? Would task outcomes improve?
2. **Swarm coordination POC**:
   - Pick one complex goal (10+ tasks, multiple agents)
   - Run it twice: once with Bobbit's standard team model, once with ruflo swarm
   - Compare: completion time, token cost, quality (gate pass rate), developer experience
3. **Decision criteria for full integration**:
   - >20% improvement on a meaningful metric (cost, time, quality)
   - Acceptable complexity increase in debugging and maintenance
   - Clear ownership boundary between Bobbit and ruflo

---

## 8. Conclusion

Ruflo and Bobbit are complementary systems with a clear integration path. The key recommendation:

> **Start with composition (MCP), not integration (code changes).**

Bobbit's MCP infrastructure is already designed to discover and connect to external tool servers. Ruflo already exposes its capabilities as MCP tools. Phase 1 requires literally zero lines of Bobbit code — just a config entry. This gives agents access to persistent vector memory, intelligent routing, and 313+ tools immediately.

The phased approach manages risk effectively:
- **Phase 1** (MCP server) validates that ruflo works reliably with Bobbit — zero downside risk
- **Phase 2** (vector memory) addresses Bobbit's biggest gap — cross-session learning — with minimal code changes
- **Phase 3** (token optimizer) targets cost savings but only after empirical verification
- **Phase 4** (swarm/router) explores deeper integration only with production data justifying it

Three principles should guide all integration work:
1. **Ruflo stays optional** — Bobbit must work identically without it
2. **Bobbit owns the workflow** — ruflo advises on routing and provides memory, Bobbit makes decisions
3. **Verify before investing** — ruflo's performance claims need independent measurement before each phase

The combined system would give Bobbit agents persistent memory, learned routing intelligence, and token optimization — capabilities that are genuinely missing today — while maintaining Bobbit's architectural simplicity and workflow rigor.
