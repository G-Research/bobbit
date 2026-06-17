export function formatSessionSearchTitle(sessionTitle: string, goalTitle?: string): string {
	const title = sessionTitle.trim();
	const goal = (goalTitle ?? "").trim();
	if (!title || !goal) return title;

	const lowerTitle = title.toLocaleLowerCase();
	const lowerGoal = goal.toLocaleLowerCase();
	if (lowerTitle.includes(lowerGoal)) return title;

	return `${goal}: ${title}`;
}
