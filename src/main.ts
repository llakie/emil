import fs from 'node:fs';
import { Imap } from './imap.js';
import { Config, configSchema } from './types.js';
import { Logger } from './logger.js';
import { Chain } from './chain.js';
import { applyJitterToDelayMs } from './util.js';

const logger = new Logger();

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveImapPassword(config: Config): string | null {
    if (config.imap.pass) {
        return config.imap.pass;
    }

    if (config.imap.passEnv) {
        return process.env[config.imap.passEnv] ?? null;
    }

    return null;
}

function loadConfig(configPath: string): Config {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = configSchema.parse(JSON.parse(raw));

    if (!resolveImapPassword(parsed)) {
        throw new Error('Missing IMAP password: set imap.pass or imap.passEnv in config.json');
    }

    return parsed;
}

async function main() {
    const configPath = process.env.CONFIG_PATH ?? './config/config.json';
    const config = loadConfig(configPath);
    const imap = new Imap(config);

    const chain = new Chain(config, logger, imap.getStepClient());

    await chain.initialize();

    let running = true;
    const stop = async () => {
        if (!running) {
            return;
        }
        running = false;
        await imap.close();
        process.exit(0);
    };

    process.on('SIGINT', () => {
        void stop();
    });
    process.on('SIGTERM', () => {
        void stop();
    });

    logger.info(
        `IMAP polling started (every ${config.imap.idlePollingIntervalMs}ms), log level=${process.env.LOG_LEVEL || 'info'}`,
    );

    const maxErrorBackoffMs = 30000;
    const INITIAL_BACKOFF_INTERVAL_MS = 1000;
    let currentErrorBackofMs = INITIAL_BACKOFF_INTERVAL_MS;

    while (running) {
        try {
            const next = await imap.getNextMessage();

            if (next) {
                logger.info(`Fetched UID=${next.message.uid}`);
                await chain.execute(next);
            } else {
                logger.info('Momentan keine weiteren Mails.');
                await sleep(config.imap.idlePollingIntervalMs);
            }

            currentErrorBackofMs = INITIAL_BACKOFF_INTERVAL_MS;
        } catch (err) {
            logger.error('Polling error', { err });
            currentErrorBackofMs = Math.min(currentErrorBackofMs, maxErrorBackoffMs);
            const retryDelayMs = Math.min(applyJitterToDelayMs(currentErrorBackofMs), maxErrorBackoffMs);
            logger.warn(`Retrying polling in ${retryDelayMs}ms (base=${currentErrorBackofMs}ms)`);
            await sleep(retryDelayMs);
            currentErrorBackofMs = Math.min(currentErrorBackofMs * 2, maxErrorBackoffMs);
        }
    }
}

void main().catch((err) => {
    logger.error('Fatal error', { err });
    process.exit(1);
});
