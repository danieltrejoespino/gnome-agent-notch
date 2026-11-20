// Readers for the System tab (S2). See docs/12-modulo-sistema.md.
//
// All asynchronous and with no state of their own: system.js decides when to call them
// (only with the System tab visible). The pure functions (parse*,
// format*) do not depend on GNOME and can be tested with gjs separately.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const decoder = new TextDecoder();

/** Reads a small file (e.g. from /proc or /sys) without blocking. */
export function readText(path, cancellable = null) {
    return new Promise((resolve, reject) => {
        Gio.File.new_for_path(path).load_contents_async(cancellable, (file, result) => {
            try {
                const [, contents] = file.load_contents_finish(result);
                resolve(decoder.decode(contents));
            } catch (e) {
                reject(e);
            }
        });
    });
}

export function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

// --- CPU ---------------------------------------------------------------------

/** `cpu` line of /proc/stat → {idle, total} (in ticks). */
export function parseCpuStat(text) {
    const line = text.split('\n').find(l => l.startsWith('cpu '));
    if (!line)
        return null;
    const v = line.trim().split(/\s+/).slice(1).map(Number);
    // user nice system idle iowait irq softirq steal (guest is already in user)
    const idle = (v[3] ?? 0) + (v[4] ?? 0);
    const total = v.slice(0, 8).reduce((a, b) => a + (b || 0), 0);
    return {idle, total};
}

/** CPU usage (0–1) between two parseCpuStat readings, or null. */
export function cpuUsage(prev, cur) {
    if (!prev || !cur)
        return null;
    const total = cur.total - prev.total;
    const idle = cur.idle - prev.idle;
    return total > 0 ? Math.min(1, Math.max(0, 1 - idle / total)) : null;
}

// CPU temperature sensors, by preference (name in hwmon).
const CPU_SENSORS = ['coretemp', 'k10temp', 'zenpower', 'cpu_thermal', 'acpitz'];

/**
 * Looks up (once) the CPU temperature file in /sys/class/hwmon.
 * Returns the path of the best sensor's `temp1_input`, or null.
 */
export async function findCpuSensor(cancellable = null) {
    const dir = Gio.File.new_for_path('/sys/class/hwmon');
    const infos = await new Promise((resolve, reject) => {
        dir.enumerate_children_async('standard::name', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_LOW, cancellable, (d, res) => {
                try {
                    const en = d.enumerate_children_finish(res);
                    en.next_files_async(64, GLib.PRIORITY_LOW, cancellable, (e, r) => {
                        try {
                            resolve(e.next_files_finish(r));
                        } catch (err) {
                            reject(err);
                        } finally {
                            e.close_async(GLib.PRIORITY_LOW, null, null);
                        }
                    });
                } catch (err) {
                    reject(err);
                }
            });
    });

    let best = null;
    let bestRank = CPU_SENSORS.length;
    for (const info of infos) {
        const base = `/sys/class/hwmon/${info.get_name()}`;
        let name;
        try {
            name = (await readText(`${base}/name`, cancellable)).trim();
        } catch (e) {
            if (isCancelled(e))
                throw e;
            continue;
        }
        const rank = CPU_SENSORS.indexOf(name);
        if (rank !== -1 && rank < bestRank) {
            best = `${base}/temp1_input`;
            bestRank = rank;
        }
    }
    return best;
}

// --- Disk -------------------------------------------------------------------

/**
 * {size, used, free} in bytes of the file system of `path`, like `df`:
 * `used` without the space reserved for root and `free` the available one.
 */
export function queryDisk(path, cancellable = null) {
    return new Promise((resolve, reject) => {
        Gio.File.new_for_path(path).query_filesystem_info_async(
            'filesystem::size,filesystem::used,filesystem::free', GLib.PRIORITY_LOW, cancellable,
            (file, res) => {
                try {
                    const info = file.query_filesystem_info_finish(res);
                    resolve({
                        size: Number(info.get_attribute_uint64('filesystem::size')),
                        used: Number(info.get_attribute_uint64('filesystem::used')),
                        free: Number(info.get_attribute_uint64('filesystem::free')),
                    });
                } catch (e) {
                    reject(e);
                }
            });
    });
}

// --- Formats ----------------------------------------------------------------

/** Seconds → "2 h 14 min", "3 d 4 h", "12 min". */
export function formatDuration(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0)
        return h > 0 ? `${d} d ${h} h` : `${d} d`;
    if (h > 0)
        return m > 0 ? `${h} h ${m} min` : `${h} h`;
    return `${m} min`;
}

// UPower states (org.freedesktop.UPower.Device.State).
const CHARGING = 1;
const DISCHARGING = 2;
const FULLY_CHARGED = 4;
const PENDING_CHARGE = 5;

/** Text of the battery row from UPower's properties. */
export function formatBattery({percentage, state, timeToEmpty, timeToFull}) {
    const parts = [`${Math.round(percentage)} %`];
    if (state === FULLY_CHARGED || (state === CHARGING && percentage >= 100)) {
        parts.push('charged');
    } else if (state === CHARGING) {
        parts.push('charging');
        if (timeToFull > 0)
            parts.push(`${formatDuration(timeToFull)} until full`);
    } else if (state === PENDING_CHARGE) {
        parts.push('plugged in, not charging');
    } else if (state === DISCHARGING && timeToEmpty > 0) {
        parts.push(`${formatDuration(timeToEmpty)} left`);
    }
    return parts.join(' · ');
}

// NetworkManager connection type → readable name.
const CONNECTION_TYPES = {
    '802-11-wireless': 'Wi-Fi',
    '802-3-ethernet': 'Ethernet',
    'vpn': 'VPN',
    'wireguard': 'VPN',
    'gsm': 'Mobile',
    'cdma': 'Mobile',
    'bluetooth': 'Bluetooth',
};

/** {name, kind, ip} of the primary connection of an NM.Client, or null. */
export function primaryConnection(client) {
    const ac = client?.get_primary_connection?.() ?? null;
    if (!ac)
        return null;
    const address = config => config?.get_addresses?.()?.[0]?.get_address?.() ?? null;
    const type = ac.get_connection_type?.() ?? '';
    return {
        name: ac.get_id?.() ?? '',
        kind: CONNECTION_TYPES[type] ?? type,
        ip: address(ac.get_ip4_config?.()) ?? address(ac.get_ip6_config?.()),
    };
}
