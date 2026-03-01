import { z } from 'zod';

export enum ImapSearchCriterium {
    ALL='ALL',
    SEEN='SEEN',
    UNSEEN='UNSEEN'
} 

export const IMAP_START_AT_KEYS = ['minDate', 'epoch', 'now'] as const;
export type ImapStartAtKey = (typeof IMAP_START_AT_KEYS)[number];
export const ERROR_POLICIES = ['stop', 'continue'] as const;
export type ErrorPolicy = (typeof ERROR_POLICIES)[number];

export const imapStartAtSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('minDate'),
        value: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected format YYYY-MM-DD'),
    }),
    z.object({
        type: z.literal('epoch'),
    }),
    z.object({
        type: z.literal('now'),
    }),
]);

export const runtimeStepSchema = z.object({
    name: z.string().min(1),
    config: z.record(z.string(), z.unknown()).default({}),
});

export const configSchema = z.object({
    imap: z.object({
        host: z.string().nonempty(),
        port: z.number().int().positive(),
        secure: z.boolean().default(true),
        user: z.string(),
        pass: z.string().optional(),
        passEnv: z.string().optional(),
        folder: z.string().default('INBOX'),
        startAt: imapStartAtSchema.default({ type: 'epoch' }),
        filter: z.object({
            criteria: z.array(z.enum(ImapSearchCriterium)).min(1).default([ ImapSearchCriterium.ALL ])
        }),
        options: z.object({
            maxFetchBytes: z.number().int().positive().optional()
        }),
        storage: z.object({
            filePath: z.string().default('/data/imap-state.json')
        }),
        idlePollingIntervalMs: z.number().int().positive().default(10000)
    }),
    runtime: z.object({
        plugins: z.array(z.string()).default([]),
        errorPolicy: z.enum(ERROR_POLICIES).default('stop'),
        steps: z.array(runtimeStepSchema).default([]),
    }),
});

export type Config = z.infer<typeof configSchema>;
export type RuntimeStepConfig = z.infer<typeof runtimeStepSchema>;

export type Classification = {
    label: string;
    confidence: number;
    reason: string;
};

export type ImapNextMessage = {
    uid: number;
    subject?: string;
    messageId?: string;
    from: string[];
    to: string[];
    date?: number;
    internalDate?: number;
    size?: number;
    seen: boolean;
    flags: string[];
    text?: string;
    html?: string;
    bodyParsed: boolean;
    bodyParseError?: string;
    source?: string;
};

export type ImapNextMessageResult = {
    message: ImapNextMessage;
    ack: () => void;
    nack: () => void;
};

export type StepResult = 'continue' | 'ack' | 'nack' | 'stop' | void;

export type StepLogger = {
    debug: (msg: string, data?: object) => void;
    info: (msg: string, data?: object) => void;
    warn: (msg: string, data?: object) => void;
    error: (msg: string, data?: object) => void;
};

export type ImapStepClient = {
    moveMessage: (uid: number, destinationFolder: string) => Promise<void>;
    deleteMessage: (uid: number) => Promise<void>;
    addFlags: (uid: number, flags: string[]) => Promise<void>;
    removeFlags: (uid: number, flags: string[]) => Promise<void>;
    getSourceFolder: () => string;
};

export type StepExecutionContext = {
    message: ImapNextMessage;
    imap: ImapStepClient;
    stepName: string;
    stepConfig: Record<string, unknown>;
    logger: StepLogger;
};

export type StepProvider = (context: StepExecutionContext) => Promise<StepResult> | StepResult;

export type StepProviderRegistry = {
    registerProvider: (name: string, provider: StepProvider) => void;
};

export type StepProviderModule = {
    registerProviders: (registry: StepProviderRegistry) => void | Promise<void>;
};
