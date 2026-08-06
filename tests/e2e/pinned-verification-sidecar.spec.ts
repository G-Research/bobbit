/**
 * Production D-5 Docker verification lifecycle.
 *
 * Unlike the ordinary in-process E2E fixture, `in-process-harness-realpush`
 * wires neither a fake pinned-checkout manager nor a fake execution backend.
 * These route-level cases therefore require the real SessionManager →
 * SandboxManager → Docker sidecar path.
 */
import { expect, test } from "./in-process-harness-realpush.js";
import { apiFetch, createGoal, deleteGoal } from "./e2e-setup.js";
import { isDockerSandboxAvailable } from "./test-utils/docker.js";
import { awaitableRm, pollUntil } from "./test-utils/cleanup.js";
import { createRunChild } from "../../tests2/harness/run-isolation.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";

const GATE_ID = "frozen-sidecar";

type Sidecar = { id: string; checkoutPath: string };

function docker(args: string[]): string {
	return execFileSync("docker", args, { encoding: "utf8", timeout: 30_000 }).trim();
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 30_000 }).trim();
}

function nodeBarrier(ready: string, release: string, file: string): string {
	const script = [
		"const fs=require('fs');",
		`fs.writeFileSync(${JSON.stringify(ready)},'ready');`,
		`while(!fs.existsSync(${JSON.stringify(release)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);`,
		`console.log('FROZEN='+fs.readFileSync(${JSON.stringify(file)},'utf8').trim());`,
		"console.log('PINNED_CWD='+process.cwd());",
	].join("");
	return `node -e ${JSON.stringify(script)}`;
}

function signals(body: any): any[] {
	return body?.signals ?? body?.gate?.signals ?? [];
}

async function gate(goalId: string): Promise<any> {
	const response = await apiFetch(`/api/goals/${goalId}/gates/${GATE_ID}`);
	expect(response.ok).toBe(true);
	return response.json();
}

async function waitForGoalReady(goalId: string): Promise<any> {
	let found: any;
	await pollUntil(async () => {
		const response = await apiFetch(`/api/goals/${goalId}`);
		if (!response.ok) return false;
		found = await response.json();
		return found.setupStatus === "ready" && typeof found.cwd === "string";
	}, { timeoutMs: 30_000, label: "pinned sidecar goal worktree" });
	return found;
}

async function waitForTerminalSignal(goalId: string, signalId: string): Promise<any> {
	let found: any;
	await pollUntil(async () => {
		const state = await gate(goalId);
		found = signals(state).find(signal => signal.id === signalId);
		return found?.verification?.status === "passed" || found?.verification?.status === "failed";
	}, { timeoutMs: 60_000, label: "pinned sidecar verification completion" });
	return found;
}

async function waitForSidecar(projectId: string, signalId: string): Promise<Sidecar> {
	let sidecar: Sidecar | undefined;
	await pollUntil(() => {
		const ids = docker([
			"ps", "-q",
			"--filter", `label=bobbit-project=${projectId}`,
			"--filter", "label=bobbit-verification-sidecar=1",
			"--filter", `label=bobbit-verification-signal=${signalId}`,
		]).split("\n").filter(Boolean);
		if (ids.length !== 1) return false;
		const inspection = JSON.parse(docker(["inspect", ids[0]!]))[0];
		const mount = inspection.Mounts.find((candidate: any) =>
			candidate.Destination === `/bobbit-state/verification-sources/${signalId}`,
		);
		if (!mount?.Source) return false;
		sidecar = { id: inspection.Id, checkoutPath: mount.Source };
		return true;
	}, { timeoutMs: 30_000, label: "production verification sidecar" });
	return sidecar!;
}

async function waitForBarrier(sidecar: Sidecar, ready: string): Promise<void> {
	await pollUntil(() => {
		try {
			docker(["exec", sidecar.id, "test", "-f", ready]);
			return true;
		} catch { return false; }
	}, { timeoutMs: 30_000, label: "sidecar command ready barrier" });
}

async function assertDurableActiveCheckout(stateDir: string, signalId: string, checkoutPath: string): Promise<void> {
	await pollUntil(() => {
		try {
			const active = JSON.parse(readFileSync(join(stateDir, "active-verifications.json"), "utf8"));
			const row = active.verifications?.find((candidate: any) => candidate.signalId === signalId);
			return row?.pinnedCheckout?.path === checkoutPath;
		} catch { return false; }
	}, { timeoutMs: 10_000, label: "durable pinned checkout reference" });
}

async function assertExactCleanup(sidecar: Sidecar): Promise<void> {
	await pollUntil(async () => {
		try { docker(["inspect", sidecar.id]); return false; } catch { /* exact container is gone */ }
		try { await lstat(sidecar.checkoutPath); return false; } catch (error: any) { return error?.code === "ENOENT"; }
	}, { timeoutMs: 30_000, label: "exact verification sidecar and checkout cleanup" });
}

async function createProject(body: Record<string, unknown>): Promise<any> {
	const response = await apiFetch("/api/projects", { method: "POST", body: JSON.stringify(body) });
	const text = await response.text();
	expect(response.status, text).toBe(201);
	return JSON.parse(text);
}

async function createWorkflow(projectId: string, id: string, verify: Record<string, unknown>[]): Promise<void> {
	const response = await apiFetch("/api/workflows", {
		method: "POST",
		body: JSON.stringify({ projectId, id, name: id, description: "Production pinned-sidecar E2E", gates: [{ id: GATE_ID, name: "Frozen sidecar", dependsOn: [], verify }] }),
	});
	expect(response.status, await response.text()).toBe(201);
}

async function setProjectComponents(projectId: string, components: Record<string, unknown>[]): Promise<void> {
	const response = await apiFetch(`/api/projects/${projectId}/config`, { method: "PUT", body: JSON.stringify({ components }) });
	expect(response.status, await response.text()).toBe(200);
}

async function deleteProject(projectId: string | undefined): Promise<void> {
	if (projectId) await apiFetch(`/api/projects/${projectId}`, { method: "DELETE" }).catch(() => {});
}

function initRepository(root: string, files: Record<string, string>): void {
	mkdirSync(root, { recursive: true });
	git(root, ["init"]);
	git(root, ["config", "user.email", "pinned-sidecar@example.test"]);
	git(root, ["config", "user.name", "Pinned sidecar fixture"]);
	for (const [relative, contents] of Object.entries(files)) {
		const target = join(root, relative);
		mkdirSync(join(target, ".."), { recursive: true });
		writeFileSync(target, contents);
	}
	git(root, ["add", "."]);
	git(root, ["commit", "-m", "fixture"]);
}

async function release(sidecar: Sidecar | undefined, releasePath: string): Promise<void> {
	if (!sidecar) return;
	try { docker(["exec", sidecar.id, "touch", releasePath]); } catch { /* terminal sidecar is already gone */ }
}

async function removeExactSidecar(sidecar: Sidecar | undefined): Promise<void> {
	if (!sidecar) return;
	try { docker(["rm", "-f", sidecar.id]); } catch { /* production cleanup won */ }
}

test.describe("production frozen verification sidecars", () => {
	test.skip(!isDockerSandboxAvailable(), "Docker daemon or bobbit-agent image unavailable");
	test.setTimeout(120_000);

	test("keeps a live-mutated single-repository worktree out of the real sidecar and exposes only sanitized durable history", async ({ gateway }) => {
		const root = createRunChild("pinned-sidecar-single");
		const source = join(root, "source");
		const ready = "/tmp/bobbit-pinned-single-ready";
		const releasePath = "/tmp/bobbit-pinned-single-release";
		const workflowId = `pinned-sidecar-single-${Date.now()}`;
		let projectId: string | undefined;
		let goalId: string | undefined;
		let sidecar: Sidecar | undefined;
		try {
			initRepository(source, { "fixture.txt": "frozen-v1\n" });
			const project = await createProject({ name: workflowId, rootPath: source });
			projectId = project.id;
			await createWorkflow(projectId!, workflowId, [{ name: "hold frozen source", type: "command", run: nodeBarrier(ready, releasePath, "fixture.txt") }]);
			const goal = await createGoal({ title: workflowId, projectId, workflowId, cwd: source, worktree: true });
			goalId = goal.id;
			const liveGoal = await waitForGoalReady(goalId);
			const signalResponse = await apiFetch(`/api/goals/${goalId}/gates/${GATE_ID}/signal`, { method: "POST", body: JSON.stringify({ content: "verify frozen source" }) });
			const signalText = await signalResponse.text();
			expect(signalResponse.status, signalText).toBe(201);
			const signal = JSON.parse(signalText).signal;
			sidecar = await waitForSidecar(projectId!, signal.id);
			await waitForBarrier(sidecar, ready);
			await assertDurableActiveCheckout(join(gateway.bobbitDir, "state"), signal.id, sidecar.checkoutPath);

			writeFileSync(join(liveGoal.cwd, "fixture.txt"), "live-v2\n");
			await release(sidecar, releasePath);
			const stored = await waitForTerminalSignal(goalId, signal.id);
			expect(stored.verification.status).toBe("passed");
			expect(stored.verification.steps[0].output).toContain("FROZEN=frozen-v1");
			expect(stored.verification.steps[0].output).not.toContain("live-v2");
			expect(stored.verification.steps[0].output).toContain(`PINNED_CWD=/bobbit-state/verification-checkouts/${signal.id}`);
			expect(readFileSync(join(liveGoal.cwd, "fixture.txt"), "utf8")).toBe("live-v2\n");
			expect(stored.contentDigest?.digest).toMatch(/^[a-f0-9]{64}$/);
			expect(stored.pinnedCheckout).toMatchObject({ version: 1, commitSha: stored.commitSha, contentDigest: stored.contentDigest });

			const detail = await gate(goalId);
			const historyResponse = await apiFetch(`/api/goals/${goalId}/gates/${GATE_ID}/inspect?section=signals&mode=full`);
			expect(historyResponse.ok).toBe(true);
			const operatorEvidence = JSON.stringify({ detail, history: await historyResponse.json() });
			expect(operatorEvidence).toContain("contentDigest");
			expect(operatorEvidence).toContain("pinnedCheckout");
			for (const privatePath of [source, liveGoal.cwd, sidecar.checkoutPath, join(gateway.bobbitDir, "state", "verification-checkouts-private")]) {
				expect(operatorEvidence).not.toContain(privatePath);
			}
			await assertExactCleanup(sidecar);
		} finally {
			await release(sidecar, releasePath);
			if (goalId) await deleteGoal(goalId);
			await removeExactSidecar(sidecar);
			await deleteProject(projectId);
			await awaitableRm(root);
		}
	});

	test("runs a paused multi-repository component command from its exact frozen nested cwd after both live repositories change", async ({ gateway }) => {
		const root = createRunChild("pinned-sidecar-multi");
		const container = join(root, "container");
		const api = join(container, "services", "api");
		const web = join(container, "apps", "web");
		const ready = "/tmp/bobbit-pinned-multi-ready";
		const releasePath = "/tmp/bobbit-pinned-multi-release";
		const workflowId = `pinned-sidecar-multi-${Date.now()}`;
		let projectId: string | undefined;
		let goalId: string | undefined;
		let sidecar: Sidecar | undefined;
		try {
			initRepository(api, { "packages/api/value.txt": "api-frozen\n" });
			initRepository(web, { "packages/web/value.txt": "web-frozen\n" });
			const command = nodeBarrier(ready, releasePath, "value.txt");
			const components = [
				{ name: "api", repo: "services/api", relativePath: "packages/api", commands: { verify: command } },
				{ name: "web", repo: "apps/web", relativePath: "packages/web" },
			];
			const project = await createProject({ name: workflowId, rootPath: container });
			projectId = project.id;
			await setProjectComponents(projectId!, components);
			await createWorkflow(projectId!, workflowId, [{ name: "api frozen component", type: "command", component: "api", command: "verify" }]);
			const goal = await createGoal({ title: workflowId, projectId, workflowId, cwd: container, worktree: true });
			goalId = goal.id;
			const liveGoal = await waitForGoalReady(goalId);
			expect(liveGoal.repoWorktrees).toMatchObject({ "services/api": expect.any(String), "apps/web": expect.any(String) });
			const signalResponse = await apiFetch(`/api/goals/${goalId}/gates/${GATE_ID}/signal`, { method: "POST", body: JSON.stringify({ content: "verify frozen component source" }) });
			const signalText = await signalResponse.text();
			expect(signalResponse.status, signalText).toBe(201);
			const signal = JSON.parse(signalText).signal;
			sidecar = await waitForSidecar(projectId!, signal.id);
			await waitForBarrier(sidecar, ready);
			await assertDurableActiveCheckout(join(gateway.bobbitDir, "state"), signal.id, sidecar.checkoutPath);

			writeFileSync(join(liveGoal.repoWorktrees["services/api"], "packages", "api", "value.txt"), "api-live-v2\n");
			writeFileSync(join(liveGoal.repoWorktrees["apps/web"], "packages", "web", "value.txt"), "web-live-v2\n");
			await release(sidecar, releasePath);
			const stored = await waitForTerminalSignal(goalId, signal.id);
			const output = stored.verification.steps[0].output as string;
			expect(stored.verification.status).toBe("passed");
			expect(output).toContain("FROZEN=api-frozen");
			expect(output).not.toContain("api-live-v2");
			expect(output).not.toContain("web-live-v2");
			expect(output).toContain(`PINNED_CWD=/bobbit-state/verification-sources/${signal.id}/services/api/packages/api`);
			expect(output).not.toContain("packages/api/packages/api");
			expect(readFileSync(join(liveGoal.repoWorktrees["services/api"], "packages", "api", "value.txt"), "utf8")).toBe("api-live-v2\n");
			expect(readFileSync(join(liveGoal.repoWorktrees["apps/web"], "packages", "web", "value.txt"), "utf8")).toBe("web-live-v2\n");
			expect(stored.pinnedCheckout).toMatchObject({ version: 2, layout: "multi-repo", contentDigest: stored.contentDigest });
			expect(stored.pinnedCheckout.repositories.map((repository: any) => repository.repoKey).sort()).toEqual(["apps/web", "services/api"]);
			await assertExactCleanup(sidecar);
		} finally {
			await release(sidecar, releasePath);
			if (goalId) await deleteGoal(goalId);
			await removeExactSidecar(sidecar);
			await deleteProject(projectId);
			await awaitableRm(root);
		}
	});
});
