import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockCert, mockKey } from '../../../tests/sep2/cert.js';
import { SEP2Client } from '../client.js';
import { FunctionSetAssignmentsListHelper } from './functionSetAssignmentsList.js';

const { cacheGet } = vi.hoisted(() => ({ cacheGet: vi.fn() }));

vi.mock('../../helpers/fileCache.js', () => ({
    createFileCache: () => ({
        get: cacheGet,
        set: vi.fn(),
    }),
}));

const sep2Client = new SEP2Client({
    host: 'http://example.com',
    cert: mockCert,
    key: mockKey,
    pen: '12345',
});

beforeEach(() => {
    cacheGet.mockReset();
    cacheGet.mockResolvedValue({ lfdi: sep2Client.lfdi, data: [] });
});

describe('FunctionSetAssignmentsListHelper', () => {
    it('should emit the cached data by default', async () => {
        const onData = vi.fn();

        new FunctionSetAssignmentsListHelper({ client: sep2Client }).on(
            'data',
            onData,
        );

        await vi.waitFor(() => {
            expect(onData).toHaveBeenCalledWith([]);
        });
    });

    it('should not load the cache when asked not to', async () => {
        const onData = vi.fn();

        new FunctionSetAssignmentsListHelper({
            client: sep2Client,
            loadCache: false,
        }).on('data', onData);

        // long enough for a cached emit to have happened
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(cacheGet).not.toHaveBeenCalled();
        expect(onData).not.toHaveBeenCalled();
    });
});
