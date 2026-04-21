import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { SDLC_REPOS_BASE } from './config.js';

const PLUGIN_CACHE_DIR = path.join(
  path.dirname(SDLC_REPOS_BASE),
  'plugin-cache',
);
const MARKETPLACES_DIR = path.join(PLUGIN_CACHE_DIR, 'marketplaces');
const PLUGINS_DIR = path.join(PLUGIN_CACHE_DIR, 'plugins');

export function getPluginsCacheDir(): string {
  return PLUGINS_DIR;
}

interface MarketplaceSource {
  source: string; // 'git' | 'github' | 'directory'
  url?: string;
  repo?: string;
  path?: string;
}

interface ProjectSettings {
  extraKnownMarketplaces?: Record<string, { source: MarketplaceSource }>;
  enabledPlugins?: Record<string, boolean>;
}

/**
 * Read a repo's .claude/settings.json and return parsed settings.
 */
function readProjectSettings(repo: string): ProjectSettings | null {
  const repoDir = path.join(SDLC_REPOS_BASE, repo);
  const settingsPath = path.join(repoDir, '.claude', 'settings.json');
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Resolve a marketplace source to a git clone URL.
 */
function marketplaceUrl(source: MarketplaceSource): string | null {
  if (source.source === 'git' && source.url) {
    return source.url;
  }
  if (source.source === 'github' && source.repo) {
    return `https://github.com/${source.repo}.git`;
  }
  return null;
}

/**
 * Clone or pull a marketplace into the cache. Returns the local path.
 */
function ensureMarketplace(
  name: string,
  source: MarketplaceSource,
): string | null {
  const url = marketplaceUrl(source);
  if (!url) {
    if (source.source === 'directory' && source.path) {
      return source.path; // Local path, no caching needed
    }
    logger.warn({ name, source }, 'Unsupported marketplace source');
    return null;
  }

  const dir = path.join(MARKETPLACES_DIR, name);
  fs.mkdirSync(MARKETPLACES_DIR, { recursive: true });

  const ghEnv = readEnvFile(['GITHUB_TOKEN']);
  const token = ghEnv.GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  const env = { ...process.env, ...(token ? { GITHUB_TOKEN: token } : {}) };

  // Inject token into HTTPS URLs for private repos
  let cloneUrl = url;
  if (token && url.startsWith('https://github.com/')) {
    cloneUrl = url.replace(
      'https://github.com/',
      `https://x-access-token:${token}@github.com/`,
    );
  }

  if (fs.existsSync(path.join(dir, '.git'))) {
    try {
      execSync('git pull --ff-only', { cwd: dir, stdio: 'pipe', env });
      logger.debug({ name }, 'Marketplace updated');
    } catch {
      logger.warn({ name }, 'Marketplace pull failed — using cached version');
    }
  } else {
    try {
      execSync(`git clone --depth 1 ${cloneUrl} ${dir}`, {
        stdio: 'pipe',
        env,
      });
      logger.info({ name, url }, 'Marketplace cloned');
    } catch (err) {
      logger.error({ name, url, err }, 'Failed to clone marketplace');
      return null;
    }
  }

  return dir;
}

/**
 * Find a plugin within a marketplace directory.
 * Marketplace layout: each plugin is a subdirectory with a plugin.json or package.json.
 */
function findPluginInMarketplace(
  marketplaceDir: string,
  pluginName: string,
): string | null {
  // Check direct subdirectory
  const pluginDir = path.join(marketplaceDir, pluginName);
  if (fs.existsSync(pluginDir) && fs.statSync(pluginDir).isDirectory()) {
    return pluginDir;
  }

  // Check plugins/ subdirectory
  const pluginsSubdir = path.join(marketplaceDir, 'plugins', pluginName);
  if (
    fs.existsSync(pluginsSubdir) &&
    fs.statSync(pluginsSubdir).isDirectory()
  ) {
    return pluginsSubdir;
  }

  return null;
}

/**
 * Sync plugins for a repo: clone/pull marketplaces, resolve enabled plugins,
 * and symlink them into the plugins cache dir.
 *
 * Returns array of plugin paths ready to mount.
 */
export function syncPluginsForRepo(repo: string): string[] {
  const settings = readProjectSettings(repo);
  if (!settings?.extraKnownMarketplaces || !settings?.enabledPlugins) {
    return [];
  }

  const pluginPaths: string[] = [];
  fs.mkdirSync(PLUGINS_DIR, { recursive: true });

  // Clone/update all marketplaces
  const marketplaceDirs: Record<string, string> = {};
  for (const [name, config] of Object.entries(
    settings.extraKnownMarketplaces,
  )) {
    const dir = ensureMarketplace(name, config.source);
    if (dir) marketplaceDirs[name] = dir;
  }

  // Resolve each enabled plugin
  for (const [pluginRef, enabled] of Object.entries(settings.enabledPlugins)) {
    if (!enabled) continue;

    // Parse "plugin-name@marketplace-name"
    const atIdx = pluginRef.lastIndexOf('@');
    if (atIdx === -1) {
      logger.warn(
        { pluginRef },
        'Invalid plugin reference — missing @marketplace',
      );
      continue;
    }

    const pluginName = pluginRef.slice(0, atIdx);
    const marketplaceName = pluginRef.slice(atIdx + 1);

    const marketplaceDir = marketplaceDirs[marketplaceName];
    if (!marketplaceDir) {
      logger.warn({ pluginRef, marketplaceName }, 'Marketplace not available');
      continue;
    }

    const pluginDir = findPluginInMarketplace(marketplaceDir, pluginName);
    if (!pluginDir) {
      logger.warn(
        { pluginRef, marketplaceDir },
        'Plugin not found in marketplace',
      );
      continue;
    }

    // Copy into plugins cache for mounting (Docker doesn't follow symlinks)
    const cacheCopy = path.join(PLUGINS_DIR, pluginName);
    try {
      if (fs.existsSync(cacheCopy)) fs.rmSync(cacheCopy, { recursive: true });
      fs.cpSync(pluginDir, cacheCopy, { recursive: true });
    } catch {
      // Fall back to using the direct path
    }

    pluginPaths.push(pluginDir);
    logger.info({ pluginRef, pluginDir }, 'Plugin resolved');
  }

  return pluginPaths;
}
