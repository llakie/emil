import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ImapStateStore } from './imapStateStore.js';
import { Config, ImapSearchCriterium } from './types.js';
import { parseIsoDateToUtcMs, utcDayStartMs } from './util.js';

function createTempConfig(overrides?: Partial<Config>): Config {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emil-state-'));
    const filePath = path.join(dir, 'imap-state.json');

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
            storage: { filePath },
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

describe('ImapStateStore attempts', () => {
    test('increments attempts per UID and resets on new UID', () => {
        const config = createTempConfig();
        const store = new ImapStateStore(config);

        expect(store.incrementAttempt(10)).toBe(1);
        expect(store.incrementAttempt(10)).toBe(2);

        const stateAfterSame = store.getState();
        expect(stateAfterSame.currentAttemptUid).toBe(10);
        expect(stateAfterSame.currentAttempt).toBe(2);

        expect(store.incrementAttempt(11)).toBe(1);
        const stateAfterNew = store.getState();
        expect(stateAfterNew.currentAttemptUid).toBe(11);
        expect(stateAfterNew.currentAttempt).toBe(1);
    });

    test('resetAttempt only clears when UID matches', () => {
        const config = createTempConfig();
        const store = new ImapStateStore(config);

        store.incrementAttempt(20);
        store.resetAttempt(99);

        let state = store.getState();
        expect(state.currentAttemptUid).toBe(20);
        expect(state.currentAttempt).toBe(1);

        store.resetAttempt(20);
        state = store.getState();
        expect(state.currentAttemptUid).toBeNull();
        expect(state.currentAttempt).toBe(0);
    });

    test('persists current attempt across reload', () => {
        const config = createTempConfig();
        const store = new ImapStateStore(config);
        store.incrementAttempt(42);

        const reloaded = new ImapStateStore(config);
        const state = reloaded.getState();
        expect(state.currentAttemptUid).toBe(42);
        expect(state.currentAttempt).toBe(1);
    });
});

describe('ImapStateStore state handling', () => {
    test('resets state when startAt changes', () => {
        const config = createTempConfig();
        const store = new ImapStateStore(config);
        store.addProcessedUid(99);

        const changed: Config = {
            ...config,
            imap: {
                ...config.imap,
                startAt: { type: 'now' },
            },
        };

        const reloaded = new ImapStateStore(changed);
        const state = reloaded.getState();
        expect(state.processedUids).toEqual([]);
        expect(state.startAtKey).toBe('now');
        expect(state.fromNowPrimed).toBe(false);
    });

    test('resets state when criteria mask changes', () => {
        const config = createTempConfig();
        const store = new ImapStateStore(config);
        store.addProcessedUid(10);

        const changed: Config = {
            ...config,
            imap: {
                ...config.imap,
                filter: { criteria: [ImapSearchCriterium.SEEN] },
            },
        };

        const reloaded = new ImapStateStore(changed);
        const state = reloaded.getState();
        expect(state.processedUids).toEqual([]);
        expect(state.criteriaMask).toBe(1);
    });

    test('falls back to default state on invalid JSON', () => {
        const config = createTempConfig();
        fs.writeFileSync(config.imap.storage.filePath, '{not json');

        const store = new ImapStateStore(config);
        const state = store.getState();
        expect(state.startAtKey).toBe('epoch');
        expect(state.processedUids).toEqual([]);
    });

    test('setUidValidity resets state and stores uidValidity', () => {
        const config = createTempConfig();
        const store = new ImapStateStore(config);
        store.addProcessedUid(123);

        const state = store.setUidValidity(42n);
        expect(state.uidValidity).toBe('42');
        expect(state.processedUids).toEqual([]);
    });

    test('markFromNowPrimed toggles flag only when needed', () => {
        const base = createTempConfig();
        const config: Config = {
            ...base,
            imap: {
                ...base.imap,
                startAt: { type: 'now' },
            },
        };
        const store = new ImapStateStore(config);
        let state = store.getState();
        expect(state.fromNowPrimed).toBe(false);

        store.markFromNowPrimed();
        state = store.getState();
        expect(state.fromNowPrimed).toBe(true);

        store.markFromNowPrimed();
        state = store.getState();
        expect(state.fromNowPrimed).toBe(true);
    });

    test('resolves startAt minDate and now correctly', () => {
        const minDate = '2026-02-01';
        const baseMin = createTempConfig();
        const configMin: Config = {
            ...baseMin,
            imap: {
                ...baseMin.imap,
                startAt: { type: 'minDate', value: minDate },
            },
        };
        const storeMin = new ImapStateStore(configMin);
        const stateMin = storeMin.getState();
        expect(stateMin.startAtKey).toBe('minDate');
        expect(stateMin.startAtValue).toBe(minDate);
        expect(stateMin.minDateMs).toBe(parseIsoDateToUtcMs(minDate));

        const baseNow = createTempConfig();
        const configNow: Config = {
            ...baseNow,
            imap: {
                ...baseNow.imap,
                startAt: { type: 'now' },
            },
        };
        const storeNow = new ImapStateStore(configNow);
        const stateNow = storeNow.getState();
        expect(stateNow.startAtKey).toBe('now');
        expect(stateNow.minDateMs).toBe(utcDayStartMs());
        expect(stateNow.fromNowPrimed).toBe(false);
    });

    test('toCriteriaMask handles different criteria', () => {
        const config = createTempConfig();
        const store = new ImapStateStore(config);
        const toMask = (store as unknown as { toCriteriaMask: (c: ImapSearchCriterium[]) => number }).toCriteriaMask.bind(
            store,
        );

        expect(toMask([ImapSearchCriterium.ALL])).toBe(3);
        expect(toMask([ImapSearchCriterium.SEEN])).toBe(1);
        expect(toMask([ImapSearchCriterium.UNSEEN])).toBe(2);
        expect(toMask([])).toBe(3);
    });
});
