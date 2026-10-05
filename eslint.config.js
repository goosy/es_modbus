import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import globals from 'globals';

// ESLint finds code problems; @stylistic normalizes whitespace without
// re-wrapping lines, so hand-laid tables keep their layout.
export default [
    { ignores: ['modbus.js'] },
    js.configs.recommended,
    stylistic.configs.customize({
        indent: 'tab',
        quotes: 'single',
        semi: true,
        jsx: false,
        arrowParens: true,
        braceStyle: '1tbs',
        quoteProps: 'consistent',
    }),
    {
        rules: {
            // Allow aligned end-of-line comments.
            '@stylistic/no-multi-spaces': ['error', { ignoreEOLComments: true }],
            // Allow consecutive single-line class fields.
            '@stylistic/lines-between-class-members': ['error', 'always', { exceptAfterSingleLine: true }],
            // Allow `if (cond) { stmt; }` on one line.
            '@stylistic/max-statements-per-line': ['error', { max: 2 }],
            // Continuation lines of binary expressions are left to the author.
            '@stylistic/indent-binary-ops': 'off',
            // Use template literals instead of concatenating strings with values.
            'prefer-template': 'error',
            // One variable per declaration.
            'one-var': ['error', 'never'],
            // Use the Number namespace instead of the equivalent globals.
            'no-restricted-globals': ['error',
                { name: 'Infinity', message: 'Use Number.POSITIVE_INFINITY.' },
                { name: 'NaN', message: 'Use Number.NaN.' },
                { name: 'isNaN', message: 'Use Number.isNaN.' },
                { name: 'isFinite', message: 'Use Number.isFinite.' },
                { name: 'parseInt', message: 'Use Number.parseInt.' },
                { name: 'parseFloat', message: 'Use Number.parseFloat.' },
            ],
        },
    },
    {
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: globals.node,
        },
    },
];
