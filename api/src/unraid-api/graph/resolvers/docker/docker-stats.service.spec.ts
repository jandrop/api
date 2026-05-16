import { Test, TestingModule } from '@nestjs/testing';
import { PassThrough } from 'stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pubsub, PUBSUB_CHANNEL } from '@app/core/pubsub.js';
import { DockerStatsService } from '@app/unraid-api/graph/resolvers/docker/docker-stats.service.js';

// Match the pattern used by docker-event.service.spec.ts: silence the
// Nest decorators / Logger so the service can be instantiated in
// isolation without bootstrapping the whole module graph.
vi.mock('@nestjs/common', async () => {
    const actual = await vi.importActual('@nestjs/common');
    return {
        ...actual,
        Injectable: () => vi.fn(),
        Logger: vi.fn().mockImplementation(() => ({
            debug: vi.fn(),
            error: vi.fn(),
            log: vi.fn(),
        })),
    };
});

vi.mock('@app/core/pubsub.js', () => ({
    pubsub: {
        publish: vi.fn().mockResolvedValue(undefined),
    },
    PUBSUB_CHANNEL: {
        DOCKER_STATS: 'DOCKER_STATS',
    },
}));

// The Docker client returned by `getDockerClient`. Each test will swap
// out the per-container `stats()` stream and the events stream so it
// can drive different behaviours.
const mockListContainers = vi.fn();
const mockGetContainer = vi.fn();
const mockGetEvents = vi.fn();
const mockDockerClient = {
    listContainers: mockListContainers,
    getContainer: mockGetContainer,
    getEvents: mockGetEvents,
};

vi.mock('@app/unraid-api/graph/resolvers/docker/utils/docker-client.js', () => ({
    getDockerClient: vi.fn(() => mockDockerClient),
}));

/**
 * Builds a Docker stats JSON chunk shaped like the real
 * `/containers/<id>/stats` socket payload. The defaults are intentionally
 * realistic so a chunk emitted through {@link emitStats} matches what the
 * service expects in production.
 */
const buildStatsChunk = (overrides: Record<string, unknown> = {}) => ({
    read: '2026-05-16T10:00:00Z',
    // 0.5s of CPU time on a 2-core host with 1s system delta → 25% cpuPercent
    cpu_stats: {
        cpu_usage: { total_usage: 500_000_000 },
        system_cpu_usage: 2_000_000_000,
        online_cpus: 2,
    },
    precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0, online_cpus: 2 },
    memory_stats: { usage: 200, limit: 1000, stats: { cache: 50 } }, // used = 150
    networks: { eth0: { rx_bytes: 1024, tx_bytes: 512 } },
    blkio_stats: {
        io_service_bytes_recursive: [
            { op: 'Read', value: 4096 },
            { op: 'Write', value: 2048 },
        ],
    },
    ...overrides,
});

/** Wait one event-loop tick so stream listeners run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Builds a per-container stats stream that the mocked
 * `docker.getContainer(id).stats({stream: true})` resolves to. Returns
 * the PassThrough so tests can write JSON chunks into it.
 */
const makeStatsStream = () => new PassThrough();

describe('DockerStatsService', () => {
    let service: DockerStatsService;
    let module: TestingModule;
    let containerStreams: Map<string, PassThrough>;
    let eventsStream: PassThrough;

    beforeEach(async () => {
        containerStreams = new Map();
        eventsStream = new PassThrough();

        mockGetEvents.mockResolvedValue(eventsStream);
        mockListContainers.mockResolvedValue([]);
        // Each `getContainer(id)` returns a stats() that resolves to a
        // fresh PassThrough we track per-id so tests can write into it.
        mockGetContainer.mockImplementation((id: string) => ({
            stats: vi.fn().mockImplementation(async () => {
                const stream = makeStatsStream();
                containerStreams.set(id, stream);
                return stream;
            }),
        }));

        module = await Test.createTestingModule({
            providers: [DockerStatsService],
        }).compile();

        service = module.get<DockerStatsService>(DockerStatsService);
    });

    afterEach(() => {
        service.stopStatsStream();
        vi.clearAllMocks();
        module.close();
    });

    it('is defined', () => {
        expect(service).toBeDefined();
    });

    it('opens a stats stream for every running container reported by listContainers', async () => {
        mockListContainers.mockResolvedValue([{ Id: 'aaa' }, { Id: 'bbb' }]);

        await service.startStatsStream();
        await flush();

        expect(mockGetContainer).toHaveBeenCalledWith('aaa');
        expect(mockGetContainer).toHaveBeenCalledWith('bbb');
        expect(containerStreams.size).toBe(2);
    });

    it('publishes a normalised stats payload when the socket pushes a chunk', async () => {
        mockListContainers.mockResolvedValue([{ Id: 'aaa' }]);

        await service.startStatsStream();
        await flush();

        const stream = containerStreams.get('aaa')!;
        stream.write(JSON.stringify(buildStatsChunk()));
        await flush();

        expect(pubsub.publish).toHaveBeenCalledTimes(1);
        const [channel, payload] = (pubsub.publish as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(channel).toBe(PUBSUB_CHANNEL.DOCKER_STATS);
        // Shape contract — anything more specific is tested below.
        expect(payload).toEqual({
            dockerContainerStats: expect.objectContaining({
                id: 'aaa',
                cpuPercent: expect.any(Number),
                memUsage: expect.any(String),
                memPercent: expect.any(Number),
                netIO: expect.any(String),
                blockIO: expect.any(String),
            }),
        });
    });

    it('computes cpuPercent with the standard docker stats formula', async () => {
        mockListContainers.mockResolvedValue([{ Id: 'aaa' }]);
        await service.startStatsStream();
        await flush();

        // cpu_delta = 500_000_000, system_delta = 2_000_000_000, cores = 2
        // → (500M / 2_000M) * 2 * 100 = 50%
        containerStreams.get('aaa')!.write(JSON.stringify(buildStatsChunk()));
        await flush();

        const payload = (pubsub.publish as ReturnType<typeof vi.fn>).mock.calls[0][1];
        expect(payload.dockerContainerStats.cpuPercent).toBeCloseTo(50, 5);
    });

    it('returns 0 cpuPercent when the system delta is non-positive (first sample edge case)', async () => {
        mockListContainers.mockResolvedValue([{ Id: 'aaa' }]);
        await service.startStatsStream();
        await flush();

        // Equal current + prev → both deltas are zero → must not divide by zero.
        containerStreams.get('aaa')!.write(
            JSON.stringify(
                buildStatsChunk({
                    cpu_stats: {
                        cpu_usage: { total_usage: 100 },
                        system_cpu_usage: 1000,
                        online_cpus: 4,
                    },
                    precpu_stats: {
                        cpu_usage: { total_usage: 100 },
                        system_cpu_usage: 1000,
                        online_cpus: 4,
                    },
                })
            )
        );
        await flush();

        const payload = (pubsub.publish as ReturnType<typeof vi.fn>).mock.calls[0][1];
        expect(payload.dockerContainerStats.cpuPercent).toBe(0);
    });

    it('subtracts cache from memory usage so the value matches what docker stats CLI shows', async () => {
        mockListContainers.mockResolvedValue([{ Id: 'aaa' }]);
        await service.startStatsStream();
        await flush();

        // usage=200, cache=50 → used=150, limit=1000 → 15%
        containerStreams.get('aaa')!.write(JSON.stringify(buildStatsChunk()));
        await flush();

        const payload = (pubsub.publish as ReturnType<typeof vi.fn>).mock.calls[0][1];
        expect(payload.dockerContainerStats.memPercent).toBeCloseTo(15, 5);
    });

    it('treats a missing memory limit as 0% to avoid NaN', async () => {
        mockListContainers.mockResolvedValue([{ Id: 'aaa' }]);
        await service.startStatsStream();
        await flush();

        containerStreams
            .get('aaa')!
            .write(
                JSON.stringify(
                    buildStatsChunk({ memory_stats: { usage: 200, limit: 0, stats: { cache: 0 } } })
                )
            );
        await flush();

        const payload = (pubsub.publish as ReturnType<typeof vi.fn>).mock.calls[0][1];
        expect(payload.dockerContainerStats.memPercent).toBe(0);
    });

    it('sums rx/tx bytes across every network interface', async () => {
        mockListContainers.mockResolvedValue([{ Id: 'aaa' }]);
        await service.startStatsStream();
        await flush();

        containerStreams.get('aaa')!.write(
            JSON.stringify(
                buildStatsChunk({
                    networks: {
                        eth0: { rx_bytes: 1_000_000, tx_bytes: 500_000 },
                        eth1: { rx_bytes: 2_000_000, tx_bytes: 1_500_000 },
                    },
                })
            )
        );
        await flush();

        const payload = (pubsub.publish as ReturnType<typeof vi.fn>).mock.calls[0][1];
        // 3MB rx / 2MB tx — formatter rounds with one decimal at the MB boundary.
        expect(payload.dockerContainerStats.netIO).toMatch(/MB.*\/.*MB/);
    });

    it('reports 0B/0B netIO for host-networked containers (no networks field)', async () => {
        mockListContainers.mockResolvedValue([{ Id: 'aaa' }]);
        await service.startStatsStream();
        await flush();

        const chunk = buildStatsChunk();
        delete (chunk as Record<string, unknown>).networks;
        containerStreams.get('aaa')!.write(JSON.stringify(chunk));
        await flush();

        const payload = (pubsub.publish as ReturnType<typeof vi.fn>).mock.calls[0][1];
        expect(payload.dockerContainerStats.netIO).toBe('0B / 0B');
    });

    it('sums blkio read/write bytes', async () => {
        mockListContainers.mockResolvedValue([{ Id: 'aaa' }]);
        await service.startStatsStream();
        await flush();

        containerStreams.get('aaa')!.write(
            JSON.stringify(
                buildStatsChunk({
                    blkio_stats: {
                        io_service_bytes_recursive: [
                            { op: 'Read', value: 1_000_000 },
                            { op: 'read', value: 500_000 }, // lower-case is also accepted by some kernels
                            { op: 'Write', value: 2_000_000 },
                        ],
                    },
                })
            )
        );
        await flush();

        const payload = (pubsub.publish as ReturnType<typeof vi.fn>).mock.calls[0][1];
        // 1.5MB read, 2MB write — formatter renders with binary units.
        expect(payload.dockerContainerStats.blockIO).toMatch(/MB.*\/.*MB/);
    });

    it('opens a new stats stream when a docker `start` event fires for a fresh container', async () => {
        await service.startStatsStream();
        await flush();
        expect(mockGetContainer).not.toHaveBeenCalled();

        eventsStream.write(JSON.stringify({ Type: 'container', Action: 'start', id: 'new-one' }));
        await flush();

        expect(mockGetContainer).toHaveBeenCalledWith('new-one');
        expect(containerStreams.size).toBe(1);
    });

    it.each(['die', 'stop', 'kill', 'destroy'])(
        'tears the stream down on a docker `%s` event',
        async (action) => {
            mockListContainers.mockResolvedValue([{ Id: 'aaa' }]);
            await service.startStatsStream();
            await flush();

            const stream = containerStreams.get('aaa')!;
            const destroySpy = vi.spyOn(stream, 'destroy');

            eventsStream.write(JSON.stringify({ Type: 'container', Action: action, id: 'aaa' }));
            await flush();

            expect(destroySpy).toHaveBeenCalled();
        }
    );

    it('ignores docker events that are not container scoped', async () => {
        await service.startStatsStream();
        await flush();

        eventsStream.write(JSON.stringify({ Type: 'image', Action: 'pull', id: 'whatever' }));
        await flush();

        expect(mockGetContainer).not.toHaveBeenCalled();
    });

    it('survives malformed event payloads without crashing', async () => {
        await service.startStatsStream();
        await flush();

        eventsStream.write('{not valid json}\n');
        // The good one right after must still be processed.
        eventsStream.write(JSON.stringify({ Type: 'container', Action: 'start', id: 'after-bad' }));
        await flush();

        expect(mockGetContainer).toHaveBeenCalledWith('after-bad');
    });

    it('survives malformed stats chunks without breaking the stream', async () => {
        mockListContainers.mockResolvedValue([{ Id: 'aaa' }]);
        await service.startStatsStream();
        await flush();

        const stream = containerStreams.get('aaa')!;
        stream.write('not valid json at all');
        await flush();
        // No publish must have happened, but the stream must remain open
        // for the next chunk.
        stream.write(JSON.stringify(buildStatsChunk()));
        await flush();

        expect(pubsub.publish).toHaveBeenCalledTimes(1);
    });

    it('is idempotent — calling startStatsStream twice does not double-open streams', async () => {
        mockListContainers.mockResolvedValue([{ Id: 'aaa' }]);

        await service.startStatsStream();
        await flush();
        const firstCallCount = mockGetContainer.mock.calls.length;

        await service.startStatsStream();
        await flush();

        // Second call must short-circuit.
        expect(mockGetContainer.mock.calls.length).toBe(firstCallCount);
    });

    it('cleans up every active stats stream and the events stream on stopStatsStream', async () => {
        mockListContainers.mockResolvedValue([{ Id: 'aaa' }, { Id: 'bbb' }]);
        await service.startStatsStream();
        await flush();

        const eventsDestroy = vi.spyOn(eventsStream, 'destroy');
        const aDestroy = vi.spyOn(containerStreams.get('aaa')!, 'destroy');
        const bDestroy = vi.spyOn(containerStreams.get('bbb')!, 'destroy');

        service.stopStatsStream();

        expect(eventsDestroy).toHaveBeenCalled();
        expect(aDestroy).toHaveBeenCalled();
        expect(bDestroy).toHaveBeenCalled();
    });

    it('stopStatsStream is safe to call multiple times', () => {
        expect(() => {
            service.stopStatsStream();
            service.stopStatsStream();
        }).not.toThrow();
    });

    it('OnModuleDestroy stops the stream so Nest tears the provider down cleanly', async () => {
        mockListContainers.mockResolvedValue([{ Id: 'aaa' }]);
        await service.startStatsStream();
        await flush();

        const destroySpy = vi.spyOn(containerStreams.get('aaa')!, 'destroy');
        service.onModuleDestroy();

        expect(destroySpy).toHaveBeenCalled();
    });
});
