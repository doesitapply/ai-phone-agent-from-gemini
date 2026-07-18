import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';

export const AUTHORITATIVE_PRODUCTION_APP_URL = 'https://ai-phone-agent-production-6811.up.railway.app';
export const AUTHORITATIVE_PRODUCTION_ORIGINS = Object.freeze([
  AUTHORITATIVE_PRODUCTION_APP_URL,
  'https://smirkcalls.com',
  'https://www.smirkcalls.com',
]);

function runGitRaw(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runGit(args, { allowFailure = false } = {}) {
  try {
    return runGitRaw(args).trim();
  } catch (error) {
    if (allowFailure) return '';
    throw error;
  }
}

function isDeployRelevant(file) {
  // Git already applies .gitignore to untracked files. Every path it reports
  // can affect the exact commit or Railway upload and belongs in the review.
  return Boolean(file);
}

function parsePorcelainStatus(raw) {
  const parts = raw.split('\0');
  const entries = [];
  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];
    if (!record) continue;
    if (record.length < 4 || record[2] !== ' ') {
      throw new Error(`Unexpected git status porcelain record: ${JSON.stringify(record)}`);
    }
    const status = record.slice(0, 2);
    const file = record.slice(3);
    const normalizedStatus = status.trim() || 'M';
    entries.push({ status: normalizedStatus, file, changeRole: 'path', relatedPath: null });
    if (status.includes('R') || status.includes('C')) {
      // Porcelain -z emits the destination in the record and the original path
      // as the following NUL-delimited field. Consume the original path so it
      // is never misparsed as a standalone status record.
      index += 1;
      if (index >= parts.length || !parts[index]) {
        throw new Error(`Git status rename/copy record is missing its source path for ${JSON.stringify(file)}`);
      }
      const source = parts[index];
      const kind = status.includes('R') ? 'rename' : 'copy';
      entries[entries.length - 1] = {
        status: `${normalizedStatus}-${kind}-to`,
        file,
        changeRole: `${kind}-destination`,
        relatedPath: source,
      };
      entries.push({
        status: `${normalizedStatus}-${kind}-from`,
        file: source,
        changeRole: `${kind}-source`,
        relatedPath: file,
      });
    }
  }
  return entries;
}

function parseNameStatus(raw) {
  const parts = raw.split('\0');
  const entries = [];
  for (let index = 0; index < parts.length;) {
    const status = parts[index++];
    if (!status) continue;
    const kind = status[0];
    if (kind === 'R' || kind === 'C') {
      const source = parts[index++];
      const destination = parts[index++];
      if (!source || !destination) {
        throw new Error(`Git diff ${status} record is missing a source or destination path.`);
      }
      const label = kind === 'R' ? 'rename' : 'copy';
      entries.push({
        status: `${status}-${label}-from`,
        file: source,
        changeRole: `${label}-source`,
        relatedPath: destination,
      });
      entries.push({
        status: `${status}-${label}-to`,
        file: destination,
        changeRole: `${label}-destination`,
        relatedPath: source,
      });
      continue;
    }
    const file = parts[index++];
    if (!file) throw new Error(`Git diff ${status} record is missing its path.`);
    entries.push({ status, file, changeRole: 'path', relatedPath: null });
  }
  return entries;
}

function isDeployVisibleIgnoreOverride(file) {
  const normalized = file.toLowerCase();
  return normalized === '.ignore' || normalized.endsWith('/.ignore');
}

function isGitIgnoredPath(file) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', file], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function assertTrustedGitContext() {
  const forbiddenExact = new Set([
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_REPLACE_REF_BASE',
    'GIT_CONFIG',
    'GIT_CONFIG_SYSTEM',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_NOSYSTEM',
    'GIT_CONFIG_PARAMETERS',
    'GIT_CONFIG_COUNT',
    'GIT_NAMESPACE',
    'GIT_SHALLOW_FILE',
    'GIT_GRAFT_FILE',
    'GIT_QUARANTINE_PATH',
  ]);
  const injected = Object.keys(process.env).find((name) => (
    forbiddenExact.has(name)
    || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)
  ));
  if (injected) {
    throw new Error(`Deploy archive safety rejects ambient Git context override ${injected}; validation must use the repository rooted at the upload working directory.`);
  }

  const cwd = realpathSync(process.cwd());
  const topLevel = realpathSync(runGit(['rev-parse', '--show-toplevel']));
  if (cwd !== topLevel) {
    throw new Error(`Deploy archive safety requires cwd ${JSON.stringify(cwd)} to equal the Git top-level ${JSON.stringify(topLevel)} exactly.`);
  }
}

function equivalentFilesystemSegment(actual, expected) {
  const normalizedActual = actual.normalize('NFC');
  const normalizedExpected = expected.normalize('NFC');
  return normalizedActual === normalizedExpected
    || normalizedActual.toLowerCase() === normalizedExpected.toLowerCase();
}

function assertTrackedPathUsesExactFilesystemSegments(file) {
  const segments = file.split('/');
  let directory = '.';

  for (const expectedSegment of segments) {
    const filesystemSegments = readdirSync(directory);
    if (!filesystemSegments.includes(expectedSegment)) {
      const mismatchedSegment = filesystemSegments.find((candidate) => (
        equivalentFilesystemSegment(candidate, expectedSegment)
      ));
      if (mismatchedSegment) {
        throw new Error(
          `Deploy archive safety rejects tracked index path ${JSON.stringify(file)} because its exact filesystem segment ${JSON.stringify(mismatchedSegment)} does not match indexed segment ${JSON.stringify(expectedSegment)} (case or Unicode normalization mismatch).`,
        );
      }
      // A genuinely absent tracked path is a normal deletion and remains
      // review-visible through Git status. Only an equivalent-but-non-exact
      // filesystem spelling can hide a case-only or Unicode-only rename.
      return;
    }
    directory = directory === '.' ? expectedSegment : `${directory}/${expectedSegment}`;
  }
}

function assertNoHiddenTrackedIndexFlags() {
  const records = runGitRaw(['ls-files', '-v', '-z']).split('\0').filter(Boolean);
  for (const record of records) {
    if (record.length < 3 || record[1] !== ' ') {
      throw new Error(`Unexpected git ls-files -v record while checking deploy archive safety: ${JSON.stringify(record)}`);
    }
    const tag = record[0];
    const file = record.slice(2);
    if (tag.toUpperCase() === 'S') {
      throw new Error(`Deploy archive safety rejects tracked path ${JSON.stringify(file)} because its skip-worktree index flag can hide uploaded bytes from Git status.`);
    }
    if (/[a-z]/.test(tag)) {
      throw new Error(`Deploy archive safety rejects tracked path ${JSON.stringify(file)} because its assume-unchanged index flag can hide uploaded bytes from Git status.`);
    }
  }
}

function assertNoRailwayBuiltinExcludedPath(file) {
  const excludedComponent = file
    .split('/')
    .find((component) => ['.git', 'node_modules'].includes(component.toLowerCase()));
  if (excludedComponent) {
    throw new Error(
      `Deploy archive safety rejects tracked path ${JSON.stringify(file)} because Railway always excludes the ${JSON.stringify(excludedComponent)} path component from uploads.`,
    );
  }
}

function assertNoFilesystemGitignoreSymlinks(directory = '.', relativeDirectory = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const normalizedName = entry.name.toLowerCase();
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (normalizedName === '.gitignore' && entry.isSymbolicLink()) {
      throw new Error(`Deploy archive safety rejects filesystem .gitignore symlink ${JSON.stringify(relativePath)} because Git and the Railway ignore walker can resolve it differently.`);
    }
    if (normalizedName === '.git' || normalizedName === 'node_modules') continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    assertNoFilesystemGitignoreSymlinks(`${directory}/${entry.name}`, relativePath);
  }
}

function assertNoFilesystemIgnoreOverrides(directory = '.', relativeDirectory = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const absolutePath = `${directory}/${entry.name}`;
    const normalizedName = entry.name.toLowerCase();
    if (normalizedName === '.git' || normalizedName === 'node_modules') {
      if (entry.name !== normalizedName) {
        throw new Error(`Deploy archive safety rejects deploy-visible Railway built-in path alias ${JSON.stringify(relativePath)}; uploader exclusions require exact path-component spelling.`);
      }
      // The root Git metadata and exact node_modules components are hard
      // excluded by Railway. Indexed paths using either component are checked
      // independently below.
      continue;
    }
    if (normalizedName === '.gitignore' && entry.isSymbolicLink()) {
      throw new Error(`Deploy archive safety rejects filesystem .gitignore symlink ${JSON.stringify(relativePath)} because Git and the Railway ignore walker can resolve it differently.`);
    }
    if (normalizedName === '.ignore') {
      throw new Error(`Deploy archive safety rejects deploy-visible .ignore file ${JSON.stringify(relativePath)} because it can re-include Git-ignored files.`);
    }
    if (normalizedName === '.railwayignore') {
      assertRailwayIgnoreSafety(relativePath);
      continue;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    // The uploader cannot descend through a parent directory that Git ignores.
    // Skip those large/non-deployable trees, but inspect every unignored parent
    // so a .ignore file hidden from Git status cannot change archive contents.
    if (isGitIgnoredPath(relativePath)) continue;
    assertNoFilesystemIgnoreOverrides(absolutePath, relativePath);
  }
}

function assertRailwayIgnoreSafety(file = '.railwayignore') {
  if (!existsSync(file)) return;
  const stat = lstatSync(file);
  if (stat.isSymbolicLink()) {
    throw new Error('Deploy archive safety rejects filesystem symlink ".railwayignore".');
  }
  if (!stat.isFile()) {
    throw new Error('Deploy archive safety requires .railwayignore to be a regular file.');
  }
  if (file.includes('/')) {
    throw new Error(`Deploy archive safety rejects nested .railwayignore file ${JSON.stringify(file)} because per-directory uploader exclusions cannot be proven against the reviewed path set.`);
  }
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const rule = lines[index].trimStart();
    if (!rule || rule.startsWith('#')) continue;
    if (rule.startsWith('!')) {
      throw new Error(`Deploy archive safety rejects negating .railwayignore rule on line ${index + 1} because it can re-include Git-ignored files.`);
    }
  }

  const excludedTracked = runGitRaw(['ls-files', '-c', '-i', '-z', `--exclude-from=${file}`])
    .split('\0')
    .filter(Boolean);
  if (excludedTracked.length > 0) {
    throw new Error(`Deploy archive safety rejects .railwayignore because it would omit tracked reviewed path ${JSON.stringify(excludedTracked[0])}.`);
  }

  const reviewedUntracked = new Set(
    runGitRaw(['ls-files', '-o', '--exclude-standard', '-z']).split('\0').filter(Boolean),
  );
  const excludedUntracked = runGitRaw(['ls-files', '-o', '-i', '-z', `--exclude-from=${file}`])
    .split('\0')
    .filter((path) => path && reviewedUntracked.has(path));
  if (excludedUntracked.length > 0) {
    throw new Error(`Deploy archive safety rejects .railwayignore because it would omit untracked reviewed path ${JSON.stringify(excludedUntracked[0])}.`);
  }
}

export function assertDeployArchiveSafety() {
  assertTrustedGitContext();
  if (!readdirSync('.').includes('.git')) {
    throw new Error('Deploy archive safety requires the repository metadata entry to be spelled exactly ".git".');
  }
  // A .ignore can be loaded by the upload walker even when the control file
  // itself is hidden from Git status. Inspect every unignored directory.
  assertNoFilesystemGitignoreSymlinks();
  assertNoFilesystemIgnoreOverrides();
  assertNoHiddenTrackedIndexFlags();

  const indexRecords = runGitRaw(['ls-files', '--stage', '-z']).split('\0').filter(Boolean);
  for (const record of indexRecords) {
    const match = /^(\d{6}) [0-9a-f]+ \d\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error(`Unexpected git index record while checking deploy archive safety: ${JSON.stringify(record)}`);
    const [, mode, file] = match;
    if (mode === '120000') {
      throw new Error(`Deploy archive safety rejects tracked symlink ${JSON.stringify(file)} because uploader link targets are not commit-pinned.`);
    }
    if (mode === '160000') {
      throw new Error(`Deploy archive safety rejects Git link/submodule ${JSON.stringify(file)} because nested source is not covered by this commit review.`);
    }
    if (isDeployVisibleIgnoreOverride(file)) {
      throw new Error(`Deploy archive safety rejects deploy-visible .ignore file ${JSON.stringify(file)} because it can re-include Git-ignored files.`);
    }
    assertNoRailwayBuiltinExcludedPath(file);
    assertTrackedPathUsesExactFilesystemSegments(file);
  }

  const standardIgnoredTracked = runGitRaw(['ls-files', '-c', '-i', '-z', '--exclude-standard'])
    .split('\0')
    .filter(Boolean);
  if (standardIgnoredTracked.length > 0) {
    throw new Error(`Deploy archive safety rejects tracked path ${JSON.stringify(standardIgnoredTracked[0])} because standard Git ignore rules would omit reviewed code from the Railway archive.`);
  }

  const statusEntries = parsePorcelainStatus(
    runGitRaw(['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  );
  for (const { file } of statusEntries) {
    if (isDeployVisibleIgnoreOverride(file)) {
      throw new Error(`Deploy archive safety rejects deploy-visible .ignore file ${JSON.stringify(file)} because it can re-include Git-ignored files.`);
    }
    if (!existsSync(file)) continue;
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) {
      throw new Error(`Deploy archive safety rejects filesystem symlink ${JSON.stringify(file)}.`);
    }
    if (stat.isDirectory()) {
      throw new Error(`Deploy archive safety rejects collapsed untracked directory ${JSON.stringify(file)}; nested repositories must not bypass file review.`);
    }
  }

}

export function resolveDeployReviewBase(explicitRef = process.env.SMIRK_DEPLOY_REVIEW_BASE_REF || '') {
  if (explicitRef) {
    const commit = runGit(['rev-parse', '--verify', `${explicitRef}^{commit}`], { allowFailure: true });
    if (!commit) throw new Error(`Explicit deploy review baseline did not resolve to a commit: ${explicitRef}`);
    return { ref: explicitRef, source: 'live-fingerprint', commit };
  }

  const candidates = [];

  const upstream = runGit(
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
    { allowFailure: true },
  );
  if (upstream) candidates.push({ ref: upstream, source: 'branch-upstream' });
  candidates.push({ ref: 'origin/main', source: 'origin-main-fallback' });

  for (const candidate of candidates) {
    const commit = runGit(['rev-parse', '--verify', `${candidate.ref}^{commit}`], { allowFailure: true });
    if (commit) return { ...candidate, commit };
  }

  return { ref: null, source: 'unavailable', commit: null };
}

export function resolveAuthoritativeLiveDeployReviewBase() {
  let liveCheck = null;
  try {
    const out = execFileSync('npm', ['run', '-s', 'check:live-is-current'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        APP_URL: '',
        SMIRK_DEPLOY_FINGERPRINT_APP_URL: AUTHORITATIVE_PRODUCTION_APP_URL,
      },
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    liveCheck = out ? JSON.parse(out) : null;
  } catch (error) {
    for (const candidate of [error?.stdout, error?.stderr]) {
      const out = String(candidate || '').trim();
      if (!out) continue;
      try {
        liveCheck = JSON.parse(out);
        break;
      } catch {
        // Continue to the other captured stream.
      }
    }
  }
  const ref = extractAuthoritativeLiveFingerprint(liveCheck);
  const commit = runGit(['rev-parse', '--verify', `${ref}^{commit}`], { allowFailure: true });
  if (!commit || commit !== ref) {
    throw new Error(`Live deployment fingerprint ${ref} is not the exact locally reviewable commit.`);
  }
  return { ref, commit, source: 'live-fingerprint', liveCheck };
}

export function assertAuthoritativeProductionLiveOrigin(liveCheck) {
  const rawUrl = liveCheck?.detail?.url
    || liveCheck?.url
    || liveCheck?.appUrl
    || null;
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ''));
  } catch {
    throw new Error('Authoritative live deployment fingerprint is missing a valid production health URL.');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/health'
    || parsed.search
    || parsed.hash
    || !AUTHORITATIVE_PRODUCTION_ORIGINS.includes(parsed.origin)
  ) {
    throw new Error(`Authoritative live deployment fingerprint must come from an allowlisted production HTTPS /health origin, not ${JSON.stringify(rawUrl)}.`);
  }
  return parsed.origin;
}

export function extractAuthoritativeLiveFingerprint(liveCheck) {
  const isSuccessfulStatus = (value) => Number.isInteger(Number(value))
    && Number(value) >= 200
    && Number(value) < 300;
  const isCommit = (value) => /^[0-9a-f]{40}$/i.test(String(value || ''));

  assertAuthoritativeProductionLiveOrigin(liveCheck);

  if (
    liveCheck?.ok === true
    && isSuccessfulStatus(liveCheck.status)
    && liveCheck.readinessHeader === '1'
    && isCommit(liveCheck.version)
    && (!liveCheck.versionHeader || liveCheck.versionHeader === liveCheck.version)
  ) {
    return liveCheck.version;
  }

  const detail = liveCheck?.detail;
  if (
    liveCheck?.ok === false
    && liveCheck?.blocker === 'stale-production-deploy'
    && detail?.ok === false
    && ['version-mismatch', 'branch-mismatch'].includes(detail?.failure)
    && isSuccessfulStatus(detail?.status)
    && detail?.readinessHeader === '1'
    && isCommit(detail?.actualVersion)
    && liveCheck?.actualVersion === detail.actualVersion
  ) {
    return detail.actualVersion;
  }

  throw new Error('Could not independently resolve a healthy, validated live deployment fingerprint.');
}

export function resolveApprovalDeployReviewBase() {
  const explicitRef = String(process.env.SMIRK_DEPLOY_REVIEW_BASE_REF || '').trim();
  if (!explicitRef) return resolveAuthoritativeLiveDeployReviewBase();
  if (!/^[0-9a-f]{40}$/i.test(explicitRef)) {
    throw new Error('Explicit deploy review baseline must be an exact 40-character commit fingerprint.');
  }
  const base = resolveDeployReviewBase(explicitRef);
  if (base.commit !== explicitRef) {
    throw new Error(`Explicit deploy review baseline ${explicitRef} did not resolve exactly.`);
  }
  const liveCheckJson = String(process.env.SMIRK_DEPLOY_LIVE_CHECK_JSON || '').trim();
  if (!liveCheckJson) {
    throw new Error('An explicit deploy review baseline requires the matching captured live-check payload.');
  }
  const liveCheck = JSON.parse(liveCheckJson);
  const capturedRef = extractAuthoritativeLiveFingerprint(liveCheck);
  if (capturedRef !== explicitRef) {
    throw new Error(`Captured live-check fingerprint ${capturedRef || 'missing'} does not match explicit review baseline ${explicitRef}.`);
  }
  return { ...base, liveCheck };
}

export function collectDeployChangeSet({ baseRef } = {}) {
  const base = resolveDeployReviewBase(baseRef);
  if (!base.ref || !base.commit) {
    throw new Error('Unable to resolve a deploy review baseline commit.');
  }
  assertDeployArchiveSafety();
  const dirtyEntries = parsePorcelainStatus(runGitRaw(['status', '--porcelain=v1', '-z', '--untracked-files=all']))
    .filter(({ file }) => isDeployRelevant(file));

  const committedEntries = parseNameStatus(
    runGitRaw(['diff', '--name-status', '-z', '-M', '-C', `${base.ref}..HEAD`]),
  ).filter(({ file }) => isDeployRelevant(file));
  const committedFiles = committedEntries.map(({ file }) => file);

  const dirtyByFile = new Map(dirtyEntries.map((entry) => [entry.file, entry]));
  const committedByFile = new Map(committedEntries.map((entry) => [entry.file, entry]));
  const files = [...new Set([...committedFiles, ...dirtyEntries.map((entry) => entry.file)])].sort();

  return {
    baseRef: base.ref,
    baseCommit: base.commit,
    baseSource: base.source,
    files,
    committedFiles: [...new Set(committedFiles)].sort(),
    dirtyFiles: [...dirtyByFile.keys()].sort(),
    entries: files.map((file) => ({
      file,
      status: dirtyByFile.get(file)?.status || committedByFile.get(file)?.status || 'committed',
      committed: committedFiles.includes(file),
      dirty: dirtyByFile.has(file),
      committedChangeRole: committedByFile.get(file)?.changeRole || null,
      committedRelatedPath: committedByFile.get(file)?.relatedPath || null,
      dirtyChangeRole: dirtyByFile.get(file)?.changeRole || null,
      dirtyRelatedPath: dirtyByFile.get(file)?.relatedPath || null,
    })),
  };
}

export function diffNumstatFromBase(file, baseRef) {
  const raw = baseRef
    ? runGitRaw(['diff', '--numstat', '-z', baseRef, '--', file])
    : runGitRaw(['diff', '--numstat', '-z', '--', file]);
  if (!raw && existsSync(file) && statSync(file).isFile()) {
    const text = readFileSync(file, 'utf8');
    return { added: text.split(/\r?\n/).length, removed: 0 };
  }
  const record = raw.split('\0').find(Boolean) || '';
  const [added, removed] = record.split('\t', 2);
  return {
    added: Number.isFinite(Number(added)) ? Number(added) : null,
    removed: Number.isFinite(Number(removed)) ? Number(removed) : null,
  };
}

export function diffExcerptFromBase(file, baseRef) {
  const args = baseRef
    ? ['diff', '--unified=1', baseRef, '--', file]
    : ['diff', '--unified=1', '--', file];
  const diff = runGit(args);
  if (diff) return diff;
  const tracked = runGit(['ls-files', '--error-unmatch', '--', file], { allowFailure: true });
  if (tracked) return '';
  if (existsSync(file) && statSync(file).isFile()) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).slice(0, 80);
    return [`--- untracked file: ${file}`, ...lines.map((line) => `+${line}`)].join('\n');
  }
  return '';
}
