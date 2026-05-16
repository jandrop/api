import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DevicesService } from '@app/unraid-api/graph/resolvers/info/devices/devices.service.js';

// Mock external dependencies
vi.mock('fs/promises', () => ({
    access: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(''),
    readdir: vi.fn().mockResolvedValue([]),
}));

vi.mock('execa', () => ({
    execa: vi.fn(),
}));

vi.mock('systeminformation', () => ({
    networkInterfaces: vi.fn().mockResolvedValue([]),
}));

vi.mock('path-type', () => ({
    isSymlink: vi.fn().mockResolvedValue(false),
}));

vi.mock('@app/core/utils/vms/get-pci-devices.js', () => ({
    getPciDevices: vi.fn(),
}));

vi.mock('@app/core/utils/vms/filter-devices.js', () => ({
    filterDevices: vi.fn(),
}));

vi.mock('@app/store/index.js', () => ({
    getters: {
        emhttp: () => ({
            var: {
                flashGuid: 'test-flash-guid',
            },
        }),
    },
}));

describe('DevicesService', () => {
    let service: DevicesService;
    let mockExeca: any;
    let mockGetPciDevices: any;
    let mockFilterDevices: any;

    beforeEach(async () => {
        vi.clearAllMocks();

        const module: TestingModule = await Test.createTestingModule({
            providers: [DevicesService],
        }).compile();

        service = module.get<DevicesService>(DevicesService);

        mockExeca = await import('execa');
        mockGetPciDevices = await import('@app/core/utils/vms/get-pci-devices.js');
        mockFilterDevices = await import('@app/core/utils/vms/filter-devices.js');
    });

    it('should be defined', () => {
        expect(service).toBeDefined();
    });

    describe('generateGpu', () => {
        it('should return GPU devices from PCI devices', async () => {
            const mockPciDevices = [
                {
                    id: '01:00.0',
                    typeid: '0300',
                    vendorname: 'NVIDIA',
                    productname: 'GeForce RTX 3080',
                    product: '2206',
                    manufacturer: 'NVIDIA',
                    allowed: false,
                    class: 'vga',
                },
                {
                    id: '02:00.0',
                    typeid: '0403',
                    vendorname: 'Intel',
                    productname: 'Audio Controller',
                    product: '1234',
                    manufacturer: 'Intel',
                    allowed: false,
                    class: 'audio',
                },
            ];

            mockGetPciDevices.getPciDevices.mockResolvedValue(mockPciDevices);
            mockFilterDevices.filterDevices.mockResolvedValue(mockPciDevices);

            const result = await service.generateGpu();

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({
                id: 'gpu/01:00.0',
                blacklisted: false,
                class: 'vga',
                productid: '2206',
                typeid: '0300',
                type: 'NVIDIA',
                vendorname: 'NVIDIA',
            });
        });

        it('should handle errors gracefully', async () => {
            mockGetPciDevices.getPciDevices.mockRejectedValue(new Error('PCI error'));

            const result = await service.generateGpu();

            expect(result).toEqual([]);
        });
    });

    describe('generatePci', () => {
        it('should return all PCI devices', async () => {
            const mockPciDevices = [
                {
                    id: '01:00.0',
                    typeid: '0300',
                    vendorname: 'NVIDIA',
                    productname: 'GeForce RTX 3080',
                    product: '2206',
                    manufacturer: 'NVIDIA',
                    allowed: false,
                    class: 'vga',
                },
            ];

            mockGetPciDevices.getPciDevices.mockResolvedValue(mockPciDevices);
            mockFilterDevices.filterDevices.mockResolvedValue(mockPciDevices);

            const result = await service.generatePci();

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({
                id: 'pci/01:00.0',
                type: 'NVIDIA',
                typeid: '0300',
                vendorname: 'NVIDIA',
                vendorid: '0300',
                productname: 'GeForce RTX 3080',
                productid: '2206',
                blacklisted: 'false',
                class: 'vga',
            });
        });

        it('should handle errors gracefully', async () => {
            mockGetPciDevices.getPciDevices.mockRejectedValue(new Error('PCI error'));

            const result = await service.generatePci();

            expect(result).toEqual([]);
        });
    });

    describe('generateNetwork', () => {
        // Each test wires the small set of fs/promises + systeminformation +
        // execa calls needed for its scenario. Defaults silence the lspci
        // and second /proc/net/dev read so they never surprise the assertion.

        let mockFs: typeof import('fs/promises');
        let mockSysinfo: typeof import('systeminformation');

        beforeEach(async () => {
            mockFs = await import('fs/promises');
            mockSysinfo = await import('systeminformation');
            vi.mocked(mockSysinfo.networkInterfaces).mockResolvedValue([] as never);
            vi.mocked(mockFs.readFile).mockResolvedValue('' as never);
            vi.mocked(mockFs.readdir).mockResolvedValue([] as never);
        });

        const setReaddir = (handler: (path: string) => Promise<string[]> | string[]) => {
            vi.mocked(mockFs.readdir).mockImplementation(async (p: string) => handler(p) as never);
        };
        const setReadFile = (handler: (path: string) => Promise<string> | string) => {
            vi.mocked(mockFs.readFile).mockImplementation(async (p: string) => handler(p) as never);
        };

        it('returns a real-interface entry built from systeminformation when available', async () => {
            setReaddir((p) => {
                if (p === '/sys/class/net/') return ['eth0', 'lo', 'docker0'];
                if (p.endsWith('/eth0')) return ['device', 'statistics'];
                if (p.endsWith('/docker0')) return ['statistics']; // virtual → filtered out
                return [];
            });
            setReadFile(() => '');
            vi.mocked(mockSysinfo.networkInterfaces).mockResolvedValueOnce([
                {
                    iface: 'eth0',
                    mac: 'aa:bb:cc:dd:ee:ff',
                    operstate: 'up',
                    speed: 1000,
                    ip4: '192.168.1.10',
                    virtual: false,
                    dhcp: true,
                },
            ] as unknown as Awaited<ReturnType<typeof sysinfo.networkInterfaces>>);
            mockExeca.execa.mockResolvedValueOnce({ stdout: '' }); // lspci empty

            const result = await service.generateNetwork();

            const eth0 = result.find((i) => i.iface === 'eth0');
            expect(eth0).toBeDefined();
            expect(eth0).toMatchObject({
                id: 'network/eth0',
                iface: 'eth0',
                mac: 'aa:bb:cc:dd:ee:ff',
                status: 'connected',
                ipAddress: '192.168.1.10',
                speed: '1000 Mbps',
                type: 'ethernet',
                dhcp: true,
                virtual: false,
            });
            // docker0 has no device/bonding/wireless → must be filtered out.
            expect(result.find((i) => i.iface === 'docker0')).toBeUndefined();
        });

        it('keeps the loopback interface unconditionally', async () => {
            setReaddir((p) => {
                if (p === '/sys/class/net/') return ['lo'];
                return [];
            });
            vi.mocked(mockSysinfo.networkInterfaces).mockResolvedValueOnce([] as never);
            mockExeca.execa.mockResolvedValueOnce({ stdout: '' });

            const result = await service.generateNetwork();
            expect(result.map((i) => i.iface)).toContain('lo');
        });

        it('propagates a user bridge IP to its bridge ports when they have no IP of their own', async () => {
            // /sys/class/net layout: br0 (user bridge), bond0 (real, part of br0),
            // br-abcd1234 (Docker bridge — explicitly NOT a user bridge), eth0 (real).
            setReaddir((p) => {
                if (p === '/sys/class/net/') return ['br0', 'bond0', 'br-abcd1234', 'eth0'];
                if (p.endsWith('/bond0')) return ['bonding'];
                if (p.endsWith('/eth0')) return ['device'];
                if (p.endsWith('/br0/brif')) return ['bond0', 'eth0'];
                return [];
            });
            setReadFile(() => '');
            vi.mocked(mockSysinfo.networkInterfaces).mockResolvedValueOnce([
                {
                    iface: 'br0',
                    mac: '',
                    operstate: 'up',
                    speed: null,
                    ip4: '192.168.1.5',
                    virtual: false,
                    dhcp: false,
                },
                {
                    iface: 'bond0',
                    mac: 'bb:bb:bb:bb:bb:bb',
                    operstate: 'up',
                    speed: 1000,
                    ip4: undefined,
                    virtual: false,
                    dhcp: false,
                },
                {
                    iface: 'eth0',
                    mac: 'aa:aa:aa:aa:aa:aa',
                    operstate: 'up',
                    speed: 1000,
                    ip4: undefined,
                    virtual: false,
                    dhcp: false,
                },
            ] as unknown as Awaited<ReturnType<typeof sysinfo.networkInterfaces>>);
            mockExeca.execa.mockResolvedValueOnce({ stdout: '' });

            const result = await service.generateNetwork();

            // Both bridge ports must inherit br0's IP since they have none of their own.
            const bond0 = result.find((i) => i.iface === 'bond0');
            const eth0 = result.find((i) => i.iface === 'eth0');
            expect(bond0?.ipAddress).toBe('192.168.1.5');
            expect(eth0?.ipAddress).toBe('192.168.1.5');
        });

        it('falls back to /sys/class/net when systeminformation does not list the interface', async () => {
            setReaddir((p) => {
                if (p === '/sys/class/net/') return ['eth0'];
                if (p.endsWith('/eth0')) return ['device'];
                return [];
            });
            setReadFile((p) => {
                if (p.endsWith('/eth0/address')) return 'cc:cc:cc:cc:cc:cc\n';
                if (p.endsWith('/eth0/operstate')) return 'up\n';
                if (p.endsWith('/eth0/speed')) return '2500\n';
                return '';
            });
            const sysinfo = await import('systeminformation');
            // systeminformation hides interfaces that are enslaved to a bond.
            vi.mocked(sysinfo.networkInterfaces).mockResolvedValueOnce([] as never);
            mockExeca.execa.mockResolvedValueOnce({ stdout: '' });

            const result = await service.generateNetwork();
            const eth0 = result.find((i) => i.iface === 'eth0');
            expect(eth0).toMatchObject({
                iface: 'eth0',
                mac: 'cc:cc:cc:cc:cc:cc',
                status: 'connected',
                speed: '2500 Mbps',
            });
        });

        it('returns [] when the top-level /sys/class/net readdir fails', async () => {
            setReaddir(() => {
                throw new Error('EACCES');
            });

            const result = await service.generateNetwork();
            expect(result).toEqual([]);
        });
    });

    describe('generateUsb', () => {
        it('should return USB devices', async () => {
            mockExeca.execa
                .mockResolvedValueOnce({ stdout: '' }) // Empty USB hubs to avoid filtering
                .mockResolvedValueOnce({
                    stdout: 'Bus 001 Device 002: ID 1234:5678 Test USB Device\nBus 001 Device 003: ID abcd:ef01 Another Device',
                }); // USB devices

            const result = await service.generateUsb();

            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({
                id: 'usb/1234:5678',
                name: 'Test USB Device',
            });
            expect(result[1]).toEqual({
                id: 'usb/abcd:ef01',
                name: 'Another Device',
            });
        });

        it('should handle errors gracefully', async () => {
            mockExeca.execa.mockRejectedValue(new Error('USB error'));

            const result = await service.generateUsb();

            expect(result).toEqual([]);
        });
    });
});
