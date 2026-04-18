import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from '../config.js';
import { readEnvFile } from '../env.js';

const sdlcEnv = readEnvFile([
  'SDLC_ENABLED',
  'SDLC_WEBHOOK_PORT',
  'SDLC_WEBHOOK_URL',
  'GITHUB_WEBHOOK_SECRET',
  'SDLC_REPOS',
  'SDLC_MAX_HEAVY_CONTAINERS',
  'TAILSCALE_SOCKET',
]);

export const SDLC_ENABLED =
  (process.env.SDLC_ENABLED || sdlcEnv.SDLC_ENABLED) === 'true';
export const SDLC_WEBHOOK_PORT = parseInt(
  process.env.SDLC_WEBHOOK_PORT || sdlcEnv.SDLC_WEBHOOK_PORT || '3456',
  10,
);
export const GITHUB_WEBHOOK_SECRET =
  process.env.GITHUB_WEBHOOK_SECRET || sdlcEnv.GITHUB_WEBHOOK_SECRET || '';
export const SDLC_REPOS = (process.env.SDLC_REPOS || sdlcEnv.SDLC_REPOS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
export const SDLC_WEBHOOK_URL =
  process.env.SDLC_WEBHOOK_URL || sdlcEnv.SDLC_WEBHOOK_URL || '';
export const TAILSCALE_SOCKET =
  process.env.TAILSCALE_SOCKET || sdlcEnv.TAILSCALE_SOCKET || '';
export const SDLC_REPOS_BASE = path.join(DATA_DIR, 'sdlc-repos');
export const MAX_SDLC_RETRIES = 2;
export const SDLC_MAX_HEAVY_CONTAINERS = Math.max(
  1,
  parseInt(
    process.env.SDLC_MAX_HEAVY_CONTAINERS ||
      sdlcEnv.SDLC_MAX_HEAVY_CONTAINERS ||
      String(MAX_CONCURRENT_CONTAINERS - 1),
    10,
  ) || MAX_CONCURRENT_CONTAINERS - 1,
);
