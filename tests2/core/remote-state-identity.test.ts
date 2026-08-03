import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { CommandRunner } from "../../src/server/gateway-deps.ts";
import {
	normalizeGithubHost,
	normalizePullRequestIdentity,
	normalizeRemoteIdentity,
	RemoteStateCoordinator,
} from "../../src/server/remote-state-coordinator.ts";

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
	it("normalizes HTTP, SSH, scp, GitHub aliases, and removes credentials", () => {
		assert.equal(normalizeRemoteIdentity("https://token:secret@www.github.com/Acme/Widget.git"), "github.com/acme/widget");
		assert.equal(normalizeRemoteIdentity("ssh://git@ssh.github.com:443/Acme/Widget.git"), "github.com/acme/widget");
		assert.equal(normalizeRemoteIdentity("git@github.com:Acme/Widget.git"), "github.com/acme/widget");
		assert.equal(normalizeRemoteIdentity("https://git.enterprise.test/Acme/Widget.git"), "git.enterprise.test/acme/widget");
		assert.equal(normalizeGithubHost("WWW.GitHub.Com."), "github.com");
	});

	it("keeps local origins credential-free and canonicalizes Windows paths", () => {
		assert.equal(normalizeRemoteIdentity("file:///C:/Repos/Widget.git"), "file:c:/repos/widget");
		assert.equal(normalizeRemoteIdentity("C:\\Repos\\Widget.git"), "file:c:/repos/widget");
	});

	it("collapses sibling worktrees by common dir and keeps execution namespaces apart", async () => {
		const coordinator = new RemoteStateCoordinator({
			commandRunner: gitIdentityRunner({
				"/repo/a": { commonDir: "/repo/.git/worktrees/a", origin: "https://token@github.com/Acme/Widget.git" },
				"/repo/b": { commonDir: "/repo/.git/worktrees/a", origin: "git@github.com:Acme/Widget.git" },
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

	it("uses host-qualified PR aliases and reconciles a head with its number", () => {
		const coordinator = new RemoteStateCoordinator();
		const head = coordinator.resolvePullRequestIdentity({ host: "ghe.example.test", owner: "Acme", repository: "Widget.git", head: "feature/a" });
		const publicGithub = coordinator.resolvePullRequestIdentity({ owner: "acme", repository: "widget", head: "feature/a" });
		assert.notEqual(head.key, publicGithub.key);
		assert.equal(normalizePullRequestIdentity({ host: "www.github.com", owner: "Acme", repository: "Widget", number: 7 }), "github.com/acme/widget#number:7");
	});
});
