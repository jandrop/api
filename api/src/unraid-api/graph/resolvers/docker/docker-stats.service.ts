import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

import type Docker from 'dockerode';

import { pubsub, PUBSUB_CHANNEL } from '@app/core/pubsub.js';
import { getDockerClient } from '@app/unraid-api/graph/resolvers/docker/utils/docker-client.js';
import { DockerContainerStats } from '@app/unraid-api/graph/resolvers/docker/docker.model.js';

interface DockerStatsPayload {
    read: string;
    cpu_stats: CpuStats;
    precpu_stats: CpuStats;
    memory_stats: { usage?: number; limit?: number; stats?: { cache?: number } };
    networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
    blkio_stats?: { io_service_bytes_recursive?: BlkioEntry[] };
}

interface CpuStats {
    cpu_usage: { total_usage: number };
    system_cpu_usage?: number;
    online_cpus?: number;
}

interface BlkioEntry {
    op: string;
    value: number;
}

/**
 * Streams per-container live runtime stats (CPU%, memory, network I/O,
 * block I/O) to the GraphQL pubsub channel `DOCKER_STATS`.
 *
 * Talks to the Docker daemon directly via its UNIX socket (`dockerode`)
 * instead of spawning the `docker stats` CLI. The CLI returns cached
 * values for cumulative counters (e.g. `NetIO`) between invocations,
 * which breaks the subscription's "live" contract. The socket
 * `/containers/{id}/stats` endpoint always returns fresh kernel
 * counters.
 *
 * Streams are opened lazily on container start and cleaned up on stop
 * via the Docker events stream, so we only hold one socket per running
 * container at any time.
 */
@Injectable()
export class DockerStatsService implements OnModuleDestroy {
    private readonly logger = new Logger(DockerStatsService.name);
    private readonly streams = new Map<string, NodeJS.ReadableStream>();
    private eventsStream: NodeJS.ReadableStream | null = null;
    private active = false;

    onModuleDestroy() {
        this.stopStatsStream();
    }

    public async startStatsStream(): Promise<void> {
        if (this.active) return;
        this.active = true;
        this.logger.log('Starting docker stats stream (dockerode)');

        const docker = getDockerClient();

        try {
            // Seed existing running containers.
            const containers = await docker.listContainers();
            for (const container of containers) {
                this.openStreamForContainer(docker, container.Id);
            }
            // Listen to lifecycle events so we add/remove streams as
            // containers start and stop.
            this.subscribeToEvents(docker);
        } catch (error) {
            this.logger.error('Failed to start docker stats', error);
            this.stopStatsStream();
        }
    }

    public stopStatsStream(): void {
        if (!this.active) return;
        this.active = false;
        this.logger.log('Stopping docker stats stream');
        for (const stream of this.streams.values()) this.destroyStream(stream);
        this.streams.clear();
        if (this.eventsStream) {
            this.destroyStream(this.eventsStream);
            this.eventsStream = null;
        }
    }

    private subscribeToEvents(docker: Docker): void {
        docker
            .getEvents({ filters: { type: ['container'] } })
            .then((stream) => {
                this.eventsStream = stream as unknown as NodeJS.ReadableStream;
                stream.on('data', (chunk: Buffer) => {
                    try {
                        const evt = JSON.parse(chunk.toString());
                        if (evt.Type !== 'container') return;
                        const id = evt.id as string | undefined;
                        if (!id) return;
                        if (evt.Action === 'start') {
                            this.openStreamForContainer(docker, id);
                        } else if (
                            evt.Action === 'die' ||
                            evt.Action === 'stop' ||
                            evt.Action === 'kill' ||
                            evt.Action === 'destroy'
                        ) {
                            this.closeStreamForContainer(id);
                        }
                    } catch (err) {
                        this.logger.debug('Failed to parse docker event', err);
                    }
                });
                stream.on('error', (err) => {
                    this.logger.error('Docker events stream error', err);
                });
            })
            .catch((err) => {
                this.logger.error('Failed to subscribe to docker events', err);
            });
    }

    private openStreamForContainer(docker: Docker, id: string): void {
        if (this.streams.has(id)) return;
        docker
            .getContainer(id)
            .stats({ stream: true })
            .then((stream) => {
                if (!this.active) {
                    this.destroyStream(stream as unknown as NodeJS.ReadableStream);
                    return;
                }
                this.streams.set(id, stream as unknown as NodeJS.ReadableStream);
                stream.on('data', (chunk: Buffer) => this.processStats(id, chunk));
                stream.on('error', (err) => {
                    this.logger.debug(`Stats stream error for ${id}`, err);
                    this.closeStreamForContainer(id);
                });
                stream.on('end', () => this.closeStreamForContainer(id));
            })
            .catch((err) => {
                this.logger.debug(`Failed to open stats stream for ${id}`, err);
            });
    }

    private closeStreamForContainer(id: string): void {
        const stream = this.streams.get(id);
        if (!stream) return;
        this.destroyStream(stream);
        this.streams.delete(id);
    }

    private destroyStream(stream: NodeJS.ReadableStream): void {
        const destroyable = stream as { destroy?: () => void };
        if (typeof destroyable.destroy === 'function') destroyable.destroy();
    }

    private processStats(id: string, chunk: Buffer): void {
        try {
            const text = chunk.toString().trim();
            if (!text) return;
            const data: DockerStatsPayload = JSON.parse(text);

            const cpuPercent = computeCpuPercent(data);
            const memUsed = computeMemoryUsage(data);
            const memLimit = data.memory_stats.limit ?? 0;
            const memPercent = memLimit > 0 ? (memUsed / memLimit) * 100 : 0;
            const { rx, tx } = sumNetworks(data.networks);
            const { read, write } = sumBlkio(data.blkio_stats?.io_service_bytes_recursive);

            const stats: DockerContainerStats = {
                id,
                cpuPercent,
                memUsage: `${formatBytes(memUsed)} / ${formatBytes(memLimit)}`,
                memPercent,
                netIO: `${formatBytes(rx)} / ${formatBytes(tx)}`,
                blockIO: `${formatBytes(read)} / ${formatBytes(write)}`,
            };

            pubsub.publish(PUBSUB_CHANNEL.DOCKER_STATS, {
                dockerContainerStats: stats,
            });
        } catch (error) {
            this.logger.debug(`Failed to process stats chunk for ${id}`, error);
        }
    }
}

/** Standard `docker stats` CPU% formula. */
function computeCpuPercent(d: DockerStatsPayload): number {
    const cpuDelta = d.cpu_stats.cpu_usage.total_usage - d.precpu_stats.cpu_usage.total_usage;
    const sysDelta =
        (d.cpu_stats.system_cpu_usage ?? 0) - (d.precpu_stats.system_cpu_usage ?? 0);
    const onlineCpus = d.cpu_stats.online_cpus ?? 1;
    if (sysDelta <= 0 || cpuDelta < 0) return 0;
    return (cpuDelta / sysDelta) * onlineCpus * 100;
}

/** Mimics `docker stats` memory column (usage - cache). */
function computeMemoryUsage(d: DockerStatsPayload): number {
    const usage = d.memory_stats.usage ?? 0;
    const cache = d.memory_stats.stats?.cache ?? 0;
    return Math.max(0, usage - cache);
}

function sumNetworks(
    networks: Record<string, { rx_bytes?: number; tx_bytes?: number }> | undefined,
): { rx: number; tx: number } {
    if (!networks) return { rx: 0, tx: 0 };
    let rx = 0;
    let tx = 0;
    for (const iface of Object.values(networks)) {
        rx += iface.rx_bytes ?? 0;
        tx += iface.tx_bytes ?? 0;
    }
    return { rx, tx };
}

function sumBlkio(entries: BlkioEntry[] | undefined): { read: number; write: number } {
    if (!entries) return { read: 0, write: 0 };
    let read = 0;
    let write = 0;
    for (const e of entries) {
        if (e.op === 'Read' || e.op === 'read') read += e.value;
        else if (e.op === 'Write' || e.op === 'write') write += e.value;
    }
    return { read, write };
}

/** Matches the SI formatting used by the original CLI-based service. */
function formatBytes(bytes: number): string {
    if (bytes < 1_000) return `${bytes}B`;
    if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)}kB`;
    if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)}MB`;
    if (bytes < 1_000_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)}GB`;
    return `${(bytes / 1_000_000_000_000).toFixed(2)}TB`;
}
