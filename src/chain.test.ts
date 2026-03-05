import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import { Chain } from './chain.js';
import { Config, ImapSearchCriterium, ImapStepClient, StepProvider } from './types.js';

const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
} as const;

function createConfig(overrides?: Partial<Config>): Config {
    return {
        imap: {
            host: 'imap.example.com',
            port: 993,
            secure: true,
            user: 'user@example.com',
            pass: 'secret',
            folder: 'INBOX',
            startAt: { type: 'epoch' },
            filter: { criteria: [ImapSearchCriterium.ALL] },
            options: {},
            maxAttempts: 3,
            storage: { filePath: path.join(os.tmpdir(), 'imap-state.json') },
            idlePollingIntervalMs: 10000,
        },
        runtime: {
            plugins: [],
            errorPolicy: 'stop',
            steps: [],
        },
        ...overrides,
    };
}

function createImapClient(): ImapStepClient {
    return {
        moveMessage: async () => {},
        deleteMessage: async () => {},
        addFlags: async () => {},
        removeFlags: async () => {},
        getSourceFolder: () => 'INBOX',
    };
}

function registerProvider(chain: Chain, name: string, provider: StepProvider): void {
    (chain as unknown as { registry: { registerProvider: (n: string, p: StepProvider) => void } }).registry.registerProvider(
        name,
        provider,
    );
}

describe('Chain', () => {
    test('acks when all steps continue', async () => {
        const config = createConfig({
            runtime: {
                plugins: [],
                errorPolicy: 'stop',
                steps: [{ name: 'stepA', config: {} }, { name: 'stepB', config: {} }],
            },
        });
        const chain = new Chain(config, logger, createImapClient());
        await chain.initialize();

        registerProvider(chain, 'stepA', () => 'continue');
        registerProvider(chain, 'stepB', () => undefined);

        const ack = jest.fn();
        const nack = jest.fn();

        await chain.execute({
            message: {
                uid: 1,
                from: [],
                to: [],
                seen: false,
                flags: [],
                bodyParsed: true,
            },
            ack,
            nack,
        });

        expect(ack).toHaveBeenCalledTimes(1);
        expect(nack).not.toHaveBeenCalled();
    });

    test('nacks when a step returns nack', async () => {
        const config = createConfig({
            runtime: {
                plugins: [],
                errorPolicy: 'stop',
                steps: [{ name: 'stepA', config: {} }],
            },
        });
        const chain = new Chain(config, logger, createImapClient());
        await chain.initialize();

        registerProvider(chain, 'stepA', () => 'nack');

        const ack = jest.fn();
        const nack = jest.fn();

        await chain.execute({
            message: {
                uid: 2,
                from: [],
                to: [],
                seen: false,
                flags: [],
                bodyParsed: true,
            },
            ack,
            nack,
        });

        expect(nack).toHaveBeenCalledTimes(1);
        expect(ack).not.toHaveBeenCalled();
    });

    test('nacks when a step throws and errorPolicy=stop', async () => {
        const config = createConfig({
            runtime: {
                plugins: [],
                errorPolicy: 'stop',
                steps: [{ name: 'stepA', config: {} }],
            },
        });
        const chain = new Chain(config, logger, createImapClient());
        await chain.initialize();

        registerProvider(chain, 'stepA', () => {
            throw new Error('boom');
        });

        const ack = jest.fn();
        const nack = jest.fn();

        await chain.execute({
            message: {
                uid: 3,
                from: [],
                to: [],
                seen: false,
                flags: [],
                bodyParsed: true,
            },
            ack,
            nack,
        });

        expect(nack).toHaveBeenCalledTimes(1);
        expect(ack).not.toHaveBeenCalled();
    });

    test('continues after error when errorPolicy=continue', async () => {
        const config = createConfig({
            runtime: {
                plugins: [],
                errorPolicy: 'continue',
                steps: [{ name: 'stepA', config: {} }, { name: 'stepB', config: {} }],
            },
        });
        const chain = new Chain(config, logger, createImapClient());
        await chain.initialize();

        registerProvider(chain, 'stepA', () => {
            throw new Error('boom');
        });
        registerProvider(chain, 'stepB', () => 'continue');

        const ack = jest.fn();
        const nack = jest.fn();

        await chain.execute({
            message: {
                uid: 4,
                from: [],
                to: [],
                seen: false,
                flags: [],
                bodyParsed: true,
            },
            ack,
            nack,
        });

        expect(ack).toHaveBeenCalledTimes(1);
        expect(nack).not.toHaveBeenCalled();
    });

    test('nacks when provider is missing and errorPolicy=stop', async () => {
        const config = createConfig({
            runtime: {
                plugins: [],
                errorPolicy: 'stop',
                steps: [{ name: 'missing', config: {} }],
            },
        });
        const chain = new Chain(config, logger, createImapClient());
        await chain.initialize();

        const ack = jest.fn();
        const nack = jest.fn();

        await chain.execute({
            message: {
                uid: 5,
                from: [],
                to: [],
                seen: false,
                flags: [],
                bodyParsed: true,
            },
            ack,
            nack,
        });

        expect(nack).toHaveBeenCalledTimes(1);
        expect(ack).not.toHaveBeenCalled();
    });

    test('continues when provider is missing and errorPolicy=continue', async () => {
        const config = createConfig({
            runtime: {
                plugins: [],
                errorPolicy: 'continue',
                steps: [{ name: 'missing', config: {} }, { name: 'stepA', config: {} }],
            },
        });
        const chain = new Chain(config, logger, createImapClient());
        await chain.initialize();

        registerProvider(chain, 'stepA', () => 'ack');

        const ack = jest.fn();
        const nack = jest.fn();

        await chain.execute({
            message: {
                uid: 6,
                from: [],
                to: [],
                seen: false,
                flags: [],
                bodyParsed: true,
            },
            ack,
            nack,
        });

        expect(ack).toHaveBeenCalledTimes(1);
        expect(nack).not.toHaveBeenCalled();
    });

    test('registerProvider validates names', () => {
        const chain = new Chain(createConfig(), logger, createImapClient());
        const registry = (chain as unknown as { registry: { registerProvider: (n: string, p: StepProvider) => void } })
            .registry;

        expect(() => registry.registerProvider('   ', () => 'continue')).toThrow(/must not be empty/);

        registry.registerProvider('stepA', () => 'continue');
        expect(() => registry.registerProvider('stepA', () => 'continue')).toThrow(/already registered/);
    });

    test('normalizeResult maps stop and invalid values', () => {
        const chain = new Chain(createConfig(), logger, createImapClient());
        const normalize = (chain as unknown as { normalizeResult: (r: unknown) => string }).normalizeResult.bind(chain);

        expect(normalize('stop')).toBe('stop');
        expect(normalize('weird')).toBe('continue');
    });

    test('resolveRegisterFunction supports named, default, and object exports', () => {
        const chain = new Chain(createConfig(), logger, createImapClient());
        const resolve = (chain as unknown as {
            resolveRegisterFunction: (m: Record<string, unknown>) => unknown;
        }).resolveRegisterFunction.bind(chain);

        const named = () => {};
        const def = () => {};
        const obj = { registerProviders: () => {} };

        expect(resolve({ registerProviders: named })).toBe(named);
        expect(resolve({ default: def })).toBe(def);
        expect(resolve({ default: obj })).toBe(obj.registerProviders);
        expect(resolve({})).toBeNull();
    });

    test('resolvePluginModuleRef handles builtins, paths, and package names', () => {
        const chain = new Chain(createConfig(), logger, createImapClient());
        const resolve = (chain as unknown as { resolvePluginModuleRef: (ref: string) => string }).resolvePluginModuleRef.bind(chain);

        expect(resolve('builtin:classification.spam')).toContain('builtin-classification-spam.js');
        expect(resolve('builtin:classification.openai')).toContain('builtin-classification-openai.js');
        expect(resolve('./relative-plugin.js')).toMatch(/^file:/);
        expect(resolve('some-package')).toBe('some-package');
    });

    test('loads plugin from file path and registers provider', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emil-plugin-'));
        const pluginPath = path.join(dir, 'plugin.mjs');
        fs.writeFileSync(
            pluginPath,
            'export function registerProviders(registry){ registry.registerProvider("plugin:step", () => "ack"); }',
        );

        const config = createConfig({
            runtime: {
                plugins: [pluginPath],
                errorPolicy: 'stop',
                steps: [{ name: 'plugin:step', config: {} }],
            },
        });

        const chain = new Chain(config, logger, createImapClient());

        const ack = jest.fn();
        const nack = jest.fn();

        await chain.execute({
            message: {
                uid: 7,
                from: [],
                to: [],
                seen: false,
                flags: [],
                bodyParsed: true,
            },
            ack,
            nack,
        });

        expect(ack).toHaveBeenCalledTimes(1);
        expect(nack).not.toHaveBeenCalled();
    });
});
