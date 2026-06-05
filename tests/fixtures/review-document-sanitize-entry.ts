import {
	renderReviewMarkdownToHtml,
	sanitizeReviewMarkdownHtml,
} from "../../src/ui/components/review/ReviewDocument.js";

(window as any).__renderReviewMarkdownToHtml = renderReviewMarkdownToHtml;
(window as any).__sanitizeReviewMarkdownHtml = sanitizeReviewMarkdownHtml;
(window as any).__reviewDocumentSanitizeReady = true;
