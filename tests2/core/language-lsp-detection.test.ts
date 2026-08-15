import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_LANGUAGE_DETECTION_ENTRIES } from "../../market-packs/code-intelligence/lib/language-matrix.ts";
import { detectComponentLanguages } from "../../market-packs/code-intelligence/src/language-detection.ts";

function fixture(): { root: string; dispose: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "language-lsp-detection-"));
	return { root, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function detect(component: string, root: string, seams?: unknown): any[] {
	return detectComponentLanguages({ component, root, componentRoot: root } as never, seams as never) as any[];
}

function fileEntry(name: string): fs.Dirent {
	return { name, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false } as fs.Dirent;
}

function directoryStream(entries: readonly fs.Dirent[]): fs.Dir {
	let index = 0;
	return {
		readSync: () => entries[index++] ?? null,
		closeSync: () => undefined,
	} as fs.Dir;
}

describe("per-component LSP language detection", () => {
	it("returns serializable component-local evidence and keeps detection disabled by default", () => {
		const f = fixture();
		try {
			fs.writeFileSync(path.join(f.root, "package.json"), "{}\n");
			fs.mkdirSync(path.join(f.root, "src"));
			fs.writeFileSync(path.join(f.root, "src", "app.ts"), "export const app = true;\n");
			fs.writeFileSync(path.join(f.root, "src", "view.tsx"), "export const View = () => <main />;\n");
			fs.writeFileSync(path.join(f.root, "src", "worker.py"), "print('ready')\n");

			const result = detect("frontend", f.root);
			expect(result.map(detection => detection.component)).toEqual(Array(result.length).fill("frontend"));
			expect(result.map(detection => detection.languageId)).toEqual(expect.arrayContaining(["python", "typescript", "tsx"]));
			for (const detection of result) {
				expect(detection.evidence.fileCount).toBeGreaterThan(0);
				expect(detection.evidence.matchedGlobs.length).toBeGreaterThan(0);
				expect(Array.isArray(detection.evidence.rootMarkers)).toBe(true);
				expect(detection.structuralSearch).toMatch(/^(available|unsupported)$/);
				expect(JSON.parse(JSON.stringify(detection))).toEqual(detection);
			}
			for (const languageId of ["python", "typescript", "tsx"]) {
				expect(result.find(detection => detection.languageId === languageId)).toMatchObject({ lsp: "disabled" });
			}
		} finally { f.dispose(); }
	});

	it("does not follow linked files or linked directories outside the component", () => {
		const f = fixture();
		const external = fs.mkdtempSync(path.join(os.tmpdir(), "language-lsp-external-"));
		try {
			fs.writeFileSync(path.join(f.root, "app.ts"), "export {};\n");
			fs.writeFileSync(path.join(external, "outside.rs"), "fn main() {}\n");
			fs.symlinkSync(path.join(external, "outside.rs"), path.join(f.root, "linked.rs"));
			fs.symlinkSync(external, path.join(f.root, "linked-directory"), process.platform === "win32" ? "junction" : "dir");

			const ids = detect("safe-component", f.root).map(detection => detection.languageId);
			expect(ids).toContain("typescript");
			expect(ids).not.toContain("rust");
		} finally {
			f.dispose();
			fs.rmSync(external, { recursive: true, force: true });
		}
	});

	it("bounds each component scan before late entries can create evidence", () => {
		const root = "/component";
		const entries = [fileEntry("first.ts"), ...Array.from({ length: MAX_LANGUAGE_DETECTION_ENTRIES }, (_, index) => fileEntry(`ignored-${index}.txt`)), fileEntry("late.py"), fileEntry("package.json")];
		let reads = 0;
		const seams = {
			lstatSync(file: fs.PathLike) {
				const value = String(file);
				return { isSymbolicLink: () => false, isDirectory: () => value === root, isFile: () => value !== root } as fs.Stats;
			},
			opendirSync() {
				const stream = directoryStream(entries);
				const readSync = stream.readSync.bind(stream);
				stream.readSync = () => {
					reads += 1;
					return readSync();
				};
				return stream;
			},
		};

		const result = detect("bounded", root, seams);
		const ids = result.map(detection => detection.languageId);
		expect(ids).toContain("typescript");
		expect(ids).not.toContain("python");
		expect(result.find(detection => detection.languageId === "typescript")?.evidence.rootMarkers).toEqual([]);
		expect(reads).toBeLessThan(MAX_LANGUAGE_DETECTION_ENTRIES);
	});
});
