import { defineConfig } from 'oxlint';

export default defineConfig({
  categories: { correctness: 'error' },
  ignorePatterns: [
    'coverage/**',
    'dist/**',
    'reports/**',
    'src/client/schema.d.ts',
  ],
  options: { typeAware: true },
  overrides: [
    {
      files: ['tests/**/*.ts'],
      rules: { 'typescript/no-unsafe-type-assertion': 'off' },
    },
  ],
  plugins: ['eslint', 'oxc', 'typescript', 'unicorn'],
  rules: {
    'no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    'typescript/consistent-type-definitions': ['error', 'type'],
    'typescript/consistent-type-imports': 'error',
    'typescript/no-deprecated': 'warn',
    'typescript/no-explicit-any': 'error',
    'typescript/no-misused-promises': 'error',
    'typescript/no-namespace': 'error',
    'typescript/no-unsafe-argument': 'error',
    'typescript/no-unsafe-assignment': 'error',
    'typescript/no-unsafe-call': 'error',
    'typescript/no-unsafe-declaration-merging': 'error',
    'typescript/no-unsafe-enum-comparison': 'error',
    'typescript/no-unsafe-function-type': 'error',
    'typescript/no-unsafe-member-access': 'error',
    'typescript/no-unsafe-return': 'error',
    'typescript/no-unsafe-type-assertion': 'error',
    'typescript/no-unsafe-unary-minus': 'error',
    'typescript/only-throw-error': 'error',
    'typescript/prefer-function-type': 'error',
    'typescript/switch-exhaustiveness-check': 'error',
    'typescript/use-unknown-in-catch-callback-variable': 'error',
  },
});
