import { describe, expect, it } from 'vitest';
import { RediscoverBackoff } from './rediscoverBackoff.js';

function createBackoff() {
    return new RediscoverBackoff({
        minDelayMs: 5_000,
        maxDelayMs: 300_000,
        healthyAfterMs: 300_000,
    });
}

describe('RediscoverBackoff', () => {
    it('should start at the minimum delay', () => {
        const backoff = createBackoff();

        expect(backoff.getDelayMs(0)).toBe(5_000);
    });

    it('should keep backing off while each recovery loses scope straight away', () => {
        const backoff = createBackoff();
        let now = 0;
        const delays: number[] = [];

        // the EndDeviceList recovers but a DER or FSA resource returns 403
        // within a few seconds of every rebuild
        for (let i = 0; i < 8; i++) {
            const delayMs = backoff.getDelayMs(now);
            delays.push(delayMs);

            now += delayMs;
            backoff.onRediscover(now);
            now += 2_000;
        }

        expect(delays).toStrictEqual([
            5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000,
        ]);
    });

    it('should not reset while waiting out the maximum delay', () => {
        const backoff = createBackoff();
        let now = 0;

        for (let i = 0; i < 7; i++) {
            now += backoff.getDelayMs(now);
            backoff.onRediscover(now);
            now += 2_000;
        }

        // scope is lost again 2s after a rebuild, even though the previous
        // wait was the full 300s
        expect(backoff.getDelayMs(now)).toBe(300_000);
    });

    it('should reset once a recovery has held', () => {
        const backoff = createBackoff();
        let now = 0;

        for (let i = 0; i < 4; i++) {
            now += backoff.getDelayMs(now);
            backoff.onRediscover(now);
            now += 2_000;
        }

        expect(backoff.getDelayMs(now)).toBe(80_000);

        now += backoff.getDelayMs(now);
        backoff.onRediscover(now);

        // the next loss of scope comes long after the last rebuild
        now += 300_000;

        expect(backoff.getDelayMs(now)).toBe(5_000);
    });
});
