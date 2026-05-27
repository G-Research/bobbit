export type ReviewDecision = "approve" | "reject";

export interface ReviewInlineCommentPayload {
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

export interface ReviewDocumentModel {
  title: string;
  markdown: string;
  source?: ReviewSource;
}

export interface ReviewDecisionEventDetail {
  document: ReviewDocumentModel | null;
  source?: ReviewSource;
  payload: ReviewDecisionPayload;
  decision: ReviewDecision;
  finalComment: string;
  inlineComments: ReviewInlineCommentPayload[];
  feedback: string;
}
