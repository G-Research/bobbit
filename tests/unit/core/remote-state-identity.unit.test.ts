import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { CommandRunner } from "../../../src/server/gateway-deps.ts";
import {
	isTrustedGithubRemoteHost,
	normalizeGithubHost,
	normalizePullRequestIdentity,
	normalizeRemoteIdentity,
	parseTrustedGithubRemote,
	parseUntrustedGithubRemoteCandidate,
	RemoteStateCoordinator,
} from "../../../src/server/remote-state-coordinator.ts";

function gitIdentityRunner(values: Record<string, { commonDir?: string; origin?: string }>): CommandRunner {
	return {
		async execFile(file, args, options) {
			assert.equal(file, "git");
			const cwd = String(options?.cwd);
			const value = values[cwd];
			if (!value) throw new Error("unknown worktree");
			if (args[0] === "rev-parse" && args.includes("--git-common-dir") && value.commonDir) {
				return { stdout: `${value.commonDir}\n`, stderr: "" };
			}
			if (args[0] === "remote" && value.origin) return { stdout: `${value.origin}\n`, stderr: "" };
			throw new Error("git command unavailable");
		},
	};
}

describe("remote state canonical identity", () => {
	it("normalizes scp-style GitHub remotes, host aliases, and URL port authorities", () => {
		assert.equal(normalizeRemoteIdentity("git@github.com:Acme/Widget.git"), "github.com/acme/widget");
		assert.equal(normalizeRemoteIdentity("github.com:Acme/Widget.git"), "github.com/acme/widget");
		assert.equal(normalizeGithubHost("WWW.GitHub.Com."), "github.com");
		assert.equal(
			normalizeRemoteIdentity("https://ghe.example.test:443/Acme/Widget.git"),
			normalizeRemoteIdentity("https://ghe.example.test/Acme/Widget.git"),
		);
		assert.equal(
			normalizeRemoteIdentity("ssh://git@ghe.example.test:22/Acme/Widget.git"),
			normalizeRemoteIdentity("ssh://git@ghe.example.test/Acme/Widget.git"),
		);
		assert.notEqual(
			normalizeRemoteIdentity("ssh://git@ghe.example.test:2222/Acme/Widget.git"),
			normalizeRemoteIdentity("ssh://git@ghe.example.test:2223/Acme/Widget.git"),
		);
		assert.equal(normalizeRemoteIdentity("https://token:secret@ghe.example.test:8443/Acme/Widget.git"), "ghe.example.test:8443/acme/widget");
	});

	it("trust-gates PR remotes to GitHub and configured enterprise hosts", () => {
		assert.equal(isTrustedGithubRemoteHost("www.github.com"), true);
		assert.equal(isTrustedGithubRemoteHost("ssh.github.com"), true);
		assert.equal(isTrustedGithubRemoteHost("ghe.example.test", ["GHE.EXAMPLE.TEST."]), true);
		assert.equal(isTrustedGithubRemoteHost("ghe.example.test:2222", ["GHE.EXAMPLE.TEST."]), true);
		assert.equal(isTrustedGithubRemoteHost("gitlab.example.test", ["ghe.example.test"]), false);
		assert.equal(isTrustedGithubRemoteHost("api.github.com"), false);
	});

	it("parses only whole trusted GitHub remote inputs", () => {
		const expected = { host: "github.com", owner: "acme", repository: "widget" };
		assert.deepEqual(parseTrustedGithubRemote("https://token:secret@github.com/Acme/Widget.git"), expected);
		assert.deepEqual(parseTrustedGithubRemote("ssh://git@ssh.github.com/Acme/Widget.git"), expected);
		assert.deepEqual(parseTrustedGithubRemote("git@github.com:Acme/Widget.git"), expected);
		assert.deepEqual(
			parseTrustedGithubRemote("https://GHE.Example.Test/Acme/Widget.git", ["ghe.example.test"]),
			{ host: "ghe.example.test", owner: "acme", repository: "widget" },
		);
		assert.deepEqual(
			parseTrustedGithubRemote("ssh://git@GHE.Example.Test:2222/Acme/Widget.git", ["ghe.example.test"]),
			{ host: "ghe.example.test", owner: "acme", repository: "widget" },
		);
		assert.deepEqual(
			parseTrustedGithubRemote("ssh://git@GHE.Example.Test:22/Acme/Widget.git", ["ghe.example.test"]),
			{ host: "ghe.example.test", owner: "acme", repository: "widget" },
		);
		assert.deepEqual(
			parseTrustedGithubRemote("https://GHE.Example.Test:8443/Acme/Widget.git", ["ghe.example.test"]),
			{ host: "ghe.example.test:8443", owner: "acme", repository: "widget" },
		);
	});

	it("separates structural parsing from the unchanged list trust gate", () => {
		assert.deepEqual(parseUntrustedGithubRemoteCandidate("https://GHE.Example.Test/Acme/Widget.git"), {
			host: "ghe.example.test",
			owner: "acme",
			repository: "widget",
		});
		assert.equal(parseTrustedGithubRemote("https://ghe.example.test/acme/widget.git"), undefined);
		assert.deepEqual(
			parseTrustedGithubRemote("https://ghe.example.test/acme/widget.git", ["ghe.example.test"]),
			parseUntrustedGithubRemoteCandidate("https://ghe.example.test/acme/widget.git"),
		);
	});

	it("preserves every malformed remote rejection for structural candidates", () => {
		const rejected = [
			"https://evil.example/a/https://github.com/acme/widget.git",
			"ssh://git@evil.example/a/git@github.com:acme/widget.git",
			"https://github.com/prefix/acme/widget.git",
			"https://github.com/acme/widget.git//",
			"https://github.com/acme%2Fother/widget.git",
			"https://github.com/acme/widget%5Cother.git",
			"https://github.com/acme/widget%252Fother.git",
			"https://github.com/acme/widget.git?token=secret",
			"git@github.com:acme%2Fother/widget.git",
			"ssh://root@ghe.example.test/acme/widget.git",
			"file:///tmp/acme/widget.git",
			"https://ghe.example.test/acme/..",
		];
		for (const remote of rejected) {
			assert.equal(parseUntrustedGithubRemoteCandidate(remote), undefined, remote);
			assert.equal(parseTrustedGithubRemote(remote, ["ghe.example.test"]), undefined, remote);
		}
	});

	it("continues rejecting structurally valid but unlisted hosts on the list path", () => {
		const remote = "https://evil.example/acme/widget.git";
		assert.deepEqual(parseUntrustedGithubRemoteCandidate(remote), {
			host: "evil.example",
			owner: "acme",
			repository: "widget",
		});
		assert.equal(parseTrustedGithubRemote(remote), undefined);
	});

	it("canonicalizes Windows local paths", () => {
		assert.equal(normalizeRemoteIdentity("C:\\Repos\\Widget.git"), "file:c:/repos/widget.git");
	});

	it("collapses sibling worktrees by common dir and keeps execution namespaces apart", async () => {
		const coordinator = new RemoteStateCoordinator({
			commandRunner: gitIdentityRunner({
				"/repo/a": { commonDir: "/repo/.git/worktrees/a", origin: "git@github.com:Acme/Widget.git" },
				"/repo/b": { commonDir: "/repo/.git/worktrees/a", origin: "github.com:acme/widget.git" },
			}),
		});
		const a = await coordinator.resolveRepositoryIdentity({ cwd: "/repo/a" });
		const b = await coordinator.resolveRepositoryIdentity({ cwd: "/repo/b" });
		const sandbox = await coordinator.resolveRepositoryIdentity({ cwd: "/repo/b", executionNamespace: "container-1" });
		assert.equal(a.key, b.key);
		assert.notEqual(a.key, sandbox.key);
		assert.equal(a.hasRemote, true);
		assert.match(a.key, /^repo:[A-Za-z0-9_-]+$/);
		assert.ok(!a.key.includes("token"));
	});

	it("runs sandbox identity probes through the execution-aware Git adapter", async () => {
		const calls: Array<{ args: readonly string[]; timeoutMs: number }> = [];
		const coordinator = new RemoteStateCoordinator({
			commandRunner: {
				async execFile() { throw new Error("host Git must not run for sandbox identity"); },
			},
			identityProbeTimeoutMs: 1_234,
		});
		const identity = await coordinator.resolveRepositoryIdentity({
			cwd: "/workspace-wt/session/feature",
			executionNamespace: "container:test",
			executeGit: async (args, timeoutMs) => {
				calls.push({ args: [...args], timeoutMs });
				if (args[0] === "rev-parse") return "/workspace/.git";
				if (args[0] === "remote") return "git@github.com:Acme/Widget.git";
				throw new Error("unexpected Git probe");
			},
		});

		assert.equal(identity.hasRemote, true);
		assert.deepEqual(calls.map(call => call.args.join(" ")), [
			"rev-parse --path-format=absolute --git-common-dir",
			"remote get-url origin",
		]);
		assert.equal(calls.every(call => call.timeoutMs === 1_234), true);
	});

	it("marks repositories without origin local so callers can remain fetch-free", async () => {
		const coordinator = new RemoteStateCoordinator({
			commandRunner: gitIdentityRunner({ "/repo": { commonDir: "/repo/.git" } }),
		});
		const identity = await coordinator.resolveRepositoryIdentity({ cwd: "/repo" });
		assert.equal(identity.hasRemote, false);
	});

	it("falls back to the compatible common-dir command when path-format is unavailable", async () => {
		const calls: string[][] = [];
		const coordinator = new RemoteStateCoordinator({
			commandRunner: {
				async execFile(file, args) {
					assert.equal(file, "git");
					calls.push([...args]);
					if (args[0] === "rev-parse" && args.includes("--path-format=absolute")) {
						throw new Error("unknown option --path-format");
					}
					if (args[0] === "rev-parse" && args.includes("--git-common-dir")) return { stdout: ".git\n", stderr: "" };
					if (args[0] === "remote") return { stdout: "https://token:secret@github.com/Acme/Widget.git\n", stderr: "" };
					throw new Error(`unexpected git command: ${args.join(" ")}`);
				},
			},
		});

		const identity = await coordinator.resolveRepositoryIdentity({ cwd: "/repo/worktree" });
		assert.equal(identity.hasRemote, true);
		assert.match(identity.key, /^repo:[A-Za-z0-9_-]+$/);
		assert.ok(calls.some(args => args.join(" ") === "rev-parse --git-common-dir"));
		assert.equal(identity.key.includes("token"), false);
	});

	it("requires a canonical PR selector and keeps custom API-port aliases distinct", () => {
		const coordinator = new RemoteStateCoordinator();
		const head = coordinator.resolvePullRequestIdentity({ host: "ghe.example.test", owner: "Acme", repository: "Widget.git", head: "feature/a" });
		const publicGithub = coordinator.resolvePullRequestIdentity({ owner: "acme", repository: "widget", head: "feature/a" });
		const port8443 = coordinator.resolvePullRequestIdentity({ host: "ghe.example.test:8443", owner: "acme", repository: "widget", head: "feature/a" });
		const port9443 = coordinator.resolvePullRequestIdentity({ host: "ghe.example.test:9443", owner: "acme", repository: "widget", head: "feature/a" });
		assert.notEqual(head.key, publicGithub.key);
		assert.notEqual(port8443.key, port9443.key);
		assert.throws(
			() => normalizePullRequestIdentity({ owner: "acme", repository: "widget" }),
			/requires a number or resolved head/,
		);
		assert.throws(
			() => normalizePullRequestIdentity({ owner: "acme", repository: "widget", head: "  " }),
			/requires a number or resolved head/,
		);
		assert.equal(normalizePullRequestIdentity({ host: "www.github.com", owner: "Acme", repository: "Widget", number: 7 }), "github.com/acme/widget#number:7");
	});
});
