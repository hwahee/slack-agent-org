import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

/**
 * ESLint flat config.
 *
 * Beyond the usual strictness, this config enforces the organization's fixed
 * principles (CLAUDE.md) as code boundaries:
 *
 * 1. Slack is reached only from `src/slack`. That module is the agent's ears:
 *    it may RECEIVE (Socket Mode) and READ (names), never send. Sending goes
 *    through the screen, mouse and keyboard like any person (src/desk).
 * 2. Inside `src/slack`, the Web API's sending namespaces (`chat`, `files`,
 *    `reactions`, …) and the escape hatch `apiCall` may not even be touched.
 * 3. The MCP SDK is an implementation detail of `src/tools`.
 * 4. `zod` may only be imported inside `src/validation` — everything else goes
 *    through the validation facade.
 * 5. Interruption is cooperative only. Nothing calls `.interrupt()` on an agent
 *    run; the agent pauses itself at a safe point (inbox_yield).
 */

const restrictedImports = [
  {
    group: ['@slack/*'],
    message:
      'Slack is reached only from src/slack (receive + read). Sending goes through the desk (GUI) — see CLAUDE.md.',
  },
  {
    group: ['@modelcontextprotocol/*'],
    message: 'The MCP SDK is an implementation detail of src/tools.',
  },
  {
    group: ['zod', 'zod/*'],
    message:
      'Import from src/validation instead. zod is an implementation detail behind the validation facade.',
  },
];

/** Restricted imports minus the groups a module is allowed to use. */
function importsExcept(...allowed) {
  return [
    'error',
    {
      patterns: restrictedImports.filter((pattern) =>
        pattern.group.every((group) => !allowed.includes(group)),
      ),
    },
  ];
}

export default tseslint.config(
  {
    ignores: ['node_modules/**', '.bin/**', 'data/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      // Cooperative interruption only (CLAUDE.md).
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='interrupt']",
          message:
            'Interruption is cooperative only: the agent pauses itself at a safe point (inbox_yield). See CLAUDE.md.',
        },
      ],
    },
  },
  // Boundaries. One rule entry per zone on purpose: flat config replaces a
  // rule's options wholesale, so overlapping blocks would drop each other.
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts'],
    ignores: ['src/slack/**', 'src/tools/**', 'src/validation/**'],
    rules: { 'no-restricted-imports': importsExcept() },
  },
  {
    files: ['src/slack/**/*.ts'],
    rules: {
      'no-restricted-imports': importsExcept('@slack/*'),
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='interrupt']",
          message:
            'Interruption is cooperative only: the agent pauses itself at a safe point (inbox_yield). See CLAUDE.md.',
        },
        {
          selector:
            'MemberExpression[property.name=/^(chat|files|reactions|pins|reminders|apiCall)$/]',
          message:
            'src/slack receives and reads only. Messages are sent through the Slack client on screen (src/desk) — see CLAUDE.md.',
        },
      ],
    },
  },
  {
    files: ['src/tools/**/*.ts'],
    rules: { 'no-restricted-imports': importsExcept('@modelcontextprotocol/*') },
  },
  {
    files: ['src/validation/**/*.ts'],
    rules: { 'no-restricted-imports': importsExcept('zod', 'zod/*') },
  },
  // Whole-agent tests play the model, which talks to the desk over MCP.
  {
    files: ['src/*.integration.test.ts'],
    rules: { 'no-restricted-imports': importsExcept('@modelcontextprotocol/*') },
  },
  // bun:test's `expect(...).rejects` matchers must be awaited at runtime but
  // are typed as non-thenable — keep the awaits, silence the false positive.
  {
    files: ['src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/await-thenable': 'off',
    },
  },
  {
    files: ['eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettierConfig,
);
