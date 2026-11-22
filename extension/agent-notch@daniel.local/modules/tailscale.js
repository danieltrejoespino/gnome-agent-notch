// Tailscale module: a panel tab to turn Tailscale on or off, see this device
// and the others in the tailnet, copy their IPs and pick an exit node
// (docs/21-modulo-tailscale.md).
//
// It speaks HTTP with tailscaled's local API over its socket using Soup
// (without launching `tailscale`): the extension does not launch processes
// (Rule 2). Reading works for any user; changing settings needs the user to be
// Tailscale's operator (`sudo tailscale set --operator=$USER`, once).
//
// The tab only exists if the socket exists. Without Tailscale, the module does
// nothing else than check that once when enabled.
//
// Consumo:
//   - With the tab hidden: nothing (no connections, no timers).
//   - When shown: it opens the notification bus (watch-ipn-bus) and asks for
//     /status and /prefs once. Each notification (or batch, grouped in
//     300 ms) asks for them again; the bus is silent while nothing changes.
//   - When hidden: it closes the bus. Commands in progress run until they finish.
//   - Rows are created once per device and reused.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import {NotchModule} from './module.js';
import {isCancelled} from './sysinfo.js';
import {makeLabel} from './widgets.js';
import {
    OPERATOR_HINT, SOCKET, actionOk, allowLanPrefs, apiUrl, canWrite, errorMessage, exitNodePrefs,
    firstIPv4, isDenied, isRunning, needsLogin, parsePrefs, parseStatus, peerDetail, runningPrefs,
    stateText, watchUrl,
} from './tailscalestate.js';

// The tab goes right after Docker (5).
const PRIORITY = 4;
const ICON = 'network-vpn-symbolic';
const BATCH_MS = 300;          // the network map arrives in bursts
const FLASH_S = 2;             // "Copied" and errors on a row
const ERROR_S = 6;
const SELF = 'self';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export const TailscaleModule = GObject.registerClass(
class TailscaleModule extends NotchModule {
    _init() {
        super._init();

        this._available = false;
        this._user = GLib.get_user_name();
        this._session = null;         // Soup, on first use
        this._cancellable = new Gio.Cancellable();   // everything (cancelled in destroy)
        this._bus = null;             // Gio.Cancellable of the notification bus
        this._batchId = 0;
        this._flashId = 0;
        this._gen = 0;
        this._status = null;
        this._prefs = null;
        this._denied = false;         // a change came back 403
        this._busy = new Set();       // 'running' | 'exit' | 'lan'
        this._flash = new Map();      // row key → {text, error, until}
        this._mode = 'list';          // 'list' | 'down'
        this._page = null;            // on first use
        this._shownShape = '';

        this._checkSocket();
    }

    get priority() {
        return PRIORITY;
    }

    get pageTitle() {
        return this._available ? 'Tailscale' : '';
    }

    get pageIcon() {
        return ICON;
    }

    get pageActor() {
        this._page ??= this._buildPage();
        return this._page.actor;
    }

    // --- Is there Tailscale? ------------------------------------------------------------

    _checkSocket() {
        const file = Gio.File.new_for_path(SOCKET);
        file.query_info_async('standard::type', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_LOW, this._cancellable, (f, res) => {
                let info;
                try {
                    info = f.query_info_finish(res);
                } catch {
                    return;   // no Tailscale (or cancelled): no tab
                }
                this._available = info.get_file_type() === Gio.FileType.SPECIAL;
                if (this._available)
                    this.emit('changed');
            });
    }

    // --- HTTP over the socket -------------------------------------------------------------

    _soup() {
        this._session ??= new Soup.Session({
            remote_connectable: Gio.UnixSocketAddress.new(SOCKET),
            // No I/O limit: the bus stays silent for as long as nothing changes.
            timeout: 0,
            // Idle connections closed soon: with the tab hidden none stays open.
            idle_timeout: 5,
            max_conns_per_host: 4,
        });
        return this._session;
    }

    // Promise with {status, text}. Rejects if tailscaled cannot be reached.
    _request(method, path, body = null) {
        const message = Soup.Message.new(method, apiUrl(path));
        if (body) {
            message.set_request_body_from_bytes('application/json',
                new GLib.Bytes(encoder.encode(JSON.stringify(body))));
        }
        return new Promise((resolve, reject) => {
            this._soup().send_and_read_async(message, GLib.PRIORITY_DEFAULT, this._cancellable, (s, res) => {
                try {
                    const bytes = s.send_and_read_finish(res);
                    resolve({status: message.get_status(), text: decoder.decode(bytes.get_data() ?? new Uint8Array())});
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    // --- Tab visible: bus + state -----------------------------------------------------

    _onViewsChanged(views) {
        if (views.has('page'))
            this._watch();
        else
            this._unwatch();
    }

    // The bus sends the current state first, which triggers the first read.
    _watch() {
        if (this._bus)
            return;
        const cancellable = new Gio.Cancellable();
        this._bus = cancellable;
        const message = Soup.Message.new('GET', watchUrl());
        this._soup().send_async(message, GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
            let stream;
            try {
                stream = s.send_finish(res);
            } catch (e) {
                if (!isCancelled(e))
                    this._busDown(cancellable, e.message);
                return;
            }
            if (message.get_status() !== Soup.Status.OK) {
                this._busDown(cancellable, `watch-ipn-bus: ${message.get_status()}`);
                return;
            }
            const lines = new Gio.DataInputStream({base_stream: stream, close_base_stream: true});
            this._readNotify(lines, cancellable);
        });
    }

    _readNotify(lines, cancellable) {
        lines.read_line_async(GLib.PRIORITY_LOW, cancellable, (l, res) => {
            let line;
            try {
                [line] = l.read_line_finish_utf8(res);
            } catch (e) {
                if (!isCancelled(e))
                    this._busDown(cancellable, e.message);
                l.close_async(GLib.PRIORITY_LOW, null, null);
                return;
            }
            if (line === null) {
                // tailscaled closed the bus (it stopped or restarted).
                l.close_async(GLib.PRIORITY_LOW, null, null);
                this._busDown(cancellable, 'end of the notification bus');
                return;
            }
            // No need to look at what changed: /status and /prefs have it all.
            this._queueRefresh();
            this._readNotify(l, cancellable);
        });
    }

    _unwatch() {
        this._bus?.cancel();
        this._bus = null;
        if (this._batchId) {
            GLib.source_remove(this._batchId);
            this._batchId = 0;
        }
    }

    _busDown(cancellable, why) {
        if (cancellable !== this._bus)
            return;   // already closed or reopened
        console.log(`[agent-notch] Tailscale: not responding (${why})`);
        this._bus = null;
        this._setMode('down');
    }

    _queueRefresh() {
        if (this._batchId)
            return;
        this._batchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BATCH_MS, () => {
            this._batchId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refresh() {
        // If two answers arrive, only the last one requested counts.
        const gen = ++this._gen;
        let status, prefs;
        try {
            const [st, pr] = await Promise.all([
                this._request('GET', '/status'),
                this._request('GET', '/prefs'),
            ]);
            status = st.status === Soup.Status.OK ? parseStatus(st.text) : null;
            prefs = pr.status === Soup.Status.OK ? parsePrefs(pr.text) : null;
            if (!status || !prefs)
                throw new Error(errorMessage(st.status === Soup.Status.OK ? pr.status : st.status, st.text));
        } catch (e) {
            if (isCancelled(e) || gen !== this._gen || !this._cancellable)
                return;
            console.log(`[agent-notch] Tailscale: could not read the state: ${e.message}`);
            this._setMode('down');
            return;
        }
        if (gen !== this._gen || !this._cancellable)
            return;
        this._status = status;
        this._prefs = prefs;
        if (canWrite(prefs, this._user))
            this._denied = false;
        this._setMode('list');
        this._render();
    }

    // --- Commands ------------------------------------------------------------------------

    async _patch(key, body, flashKey) {
        if (this._busy.has(key))
            return;
        this._busy.add(key);
        this._render();
        try {
            const {status, text} = await this._request('PATCH', '/prefs', body);
            if (isDenied(status)) {
                this._denied = true;
                this._showFlash(flashKey, 'Not allowed: see the command below', true);
            } else if (!actionOk(status)) {
                this._showFlash(flashKey, errorMessage(status, text), true);
            }
        } catch (e) {
            if (isCancelled(e))
                return;
            this._showFlash(flashKey, e.message, true);
        }
        if (!this._cancellable)
            return;   // destroyed in the meantime
        this._busy.delete(key);
        // The bus brings the change too, but a change that changes nothing
        // sends no notification, and with the tab hidden there is no bus.
        if (this._bus)
            this._queueRefresh();
        else
            this._render();
    }

    _toggleRunning() {
        const on = !this._prefs?.wantRunning;
        this._patch('running', runningPrefs(on), SELF);
    }

    _toggleExitNode(peer) {
        const inUse = this._prefs?.exitNodeId === peer.id;
        this._patch('exit', exitNodePrefs(inUse ? '' : peer.id), peer.id);
    }

    _toggleLan() {
        this._patch('lan', allowLanPrefs(!this._prefs?.allowLan), SELF);
    }

    _copy(key, ip) {
        if (!ip)
            return;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, ip);
        this._showFlash(key, `Copied ${ip}`, false);
    }

    // A temporary text on a row ("Copied", an error). A single timer, only while
    // one is visible.
    _showFlash(key, text, error) {
        if (error)
            console.log(`[agent-notch] Tailscale: ${text}`);
        const seconds = error ? ERROR_S : FLASH_S;
        this._flash.set(key, {text, error, until: GLib.get_monotonic_time() + seconds * 1e6});
        this._render();
        if (!this._flashId) {
            this._flashId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, FLASH_S, () => {
                const now = GLib.get_monotonic_time();
                for (const [k, f] of this._flash) {
                    if (f.until <= now)
                        this._flash.delete(k);
                }
                this._render();
                if (this._flash.size > 0)
                    return GLib.SOURCE_CONTINUE;
                this._flashId = 0;
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    // --- Page ---------------------------------------------------------------------------

    _buildPage() {
        const actor = new St.BoxLayout({
            style_class: 'agent-notch-tailscale-page',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.START,
        });

        // Header: this device (click → copy its IP) and Turn on / Turn off.
        const body = new St.BoxLayout({
            style_class: 'agent-notch-tailscale-body',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        const header = new St.BoxLayout({style_class: 'agent-notch-tailscale-header', x_expand: true});
        const selfBox = new St.BoxLayout({style_class: 'agent-notch-tailscale-self-box', x_expand: true});
        const dot = new St.Widget({style_class: 'agent-notch-dot', y_align: Clutter.ActorAlign.CENTER});
        const selfText = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const title = makeLabel('agent-notch-tailscale-title');
        const detail = makeLabel('agent-notch-tailscale-detail');
        const suffix = makeLabel('agent-notch-tailscale-suffix');
        selfText.add_child(title);
        selfText.add_child(detail);
        selfText.add_child(suffix);
        selfBox.add_child(dot);
        selfBox.add_child(selfText);
        const self = new St.Button({
            style_class: 'agent-notch-tailscale-self',
            child: selfBox,
            can_focus: true,
            x_expand: true,
        });
        self.connect('clicked', () => this._copy(SELF, firstIPv4(this._status?.self?.ips ?? [])));
        const power = new St.Button({
            style_class: 'agent-notch-tailscale-power',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        power.connect('clicked', () => this._toggleRunning());
        header.add_child(self);
        header.add_child(power);
        body.add_child(header);

        // Without operator / without session: what to run in a terminal.
        const hint = new St.BoxLayout({
            style_class: 'agent-notch-tailscale-hint',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            visible: false,
        });
        const hintText = makeLabel('agent-notch-tailscale-hint-text');
        hintText.clutter_text.line_wrap = true;
        const hintCommand = makeLabel('agent-notch-tailscale-hint-command');
        hint.add_child(hintText);
        hint.add_child(hintCommand);
        body.add_child(hint);

        // "Allow local network", only while an exit node is in use.
        const lanIcon = new St.Icon({style_class: 'agent-notch-tailscale-lan-icon'});
        const lanBox = new St.BoxLayout({style_class: 'agent-notch-tailscale-lan-box'});
        lanBox.add_child(lanIcon);
        lanBox.add_child(new St.Label({text: 'Allow local network', y_align: Clutter.ActorAlign.CENTER}));
        const lan = new St.Button({
            style_class: 'agent-notch-tailscale-lan',
            child: lanBox,
            can_focus: true,
            x_align: Clutter.ActorAlign.START,
            visible: false,
        });
        lan.connect('clicked', () => this._toggleLan());
        body.add_child(lan);

        const devicesTitle = makeLabel('agent-notch-tailscale-devices-title');
        body.add_child(devicesTitle);
        const list = new St.BoxLayout({
            style_class: 'agent-notch-tailscale-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        const scroll = new St.ScrollView({
            style_class: 'agent-notch-tailscale-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            child: list,
        });
        body.add_child(scroll);
        const empty = makeLabel('agent-notch-tailscale-empty', {x_align: Clutter.ActorAlign.CENTER});
        body.add_child(empty);
        actor.add_child(body);

        // tailscaled not responding: the same space with Retry.
        const notice = new St.BoxLayout({
            style_class: 'agent-notch-docker-notice',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        notice.add_child(new St.Icon({icon_name: ICON, style_class: 'agent-notch-docker-notice-icon'}));
        notice.add_child(new St.Label({
            style_class: 'agent-notch-docker-notice-title',
            text: 'Tailscale is not responding',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        const retry = new St.Button({
            style_class: 'agent-notch-docker-retry',
            label: 'Retry',
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        retry.connect('clicked', () => {
            this._setMode('list');
            this._watch();
        });
        notice.add_child(retry);
        actor.add_child(notice);

        const page = {
            actor, body, dot, header, self, title, detail, suffix, power, hint, hintText, hintCommand,
            lan, lanIcon, devicesTitle, list, scroll, empty, notice, rows: new Map(),
        };
        this._page = page;
        this._applyMode();
        this._render();
        return page;
    }

    _setMode(mode) {
        if (mode === this._mode)
            return;
        this._mode = mode;
        this._applyMode();
    }

    _applyMode() {
        const page = this._page;
        if (!page)
            return;
        const down = this._mode === 'down';
        page.body.visible = !down;
        page.notice.visible = down;
        this.emit('changed');
    }

    _newRow() {
        const r = {};
        r.actor = new St.BoxLayout({style_class: 'agent-notch-tailscale-row', x_expand: true});
        const box = new St.BoxLayout({style_class: 'agent-notch-tailscale-row-box', x_expand: true});
        r.dot = new St.Widget({style_class: 'agent-notch-dot', y_align: Clutter.ActorAlign.CENTER});
        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        r.name = makeLabel('agent-notch-tailscale-row-name');
        r.detail = makeLabel('agent-notch-tailscale-row-detail');
        text.add_child(r.name);
        text.add_child(r.detail);
        box.add_child(r.dot);
        box.add_child(text);
        r.copy = new St.Button({
            style_class: 'agent-notch-tailscale-row-copy',
            child: box,
            can_focus: true,
            x_expand: true,
        });
        r.copy.connect('clicked', () => {
            if (r.data)
                this._copy(r.data.id, firstIPv4(r.data.ips));
        });
        r.exit = new St.Button({
            style_class: 'agent-notch-tailscale-exit',
            label: 'Exit node',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        r.exit.connect('clicked', () => {
            if (r.data)
                this._toggleExitNode(r.data);
        });
        r.actor.add_child(r.copy);
        r.actor.add_child(r.exit);
        return r;
    }

    _render() {
        const page = this._page;
        if (!page || this._mode === 'down')
            return;
        const status = this._status;
        const prefs = this._prefs;
        const state = status?.state ?? '';
        const running = isRunning(state);
        const writable = canWrite(prefs, this._user) && !this._denied;

        // Header.
        setClass(page.header, 'en-marcha', running);
        setClass(page.header, 'cambiando', this._busy.has('running') || state === 'Starting');
        setText(page.title, status ? stateText(state) : '…');
        const flash = this._flash.get(SELF);
        setClass(page.header, 'con-error', !!flash?.error);
        const selfIp = firstIPv4(status?.self?.ips ?? []);
        setText(page.detail, flash?.text ?? [status?.self?.name, selfIp].filter(Boolean).join(' · '));
        setText(page.suffix, status?.dnsSuffix ?? '');
        page.suffix.visible = !!status?.dnsSuffix;
        page.self.reactive = !!selfIp;
        page.self.accessible_name = selfIp ? `Copy ${selfIp}` : '';

        const login = needsLogin(state);
        page.power.visible = !!prefs && !login;
        page.power.label = this._busy.has('running') ? '…' : prefs?.wantRunning ? 'Turn off' : 'Turn on';
        page.power.reactive = writable && !this._busy.has('running');

        // What to run, if anything.
        let hint = null;
        if (login)
            hint = ['Sign in from a terminal:', 'tailscale up'];
        else if (prefs && !writable)
            hint = ['To turn it on or off from here, run once:', OPERATOR_HINT];
        page.hint.visible = !!hint;
        if (hint) {
            setText(page.hintText, hint[0]);
            setText(page.hintCommand, hint[1]);
        }

        // Exit node: local network.
        const exitId = prefs?.exitNodeId ?? '';
        page.lan.visible = running && !!exitId;
        page.lanIcon.icon_name = prefs?.allowLan ? 'checkbox-checked-symbolic' : 'checkbox-symbolic';
        page.lan.reactive = writable && !this._busy.has('lan');

        // Devices (only while connected: otherwise the list is stale).
        const peers = running ? status.peers : [];
        const online = peers.filter(p => p.online).length;
        setText(page.devicesTitle, `Devices  ${online}/${peers.length}`);
        page.devicesTitle.visible = peers.length > 0;
        page.scroll.visible = peers.length > 0;
        let empty = '';
        if (!status)
            empty = '…';
        else if (state === 'Stopped')
            empty = 'Tailscale is off';
        else if (running && peers.length === 0)
            empty = 'No other devices';
        setText(page.empty, empty);
        page.empty.visible = empty !== '';

        const now = Date.now();
        const seen = new Set();
        peers.forEach((p, i) => {
            let r = page.rows.get(p.id);
            if (!r) {
                r = this._newRow();
                page.rows.set(p.id, r);
                page.list.add_child(r.actor);
            }
            page.list.set_child_at_index(r.actor, i);
            seen.add(p.id);
            this._renderRow(r, p, {now, exitId, writable});
        });
        for (const [id, r] of page.rows) {
            if (!seen.has(id)) {
                r.actor.destroy();
                page.rows.delete(id);
            }
        }

        // The island only cares whether the height changes.
        const shape = `${peers.length}|${!!hint}|${page.lan.visible}|${empty !== ''}|${page.suffix.visible}`;
        if (shape !== this._shownShape) {
            this._shownShape = shape;
            this.emit('changed');
        }
    }

    _renderRow(r, p, {now, exitId, writable}) {
        r.data = p;
        const inUse = exitId === p.id;
        setClass(r.actor, 'en-marcha', p.online);
        setText(r.name, p.name);
        const flash = this._flash.get(p.id);
        setClass(r.actor, 'con-error', !!flash?.error);
        setText(r.detail, flash?.text ?? peerDetail(p, now));
        const ip = firstIPv4(p.ips);
        r.copy.reactive = !!ip;
        r.copy.accessible_name = ip ? `Copy ${ip}` : p.name;
        r.exit.visible = p.exitNodeOption || inUse;
        setClass(r.exit, 'en-uso', inUse);
        r.exit.reactive = writable && !this._busy.has('exit');
        r.exit.accessible_name = inUse ? `Stop using ${p.name} as exit node` : `Use ${p.name} as exit node`;
    }

    destroy() {
        this._unwatch();
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._flashId) {
            GLib.source_remove(this._flashId);
            this._flashId = 0;
        }
        this._session?.abort();
        this._session = null;
        this._page?.actor.destroy();
        this._page = null;
        this._status = null;
        this._prefs = null;
        this._busy.clear();
        this._flash.clear();
    }
});

function setClass(actor, cls, on) {
    if (on)
        actor.add_style_class_name(cls);
    else
        actor.remove_style_class_name(cls);
}

function setText(label, text) {
    if (label.text !== text)
        label.text = text;
}
