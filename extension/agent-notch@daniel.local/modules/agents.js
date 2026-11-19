// Módulo Agentes: estado de las sesiones de Claude Code y otros agentes
// (Fase 1, pasos 4–6 de docs/10-hoja-de-ruta.md).
//
// Los adaptadores escriben un JSON por sesión en
//     $XDG_RUNTIME_DIR/agent-notch/sessions/<agente>-<sesion>.json
// (docs/03-formato-estado.md). AGENT_NOTCH_DIR cambia la raíz: el GNOME de
// prueba usa agent-notch-dev para que scripts/simulate.py no salga en la
// isla del escritorio real.
//
// Vistas:
//   - Compacta: «● mi-app · Editando main.py», o «● 3 agentes · 1 te
//     necesita» con varias. Las sesiones que solo esperan no la ocupan.
//   - Expandida (hover): una fila por sesión (punto · proyecto · acción ·
//     tiempo). Clic en una fila → trae al frente la ventana de su terminal,
//     si se sabe cuál es con certeza (si no, no hace nada).
//
// Sesiones muertas (docs/03): con PID, cuando ese proceso ya no existe; sin
// PID, a los 30 min sin novedades. Se quitan y se borra su archivo.
//
// Consumo:
//   - Por eventos: Gio.FileMonitor sobre la carpeta, nada de sondeo.
//   - Ráfagas agrupadas: como mucho una lectura/redibujado cada 100 ms.
//   - Lecturas asíncronas, canceladas al destruir.
//   - Temporizadores solo mientras hacen falta: 5 s tras `terminado`;
//     revisar sesiones muertas cada 30 s solo si hay sesiones; refrescar
//     los tiempos cada 30 s solo con la vista expandida a la vista.
//   - Las filas se crean al primer hover y se reutilizan.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {NotchModule} from './module.js';
import {readText, isCancelled} from './sysinfo.js';
import {makeLabel} from './widgets.js';
import {
    STATES, formatAge, isDead, isSessionFile, nextChangeIn, parentPid, parseSession,
    pickWindow, sameSummary, shownState, sortSessions, stateText, summarize,
} from './agentstate.js';

// Compacta: con algo en marcha gana a la música (10) pero no al
// temporizador de concentración (20); pidiendo atención gana a todo salvo
// a los banners de notificaciones (100).
const PRIORITY = 15;
const PRIORITY_ATTENTION = 50;
const BATCH_MS = 100;
const REAP_S = 30;
const AGE_TICK_S = 30;
const MAX_ROWS = 6;
const MAX_ANCESTORS = 16;

const decoder = new TextDecoder();
const nowSeconds = () => GLib.get_real_time() / 1e6;
// /proc no bloquea: comprobar si existe un proceso es instantáneo.
const pidAlive = pid => GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS);

function sessionsDir() {
    const root = GLib.getenv('AGENT_NOTCH_DIR') ||
        GLib.build_filenamev([GLib.get_user_runtime_dir(), 'agent-notch']);
    return GLib.build_filenamev([root, 'sessions']);
}

function setStateClass(actor, state) {
    for (const s of STATES) {
        if (s === state)
            actor.add_style_class_name(`estado-${s}`);
        else
            actor.remove_style_class_name(`estado-${s}`);
    }
}

export const AgentsModule = GObject.registerClass(
class AgentsModule extends NotchModule {
    _init() {
        super._init();

        this._sessions = new Map();   // nombre de archivo → sesión
        this._readGen = new Map();    // nombre → nº de la última lectura pedida
        this._pending = new Set();    // nombres por releer en la próxima tanda
        this._batchId = 0;
        this._expireId = 0;
        this._reapId = 0;
        this._ageId = 0;
        this._summary = null;
        this._rowCount = 0;           // filas visibles en la vista expandida
        this._exp = null;             // vista expandida, al primer hover
        this._rows = [];
        this._cancellable = new Gio.Cancellable();

        this._buildCompact();

        this._dir = Gio.File.new_for_path(sessionsDir());
        try {
            // Los adaptadores la crean con 0700; si aún no hay ninguno, la
            // creamos nosotros para poder vigilarla desde ya.
            GLib.mkdir_with_parents(this._dir.get_path(), 0o700);
            this._monitor = this._dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            this._monitor.connectObject('changed', (_m, file, other) => {
                this._queue(file);
                this._queue(other);
            }, this);
        } catch (e) {
            console.error(`[agent-notch] Agentes: no se puede vigilar ${this._dir.get_path()}: ${e.message}`);
            this._monitor = null;
        }
        this._loadAll();
    }

    get priority() {
        return this._summary?.state === 'atencion' ? PRIORITY_ATTENTION : PRIORITY;
    }

    get active() {
        return this._summary !== null;
    }

    get compactActor() {
        return this._compact;
    }

    get hasExpanded() {
        return this._sessions.size > 0;
    }

    get expandedActor() {
        if (!this._exp)
            this._buildExpanded();
        return this._exp;
    }

    // --- Lectura de la carpeta -------------------------------------------------

    // Cualquier evento (CREATED, CHANGES_DONE_HINT, RENAMED, MOVED_IN,
    // DELETED…) se trata igual: releer ese archivo. Si ya no existe, la
    // sesión se quita. Así da igual qué eventos mande GLib para un rename.
    _queue(file) {
        const name = file?.get_basename();
        if (!isSessionFile(name) || !file.get_parent()?.equal(this._dir))
            return;
        this._pending.add(name);
        if (!this._batchId) {
            this._batchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BATCH_MS, () => {
                this._batchId = 0;
                const names = [...this._pending];
                this._pending.clear();
                for (const n of names)
                    this._read(n);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _loadAll() {
        this._dir.enumerate_children_async('standard::name', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, this._cancellable, (dir, res) => {
                let enumerator;
                try {
                    enumerator = dir.enumerate_children_finish(res);
                } catch (e) {
                    if (!isCancelled(e))
                        console.error(`[agent-notch] Agentes: no se puede leer la carpeta: ${e.message}`);
                    return;
                }
                this._nextFiles(enumerator);
            });
    }

    _nextFiles(enumerator) {
        enumerator.next_files_async(32, GLib.PRIORITY_DEFAULT, this._cancellable, (en, res) => {
            let infos;
            try {
                infos = en.next_files_finish(res);
            } catch {
                infos = [];
            }
            for (const info of infos) {
                if (isSessionFile(info.get_name()))
                    this._read(info.get_name());
            }
            if (infos.length > 0)
                this._nextFiles(en);
            else
                en.close_async(GLib.PRIORITY_DEFAULT, null, null);
        });
    }

    _read(name) {
        // Si llegan dos lecturas del mismo archivo, solo cuenta la última
        // pedida (la otra podría traer datos viejos).
        const gen = (this._readGen.get(name) ?? 0) + 1;
        this._readGen.set(name, gen);
        this._dir.get_child(name).load_contents_async(this._cancellable, (file, res) => {
            let session = null;
            try {
                const [, bytes] = file.load_contents_finish(res);
                session = parseSession(decoder.decode(bytes));
            } catch (e) {
                if (isCancelled(e))
                    return;
                // NOT_FOUND: la sesión terminó (o se borró): se quita.
            }
            if (!this._dir || this._readGen.get(name) !== gen)
                return;   // destruido, o hay una lectura más nueva en camino
            this._readGen.delete(name);
            if (session)
                this._sessions.set(name, session);
            else
                this._sessions.delete(name);
            this._render();
        });
    }

    // --- Sesiones muertas --------------------------------------------------------

    // Quita las sesiones muertas y borra sus archivos. Devuelve si quitó alguna.
    _reap() {
        const now = nowSeconds();
        let removed = false;
        for (const [name, session] of this._sessions) {
            if (!isDead(session, now, pidAlive))
                continue;
            this._sessions.delete(name);
            this._dir.get_child(name).delete_async(GLib.PRIORITY_LOW, null, (f, res) => {
                try {
                    f.delete_finish(res);
                } catch {
                    // Ya no estaba: nada que hacer.
                }
            });
            removed = true;
        }
        return removed;
    }

    // Revisión cada 30 s, solo mientras haya sesiones.
    _syncReaper() {
        if (this._sessions.size > 0 && !this._reapId) {
            this._reapId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, REAP_S, () => {
                if (this._reap())
                    this._render();
                if (this._sessions.size > 0)
                    return GLib.SOURCE_CONTINUE;
                this._reapId = 0;
                return GLib.SOURCE_REMOVE;
            });
        } else if (this._sessions.size === 0 && this._reapId) {
            GLib.source_remove(this._reapId);
            this._reapId = 0;
        }
    }

    // --- Vista compacta ----------------------------------------------------------

    _buildCompact() {
        this._compact = new St.BoxLayout({
            style_class: 'agent-notch-agents',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._dot = new St.Widget({
            style_class: 'agent-notch-dot',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title = makeLabel('agent-notch-agents-title', {y_align: Clutter.ActorAlign.CENTER});
        this._separator = new St.Label({
            style_class: 'agent-notch-agents-separator',
            text: '·',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._detail = makeLabel('agent-notch-agents-detail', {y_align: Clutter.ActorAlign.CENTER});
        this._compact.add_child(this._dot);
        this._compact.add_child(this._title);
        this._compact.add_child(this._separator);
        this._compact.add_child(this._detail);
    }

    _render() {
        if (!this._compact)
            return;
        // Una sesión recién leída puede venir ya muerta (p. ej. tras un
        // cierre en falso): se quita sin esperar a la próxima revisión.
        this._reap();

        const now = nowSeconds();
        const sessions = [...this._sessions.values()];
        const summary = summarize(sessions, now);
        this._scheduleExpiry(sessions, now);
        this._syncReaper();

        const rowCount = Math.min(sessions.length, MAX_ROWS) + (sessions.length > MAX_ROWS ? 1 : 0);
        if (this._exp)
            this._renderRows(sessions, now);

        const before = this._summary;
        if (!sameSummary(summary, before)) {
            this._summary = summary;
            if (summary) {
                setStateClass(this._compact, summary.state);
                this._title.text = summary.title;
                this._detail.text = summary.detail;
            }
        }

        // A la isla solo le importa si aparece/desaparece algo, cambia la
        // prioridad o cambia el alto de la vista expandida; los cambios de
        // texto los recoloca Clutter solo.
        const changed = (before === null) !== (summary === null) ||
            before?.state !== summary?.state || rowCount !== this._rowCount;
        this._rowCount = rowCount;
        if (changed)
            this.emit('changed');
    }

    // `terminado` se ve como `inactivo` a los 5 s: un solo temporizador
    // hasta el próximo cambio, y ninguno si no hay sesiones terminando.
    _scheduleExpiry(sessions, now) {
        if (this._expireId) {
            GLib.source_remove(this._expireId);
            this._expireId = 0;
        }
        const left = nextChangeIn(sessions, now);
        if (left === null)
            return;
        this._expireId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(left * 1000) + 50, () => {
            this._expireId = 0;
            this._render();
            return GLib.SOURCE_REMOVE;
        });
    }

    // --- Vista expandida ---------------------------------------------------------

    _buildExpanded() {
        this._exp = new St.BoxLayout({
            style_class: 'agent-notch-agents-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._more = makeLabel('agent-notch-agents-more', {visible: false});
        this._exp.add_child(this._more);
        this._renderRows([...this._sessions.values()], nowSeconds());
    }

    _newRow() {
        const row = {};
        const box = new St.BoxLayout({style_class: 'agent-notch-agents-row-box', x_expand: true});
        row.button = new St.Button({
            style_class: 'agent-notch-agents-row',
            child: box,
            x_expand: true,
            can_focus: true,
        });
        row.dot = new St.Widget({style_class: 'agent-notch-dot', y_align: Clutter.ActorAlign.CENTER});
        row.project = makeLabel('agent-notch-agents-row-project', {y_align: Clutter.ActorAlign.CENTER});
        row.action = makeLabel('agent-notch-agents-row-action', {
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        row.age = new St.Label({style_class: 'agent-notch-agents-row-age', y_align: Clutter.ActorAlign.CENTER});
        for (const child of [row.dot, row.project, row.action, row.age])
            box.add_child(child);
        row.button.connect('clicked', () => {
            if (row.session)
                this._focusTerminal(row.session);
        });
        // Antes de la etiqueta «y N más», que va siempre la última.
        this._exp.insert_child_below(row.button, this._more);
        return row;
    }

    _renderRows(sessions, now) {
        const sorted = sortSessions(sessions, now);
        const shown = sorted.slice(0, MAX_ROWS);
        while (this._rows.length < shown.length)
            this._rows.push(this._newRow());

        this._rows.forEach((row, i) => {
            const s = shown[i];
            row.session = s ?? null;
            row.button.visible = Boolean(s);
            if (!s)
                return;
            const state = shownState(s, now);
            setStateClass(row.button, state);
            const action = state === 'inactivo' ? stateText(state) : s.accion ?? stateText(state);
            if (row.project.text !== s.proyecto)
                row.project.text = s.proyecto;
            if (row.action.text !== action)
                row.action.text = action;
            const age = formatAge(now - s.inicio);
            if (row.age.text !== age)
                row.age.text = age;
            row.button.accessible_name = `${s.proyecto}: ${action}`;
        });

        const hidden = sorted.length - shown.length;
        this._more.visible = hidden > 0;
        if (hidden > 0)
            this._more.text = `y ${hidden} más`;
    }

    // Los tiempos («12 min») solo se refrescan con la vista a la vista.
    _onViewsChanged(views) {
        const visible = views.has('expanded');
        if (visible && !this._ageId) {
            this._render();
            this._ageId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, AGE_TICK_S, () => {
                this._render();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!visible && this._ageId) {
            GLib.source_remove(this._ageId);
            this._ageId = 0;
        }
    }

    // --- Clic: traer la terminal de la sesión ------------------------------------

    async _focusTerminal(session) {
        if (session.pid === null)
            return;
        const ancestors = [];
        let pid = session.pid;
        try {
            while (pid && pid > 1 && ancestors.length < MAX_ANCESTORS) {
                ancestors.push(pid);
                // eslint-disable-next-line no-await-in-loop
                pid = parentPid(await readText(`/proc/${pid}/stat`, this._cancellable));
            }
        } catch (e) {
            if (isCancelled(e))
                return;
            // El proceso terminó mientras subíamos: con lo que haya.
        }
        if (!this._dir)
            return;   // destruido mientras tanto

        const windows = global.display.list_all_windows()
            .filter(w => w.get_window_type() === Meta.WindowType.NORMAL && !w.is_skip_taskbar())
            .map(w => ({pid: w.get_pid(), title: w.get_title(), window: w}));
        const target = pickWindow(ancestors, windows, session.proyecto);
        if (!target)
            return;   // no se sabe cuál es: mejor no hacer nada
        Main.activateWindow(target);
        this.emit('dismiss');
    }

    destroy() {
        this._cancellable.cancel();
        this._monitor?.disconnectObject(this);
        this._monitor?.cancel();
        this._monitor = null;
        for (const id of [this._batchId, this._expireId, this._reapId, this._ageId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._batchId = this._expireId = this._reapId = this._ageId = 0;
        this._pending.clear();
        this._sessions.clear();
        this._readGen.clear();
        this._compact?.destroy();
        this._compact = this._dot = this._title = this._separator = this._detail = null;
        this._exp?.destroy();
        this._exp = this._more = null;
        this._rows = [];
        this._dir = null;
    }
});
