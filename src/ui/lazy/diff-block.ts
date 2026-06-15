let loaded = false;

export function ensureDiffBlock(): void {
	if (loaded) return;
	loaded = true;
	void import("../components/DiffBlock.js");
}
