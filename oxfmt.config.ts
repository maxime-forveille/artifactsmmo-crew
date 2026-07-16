import { defineConfig } from 'oxfmt';

export default defineConfig({
  ignorePatterns: [
    '.striker-tmp',
    'coverage',
    'reports',
    'openapi.yaml',
    'pnpm-lock.yaml',
  ],
  jsdoc: true,
  objectWrap: 'collapse',
  printWidth: 80,
  singleQuote: true,
  sortImports: {
    groups: [
      ['builtin', 'external'],
      'internal',
      'subpath',
      'parent',
      'sibling',
      'index',
      'style',
      'unknown',
    ],
  },
  sortPackageJson: { sortScripts: true },
});
