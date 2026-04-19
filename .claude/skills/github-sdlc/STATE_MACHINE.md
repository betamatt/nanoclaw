# SDLC State Machine

An issue-and-PR lifecycle state machine driven by GitHub labels. Each issue carries exactly one `sdlc:<state>` label at a time; applying a new state label *is* the transition, and the guard workflow enforces that by stripping all other state labels and flags atomically.

## Design principles

1. **Labels are the source of truth.** The current state is whatever `sdlc:<state>` label is present. No separate state store.
2. **State labels are mutually exclusive.** Exactly one at a time. Applying a new one removes the others.
3. **Flags are orthogonal modifiers.** Additive to any compatible state. Any flag present blocks advance.
4. **One logical unit, two label hosts.** Issue and PR are the same work item; labels live wherever they're most convenient to apply.
5. **States are for event-driven waits; flags are for human-gated pauses.** If the machine can detect unblocking on its own, it's a state. If a human has to actively clear it, it's a flag.

## Label partition

State labels on the **issue**:

- `sdlc:triage`
- `sdlc:blocked`
- `sdlc:plan-ready`
- `sdlc:plan-approved`
- `sdlc:implemented`

State labels on the **PR**:

- `sdlc:review`
- `sdlc:validate`
- `sdlc:awaiting-merge`
- `sdlc:merge`

Flag labels (applied on whichever artifact is in scope for the current state):

- `sdlc:feedback-required`

## States

### Triage (issue)

Agent applies on new issues. Interactive phase — agent asks questions, gets responses, refines the problem statement until confident enough to either hand off to planning or flag open dependencies. Held by `sdlc:feedback-required` when the agent has open questions for a human.

**Exits to:** `sdlc:blocked` if triage surfaces open dependencies, `sdlc:plan-ready` otherwise.

### Blocked (issue)

External dependencies are open. Agent waits passively; no human action needed to advance. The `issues.closed` workflow re-evaluates any open issues that reference the closing one and advances them to `sdlc:plan-ready` when all their blockers resolve.

Blockers are declared via GitHub cross-references in the issue body (`Depends on: #123`). The cross-reference graph is the dependency graph.

**Exits to:** `sdlc:plan-ready` when all referenced blockers are closed.

### Plan ready (issue)

Agent has produced a plan; waiting for human approval. Held by `sdlc:feedback-required` when the human has pushed back and the agent is iterating the plan. The plan can't be rejected — it loops until approved.

**Exits to:** `sdlc:plan-approved` when a human applies that label.

### Plan approved (issue)

Human gate passed. Agent begins implementation. No intra-state interactivity — this state exists to mark "human has signed off on the plan, execution authorized" and is exited as soon as a PR opens.

**Exits to:** `sdlc:implemented` when the implementation PR opens.

### Implemented (issue)

Terminal state on the issue side. Applied by the agent when it opens the implementation PR. The issue label never changes after this — all subsequent state lives on the PR. Issue closes when the PR merges (via `Closes #N` linkage).

### Review (PR)

Automated code-level review: lint, tests, diff coverage, code-review bot, security scan. Held by `sdlc:feedback-required` when the review raises questions the agent can't resolve on its own.

**Exits to:** `sdlc:validate` when automated review passes.

### Validate (PR)

Automated acceptance-level verification: use case met, integration/E2E, no regressions against the acceptance criteria captured during triage. Failed validation stays in this state with `sdlc:feedback-required` added. Code concerns belong in review; validate is about whether the thing does what the issue asked for.

**Exits to:** `sdlc:awaiting-merge` when validation passes.

### Awaiting merge (PR)

Waiting for human sign-off on the merge. All automated gates have passed; this is the final human checkpoint before the merge queue.

**Exits to:** `sdlc:merge` when a human applies that label.

### Merge (PR)

Queued for merge. The agent processes this queue serially — one merge at a time — to avoid interleaved builds and contested main. FIFO by label-application timestamp.

**Exits to:** issue closure on successful merge.

## Flags

### Feedback required

`sdlc:feedback-required`. Applies to: `triage`, `plan-ready`, `review`, `validate`.

Raised by the agent when it needs a human to answer a question or resolve an ambiguity it can't handle autonomously. Blocks advance until a human removes it or applies a new state label that implies resolution. Cleared by removal or by state transition (state transitions strip all flags).

Not applied to `blocked`, `plan-approved`, `implemented`, `awaiting-merge`, or `merge`: those states are either waiting for external events or represent human gates where the human applies the state label directly.

## Transitions

| From               | To                 | Trigger                                    | Actor  |
|--------------------|--------------------|--------------------------------------------|--------|
| (new issue)        | `triage`           | Issue opened                               | agent  |
| `triage`           | `blocked`          | Open dependencies detected                 | agent  |
| `triage`           | `plan-ready`       | Triage complete, no blockers               | agent  |
| `blocked`          | `plan-ready`       | All referenced blockers closed             | agent  |
| `plan-ready`       | `plan-approved`    | Human approves plan                        | human  |
| `plan-approved`    | `implemented`      | Implementation PR opened                   | agent  |
| `implemented`      | `review`           | PR opens (PR enters state machine)         | agent  |
| `review`           | `validate`         | Automated code review passes               | agent  |
| `validate`         | `awaiting-merge`   | Automated validation passes                | agent  |
| `awaiting-merge`   | `merge`            | Human signs off on merge                   | human  |
| `merge`            | (closed)           | Agent merges PR serially, issue auto-closes| agent  |

## Enforcement

A single label-guard workflow on `issues.labeled`, `issues.unlabeled`, `pull_request.labeled`, and `pull_request.unlabeled`.

When a new `sdlc:<state>` label is applied, the guard:

1. Validates `github.actor` against the allow-list for that label (reject human applying an agent-only label and vice versa).
2. Validates `(current_state, new_state)` against the legal transition table (reject illegal jumps).
3. Removes all other `sdlc:<state>:*` labels on the artifact.
4. Removes all `sdlc:<flag>:*` labels on the artifact.
5. Fires the downstream workflow for the new state.

If any step fails, the newly-applied label is removed as rollback. The label set is always in a valid configuration after the workflow exits.

### Actor allow-lists

- **Agent-only:** `triage`, `blocked`, `plan-ready`, `implemented`, `review`, `validate`, `awaiting-merge`
- **Human-only:** `plan-approved`, `merge`
- **Either:** `feedback-required` (agent raises when stuck; human may raise to force a pause)

### Legal transitions

The transition table above is the allow-list. Anything not in it is rejected. Notably:

- `triage` has two legal successors (`blocked`, `plan-ready`)
- `blocked` has one (`plan-ready`)
- Every other state has exactly one legal successor
- No backward transitions — all rework happens within a state via `sdlc:feedback-required`

## Design notes

### Flags don't persist across transitions

State transitions strip all flags. `sdlc:feedback-required` is strictly within-state; resolving it either removes the flag (agent re-runs) or advances the state (which removes it as a side effect). No pause condition ever travels between states.

### Why `merge` is a state, not a flag

The human sign-off in `awaiting-merge` is a real transition — it's moving the PR from "human review pending" to "in the merge queue." The agent processes the queue without further human input, so `merge` behaves as an event-driven wait (wait for queue position, then merge). Event-driven → state.

### Merge failure handling

If the agent fails to merge (conflict, CI flake, branch protection rejects), the PR stays in `sdlc:merge` with `sdlc:feedback-required` added. This preserves queue position and marks human attention as needed. Resolving the issue and removing the flag lets the agent retry; applying `sdlc:awaiting-merge` kicks it back out of the queue for deeper rework.

### Skipping `blocked`

When triage completes with no open dependencies, the agent transitions directly to `plan-ready`. `blocked` is only entered when there's something to wait on. The transition table permits both paths out of `triage`.

### Close-event workflow

On `issues.closed`, scan open issues whose body cross-references the closing one. For each, re-evaluate all declared blockers. If all are closed, apply `sdlc:plan-ready` — the state-swap rule handles removing `sdlc:blocked` as a side effect. No polling.

### Future pauses

New pause reasons follow the same test: human has to clear it → flag. Machine can detect resolution → state. `sdlc:urgent` would be a flag (priority signal the merge-queue processor reads). A wait on external API availability would be a state.
