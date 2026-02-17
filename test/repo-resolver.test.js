const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const {
  normalizeRepoUrl,
  extractRepoName,
  getRepoRemotes,
  scanForRepo,
  cacheLookup,
  cacheStore,
  CACHE_FILE,
} = require('../src/repo-resolver');

// ---------------------------------------------------------------------------
// Helpers — create throwaway git repos in a temp dir
// ---------------------------------------------------------------------------

let tmpRoot;

function mkTmpDir(name) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Create a bare-minimum git repo with a remote pointing at `remoteUrl`. */
function createFakeRepo(dirName, remoteUrl) {
  const dir = mkTmpDir(dirName);
  execSync('git init -q', { cwd: dir });
  execSync(`git remote add origin '${remoteUrl}'`, { cwd: dir });
  return dir;
}

// Back up / restore the real cache so tests don't clobber it
let cacheBackup = null;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-resolver-test-'));

  if (fs.existsSync(CACHE_FILE)) {
    cacheBackup = fs.readFileSync(CACHE_FILE, 'utf8');
  }
});

after(() => {
  // Restore cache
  if (cacheBackup !== null) {
    fs.writeFileSync(CACHE_FILE, cacheBackup);
  } else if (fs.existsSync(CACHE_FILE)) {
    fs.unlinkSync(CACHE_FILE);
  }

  // Clean up temp dir
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// normalizeRepoUrl
// ---------------------------------------------------------------------------

describe('normalizeRepoUrl', () => {
  it('normalizes SSH URLs', () => {
    assert.equal(
      normalizeRepoUrl('git@github.com:DataDog/web-ui.git'),
      'github.com/datadog/web-ui',
    );
  });

  it('normalizes HTTPS URLs', () => {
    assert.equal(
      normalizeRepoUrl('https://github.com/DataDog/web-ui.git'),
      'github.com/datadog/web-ui',
    );
  });

  it('normalizes HTTP URLs', () => {
    assert.equal(
      normalizeRepoUrl('http://github.com/DataDog/web-ui.git'),
      'github.com/datadog/web-ui',
    );
  });

  it('normalizes bare host/owner/repo', () => {
    assert.equal(
      normalizeRepoUrl('github.com/DataDog/web-ui'),
      'github.com/datadog/web-ui',
    );
  });

  it('normalizes Azure SSH', () => {
    assert.equal(
      normalizeRepoUrl('git@ssh.dev.azure.com:v3/org/project/repo'),
      'dev.azure.com/org/project/repo',
    );
  });

  it('strips trailing .git', () => {
    assert.equal(
      normalizeRepoUrl('github.com/Foo/Bar.git'),
      'github.com/foo/bar',
    );
  });

  it('strips trailing slashes', () => {
    assert.equal(
      normalizeRepoUrl('github.com/Foo/Bar///'),
      'github.com/foo/bar',
    );
  });

  it('lowercases everything', () => {
    assert.equal(
      normalizeRepoUrl('GITHUB.COM/DataDog/Web-UI'),
      'github.com/datadog/web-ui',
    );
  });

  it('trims whitespace', () => {
    assert.equal(
      normalizeRepoUrl('  github.com/a/b  '),
      'github.com/a/b',
    );
  });

  it('returns null for falsy input', () => {
    assert.equal(normalizeRepoUrl(null), null);
    assert.equal(normalizeRepoUrl(undefined), null);
    assert.equal(normalizeRepoUrl(''), null);
  });
});

// ---------------------------------------------------------------------------
// extractRepoName
// ---------------------------------------------------------------------------

describe('extractRepoName', () => {
  it('extracts last path segment', () => {
    assert.equal(extractRepoName('github.com/datadog/web-ui'), 'web-ui');
  });

  it('handles deep paths', () => {
    assert.equal(extractRepoName('dev.azure.com/org/project/repo'), 'repo');
  });

  it('returns null for null input', () => {
    assert.equal(extractRepoName(null), null);
  });
});

// ---------------------------------------------------------------------------
// getRepoRemotes
// ---------------------------------------------------------------------------

describe('getRepoRemotes', () => {
  it('returns remote URLs from a git repo', () => {
    const dir = createFakeRepo('remotes-test', 'git@github.com:Test/repo.git');
    const remotes = getRepoRemotes(dir);
    assert.ok(remotes.includes('git@github.com:Test/repo.git'));
  });

  it('returns empty array for non-git directory', () => {
    const dir = mkTmpDir('not-a-repo');
    assert.deepEqual(getRepoRemotes(dir), []);
  });

  it('returns empty array for nonexistent path', () => {
    assert.deepEqual(getRepoRemotes('/tmp/does-not-exist-xyz'), []);
  });

  it('deduplicates fetch and push URLs', () => {
    const dir = createFakeRepo('dedup-test', 'git@github.com:Test/dedup.git');
    // git remote -v shows fetch + push, both same URL — should deduplicate
    const remotes = getRepoRemotes(dir);
    assert.equal(remotes.length, 1);
  });
});

// ---------------------------------------------------------------------------
// scanForRepo
// ---------------------------------------------------------------------------

describe('scanForRepo', () => {
  it('finds a repo by name + remote match', () => {
    const remoteUrl = 'git@github.com:ScanOrg/my-service.git';
    const scanBase = mkTmpDir('scan-base');
    const repoDir = path.join(scanBase, 'my-service');
    fs.mkdirSync(repoDir);
    execSync('git init -q', { cwd: repoDir });
    execSync(`git remote add origin '${remoteUrl}'`, { cwd: repoDir });

    const result = scanForRepo('github.com/scanorg/my-service', [scanBase], 2);
    assert.equal(result, repoDir);
  });

  it('returns null when repo name matches but remote does not', () => {
    const scanBase = mkTmpDir('scan-wrong-remote');
    const repoDir = path.join(scanBase, 'my-service');
    fs.mkdirSync(repoDir);
    execSync('git init -q', { cwd: repoDir });
    execSync("git remote add origin 'git@github.com:Other/other.git'", { cwd: repoDir });

    const result = scanForRepo('github.com/scanorg/my-service', [scanBase], 2);
    assert.equal(result, null);
  });

  it('returns null when directory has no .git', () => {
    const scanBase = mkTmpDir('scan-no-git');
    fs.mkdirSync(path.join(scanBase, 'my-service'));

    const result = scanForRepo('github.com/scanorg/my-service', [scanBase], 2);
    assert.equal(result, null);
  });

  it('respects maxDepth', () => {
    const scanBase = mkTmpDir('scan-depth');
    // Repo nested 3 levels deep: scanBase/a/b/my-repo
    const deep = path.join(scanBase, 'a', 'b', 'my-repo');
    fs.mkdirSync(deep, { recursive: true });
    execSync('git init -q', { cwd: deep });
    execSync("git remote add origin 'git@github.com:Org/my-repo.git'", { cwd: deep });

    // maxDepth=1 should miss it (can enter a at depth 1, but b at depth 2 > 1)
    assert.equal(scanForRepo('github.com/org/my-repo', [scanBase], 1), null);
    // maxDepth=2 should find it (enters a at depth 1, b at depth 2, finds my-repo there)
    assert.equal(scanForRepo('github.com/org/my-repo', [scanBase], 2), deep);
  });

  it('skips node_modules and other ignored dirs', () => {
    const scanBase = mkTmpDir('scan-skip');
    const hidden = path.join(scanBase, 'node_modules', 'my-lib');
    fs.mkdirSync(hidden, { recursive: true });
    execSync('git init -q', { cwd: hidden });
    execSync("git remote add origin 'git@github.com:Org/my-lib.git'", { cwd: hidden });

    assert.equal(scanForRepo('github.com/org/my-lib', [scanBase], 4), null);
  });

  it('is case-insensitive on directory name', () => {
    const scanBase = mkTmpDir('scan-case');
    const repoDir = path.join(scanBase, 'Web-UI');
    fs.mkdirSync(repoDir);
    execSync('git init -q', { cwd: repoDir });
    execSync("git remote add origin 'git@github.com:DataDog/web-ui.git'", { cwd: repoDir });

    // normalizedUrl has lowercase "web-ui", dir name is "Web-UI"
    const result = scanForRepo('github.com/datadog/web-ui', [scanBase], 2);
    assert.equal(result, repoDir);
  });

  it('returns null for nonexistent search path', () => {
    assert.equal(scanForRepo('github.com/a/b', ['/tmp/no-such-dir-xyz'], 2), null);
  });
});

// ---------------------------------------------------------------------------
// cacheStore + cacheLookup
// ---------------------------------------------------------------------------

describe('cache', () => {
  beforeEach(() => {
    // Start each test with a clean cache
    if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
  });

  it('stores and retrieves a cached path', () => {
    // Need a real git repo for the remote verification in cacheLookup
    const dir = createFakeRepo('cache-hit', 'git@github.com:CacheOrg/cache-repo.git');
    const norm = 'github.com/cacheorg/cache-repo';

    cacheStore(norm, dir);
    const result = cacheLookup(norm);
    assert.equal(result, dir);
  });

  it('returns null for uncached URL', () => {
    assert.equal(cacheLookup('github.com/nope/nope'), null);
  });

  it('evicts entry when path no longer exists', () => {
    const norm = 'github.com/gone/gone';
    cacheStore(norm, '/tmp/definitely-does-not-exist-xyz');

    const result = cacheLookup(norm);
    assert.equal(result, null);

    // Entry should be removed from cache file
    const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    assert.equal(cache[norm], undefined);
  });

  it('evicts entry when remotes no longer match', () => {
    // Create repo with a DIFFERENT remote than what we cache
    const dir = createFakeRepo('cache-mismatch', 'git@github.com:Other/other.git');
    const norm = 'github.com/original/original';

    cacheStore(norm, dir);
    const result = cacheLookup(norm);
    assert.equal(result, null);
  });
});
