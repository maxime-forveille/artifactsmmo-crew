export default {
  clearTextReporter: { maxTestsToLog: 1, reportTests: false, skipFull: true },
  concurrency: '50%',
  // TypeScript 7's native-preview package doesn't expose the compiler API
  // Stryker uses to rewrite tsconfig files inside a sandbox. In-place mode
  // avoids that rewrite; Stryker backs up and restores every mutated file.
  inPlace: true,
  incremental: true,
  mutate: ['src/**/*.ts', '!src/client/schema.d.ts', '!src/index.ts'],
  plugins: ['@stryker-mutator/vitest-runner'],
  reporters: ['clear-text', 'progress', 'html'],
  testRunner: 'vitest',
  thresholds: { break: null, high: 80, low: 60 },
};
