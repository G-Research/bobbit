export type ReviewDecision = "approve" | "reject";

export interface ReviewInlineCommentPayload {
  /** Stable file identity for grouped reviews. Legacy callers may omit it. */
  fileId?: string;
  documentTitle: string;
  quote: string;
  comment: string;
  prefix?: string;
  suffix?: string;
  start?: number;
  end?: number;
  isCode?: boolean;
}

export interface ReviewDecisionPayload {
  decision: ReviewDecision;
  finalComment: string;
  inlineComments: ReviewInlineCommentPayload[];
  /** Human-readable fallback for the existing agent chat review flow. */
  feedback: string;
}

export type ReviewSource =
  | { kind: "markdown-review"; sessionId: string }
  | {
      kind: "verification-signoff-markdown";
      goalId: string;
      gateId: string;
      signalId: string;
      stepName: string;
      goalTitle?: string;
      gateName?: string;
      stepLabel?: string;
    }
  | {
      kind: "verification-signoff-pr";
      goalId: string;
      gateId: string;
      signalId: string;
      stepName: string;
      prUrl: string;
      goalTitle?: string;
      gateName?: string;
      stepLabel?: string;
    };

export interface ReviewFileModel {
  fileId: string;
  title: string;
  markdown: string;
}

/** One primary review workspace and its ordered, navigation-only files. */
export interface ReviewGroupModel {
  reviewId: string;
  title: string;
  files: ReviewFileModel[];
  activeFileId: string;
  source: ReviewSource;
}

/**
 * Compatibility view used by the original one-document review surface.
 * Grouped reviews use `fileId` beneath a stable `reviewId`; for legacy callers
 * `documentId` remains the file identity.
 */
export interface ReviewDocumentModel {
  title: string;
  markdown: string;
  source?: ReviewSource;
  documentId?: string;
  fileId?: string;
  reviewId?: string;
}

export interface ReviewDecisionEventDetail {
  review?: ReviewGroupModel | null;
  document: ReviewDocumentModel | null;
  source?: ReviewSource;
  payload: ReviewDecisionPayload;
  decision: ReviewDecision;
  finalComment: string;
  inlineComments: ReviewInlineCommentPayload[];
  feedback: string;
}
