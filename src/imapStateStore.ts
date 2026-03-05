import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Logger } from './logger.js';
import { Config, IMAP_START_AT_KEYS, ImapSearchCriterium, ImapStartAtKey } from './types.js';
import { parseIsoDateToUtcMs, utcDayStartMs } from './util.js';

export const SEEN_MASK = 1;
export const UNSEEN_MASK = 2;

const nonNegativeIntSchema = z.number().int().nonnegative();
const persistedStateSchema = z
    .object({
        startAtKey: z.enum(IMAP_START_AT_KEYS).default('epoch'),
        startAtValue: z.string().nullable().default(null),
        fromNowPrimed: z.boolean().default(true),
        minDateMs: nonNegativeIntSchema.default(0),
        rangeStartMs: nonNegativeIntSchema.nullable().default(null),
        rangeEndMs: nonNegativeIntSchema.nullable().default(null),
        processedUids: z.array(nonNegativeIntSchema).default([]),
        currentAttemptUid: nonNegativeIntSchema.nullable().default(null),
        currentAttempt: nonNegativeIntSchema.default(0),
        criteriaMask: nonNegativeIntSchema.default(0),
        uidValidity: z.string().nullable().default(null),
    })
    .strict()
    .superRefine((value, ctx) => {
        if (value.rangeStartMs !== null && value.rangeEndMs !== null && value.rangeStartMs > value.rangeEndMs) {
            ctx.addIssue({
                code: 'custom',
                message: 'rangeStartMs must be <= rangeEndMs',
                path: ['rangeStartMs'],
            });
        }
    });

export type ImapPersistedState = z.infer<typeof persistedStateSchema>;

type StartAtResolved = {
    startAtKey: ImapStartAtKey;
    startAtValue: string | null;
    minDateMs: number;
    fromNowPrimed: boolean;
};

export class ImapStateStore {
    private readonly logger: Logger;
    private readonly filePath: string;
    private state: ImapPersistedState;

    constructor(private readonly config: Config) {
        this.logger = new Logger();

        const dataDir = path.dirname(this.config.imap.storage.filePath);

        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        }

        this.filePath = this.config.imap.storage.filePath;
        this.state = this.load();
    }

    public getState(): ImapPersistedState {
        return {
            ...this.state,
            processedUids: [...this.state.processedUids],
        };
    }

    public setUidValidity(uidValidity: bigint): ImapPersistedState {
        this.state = this.createDefaultState();
        this.state.uidValidity = uidValidity.toString();
        this.persist();
        return this.getState();
    }

    public setWindow(rangeStartMs: number, rangeEndMs: number): ImapPersistedState {
        this.state = persistedStateSchema.parse({
            ...this.state,
            rangeStartMs,
            rangeEndMs,
            processedUids: [],
        });

        this.persist();

        return this.getState();
    }

    public addProcessedUid(uid: number): ImapPersistedState {
        const validatedUid = nonNegativeIntSchema.parse(uid);

        if (this.state.processedUids.includes(validatedUid)) {
            return this.getState();
        }

        this.state = persistedStateSchema.parse({
            ...this.state,
            processedUids: [...this.state.processedUids, validatedUid],
        });

        this.persist();

        return this.getState();
    }

    public incrementAttempt(uid: number): number {
        const validatedUid = nonNegativeIntSchema.parse(uid);

        const nextAttempt = this.state.currentAttemptUid === validatedUid ? this.state.currentAttempt + 1 : 1;

        this.state = persistedStateSchema.parse({
            ...this.state,
            currentAttemptUid: validatedUid,
            currentAttempt: nextAttempt,
        });

        this.persist();
        return nextAttempt;
    }

    public resetAttempt(uid: number): ImapPersistedState {
        const validatedUid = nonNegativeIntSchema.parse(uid);

        if (this.state.currentAttemptUid !== validatedUid) {
            return this.getState();
        }

        this.state = persistedStateSchema.parse({
            ...this.state,
            currentAttemptUid: null,
            currentAttempt: 0,
        });

        this.persist();
        return this.getState();
    }

    public markFromNowPrimed(): ImapPersistedState {
        if (this.state.fromNowPrimed) {
            return this.getState();
        }

        this.state = persistedStateSchema.parse({
            ...this.state,
            fromNowPrimed: true,
        });

        this.persist();

        return this.getState();
    }

    private load(): ImapPersistedState {
        if (!fs.existsSync(this.filePath)) {
            return this.createDefaultState();
        }

        try {
            const raw = fs.readFileSync(this.filePath, 'utf-8');
            const parsed: unknown = JSON.parse(raw);
            const result = persistedStateSchema.safeParse(parsed);

            if (result.success) {
                const startAtFromConfig = this.resolveStartAtFromConfig();

                if (startAtFromConfig.startAtKey !== result.data.startAtKey) {
                    this.logger.info('Changed startAt from config detected. Resetting state');
                    return this.createDefaultState();
                }

                if (startAtFromConfig.startAtValue !== result.data.startAtValue) {
                    this.logger.info('Changed startAt value from config detected. Resetting state');
                    return this.createDefaultState();
                }

                if (result.data.criteriaMask !== this.toCriteriaMask(this.config.imap.filter.criteria)) {
                    this.logger.info('Changed criteria mask from config detected. Resetting state');
                    return this.createDefaultState();
                }

                return result.data;
            }
        } catch (err: any) {
            this.logger.warn(`Invalid state file. Reset to new state. Cause ${err.message}`);
        }

        return this.createDefaultState();
    }

    private persist(): void {
        const tmpPath = `${this.filePath}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(this.state), { encoding: 'utf-8', mode: 0o600 });
        fs.renameSync(tmpPath, this.filePath);
    }

    private createDefaultState(): ImapPersistedState {
        const startAt = this.resolveStartAtFromConfig();

        return persistedStateSchema.parse({
            startAtKey: startAt.startAtKey,
            startAtValue: startAt.startAtValue,
            fromNowPrimed: startAt.fromNowPrimed,
            minDateMs: startAt.minDateMs,
            criteriaMask: this.toCriteriaMask(this.config.imap.filter.criteria),
        });
    }

    private resolveStartAtFromConfig(): StartAtResolved {
        const configuredStartAt = this.config.imap.startAt ?? ({ type: 'epoch' } as const);

        if (configuredStartAt.type === 'minDate') {
            return {
                startAtKey: 'minDate',
                startAtValue: configuredStartAt.value,
                minDateMs: parseIsoDateToUtcMs(configuredStartAt.value),
                fromNowPrimed: true,
            };
        }

        if (configuredStartAt.type === 'now') {
            return {
                startAtKey: 'now',
                startAtValue: null,
                minDateMs: utcDayStartMs(),
                fromNowPrimed: false,
            };
        }

        return {
            startAtKey: 'epoch',
            startAtValue: null,
            minDateMs: 0,
            fromNowPrimed: true,
        };
    }

    private toCriteriaMask(criteria: ImapSearchCriterium[]): number {
        if (criteria.includes(ImapSearchCriterium.ALL)) {
            return SEEN_MASK | UNSEEN_MASK;
        }

        let mask = 0;

        if (criteria.includes(ImapSearchCriterium.SEEN)) {
            mask |= SEEN_MASK;
        }
        if (criteria.includes(ImapSearchCriterium.UNSEEN)) {
            mask |= UNSEEN_MASK;
        }

        return mask || (SEEN_MASK | UNSEEN_MASK);
    }
}
