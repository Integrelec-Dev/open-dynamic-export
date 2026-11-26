// exponential backoff for re-running SEP2 discovery after losing scope.
//
// the backoff only resets once a recovery has held for healthyAfterMs. A
// recovery that loses scope again straight away, for example because the
// EndDeviceList is readable but a DER or FSA resource still returns 403, keeps
// backing off instead of rebuilding at the minimum delay forever.
export class RediscoverBackoff {
    private readonly minDelayMs: number;
    private readonly maxDelayMs: number;
    private readonly healthyAfterMs: number;
    private delayMs: number;
    private lastRediscoverAt: number | null = null;

    constructor({
        minDelayMs,
        maxDelayMs,
        healthyAfterMs,
    }: {
        minDelayMs: number;
        maxDelayMs: number;
        healthyAfterMs: number;
    }) {
        this.minDelayMs = minDelayMs;
        this.maxDelayMs = maxDelayMs;
        this.healthyAfterMs = healthyAfterMs;
        this.delayMs = minDelayMs;
    }

    // call when scope is lost: how long to wait before re-running discovery
    getDelayMs(now = Date.now()): number {
        if (
            this.lastRediscoverAt !== null &&
            now - this.lastRediscoverAt >= this.healthyAfterMs
        ) {
            // the last recovery held, so this is a new loss of scope
            this.delayMs = this.minDelayMs;
        }

        return this.delayMs;
    }

    // call when discovery is re-run
    onRediscover(now = Date.now()) {
        this.lastRediscoverAt = now;
        this.delayMs = Math.min(this.delayMs * 2, this.maxDelayMs);
    }
}
