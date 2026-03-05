import pino, { Logger as PinoLogger, LoggerOptions, LevelWithSilent } from 'pino';

export type LogLevel = LevelWithSilent;

export class Logger {
    private readonly base: PinoLogger;

    constructor(level?: LogLevel) {
        const disablePretty =
            process.env.NODE_ENV === 'test' || typeof process.env.JEST_WORKER_ID !== 'undefined';
        const envLevel = process.env.LOG_LEVEL as LogLevel | undefined;
        const effectiveLevel = level ?? envLevel ?? (disablePretty ? 'silent' : 'info');
        const options: LoggerOptions = { level: effectiveLevel };

        if (disablePretty) {
            this.base = pino(options);
            return;
        }

        const transport = pino.transport({
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'SYS:standard',
                ignore: 'pid,hostname',
            },
        });
        this.base = pino(options, transport);
    }

    setLevel(level: LogLevel): void {
        this.base.level = level;
    }

    debug(msg: string, data?: object): void {
        data ? this.base.debug(data, msg) : this.base.debug(msg);
    }

    info(msg: string, data?: object): void {
        data ? this.base.info(data, msg) : this.base.info(msg);
    }

    warn(msg: string, data?: object): void {
        data ? this.base.warn(data, msg) : this.base.warn(msg);
    }

    error(msg: string, data?: object): void {
        data ? this.base.error(data, msg) : this.base.error(msg);
    }
}
