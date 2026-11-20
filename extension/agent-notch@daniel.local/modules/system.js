// System module: RAM and swap like `free -h`, in the expanded view, in a
// Home card and in its own panel tab. The tab (S2) also shows
// CPU and temperature, disk, battery, network, public IP (with a button),
// uptime and the system version, and the internet speed on
// demand (measured by a separate D-Bus service, docs/16-velocidad-internet.md).
// See docs/12-modulo-sistema.md.
//
// Cost: memory does not notify when it changes, so it has to be polled,
// but ONLY while one of its views is visible, every 2 s and
// asynchronously. The tab's data is only read (and its signals only listened to)
// while the tab is visible. With the island idle nothing is running.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import {loadInterfaceXML} from 'resource:///org/gnome/shell/misc/fileUtils.js';

import {NotchModule} from './module.js';
import {Bar, makeLabel} from './widgets.js';
import * as Info from './sysinfo.js';

const PRIORITY = 0;          // below the music
const REFRESH_SECONDS = 2;
const MEMINFO = '/proc/meminfo';
const DISK_EVERY_TICKS = 5;  // disk: every 10 s
const PUBLIC_IP_URL = 'https://api.ipify.org';
const PUBLIC_IP_TIMEOUT_S = 5;
const IP_RE = /^[0-9a-fA-F:.]{3,45}$/;

const UPowerProxy = Gio.DBusProxy.makeProxyWrapper(
    loadInterfaceXML('org.freedesktop.UPower.Device'));

// Speed test: a separate service (services/speedtest/speedtest.py) that
// D-Bus starts when Start is called and that quits on its own when done.
const SPEED_BUS_NAME = 'dev.agentnotch.SpeedTest';
const SPEED_OBJECT_PATH = '/dev/agentnotch/SpeedTest';
const SpeedTestProxy = Gio.DBusProxy.makeProxyWrapper(`
<node>
  <interface name="dev.agentnotch.SpeedTest">
    <method name="Start"/>
    <method name="Cancel"/>
    <signal name="Progress"><arg name="phase" type="s"/><arg name="value" type="d"/></signal>
    <signal name="Finished">
      <arg name="latency_ms" type="d"/><arg name="download_mbps" type="d"/><arg name="upload_mbps" type="d"/>
    </signal>
    <signal name="Failed"><arg name="message" type="s"/></signal>
  </interface>
</node>`);

// 94 Mbps, 8.5 Mbps
function formatMbps(mbps) {
    return `${mbps < 10 ? mbps.toFixed(1) : Math.round(mbps)} Mbps`;
}

// Identifier of the current network (to forget the speed measured on another one).
// ⚠️ GNOME 50 internal, same as in _watchNetwork().
function currentNetworkId() {
    const client = Main.panel.statusArea.quickSettings?._network?._client;
    return client?.primary_connection?.get_uuid?.() ?? null;
}

// Like `free -h` (procps-ng 4): binary units; one decimal below
// 10 and an integer (truncated) from 10 up.  E.g.: 3.4Gi, 899Mi, 14Gi, 0B
export function formatBytes(bytes) {
    if (bytes <= 0)
        return '0B';
    const units = ['B', 'Ki', 'Mi', 'Gi', 'Ti'];
    let value = bytes;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024;
        i++;
    }
    if (i === 0)
        return `${Math.round(value)}B`;
    return value < 10 ? `${value.toFixed(1)}${units[i]}` : `${Math.floor(value)}${units[i]}`;
}

// Returns {memTotal, memUsed, swapTotal, swapUsed} in bytes.
// used = MemTotal − MemAvailable (same as `free` in procps-ng 4).
export function parseMeminfo(text) {
    const kb = {};
    for (const line of text.split('\n')) {
        const m = /^(\w+):\s+(\d+)/.exec(line);
        if (m)
            kb[m[1]] = Number(m[2]);
    }
    const memTotal = (kb.MemTotal ?? 0) * 1024;
    const memAvailable = (kb.MemAvailable ?? kb.MemFree ?? 0) * 1024;
    const swapTotal = (kb.SwapTotal ?? 0) * 1024;
    const swapFree = (kb.SwapFree ?? 0) * 1024;
    return {
        memTotal,
        memUsed: Math.max(0, memTotal - memAvailable),
        swapTotal,
        swapUsed: Math.max(0, swapTotal - swapFree),
    };
}

// A row: "RAM   3.4Gi / 14Gi" + usage bar.
const UsageRow = GObject.registerClass(
class UsageRow extends St.BoxLayout {
    _init(name) {
        super._init({
            style_class: 'agent-notch-usage-row',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        const header = new St.BoxLayout({x_expand: true});
        this.add_child(header);
        header.add_child(new St.Label({
            text: name,
            style_class: 'agent-notch-usage-name',
            x_expand: true,
        }));
        this._value = new St.Label({style_class: 'agent-notch-usage-value'});
        header.add_child(this._value);

        this._bar = new Bar();
        this.add_child(this._bar);
    }

    set(used, total) {
        const fraction = total > 0 ? Math.min(1, used / total) : 0;
        this.setText(`${formatBytes(used)} / ${formatBytes(total)}`, fraction);
    }

    // Free text + bar fraction (0–1).
    setText(text, fraction) {
        if (this._value.text !== text)
            this._value.text = text;
        this._bar.setFraction(fraction);

        // Color by usage: normal, high (≥ 75 %), critical (≥ 90 %).
        const level = fraction >= 0.9 ? 'critical' : fraction >= 0.75 ? 'high' : null;
        for (const cls of ['high', 'critical']) {
            if (cls === level)
                this._bar.fill.add_style_class_name(cls);
            else
                this._bar.fill.remove_style_class_name(cls);
        }
    }
});

// RAM + swap (the swap row only if there is swap).
const UsageView = GObject.registerClass(
class UsageView extends St.BoxLayout {
    _init(styleClass) {
        super._init({
            style_class: styleClass,
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._ram = new UsageRow('RAM');
        this._swap = new UsageRow('Swap');
        this._swap.visible = false;
        this.add_child(this._ram);
        this.add_child(this._swap);
    }

    // Returns true if the swap's visibility changed (the size changes).
    update({memTotal, memUsed, swapTotal, swapUsed}) {
        this._ram.set(memUsed, memTotal);
        const hasSwap = swapTotal > 0;
        if (hasSwap)
            this._swap.set(swapUsed, swapTotal);
        if (this._swap.visible === hasSwap)
            return false;
        this._swap.visible = hasSwap;
        return true;
    }
});

// Data row: "Name      value" (+ an optional widget on the right).
const InfoRow = GObject.registerClass(
class InfoRow extends St.BoxLayout {
    _init(name, extra = null) {
        super._init({style_class: 'agent-notch-info-row', x_expand: true});
        this.add_child(new St.Label({
            text: name,
            style_class: 'agent-notch-info-name',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._value = makeLabel('agent-notch-info-value', {
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._value);
        if (extra)
            this.add_child(extra);
    }

    setValue(text) {
        if (this._value.text !== text)
            this._value.text = text;
    }
});

// System tab: RAM/swap, CPU, disk and machine data.
const SystemPage = GObject.registerClass(
class SystemPage extends St.BoxLayout {
    _init(onPublicIp, onSpeedTest) {
        super._init({
            style_class: 'agent-notch-system agent-notch-system-page',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.usage = new UsageView('agent-notch-system-usage');
        this.cpu = new UsageRow('CPU');
        this.disk = new UsageRow('Disk');
        this.add_child(this.usage);
        this.add_child(this.cpu);
        this.add_child(this.disk);

        const info = new St.BoxLayout({
            style_class: 'agent-notch-info',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this.add_child(info);

        this.battery = new InfoRow('Battery');
        this.battery.visible = false;
        this.network = new InfoRow('Network');
        this.network.visible = false;
        this.publicIpButton = new St.Button({
            style_class: 'agent-notch-system-button',
            label: 'Check',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.publicIpButton.connect('clicked', () => onPublicIp());
        this.publicIp = new InfoRow('Public IP', this.publicIpButton);
        this.speedButton = new St.Button({
            style_class: 'agent-notch-system-button',
            label: 'Test',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.speedButton.connect('clicked', () => onSpeedTest());
        this.speed = new InfoRow('Speed', this.speedButton);
        this.uptime = new InfoRow('Uptime');
        this.os = new InfoRow('System');
        for (const row of [this.battery, this.network, this.publicIp, this.speed, this.uptime, this.os])
            info.add_child(row);
    }

    update(meminfo) {
        return this.usage.update(meminfo);
    }
});

export const SystemModule = GObject.registerClass(
class SystemModule extends NotchModule {
    _init() {
        super._init();
        this._exp = null;          // views: created on first use
        this._card = null;
        this._page = null;
        this._last = null;         // last reading (for freshly created views)
        this._timerId = 0;
        this._cancellable = null;
        this._file = Gio.File.new_for_path(MEMINFO);

        // Tab (S2): only active while visible.
        this._pageActive = false;
        this._pageCancellable = null;
        this._ticks = 0;
        this._cpuPrev = null;
        this._sensorPath = undefined;   // undefined = not looked up yet; null = there is none
        this._uptimeBase = null;        // {seconds, at (monotonic µs)}
        this._osText = null;
        this._upower = null;
        this._nmClient = null;
        this._ipCancellable = null;

        // Speed: proxy only while measuring; the result, until the
        // network changes.
        this._speedProxy = null;
        this._speedSignals = [];
        this._speedText = '';
        this._speedNetwork = null;
        this._speedDown = null;
    }

    get priority() {
        return PRIORITY;
    }

    // No compact view: the RAM only shows when expanding.
    get active() {
        return false;
    }

    get hasExpanded() {
        return true;
    }

    get expandedActor() {
        this._exp ??= this._newView('agent-notch-system');
        return this._exp;
    }

    get homeCard() {
        this._card ??= this._newView('agent-notch-system agent-notch-card');
        return this._card;
    }

    get pageActor() {
        if (!this._page) {
            this._page = new SystemPage(
                () => this._queryPublicIp(),
                () => this._toggleSpeedTest());
            if (this._last)
                this._page.update(this._last);
            this._showSpeed();
        }
        return this._page;
    }

    get pageTitle() {
        return 'System';
    }

    get pageIcon() {
        return 'utilities-system-monitor-symbolic';
    }

    _newView(styleClass) {
        const view = new UsageView(styleClass);
        if (this._last)
            view.update(this._last);
        return view;
    }

    // Read the RAM while any of the views is visible; the rest, only
    // with the tab visible.
    _onViewsChanged(views) {
        if (views.has('page') && this._page)
            this._startPage();
        else
            this._stopPage();

        if (views.size > 0)
            this._start();
        else
            this._stop();
    }

    _start() {
        if (this._timerId)
            return;
        this._refresh();
        // timeout_add_seconds groups the wakeups with others from the system
        // (better for the battery than a millisecond timer).
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, REFRESH_SECONDS, () => {
            this._refresh();
            if (this._pageActive)
                this._refreshPage(++this._ticks % DISK_EVERY_TICKS === 0);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stop() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        this._cancellable?.cancel();
        this._cancellable = null;
    }

    _refresh() {
        if (this._cancellable)   // a reading is already in progress
            return;
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        this._file.load_contents_async(cancellable, (file, result) => {
            if (this._cancellable === cancellable)
                this._cancellable = null;
            let contents;
            try {
                [, contents] = file.load_contents_finish(result);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.error('[agent-notch] Could not read', MEMINFO, e.message);
                return;
            }
            this._show(parseMeminfo(new TextDecoder().decode(contents)));
        });
    }

    _show(info) {
        this._last = info;
        // The island's size does not change when the numbers update, so
        // 'changed' is not emitted (avoids recomputing the layout every 2 s)...
        let resized = false;
        for (const view of [this._exp, this._card, this._page]) {
            if (view)
                resized = view.update(info) || resized;
        }
        if (resized)
            this.emit('changed');  // ...unless the swap appears or disappears.
    }

    // --- System tab (S2) -------------------------------------------------

    _startPage() {
        if (this._pageActive)
            return;
        this._pageActive = true;
        this._pageCancellable = new Gio.Cancellable();
        this._ticks = 0;
        this._cpuPrev = null;
        this._page.cpu.setText('measuring…', 0);

        // Speed measured on another network: no longer valid.
        if (!this._speedProxy && this._speedText && this._speedNetwork !== currentNetworkId())
            this._setSpeed('');

        this._showOs();
        this._readUptime();
        this._watchBattery();
        this._watchNetwork();
        this._refreshPage(true);
    }

    _stopPage() {
        if (!this._pageActive)
            return;
        this._pageActive = false;
        this._pageCancellable?.cancel();
        this._pageCancellable = null;
        this._ipCancellable?.cancel();
        this._ipCancellable = null;
        this._upower?.disconnectObject(this);
        this._nmClient?.disconnectObject(this);
        this._nmClient = null;
        // The public IP is forgotten when the tab closes.
        this._page?.publicIp.setValue('');
        if (this._page)
            this._page.publicIpButton.visible = true;
    }

    // Every 2 s with the tab visible: CPU, temperature, network,
    // uptime and, when due, the disk.
    async _refreshPage(withDisk) {
        const cancellable = this._pageCancellable;
        const page = this._page;
        if (!cancellable || !page)
            return;
        try {
            if (this._sensorPath === undefined)
                this._sensorPath = await Info.findCpuSensor(cancellable);

            const [stat, temp] = await Promise.all([
                Info.readText('/proc/stat', cancellable),
                this._sensorPath
                    ? Info.readText(this._sensorPath, cancellable).catch(e => {
                        if (Info.isCancelled(e))
                            throw e;
                        return null;
                    })
                    : null,
            ]);
            const cur = Info.parseCpuStat(stat);
            const usage = Info.cpuUsage(this._cpuPrev, cur);
            this._cpuPrev = cur;
            // Until the second reading there is no usage (docs/09: "…" looked like "_").
            const parts = [usage === null ? 'measuring…' : `${Math.round(usage * 100)} %`];
            if (temp !== null)
                parts.push(`${Math.round(Number(temp) / 1000)} °C`);
            page.cpu.setText(parts.join('  ·  '), usage ?? 0);

            this._showNetwork();
            this._showUptime();

            if (withDisk) {
                // Like `df -h`: "used / size" and the bar with df's
                // Use%, used / (used + available).
                const {size, used, free} = await Info.queryDisk('/', cancellable);
                page.disk.setText(`${formatBytes(used)} / ${formatBytes(size)}`,
                    used + free > 0 ? used / (used + free) : 0);
            }
        } catch (e) {
            if (!Info.isCancelled(e))
                console.warn(`[agent-notch] System: ${e.message}`);
        }
    }

    _showOs() {
        if (this._osText) {
            this._page.os.setValue(this._osText);
            return;
        }
        const os = GLib.get_os_info('PRETTY_NAME') ?? 'Linux';
        const gnome = `GNOME ${Config.PACKAGE_VERSION}`;
        this._page.os.setValue(`${os} · ${gnome}`);
        Info.readText('/proc/sys/kernel/osrelease', this._pageCancellable).then(kernel => {
            this._osText = `${os} · Linux ${kernel.trim()} · ${gnome}`;
            this._page?.os.setValue(this._osText);
        }).catch(() => {});
    }

    async _readUptime() {
        try {
            const text = await Info.readText('/proc/uptime', this._pageCancellable);
            this._uptimeBase = {
                seconds: parseFloat(text.split(' ')[0]),
                at: GLib.get_monotonic_time(),
            };
            this._showUptime();
        } catch (e) {
            if (!Info.isCancelled(e))
                console.warn(`[agent-notch] System: ${e.message}`);
        }
    }

    _showUptime() {
        if (!this._uptimeBase || !this._page)
            return;
        const {seconds, at} = this._uptimeBase;
        this._page.uptime.setValue(
            Info.formatDuration(seconds + (GLib.get_monotonic_time() - at) / 1e6));
    }

    // Battery: UPower proxy (created once, asynchronous); its changes
    // are only listened to with the tab visible.
    _watchBattery() {
        if (!this._upower) {
            this._upower = new UPowerProxy(Gio.DBus.system, 'org.freedesktop.UPower',
                '/org/freedesktop/UPower/devices/DisplayDevice', (_proxy, error) => {
                    if (error) {
                        console.warn(`[agent-notch] System: UPower: ${error.message}`);
                        return;
                    }
                    this._showBattery();
                });
        } else {
            this._showBattery();
        }
        this._upower.connectObject('g-properties-changed', () => this._showBattery(), this);
    }

    _showBattery() {
        const page = this._page;
        const p = this._upower;
        if (!page || !p)
            return;
        const present = Boolean(p.IsPresent) && p.Type === 2;   // 2 = battery
        if (present) {
            page.battery.setValue(Info.formatBattery({
                percentage: p.Percentage ?? 0,
                state: p.State ?? 0,
                timeToEmpty: Number(p.TimeToEmpty ?? 0),
                timeToFull: Number(p.TimeToFull ?? 0),
            }));
        }
        this._setRowVisible(page.battery, present);
    }

    // Network: the NM.Client GNOME already has open.
    // ⚠️ GNOME 50 internal: Main.panel.statusArea.quickSettings._network._client
    _watchNetwork() {
        this._nmClient = Main.panel.statusArea.quickSettings?._network?._client ?? null;
        this._nmClient?.connectObject('notify::primary-connection', () => {
            // Another network: the public IP and the measured speed are no longer valid.
            this._cancelSpeedTest();
            this._setSpeed('');
            this._ipCancellable?.cancel();
            this._ipCancellable = null;
            this._page?.publicIp.setValue('');
            if (this._page)
                this._page.publicIpButton.visible = true;
            this._showNetwork();
        }, this);
        this._showNetwork();
    }

    _showNetwork() {
        const page = this._page;
        if (!page)
            return;
        if (!this._nmClient) {
            this._setRowVisible(page.network, false);
            return;
        }
        const c = Info.primaryConnection(this._nmClient);
        page.network.setValue(c
            ? [`${c.name}${c.kind ? ` (${c.kind})` : ''}`, c.ip].filter(Boolean).join(' · ')
            : 'No connection');
        this._setRowVisible(page.network, true);
    }

    // Public IP: ONE small request, only when pressing "Check".
    _queryPublicIp() {
        const page = this._page;
        if (!page || this._ipCancellable)
            return;
        const cancellable = new Gio.Cancellable();
        this._ipCancellable = cancellable;
        page.publicIpButton.visible = false;
        page.publicIp.setValue('Checking…');

        const session = new Soup.Session({timeout: PUBLIC_IP_TIMEOUT_S});
        const message = Soup.Message.new('GET', PUBLIC_IP_URL);
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
            if (this._ipCancellable !== cancellable)
                return;   // cancelled (tab closed or network change)
            this._ipCancellable = null;
            let text = null;
            try {
                const bytes = s.send_and_read_finish(res);
                if (message.get_status() === Soup.Status.OK)
                    text = new TextDecoder().decode(bytes.toArray()).trim();
            } catch (e) {
                if (Info.isCancelled(e))
                    return;
            }
            if (!this._page)
                return;
            const ok = text !== null && IP_RE.test(text);
            this._page.publicIp.setValue(ok ? text : 'Could not check');
            this._page.publicIpButton.visible = !ok;
        });
    }

    // --- Internet speed (docs/16-velocidad-internet.md) ----------------

    _toggleSpeedTest() {
        if (this._speedProxy)
            this._cancelSpeedTest();
        else
            this._startSpeedTest();
    }

    _startSpeedTest() {
        this._speedNetwork = currentNetworkId();
        this._speedDown = null;
        this._setSpeed('Testing…');

        // Asynchronous proxy; D-Bus starts the service when Start is called.
        const proxy = new SpeedTestProxy(Gio.DBus.session, SPEED_BUS_NAME, SPEED_OBJECT_PATH,
            (p, error) => {
                if (this._speedProxy !== p)
                    return;   // cancelled while it was being created
                if (error) {
                    this._speedFailed(error.message);
                    return;
                }
                p.StartRemote((_result, startError) => {
                    if (startError && this._speedProxy === p)
                        this._speedFailed(startError.message);
                });
            }, null, Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES);
        this._speedProxy = proxy;
        this._speedSignals = [
            proxy.connectSignal('Progress', (_p, _sender, [phase, value]) =>
                this._onSpeedProgress(phase, value)),
            proxy.connectSignal('Finished', (_p, _sender, [latency, down, up]) => {
                this._releaseSpeedProxy();
                this._setSpeed(`↓ ${formatMbps(down)} · ↑ ${formatMbps(up)} · ${Math.round(latency)} ms`);
            }),
            proxy.connectSignal('Failed', (_p, _sender, [message]) => this._speedFailed(message)),
        ];
    }

    _onSpeedProgress(phase, value) {
        if (phase === 'latency') {
            this._setSpeed(`Latency ${Math.round(value)} ms…`);
        } else if (phase === 'download') {
            this._speedDown = value;
            this._setSpeed(`↓ ${formatMbps(value)}…`);
        } else if (phase === 'upload') {
            const down = this._speedDown !== null ? `↓ ${formatMbps(this._speedDown)} · ` : '';
            this._setSpeed(`${down}↑ ${formatMbps(value)}…`);
        }
    }

    _speedFailed(message) {
        this._releaseSpeedProxy();
        // Cloudflare limits tests run too close together (HTTP 429).
        if (message === 'rate-limited') {
            this._setSpeed('Too many tests in a row; wait a few minutes');
            return;
        }
        console.warn(`[agent-notch] System: speed test: ${message}`);
        this._setSpeed('Could not test');
    }

    _cancelSpeedTest() {
        const proxy = this._speedProxy;
        if (!proxy)
            return;
        this._releaseSpeedProxy();
        // The service quits when it gets Cancel (and also if GNOME Shell
        // leaves the bus).
        proxy.CancelRemote(() => {});
        this._setSpeed('');
    }

    _releaseSpeedProxy() {
        for (const id of this._speedSignals)
            this._speedProxy?.disconnectSignal(id);
        this._speedSignals = [];
        this._speedProxy = null;
    }

    _setSpeed(text) {
        this._speedText = text;
        this._showSpeed();
    }

    _showSpeed() {
        if (!this._page)
            return;
        this._page.speed.setValue(this._speedText);
        this._page.speedButton.label = this._speedProxy ? 'Cancel' : 'Test';
    }

    // Showing or hiding a row changes the size: tell the island.
    _setRowVisible(row, visible) {
        if (row.visible === visible)
            return;
        row.visible = visible;
        this.emit('changed');
    }

    destroy() {
        this._cancelSpeedTest();
        this._stopPage();
        this._upower = null;
        this._stop();
        for (const view of [this._exp, this._card, this._page])
            view?.destroy();
        this._exp = this._card = this._page = null;
        this._file = null;
    }
});
