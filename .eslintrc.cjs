module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
  },
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended'
  ],
  parserOptions: {
    tsconfigRootDir: __dirname,
  },
  rules: {
    'no-console': 'warn',
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/explicit-function-return-type': 'error',
    '@typescript-eslint/no-unused-vars': 'error',
    'no-restricted-syntax': [
      'error',
      {
        selector: "CallExpression[callee.object.name='process'][callee.property.name='env']",
        message: 'Do not access process.env directly. Use the config module from src/core/config.',
      },
    ],
  },
  overrides: [
    {
      files: ['**/tests/**/*.ts', '**/*.test.ts', 'vitest.config.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/explicit-function-return-type': 'off',
      },
    },
  ],
};
