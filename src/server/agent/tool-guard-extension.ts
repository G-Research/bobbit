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
 * @param _sessionId - Retained for API compatibility; runtime identity comes from the gateway-owned BOBBIT_SESSION_ID env so identical policies can share one immutable extension.
 * @param policies - Map of tool name → { policy, group } for all resolved tools
 * @param grantedTools - Tools already granted (pre-populated grant set)
 * @param readSessionGuardRequired - Protect an unknown runtime read_session registration without synthesizing a policy entry
 * @returns TypeScript source string for the extension
 */
export function generateToolGuardExtension(
	_sessionId: string,
	policies: Record<string, ToolPolicyEntry>,
	grantedTools: string[],
	readSessionGuardRequired = false,
): string {
	// Only include 'ask' and 'never' policies in the generated code —
	// 'allow' tools don't need the guard.
	const askPolicies: Record<string, ToolPolicyEntry> = {};
	const neverPolicies: Record<string, ToolPolicyEntry> = {};
	let readSessionProtected = readSessionGuardRequired;
	for (const [name, entry] of Object.entries(policies)) {
		if (entry.policy === 'ask') {
			askPolicies[name] = entry;
		} else if (entry.policy === 'never') {
			neverPolicies[name] = entry;
		}
		if (name.toLowerCase() === "read_session" && entry.policy !== "never") {
			readSessionProtected = true;
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

  // Unlike ordinary allow-policy tools, read_session always needs this
  // immutable pre-handler guard. Config/project overrides can replace its
  // execute implementation, but cannot replace this gateway-owned extension.
  const readSessionProtected = ${JSON.stringify(readSessionProtected)};
  const contextHeavyErrorCode = "CONTEXT_HEAVY_LIMIT_REQUIRED";

  const askPolicyNamesByLower = new Map(Object.keys(askPolicies).map((name) => [name.toLowerCase(), name]));
  const neverPolicyNamesByLower = new Map(Object.keys(neverPolicies).map((name) => [name.toLowerCase(), name]));

  function policyEntry(map, namesByLower, toolName) {
    if (map[toolName]) return { canonicalName: toolName, entry: map[toolName] };
    const canonicalName = namesByLower.get(String(toolName || "").toLowerCase());
    return canonicalName ? { canonicalName, entry: map[canonicalName] } : undefined;
  }

  function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function toolCallInput(event) {
    if (isObject(event && event.input)) return event.input;
    if (isObject(event && event.arguments)) return event.arguments;
    return {};
  }

  function contextHeavyReadError(input) {
    const flags = ["verbose", "include_tool_results", "includeToolResults"].filter((flag) => input[flag] === true);
    if (flags.length === 0) return undefined;
    const limit = input.limit;
    if (typeof limit === "number" && Number.isFinite(limit) && Number.isInteger(limit) && limit >= 1 && limit <= 10) {
      return undefined;
    }
    const formattedFlags = flags.map((flag) => "\u0060" + flag + "\u0060").join(", ");
    return {
      error: "You should not typically pull this much data from the API. " +
        "Context-heavy flag(s) " + formattedFlags + " require an explicit limit at or below 10. " +
        "Call again with limit <= 10 and fetch in smaller batches only if you REALLY need full verbosity. " +
        "Keep an eye on token consumption.",
      code: contextHeavyErrorCode,
    };
  }

  // In-memory grant set — tools that have been granted during this session
  const grantedTools = new Set(${JSON.stringify(grantedTools)});
  const grantedToolsLower = new Set(${JSON.stringify(grantedTools.map((name) => name.toLowerCase()))});

  // Gateway-owned process state is captured per activation. Keeping it out of
  // generated source makes policy-identical guards content-addressable without
  // sharing identity, credentials, or the per-activation grant set below.
  const bobbitDir = process.env.BOBBIT_DIR || path.join(os.homedir(), ".bobbit");
  const gatewayUrlFromEnv = process.env.BOBBIT_GATEWAY_URL;
  const tokenFromEnv = process.env.BOBBIT_TOKEN;
  const sessionId = process.env.BOBBIT_SESSION_ID;

  pi.on("tool_call", async (event) => {
    const toolName = event.toolName || event.tool;

    // This check deliberately precedes both permission long-polling and the
    // resolved tool handler, so an invalid heavy read cannot reach fetch even
    // when a stale server/project extension won normal provider resolution.
    if (readSessionProtected && String(toolName || "").toLowerCase() === "read_session") {
      const heavyError = contextHeavyReadError(toolCallInput(event));
      if (heavyError) {
        return { block: true, reason: JSON.stringify(heavyError) };
      }
    }

    // Hard-block 'never' tools immediately with a clear reason. The agent sees
    // this as a tool error so it can adapt (e.g. reviewers falling back to
    // read-only analysis instead of running bash_bg).
    const directNeverPolicy = neverPolicies[toolName];
    const neverPolicy = directNeverPolicy
      ? { canonicalName: toolName, entry: directNeverPolicy }
      : policyEntry(neverPolicies, neverPolicyNamesByLower, toolName);
    if (neverPolicy) {
      return {
        block: true,
        reason: 'Tool "' + toolName + '" is not permitted for this role. Do not call it again — choose a different approach.'
      };
    }

    const askPolicy = policyEntry(askPolicies, askPolicyNamesByLower, toolName);

    // If tool is already granted or not in the ask-policies map, pass through
    if (grantedTools.has(toolName) || grantedToolsLower.has(String(toolName || "").toLowerCase()) || !askPolicy) {
      return undefined;
    }

    // Tool has 'ask' policy and is not yet granted — request permission via gateway.
    // Missing identity fails closed rather than sending an unscoped request.
    if (!sessionId) {
      return { block: true, reason: "Tool permission check unavailable: missing BOBBIT_SESSION_ID" };
    }
    const entry = askPolicy.entry;

    try {
      // Credentials are needed only for an ask-policy request. Loading them
      // lazily keeps never-only guards active in credential-less fixtures and
      // still fails closed when an ask guard cannot reach its gateway state.
      const gwUrl = gatewayUrlFromEnv || fs.readFileSync(path.join(bobbitDir, "state", "gateway-url"), "utf-8").trim();
      const token = tokenFromEnv || fs.readFileSync(path.join(bobbitDir, "state", "token"), "utf-8").trim();
      const body = JSON.stringify({ toolName, toolGroup: entry.group });
      const url = new URL(gwUrl + "/api/sessions/" + sessionId + "/tool-grant-request");
      const mod = url.protocol === "https:" ? await import("node:https") : await import("node:http");
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
        // Permission granted — only unblock if the server response actually
        // covers the tool call this guard is currently blocking. A stale or
        // mismatched permission-card response must not release this invocation.
        const grantScope = r.scope === "group" ? "group" : (r.scope === "tool" ? "tool" : undefined);
        const responseTools = Array.isArray(r.tools) ? r.tools : [];
        const responseToolsLower = new Set(responseTools.map((name) => String(name || "").toLowerCase()));
        const currentNamesLower = new Set([String(toolName || "").toLowerCase(), String(askPolicy.canonicalName || "").toLowerCase()]);
        const currentListed = [...currentNamesLower].some((name) => responseToolsLower.has(name));
        const groupMatches = grantScope === "group" && r.group === entry.group;
        const coversCurrent = responseTools.length > 0
          ? currentListed && (grantScope !== "group" || groupMatches)
          : (grantScope ? groupMatches : true);
        if (!coversCurrent) {
          return { block: true, reason: "Permission grant did not cover tool " + toolName };
        }

        if (r.mode === "one-time") {
          // One-time grants authorize exactly this blocked invocation. Do not
          // cache them in this process, or future turns would bypass ask prompts
          // after the server revokes its oneTimeGrantedTools on agent_end.
          return { block: false };
        }

        const newlyGranted = grantScope === "group"
          ? responseTools.filter((granted) => {
              const grantedPolicy = policyEntry(askPolicies, askPolicyNamesByLower, granted);
              return grantedPolicy && grantedPolicy.entry.group === entry.group;
            })
          : [askPolicy.canonicalName];
        for (const granted of (newlyGranted.length > 0 ? newlyGranted : [askPolicy.canonicalName])) {
          grantedTools.add(granted);
          grantedToolsLower.add(String(granted || "").toLowerCase());
        }
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
