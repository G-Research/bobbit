import {
	apiFetch,
	base,
	describeExtensionSettingsApi,
	expect,
	test,
} from "./helpers/extension-settings-api-fixture.js";

describeExtensionSettingsApi("extension settings API contract", ({
	PACK_ID,
	PROVIDER_ID,
	SECRET_A,
	createProject,
	operatorHeaders,
	patchTarget,
	readJson,
	runtimeProviderIds,
	runtimeProviders,
	settings,
	settingsPath,
	target,
	targetByRef,
	targetPath,
}) => {
test("keeps provider and hook config gates without a declaration visible as repairable invalid schemas", async ({ gateway }) => {
	const project = await createProject(gateway, "activation-only");
	const initial = await settings(project.id);
	for (const kind of ["provider", "hook"] as const) {
		const invalid = initial.targets.find((candidate: any) =>
			candidate.ref?.packId === PACK_ID && candidate.ref?.kind === kind && candidate.ref?.id === "activation-only",
		);
		expect(invalid).toMatchObject({
			enabled: { effective: false },
			configuration: { state: "invalid-schema", missing: [] },
			fields: [],
		});
		const response = await apiFetch(`${settingsPath(project.id)}/${encodeURIComponent(PACK_ID)}/${kind}/activation-only`, {
			method: "PATCH", headers: operatorHeaders(), body: JSON.stringify({ expectedRevision: initial.revision, enabled: true }),
		});
		expect(response.status).toBe(422);
		expect(await readJson(response)).toMatchObject({ code: "EXTENSION_SETTINGS_INVALID_SCHEMA" });
	}
	expect(runtimeProviderIds(gateway, project.id)).not.toContain("activation-only");
});

test("exposes no-config and opaque provider/hook targets for project-local enablement", async ({ gateway }) => {
	const project = await createProject(gateway, "configless-targets");
	let revision = (await settings(project.id)).revision;
	for (const [kind, id] of [["provider", "no-config"], ["provider", "opaque-config"], ["hook", "no-config"], ["hook", "opaque-config"]] as const) {
		const initial = targetByRef(await settings(project.id), kind, id);
		expect(initial).toMatchObject({ fields: [], configuration: { state: "ready", missing: [] }, enabled: { effective: true } });
		const response = await apiFetch(`${settingsPath(project.id)}/${encodeURIComponent(PACK_ID)}/${kind}/${id}`, {
			method: "PATCH", headers: operatorHeaders(), body: JSON.stringify({ expectedRevision: revision, enabled: false }),
		});
		expect(response.status).toBe(200);
		const body = await readJson(response);
		expect(body.target).toMatchObject({ ref: { packId: PACK_ID, kind, id }, fields: [], enabled: { effective: false, projectOverride: false } });
		revision = body.revision;
	}
});

test("authenticates redacted reads and requires a verified operator for every mutation", async ({ gateway }) => {
	const project = await createProject(gateway, "auth");
	const anonymous = await fetch(`${base()}${settingsPath(project.id)}`);
	expect(anonymous.status).toBe(401);

	const initial = await settings(project.id);
	expect(initial).toMatchObject({ schema: 2, revision: 0 });
	expect(target(initial)).toMatchObject({
		enabled: { effective: true },
		configuration: { state: "requires-config", missing: ["externalUrl"] },
	});
	const defaulted = target(initial).fields.find((field: any) => field.key === "recallScope");
	expect(defaulted).toMatchObject({ value: "all", default: "all", source: "default" });
	expect(target(initial).fields.find((field: any) => field.key === "languages"))
		.toMatchObject({ type: "multi-enum", value: ["typescript"], default: ["typescript"], source: "default" });
	expect(target(initial).fields.find((field: any) => field.key === "apiKey")).not.toHaveProperty("default");

	const bearerOnly = await apiFetch(targetPath(project.id), {
		method: "PATCH",
		body: JSON.stringify({ expectedRevision: initial.revision, enabled: false }),
	});
	expect(bearerOnly.status).toBe(403);
	expect(await readJson(bearerOnly)).toMatchObject({ code: "PROMPT_EXTENSION_OPERATOR_REQUIRED" });
});

test("validates exact server-resolved targets and revision CAS before publishing a redacted update", async ({ gateway }) => {
	const project = await createProject(gateway, "validation");
	const initial = await settings(project.id);

	for (const [pathSuffix, body, status, code] of [
		["/" + encodeURIComponent(PACK_ID), { enabled: true }, 400, "EXTENSION_SETTINGS_EXPECTED_REVISION_REQUIRED"],
		["/" + encodeURIComponent(PACK_ID), { expectedRevision: initial.revision, values: { externalUrl: "https://wrong-route.test" } }, 400, "EXTENSION_SETTINGS_INVALID_PACK_MUTATION"],
		["/missing/provider/memory", { expectedRevision: initial.revision, enabled: true }, 404, "EXTENSION_SETTINGS_TARGET_NOT_FOUND"],
		["/" + encodeURIComponent(PACK_ID) + "/provider/memory", { expectedRevision: initial.revision, values: { unknown: "nope" } }, 422, "EXTENSION_SETTINGS_UNKNOWN_FIELD"],
		["/" + encodeURIComponent(PACK_ID) + "/provider/memory", { expectedRevision: initial.revision, values: { recallScope: "invalid" } }, 422, "EXTENSION_SETTINGS_INVALID_FIELD_VALUE"],
		["/" + encodeURIComponent(PACK_ID) + "/provider/memory", { expectedRevision: initial.revision, values: { recallBudget: 0 } }, 422, "EXTENSION_SETTINGS_INVALID_FIELD_VALUE"],
	] as const) {
		const response = await apiFetch(`${settingsPath(project.id)}${pathSuffix}`, {
			method: "PATCH", headers: operatorHeaders(), body: JSON.stringify(body),
		});
		expect(response.status).toBe(status);
		expect((await readJson(response)).code).toBe(code);
	}

	const saved = await patchTarget(project.id, initial.revision, {
		externalUrl: "https://validated-hindsight.example.test",
		recallScope: "project",
		autoRecall: false,
		recallBudget: 512,
	});
	expect(saved.status).toBe(200);
	const savedBody = await readJson(saved);
	expect(savedBody).toMatchObject({ revision: initial.revision + 1, target: { configuration: { state: "ready" } } });
	expect(savedBody.target.fields.find((field: any) => field.key === "recallScope")).toMatchObject({ value: "project", default: "all", source: "project" });
	expect(savedBody.target.fields.find((field: any) => field.key === "apiKey")).not.toHaveProperty("default");

	const stale = await patchTarget(project.id, initial.revision, { externalUrl: "https://stale.example.test" });
	expect(stale.status).toBe(409);
	expect(await readJson(stale)).toMatchObject({ code: "EXTENSION_SETTINGS_REVISION_CONFLICT" });
});

test("canonicalizes multi-enum arrays, rejects invalid sets, and restores project values after reload", async ({ gateway }) => {
	const project = await createProject(gateway, "multi-enum");
	const initial = await settings(project.id);

	for (const languages of ["typescript", ["unknown"], ["typescript", "typescript"], []] as const) {
		const response = await patchTarget(project.id, initial.revision, { languages });
		expect(response.status).toBe(422);
		expect(await readJson(response)).toMatchObject({ code: "EXTENSION_SETTINGS_INVALID_FIELD_VALUE" });
	}

	const saved = await patchTarget(project.id, initial.revision, {
		externalUrl: "https://multi-enum-hindsight.example.test",
		languages: ["typescript", "javascript"],
		optionalLanguages: [],
		apiKey: SECRET_A,
	});
	expect(saved.status).toBe(200);
	const savedText = await saved.text();
	expect(savedText).not.toContain(SECRET_A);
	const savedTarget = JSON.parse(savedText).target;
	expect(savedTarget.fields.find((field: any) => field.key === "languages"))
		.toMatchObject({ value: ["javascript", "typescript"], source: "project" });
	expect(savedTarget.fields.find((field: any) => field.key === "optionalLanguages"))
		.toMatchObject({ value: [], source: "project" });
	expect(runtimeProviders(gateway, project.id).find((provider: any) => provider.id === PROVIDER_ID)?.config)
		.toMatchObject({ languages: ["javascript", "typescript"], optionalLanguages: [] });

	await gateway.projectContextManager.remove(project.id);
	const reloaded = target(await settings(project.id));
	expect(reloaded.fields.find((field: any) => field.key === "languages"))
		.toMatchObject({ value: ["javascript", "typescript"], source: "project" });
	expect(reloaded.fields.find((field: any) => field.key === "optionalLanguages"))
		.toMatchObject({ value: [], source: "project" });
	expect(JSON.stringify(reloaded)).not.toContain(SECRET_A);
});

test("clears defaulted overrides back to their declared source but rejects clearing required no-default fields", async ({ gateway }) => {
	const project = await createProject(gateway, "defaults");
	const initial = await settings(project.id);
	expect(target(initial).fields.find((field: any) => field.key === "recallScope")).toMatchObject({ value: "all", source: "default" });

	const configured = await patchTarget(project.id, initial.revision, {
		recallScope: "project",
		requiredName: "project-owned required value",
	});
	expect(configured.status).toBe(200);
	const configuredBody = await readJson(configured);
	expect(configuredBody.target.fields.find((field: any) => field.key === "recallScope")).toMatchObject({ value: "project", source: "project" });

	const clearedDefault = await patchTarget(project.id, configuredBody.revision, { recallScope: null });
	expect(clearedDefault.status).toBe(200);
	const clearedDefaultBody = await readJson(clearedDefault);
	expect(clearedDefaultBody.target.fields.find((field: any) => field.key === "recallScope")).toMatchObject({ value: "all", source: "default" });
	expect(clearedDefaultBody.target.fields.find((field: any) => field.key === "requiredName")).toMatchObject({ value: "project-owned required value", source: "project" });

	const rejectedRequired = await patchTarget(project.id, clearedDefaultBody.revision, { requiredName: null });
	expect(rejectedRequired.status).toBe(422);
	expect(await readJson(rejectedRequired)).toMatchObject({ code: "EXTENSION_SETTINGS_REQUIRED_FIELD" });
});
});
