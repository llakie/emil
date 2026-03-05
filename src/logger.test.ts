import { jest } from '@jest/globals';

const realEnv = { ...process.env };

afterEach(() => {
    for (const key of Object.keys(process.env)) {
        delete process.env[key];
    }
    Object.assign(process.env, realEnv);
    jest.resetModules();
    jest.clearAllMocks();
});

async function loadLoggerWithMock() {
    const transportMock = jest.fn(() => ({ transport: true }));
    const pinoMock = Object.assign(
        jest.fn(() => ({
            level: 'info',
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        })),
        { transport: transportMock },
    );

    await jest.unstable_mockModule('pino', () => ({
        __esModule: true,
        default: pinoMock,
    }));

    const { Logger } = await import('./logger.js');
    return { Logger, pinoMock, transportMock };
}

describe('Logger', () => {
    test('skips transport in test environment', async () => {
        process.env.NODE_ENV = 'test';

        const { Logger, pinoMock, transportMock } = await loadLoggerWithMock();
        const logger = new Logger('info');

        expect(transportMock).not.toHaveBeenCalled();
        expect(pinoMock).toHaveBeenCalledTimes(1);
        expect(pinoMock.mock.calls[0]).toHaveLength(1);

        logger.info('hello');
        expect((logger as any).base.info).toHaveBeenCalledWith('hello');
    });

    test('uses transport outside test environment', async () => {
        process.env.NODE_ENV = 'production';
        delete process.env.JEST_WORKER_ID;

        const { Logger, pinoMock, transportMock } = await loadLoggerWithMock();
        const logger = new Logger('debug');

        expect(transportMock).toHaveBeenCalledTimes(1);
        expect(pinoMock.mock.calls[0]).toHaveLength(2);

        logger.setLevel('warn');
        expect((logger as any).base.level).toBe('warn');
    });
});
