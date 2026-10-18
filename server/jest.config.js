module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  setupFiles: ['<rootDir>/tests/env.js'],
  globalSetup: '<rootDir>/tests/globalSetup.js',
  testTimeout: 20000,
};
