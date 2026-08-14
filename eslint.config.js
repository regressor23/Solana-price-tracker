import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `coverage/` is generated: the HTML reporter drops its own scripts there,
    // and type-aware linting fails on them because no tsconfig owns them.
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/*.tsbuildinfo'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Fire-and-forget promises must be marked, so an unhandled rejection in
      // a feed loop is a deliberate choice rather than an oversight.
      '@typescript-eslint/no-floating-promises': 'error',
      'no-console': ['warn', { allow: ['warn', 'error', 'log'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  {
    files: ['**/*.test.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },

  {
    // Plain JavaScript is tooling, not product: config files and the collector's
    // watch launcher. No tsconfig owns them, so type-aware rules cannot run —
    // and the glob needs `**/` or it matches only the repository root.
    files: ['**/*.js', '**/*.mjs', '*.config.ts'],
    ...tseslint.configs.disableTypeChecked,
  },

  {
    // Node's globals, spelled out rather than pulled from the `globals` package.
    // TypeScript files get these from `@types/node`; plain JavaScript has no
    // such source, and two names are cheaper than a dependency.
    files: ['**/*.mjs'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } },
  },
);
