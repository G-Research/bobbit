export function isLikelyGeneratedPath(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, "/").toLowerCase();
	return normalized.startsWith("dist/")
		|| normalized.includes("/dist/")
		|| normalized.includes("/generated/")
		|| normalized.includes("__snapshots__/")
		|| normalized.endsWith(".snap")
		|| normalized.endsWith("package-lock.json")
		|| normalized.endsWith("pnpm-lock.yaml")
		|| normalized.endsWith("yarn.lock")
		|| normalized.endsWith("bun.lockb")
		|| normalized.endsWith(".min.js")
		|| normalized.endsWith(".min.css");
}
