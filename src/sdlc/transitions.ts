/**
 * SDLC state machine transition table and validation.
 * See .claude/skills/github-sdlc/STATE_MACHINE.md for the full spec.
 */

// Issue states
export type IssueState =
  | 'triage'
  | 'blocked'
  | 'plan-ready'
  | 'plan-approved'
  | 'implemented';

// PR states
export type PrState = 'review' | 'validate' | 'awaiting-merge' | 'merge';

// All states
export type SdlcState = IssueState | PrState;

// Flag
export type SdlcFlag = 'feedback-required';

/** Legal transitions: from → allowed successors */
export const LEGAL_TRANSITIONS: Record<SdlcState, SdlcState[]> = {
  triage: ['blocked', 'plan-ready'],
  blocked: ['plan-ready'],
  'plan-ready': ['plan-approved'],
  'plan-approved': ['implemented'],
  implemented: ['review'],
  review: ['validate'],
  validate: ['awaiting-merge'],
  'awaiting-merge': ['merge'],
  merge: [],
};

/** States that only the agent may apply */
export const AGENT_ONLY_STATES = new Set<SdlcState>([
  'triage',
  'blocked',
  'plan-ready',
  'implemented',
  'review',
  'validate',
  'awaiting-merge',
]);

/** States that only a human may apply */
export const HUMAN_ONLY_STATES = new Set<SdlcState>(['plan-approved', 'merge']);

/** States where sdlc:feedback-required flag is valid */
export const FLAGGABLE_STATES = new Set<SdlcState>([
  'triage',
  'plan-ready',
  'review',
  'validate',
  'merge',
]);

/** States that live on the issue (pre-PR) */
export const ISSUE_STATES = new Set<SdlcState>([
  'triage',
  'blocked',
  'plan-ready',
  'plan-approved',
  'implemented',
]);

/** States that live on the PR */
export const PR_STATES = new Set<SdlcState>([
  'review',
  'validate',
  'awaiting-merge',
  'merge',
]);

/** All state label names (prefixed with sdlc:) */
export const ALL_STATE_LABELS = [...Object.keys(LEGAL_TRANSITIONS)].map(
  (s) => `sdlc:${s}`,
);

/** The flag label */
export const FEEDBACK_FLAG_LABEL = 'sdlc:feedback-required';

/**
 * Validate a state transition.
 * Returns null if valid, or an error string if invalid.
 */
export function validateTransition(
  from: SdlcState | null,
  to: SdlcState,
  actorIsAgent: boolean,
): string | null {
  // Check actor permissions
  if (actorIsAgent && HUMAN_ONLY_STATES.has(to)) {
    return `State "${to}" can only be applied by a human`;
  }
  if (!actorIsAgent && AGENT_ONLY_STATES.has(to)) {
    return `State "${to}" can only be applied by the agent`;
  }

  // New issue — only triage is valid
  if (from === null) {
    if (to !== 'triage') {
      return `New issues must start in "triage", not "${to}"`;
    }
    return null;
  }

  // Check legal transition
  const allowed = LEGAL_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    return `Transition from "${from}" to "${to}" is not allowed`;
  }

  return null;
}

/**
 * Extract the current SDLC state from a labels array.
 * Returns the state name (without sdlc: prefix) or null.
 */
export function stateFromLabels(
  labels: Array<{ name: string }>,
): SdlcState | null {
  for (const label of labels) {
    if (label.name.startsWith('sdlc:')) {
      const state = label.name.slice(5) as SdlcState;
      if (state in LEGAL_TRANSITIONS) {
        return state;
      }
    }
  }
  return null;
}

/**
 * Check if the feedback-required flag is present.
 */
export function hasFeedbackFlag(labels: Array<{ name: string }>): boolean {
  return labels.some((l) => l.name === FEEDBACK_FLAG_LABEL);
}
