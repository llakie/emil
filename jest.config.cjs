module.exports = {
    testEnvironment: 'node',
    extensionsToTreatAsEsm: ['.ts'],
    transform: {
        '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: 'tsconfig.json' }],
    },
    moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1',
    },
    testMatch: ['**/?(*.)+(test).ts'],
    clearMocks: true,
    coverageReporters: ['json-summary', 'lcov', 'text'],
};
