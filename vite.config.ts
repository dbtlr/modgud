import { defineConfig } from 'vite-plus';

// Paths no tool should format or lint: build and test output, package-manager
// state, generated code, and agent working files.
const GENERATED_IGNORES = [
  'dist/**',
  'coverage/**',
  'node_modules',
  'bun.lock',
  '**/*.gen.{js,ts}',
  '**/*.generated.{js,ts}',
  '.claude/**',
  '.codex/**',
  '.superpowers/**',
];

// Style preferences that catch no correctness issue.
const RELAXED_DEFAULTS = {
  'func-style': 'off',
  'id-length': 'off',
  'import/exports-last': 'off',
  'import/group-exports': 'off',
  'init-declarations': 'off',
  'max-params': 'off',
  'max-statements': 'off',
  'no-continue': 'off',
  'no-underscore-dangle': 'off',
  // oxlint 1.85 moved one-var into `style`; it demands one combined declaration per scope.
  'one-var': 'off',
  'prefer-destructuring': 'off',
  'prefer-named-capture-group': 'off',
  'unicorn/catch-error-name': 'off',
  'unicorn/no-await-expression-member': 'off',
  'unicorn/numeric-separators-style': 'off',
} as const;

// Every file name `bun test` discovers.
const TEST_FILES = ['**/*.test.ts', '**/*_test.ts', '**/*.spec.ts', '**/*_spec.ts'];

export default defineConfig({
  fmt: {
    // oxfmt owns code, not prose: its markdown style is fixed and would rewrite docs.
    ignorePatterns: ['**/*.{md,mdx,markdown}', ...GENERATED_IGNORES],
    singleQuote: true,
    sortImports: { ignoreCase: true },
  },
  lint: {
    categories: {
      correctness: 'error',
      nursery: 'off',
      pedantic: 'off',
      perf: 'error',
      restriction: 'off',
      style: 'warn',
      suspicious: 'error',
    },
    ignorePatterns: GENERATED_IGNORES,
    // Warnings fail the gate, and lint is type-aware with a full typecheck.
    options: { denyWarnings: true, typeAware: true, typeCheck: true },
    overrides: [
      {
        files: ['packages/modgud/**'],
        plugins: ['node'],
        rules: { 'import/no-nodejs-modules': 'off' },
      },
      {
        files: TEST_FILES,
        rules: {
          // Tests force loose types on purpose to drive error paths.
          'typescript/no-unsafe-type-assertion': 'off',
          // Nested matchers are the idiomatic way to assert structure.
          'unicorn/max-nested-calls': 'off',
        },
      },
    ],
    plugins: ['typescript', 'import', 'eslint', 'unicorn', 'oxc', 'promise'],
    rules: {
      'capitalized-comments': 'off',
      'import/no-named-export': 'off',
      'import/no-nodejs-modules': 'error',
      'import/prefer-default-export': 'off',
      'no-duplicate-imports': ['warn', { allowSeparateTypeImports: true }],
      'no-magic-numbers': 'off',
      'no-ternary': 'off',
      'sort-imports': 'off',
      'typescript/consistent-type-definitions': ['warn', 'type'],
      'unicorn/no-null': 'off',
      'unicorn/prefer-ternary': 'off',
      ...RELAXED_DEFAULTS,
    },
  },
});
