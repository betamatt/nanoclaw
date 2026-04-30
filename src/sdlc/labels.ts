/**
 * GitHub label operations for the SDLC state machine.
 * Labels are the source of truth for issue/PR state.
 */
import { execSync } from 'child_process';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import {
  ALL_COMMAND_LABELS,
  ALL_STATE_LABELS,
  FEEDBACK_FLAG_LABEL,
  type SdlcCommand,
  type SdlcFlag,
  type SdlcState,
  stateFromLabels,
} from './transitions.js';

function ghEnv(): Record<string, string> {
  const env = readEnvFile(['GITHUB_TOKEN']);
  const token = env.GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  return {
    ...process.env,
    ...(token ? { GITHUB_TOKEN: token } : {}),
  } as Record<string, string>;
}

/**
 * Read the current SDLC state from an issue or PR's labels via API.
 * Prefer using webhook payload labels when available to avoid API calls.
 */
export function readState(repo: string, number: number): SdlcState | null {
  try {
    const result = execSync(`gh api repos/${repo}/issues/${number}/labels --jq '[.[].name]'`, {
      encoding: 'utf-8',
      env: ghEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const names: string[] = JSON.parse(result);
    return stateFromLabels(names.map((name) => ({ name })));
  } catch {
    return null;
  }
}

/**
 * Apply a new state label to an issue or PR.
 * Atomically strips all other sdlc:* state labels and flag labels.
 */
export function applyStateLabel(repo: string, number: number, newState: SdlcState): void {
  const env = ghEnv();
  const labelToAdd = `sdlc:${newState}`;

  // Get current labels
  let currentLabels: string[];
  try {
    const result = execSync(`gh api repos/${repo}/issues/${number}/labels --jq '[.[].name]'`, {
      encoding: 'utf-8',
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    currentLabels = JSON.parse(result);
  } catch {
    currentLabels = [];
  }

  // Compute new label set: remove all sdlc:* state, command, and flag labels, add new state
  const sdlcLabels = new Set([...ALL_STATE_LABELS, ...ALL_COMMAND_LABELS, FEEDBACK_FLAG_LABEL]);
  const kept = currentLabels.filter((l) => !sdlcLabels.has(l));
  kept.push(labelToAdd);

  // Set labels atomically via PUT (replaces entire label set)
  try {
    const payload = JSON.stringify({ labels: kept });
    execSync(`gh api repos/${repo}/issues/${number}/labels -X PUT --input -`, {
      input: payload,
      encoding: 'utf-8',
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    log.info('State label applied', { repo, number, state: newState });
  } catch (err) {
    log.error('Failed to apply state label', { repo, number, state: newState, err });
  }
}

/**
 * Add a flag label to an issue or PR without touching state labels.
 */
export function addFlag(repo: string, number: number, flag: SdlcFlag): void {
  const label = `sdlc:flag:${flag}`;
  try {
    execSync(`gh api repos/${repo}/issues/${number}/labels -X POST -f "labels[]=${label}"`, {
      env: ghEnv(),
      stdio: 'pipe',
    });
    log.info('Flag added', { repo, number, flag });
  } catch (err) {
    log.warn('Failed to add flag', { repo, number, flag, err });
  }
}

/**
 * Remove a flag label from an issue or PR.
 */
export function removeFlag(repo: string, number: number, flag: SdlcFlag): void {
  const label = `sdlc:flag:${flag}`;
  try {
    execSync(`gh api repos/${repo}/issues/${number}/labels/${encodeURIComponent(label)} -X DELETE`, {
      env: ghEnv(),
      stdio: 'pipe',
    });
    log.info('Flag removed', { repo, number, flag });
  } catch {
    // May not exist — that's fine
  }
}

/**
 * Remove a state label from an issue or PR (used for rollback on invalid transitions).
 */
export function removeStateLabel(repo: string, number: number, state: SdlcState): void {
  const label = `sdlc:${state}`;
  try {
    execSync(`gh api repos/${repo}/issues/${number}/labels/${encodeURIComponent(label)} -X DELETE`, {
      env: ghEnv(),
      stdio: 'pipe',
    });
  } catch {
    // May not exist
  }
}
