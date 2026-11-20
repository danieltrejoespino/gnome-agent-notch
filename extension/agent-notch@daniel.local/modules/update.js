// Update module: an "Update to vN" button in the panel's tab bar,
// a row in the hover and a dot next to the eyes at rest, only
// while there is a new version (docs/18, approved on 19-11-2026).
//
// - It learns about it through ~/.local/state/agent-notch/update.json, written by
//   services/updater/update_check.py; it watches it with Gio.FileMonitor (no
//   polling) and ONLY if the running code is a vN release (with main or a
//   local copy it watches nothing). The running version is the one in metadata.json
//   (version-name, written by install.sh), which GNOME reads once per session.
// - Install: calls dev.agentnotch.Updater.Instalar() over D-Bus (the
//   extension does not launch processes, Rule 2); progress comes back through update.json.
// - When done: "Log out to finish" opens GNOME's dialog.
// - The actors are created the first time they are needed and reused.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';

import {NotchModule} from './module.js';
import {readText, isCancelled} from './sysinfo.js';
import {buttonText, sameView, updateView, versionKey} from './updatestate.js';
import {makeLabel} from './widgets.js';

const PRIORITY = -50;   // in the hover, below the rest
const BATCH_MS = 100;
const ICON = 'software-update-available-symbolic';
const STATE_NAME = 'update.json';

const BUS_NAME = 'dev.agentnotch.Updater';
const OBJECT_PATH = '/dev/agentnotch/Updater';

export const UpdateModule = GObject.registerClass(
class UpdateModule extends NotchModule {
    _init(running = null) {
        super._init();
        this._view = null;
        this._running = typeof running === 'string' ? running.trim() : null;
        this._starting = false;    // Instalar() requested, no news yet
        this._pill = null;         // tab bar button
        this._row = null;          // hover row
        this._monitor = null;
        this._batchId = 0;
        this._cancellable = new Gio.Cancellable();

        this._stateDir = GLib.build_filenamev([GLib.get_user_state_dir(), 'agent-notch']);
        if (versionKey(this._running))
            this._watch();
    }

    /** Is there a new version to offer? (used by the mascot). */
    get available() {
        return this._view !== null;
    }

    get priority() {
        return PRIORITY;
    }

    get hasExpanded() {
        return this.available;
    }

    get expandedActor() {
        this._row ??= this._buildRow();
        return this._row.actor;
    }

    get tabBarActor() {
        this._pill ??= this._buildPill();
        return this._pill.actor;
    }

    // --- Watching update.json -------------------------------------------------

    _watch() {
        try {
            GLib.mkdir_with_parents(this._stateDir, 0o700);
            const dir = Gio.File.new_for_path(this._stateDir);
            this._monitor = dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            this._monitor.connectObject('changed', (_m, file, other) => {
                if (file?.get_basename() === STATE_NAME || other?.get_basename() === STATE_NAME)
                    this._queueRead();
            }, this);
        } catch (e) {
            console.error(`[agent-notch] Update: cannot watch ${this._stateDir}: ${e.message}`);
            return;
        }
        this._read();
    }

    _queueRead() {
        if (this._batchId)
            return;
        this._batchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BATCH_MS, () => {
            this._batchId = 0;
            this._read();
            return GLib.SOURCE_REMOVE;
        });
    }

    _read() {
        const path = GLib.build_filenamev([this._stateDir, STATE_NAME]);
        readText(path, this._cancellable)
            .then(text => this._apply(updateView(text, this._running)))
            .catch(e => {
                if (!isCancelled(e))
                    this._apply(null);   // it does not exist: nothing to offer
            });
    }

    _apply(view) {
        // Any news from the service replaces the local "Updating…".
        const was = this._starting;
        this._starting = false;
        if (sameView(view, this._view)) {
            if (was)
                this._render();
            return;
        }
        this._view = view;
        this._render();
        // The island readjusts its size (the text changes) and the mascot its dot.
        this.emit('changed');
    }

    // --- Actors ------------------------------------------------------------------

    _buildPill() {
        const label = new St.Label({
            style_class: 'agent-notch-update-pill-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const box = new St.BoxLayout({style_class: 'agent-notch-update-pill-box'});
        box.add_child(new St.Icon({icon_name: ICON, style_class: 'agent-notch-update-icon'}));
        box.add_child(label);
        const actor = new St.Button({
            style_class: 'agent-notch-update-pill',
            child: box,
            can_focus: true,
            visible: false,
        });
        actor.connect('clicked', () => this._activate());
        const pill = {actor, label};
        this._renderPill(pill);
        return pill;
    }

    _buildRow() {
        const actor = new St.BoxLayout({style_class: 'agent-notch-update-row', x_expand: true});
        actor.add_child(new St.Icon({
            icon_name: ICON,
            style_class: 'agent-notch-update-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const title = makeLabel('agent-notch-update-title', {
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        const button = new St.Button({
            style_class: 'agent-notch-update-button',
            label: '',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        button.connect('clicked', () => this._activate());
        actor.add_child(title);
        actor.add_child(button);
        const row = {actor, title, button};
        this._renderRow(row);
        return row;
    }

    _render() {
        if (this._pill)
            this._renderPill(this._pill);
        if (this._row)
            this._renderRow(this._row);
    }

    _shownView() {
        return this._starting && this._view ? {...this._view, state: 'instalando'} : this._view;
    }

    _renderPill(pill) {
        const view = this._shownView();
        pill.actor.visible = view !== null;
        if (!view)
            return;
        pill.label.text = buttonText(view);
        pill.actor.reactive = view.state !== 'instalando';
        pill.actor.accessible_name = pill.label.text;
        setStateClass(pill.actor, view.state);
    }

    _renderRow(row) {
        const view = this._shownView();
        if (!view)
            return;
        row.title.text = view.state === 'error' && view.log
            ? `Details in ${view.log}`
            : `agent-notch ${view.version} available`;
        row.button.label = buttonText(view);
        row.button.reactive = view.state !== 'instalando';
        setStateClass(row.actor, view.state);
    }

    // --- Actions -------------------------------------------------------------------

    _activate() {
        const state = this._view?.state;
        if (!state || state === 'instalando' || this._starting)
            return;
        if (state === 'instalada') {
            this._logout();
            return;
        }
        this._starting = true;
        this._render();
        Gio.DBus.session.call(BUS_NAME, OBJECT_PATH, BUS_NAME, 'Instalar', null, null,
            Gio.DBusCallFlags.NONE, -1, this._cancellable, (conn, result) => {
                try {
                    conn.call_finish(result);
                } catch (e) {
                    if (isCancelled(e))
                        return;
                    console.error(`[agent-notch] Update: could not request the install: ${e.message}`);
                    this._starting = false;
                    this._render();
                }
            });
    }

    // GNOME's log out dialog (it asks for confirmation).
    // ✅ SystemActions.activateLogout() exists in GNOME 50 (verified on
    // 19-11-2026 in misc/systemActions.js).
    _logout() {
        try {
            SystemActions.getDefault().activateLogout();
        } catch (e) {
            console.error(`[agent-notch] Update: could not open the log out dialog: ${e.message}`);
        }
    }

    destroy() {
        this._cancellable.cancel();
        if (this._batchId) {
            GLib.source_remove(this._batchId);
            this._batchId = 0;
        }
        this._monitor?.disconnectObject(this);
        this._monitor?.cancel();
        this._monitor = null;
        this._pill?.actor.destroy();
        this._row?.actor.destroy();
        this._pill = this._row = null;
        this._view = null;
    }
});

function setStateClass(actor, state) {
    for (const s of ['disponible', 'instalando', 'instalada', 'error']) {
        if (s === state)
            actor.add_style_class_name(`estado-${s}`);
        else
            actor.remove_style_class_name(`estado-${s}`);
    }
}
