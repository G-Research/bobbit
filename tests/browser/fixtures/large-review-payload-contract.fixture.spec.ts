import { expect, test } from "@playwright/test";
import {
	LARGE_REVIEW_FILE_COUNT,
	LARGE_REVIEW_TOTAL_BYTES,
	assertLargeReviewFixture,
	largeReviewCanonicalHash,
	largeReviewFiles,
} from "../../../tests2/browser/fixtures/large-review-payload-fixture.js";

test.describe("Large review browser payload fixture", () => {
	test("is a deterministic 20-file, exact 485 KiB UTF-8 payload with opaque duplicate-title identities", () => {
		const files = largeReviewFiles();
		assertLargeReviewFixture(files);

		expect(files).toHaveLength(LARGE_REVIEW_FILE_COUNT);
		expect(files.reduce((sum, file) => sum + file.bytes, 0)).toBe(LARGE_REVIEW_TOTAL_BYTES);
		expect(files[8].title).toBe(files[9].title);
		expect(files[8].fileId).not.toBe(files[9].fileId);
		expect(new Set(files.map((file) => file.marker)).size).toBe(LARGE_REVIEW_FILE_COUNT);
		expect(largeReviewCanonicalHash(files)).toMatch(/^[a-f0-9]{64}$/);
		expect(largeReviewCanonicalHash(files)).toBe(largeReviewCanonicalHash());
	});
});
