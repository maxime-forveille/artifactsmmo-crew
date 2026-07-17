import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  createChangedMutationScopes,
  isLiteralMutationScope,
  mutationPathFromScope,
  parseChangedFiles,
} from './mutationScope.js';

const STRYKER_SETUP_PATTERN = /^stryker-setup-\d+\.js$/;

type SafetyBackup = Readonly<{ restore: () => void }>;

const removeStrykerSetupFiles = (): void => {
  for (const fileName of readdirSync(process.cwd())) {
    if (STRYKER_SETUP_PATTERN.test(fileName)) {
      rmSync(fileName, { force: true });
    }
  }
};

const readGitOutput = (args: readonly string[]): string => {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  }

  return result.stdout.trim();
};

const optionIndex = (
  args: readonly string[],
  names: readonly string[],
): number => args.findIndex((arg) => names.includes(arg));

const withoutOption = (
  args: readonly string[],
  index: number,
  hasValue: boolean,
): readonly string[] => [
  ...args.slice(0, index),
  ...args.slice(index + (hasValue ? 2 : 1)),
];

const lineCount = (path: string): number =>
  readFileSync(path, 'utf8').split('\n').length;

const changedMutationArgs = (args: readonly string[]): readonly string[] => {
  const changedIndex = args.indexOf('--changed');
  if (changedIndex === -1) {
    return args;
  }

  let remainingArgs = withoutOption(args, changedIndex, false);
  const mutateIndex = optionIndex(remainingArgs, ['--mutate', '-m']);
  const requestedScopes =
    mutateIndex === -1
      ? []
      : (remainingArgs[mutateIndex + 1]?.split(',').filter(Boolean) ?? []);
  if (mutateIndex !== -1) {
    remainingArgs = withoutOption(remainingArgs, mutateIndex, true);
  }

  const diff = readGitOutput([
    '--no-pager',
    'diff',
    '--no-ext-diff',
    '--unified=0',
    'HEAD',
    '--',
    'scripts',
    'src',
  ]);
  const untrackedPaths = readGitOutput([
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    'scripts',
    'src',
  ])
    .split('\n')
    .filter(Boolean);
  const paths = [
    ...parseChangedFiles(diff).map((file) => file.path),
    ...untrackedPaths,
    ...requestedScopes.map(mutationPathFromScope),
  ];
  const lineCountByPath = new Map(
    [...new Set(paths)]
      .filter((path) => existsSync(path))
      .map((path) => [path, lineCount(path)] as const),
  );
  const scopes = createChangedMutationScopes({
    diff,
    lineCountByPath,
    requestedScopes,
    untrackedPaths,
  });

  if (scopes.length === 0) {
    throw new Error(
      'No changed mutable TypeScript source found. Pass --mutate <source-file> when only tests changed.',
    );
  }

  console.info(
    `Mutation scope:\n${scopes.map((scope) => `  - ${scope}`).join('\n')}`,
  );

  const scopeHash = createHash('sha256')
    .update(scopes.join('\0'))
    .digest('hex')
    .slice(0, 16);
  const incrementalFile = `reports/mutation/incremental/${scopeHash}.json`;
  mkdirSync(dirname(incrementalFile), { recursive: true });

  const hasReporters = optionIndex(remainingArgs, ['--reporters']) !== -1;
  const hasIncrementalFile =
    optionIndex(remainingArgs, ['--incrementalFile']) !== -1;

  return [
    ...remainingArgs,
    '--mutate',
    scopes.join(','),
    ...(hasReporters ? [] : ['--reporters', 'clear-text']),
    ...(hasIncrementalFile ? [] : ['--incrementalFile', incrementalFile]),
  ];
};

const mutationScopes = (args: readonly string[]): readonly string[] => {
  const mutateIndex = optionIndex(args, ['--mutate', '-m']);
  return mutateIndex === -1
    ? []
    : (args[mutateIndex + 1]?.split(',').filter(Boolean) ?? []);
};

const createSafetyBackup = (scopes: readonly string[]): SafetyBackup => {
  const paths = [
    ...new Set(
      scopes
        .filter(isLiteralMutationScope)
        .map(mutationPathFromScope)
        .filter((path) => existsSync(path)),
    ),
  ];
  if (paths.length === 0) {
    return { restore: () => undefined };
  }

  const directory = mkdtempSync(join(tmpdir(), 'artifactsmmo-crew-stryker-'));
  const backups = paths.map((path, index) => {
    const backupPath = join(directory, String(index));
    copyFileSync(path, backupPath);
    return { backupPath, path };
  });

  return {
    restore: () => {
      for (const backup of backups) {
        copyFileSync(backup.backupPath, backup.path);
      }
      rmSync(directory, { force: true, recursive: true });
    },
  };
};

const runStryker = (args: readonly string[]): Promise<number> =>
  new Promise((resolve, reject) => {
    const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    const child = spawn(pnpmCommand, ['exec', 'stryker', 'run', ...args], {
      stdio: 'inherit',
    });

    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });

const main = async (): Promise<void> => {
  process.once('exit', removeStrykerSetupFiles);
  const args = changedMutationArgs(process.argv.slice(2));
  const backup = createSafetyBackup(mutationScopes(args));

  try {
    process.exitCode = await runStryker(args);
  } finally {
    backup.restore();
    removeStrykerSetupFiles();
    process.removeListener('exit', removeStrykerSetupFiles);
  }
};

void main().catch((error: unknown) => {
  removeStrykerSetupFiles();
  console.error(error);
  process.exitCode = 1;
});
