import { Test } from '@nestjs/testing';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NetworkMetricsService } from '@app/unraid-api/graph/resolvers/metrics/network-metrics/network-metrics.service.js';

vi.mock('fs/promises', () => ({
    readFile: vi.fn(),
    readdir: vi.fn(),
}));

const fs = await import('fs/promises');
const mockReadFile = fs.readFile as ReturnType<typeof vi.fn>;
const mockReaddir = fs.readdir as ReturnType<typeof vi.fn>;

/**
 * Build a `/proc/net/dev`-shaped string. The kernel emits two header
 * lines plus one line per interface; each line has 16 counter columns,
 * with byte-1 at index 0 and tx-byte-1 at index 8 (after `iface:`).
 */
function buildProcNetDev(samples: Array<{ iface: string; rx: number; tx: number }>): string {
    const header = 'Inter-|   Receive                                                |  Transmit\n';
    const subhead =
        ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n';
    const body = samples
        .map((s) => `${s.iface.padStart(6)}: ${s.rx} 0 0 0 0 0 0 0 ${s.tx} 0 0 0 0 0 0 0`)
        .join('\n');
    return header + subhead + body;
}

describe('NetworkMetricsService', () => {
    let service: NetworkMetricsService;

    beforeEach(async () => {
        vi.clearAllMocks();
        // Default: every interface we ask about is a real physical NIC.
        mockReaddir.mockImplementation(async () => ['device', 'statistics'] as never);

        const module = await Test.createTestingModule({
            providers: [NetworkMetricsService],
        }).compile();
        service = module.get<NetworkMetricsService>(NetworkMetricsService);
    });

    it('is defined', () => {
        expect(service).toBeDefined();
    });

    it('returns the cumulative rx/tx bytes for every real interface on the first call', async () => {
        mockReadFile.mockResolvedValueOnce(
            buildProcNetDev([
                { iface: 'eth0', rx: 1_000_000, tx: 500_000 },
                { iface: 'eth1', rx: 2_000_000, tx: 1_500_000 },
            ])
        );

        const result = await service.generateNetworkLoad();

        expect(result.id).toBe('metrics/network');
        expect(result.interfaces).toHaveLength(2);
        const eth0 = result.interfaces.find((i) => i.iface === 'eth0')!;
        expect(eth0.rxBytes).toBe(1_000_000);
        expect(eth0.txBytes).toBe(500_000);
        // First sample has no previous snapshot → rates default to 0.
        expect(eth0.rxBytesPerSec).toBe(0);
        expect(eth0.txBytesPerSec).toBe(0);
    });

    it('computes the per-second delta between consecutive snapshots', async () => {
        // Snapshot 1 — record so the service can diff against it.
        const before = Date.now();
        mockReadFile.mockResolvedValueOnce(
            buildProcNetDev([{ iface: 'eth0', rx: 1_000_000, tx: 500_000 }])
        );
        await service.generateNetworkLoad();

        // Advance Date.now() by 2 s and emit a higher counter so
        // delta/seconds is deterministic.
        const advanceMs = 2_000;
        vi.spyOn(Date, 'now').mockImplementation(() => before + advanceMs);

        mockReadFile.mockResolvedValueOnce(
            buildProcNetDev([{ iface: 'eth0', rx: 3_000_000, tx: 1_500_000 }])
        );
        const result = await service.generateNetworkLoad();

        const eth0 = result.interfaces.find((i) => i.iface === 'eth0')!;
        // Δrx = 2,000,000 bytes over 2s → 1,000,000 B/s.
        expect(eth0.rxBytesPerSec).toBeCloseTo(1_000_000);
        // Δtx = 1,000,000 over 2s → 500,000 B/s.
        expect(eth0.txBytesPerSec).toBeCloseTo(500_000);
    });

    it('clamps the rate to zero when the counter goes backwards (interface reset)', async () => {
        const before = Date.now();
        mockReadFile.mockResolvedValueOnce(
            buildProcNetDev([{ iface: 'eth0', rx: 1_000_000_000, tx: 500_000_000 }])
        );
        await service.generateNetworkLoad();

        // Simulate a kernel counter reset / interface flap that lowers rx/tx.
        vi.spyOn(Date, 'now').mockImplementation(() => before + 1_000);
        mockReadFile.mockResolvedValueOnce(buildProcNetDev([{ iface: 'eth0', rx: 10, tx: 5 }]));

        const result = await service.generateNetworkLoad();
        const eth0 = result.interfaces.find((i) => i.iface === 'eth0')!;
        // A negative delta is meaningless on a monotonic counter; we
        // floor it so the dashboard never shows a phantom negative
        // speed.
        expect(eth0.rxBytesPerSec).toBe(0);
        expect(eth0.txBytesPerSec).toBe(0);
    });

    it('keeps the loopback interface and drops anything that lacks device/bonding/wireless entries', async () => {
        // Three interfaces in /proc/net/dev: lo (always real), eth0
        // (physical, keep), docker0 (virtual bridge, drop).
        mockReadFile.mockResolvedValueOnce(
            buildProcNetDev([
                { iface: 'lo', rx: 100, tx: 100 },
                { iface: 'eth0', rx: 200, tx: 200 },
                { iface: 'docker0', rx: 300, tx: 300 },
            ])
        );
        mockReaddir.mockImplementation(async (path) => {
            const name = String(path).split('/').pop();
            if (name === 'eth0') return ['device', 'statistics'] as never;
            if (name === 'docker0') return ['brif', 'statistics'] as never; // no device/bonding/wireless
            return ['statistics'] as never;
        });

        const result = await service.generateNetworkLoad();
        const ifaces = result.interfaces.map((i) => i.iface);
        expect(ifaces).toContain('lo');
        expect(ifaces).toContain('eth0');
        expect(ifaces).not.toContain('docker0');
    });

    it('keeps bond interfaces (bonding dir) and wireless interfaces (wireless dir)', async () => {
        mockReadFile.mockResolvedValueOnce(
            buildProcNetDev([
                { iface: 'bond0', rx: 100, tx: 100 },
                { iface: 'wlan0', rx: 200, tx: 200 },
            ])
        );
        mockReaddir.mockImplementation(async (path) => {
            if (String(path).endsWith('/bond0')) return ['bonding'] as never;
            if (String(path).endsWith('/wlan0')) return ['wireless'] as never;
            return [] as never;
        });

        const result = await service.generateNetworkLoad();
        expect(result.interfaces.map((i) => i.iface).sort()).toEqual(['bond0', 'wlan0']);
    });

    it('returns an empty interfaces list when /proc/net/dev cannot be read', async () => {
        mockReadFile.mockRejectedValueOnce(new Error('EACCES'));

        const result = await service.generateNetworkLoad();
        expect(result).toEqual({ id: 'metrics/network', interfaces: [] });
    });

    it('survives readdir failures on a specific interface (treats it as not-real)', async () => {
        mockReadFile.mockResolvedValueOnce(buildProcNetDev([{ iface: 'eth0', rx: 1, tx: 1 }]));
        mockReaddir.mockRejectedValueOnce(new Error('ENOENT'));

        const result = await service.generateNetworkLoad();
        // eth0 is excluded because we couldn't verify it.
        expect(result.interfaces.find((i) => i.iface === 'eth0')).toBeUndefined();
    });

    it('preserves the previous snapshot across calls so the next delta is correct', async () => {
        const t0 = 1_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => t0);

        mockReadFile.mockResolvedValueOnce(buildProcNetDev([{ iface: 'eth0', rx: 100, tx: 100 }]));
        await service.generateNetworkLoad();

        // First-then-second invocation 1s apart, then second-then-third 1s
        // apart again. Snapshot-after-snapshot must compute the right
        // delta each time without "losing" the previous reading.
        vi.spyOn(Date, 'now').mockImplementation(() => t0 + 1_000);
        mockReadFile.mockResolvedValueOnce(buildProcNetDev([{ iface: 'eth0', rx: 200, tx: 200 }]));
        let result = await service.generateNetworkLoad();
        let eth0 = result.interfaces.find((i) => i.iface === 'eth0')!;
        expect(eth0.rxBytesPerSec).toBeCloseTo(100);

        vi.spyOn(Date, 'now').mockImplementation(() => t0 + 2_000);
        mockReadFile.mockResolvedValueOnce(buildProcNetDev([{ iface: 'eth0', rx: 350, tx: 250 }]));
        result = await service.generateNetworkLoad();
        eth0 = result.interfaces.find((i) => i.iface === 'eth0')!;
        // Δrx = 150 over 1s.
        expect(eth0.rxBytesPerSec).toBeCloseTo(150);
        expect(eth0.txBytesPerSec).toBeCloseTo(50);
    });
});
