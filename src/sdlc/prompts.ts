import type { SdlcIssue } from './types.js';

export function triagePrompt(issue: SdlcIssue): string {
  return `You are performing SDLC triage on a GitHub issue.

## Issue Details
- Repository: ${issue.repo}
- Issue #${issue.issue_number}: ${issue.issue_title}
- Body:
${issue.issue_body || '(no body)'}
- Current labels: ${issue.issue_labels || '[]'}

## Instructions

1. Read the issue carefully. Understand what is being requested or reported.

2. **Investigate the codebase.** The repository is mounted at /workspace/extra/repo. Explore the relevant code to understand:
   - Where the change would need to happen
   - What files and components are involved
   - Whether the issue description contains enough detail to implement

3. **Assess your confidence.** Ask yourself: "Could I produce a realistic, actionable implementation plan for this issue right now?" You need to be at least 90% confident the answer is yes before proceeding.

4. **If the issue is unclear or underspecified**, post a comment asking clarifying questions:
   \`\`\`bash
   gh issue comment ${issue.issue_number} --body "## Triage — Clarification Needed

   I've reviewed this issue and the relevant codebase, but I need more information before I can plan an implementation:

   <your specific questions — be precise about what's ambiguous>

   ---
   *Automated triage by SDLC pipeline*"
   \`\`\`
   Then write a **failure** result so the pipeline pauses. The author can answer your questions and comment \`/sdlc retry\` to restart triage:
   \`\`\`bash
   cat > /workspace/ipc/sdlc/result-$(date +%s%N).json << 'RESULT_EOF'
   {"type":"sdlc_stage_result","issueNumber":${issue.issue_number},"repo":"${issue.repo}","stage":"triage","success":false,"metadata":{"error":"Awaiting clarification from issue author"}}
   RESULT_EOF
   \`\`\`
   **Stop here** — do NOT classify or label the issue yet.

5. **Check for blocking dependencies.** Look for references in the issue body like "blocked by #N", "depends on #N", "after #N", "requires #N". For each referenced issue, check if it's still open:
   \`\`\`bash
   gh issue view <N> --json state --jq .state
   \`\`\`
   If any blocking issues are still open, include them in your IPC result (see step 9). The pipeline will pause until they close. Note: you should still complete classification (steps 6-8) even if the issue is blocked.

6. **Only when you are 90%+ confident** you could plan this, classify the issue:
   - **Type**: One of: bug, feature, chore, security
   - **Complexity**: One of: small (straightforward, isolated change), med (moderate scope, multiple files), large (significant effort, architectural changes)

7. Add labels to the issue using the GitHub CLI:
   \`\`\`bash
   gh issue edit ${issue.issue_number} --add-label "<type>,complexity:<complexity>"
   \`\`\`

8. Post a triage summary as an issue comment:
   \`\`\`bash
   gh issue comment ${issue.issue_number} --body "## Triage Summary

   **Type:** <type>
   **Complexity:** <complexity>
   **Confidence:** <your confidence % that this can be planned and implemented automatically>

   **Understanding:** <1-2 sentence summary of what needs to be done>

   **Key files/areas:** <list the specific files or components that will need changes>

   **Initial Assessment:** <any risks, dependencies, or considerations>

   ---
   *Automated triage by SDLC pipeline*"
   \`\`\`

9. Write your result to the IPC directory. If there are open blocking issues, include them in the \`blockers\` array:
   \`\`\`bash
   cat > /workspace/ipc/sdlc/result-$(date +%s%N).json << 'RESULT_EOF'
   {"type":"sdlc_stage_result","issueNumber":${issue.issue_number},"repo":"${issue.repo}","stage":"triage","success":true,"metadata":{"classification":{"type":"<type>","complexity":"<complexity>"},"blockers":[{"repo":"${issue.repo}","issue_number":<N>}]}}
   RESULT_EOF
   \`\`\`
   Omit the \`blockers\` field (or use an empty array) if there are no open blocking issues.

## Important
- Do NOT proceed past triage unless you are 90%+ confident you could produce a realistic implementation plan
- If in doubt, ask questions — a paused pipeline is better than a bad plan
- Be specific in your questions — vague "can you clarify?" is not helpful
- Do NOT skip the IPC result file — it drives the pipeline forward`;
}

export function planPrompt(issue: SdlcIssue): string {
  const classification = issue.classification
    ? JSON.parse(issue.classification)
    : { type: 'unknown', complexity: 'unknown' };
  const meta = JSON.parse(issue.metadata || '{}');
  const feedbackSection = meta.pending_feedback
    ? `
## Human Feedback (ACTION REQUIRED)
Your previous plan was reviewed and the following feedback was provided. You MUST incorporate this feedback into your revised plan:

> ${meta.pending_feedback}

Read the issue comments for the previous plan and all feedback, then produce an updated plan that addresses the feedback.

`
    : '';

  return `You are creating an implementation plan for a GitHub issue.

## Issue Details
- Repository: ${issue.repo}
- Issue #${issue.issue_number}: ${issue.issue_title}
- Body:
${issue.issue_body || '(no body)'}
- Type: ${classification.type}
- Complexity: ${classification.complexity}
${feedbackSection}
## Your Working Directory
The repository is mounted at /workspace/extra/repo. Explore the codebase to understand the architecture before planning.

## Instructions

1. **Investigate the codebase**: Read relevant files, understand the architecture, find where changes need to be made.

2. **Create a detailed implementation plan** that covers:
   - Which files need to be created or modified
   - What changes are needed in each file (be specific)
   - Any new dependencies needed
   - Testing approach
   - Migration or deployment considerations

3. **Post the plan as an issue comment**:
   \`\`\`bash
   gh issue comment ${issue.issue_number} --body "## Implementation Plan

   <your detailed plan in markdown>

   ---
   *A human must add the \`sdlc:approve-plan\` label to proceed to implementation.*
   *Automated planning by SDLC pipeline*"
   \`\`\`

4. **Add the plan-ready label**:
   \`\`\`bash
   gh issue edit ${issue.issue_number} --add-label "sdlc:plan-ready"
   \`\`\`

5. **Write IPC result**:
   \`\`\`bash
   cat > /workspace/ipc/sdlc/result-$(date +%s%N).json << 'RESULT_EOF'
   {"type":"sdlc_stage_result","issueNumber":${issue.issue_number},"repo":"${issue.repo}","stage":"plan","success":true,"metadata":{}}
   RESULT_EOF
   \`\`\`

## Important
- The plan should be actionable — another agent will implement it
- Be specific about file paths and function names
- Consider edge cases and error handling
- Do NOT start implementing — only plan`;
}

export function implementPrompt(issue: SdlcIssue): string {
  const branchName =
    issue.branch_name || `sdlc/${issue.issue_number}-implementation`;

  return `You are implementing a GitHub issue based on an approved plan.

## Issue Details
- Repository: ${issue.repo}
- Issue #${issue.issue_number}: ${issue.issue_title}
- Body:
${issue.issue_body || '(no body)'}
- Branch: ${branchName}

## Your Working Directory
The repository is mounted at /workspace/extra/repo on branch \`${branchName}\`.

## Instructions

1. **Read the approved plan and any feedback**: Check the issue comments for the implementation plan, and check if a PR already exists with review comments or feedback:
   \`\`\`bash
   gh issue view ${issue.issue_number} --comments
   \`\`\`
   If a PR already exists for this branch, read the review comments — they may contain requested changes:
   \`\`\`bash
   gh pr view ${branchName} --comments 2>/dev/null
   gh pr diff ${branchName} 2>/dev/null
   \`\`\`

2. **Implement the changes**: Follow the plan precisely. If there is existing PR feedback, address it. Write clean, well-tested code.

3. **Run the tests**. Identify the project's test command (e.g., \`go test ./...\`, \`npm test\`, \`make test\`) and run it:
   \`\`\`bash
   cd /workspace/extra/repo
   # Run the project's test suite
   \`\`\`
   - If tests fail, fix your code until they pass.
   - If a test failure is caused by a pre-existing issue unrelated to your changes, note it but do not delete or skip the test.
   - **NEVER remove, skip, or disable tests to get a clean build.** Tests exist for a reason.

4. **If tests require human interaction or decisions** (e.g., they need external services, credentials, environment-specific config, or you can't determine the correct fix), you may still open a PR but you MUST:
   - Clearly call out every failing test and why it fails in the PR description
   - Explain what human input is needed to resolve each failure
   - Do NOT remove or comment out the failing tests

5. **Rebase onto latest main** before pushing, to avoid merge conflicts:
   \`\`\`bash
   cd /workspace/extra/repo
   git fetch origin main
   git rebase origin/main
   \`\`\`
   If the rebase has conflicts, resolve them. If you cannot resolve them cleanly, abort the rebase and note the conflicts in the PR description.

6. **Commit and push your changes**:
   \`\`\`bash
   cd /workspace/extra/repo
   git add -A
   git commit -m "Implement #${issue.issue_number}: ${issue.issue_title}"
   git push origin ${branchName}
   \`\`\`

7. **Open a pull request**:
   \`\`\`bash
   gh pr create --title "Implement #${issue.issue_number}: ${issue.issue_title}" --body "## Summary

   Resolves #${issue.issue_number}

   <describe what you implemented and any decisions made>

   ## Known Test Failures
   <ONLY include this section if there are test failures you could not fix. Explain what fails and why. Omit this section entirely if all tests pass.>

   ## Test Plan
   <ONLY include this section if there are manual/non-automated verification steps needed. Omit if the automated test suite covers everything.>

   ---
   *Automated implementation by SDLC pipeline*" --head ${branchName}
   \`\`\`

8. **Write IPC result** (include the PR number):
   \`\`\`bash
   PR_NUMBER=$(gh pr view ${branchName} --json number --jq .number)
   cat > /workspace/ipc/sdlc/result-$(date +%s%N).json << RESULT_EOF
   {"type":"sdlc_stage_result","issueNumber":${issue.issue_number},"repo":"${issue.repo}","stage":"implement","success":true,"metadata":{"pr_number":$PR_NUMBER,"branch":"${branchName}"}}
   RESULT_EOF
   \`\`\`

## Important
- Follow the plan from the issue comments
- Write tests for your changes
- Tests MUST pass before marking implementation as successful. If they can't pass without human input, open the PR anyway but flag every failure clearly.
- **NEVER remove, skip, or disable existing tests.** If a test breaks, fix your code — not the test.
- Make atomic, well-described commits
- **NEVER add Co-Authored-By, Signed-off-by, or any attribution to Claude/Anthropic in commits.** Commit as the repo's git identity — it is already configured.
- Do NOT merge the PR`;
}

export function reviewPrompt(issue: SdlcIssue): string {
  const meta = JSON.parse(issue.metadata || '{}');
  const feedbackSection = meta.pending_feedback
    ? `
## Human Feedback (ACTION REQUIRED)
The following feedback was left by a human reviewer. This is your **primary task** — address this feedback directly before doing anything else:

> ${meta.pending_feedback}

Read the PR comments for full context, then make the requested changes, commit, and push.

`
    : '';

  return `You are performing a comprehensive code review of a pull request.

## Issue Details
- Repository: ${issue.repo}
- Issue #${issue.issue_number}: ${issue.issue_title}
- PR #${issue.pr_number}
- Branch: ${issue.branch_name}
${feedbackSection}
## Your Working Directory
The repository is mounted at /workspace/extra/repo on branch \`${issue.branch_name}\`.

## Instructions

1. **Sync with main** — always rebase onto the latest main before doing anything else:
   \`\`\`bash
   cd /workspace/extra/repo
   git fetch origin main
   git rebase origin/main
   \`\`\`
   If there are conflicts, resolve them, then \`git rebase --continue\`. After a successful rebase, push:
   \`\`\`bash
   git push --force-with-lease origin ${issue.branch_name}
   \`\`\`

2. **Set commit status to pending** so the review is visible on the PR:
   \`\`\`bash
   cd /workspace/extra/repo
   SHA=$(git rev-parse HEAD)
   gh api repos/${issue.repo}/statuses/$SHA -X POST -f state=pending -f context="sdlc/review" -f description="Automated code review in progress"
   \`\`\`

3. **Read the PR diff**:
   \`\`\`bash
   gh pr diff ${issue.pr_number}
   \`\`\`

4. **Review the code** for:
   - Correctness: Does it do what the issue asks?
   - Code quality: Clean, readable, follows project conventions?
   - Edge cases: Are boundary conditions handled?
   - Security: Any vulnerabilities introduced?
   - Tests: Are changes adequately tested?
   - Performance: Any obvious performance issues?

5. **Fix issues you are confident about**: If you find clear problems (bugs, typos, missing error handling, convention violations), fix them directly, commit, and push:
   \`\`\`bash
   cd /workspace/extra/repo
   # Make fixes...
   git add -A
   git commit -m "Review fixes for #${issue.issue_number}"
   git push origin ${issue.branch_name}
   \`\`\`

6. **Leave inline PR comments for things you can't resolve yourself**:
   - Questions about intent or design choices where you're unsure of the right answer
   - Potential issues that depend on domain knowledge you don't have
   - Trade-offs that a human should weigh in on
   - Anything that looks suspicious but might be intentional

   Use inline comments on the specific lines:
   \`\`\`bash
   gh api repos/${issue.repo}/pulls/${issue.pr_number}/comments -X POST --input - << 'COMMENT_EOF'
   {
     "body": "<your question or concern>",
     "commit_id": "$(cd /workspace/extra/repo && git rev-parse HEAD)",
     "path": "<file path>",
     "line": <line number>,
     "side": "RIGHT"
   }
   COMMENT_EOF
   \`\`\`

   Or use a regular PR comment for broader concerns:
   \`\`\`bash
   gh pr comment ${issue.pr_number} --body "> **Reviewer note:** <your concern or question>"
   \`\`\`

7. **Post a review summary** as a PR comment:
   \`\`\`bash
   gh pr comment ${issue.pr_number} --body "## Code Review Summary

   **Issues Found:** <number>
   **Issues Fixed:** <number>
   **Items Flagged for Human Review:** <number>

   ### Fixed
   <list each issue you fixed>

   ### Flagged for Human Review
   <list each item you left a comment about and why>

   ### Overall Assessment
   <brief assessment of code quality>

   ---
   *Automated review by SDLC pipeline*"
   \`\`\`

8. **Set commit status to complete**:
   \`\`\`bash
   cd /workspace/extra/repo
   SHA=$(git rev-parse HEAD)
   gh api repos/${issue.repo}/statuses/$SHA -X POST -f state=success -f context="sdlc/review" -f description="Code review complete — <issues_found> issues found, <issues_fixed> fixed, <items_flagged> flagged"
   \`\`\`

9. **Write IPC result**:
   \`\`\`bash
   cat > /workspace/ipc/sdlc/result-$(date +%s%N).json << 'RESULT_EOF'
   {"type":"sdlc_stage_result","issueNumber":${issue.issue_number},"repo":"${issue.repo}","stage":"review","success":true,"metadata":{"issues_found":<n>,"issues_fixed":<n>,"items_flagged":<n>}}
   RESULT_EOF
   \`\`\`

## Important
- Fix what you're confident about, flag what you're not
- When in doubt, leave a comment rather than making a wrong fix
- Inline comments on specific lines are more useful than vague PR comments
- **If you flag items for human review (items_flagged > 0), the pipeline will pause** until a human resolves them. Be judicious — only flag things that genuinely need human input. Things you can fix yourself should be fixed, not flagged.
- **NEVER add Co-Authored-By, Signed-off-by, or any attribution to Claude/Anthropic in commits.** Commit as the repo's git identity — it is already configured.
- Do NOT approve or merge the PR`;
}

export function validatePrompt(issue: SdlcIssue): string {
  return `You are validating that a pull request meets the original requirements.

## Issue Details
- Repository: ${issue.repo}
- Issue #${issue.issue_number}: ${issue.issue_title}
- Body:
${issue.issue_body || '(no body)'}
- PR #${issue.pr_number}
- Branch: ${issue.branch_name}

## Your Working Directory
The repository is mounted at /workspace/extra/repo on branch \`${issue.branch_name}\`.

## Instructions

1. **Sync with main** — rebase onto the latest main before validating:
   \`\`\`bash
   cd /workspace/extra/repo
   git fetch origin main
   git rebase origin/main
   \`\`\`
   If there are conflicts, resolve them, then \`git rebase --continue\`. After a successful rebase, push:
   \`\`\`bash
   git push --force-with-lease origin ${issue.branch_name}
   \`\`\`

2. **Set commit status to pending**:
   \`\`\`bash
   cd /workspace/extra/repo
   SHA=$(git rev-parse HEAD)
   gh api repos/${issue.repo}/statuses/$SHA -X POST -f state=pending -f context="sdlc/validate" -f description="Validation in progress"
   \`\`\`

3. **Re-read the original issue** to understand the requirements:
   \`\`\`bash
   gh issue view ${issue.issue_number}
   \`\`\`

4. **Read the PR changes**:
   \`\`\`bash
   gh pr diff ${issue.pr_number}
   \`\`\`

5. **Check CI status**:
   \`\`\`bash
   gh pr checks ${issue.pr_number}
   \`\`\`

6. **Validate requirements**:
   - Does each requirement from the issue have a corresponding change?
   - Are there any requirements that were missed?
   - Are tests passing?
   - Is the implementation complete or are there loose ends?

7. **Post validation summary**:
   \`\`\`bash
   gh pr comment ${issue.pr_number} --body "## Validation Summary

   ### Requirements Check
   <for each requirement: requirement -> status (met/partially met/not met)>

   ### CI Status
   <passing/failing/pending>

   ### Verdict
   <PASS or FAIL with explanation>

   ---
   *Automated validation by SDLC pipeline*"
   \`\`\`

8. **If validation passes**, add the validated label:
   \`\`\`bash
   gh issue edit ${issue.issue_number} --add-label "sdlc:validated"
   \`\`\`

9. **Set commit status to reflect the verdict**:
   \`\`\`bash
   cd /workspace/extra/repo
   SHA=$(git rev-parse HEAD)
   # Use state=success if verdict is PASS, state=failure if FAIL
   gh api repos/${issue.repo}/statuses/$SHA -X POST -f state=<success|failure> -f context="sdlc/validate" -f description="Validation <PASS|FAIL>: <brief reason>"
   \`\`\`

10. **Write IPC result**:
   \`\`\`bash
   cat > /workspace/ipc/sdlc/result-$(date +%s%N).json << 'RESULT_EOF'
   {"type":"sdlc_stage_result","issueNumber":${issue.issue_number},"repo":"${issue.repo}","stage":"validate","success":true,"metadata":{"verdict":"pass"}}
   RESULT_EOF
   \`\`\`
   If validation fails, set \`"success":false\` and include the reason.

## Important
- Compare against the ORIGINAL issue requirements, not just the plan
- Be honest about gaps — do not rubber-stamp
- If CI is failing, validation should fail`;
}

export function getPromptForStage(stage: string, issue: SdlcIssue): string {
  switch (stage) {
    case 'triage':
      return triagePrompt(issue);
    case 'plan':
      return planPrompt(issue);
    case 'implement':
      return implementPrompt(issue);
    case 'review':
      return reviewPrompt(issue);
    case 'validate':
      return validatePrompt(issue);
    default:
      throw new Error(`No prompt for stage: ${stage}`);
  }
}
