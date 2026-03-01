import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { ImapNextMessage, StepProvider, StepProviderRegistry } from '../types.js';

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_MIN_CONFIDENCE = 0.75;
const DEFAULT_MAX_TEXT_CHARS = 6000;
const DEFAULT_MAX_HTML_CHARS = 6000;

const labelSchema = z
    .object({
        id: z.string().min(1),
        prompt: z.string().min(1),
        folder: z.string().min(1).optional(),
    })
    .strict();

const openAiStepConfigSchema = z
    .object({
        apiKey: z.string().min(1).optional(),
        apiKeyEnv: z.string().min(1).default('OPENAI_API_KEY'),
        model: z.string().min(1).default(DEFAULT_MODEL),
        labels: z.array(labelSchema).min(1),
        labelMap: z.record(z.string(), z.string().min(1)).default({}),
        thresholds: z
            .object({
                minConfidence: z.number().min(0).max(1).default(DEFAULT_MIN_CONFIDENCE),
            })
            .default({ minConfidence: DEFAULT_MIN_CONFIDENCE }),
        limits: z
            .object({
                maxTextChars: z.number().int().positive().default(DEFAULT_MAX_TEXT_CHARS),
                maxHtmlChars: z.number().int().positive().default(DEFAULT_MAX_HTML_CHARS),
            })
            .passthrough()
            .default({
                maxTextChars: DEFAULT_MAX_TEXT_CHARS,
                maxHtmlChars: DEFAULT_MAX_HTML_CHARS,
            }),
    })
    .strict();

const modelOutputSchema = z
    .object({
        labelId: z.string().min(1),
        confidence: z.number().min(0).max(1),
        reason: z.string().default(''),
    })
    .strict();

type OpenAiStepConfig = z.infer<typeof openAiStepConfigSchema>;
type ModelClassificationOutput = z.infer<typeof modelOutputSchema>;

class OpenAiClassifier {
    private config: OpenAiStepConfig | null = null;
    private client: OpenAI | null = null;
    private currentApiKey: string | null = null;

    public configure(stepConfig: Record<string, unknown>): { ok: true } | { ok: false; reason: string } {
        const parsed = openAiStepConfigSchema.safeParse(stepConfig);

        if (!parsed.success) {
            return { ok: false, reason: parsed.error.message };
        }

        this.config = parsed.data;
        const apiKey = this.config.apiKey ?? process.env[this.config.apiKeyEnv];

        if (!apiKey) {
            this.client = null;
            this.currentApiKey = null;
            return {
                ok: false,
                reason: `Missing API key (set config.apiKey or env var "${this.config.apiKeyEnv}")`,
            };
        }

        if (!this.client || this.currentApiKey !== apiKey) {
            this.client = new OpenAI({ apiKey });
            this.currentApiKey = apiKey;
        }

        return { ok: true };
    }

    public getConfig(): OpenAiStepConfig {
        if (!this.config) {
            throw new Error('OpenAI classifier is not configured');
        }

        return this.config;
    }

    public async classify(message: ImapNextMessage): Promise<ModelClassificationOutput> {
        if (!this.client) {
            throw new Error('OpenAI client is not available');
        }

        const config = this.getConfig();
        const response = await this.client.responses.parse({
            model: config.model,
            instructions: this.buildSystemInstructions(config),
            input: this.buildUserPrompt(message, config),
            text: {
                format: zodTextFormat(modelOutputSchema, 'email_classification'),
            },
        });

        if (!response.output_parsed) {
            throw new Error('OpenAI did not return a parsed classification');
        }

        return modelOutputSchema.parse(response.output_parsed);
    }

    public resolveTargetFolder(labelId: string): string | null {
        const config = this.getConfig();
        const fromMap = config.labelMap[labelId];

        if (fromMap) {
            return fromMap;
        }

        const label = config.labels.find((entry) => entry.id === labelId);
        return label?.folder ?? null;
    }

    private buildSystemInstructions(config: OpenAiStepConfig): string {
        const labels = config.labels.map((label) => `- ${label.id}: ${label.prompt}`).join('\n');

        return [
            'You classify emails into exactly one label.',
            'Choose the best fitting label id from the provided list.',
            'Set confidence between 0 and 1.',
            'Keep reason short and concrete.',
            'Allowed labels:',
            labels,
        ].join('\n');
    }

    private buildUserPrompt(message: ImapNextMessage, config: OpenAiStepConfig): string {
        const subject = this.normalizeInput(message.subject);
        const from = message.from.join(', ');
        const text = this.limitText(this.normalizeInput(message.text), config.limits.maxTextChars);
        const html = this.limitText(this.normalizeInput(message.html), config.limits.maxHtmlChars);

        return [
            'Classify this email:',
            `subject: ${subject || '(empty)'}`,
            `from: ${from || '(unknown)'}`,
            `text: ${text || '(empty)'}`,
            `html: ${html || '(empty)'}`,
        ].join('\n');
    }

    private normalizeInput(value?: string): string {
        if (!value) {
            return '';
        }

        return value.replace(/\s+/g, ' ').trim();
    }

    private limitText(value: string, maxChars: number): string {
        if (value.length <= maxChars) {
            return value;
        }

        return `${value.slice(0, maxChars)}…`;
    }
}

class OpenAiStepProvider {
    public static createInstance(): StepProvider {
        const classifier = new OpenAiClassifier();

        return async ({ message, stepConfig, logger, imap }) => {
            const flagAsUnassigned = async (details: Record<string, unknown>) => {
                try {
                    await imap.addFlags(message.uid, ['\\Flagged']);
                    logger.info(`Flagged unassigned mail UID=${message.uid}`, details);
                } catch (err) {
                    logger.warn(`Could not flag unassigned mail UID=${message.uid}`, { err });
                }
            };

            const configured = classifier.configure(stepConfig);
            if (!configured.ok) {
                logger.warn(`OpenAI classifier skipped for UID=${message.uid}: ${configured.reason}`);
                return 'continue';
            }

            const config = classifier.getConfig();
            let classification: ModelClassificationOutput;

            try {
                classification = await classifier.classify(message);
            } catch (err) {
                logger.error(`OpenAI classification failed for UID=${message.uid}`, { err });
                return 'nack';
            }

            const knownLabel = config.labels.some((label) => label.id === classification.labelId);
            if (!knownLabel) {
                logger.warn(`OpenAI returned unknown label for UID=${message.uid}`, {
                    labelId: classification.labelId,
                    confidence: classification.confidence,
                    reason: classification.reason,
                });
                await flagAsUnassigned({
                    reason: 'unknown_label',
                    labelId: classification.labelId,
                    confidence: classification.confidence,
                });
                return 'continue';
            }

            if (classification.confidence < config.thresholds.minConfidence) {
                logger.info(`OpenAI confidence below threshold for UID=${message.uid}`, {
                    date: message.internalDate ? new Date(message.internalDate) : 'unknown',
                    labelId: classification.labelId,
                    confidence: classification.confidence,
                    minConfidence: config.thresholds.minConfidence,
                    reason: classification.reason,
                });
                await flagAsUnassigned({
                    date: message.internalDate ? new Date(message.internalDate) : 'unknown',
                    reason: 'low_confidence',
                    labelId: classification.labelId,
                    confidence: classification.confidence,
                    minConfidence: config.thresholds.minConfidence,
                });
                return 'continue';
            }

            const targetFolder = classifier.resolveTargetFolder(classification.labelId);
            if (!targetFolder) {
                logger.warn(`No target folder mapped for OpenAI label "${classification.labelId}"`);
                await flagAsUnassigned({
                    reason: 'missing_target_folder',
                    labelId: classification.labelId,
                    confidence: classification.confidence,
                });
                return 'continue';
            }

            if (targetFolder.trim() === imap.getSourceFolder().trim()) {
                logger.info(`OpenAI classified UID=${message.uid}; target folder equals source folder, skipping move`, {
                    labelId: classification.labelId,
                    confidence: classification.confidence,
                    reason: classification.reason,
                    targetFolder
                });
                return 'ack';
            }

            try {
                await imap.moveMessage(message.uid, targetFolder);

                logger.info(`OpenAI classified and moved UID=${message.uid}`, {
                    date: message.internalDate ? new Date(message.internalDate) : 'unknown',
                    labelId: classification.labelId,
                    confidence: classification.confidence,
                    reason: classification.reason,
                    targetFolder,
                });
                return 'ack';
            } catch (err) {
                logger.error(`Failed to move OpenAI-classified UID=${message.uid} to "${targetFolder}"`, { err });
                return 'nack';
            }
        };
    }
}

export function registerProviders(registry: StepProviderRegistry): void {
    registry.registerProvider('builtin:classification.openai', OpenAiStepProvider.createInstance());
}
