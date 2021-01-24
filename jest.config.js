module.exports = {
  globals: {
    'ts-jest': {
      tsconfig: './tsconfig.json',
    },
  },
  "roots": [
    "<rootDir>/src"
  ],
  testEnvironment: 'jsdom',
  preset: 'ts-jest',
  transform: {
    "^.+\\.(ts)$": "ts-jest",
  },
  testPathIgnorePatterns: [
    'node_modules/',
    'build/',
  ],
  watchPathIgnorePatterns: ['.tmp', 'dist'],
};
