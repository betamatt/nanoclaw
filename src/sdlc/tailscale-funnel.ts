import { execSync, spawn, type ChildProcess } from 'child_process';

import { log } from '../log.js';
import { SDLC_WEBHOOK_PORT, TAILSCALE_SOCKET } from './config.js';

let funnelProc: ChildProcess | null = null;

/** Build the --socket flag if configured. */
function socketArgs(): string[] {
  return TAILSCALE_SOCKET ? ['--socket', TAILSCALE_SOCKET] : [];
}

/**
 * Start `tailscale funnel` to expose the webhook port publicly.
 * Returns the public HTTPS URL, or null if Tailscale is unavailable.
 */
export function startFunnel(): string | null {
  const sockArgs = socketArgs();

  // Check that tailscale is installed and logged in
  try {
    execSync(['tailscale', ...sockArgs, 'status', '--json'].join(' '), {
      stdio: 'pipe',
      timeout: 10000,
    });
  } catch {
    log.warn(
      'Tailscale not available — webhook will only be reachable locally. Install Tailscale and run `tailscale up` to enable Funnel.',
    );
    return null;
  }

  // Get the Tailscale hostname for this machine
  let hostname: string;
  try {
    const status = JSON.parse(
      execSync(['tailscale', ...sockArgs, 'status', '--json'].join(' '), {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      }),
    );
    const dnsSuffix = status.MagicDNSSuffix || status.CurrentTailnet?.MagicDNSSuffix;
    const selfName = status.Self?.DNSName?.replace(/\.$/, '');
    if (selfName) {
      hostname = selfName;
    } else if (status.Self?.HostName && dnsSuffix) {
      hostname = `${status.Self.HostName}.${dnsSuffix}`;
    } else {
      log.error('Could not determine Tailscale hostname from status');
      return null;
    }
  } catch (err) {
    log.error('Failed to get Tailscale status', { err });
    return null;
  }

  // `tailscale funnel --bg` runs in background, forwarding traffic to the local port
  try {
    funnelProc = spawn('tailscale', [...sockArgs, 'funnel', '--bg', `${SDLC_WEBHOOK_PORT}`], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    funnelProc.on('error', (err) => {
      log.error('Tailscale funnel process error', { err });
      funnelProc = null;
    });

    funnelProc.on('exit', (code) => {
      if (code !== 0) {
        log.warn('Tailscale funnel exited with non-zero code', { code });
      }
      funnelProc = null;
    });

    funnelProc.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) log.debug(msg, { source: 'tailscale-funnel' });
    });

    funnelProc.stdout?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) log.debug(msg, { source: 'tailscale-funnel' });
    });
  } catch (err) {
    log.error('Failed to start tailscale funnel', { err });
    return null;
  }

  const url = `https://${hostname}`;
  log.info('Tailscale Funnel started', { url, port: SDLC_WEBHOOK_PORT });
  return url;
}

/**
 * Stop the tailscale funnel.
 */
export function stopFunnel(): void {
  if (funnelProc) {
    funnelProc.kill();
    funnelProc = null;
  }

  // Also turn off funnel via CLI in case --bg detached it
  try {
    const sockArgs = socketArgs();
    execSync(['tailscale', ...sockArgs, 'funnel', '--bg', 'off', `${SDLC_WEBHOOK_PORT}`].join(' '), {
      stdio: 'pipe',
      timeout: 10000,
    });
  } catch {
    // ignore — may already be off
  }
}
