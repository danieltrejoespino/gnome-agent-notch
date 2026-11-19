// Módulo Agentes: estado de las sesiones de Claude Code y otros agentes
// (Fase 1, pasos 4–5 de docs/10-hoja-de-ruta.md).
//
// Los adaptadores escriben un JSON por sesión en
//     $XDG_RUNTIME_DIR/agent-notch/sessions/<agente>-<sesion>.json
// (docs/03-formato-estado.md). AGENT_NOTCH_DIR cambia la raíz: el GNOME de
// prueba usa agent-notch-dev para que scripts/simulate.py no salga en la
// isla del escritorio real.
//
// Vista compacta: «● mi-app · Editando main.py», o «● 3 agentes · 1 te
// necesita» con varias. Las sesiones que solo esperan no ocupan la
// compacta (no tapan la música).
//
// Consumo:
//   - Por eventos: Gio.FileMonitor sobre la carpeta, nada de sondeo.
//   - Ráfagas agrupadas: como mucho una lectura/redibujado cada 100 ms.
//   - Lecturas asíncronas (load_contents_async), canceladas al destruir.
//   - Un único temporizador, solo mientras alguna sesión está en
//     `terminado` (para pasarla a `inactivo` a los 5 s).

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {NotchModule} from './module.js';
import {makeLabel} from './widgets.js';
import {
    STATES, isSessionFile, nextChangeIn, parseSession, sameSummary, summarize,
} from './agentstate.js';

// Compacta: con algo en marcha gana a la música (10) pero no al
// temporizador de concentración (20); pidiendo atención gana a todo salvo
// a los banners de notificaciones (100).
const PRIORITY = 15;
const PRIORITY_ATTENTION = 50;
const BATCH_MS = 100;

const decoder = new TextDecoder();
const nowSeconds = () => GLib.get_real_time() / 1e6;

function sessionsDir() {
    const root = GLib.getenv('AGENT_NOTCH_DIR') ||
        GLib.build_filenamev([GLib.get_user_runtime_dir(), 'agent-notch']);
    return GLib.build_filenamev([root, 'sessions']);
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
        this._summary = null;
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
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
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
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
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

    // --- Vista -----------------------------------------------------------------

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
        const now = nowSeconds();
        const sessions = [...this._sessions.values()];
        const summary = summarize(sessions, now);
        this._scheduleExpiry(sessions, now);

        if (sameSummary(summary, this._summary))
            return;
        const before = this._summary;
        this._summary = summary;

        if (summary) {
            for (const state of STATES) {
                if (state === summary.state)
                    this._compact.add_style_class_name(`estado-${state}`);
                else
                    this._compact.remove_style_class_name(`estado-${state}`);
            }
            this._title.text = summary.title;
            this._detail.text = summary.detail;
        }

        // A la isla solo le importa si aparece/desaparece o cambia de
        // prioridad; los cambios de texto los recoloca Clutter solo.
        if ((before === null) !== (summary === null) || before?.state !== summary?.state)
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

    destroy() {
        this._cancellable.cancel();
        this._monitor?.disconnectObject(this);
        this._monitor?.cancel();
        this._monitor = null;
        for (const id of [this._batchId, this._expireId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._batchId = this._expireId = 0;
        this._pending.clear();
        this._sessions.clear();
        this._readGen.clear();
        this._compact?.destroy();
        this._compact = this._dot = this._title = this._separator = this._detail = null;
        this._dir = null;
    }
});
