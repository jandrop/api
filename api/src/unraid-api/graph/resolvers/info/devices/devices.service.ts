import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { access, readdir, readFile } from 'fs/promises';

import { execa } from 'execa';
import { isSymlink } from 'path-type';

import type { PciDevice } from '@app/core/types/index.js';
import { sanitizeProduct } from '@app/core/utils/vms/domain/sanitize-product.js';
import { sanitizeVendor } from '@app/core/utils/vms/domain/sanitize-vendor.js';
import { vmRegExps } from '@app/core/utils/vms/domain/vm-regexps.js';
import { filterDevices } from '@app/core/utils/vms/filter-devices.js';
import { getPciDevices } from '@app/core/utils/vms/get-pci-devices.js';
import { getters } from '@app/store/index.js';
import {
    InfoGpu,
    InfoNetwork,
    InfoPci,
    InfoUsb,
} from '@app/unraid-api/graph/resolvers/info/devices/devices.model.js';
import { networkInterfaces } from 'systeminformation';

/** Sample interval in milliseconds used to compute instantaneous network speed. */
const SPEED_SAMPLE_INTERVAL_MS = 1000;

interface RawUsbDeviceData {
    id: string;
    n?: string;
}

interface UsbDevice {
    id: string;
    name: string;
    guid: string;
    vendorname?: string;
}

interface TrafficSample {
    rxBytes: number;
    txBytes: number;
}

@Injectable()
export class DevicesService {
    private readonly logger = new Logger(DevicesService.name);

    async generateGpu(): Promise<InfoGpu[]> {
        try {
            const systemPciDevices = await this.getSystemPciDevices();
            return systemPciDevices
                .filter((device) => device.class === 'vga' && !device.allowed)
                .map((entry) => {
                    const gpu: InfoGpu = {
                        id: `gpu/${entry.id}`,
                        blacklisted: entry.allowed,
                        class: entry.class,
                        productid: entry.product,
                        typeid: entry.typeid,
                        type: entry.manufacturer,
                        vendorname: entry.vendorname,
                    };
                    return gpu;
                });
        } catch (error: unknown) {
            this.logger.error(
                `Failed to generate GPU devices: ${error instanceof Error ? error.message : String(error)}`,
                error instanceof Error ? error.stack : undefined
            );
            return [];
        }
    }

    async generatePci(): Promise<InfoPci[]> {
        try {
            const devices = await this.getSystemPciDevices();
            return devices.map((device) => ({
                id: `pci/${device.id}`,
                type: device.manufacturer,
                typeid: device.typeid,
                vendorname: device.vendorname,
                vendorid: device.typeid.substring(0, 4),
                productname: device.productname,
                productid: device.product,
                blacklisted: device.allowed ? 'true' : 'false',
                class: device.class,
            }));
        } catch (error: unknown) {
            this.logger.error(
                `Failed to generate PCI devices: ${error instanceof Error ? error.message : String(error)}`,
                error instanceof Error ? error.stack : undefined
            );
            return [];
        }
    }

    async generateNetwork(): Promise<InfoNetwork[]> {
        try {
            // List every interface known to the kernel — this includes physical
            // NICs (eth0/eth1) that systeminformation hides when they're enslaved
            // to a bond.
            const allIfaces = (await readdir('/sys/class/net/').catch(() => [] as string[])).filter(
                (n) => n !== 'bonding_masters'
            );

            // Real interfaces: physical NIC, bond, wireless or loopback — mirrors
            // what Unraid's web UI exposes. Bridges (br0, shim-br0, br-<hash>),
            // tunnels, virtio bridges and Docker veth devices are filtered out.
            const isRealInterface = async (name: string): Promise<boolean> => {
                if (name === 'lo') return true;
                const entries = await readdir(`/sys/class/net/${name}`).catch(() => [] as string[]);
                return (
                    entries.includes('device') ||
                    entries.includes('bonding') ||
                    entries.includes('wireless')
                );
            };
            const realIfaces = (
                await Promise.all(
                    allIfaces.map(async (n) => [n, await isRealInterface(n)] as const)
                )
            )
                .filter(([, ok]) => ok)
                .map(([n]) => n);

            const parseTraffic = (raw: string): Map<string, TrafficSample> => {
                const map = new Map<string, TrafficSample>();
                for (const line of raw.split('\n').slice(2)) {
                    const m = line.trim().match(/^(\S+):\s+(\d+)(?:\s+\d+){6}\s+\d+\s+(\d+)/);
                    if (m) map.set(m[1], { rxBytes: parseFloat(m[2]), txBytes: parseFloat(m[3]) });
                }
                return map;
            };

            // Fetch enrichment sources in parallel
            const [sysInfoResult, procNetDevResult, lspciResult] = await Promise.allSettled([
                networkInterfaces(),
                readFile('/proc/net/dev', 'utf8'),
                execa('lspci', ['-mm']),
            ]);

            const sysInfoByIface = new Map<string, Awaited<ReturnType<typeof networkInterfaces>>[number]>();
            if (sysInfoResult.status === 'fulfilled') {
                for (const i of sysInfoResult.value) sysInfoByIface.set(i.iface, i);
            }

            const trafficSnapshot1 =
                procNetDevResult.status === 'fulfilled'
                    ? parseTraffic(procNetDevResult.value)
                    : new Map<string, TrafficSample>();

            // Second /proc/net/dev read after the sample interval to compute speed
            const trafficSnapshot2 = await readFile('/proc/net/dev', 'utf8')
                .then(
                    (raw) =>
                        new Promise<Map<string, TrafficSample>>((resolve) => {
                            setTimeout(() => resolve(parseTraffic(raw)), SPEED_SAMPLE_INTERVAL_MS);
                        })
                )
                .catch(() => new Map<string, TrafficSample>());

            // Build lspci vendor/model index keyed by full PCI slot (0000:xx:xx.x)
            const lspciIndex = new Map<string, { vendor: string; model: string }>();
            if (lspciResult.status === 'fulfilled') {
                for (const line of lspciResult.value.stdout.split('\n')) {
                    const parts: string[] = [];
                    let m: RegExpExecArray | null;
                    const re = /"([^"]*)"/g;
                    while ((m = re.exec(line)) !== null) parts.push(m[1]);
                    if (parts.length >= 3) {
                        lspciIndex.set(`0000:${line.split(' ')[0]}`, { vendor: parts[1], model: parts[2] });
                    }
                }
            }

            // Resolve the PCI slot for a (possibly bonded) interface by traversing
            // bond.active_slave so vendor/model surface on bond0 itself.
            const resolvePciSlot = async (name: string, depth = 0): Promise<string | null> => {
                if (depth > 3) return null;
                const uevent = await readFile(`/sys/class/net/${name}/device/uevent`, 'utf8').catch(() => '');
                const slotMatch = uevent.match(/PCI_SLOT_NAME=(.+)/);
                if (slotMatch) return slotMatch[1].trim();
                const slaves = await readFile(`/sys/class/net/${name}/bonding/slaves`, 'utf8').catch(() => '');
                if (slaves.trim()) {
                    // For active-backup mode, active_slave is the currently forwarding interface
                    const activeSlave = await readFile(
                        `/sys/class/net/${name}/bonding/active_slave`,
                        'utf8'
                    ).catch(() => '');
                    const target = activeSlave.trim() || slaves.trim().split(/\s+/)[0];
                    return resolvePciSlot(target, depth + 1);
                }
                return null;
            };

            const pciMap = new Map<string, { vendor: string; model: string }>();
            await Promise.all(
                realIfaces.map(async (name) => {
                    const slot = await resolvePciSlot(name);
                    const pci = slot ? lspciIndex.get(slot) : undefined;
                    if (pci) pciMap.set(name, pci);
                })
            );

            const deriveType = (name: string): string => {
                if (name === 'lo') return 'loopback';
                if (/^(eth|em|ens|enp|en\d)/.test(name)) return 'ethernet';
                if (name.startsWith('bond')) return 'bond';
                if (name.startsWith('wlan') || name.startsWith('wifi')) return 'wireless';
                return 'other';
            };

            const mapStatus = (operstate: string): string => {
                if (operstate === 'up') return 'connected';
                if (operstate === 'down') return 'disconnected';
                return 'unknown';
            };

            // For each real interface, prefer systeminformation; fall back to
            // /sys/class/net/<name>/ for enslaved/missing ones (eth0/eth1 inside a bond).
            return Promise.all(
                realIfaces.map(async (name) => {
                    const si = sysInfoByIface.get(name);
                    let mac: string | undefined;
                    let operstate = '';
                    let speedRaw: number | null | undefined;
                    let ip4: string | undefined;
                    let virtual = false;
                    let dhcp: boolean | undefined;
                    if (si) {
                        mac = si.mac;
                        operstate = si.operstate;
                        speedRaw = si.speed;
                        ip4 = si.ip4;
                        virtual = si.virtual;
                        dhcp = si.dhcp;
                    } else {
                        mac = (
                            await readFile(`/sys/class/net/${name}/address`, 'utf8').catch(() => '')
                        ).trim();
                        operstate = (
                            await readFile(`/sys/class/net/${name}/operstate`, 'utf8').catch(() => '')
                        ).trim();
                        const sr = parseInt(
                            (
                                await readFile(`/sys/class/net/${name}/speed`, 'utf8').catch(() => '')
                            ).trim(),
                            10
                        );
                        speedRaw = Number.isFinite(sr) ? sr : null;
                    }
                    const t1 = trafficSnapshot1.get(name);
                    const t2 = trafficSnapshot2.get(name);
                    const pci = pciMap.get(name);
                    const rxBytesPerSec =
                        t1 && t2
                            ? Math.max(0, (t2.rxBytes - t1.rxBytes) / (SPEED_SAMPLE_INTERVAL_MS / 1000))
                            : undefined;
                    const txBytesPerSec =
                        t1 && t2
                            ? Math.max(0, (t2.txBytes - t1.txBytes) / (SPEED_SAMPLE_INTERVAL_MS / 1000))
                            : undefined;

                    return {
                        id: `network/${name}`,
                        iface: name,
                        model: pci?.model,
                        vendor: pci?.vendor,
                        mac: mac || undefined,
                        virtual,
                        speed:
                            speedRaw != null && speedRaw >= 0 ? `${speedRaw} Mbps` : undefined,
                        dhcp,
                        status: mapStatus(operstate),
                        ipAddress: ip4 || undefined,
                        type: deriveType(name),
                        rxBytes: t1?.rxBytes,
                        txBytes: t1?.txBytes,
                        rxBytesPerSec,
                        txBytesPerSec,
                    } as InfoNetwork;
                })
            );
        } catch (error: unknown) {
            this.logger.error(
                `Failed to generate network devices: ${error instanceof Error ? error.message : String(error)}`,
                error instanceof Error ? error.stack : undefined
            );
            return [];
        }
    }

    async generateUsb(): Promise<InfoUsb[]> {
        try {
            const usbDevices = await this.getSystemUSBDevices();
            return usbDevices.map((device) => ({
                id: `usb/${device.id}`,
                name: device.name,
            }));
        } catch (error: unknown) {
            this.logger.error(
                `Failed to generate USB devices: ${error instanceof Error ? error.message : String(error)}`,
                error instanceof Error ? error.stack : undefined
            );
            return [];
        }
    }

    private addDeviceClass(device: Readonly<PciDevice>): PciDevice {
        const modifiedDevice: PciDevice = {
            ...device,
            class: 'other',
        };

        if (vmRegExps.allowedGpuClassId.test(device.typeid)) {
            modifiedDevice.class = 'vga';
            const regex = new RegExp(/.+\[(?<gpuName>.+)]/);
            const productName = regex.exec(device.productname)?.groups?.gpuName;

            if (productName) {
                modifiedDevice.productname = productName;
            }

            return modifiedDevice;
        }

        if (vmRegExps.allowedAudioClassId.test(device.typeid)) {
            modifiedDevice.class = 'audio';
            return modifiedDevice;
        }

        return modifiedDevice;
    }

    private async getSystemPciDevices(): Promise<PciDevice[]> {
        const devices = await getPciDevices();
        const basePath = '/sys/bus/pci/devices/0000:';

        const filteredDevices = await Promise.all(
            devices.map(async (device: Readonly<PciDevice>) => {
                const exists = await access(`${basePath}${device.id}/iommu_group/`)
                    .then(() => true)
                    .catch(() => false);
                return exists ? device : null;
            })
        ).then((devices) => devices.filter((device) => device !== null));

        const processedDevices = await filterDevices(filteredDevices).then(async (devices) =>
            Promise.all(
                devices
                    .map((device) => this.addDeviceClass(device as PciDevice))
                    .map(async (device) => {
                        await isSymlink(`${basePath}${device.id}/driver`).then((symlink) => {
                            if (symlink) {
                                // Future: Add driver detection logic here
                            }
                        });

                        device.vendorname = sanitizeVendor(device.vendorname);
                        device.productname = sanitizeProduct(device.productname);

                        return device;
                    })
            )
        );

        return processedDevices;
    }

    private async getSystemUSBDevices(): Promise<UsbDevice[]> {
        const usbHubs = await execa('cat /sys/bus/usb/drivers/hub/*/modalias', { shell: true })
            .then(({ stdout }) =>
                stdout.split('\n').map((line) => {
                    const [, id] = line.match(/usb:v(\w{9})/) ?? [];
                    return id.replace('p', ':');
                })
            )
            .catch(() => [] as string[]);

        const emhttp = getters.emhttp();

        const filterBootDrive = (device: UsbDevice): boolean => emhttp.var.flashGuid !== device.guid;

        const filterUsbHubs = (device: UsbDevice): boolean => !usbHubs.includes(device.id);

        const sanitizeVendorName = (device: UsbDevice): UsbDevice => {
            const vendorname = sanitizeVendor(device.vendorname || '');
            return {
                ...device,
                vendorname,
            };
        };

        const parseBasicDevice = (device: RawUsbDeviceData): UsbDevice => {
            const idParts = device.id.split(':');
            let guid: string;

            if (idParts.length === 2) {
                const [vendorId, productId] = idParts;
                guid = `${vendorId}-${productId}-basic`;
            } else {
                guid = `unknown-${randomUUID()}`;
            }

            const deviceName = device.n?.trim() || '';

            return {
                id: device.id,
                name: deviceName || '[unnamed device]',
                guid,
                vendorname: '',
            };
        };

        const parseUsbDevices = (stdout: string): UsbDevice[] => {
            return stdout
                .split('\n')
                .map((line) => {
                    const regex = /^.+: ID (?<id>\S+)(?<n>.*)$/;
                    const result = regex.exec(line);
                    if (!result?.groups) return null;

                    const rawData: RawUsbDeviceData = {
                        id: result.groups.id,
                        n: result.groups.n,
                    };

                    return parseBasicDevice(rawData);
                })
                .filter((device): device is UsbDevice => device !== null);
        };

        const usbDevices = await execa('lsusb')
            .then(({ stdout }) => {
                const devices = parseUsbDevices(stdout);
                return devices.filter(filterBootDrive).filter(filterUsbHubs).map(sanitizeVendorName);
            })
            .catch(() => []);

        return usbDevices;
    }
}
