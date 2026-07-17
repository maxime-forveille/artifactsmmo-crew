type ChangedFile = Readonly<{
  hunks: readonly MutationRange[];
  isNew: boolean;
  path: string;
}>;

type MutableChangedFile = {
  hunks: MutationRange[];
  isNew: boolean;
  path: string;
};

type MutationRange = Readonly<{ end: number; start: number }>;

type ChangedMutationScopeInput = Readonly<{
  contextLines?: number;
  diff: string;
  lineCountByPath: ReadonlyMap<string, number>;
  requestedScopes?: readonly string[];
  untrackedPaths: readonly string[];
}>;

const HUNK_PATTERN = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const MUTATION_RANGE_PATTERN = /:\d+(?::\d+)?-\d+(?::\d+)?$/;
const MUTATION_GLOB_PATTERN = /[*?[\]{}()!@+]/;

export const mutationPathFromScope = (scope: string): string =>
  scope.replace(MUTATION_RANGE_PATTERN, '');

export const isLiteralMutationScope = (scope: string): boolean =>
  !MUTATION_GLOB_PATTERN.test(mutationPathFromScope(scope));

const isMutableSource = (path: string): boolean =>
  (path.startsWith('src/') || path.startsWith('scripts/')) &&
  path.endsWith('.ts') &&
  path !== 'scripts/runMutationTests.ts' &&
  path !== 'src/client/schema.d.ts' &&
  path !== 'src/index.ts';

export const parseChangedFiles = (diff: string): readonly ChangedFile[] => {
  const files: MutableChangedFile[] = [];
  let current: MutableChangedFile | undefined;
  let isNew = false;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = undefined;
      isNew = false;
      continue;
    }

    if (line.startsWith('new file mode ')) {
      isNew = true;
      continue;
    }

    if (line.startsWith('+++ b/')) {
      current = { hunks: [], isNew, path: line.slice(6) };
      files.push(current);
      continue;
    }

    const hunk = HUNK_PATTERN.exec(line);
    if (current === undefined || hunk === null) {
      continue;
    }

    const start = Number(hunk[1]);
    const lineCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
    current.hunks.push({ end: start + Math.max(lineCount, 1) - 1, start });
  }

  return files;
};

const mergeRanges = (
  ranges: readonly MutationRange[],
): readonly MutationRange[] =>
  ranges
    .toSorted((left, right) => left.start - right.start)
    .reduce<MutationRange[]>((merged, range) => {
      const previous = merged.at(-1);
      if (previous === undefined || range.start > previous.end + 1) {
        return [...merged, range];
      }

      return [
        ...merged.slice(0, -1),
        { end: Math.max(previous.end, range.end), start: previous.start },
      ];
    }, []);

const scopesForChangedFile = (
  file: ChangedFile,
  lineCount: number,
  contextLines: number,
): readonly string[] => {
  if (file.isNew || file.hunks.length === 0) {
    return [file.path];
  }

  return mergeRanges(
    file.hunks.map((hunk) => ({
      end: Math.min(hunk.end + contextLines, lineCount),
      start: Math.max(hunk.start - contextLines, 1),
    })),
  ).map((range) => `${file.path}:${range.start}-${range.end}`);
};

/** Builds one compact Stryker scope from changed source lines. */
export const createChangedMutationScopes = ({
  contextLines = 2,
  diff,
  lineCountByPath,
  requestedScopes = [],
  untrackedPaths,
}: ChangedMutationScopeInput): readonly string[] => {
  const changedFiles = parseChangedFiles(diff).filter((file) =>
    isMutableSource(file.path),
  );
  const changedByPath = new Map(
    changedFiles.map((file) => [file.path, file] as const),
  );
  const relevantUntracked = untrackedPaths.filter(isMutableSource);
  const candidates =
    requestedScopes.length === 0
      ? [...changedFiles.map((file) => file.path), ...relevantUntracked]
      : requestedScopes;

  return [
    ...new Set(
      candidates.flatMap((scope) => {
        if (
          MUTATION_RANGE_PATTERN.test(scope) ||
          !isLiteralMutationScope(scope)
        ) {
          return [scope];
        }

        const path = mutationPathFromScope(scope);
        const changedFile = changedByPath.get(path);
        if (changedFile === undefined || relevantUntracked.includes(path)) {
          return isMutableSource(path) ? [path] : [];
        }

        return scopesForChangedFile(
          changedFile,
          lineCountByPath.get(path) ?? Number.MAX_SAFE_INTEGER,
          contextLines,
        );
      }),
    ),
  ];
};
