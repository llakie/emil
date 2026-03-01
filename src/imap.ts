import { FetchMessageObject, ImapFlow, SearchObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import { Config, ImapNextMessageResult, ImapSearchCriterium, ImapStepClient } from './types.js';
import { ImapPersistedState, ImapStateStore } from './imapStateStore.js';
import { toUnixMs, utcDayStartMs, UTC_DAY_MS } from './util.js';
import { Logger } from './logger.js';

type MessageRefRange = {
    startUtcMs: number;
    endUtcMs: number;
    sortedMessageUids: number[] | null;
};

export class Imap {
    private readonly stateStore: ImapStateStore;
    private client: ImapFlow | null = null;
    private inFlightUid: number | null = null;
    private currentUidValidity: bigint = 0n;
    private logger: Logger;
    private messageRefRange: MessageRefRange = {
        startUtcMs: 0,
        endUtcMs: 0,
        sortedMessageUids: null
    };

    constructor(private readonly config: Config) {
        this.stateStore = new ImapStateStore(this.config);
        this.logger = new Logger();
    }

    public async getNextMessage(): Promise<ImapNextMessageResult | null> {
        const client = await this.ensureConnected();
        
        let state = this.stateStore.getState();
        const todayStartMs = utcDayStartMs();

        if (this.currentUidValidity.toString() !== state.uidValidity) {
            state = this.stateStore.setUidValidity(this.currentUidValidity);
        }

        if (this.inFlightUid !== null) {
            throw new Error(`Message UID ${this.inFlightUid} is still in processing. Call ack() or nack() first.`);
        }

        if (state.rangeStartMs === null || state.rangeEndMs === null) {
            if (state.startAtKey === 'now') {
                state = this.stateStore.setWindow(todayStartMs, todayStartMs + UTC_DAY_MS);
            } else {
                state = this.stateStore.setWindow(state.minDateMs, todayStartMs);
            }
        }

        this.syncMessageRefRange(state);

        if (state.startAtKey === 'now' && !state.fromNowPrimed) {
            const baselineUids = await this.getSortedMessageUids(client, this.messageRefRange);

            for (const uid of baselineUids) {
                this.stateStore.addProcessedUid(uid);
            }

            this.stateStore.markFromNowPrimed();

            return null;
        }

        let next = await this.getNextMessageInWindow(client, state, this.messageRefRange);

        if (next !== null) {
            return next;
        }

        this.messageRefRange.startUtcMs = todayStartMs;
        this.messageRefRange.endUtcMs = this.messageRefRange.startUtcMs + UTC_DAY_MS;

        if (state.rangeStartMs === this.messageRefRange.startUtcMs && state.rangeEndMs === this.messageRefRange.endUtcMs) {
            // Because it was already checked
            return null;
        }
        
        state = this.stateStore.setWindow(this.messageRefRange.startUtcMs, this.messageRefRange.endUtcMs);
        this.syncMessageRefRange(state);

        return await this.getNextMessageInWindow(client, state, this.messageRefRange);
    }

    private syncMessageRefRange(state: ImapPersistedState): void {
        if (state.rangeStartMs === null || state.rangeEndMs === null) {
            this.messageRefRange.startUtcMs = 0;
            this.messageRefRange.endUtcMs = 0;
            this.messageRefRange.sortedMessageUids = null;
            return;
        }

        const rangesChanged = this.messageRefRange.startUtcMs !== state.rangeStartMs || this.messageRefRange.endUtcMs !== state.rangeEndMs;

        if (rangesChanged) {
            this.messageRefRange.startUtcMs = state.rangeStartMs;
            this.messageRefRange.endUtcMs = state.rangeEndMs;
            this.messageRefRange.sortedMessageUids = null;
        }
    }

    private async getNextMessageInWindow(client: ImapFlow, state: ImapPersistedState, messageRefRange: MessageRefRange): Promise<ImapNextMessageResult | null> {
        if (utcDayStartMs() === messageRefRange.startUtcMs) {
            messageRefRange.sortedMessageUids = await this.getSortedMessageUids(client, messageRefRange);
        } else {
            if (messageRefRange.sortedMessageUids === null) {
                messageRefRange.sortedMessageUids = await this.getSortedMessageUids(client, messageRefRange);
            }
        }

        if (messageRefRange.sortedMessageUids.length === 0) {
            return null;
        }

        const processedUids = new Set(state.processedUids);

        const nextMessageUids = messageRefRange.sortedMessageUids.filter(potentialRef => !processedUids.has(potentialRef));

        if (nextMessageUids.length === 0) {
            return null;
        }

        for (const nextMessageUid of nextMessageUids) {
            const nextMessage = await client.fetchOne(String(nextMessageUid), this.getFullFetchQuery(), { uid: true });

            if (nextMessage === false) {
                this.logger.warn(`Skipping mail ${nextMessageUid}`);
                this.stateStore.addProcessedUid(nextMessageUid);
                continue;
            }

            return this.createResult(nextMessage, (uid: number) => {
                this.stateStore.addProcessedUid(uid);
                this.clearInflightId();
            }, (_uid: number) => {
                this.clearInflightId();
            });
        }

        return null;
    }

    private async getSortedMessageUids(client: ImapFlow, messageRefRange: MessageRefRange): Promise<number[]> {
        // We are at the current day, so fetch all message uids again since there might be new E-Mails
        const uids = await client.search(this.buildWindowSearchQuery(messageRefRange.startUtcMs, messageRefRange.endUtcMs), { uid: true });
        
        if (!uids || uids.length === 0) {
            return [];
        }

        return await this.loadSortedMessageUids(client, uids, messageRefRange.startUtcMs);
    }

    private async loadSortedMessageUids(
        client: ImapFlow,
        candidateUids: number[],
        fallbackDateMs: number
    ): Promise<number[]> {
        const candidates: Array<{ uid: number; internalDateMs: number }> = [];
        const returnedUids = new Set<number>();

        for await (const message of client.fetch(candidateUids, { uid: true, internalDate: true }, { uid: true })) {
            returnedUids.add(message.uid);
            candidates.push({ uid: message.uid, internalDateMs: toUnixMs(message.internalDate) ?? fallbackDateMs });
        }

        for (const uid of candidateUids) {
            if (!returnedUids.has(uid)) {
                this.stateStore.addProcessedUid(uid);
            }
        }

        candidates.sort((a, b) => a.internalDateMs - b.internalDateMs || a.uid - b.uid);

        return candidates.map((candidate) => candidate.uid);
    }

    private async createResult(
        message: FetchMessageObject,
        onAck: (uid: number) => void,
        onNack: (uid: number) => void,
    ): Promise<ImapNextMessageResult> {
        this.inFlightUid = message.uid;
        const parsedBody = await this.parseMessageBody(message.source);

        let processed = false;

        return {
            message: {
                uid: message.uid,
                subject: message.envelope?.subject,
                messageId: message.envelope?.messageId,
                from: this.addressesToStrings(message.envelope?.from),
                to: this.addressesToStrings(message.envelope?.to),
                date: toUnixMs(message.envelope?.date),
                internalDate: toUnixMs(message.internalDate),
                size: message.size,
                seen: message.flags?.has('\\Seen') ?? false,
                flags: message.flags ? Array.from(message.flags) : [],
                text: parsedBody.text,
                html: parsedBody.html,
                bodyParsed: parsedBody.ok,
                bodyParseError: parsedBody.error,
                source: message.source ? message.source.toString('utf-8') : undefined,
            },
            ack: () => {
                if (processed) {
                    return;
                }

                onAck(message.uid);
                processed = true;
            },
            nack: () => {
                if (processed) {
                    return;
                }

                onNack(message.uid);
                processed = true;
            },
        };
    }

    private clearInflightId(): void {
        this.inFlightUid = null;
    }

    private addressesToStrings(
        addresses?: Array<{
            name?: string;
            address?: string;
        }>,
    ): string[] {
        if (!addresses || addresses.length === 0) {
            return [];
        }

        return addresses
            .map((entry) => {
                if (entry.name && entry.address) {
                    return `${entry.name} <${entry.address}>`;
                }
                return entry.address || entry.name || '';
            })
            .filter((value) => value.length > 0);
    }

    private async parseMessageBody(
        source: Buffer | undefined,
    ): Promise<{ ok: boolean; text?: string; html?: string; error?: string }> {
        if (!source) {
            return { ok: false, error: 'Message source is missing' };
        }

        try {
            const parsed = await simpleParser(source);
            return {
                ok: true,
                text: parsed.text || undefined,
                html: typeof parsed.html === 'string' ? parsed.html : undefined,
            };
        } catch (err) {
            return {
                ok: false,
                error: err instanceof Error ? err.message : 'Unknown parser error',
            };
        }
    }

    public async close(): Promise<void> {
        if (!this.client) {
            return;
        }

        try {
            await this.client.logout();
        } finally {
            this.client = null;
        }
    }

    public getStepClient(): ImapStepClient {
        return {
            moveMessage: async (uid: number, destinationFolder: string) => {
                await this.moveMessage(uid, destinationFolder);
            },
            deleteMessage: async (uid: number) => {
                await this.deleteMessage(uid);
            },
            addFlags: async (uid: number, flags: string[]) => {
                await this.addFlags(uid, flags);
            },
            removeFlags: async (uid: number, flags: string[]) => {
                await this.removeFlags(uid, flags);
            },
            getSourceFolder: () => {
                return this.config.imap.folder;
            },
        };
    }

    public async moveMessage(uid: number, destinationFolder: string): Promise<void> {
        const client = await this.ensureConnected();
        const moved = await client.messageMove(String(uid), destinationFolder, { uid: true });

        if (moved === false) {
            throw new Error(`Could not move UID ${uid} to ${destinationFolder}`);
        }
    }

    public async deleteMessage(uid: number): Promise<void> {
        const client = await this.ensureConnected();
        const deleted = await client.messageDelete(String(uid), { uid: true });

        if (!deleted) {
            throw new Error(`Could not delete UID ${uid}`);
        }
    }

    public async addFlags(uid: number, flags: string[]): Promise<void> {
        const client = await this.ensureConnected();
        const success = await client.messageFlagsAdd(String(uid), flags, { uid: true });

        if (!success) {
            throw new Error(`Could not add flags to UID ${uid}`);
        }
    }

    public async removeFlags(uid: number, flags: string[]): Promise<void> {
        const client = await this.ensureConnected();
        const success = await client.messageFlagsRemove(String(uid), flags, { uid: true });

        if (!success) {
            throw new Error(`Could not remove flags from UID ${uid}`);
        }
    }

    private getFullFetchQuery() {
        const maxFetchBytes = this.config.imap.options.maxFetchBytes;
        return {
            uid: true,
            envelope: true,
            internalDate: true,
            flags: true,
            size: true,
            source: maxFetchBytes ? { start: 0, maxLength: maxFetchBytes } : true,
        } as const;
    }

    private buildWindowSearchQuery(rangeStartMs: number, rangeEndMs: number): SearchObject {
        const query: SearchObject = {
            // Use ISO UTC strings to avoid local-time re-parse drift in imapflow.
            since: new Date(rangeStartMs).toISOString(),
            before: new Date(rangeEndMs).toISOString(),
        };

        this.applyCriteria(query);
        return query;
    }

    private applyCriteria(query: SearchObject): void {
        const criteria = new Set(this.config.imap.filter.criteria);

        if (criteria.has(ImapSearchCriterium.ALL)) {
            return;
        }

        const includesSeen = criteria.has(ImapSearchCriterium.SEEN);
        const includesUnseen = criteria.has(ImapSearchCriterium.UNSEEN);

        if (includesSeen && !includesUnseen) {
            query.seen = true;
            return;
        }

        if (!includesSeen && includesUnseen) {
            query.seen = false;
        }
    }

    private async ensureConnected(): Promise<ImapFlow> {
        if (this.client?.usable) {
            return this.client;
        }

        const resolvedPassword = this.resolveImapPassword();

        if (!resolvedPassword) {
            throw new Error('IMAP password is missing: set imap.pass or imap.passEnv');
        }

        const client = new ImapFlow({
            host: this.config.imap.host,
            port: this.config.imap.port,
            secure: this.config.imap.secure,
            auth: {
                user: this.config.imap.user,
                pass: resolvedPassword,
            },
            logger: false,
        });

        await client.connect();

        const mailbox = await client.mailboxOpen(this.config.imap.folder);

        if (!mailbox.uidValidity) {
            throw new Error(`Cannot ensure mailbox mail index integrity`);
        }

        this.currentUidValidity = mailbox.uidValidity;
        this.client = client;

        return client;
    }

    private resolveImapPassword(): string | null {
        if (this.config.imap.pass) {
            return this.config.imap.pass;
        }

        if (this.config.imap.passEnv) {
            return process.env[this.config.imap.passEnv] ?? null;
        }

        return null;
    }
}
