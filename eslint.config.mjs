import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';
import js from '@eslint/js';
import globals from 'globals';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactPlugin from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

// Load official Airbnb style guide rules and strip deprecated/incompatible ESLint v10 rules
const airbnbBaseConfigs = compat.extends('airbnb-base').map((cfg) => {
  if (!cfg.rules) return cfg;
  const cleanedRules = { ...cfg.rules };
  // Remove legacy formatting/deprecated rules removed or superseded in ESLint 9+/10 + Biome
  const removedOrStylistic = [
    'array-bracket-newline',
    'array-bracket-spacing',
    'array-element-newline',
    'arrow-parens',
    'arrow-spacing',
    'block-spacing',
    'brace-style',
    'comma-dangle',
    'comma-spacing',
    'comma-style',
    'computed-property-spacing',
    'dot-location',
    'eol-last',
    'func-call-spacing',
    'function-call-argument-newline',
    'function-paren-newline',
    'generator-star-spacing',
    'implicit-arrow-linebreak',
    'indent',
    'jsx-quotes',
    'key-spacing',
    'keyword-spacing',
    'line-comment-position',
    'linebreak-style',
    'lines-around-comment',
    'lines-around-directive',
    'lines-between-class-members',
    'max-len',
    'max-statements-per-line',
    'multiline-comment-style',
    'multiline-ternary',
    'new-parens',
    'newline-per-chained-call',
    'no-confusing-arrow',
    'no-extra-parens',
    'no-extra-semi',
    'no-floating-decimal',
    'no-mixed-operators',
    'no-mixed-spaces-and-tabs',
    'no-multi-spaces',
    'no-multiple-empty-lines',
    'no-new-object',
    'no-new-symbol',
    'no-return-await',
    'no-spaced-func',
    'no-tabs',
    'no-trailing-spaces',
    'no-whitespace-before-property',
    'nonblock-statement-body-position',
    'object-curly-newline',
    'object-curly-spacing',
    'object-property-newline',
    'one-var-declaration-per-line',
    'operator-linebreak',
    'padded-blocks',
    'padding-line-between-statements',
    'quote-props',
    'quotes',
    'rest-spread-spacing',
    'semi',
    'semi-spacing',
    'semi-style',
    'space-before-blocks',
    'space-before-function-paren',
    'space-in-parens',
    'space-infix-ops',
    'space-unary-ops',
    'spaced-comment',
    'switch-colon-spacing',
    'template-curly-spacing',
    'template-tag-spacing',
    'wrap-iife',
    'wrap-regex',
    'yield-star-spacing',
    'global-require',
    'no-buffer-constructor',
    'no-new-require',
    'no-path-concat',
    'valid-typeof',
    // import plugin rules incompatible with TypeScript ESM resolver in ESLint 10 flat config
    'import/no-unresolved',
    'import/named',
    'import/default',
    'import/namespace',
    'import/export',
    'import/no-named-as-default',
    'import/no-named-as-default-member',
    'import/no-duplicates',
    'import/extensions',
    'import/order',
    'import/no-extraneous-dependencies',
    'import/prefer-default-export',
    'import/no-mutable-exports',
    'import/no-cycle',
    'import/no-self-import',
    'import/no-useless-path-segments',
    'import/no-relative-packages',
    'import/no-import-module-exports',
    'import/first',
    'import/newline-after-import',
    'import/no-amd',
    'import/no-webpack-loader-syntax',
    'import/no-dynamic-require',
  ];
  for (const rule of removedOrStylistic) {
    delete cleanedRules[rule];
  }
  for (const key of Object.keys(cleanedRules)) {
    if (key.startsWith('import/')) {
      delete cleanedRules[key];
    }
  }
  const next = { ...cfg, rules: cleanedRules };
  if (next.plugins && 'import' in next.plugins) {
    const restPlugins = { ...next.plugins };
    delete restPlugins.import;
    next.plugins = restPlugins;
  }
  return next;
});

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'site/**',
      'public_pages/**',
      'docs/**',
      'project_repo/**',
      'node_modules/**',
      '.state/**',
      '*.config.*',
    ],
  },
  ...airbnbBaseConfigs,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'server.ts', 'scripts/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      // TypeScript supersedes core JS rules
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-shadow': 'off',
      '@typescript-eslint/no-shadow': 'warn',
      'no-use-before-define': 'off',
      'no-redeclare': 'off',
      'no-empty-function': 'off',
      'no-useless-constructor': 'off',

      // Airbnb pragmatic adjustments for TypeScript, React 19 & industrial simulation algorithms
      'no-console': 'off',
      'no-restricted-syntax': 'off',
      'no-plusplus': 'off',
      'no-continue': 'off',
      'no-underscore-dangle': 'off',
      'no-bitwise': 'off',
      'no-nested-ternary': 'off',
      'no-param-reassign': 'off',
      'consistent-return': 'off',
      'class-methods-use-this': 'off',
      'no-await-in-loop': 'off',
      'no-void': 'off',
      'default-case': 'off',
      'camelcase': 'off',
      'prefer-destructuring': 'off',
      'no-control-regex': 'off',
      'max-classes-per-file': 'off',
      'no-restricted-globals': 'off',
      'no-promise-executor-return': 'off',
      'no-cond-assign': ['error', 'except-parens'],
      'no-else-return': 'off',
      'no-lonely-if': 'warn',
      'guard-for-in': 'off',
      'radix': 'warn',
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
      'no-throw-literal': 'error',
      'prefer-template': 'warn',
      'object-shorthand': 'warn',

      // React & Hooks (Airbnb React style)
      'react/jsx-key': 'error',
      'react/jsx-no-duplicate-props': 'error',
      'react/jsx-no-target-blank': 'error',
      'react/no-danger': 'error',
      'react/self-closing-comp': 'warn',
      'react/react-in-jsx-scope': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // Accessibility (Airbnb jsx-a11y)
      'jsx-a11y/alt-text': 'error',
      'jsx-a11y/anchor-is-valid': 'warn',
      'jsx-a11y/aria-props': 'error',
      'jsx-a11y/aria-role': 'error',
      'jsx-a11y/role-has-required-aria-props': 'error',
    },
  },
  {
    files: ['tests/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  }
);
