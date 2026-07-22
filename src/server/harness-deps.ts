import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface PackageManifest {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

export interface DependencyValidationReads {
	readFile?: (file: string) => string | Buffer;
	exists?: (file: string) => boolean;
}

export type DependencyValidationResult =
	| { ok: true }
	| {
		ok: false;
		message: string;
		missing?: string[];
		diagnostics?: string[];
	};

const MANUAL_RECOVERY = "Stop Bobbit and the development stack, run `npm install` manually, then retry or restart.";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function invalidResult(message: string, missing?: string[]): DependencyValidationResult {
	return {
		ok: false,
		message: `${message} ${MANUAL_RECOVERY}`,
		...(missing && missing.length > 0 ? { missing } : {}),
	};
}

function isDependencyMap(value: unknown): value is Record<string, string> {
	return value !== null
		&& typeof value === "object"
		&& !Array.isArray(value)
		&& Object.values(value).every(version => typeof version === "string");
}

/**
 * Validate the installed manifests for all declared production and development
 * dependencies. This phase is deliberately read-only: dependency repair is an
 * operator action and never part of harness startup or restart.
 */
export function validateDependencies(
	projectRoot: string,
	reads: DependencyValidationReads = {},
): DependencyValidationResult {
	const manifestPath = path.join(projectRoot, "package.json");
	const readFile = reads.readFile ?? ((file: string) => fs.readFileSync(file, "utf-8"));
	const exists = reads.exists ?? ((file: string) => fs.existsSync(file));

	let parsed: unknown;
	try {
		const contents = readFile(manifestPath);
		parsed = JSON.parse(Buffer.isBuffer(contents) ? contents.toString("utf-8") : contents);
	} catch (error) {
		const detail = errorMessage(error);
		const isSyntaxError = error instanceof SyntaxError;
		return invalidResult(isSyntaxError
			? `Root package.json contains invalid JSON and could not be parsed: ${detail}.`
			: `Root package.json could not be read: ${detail}.`);
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return invalidResult("Root package.json has an invalid structure: expected a JSON object.");
	}

	const manifest = parsed as PackageManifest;
	for (const field of ["dependencies", "devDependencies"] as const) {
		const value = manifest[field];
		if (value !== undefined && !isDependencyMap(value)) {
			return invalidResult(`Root package.json has an invalid ${field} field: expected an object whose values are version strings.`);
		}
	}

	const declared = new Set([
		...Object.keys(manifest.dependencies ?? {}),
		...Object.keys(manifest.devDependencies ?? {}),
	]);
	const missing = [...declared].filter(name =>
		!exists(path.join(projectRoot, "node_modules", name, "package.json")),
	);

	if (missing.length > 0) {
		return invalidResult(`Missing declared dependencies: ${missing.join(", ")}.`, missing);
	}
	return { ok: true };
}

export type HarnessLifecycleTrigger = "initial" | "sentinel-restart" | "crash-relaunch";

export interface HarnessLifecycleDeps {
	validate: () => DependencyValidationResult | Promise<DependencyValidationResult>;
	build: () => void | Promise<void>;
	launch: () => void | Promise<void>;
	report: (message: string) => void;
	exit: (code: number) => void;
}

function describeValidationFailure(result: Exclude<DependencyValidationResult, { ok: true }>): string {
	const details = [result.message, ...(result.diagnostics ?? [])];
	if (result.missing?.length && !details.some(detail => result.missing!.every(name => detail.includes(name)))) {
		details.push(`Missing dependencies: ${result.missing.join(", ")}.`);
	}
	return details.join("\n");
}

export interface DependencyValidationCliDeps {
	validate?: (projectRoot: string) => DependencyValidationResult;
	report?: (message: string) => void;
}

/**
 * Read-only pre-build entry point for `npm run dev:harness`.
 *
 * Returning an exit code keeps the production wrapper and focused tests on the
 * same validation policy without exposing a command/package-manager seam.
 */
export function runDependencyValidationCli(
	projectRoot: string,
	deps: DependencyValidationCliDeps = {},
): number {
	let result: DependencyValidationResult;
	try {
		result = (deps.validate ?? validateDependencies)(projectRoot);
	} catch (error) {
		result = invalidResult(`Dependency validation failed: ${errorMessage(error)}.`);
	}
	if (result.ok) return 0;
	(deps.report ?? console.error)(`[harness] ${describeValidationFailure(result)}`);
	return 1;
}

/**
 * Apply dependency validation consistently at each harness lifecycle entry.
 * Unknown properties on the injected dependency object are intentionally
 * ignored, so no legacy repair or package-manager callback can be reached.
 */
export async function runHarnessLifecycle(
	trigger: HarnessLifecycleTrigger,
	deps: HarnessLifecycleDeps,
): Promise<void> {
	let validation: DependencyValidationResult;
	try {
		validation = await deps.validate();
	} catch (error) {
		validation = invalidResult(`Dependency validation failed: ${errorMessage(error)}.`);
	}

	if (!validation.ok) {
		deps.report(describeValidationFailure(validation));
		if (trigger === "initial") deps.exit(1);
		return;
	}

	if (trigger !== "crash-relaunch") {
		try {
			await deps.build();
		} catch (error) {
			deps.report(`Harness build failure: ${errorMessage(error)}.`);
			if (trigger === "initial") deps.exit(1);
			return;
		}
	}

	await deps.launch();
}

const invokedPath = process.argv[1];
if (invokedPath && path.resolve(invokedPath) === path.resolve(fileURLToPath(import.meta.url))) {
	process.exitCode = runDependencyValidationCli(process.cwd());
}
