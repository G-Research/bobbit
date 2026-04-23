/**
 * Generates a pi-coding-agent extension that acts as a tool_call guard.
 *
 * The guard intercepts every tool invocation and enforces access policy:
 * - `allow` or already-granted tools pass through immediately
 * - `ask` tools block until the gateway grants permission (via REST long-poll)
 * - `never` tools are blocked immediately with a clear error message. (In
 *   principle `never` tools should not be registered at all, but some tool
 *   extensions register multiple tools from a single file — e.g.
 *   `defaults/tools/shell/extension.ts` registers both `bash` and `bash_bg`.
 *   When a role allows `bash` but denies `bash_bg`, the extension still
 *   registers both, so the guard has to hard-block the denied one.)
 */

/**
 * Policy info for a single tool, including which group it belongs to.
 */
export interface ToolPolicyEntry {
	policy: string; // 'allow' | 'ask' | 'never'
	group: string;
}

/**
 * Generate the TypeScript source for a tool_call guard extension.
 *
 * @param sessionId - The session ID (used to POST grant requests to the gateway)
 * @param policies - Map of tool name → { policy, group } for all tools with 'ask' policy
 * @param grantedTools - Tools already granted (pre-populated grant set)
 * @returns TypeScript source string for the extension
 */
export function generateToolGuardExtension(
	sessionId: string,
	policies: Record<string, ToolPolicyEntry>,
	grantedTools: string[],
): string {
	// Only include 'ask' and 'never' policies in the generated code —
	// 'allow' tools don't need the guard.
	const askPolicies: Record<string, ToolPolicyEntry> = {};
	const neverPolicies: Record<string, ToolPolicyEntry> = {};
	for (const [name, entry] of Object.entries(policies)) {
		if (entry.policy === 'ask') {
			askPolicies[name] = entry;
		} else if (entry.policy === 'never') {
			neverPolicies[name] = entry;
		}
	}

	return `import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export default function(pi) {
  // Policy map: tool name → { policy, group } (only 'ask' tools included)
  const askPolicies = ${JSON.stringify(askPolicies)};

  // Tools that must be hard-blocked (role/group resolved policy = 'never').
  // Some extensions register multiple tools from one file, so a 'never' tool
  // can still appear in the agent's tool registry — the guard rejects it here.
  const neverPolicies = ${JSON.stringify(neverPolicies)};

  // In-memory grant set — tools that have been granted during this session
  const grantedTools = new Set(${JSON.stringify(grantedTools)});

  // Read gateway URL and auth token (same pattern as MCP proxy extensions)
  const bobbitDir = process.env.BOBBIT_DIR || path.join(os.homedir(), ".bobbit");
  const gwUrl = process.env.BOBBIT_GATEWAY_URL || fs.readFileSync(path.join(bobbitDir, "state", "gateway-url"), "utf-8").trim();
  const token = process.env.BOBBIT_TOKEN || fs.readFileSync(path.join(bobbitDir, "state", "token"), "utf-8").trim();
  const sessionId = ${JSON.stringify(sessionId)};

  pi.on("tool_call", async (event) => {
    const toolName = event.toolName || event.tool;

    // Hard-block 'never' tools immediately with a clear reason. The agent sees
    // this as a tool error so it can adapt (e.g. reviewers falling back to
    // read-only analysis instead of running bash_bg).
    if (neverPolicies[toolName]) {
      return {
        block: true,
        reason: "Tool \"" + toolName + "\" is not permitted for this role. Do not call it again — choose a different approach."
      };
    }

    // If tool is already granted or not in the ask-policies map, pass through
    if (grantedTools.has(toolName) || !askPolicies[toolName]) {
      return undefined;
    }

    // Tool has 'ask' policy and is not yet granted — request permission via gateway
    const entry = askPolicies[toolName];
    const body = JSON.stringify({ toolName, toolGroup: entry.group });
    const url = new URL(gwUrl + "/api/sessions/" + sessionId + "/tool-grant-request");
    const mod = url.protocol === "https:" ? await import("node:https") : await import("node:http");

    try {
      const result = await new Promise((resolve, reject) => {
        const req = mod.request(url, {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
          ...(url.protocol === "https:" ? { rejectUnauthorized: false } : {}),
        }, (res) => {
          let data = "";
          res.on("data", (chunk) => data += chunk);
          res.on("end", () => {
            try { resolve(JSON.parse(data)); } catch { resolve({ granted: false, reason: "Invalid response" }); }
          });
        });
        req.on("error", reject);
        req.write(body);
        req.end();
      });

      const r = result;
      if (r && r.granted) {
        // Permission granted — add to in-memory set so future calls pass through
        grantedTools.add(toolName);
        return { block: false };
      } else {
        const reason = (r && r.reason) ? r.reason : "Permission denied by user";
        return { block: true, reason };
      }
    } catch (err) {
      return { block: true, reason: "Failed to request permission: " + (err && err.message || String(err)) };
    }
  });
}
`;
}
