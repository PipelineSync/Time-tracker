// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

// TypeScript flat config (ESLint 9). Scope: the app source, the Netlify
// Functions, the verification harness and the tooling at the repo root.
// The native projects (android/, ios/, src-tauri/) and build output are not
// linted here.
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'android/**',
      'ios/**',
      'src-tauri/**',
      // Pre-paint theme bootstrap: deliberately plain ES5, loaded before the
      // bundle — it is not part of the TypeScript program.
      'public/theme-init.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      // Most code is browser code; the scripts/ verification harness, the
      // Netlify Functions and the root tooling also run on Node, so allow
      // both global sets everywhere (Node 18+ exposes fetch/Response too).
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // The codebase predates the linter; underscore-prefixed leftovers are
      // an accepted convention (e.g. `const { permissions: _drop, ...rest }`).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // `any` appears in the verification harness (storage stubs) and a few
      // backend boundaries; tracking it down is a project, not a lint gate.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    // Build/tooling configs (tailwind, postcss) are CommonJS-style files
    // loaded by their own tooling (jiti) — allow require() there.
    files: ['*.config.js'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
)
