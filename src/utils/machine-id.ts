import os from 'os';
import crypto from 'crypto';

/**
 * Get the primary MAC address (first non-internal interface)
 */
function getPrimaryMacAddress(): string {
    const interfaces = os.networkInterfaces();

    for (const [name, addrs] of Object.entries(interfaces)) {
        if (!addrs) continue;

        for (const addr of addrs) {
            // Skip internal/loopback and addresses without MAC
            if (addr.internal || !addr.mac || addr.mac === '00:00:00:00:00:00') {
                continue;
            }
            return addr.mac;
        }
    }

    return 'unknown';
}

/**
 * Generate a unique, deterministic machine fingerprint
 * Uses MAC address + platform for stability
 * - MAC is globally unique per network interface
 * - Platform helps distinguish dual-boot scenarios
 */
export function generateMachineId(): string {
    const mac = getPrimaryMacAddress();
    const platform = os.platform();

    // Combine MAC + platform
    const fingerprintData = `${mac}|${platform}`;

    // Hash for privacy and fixed length
    return crypto.createHash('sha256').update(fingerprintData).digest('hex');
}

/**
 * Generate a shorter machine ID (first 16 chars of full hash)
 */
export function generateShortMachineId(): string {
    return generateMachineId().substring(0, 16);
}

/**
 * Get machine fingerprint for API request
 */
export interface MachineFingerprint {
    machine_id: string;
    platform: string;
}

export function getMachineFingerprint(): MachineFingerprint {
    return {
        machine_id: generateMachineId(),
        platform: os.platform(),
    };
}
