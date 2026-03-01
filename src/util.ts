export function parseIsoDateToUtcMs(value: string): number {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);

    if (!match) {
        throw new Error(`Invalid minDate "${value}". Expected format YYYY-MM-DD.`);
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);

    return Date.UTC(year, month - 1, day, 0, 0, 0, 0);
}

export const UTC_DAY_MS = 24 * 60 * 60 * 1000;

export function utcDayStartMs(value: number | Date = Date.now()): number {
    const date = value instanceof Date ? value : new Date(value);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0);
}

export function toUnixMs(value: Date | string | undefined): number | undefined {
    if (!value) {
        return undefined;
    }

    const ms = value instanceof Date ? value.getTime() : Date.parse(value);

    if (!Number.isFinite(ms)) {
        return undefined;
    }

    return ms;
}

export function applyJitterToDelayMs(baseMs: number, ratio = 0.2): number {
    const minFactor = Math.max(0, 1 - ratio);
    const maxFactor = 1 + ratio;
    const factor = minFactor + Math.random() * (maxFactor - minFactor);
    return Math.max(0, Math.floor(baseMs * factor));
}
