export interface WalkthroughReadonlyAllow {
	allowed: true;
	argv: string[];
}

export interface WalkthroughReadonlyBlock {
	allowed: false;
	reason: string;
	argv?: string[];
}

export type WalkthroughReadonlyDecision = WalkthroughReadonlyAllow | WalkthroughReadonlyBlock;

const MAX_COMMAND_CHARS = 12_000;

const BLOCKED_EXECUTABLES = new Set([
	"bash", "sh", "zsh", "fish", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe",
	"node", "node.exe", "python", "python3", "python.exe", "ruby", "perl", "php", "deno", "tsx", "ts-node",
	"npm", "npx", "pnpm", "yarn", "bun", "cargo", "go", "pytest", "jest", "vitest", "mocha", "playwright",
	"docker", "docker.exe", "docker-compose", "podman", "kubectl",
	"make", "cmake", "ninja", "vite", "tsc", "webpack", "rollup",
	"rm", "rmdir", "del", "erase", "mv", "move", "cp", "copy", "mkdir", "touch", "chmod", "chown", "chgrp", "ln",
	"tee", "truncate", "dd", "install", "rsync", "scp", "curl", "wget",
	"service", "systemctl", "nohup", "setsid",
]);

const GIT_ALLOWED = new Set(["diff", "show", "log", "rev-parse", "status"]);
const SEARCH_READ_ALLOWED = new Set(["rg", "grep", "ls", "cat", "head", "tail", "pwd"]);
const GH_PR_READ_ALLOWED = new Set(["view", "diff"]);

function basename(token: string): string {
	const normalized = token.replace(/\\/g, "/");
	const last = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
	return last.endsWith(".cmd") || last.endsWith(".bat") ? last.slice(0, -4) : last;
}

function hasForbiddenShellSyntax(command: string): string | undefined {
	if (command.length > MAX_COMMAND_CHARS) return `command exceeds ${MAX_COMMAND_CHARS} characters`;
	if (/\r|\n/.test(command)) return "multi-line commands and heredocs are not allowed";
	if (/[;&|`]/.test(command)) return "shell chaining, pipes, backgrounding, and command substitution are not allowed";
	if (/[<>]/.test(command)) return "redirection and heredocs are not allowed";
	if (/\$\s*\(|\$\s*\{/.test(command)) return "shell expansion and command substitution are not allowed";
	return undefined;
}

function tokenize(command: string): { ok: true; argv: string[] } | { ok: false; reason: string } {
	const argv: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = undefined;
			else current += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (current.length > 0) {
				argv.push(current);
				current = "";
			}
			continue;
		}
		current += ch;
	}

	if (escaped) current += "\\";
	if (quote) return { ok: false, reason: "unterminated quoted string" };
	if (current.length > 0) argv.push(current);
	return { ok: true, argv };
}

function block(reason: string, argv?: string[]): WalkthroughReadonlyBlock {
	return { allowed: false, reason, argv };
}

function allowGh(argv: string[]): WalkthroughReadonlyDecision {
	const [, first, second] = argv;
	if (first === "pr" && second && GH_PR_READ_ALLOWED.has(second)) return { allowed: true, argv };
	if (first === "pr") return block(`gh pr ${second ?? ""}`.trim() + " is not a read-only PR command", argv);

	if (first !== "api") return block("only gh pr view, gh pr diff, and selected read-only gh api calls are allowed", argv);

	let endpoint: string | undefined;
	for (let i = 2; i < argv.length; i++) {
		const token = argv[i];
		if (token === "--method" || token === "-X") {
			const method = argv[i + 1]?.toUpperCase();
			if (method !== "GET") return block("gh api is restricted to GET requests", argv);
			i++;
			continue;
		}
		if (token.startsWith("--method=")) {
			if (token.slice("--method=".length).toUpperCase() !== "GET") return block("gh api is restricted to GET requests", argv);
			continue;
		}
		if (token === "-f" || token === "--field" || token === "-F" || token === "--raw-field" || token === "--input") {
			return block("gh api request bodies are not allowed", argv);
		}
		if (token.startsWith("-")) {
			if (token === "--paginate" || token === "--jq" || token === "-q" || token === "--header" || token === "-H" || token === "--hostname") {
				if (token !== "--paginate") i++;
				continue;
			}
			continue;
		}
		endpoint = token;
		break;
	}

	if (!endpoint) return block("gh api endpoint is required", argv);
	const normalized = endpoint.replace(/^\/+/, "");
	if (/^repos\/[^/]+\/[^/]+\/pulls\/\d+(?:\/(?:files|commits))?$/.test(normalized)) return { allowed: true, argv };
	return block("gh api is limited to read-only pull request metadata, files, and commits endpoints", argv);
}

function allowGit(argv: string[]): WalkthroughReadonlyDecision {
	const sub = argv[1];
	if (!sub || !GIT_ALLOWED.has(sub)) return block(`git ${sub ?? ""}`.trim() + " is not allowed in PR walkthrough sessions", argv);
	if (sub === "status") {
		const allowedStatusArgs = new Set(["--short", "-s", "--porcelain", "--porcelain=v1", "--porcelain=v2", "--branch", "-b", "--ignored", "--untracked-files", "-uno", "--ahead-behind"]);
		for (const arg of argv.slice(2)) {
			if (!allowedStatusArgs.has(arg) && !arg.startsWith("--untracked-files=")) {
				return block("git status is restricted to short/porcelain-style read-only flags", argv);
			}
		}
	}
	return { allowed: true, argv };
}

function allowFind(argv: string[]): WalkthroughReadonlyDecision {
	const blocked = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"]);
	for (const token of argv.slice(1)) {
		if (blocked.has(token)) return block(`find action ${token} can mutate or write files`, argv);
	}
	return { allowed: true, argv };
}

function allowSed(argv: string[]): WalkthroughReadonlyDecision {
	let hasNoPrint = false;
	let script: string | undefined;
	for (const token of argv.slice(1)) {
		if (token === "-i" || token.startsWith("-i")) return block("sed in-place editing is not allowed", argv);
		if (token === "-n" || (/^-[A-Za-z]+$/.test(token) && token.includes("n"))) {
			hasNoPrint = true;
			continue;
		}
		if (!token.startsWith("-") && script === undefined) script = token;
	}
	if (!hasNoPrint) return block("sed is allowed only with -n for bounded read-only printing", argv);
	if (!script || !/p\s*$/.test(script) || /[ewr]/.test(script.replace(/\\./g, ""))) {
		return block("sed is restricted to print-only scripts such as -n '1,40p'", argv);
	}
	return { allowed: true, argv };
}

export function evaluateWalkthroughReadonlyCommand(command: string): WalkthroughReadonlyDecision {
	const trimmed = command.trim();
	if (!trimmed) return block("empty command");
	const syntaxReason = hasForbiddenShellSyntax(trimmed);
	if (syntaxReason) return block(syntaxReason);

	const parsed = tokenize(trimmed);
	if (!parsed.ok) return block(parsed.reason);
	const argv = parsed.argv;
	if (argv.length === 0) return block("empty command");

	const cmd = basename(argv[0]);
	if (BLOCKED_EXECUTABLES.has(cmd)) return block(`${cmd} is not permitted in read-only PR walkthrough sessions`, argv);
	if (cmd === "gh") return allowGh(argv);
	if (cmd === "git") return allowGit(argv);
	if (cmd === "find") return allowFind(argv);
	if (cmd === "sed") return allowSed(argv);
	if (SEARCH_READ_ALLOWED.has(cmd)) return { allowed: true, argv };

	return block(`${cmd} is not on the PR walkthrough read-only command allowlist`, argv);
}

export function assertWalkthroughReadonlyCommand(command: string): string[] {
	const decision = evaluateWalkthroughReadonlyCommand(command);
	if (!decision.allowed) throw new Error(decision.reason);
	return decision.argv;
}
