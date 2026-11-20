// Módulo Actualización: botón «Actualizar a vN» en la barra de pestañas del
// panel, una fila en el hover y un puntito junto a los ojos en reposo, solo
// mientras haya una versión nueva (docs/18, aprobado el 19-11-2026).
//
// - Se entera por ~/.local/state/agent-notch/update.json, que escribe
//   services/updater/update_check.py; lo vigila con Gio.FileMonitor (sin
//   sondeo) y SOLO si lo instalado es una release vN (con main o una copia
//   local no vigila nada).
// - Instalar: llama a dev.agentnotch.Updater.Instalar() por D-Bus (la
//   extensión no lanza procesos, Regla 2); el progreso vuelve por update.json.
// - Al terminar: «Cerrar sesión para terminar» abre el diálogo de GNOME.
// - Los actores se crean la primera vez que hacen falta y se reutilizan.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';

import {NotchModule} from './module.js';
import {readText, isCancelled} from './sysinfo.js';
import {buttonText, parseInstalled, sameView, updateView, versionKey} from './updatestate.js';
import {makeLabel} from './widgets.js';

const PRIORITY = -50;   // en el hover, debajo de lo demás
const BATCH_MS = 100;
const ICON = 'software-update-available-symbolic';
const STATE_NAME = 'update.json';

const BUS_NAME = 'dev.agentnotch.Updater';
const OBJECT_PATH = '/dev/agentnotch/Updater';

export const UpdateModule = GObject.registerClass(
class UpdateModule extends NotchModule {
    _init() {
        super._init();
        this._view = null;
        this._installed = null;
        this._starting = false;    // Instalar() pedido, aún sin noticias
        this._pill = null;         // botón de la barra de pestañas
        this._row = null;          // fila del hover
        this._monitor = null;
        this._batchId = 0;
        this._cancellable = new Gio.Cancellable();

        const app = GLib.build_filenamev([GLib.get_user_data_dir(), 'agent-notch', 'VERSION']);
        this._stateDir = GLib.build_filenamev([GLib.get_user_state_dir(), 'agent-notch']);
        readText(app, this._cancellable).then(text => {
            this._installed = parseInstalled(text);
            if (versionKey(this._installed))
                this._watch();
        }).catch(e => {
            if (!isCancelled(e))
                this._installed = null;   // sin VERSION: copia de desarrollo
        });
    }

    /** ¿Hay una versión nueva que ofrecer? (lo usa la mascota). */
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

    // --- Vigilar update.json -------------------------------------------------

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
            console.error(`[agent-notch] Actualización: no se puede vigilar ${this._stateDir}: ${e.message}`);
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
            .then(text => this._apply(updateView(text, this._installed)))
            .catch(e => {
                if (!isCancelled(e))
                    this._apply(null);   // no existe: nada que ofrecer
            });
    }

    _apply(view) {
        // Cualquier noticia del servicio sustituye al «Actualizando…» local.
        const was = this._starting;
        this._starting = false;
        if (sameView(view, this._view)) {
            if (was)
                this._render();
            return;
        }
        this._view = view;
        this._render();
        // La isla reajusta su tamaño (el texto cambia) y la mascota su puntito.
        this.emit('changed');
    }

    // --- Actores ------------------------------------------------------------------

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
            ? `Detalles en ${view.log}`
            : `agent-notch ${view.version} disponible`;
        row.button.label = buttonText(view);
        row.button.reactive = view.state !== 'instalando';
        setStateClass(row.actor, view.state);
    }

    // --- Acciones -------------------------------------------------------------------

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
                    console.error(`[agent-notch] Actualización: no se pudo pedir la instalación: ${e.message}`);
                    this._starting = false;
                    this._render();
                }
            });
    }

    // El diálogo de cerrar sesión de GNOME (pide confirmación).
    // ✅ SystemActions.activateLogout() existe en GNOME 50 (verificado el
    // 19-11-2026 en misc/systemActions.js).
    _logout() {
        try {
            SystemActions.getDefault().activateLogout();
        } catch (e) {
            console.error(`[agent-notch] Actualización: no se pudo abrir el diálogo de cerrar sesión: ${e.message}`);
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
