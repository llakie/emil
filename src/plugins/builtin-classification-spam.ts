import { z } from 'zod';
import { StepProvider, StepProviderRegistry } from '../types.js';

const spamScoringSchema = z
    .object({
        minScore: z.number().int().nonnegative().default(80),
        weights: z
            .object({
                subjectPattern: z.number().int().nonnegative().default(25),
                headerPattern: z.number().int().nonnegative().default(30),
                senderAddress: z.number().int().nonnegative().default(45),
                senderDomain: z.number().int().nonnegative().default(35),
                authFail: z.number().int().nonnegative().default(60),
            })
            .default({
                subjectPattern: 25,
                headerPattern: 30,
                senderAddress: 45,
                senderDomain: 35,
                authFail: 60,
            }),
    })
    .default({
        minScore: 80,
        weights: {
            subjectPattern: 25,
            headerPattern: 30,
            senderAddress: 45,
            senderDomain: 35,
            authFail: 60,
        },
    });

const spamStepConfigSchema = z
    .object({
        spamHeaders: z.array(z.string()).default([]),
        spamSubjectsPatterns: z.array(z.string()).default([]),
        blockedSenders: z.array(z.string().email()).default([]),
        blockedDomains: z.array(z.string()).default([]),
        trustedSenders: z.array(z.string().email()).default([]),
        trustedDomains: z.array(z.string()).default([]),
        authFailPatterns: z.array(z.string()).default(['spf=fail', 'spf=softfail', 'dkim=fail', 'dmarc=fail']),
        spamFolder: z.string().min(1),
        scoring: spamScoringSchema,
    })
    .strict();

type SpamStepConfig = z.infer<typeof spamStepConfigSchema>;
type SpamClassificationResult = {
    trusted: boolean;
    isSpam: boolean;
    score: number;
    minScore: number;
    reasons: string[];
};

class SpamClassifier {
    private config: SpamStepConfig = spamStepConfigSchema.parse({ spamFolder: 'Spam' });

    public configure(stepConfig: Record<string, unknown>): void {
        this.config = spamStepConfigSchema.parse(stepConfig);
    }

    public getSpamFolder(): string {
        return this.config.spamFolder;
    }

    public classify(message: { subject?: string; source?: string; from: string[] }): SpamClassificationResult {
        const lowerSubject = (message.subject ?? '').toLowerCase();
        const lowerHeaders = this.extractHeaderBlock(message.source).toLowerCase();
        const senders = this.extractSenderAddresses(message.from).map((value) => value.toLowerCase());
        const trustedSenders = this.config.trustedSenders.map((entry) => entry.toLowerCase());
        const blockedSenders = this.config.blockedSenders.map((entry) => entry.toLowerCase());
        const senderDomains = senders
            .map((sender) => sender.split('@')[1] ?? '')
            .filter((domain): domain is string => domain.length > 0);

            const reasons = new Set<string>();
        let score = 0;
        const minScore = this.config.scoring.minScore;

        for (const trustedSender of trustedSenders) {
            if (senders.includes(trustedSender)) {
                return { trusted: true, isSpam: false, score: 0, minScore, reasons: [] };
            }
        }

        for (const trustedDomain of this.config.trustedDomains) {
            if (senderDomains.some((domain) => this.matchesDomainRule(domain, trustedDomain))) {
                return { trusted: true, isSpam: false, score: 0, minScore, reasons: [] };
            }
        }

        for (const pattern of this.config.spamSubjectsPatterns) {
            const reason = `subject:${pattern}`;
            if (!reasons.has(reason) && this.matchPattern(lowerSubject, pattern)) {
                reasons.add(reason);
                score += this.config.scoring.weights.subjectPattern;
            }
        }

        for (const pattern of this.config.spamHeaders) {
            const reason = `header:${pattern}`;
            if (!reasons.has(reason) && this.matchPattern(lowerHeaders, pattern)) {
                reasons.add(reason);
                score += this.config.scoring.weights.headerPattern;
            }
        }

        for (const senderRule of blockedSenders) {
            const reason = `sender:${senderRule}`;
            if (!reasons.has(reason) && senders.includes(senderRule)) {
                reasons.add(reason);
                score += this.config.scoring.weights.senderAddress;
            }
        }

        for (const domainRule of this.config.blockedDomains) {
            const reason = `senderDomain:${domainRule}`;
            if (!reasons.has(reason) && senderDomains.some((domain) => this.matchesDomainRule(domain, domainRule))) {
                reasons.add(reason);
                score += this.config.scoring.weights.senderDomain;
            }
        }

        for (const pattern of this.config.authFailPatterns) {
            const reason = `auth:${pattern}`;
            if (!reasons.has(reason) && this.matchPattern(lowerHeaders, pattern)) {
                reasons.add(reason);
                score += this.config.scoring.weights.authFail;
            }
        }

        return {
            trusted: false,
            isSpam: score >= minScore,
            score,
            minScore,
            reasons: Array.from(reasons),
        };
    }

    private matchPattern(target: string, pattern: string): boolean {
        if (!target || !pattern) {
            return false;
        }

        try {
            return new RegExp(pattern, 'i').test(target);
        } catch {
            return target.includes(pattern.toLowerCase());
        }
    }

    private extractHeaderBlock(source?: string): string {
        if (!source) {
            return '';
        }

        const separatorIndex = source.search(/\r?\n\r?\n/);
        if (separatorIndex < 0) {
            return source;
        }

        return source.slice(0, separatorIndex);
    }

    private extractSenderAddresses(fromEntries: string[]): string[] {
        return fromEntries
            .map((entry) => this.extractAddress(entry))
            .filter((entry): entry is string => entry !== null);
    }

    private extractAddress(value: string): string | null {
        const trimmed = value.trim();
        if (!trimmed) {
            return null;
        }

        const wrappedMatch = trimmed.match(/<([^>]+)>/);
        const candidate = (wrappedMatch?.[1] ?? trimmed).trim();

        if (!candidate.includes('@')) {
            return null;
        }

        return candidate;
    }

    private matchesDomainRule(domain: string, rule: string): boolean {
        const normalizedRule = rule.trim().toLowerCase().replace(/^@/, '');
        if (!normalizedRule) {
            return false;
        }

        try {
            return new RegExp(normalizedRule, 'i').test(domain);
        } catch {
            return domain === normalizedRule || domain.endsWith(`.${normalizedRule}`);
        }
    }
}

class SpamStepProvider {
    public static createInstance(): StepProvider {
        const classifier = new SpamClassifier();

        return async ({ message, stepConfig, logger, imap }) => {
            let classificationResult: SpamClassificationResult;

            try {
                classifier.configure(stepConfig);
                classificationResult = classifier.classify(message);
            } catch (err) {
                logger.warn(`Spam classification failed for UID=${message.uid}. Continuing pipeline.`, { err });
                return 'continue';
            }

            if (classificationResult.trusted || !classificationResult.isSpam) {
                return 'continue';
            }

            const spamFolder = classifier.getSpamFolder();

            try {
                await imap.moveMessage(message.uid, spamFolder);
                logger.info(`Spam matched and moved UID=${message.uid} to "${spamFolder}"`, {
                    reasons: classificationResult.reasons,
                    score: classificationResult.score,
                    minScore: classificationResult.minScore,
                });
                return 'ack';
            } catch (err) {
                logger.error(`Failed to move spam UID=${message.uid} to "${spamFolder}"`, { err });
                return 'nack';
            }
        };
    }
}

export function registerProviders(registry: StepProviderRegistry): void {
    registry.registerProvider('builtin:classification.spam', SpamStepProvider.createInstance());
}
