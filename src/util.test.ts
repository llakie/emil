import { jest } from '@jest/globals';
import { applyJitterToDelayMs, parseIsoDateToUtcMs, toUnixMs, utcDayStartMs } from './util.js';

describe('util', () => {
    test('parseIsoDateToUtcMs parses YYYY-MM-DD', () => {
        const ms = parseIsoDateToUtcMs('2026-01-02');
        expect(ms).toBe(Date.UTC(2026, 0, 2, 0, 0, 0, 0));
    });

    test('parseIsoDateToUtcMs rejects invalid format', () => {
        expect(() => parseIsoDateToUtcMs('2026-1-2')).toThrow(/Invalid minDate/);
    });

    test('utcDayStartMs returns midnight UTC', () => {
        const date = new Date(Date.UTC(2026, 4, 5, 12, 34, 56));
        expect(utcDayStartMs(date)).toBe(Date.UTC(2026, 4, 5, 0, 0, 0, 0));
    });

    test('toUnixMs returns ms for Date and undefined for invalid input', () => {
        const date = new Date('2026-03-05T10:00:00Z');
        expect(toUnixMs(date)).toBe(date.getTime());
        expect(toUnixMs('not-a-date')).toBeUndefined();
        expect(toUnixMs(undefined)).toBeUndefined();
    });

    test('applyJitterToDelayMs respects min and max factors', () => {
        const spy = jest.spyOn(Math, 'random');

        spy.mockReturnValue(0);
        expect(applyJitterToDelayMs(1000, 0.2)).toBe(800);

        spy.mockReturnValue(1);
        expect(applyJitterToDelayMs(1000, 0.2)).toBe(1200);

        spy.mockRestore();
    });
});
