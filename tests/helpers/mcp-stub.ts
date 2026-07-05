/**
 * Shared test seam for SessionManager unit tests: several SessionManager code
 * paths — restoreSession(), createSession(), createDelegateSession(),
 * assignRole(), and forceAbort()'s force-kill/respawn branch — unconditionally
 * call `ensureMcpManagerForContext()` to rebuild tool-activation args. That
 * builds a REAL McpManager and connects it, which discovers and connects to
 * whatever MCP servers happen to be configured in the ambient
 * ~/.claude.json / ~/.claude/.mcp.json / ~/.bobbit/.mcp.json on the machine
 * running the test — real stdio child processes, real HTTP sockets, entirely
 * unrelated to the test's own fixtures (see McpManager's manual-config
 * cascade in src/server/mcp/mcp-manager.ts). Nothing tears those connections
 * down on a bare `new SessionManager()` in a unit test, so the leaked handles
 * keep the test file's event loop alive well past every `it()` block
 * completing (the file "hangs" when run solo, or under `--test-force-exit`
 * the leaked connect/spawn latency can blow past timing assertions).
 *
 * Stub the MCP manager lookup to a no-op on every `SessionManager` instance a
 * unit test constructs so these code paths never reach out to real ambient
 * infrastructure. `buildToolActivationArgs()` already tolerates a null MCP
 * manager (`mcpManager ? ... : undefined`), so this is a pure test seam with
 * no behavioral change to what's under test.
 *
 * First introduced for tests/session-manager-force-abort-grace.test.ts;
 * reuse this for any unit test that calls createSession / restoreSession /
 * createDelegateSession / assignRole / forceAbort on a plain
 * `new SessionManager()` instead of duplicating the stub inline.
 */
export function stubMcp(manager: any): void {
	manager.ensureMcpManagerForContext = async () => null;
}
