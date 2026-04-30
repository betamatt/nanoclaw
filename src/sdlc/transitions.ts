/**
 * SDLC label taxonomy and state machine.
 *
 * Three kinds of sdlc: labels:
 *
 * - **States** — what the issue/PR IS right now. Mutually exclusive.
 *   Only one state label at a time. Applied by the agent (or by the
 *   pipeline on recovery). Humans should not manually set state labels.
 *
 * - **Commands** — human actions that trigger a state transition.
 *   Applied by a human, consumed by the pipeline (which removes the
 *   command label and applies the resulting state). Ephemeral.
 *
 * - **Flags** — modifiers that can coexist with any state.
 *   Applied/removed by either agent or human.
 */

// ── States ───────────────────────────────────────────────────────────────────

/** Issue states (pre-PR) */
export type IssueState = 'triage' | 'blocked' | 'plan-ready' | 'implementing';

/** PR states */
export type PrState = 'review' | 'validate' | 'merging';

/** All states */
export type SdlcState = IssueState | PrState;

/** Legal state transitions (agent-driven) */
export const LEGAL_TRANSITIONS: Record<SdlcState, SdlcState[]> = {
  triage: ['blocked', 'plan-ready'],
  blocked: ['implementing'],       // unblocked → straight to implementing
  'plan-ready': ['implementing'],   // via approve-plan command
  implementing: ['review'],         // agent opens PR, moves to review
  review: ['validate'],
  validate: ['merging'],            // via merge command (or auto for low-risk)
  merging: [],                      // terminal active state → closed on success
};

/** States that live on the issue (pre-PR) */
export const ISSUE_STATES = new Set<SdlcState>(['triage', 'blocked', 'plan-ready', 'implementing']);

/** States that live on the PR */
export const PR_STATES = new Set<SdlcState>(['review', 'validate', 'merging']);

/** States where sdlc:feedback-required flag is valid */
export const FLAGGABLE_STATES = new Set<SdlcState>(['triage', 'plan-ready', 'review', 'validate', 'merging']);

// ── Commands ─────────────────────────────────────────────────────────────────

export type SdlcCommand = 'approve-plan' | 'merge';

/** Command → { from states, resulting state } */
export const COMMAND_EFFECTS: Record<SdlcCommand, { from: Set<SdlcState>; to: SdlcState }> = {
  'approve-plan': { from: new Set(['plan-ready']), to: 'implementing' },
  merge: { from: new Set(['validate']), to: 'merging' },
};

export const ALL_COMMANDS: SdlcCommand[] = Object.keys(COMMAND_EFFECTS) as SdlcCommand[];

// ── Flags ────────────────────────────────────────────────────────────────────

export type SdlcFlag = 'feedback-required';

export const FEEDBACK_FLAG_LABEL = 'sdlc:flag:feedback-required';

// ── Derived sets ─────────────────────────────────────────────────────────────

/** All state label names (prefixed with sdlc:) */
export const ALL_STATE_LABELS = Object.keys(LEGAL_TRANSITIONS).map((s) => `sdlc:${s}`);

/** All command label names */
export const ALL_COMMAND_LABELS = ALL_COMMANDS.map((c) => `sdlc:cmd:${c}`);

/** All labels the pipeline manages (states + commands + flags) */
export const ALL_SDLC_LABELS = [...ALL_STATE_LABELS, ...ALL_COMMAND_LABELS, FEEDBACK_FLAG_LABEL];

// ── Functions ────────────────────────────────────────────────────────────────

/**
 * Extract the current SDLC state from a labels array.
 * Only matches state labels, not commands or flags.
 */
export function stateFromLabels(labels: Array<{ name: string }>): SdlcState | null {
  for (const label of labels) {
    if (label.name.startsWith('sdlc:')) {
      const value = label.name.slice(5);
      if (value in LEGAL_TRANSITIONS) {
        return value as SdlcState;
      }
    }
  }
  return null;
}

/**
 * Extract any command labels from the labels array.
 */
export function commandFromLabels(labels: Array<{ name: string }>): SdlcCommand | null {
  for (const label of labels) {
    if (label.name.startsWith('sdlc:')) {
      const value = label.name.slice(5);
      if (ALL_COMMANDS.includes(value as SdlcCommand)) {
        return value as SdlcCommand;
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
