import { vi } from "vitest";
import {
	apiFetch,
	connectWs,
	createSession,
	describeExtensionSettingsApi,
	expect,
	test,
	type WsConnection,
} from "./helpers/extension-settings-api-fixture.js";

describeExtensionSettingsApi("extension settings API runtime consistency", ({
	PACK_ID,
	PROVIDER_ID,
	RECONCILIATION_HOOK_ID,
	SECRET_A,
	SECRET_B,
	createProject,
	grantsPath,
	operatorHeaders,
	patchTarget,
	putLegacyProviderConfig,
	readJson,
	reconciliationHookPath,
	runtimeHookIds,
	runtimeProviderIds,
	runtimeProviders,
	settings,
	settingsPath,
	target,
	targetByRef,
	writeReconciliationHookV2,
}) => {
test("redacts Hindsight secrets while invalidating project caches via metadata-only WebSocket frames", async ({ gateway }) => {
	const project = await createProject(gateway, "redaction");
	const sessionId = await createSession({ projectId: project.id, cwd: project.rootPath });
	let connection: WsConnection | undefined;
	try {
		connection = await connectWs(sessionId);
		const initial = await settings(project.id);
		expect(runtimeProviderIds(gateway, project.id)).not.toContain(PROVIDER_ID);
		const cursor = connection.messageCount();
		const captured: string[] = [];
		const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
		for (const spy of spies) spy.mockImplementation((...args: unknown[]) => { captured.push(args.map(String).join(" ")); });
		let saved: Response;
		try {
			saved = await patchTarget(project.id, initial.revision, {
				externalUrl: "https://redaction-hindsight.example.test",
				apiKey: SECRET_A,
			});
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
		expect(saved!.status).toBe(200);
		const savedText = await saved!.text();
		expect(savedText).not.toContain(SECRET_A);
		const savedBody = JSON.parse(savedText);
		expect(savedBody.target.fields.find((field: any) => field.key === "apiKey")).toEqual(expect.objectContaining({ type: "secret", secretSet: true }));
		expect(JSON.stringify(captured)).not.toContain(SECRET_A);

		const invalidation = await connection.waitForFrom(cursor, message => message.type === "extension_settings_updated", 5_000);
		expect(invalidation).toMatchObject({ type: "extension_settings_updated", projectId: project.id, revision: initial.revision + 1 });
		expect(Object.keys(invalidation).sort()).toEqual(["projectId", "revision", "ts", "type"]);
		expect(JSON.stringify(invalidation)).not.toContain(SECRET_A);
		expect(runtimeProviderIds(gateway, project.id)).toContain(PROVIDER_ID);

		const reloaded = await settings(project.id);
		expect(JSON.stringify(reloaded)).not.toContain(SECRET_A);
		expect(target(reloaded).fields.find((field: any) => field.key === "apiKey")).toEqual(expect.objectContaining({ secretSet: true }));
	} finally {
		connection?.close();
		await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
	}
});

test("keeps grants untouched, preserves legacy Hindsight mode only at runtime before a project record, and isolates configured projects", async ({ gateway }) => {
	const projectA = await createProject(gateway, "isolation-a");
	const projectB = await createProject(gateway, "isolation-b");
	const grantsBefore = await readJson(await apiFetch(`/api/projects/${encodeURIComponent(projectA.id)}/extension-grants`));

	const legacyUrl = "https://legacy-hindsight.example.test";
	await putLegacyProviderConfig(gateway, { externalUrl: legacyUrl, languages: ["python"], mode: "managed" });
	const beforeRecord = target(await settings(projectB.id));
	expect(beforeRecord.fields.find((field: any) => field.key === "externalUrl")).toMatchObject({ value: legacyUrl, source: "legacy" });
	expect(beforeRecord.fields.find((field: any) => field.key === "languages"))
		.toMatchObject({ value: ["typescript"], source: "default" });
	expect(beforeRecord.fields.find((field: any) => field.key === "mode")).toBeUndefined();
	expect(JSON.stringify(beforeRecord)).not.toContain("managed");
	expect(runtimeProviders(gateway, projectB.id).find((provider: any) => provider.id === PROVIDER_ID)?.config)
		.toMatchObject({ externalUrl: legacyUrl, mode: "managed" });

	const invalidLegacyProject = await createProject(gateway, "legacy-invalid");
	await putLegacyProviderConfig(gateway, { externalUrl: legacyUrl, recallScope: "invalid", mode: "managed" });
	expect(target(await settings(invalidLegacyProject.id)).configuration).toMatchObject({ state: "invalid-values" });
	expect(runtimeProviderIds(gateway, invalidLegacyProject.id)).not.toContain(PROVIDER_ID);
	await putLegacyProviderConfig(gateway, { externalUrl: legacyUrl, mode: "managed" });

	const aInitial = await settings(projectA.id);
	const aSaved = await patchTarget(projectA.id, aInitial.revision, {
		externalUrl: "https://project-a-hindsight.example.test",
		apiKey: SECRET_A,
	});
	expect(aSaved.status).toBe(200);
	const projectAConfig = runtimeProviders(gateway, projectA.id).find((provider: any) => provider.id === PROVIDER_ID)?.config;
	expect(projectAConfig).toMatchObject({ externalUrl: "https://project-a-hindsight.example.test" });
	expect(projectAConfig).not.toHaveProperty("mode");
	const bInitial = await settings(projectB.id);
	const bSaved = await patchTarget(projectB.id, bInitial.revision, {
		externalUrl: "https://project-b-hindsight.example.test",
		apiKey: SECRET_B,
	});
	expect(bSaved.status).toBe(200);

	const a = target(await settings(projectA.id));
	const b = target(await settings(projectB.id));
	expect(a.fields.find((field: any) => field.key === "externalUrl")).toMatchObject({ value: "https://project-a-hindsight.example.test", source: "project" });
	expect(b.fields.find((field: any) => field.key === "externalUrl")).toMatchObject({ value: "https://project-b-hindsight.example.test", source: "project" });
	expect(JSON.stringify(a)).not.toContain(SECRET_A);
	expect(JSON.stringify(b)).not.toContain(SECRET_B);
	expect(JSON.stringify(a)).not.toContain("project-b-hindsight");
	expect(JSON.stringify(b)).not.toContain("project-a-hindsight");

	const disableB = await apiFetch(`${settingsPath(projectB.id)}/${encodeURIComponent(PACK_ID)}`, {
		method: "PATCH", headers: operatorHeaders(), body: JSON.stringify({ expectedRevision: (await settings(projectB.id)).revision, enabled: false }),
	});
	expect(disableB.status).toBe(200);
	expect(target(await settings(projectB.id))).toMatchObject({ enabled: { effective: false, projectOverride: false }, configuration: { state: "disabled" } });
	expect(runtimeProviderIds(gateway, projectA.id)).toContain(PROVIDER_ID);
	expect(runtimeProviderIds(gateway, projectB.id)).not.toContain(PROVIDER_ID);

	await gateway.projectContextManager.remove(projectB.id);
	const afterReload = target(await settings(projectB.id));
	expect(afterReload).toMatchObject({ enabled: { effective: false, projectOverride: false } });
	expect(afterReload.fields.find((field: any) => field.key === "apiKey")).toMatchObject({ secretSet: true });
	expect(JSON.stringify(afterReload)).not.toContain(SECRET_B);
	expect(JSON.stringify(afterReload)).not.toContain(SECRET_A);
	expect(await readJson(await apiFetch(`/api/projects/${encodeURIComponent(projectA.id)}/extension-grants`))).toEqual(grantsBefore);
});

test("fails closed after hook schema evolution while preserving redaction, compatible additions, and mutate-only authority", async ({ gateway }) => {
	const project = await createProject(gateway, "hook-schema-evolution");
	const initial = await settings(project.id);
	const secretCanary = `EVOLVED_HOOK_SECRET_MUST_NEVER_ESCAPE_${Date.now()}`;
	const saved = await apiFetch(reconciliationHookPath(project.id), {
		method: "PATCH",
		headers: operatorHeaders(),
		body: JSON.stringify({
			expectedRevision: initial.revision,
			values: {
				endpoint: "https://schema-evolution.example.test",
				legacyEnum: "legacy",
				legacyText: "stored-before-boolean",
				legacyNumber: 3,
				removedValue: "must-not-return-after-removal",
				apiKey: secretCanary,
			},
		}),
	});
	expect(saved.status).toBe(200);
	const savedBody = await readJson(saved);
	expect(JSON.stringify(savedBody)).not.toContain(secretCanary);
	expect(savedBody.target.fields.find((field: any) => field.key === "apiKey"))
		.toEqual(expect.objectContaining({ type: "secret", secretSet: true }));
	expect(runtimeHookIds(gateway, project.id)).toContain(RECONCILIATION_HOOK_ID);

	const mutationGrant = await apiFetch(grantsPath(project.id), {
		method: "PUT",
		headers: operatorHeaders(),
		body: JSON.stringify({ packId: PACK_ID, hookId: RECONCILIATION_HOOK_ID, capability: "mutate" }),
	});
	expect(mutationGrant.status).toBe(200);
	const mutateOnly = targetByRef(await settings(project.id), "hook", RECONCILIATION_HOOK_ID);
	expect(mutateOnly.hookGrant).toMatchObject({
		requestedCapabilities: ["decide", "mutate"],
		grants: ["mutate"],
		runnable: false,
		status: "grant-required",
		runtimeAuthorized: true,
	});

	writeReconciliationHookV2();
	const refresh = await apiFetch("/api/marketplace/pack-activation", {
		method: "PUT",
		body: JSON.stringify({ scope: "server", packName: PACK_ID, disabled: {} }),
	});
	expect(refresh.status, `schema evolution must invalidate the pack resolver: ${await refresh.clone().text()}`).toBe(200);

	const evolvedResponse = await settings(project.id);
	const evolved = targetByRef(evolvedResponse, "hook", RECONCILIATION_HOOK_ID);
	expect(evolved).toMatchObject({
		enabled: { effective: true },
		configuration: { state: "invalid-values", missing: [] },
	});
	for (const key of ["legacyEnum", "legacyText", "legacyNumber"]) {
		expect(evolved.fields.find((field: any) => field.key === key)).not.toHaveProperty("value");
	}
	expect(evolved.fields.find((field: any) => field.key === "removedValue")).toBeUndefined();
	expect(evolved.fields.find((field: any) => field.key === "optionalAdded")).not.toHaveProperty("value");
	expect(evolved.fields.find((field: any) => field.key === "defaultAdded"))
		.toMatchObject({ value: "evolved-default", default: "evolved-default", source: "default" });
	expect(evolved.fields.find((field: any) => field.key === "apiKey")).toEqual(expect.objectContaining({ type: "secret", secretSet: true }));
	expect(JSON.stringify(evolvedResponse)).not.toContain(secretCanary);
	const diagnostics: string[] = [];
	const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { diagnostics.push(args.map(String).join(" ")); });
	try {
		expect(runtimeHookIds(gateway, project.id)).not.toContain(RECONCILIATION_HOOK_ID);
	} finally {
		warn.mockRestore();
	}
	expect(JSON.stringify(diagnostics)).not.toContain(secretCanary);

	const repaired = await apiFetch(reconciliationHookPath(project.id), {
		method: "PATCH",
		headers: operatorHeaders(),
		body: JSON.stringify({ expectedRevision: evolvedResponse.revision, values: { legacyEnum: "strict", legacyText: true, legacyNumber: 6 } }),
	});
	expect(repaired.status).toBe(200);
	const repairedTarget = (await readJson(repaired)).target;
	expect(repairedTarget.configuration).toMatchObject({ state: "ready", missing: [] });
	expect(repairedTarget.fields.find((field: any) => field.key === "defaultAdded"))
		.toMatchObject({ value: "evolved-default", source: "default" });
	expect(runtimeHookIds(gateway, project.id)).toContain(RECONCILIATION_HOOK_ID);
});
});
