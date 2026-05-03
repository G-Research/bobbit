# Priority 11 — Prompt-Injection Defense

## Verdict summary

| goal | claim | verdict | confidence |
|---|---|---|---|
| 11.1 | Bobbit injects AGENTS.md/CLAUDE.md/memories verbatim with no injection scan; Hermes scans every context file with 13 patterns. | **real** | high |
| 11.2 | YAML frontmatter on memory files reaches the model verbatim; should be stripped. | **partial** | high |
| 11.3 | No sensitive-path write deny-list (`~/.ssh/*`, `/etc/passwd`, …); Hermes has one. | **real** | high |
| 11.4 | No `BOBBIT_WRITE_SAFE_ROOT`-style chroot for write tools; Hermes has `HERMES_WRITE_SAFE_ROOT`. | **real** | high |
| 11.5 | Internal fence tags (`<memory>…`, `<context>…`) can leak when a delta boundary splits a tag. | **unverifiable** | low |

---

## Goal 11.1: Context-file scanner

**Doc claim.** Bobbit injects AGENTS.md, CLAUDE.md, READMEs, memory files verbatim with no scan; should detect 13 prompt-injection patterns (ignore-previous, hidden Unicode, exfil curl/wget, secret-file reads, hidden HTML, base64-pipe, reverse shell, etc.) and warn-and-strip by default.

**Bobbit reality.** `src/server/agent/system-prompt.ts:60-70` (`readAgentsMd`) and `:88-103` (`readClaudeMd`) read AGENTS.md / CLAUDE.md verbatim, run `resolveMarkdownRefs` on `@`-references, and feed the result straight into the assembled system prompt at `:317-324` with no scanning. `grep -rn "inject\|sanitize" src/server/agent/` only matches Unicode surrogate sanitization in pi-ai, not prompt-injection mitigation (audits/bobbit.md:228-231).

**Claude Code reality.** No content-level sanitisation on file reads or web fetches — only a `<system-reminder>` appended to text reads at `src/tools/FileReadTool/FileReadTool.ts:738` ("consider whether it would be considered malware… MUST refuse to improve or augment") and the WebFetch internal-prompt design at `src/tools/WebFetchTool/utils.ts:484-500`. No AGENTS.md scanning, no "ignore previous instructions" detection, no hidden-Unicode check (audits/claude-code.md:273-278, 312-317).

**Hermes reality.** `agent/prompt_builder.py:36-72` defines `_CONTEXT_THREAT_PATTERNS` (10 regexes: `prompt_injection`, `deception_hide`, `sys_prompt_override`, `disregard_rules`, `bypass_restrictions`, `html_comment_injection`, `hidden_div`, `translate_execute`, `exfil_curl`, `read_secrets`) plus `_CONTEXT_INVISIBLE_CHARS` (10 zero-width / RTL-override codepoints). On hit, content is replaced with `[BLOCKED: <file> contained potential prompt injection (<finding>). Content not loaded.]` — malicious instructions never enter the prompt. (Audit notes count is 10+10, not 13 as the doc states.)

**Verdict.** **Real.**

**Reasoning.** Bobbit has zero content-level scanning of injected context files; Hermes has the canonical implementation. The "13 patterns" headline figure is itself slightly off (Hermes ships 10 regex categories plus 10 invisible chars), but the underlying gap is genuine and the reference implementation is concrete and short.

**Minimal proof of gap.**

Bobbit — `src/server/agent/system-prompt.ts:60-70`:
```ts
export function readAgentsMd(cwd: string): string {
    const agentsPath = path.join(cwd, "AGENTS.md");
    if (!fs.existsSync(agentsPath)) return "";
    try {
        const raw = fs.readFileSync(agentsPath, "utf-8");
        return resolveMarkdownRefs(raw, cwd);   // ← raw content, no scan
    } catch {
        return "";
    }
}
```

Hermes — `agent/prompt_builder.py:56-72`:
```python
def _scan_context_content(content: str, filename: str) -> str:
    findings = []
    for char in _CONTEXT_INVISIBLE_CHARS:
        if char in content: findings.append(f"invisible unicode U+{ord(char):04X}")
    for pattern, pid in _CONTEXT_THREAT_PATTERNS:
        if re.search(pattern, content, re.IGNORECASE): findings.append(pid)
    if findings:
        logger.warning("Context file %s blocked: %s", filename, ", ".join(findings))
        return f"[BLOCKED: {filename} contained potential prompt injection ({', '.join(findings)}). Content not loaded.]"
    return content
```

**Scope-down notes.** Adopt the Hermes pattern set verbatim (10 regex + 10 invisible chars) rather than the doc's stated 13 — the doc's table is aspirational and includes patterns Hermes doesn't actually ship (e.g. base64-pipe, reverse-shell idioms, `env | curl`). A second-pass enrichment can add those once the baseline is in place. Default behaviour should be Hermes-style **block-and-replace** rather than the doc's "warn-and-strip", because partial stripping can leave malformed instructions that are themselves a pivot vector.

---

## Goal 11.2: YAML frontmatter strip

**Doc claim.** Frontmatter on memory files reaches the model verbatim and could carry hidden instructions; strip leading `---`-fenced YAML before injection.

**Bobbit reality.** Bobbit *does* parse frontmatter for Claude Code memory files and *does* separate body from frontmatter — but only for the dedicated memory loader. `src/server/agent/system-prompt.ts:75-85` (`parseMemoryFile`) returns `{ name, description, type, body }` with the body stripped of frontmatter, and `readClaudeCodeMemories` (line 105+) is the consumer. AGENTS.md and CLAUDE.md, however, are read raw via `readAgentsMd` (`:60-70`) and `readClaudeMd` (`:88-103`) — `resolveMarkdownRefs` does not strip frontmatter, so any leading `---` block on AGENTS.md flows verbatim into the system prompt.

**Claude Code reality.** Not directly examined for frontmatter stripping, but consistent with audits/claude-code.md:273-278 — no content-level sanitisation on context-file reads.

**Hermes reality.** Frontmatter handling is out-of-band of the threat-pattern scan; whatever remains after `_scan_context_content` is injected. Hermes's mitigation is the regex/invisible-char filter, not a frontmatter strip.

**Verdict.** **Partial.**

**Reasoning.** Bobbit already strips frontmatter from Claude Code memory files (`parseMemoryFile`), so the broad framing "frontmatter reaches the model verbatim" is wrong for that path. The remaining gap is narrower: AGENTS.md and CLAUDE.md (the two files the user is most likely to author) do *not* get frontmatter stripped. The fix is a 5-line helper called from `readAgentsMd`/`readClaudeMd`.

**Minimal proof of gap.**

Bobbit — `src/server/agent/system-prompt.ts:75-85` (frontmatter is parsed only for memories):
```ts
export function parseMemoryFile(content: string): { name: string; description: string; type: string; body: string } | null {
    if (!content.startsWith('---')) return null;
    const endIdx = content.indexOf('\n---', 3);
    if (endIdx === -1) return null;
    const frontmatter = content.slice(3, endIdx);
    const body = content.slice(endIdx + 4).trim();
    // …returns body with frontmatter removed
}
```

But `readAgentsMd` (`:60-70`) and `readClaudeMd` (`:88-103`) never call it — they return `resolveMarkdownRefs(raw, cwd)` directly.

**Scope-down notes.** Reword as "extend `parseMemoryFile`'s behaviour to AGENTS.md and CLAUDE.md". XS effort, no new module. Combine with 11.1 — the frontmatter strip is a no-op precursor to scanning the *body* (so a hidden instruction in YAML doesn't trivially evade a body-only regex).

---

## Goal 11.3: Sensitive-path write deny

**Doc claim.** Bobbit has no static deny list for sensitive paths (SSH keys, AWS creds, shell rcfiles, /etc/passwd, …); should refuse `write`/`edit`/`patch` against ~20 paths.

**Bobbit reality.** Searched `src/`, `defaults/`, `.bobbit/config/tools/filesystem/{write,edit}.yaml` for `BOBBIT_WRITE`, `WRITE_SAFE`, `sensitive_paths`, `deny`, `\.ssh`, `/etc/passwd` — **zero hits**. The filesystem write/edit tools have no path-deny enforcement; security comes only from the optional Docker sandbox boundary (`sandbox: docker` in `project.yaml`). Audit confirms: audits/bobbit.md:228-231 ("No active defense").

**Claude Code reality.** CC has *shell-level* sensitive-path detection — `src/tools/BashTool/bashSecurity.ts:1611-1670, 2089` enumerates exploits like `cat safe.txt \; echo ~/.ssh/id_rsa` and `mv ./decoy '<\n>#' ~/.ssh/id_rsa ./exfil_dir`, and `pathValidation.ts:681` issues `behavior: 'deny'`. But this is `BashTool` parsing of shell commands, not a filesystem-level write tool deny-list. CC's own write tool has no equivalent static deny set examined here.

**Hermes reality.** `agent/file_safety.py:18-66` defines `build_write_denied_paths` (exact files: `~/.ssh/{authorized_keys,id_rsa,id_ed25519,config}`, `~/.bashrc`, `~/.zshrc`, `~/.profile`, `~/.netrc`, `~/.pgpass`, `~/.npmrc`, `~/.pypirc`, `/etc/sudoers`, `/etc/passwd`, `/etc/shadow`) and `build_write_denied_prefixes` (directory prefixes: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `/etc/sudoers.d`, `/etc/systemd`, `~/.docker`, `~/.azure`, `~/.config/gh`). Enforced in `is_write_denied` (`:75-93`) which resolves `realpath` first to defeat symlink escapes.

**Verdict.** **Real.**

**Reasoning.** Concrete, copy-pasteable reference implementation in Hermes; zero equivalent in Bobbit. The doc's path list is a near-exact match for Hermes's deny set.

**Minimal proof of gap.**

Bobbit — `.bobbit/config/tools/filesystem/write.yaml`/`edit.yaml`: no deny enforcement (grep returns no matches for `deny|sensitive|ssh|netrc|passwd`). Write paths go directly to `fs.writeFile` with no pre-check.

Hermes — `agent/file_safety.py:75-93`:
```python
def is_write_denied(path: str) -> bool:
    home = os.path.realpath(os.path.expanduser("~"))
    resolved = os.path.realpath(os.path.expanduser(str(path)))
    if resolved in build_write_denied_paths(home):
        return True
    for prefix in build_write_denied_prefixes(home):
        if resolved.startswith(prefix):
            return True
    safe_root = get_safe_write_root()
    if safe_root and not (resolved == safe_root or resolved.startswith(safe_root + os.sep)):
        return True
    return False
```

**Scope-down notes.** Implement at the `write`/`edit` extension layer (`.bobbit/config/tools/filesystem/`), not in the LLM's prompt — Hermes's enforcement is in tool code, not in the model's instructions. `realpath` resolution is essential (covers symlink escape).

---

## Goal 11.4: Env-controlled write root

**Doc claim.** Add `BOBBIT_WRITE_SAFE_ROOT` env var; when set, refuse all writes outside the resolved subtree (with symlink-escape blocked via realpath).

**Bobbit reality.** No `BOBBIT_WRITE_SAFE_ROOT` (or any equivalent) env var. Search returns zero hits across `src/`, `defaults/`, `.bobbit/config/`. The only confinement Bobbit offers is the optional Docker sandbox (`sandbox: docker`), which is a process boundary, not a per-write path check.

**Claude Code reality.** CC has shell-level read-only mode (`PowerShellTool/readOnlyValidation.ts`, `BashTool/readOnlyValidation.ts`) and Plan Mode, but no equivalent write-root chroot env var.

**Hermes reality.** `agent/file_safety.py:67-73, 88-91` — `HERMES_WRITE_SAFE_ROOT`:
```python
def get_safe_write_root() -> Optional[str]:
    root = os.getenv("HERMES_WRITE_SAFE_ROOT", "")
    if not root:
        return None
    try:
        return os.path.realpath(os.path.expanduser(root))
    except Exception:
        return None
```
And in `is_write_denied`: `if safe_root and not (resolved == safe_root or resolved.startswith(safe_root + os.sep)): return True`.

**Verdict.** **Real.**

**Reasoning.** Direct 1:1 mapping to Hermes; trivial port; same single helper file as 11.3.

**Minimal proof of gap.** Same as above — Bobbit `grep BOBBIT_WRITE_SAFE` → 0 hits; Hermes `file_safety.py:67-73` cited.

**Scope-down notes.** Bundle implementation with 11.3 (one `sensitive-paths.ts` module, `is_write_denied`-equivalent function, both behaviours flow through it). Don't ship 11.4 standalone — without 11.3 the deny-set is empty and the env var alone is brittle.

---

## Goal 11.5: Streaming context-fence scrubber

**Doc claim.** Internal fence tags (`<memory>…</memory>`, `<context>…</context>`) can leak into user-visible deltas if a streaming boundary splits a tag.

**Bobbit reality.** Searched for `<memory>`, `</memory>`, `<context>`, `</context>`, `fence`, `scrub` in `src/` — **zero hits**. Bobbit does not appear to wrap injected context in any custom fence tags in the first place; the system prompt assembles plain `## Heading` markdown sections (`system-prompt.ts:317-324`: `sections.push({ label: "Project Context", source: "AGENTS.md", content: ... })`). Without a tag wrapper, there is no "split-tag leak" failure mode to scrub.

**Claude Code reality.** Uses `<system-reminder>…</system-reminder>` tags around mitigation reminders (`FileReadTool.ts:738`). Not examined for streaming-boundary handling.

**Hermes reality.** Not examined for fence-streaming behaviour; out of scope of this audit.

**Verdict.** **Unverifiable** (leans toward hallucinated for Bobbit specifically).

**Reasoning.** The premise — that Bobbit emits internal fence tags that could be split mid-delta — is not supported by the source. Bobbit's system-prompt assembly uses markdown headings, not custom XML-style fences. If any path does use such tags I did not find it. Until a concrete leak path is identified (i.e. an actual `<memory>…</memory>` emission in user-visible output), this goal is solving a problem that doesn't exist in Bobbit.

**Minimal proof of gap.** N/A — no gap demonstrated.

**Scope-down notes.** Drop unless someone can produce a repro. If the concern is generic streaming-boundary tag-splitting (e.g. a tool emits HTML/XML in deltas), the right fix is a generic delta buffer in the WS frame layer, not a context-specific scrubber. The "< 5 % latency overhead" acceptance criterion is hard to defend without a baseline.

---

## Cross-cutting recommendation

11.1 + 11.2 + 11.3 + 11.4 are all parts of the same Hermes file (`agent/prompt_builder.py:36-72` for context scanning, `agent/file_safety.py:1-93` for write safety). Combined effort is ~1 day in TS: a `src/server/security/` module containing `scanContextContent()`, `stripFrontmatter()`, `isWriteDenied()` plus call-sites in `system-prompt.ts` (read paths) and `.bobbit/config/tools/filesystem/{write,edit}.yaml` extensions. Doc's separate-goal framing is reasonable for accounting but should be implemented as one PR.

11.5 should be dropped or rewritten with concrete repro evidence.
