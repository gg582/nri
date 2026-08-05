export default {
  testEnvironment: 'node',
  transform: {
    '^.+\.(ts|tsx)$': '<rootDir>/tsTransformer.js',
  },
  testMatch: ['**/tests/**/*.test.ts', '**/tests/**/*.test.tsx'],
};
