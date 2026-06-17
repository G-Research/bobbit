export function formatSessionSearchTitle(sessionTitle: string, goalTitle?: string): string {
	const title = sessionTitle.trim();
	const goal = (goalTitle ?? "").trim();
	if (!title || !goal) return title;

	if (containsGoalTitleAsPhrase(title, goal)) return title;

	return `${goal}: ${title}`;
}

function containsGoalTitleAsPhrase(title: string, goal: string): boolean {
	const normalizedTitle = normalizeForTitleMatch(title);
	const normalizedGoal = normalizeForTitleMatch(goal);
	if (!normalizedTitle || !normalizedGoal) return false;

	let start = 0;
	while (start <= normalizedTitle.length) {
		const idx = normalizedTitle.indexOf(normalizedGoal, start);
		if (idx === -1) return false;
		const before = idx === 0 ? "" : normalizedTitle[idx - 1];
		const after = normalizedTitle[idx + normalizedGoal.length] ?? "";
		if (!isTitleTokenChar(before) && !isTitleTokenChar(after)) return true;
		start = idx + 1;
	}
	return false;
}

function normalizeForTitleMatch(value: string): string {
	return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function isTitleTokenChar(char: string): boolean {
	return char !== "" && /[\p{L}\p{N}]/u.test(char);
}
