import { Injectable, Logger } from '@nestjs/common';
import { readFile } from 'fs/promises';

import {
    NetworkInterfaceUtilization,
    NetworkUtilization,
} from '@app/unraid-api/graph/resolvers/metrics/network-metrics/network-metrics.model.js';

interface TrafficSample {
    rxBytes: number;
    txBytes: number;
    timestamp: number;
}

/**
 * Reads `/proc/net/dev` to expose per-interface network utilization.
 *
 * Maintains the previous read across calls so that consecutive invocations
 * compute the instantaneous speed from the actual elapsed time between
 * reads — no artificial delays.
 */
@Injectable()
export class NetworkMetricsService {
    private readonly logger = new Logger(NetworkMetricsService.name);
    private previousSnapshot: Map<string, TrafficSample> = new Map();

    /**
     * Read /proc/net/dev, compute per-interface deltas against the last
     * snapshot and return a complete utilization payload.
     *
     * Virtual Docker interfaces (veth*, br-<hash>, docker0) are filtered out.
     */
    async generateNetworkLoad(): Promise<NetworkUtilization> {
        const raw = await readFile('/proc/net/dev', 'utf8').catch((err) => {
            this.logger.warn(`Failed to read /proc/net/dev: ${String(err)}`);
            return '';
        });

        const now = Date.now();
        const current = this.parseTraffic(raw, now);
        const interfaces: NetworkInterfaceUtilization[] = [];

        for (const [iface, sample] of current.entries()) {
            if (this.isDockerVirtualInterface(iface)) continue;

            const previous = this.previousSnapshot.get(iface);
            let rxBytesPerSec = 0;
            let txBytesPerSec = 0;

            if (previous) {
                const deltaSeconds = (sample.timestamp - previous.timestamp) / 1000;
                if (deltaSeconds > 0) {
                    rxBytesPerSec = Math.max(0, (sample.rxBytes - previous.rxBytes) / deltaSeconds);
                    txBytesPerSec = Math.max(0, (sample.txBytes - previous.txBytes) / deltaSeconds);
                }
            }

            interfaces.push({
                iface,
                rxBytes: sample.rxBytes,
                txBytes: sample.txBytes,
                rxBytesPerSec,
                txBytesPerSec,
            });
        }

        this.previousSnapshot = current;

        return {
            id: 'metrics/network',
            interfaces,
        };
    }

    private parseTraffic(raw: string, timestamp: number): Map<string, TrafficSample> {
        const map = new Map<string, TrafficSample>();
        for (const line of raw.split('\n').slice(2)) {
            // /proc/net/dev format: "iface: rxBytes rxPackets ... txBytes txPackets ..."
            const match = line.trim().match(/^(\S+):\s+(\d+)(?:\s+\d+){6}\s+\d+\s+(\d+)/);
            if (match) {
                map.set(match[1], {
                    rxBytes: parseFloat(match[2]),
                    txBytes: parseFloat(match[3]),
                    timestamp,
                });
            }
        }
        return map;
    }

    private isDockerVirtualInterface(name: string): boolean {
        return name.startsWith('veth') || /^br-[a-f0-9]+$/.test(name) || name === 'docker0';
    }
}