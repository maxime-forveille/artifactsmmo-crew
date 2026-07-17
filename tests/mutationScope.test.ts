import { describe, expect, it } from 'vitest';

import {
  createChangedMutationScopes,
  isLiteralMutationScope,
  mutationPathFromScope,
  parseChangedFiles,
} from '../scripts/mutationScope.js';

const modifiedDiff = `diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -8,0 +10,2 @@
+first
+second
@@ -12 +14 @@
-old
+new`;

describe('parseChangedFiles', () => {
  it('parses modified hunks and deleted-line anchors', () => {
    expect(parseChangedFiles(modifiedDiff)).toEqual([
      {
        hunks: [
          { end: 11, start: 10 },
          { end: 14, start: 14 },
        ],
        isNew: false,
        path: 'src/example.ts',
      },
    ]);
  });

  it('marks a newly added source file for whole-file mutation', () => {
    const diff = `diff --git a/src/newFeature.ts b/src/newFeature.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/newFeature.ts
@@ -0,0 +1,3 @@
+one
+two
+three`;

    expect(parseChangedFiles(diff)).toEqual([
      { hunks: [{ end: 3, start: 1 }], isNew: true, path: 'src/newFeature.ts' },
    ]);
  });
});

describe('createChangedMutationScopes', () => {
  it('adds context and merges adjacent ranges for an existing source', () => {
    expect(
      createChangedMutationScopes({
        diff: modifiedDiff,
        lineCountByPath: new Map([['src/example.ts', 20]]),
        untrackedPaths: [],
      }),
    ).toEqual(['src/example.ts:8-16']);
  });

  it('uses whole files for new and untracked sources', () => {
    const diff = `diff --git a/src/newFeature.ts b/src/newFeature.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/newFeature.ts
@@ -0,0 +1,2 @@
+one
+two`;

    expect(
      createChangedMutationScopes({
        diff,
        lineCountByPath: new Map([['src/newFeature.ts', 2]]),
        untrackedPaths: ['src/untracked.ts', 'tests/ignored.test.ts'],
      }),
    ).toEqual(['src/newFeature.ts', 'src/untracked.ts']);
  });

  it('anchors a deletion-only hunk to the surrounding remaining lines', () => {
    const diff = `diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -10 +10,0 @@
-deleted`;

    expect(
      createChangedMutationScopes({
        diff,
        lineCountByPath: new Map([['src/example.ts', 20]]),
        untrackedPaths: [],
      }),
    ).toEqual(['src/example.ts:8-12']);
  });

  it('mutates an explicitly requested unchanged source in full', () => {
    expect(
      createChangedMutationScopes({
        diff: '',
        lineCountByPath: new Map([['src/example.ts', 20]]),
        requestedScopes: ['src/example.ts', 'src/other.ts:5-9', 'src/index.ts'],
        untrackedPaths: [],
      }),
    ).toEqual(['src/example.ts', 'src/other.ts:5-9']);
  });

  it('clamps context to the source boundaries', () => {
    const diff = `diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1 +1 @@
-old
+new
@@ -9 +10 @@
-old
+new`;

    expect(
      createChangedMutationScopes({
        contextLines: 2,
        diff,
        lineCountByPath: new Map([['src/example.ts', 10]]),
        untrackedPaths: [],
      }),
    ).toEqual(['src/example.ts:1-3', 'src/example.ts:8-10']);
  });
});

describe('mutation scope helpers', () => {
  it('extracts paths and distinguishes literal paths from globs', () => {
    expect(mutationPathFromScope('src/example.ts:5:2-9:4')).toBe(
      'src/example.ts',
    );
    expect(isLiteralMutationScope('src/example.ts:5-9')).toBe(true);
    expect(isLiteralMutationScope('src/**/*.ts')).toBe(false);
  });
});
