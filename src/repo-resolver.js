/**
 * Resolve a repo URL to a local checkout path.
 *
 * Pipeline: normalize URL → cache lookup (verify) → filesystem scan → cache result
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CONFIG_FILE = path.join(process.env.HOME, '.claude-fix', 'config.json');
const CACHE_FILE = path.join(process.env.HOME, '.claude-fix', 'repo-cache.json');

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', '.bare', '__pycache__',
  'vendor', '.venv', 'build', '.cache', '.next', '.turbo',
]);

// ---------------------------------------------------------------------------
// URL normalization
// ---------------------------------------------------------------------------

/**
 * Normalize any repo URL to "host/owner/repo" (lowercase, no protocol, no .git).
 *
 * Handles SSH, HTTPS, bare, and Azure SSH variants.
 */
function normalizeRepoUrl(url) {
  if (!url) return null;
  let u = url.trim();

  // Azure SSH: git@ssh.dev.azure.com:v3/org/project/repo
  const azureMatch = u.match(/^git@ssh\.dev\.azure\.com:v3\/(.+)/);
  if (azureMatch) {
    return ('dev.azure.com/' + azureMatch[1]).toLowerCase().replace(/\.git$/, '');
  }

  // SSH: git@host:owner/repo.git
  const sshMatch = u.match(/^git@([^:]+):(.+)/);
  if (sshMatch) {
    return (sshMatch[1] + '/' + sshMatch[2]).toLowerCase().replace(/\.git$/, '');
  }

  // HTTPS: https://host/owner/repo.git
  u = u.replace(/^https?:\/\//, '');

  // Strip trailing .git and slashes
  u = u.replace(/\.git$/, '').replace(/\/+$/, '');

  return u.toLowerCase();
}

/**
 * Extract the last path segment (repo name) from a normalized URL.
 */
function extractRepoName(normalizedUrl) {
  if (!normalizedUrl) return null;
  const parts = normalizedUrl.split('/');
  return parts[parts.length - 1];
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Run `git remote -v` in a directory and return deduplicated remote URLs.
 */
function getRepoRemotes(dirPath) {
  try {
    const out = execSync(`git -C '${dirPath}' remote -v`, {
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();

    const urls = new Set();
    for (const line of out.split('\n')) {
      const parts = line.split(/\s+/);
      if (parts[1]) urls.add(parts[1]);
    }
    return [...urls];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2) + '\n');
}

/**
 * Look up a normalized URL in the cache. Returns the path if still valid, else null.
 */
function cacheLookup(normalizedUrl) {
  const cache = loadCache();
  const entry = cache[normalizedUrl];
  if (!entry) return null;

  // Verify path still exists
  if (!fs.existsSync(entry.path)) {
    delete cache[normalizedUrl];
    saveCache(cache);
    console.log(`[repo-resolver] Cache stale (path gone): ${entry.path}`);
    return null;
  }

  // Verify remotes still match
  const remotes = getRepoRemotes(entry.path);
  const remoteNorms = remotes.map(normalizeRepoUrl);
  if (!remoteNorms.includes(normalizedUrl)) {
    delete cache[normalizedUrl];
    saveCache(cache);
    console.log(`[repo-resolver] Cache stale (remote mismatch): ${entry.path}`);
    return null;
  }

  // Update lastUsed
  entry.lastUsed = new Date().toISOString();
  saveCache(cache);
  console.log(`[repo-resolver] Cache hit: ${normalizedUrl} → ${entry.path}`);
  return entry.path;
}

function cacheStore(normalizedUrl, resolvedPath) {
  const cache = loadCache();
  cache[normalizedUrl] = {
    path: resolvedPath,
    lastUsed: new Date().toISOString(),
  };
  saveCache(cache);
}

// ---------------------------------------------------------------------------
// Filesystem scan
// ---------------------------------------------------------------------------

/**
 * Recursively scan directories for a repo whose remotes match the given URL.
 *
 * Only runs `git remote -v` when the directory name matches the repo name
 * (case-insensitive) AND contains a `.git` entry, keeping things fast.
 */
function scanForRepo(normalizedUrl, searchPaths, maxDepth) {
  const repoName = extractRepoName(normalizedUrl);
  if (!repoName) return null;

  for (const raw of searchPaths) {
    const base = raw.replace(/^~/, process.env.HOME);
    const result = walkDir(base, repoName, normalizedUrl, 0, maxDepth);
    if (result) return result;
  }

  return null;
}

function walkDir(dir, repoName, normalizedUrl, depth, maxDepth) {
  if (depth > maxDepth) return null;

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;

    const full = path.join(dir, entry.name);

    // Check if this directory matches the repo name
    if (entry.name.toLowerCase() === repoName) {
      // Must have .git dir or file (worktree has a .git file)
      const gitPath = path.join(full, '.git');
      if (fs.existsSync(gitPath)) {
        const remotes = getRepoRemotes(full);
        const remoteNorms = remotes.map(normalizeRepoUrl);
        if (remoteNorms.includes(normalizedUrl)) {
          return full;
        }
      }
    }

    // Recurse
    const result = walkDir(full, repoName, normalizedUrl, depth + 1, maxDepth);
    if (result) return result;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Resolve a repo URL (e.g. "github.com/DataDog/web-ui") to a local path.
 * Returns the absolute path or null if not found.
 */
function resolveRepo(repoUrl) {
  const normalized = normalizeRepoUrl(repoUrl);
  if (!normalized) {
    console.log('[repo-resolver] Invalid repo URL:', repoUrl);
    return null;
  }

  console.log(`[repo-resolver] Resolving: ${normalized}`);

  // 1. Cache lookup
  const cached = cacheLookup(normalized);
  if (cached) return cached;

  // 2. Filesystem scan
  const config = loadConfig();
  const searchPaths = config.GIT_SEARCH_PATHS || ['~/dd'];
  const maxDepth = config.GIT_SEARCH_MAX_DEPTH || 4;

  console.log(`[repo-resolver] Scanning ${searchPaths.join(', ')} (depth ${maxDepth})`);
  const found = scanForRepo(normalized, searchPaths, maxDepth);

  if (found) {
    console.log(`[repo-resolver] Found: ${found}`);
    cacheStore(normalized, found);
    return found;
  }

  console.log(`[repo-resolver] Not found: ${normalized}`);
  return null;
}

module.exports = {
  resolveRepo,
  normalizeRepoUrl,
  extractRepoName,
  getRepoRemotes,
  scanForRepo,
  cacheLookup,
  cacheStore,
  // Exposed for tests to override
  CACHE_FILE,
};
