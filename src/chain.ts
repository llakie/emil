import path from 'path';
import { pathToFileURL } from 'url';
import {
    Config,
    ImapNextMessageResult,
    ImapStepClient,
    RuntimeStepConfig,
    StepProvider,
    StepProviderModule,
    StepProviderRegistry,
    StepResult,
} from './types.js';
import { Logger } from './logger.js';

class StepProviderRegistryImpl implements StepProviderRegistry {
    private readonly providers = new Map<string, StepProvider>();

    public registerProvider(name: string, provider: StepProvider): void {
        if (!name || !name.trim()) {
            throw new Error('Step provider name must not be empty');
        }

        if (this.providers.has(name)) {
            throw new Error(`Step provider "${name}" is already registered`);
        }

        this.providers.set(name, provider);
    }

    public getProvider(name: string): StepProvider | undefined {
        return this.providers.get(name);
    }
}

export class Chain {
    private readonly registry: StepProviderRegistryImpl;
    private initialized = false;

    constructor(
        private readonly config: Config,
        private readonly logger: Logger,
        private readonly imapClient: ImapStepClient,
    ) {
        this.registry = new StepProviderRegistryImpl();
    }

    public async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }

        await this.loadPlugins(this.config.runtime.plugins);
        this.initialized = true;
    }

    public async execute(next: ImapNextMessageResult): Promise<void> {
        if (!this.initialized) {
            await this.initialize();
        }

        for (const step of this.config.runtime.steps) {
            const provider = this.registry.getProvider(step.name);
            if (!provider) {
                const err = new Error(`Unknown step provider "${step.name}"`);

                if (this.config.runtime.errorPolicy === 'stop') {
                    this.logger.error(err.message);
                    next.nack();
                    return;
                }

                this.logger.warn(err.message);
                continue;
            }

            try {
                const result = await provider({
                    message: next.message,
                    imap: this.imapClient,
                    stepName: step.name,
                    stepConfig: step.config,
                    logger: this.logger,
                });

                const action = this.normalizeResult(result);

                if (action === 'continue') {
                    continue;
                }

                if (action === 'nack') {
                    next.nack();
                    return;
                }

                // Both "ack" and "stop" terminate current mail successfully.
                next.ack();
                return;
            } catch (err) {
                this.logger.error(`Step "${step.name}" failed`, { err });

                if (this.config.runtime.errorPolicy === 'stop') {
                    next.nack();
                    return;
                }
            }
        }

        // Safety default so in-flight state never gets stuck.
        next.ack();
    }

    private async loadPlugins(pluginRefs: string[]): Promise<void> {
        for (const pluginRef of pluginRefs) {
            const moduleRef = this.resolvePluginModuleRef(pluginRef);
            this.logger.info(`Loading plugin "${pluginRef}"`, { moduleRef });

            const loaded: unknown = await import(moduleRef);
            const moduleCandidate = loaded as Partial<StepProviderModule> & { default?: unknown };
            const registerFn = this.resolveRegisterFunction(moduleCandidate);

            if (!registerFn) {
                throw new Error(`Plugin "${pluginRef}" does not export registerProviders`);
            }

            await registerFn(this.registry);
            this.logger.info(`Plugin loaded "${pluginRef}"`);
        }
    }

    private resolvePluginModuleRef(pluginRef: string): string {
        if (pluginRef === 'builtin:classification.spam') {
            return new URL('./plugins/builtin-classification-spam.js', import.meta.url).href;
        }

        if (pluginRef === 'builtin:classification.openai') {
            return new URL('./plugins/builtin-classification-openai.js', import.meta.url).href;
        }

        if (pluginRef.startsWith('.') || pluginRef.startsWith('/')) {
            return pathToFileURL(path.resolve(pluginRef)).href;
        }

        return pluginRef;
    }

    private resolveRegisterFunction(
        moduleCandidate: Partial<StepProviderModule> & { default?: unknown },
    ): StepProviderModule['registerProviders'] | null {
        if (typeof moduleCandidate.registerProviders === 'function') {
            return moduleCandidate.registerProviders;
        }

        if (typeof moduleCandidate.default === 'function') {
            return moduleCandidate.default as StepProviderModule['registerProviders'];
        }

        if (
            moduleCandidate.default &&
            typeof moduleCandidate.default === 'object' &&
            'registerProviders' in moduleCandidate.default &&
            typeof (moduleCandidate.default as { registerProviders?: unknown }).registerProviders === 'function'
        ) {
            return (moduleCandidate.default as StepProviderModule).registerProviders;
        }

        return null;
    }

    private normalizeResult(result: StepResult): Exclude<StepResult, void> {
        if (!result || result === 'continue') {
            return 'continue';
        }

        if (result === 'ack' || result === 'nack' || result === 'stop') {
            return result;
        }

        return 'continue';
    }
}

export type { RuntimeStepConfig };
