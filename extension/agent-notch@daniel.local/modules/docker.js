// Módulo Docker: pestaña del panel para ver los contenedores e iniciarlos o
// detenerlos, uno a uno o por proyecto de Compose (docs/19-modulo-docker.md).
//
// Habla HTTP con el socket de Docker usando Soup (sin lanzar `docker`): la
// extensión no lanza procesos (Regla 2). Solo lista, inicia y detiene.
//
// La pestaña solo existe si el socket existe y se puede escribir en él (el
// usuario está en el grupo `docker`). Sin Docker, el módulo no hace nada más
// que comprobarlo una vez al activarse.
//
// Consumo:
//   - Con la pestaña oculta: nada (ni conexiones ni temporizadores).
//   - Al mostrarla: abre el flujo de eventos de Docker y pide la lista una
//     vez. Cada evento (o tanda de eventos, agrupados en 100 ms) vuelve a
//     pedir la lista: son unos KB y solo pasa cuando algo cambia.
//   - Al ocultarla: cierra el flujo. Las órdenes en curso (iniciar/detener)
//     siguen hasta acabar, para no dejar un contenedor a medias.
//   - Filas y grupos se crean una vez por contenedor/proyecto y se reutilizan.

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
    actionOk, apiUrl, errorMessage, eventsUrl, formatPorts, groupAction, groupByProject,
    groupPlan, isRunning, parseContainers, socketPath, stateText,
} from './dockerstate.js';

// La pestaña va después de las demás (Agentes es 15).
const PRIORITY = 5;
const ICON = 'package-x-generic-symbolic';
const BATCH_MS = 100;
const ERROR_S = 6;
const START_ICON = 'media-playback-start-symbolic';
const STOP_ICON = 'media-playback-stop-symbolic';

const decoder = new TextDecoder();

export const DockerModule = GObject.registerClass(
class DockerModule extends NotchModule {
    _init() {
        super._init();

        this._available = false;
        this._socket = socketPath(GLib.getenv('DOCKER_HOST'));
        this._session = null;         // Soup, al primer uso
        this._cancellable = new Gio.Cancellable();   // todo (se cancela en destroy)
        this._events = null;          // Gio.Cancellable del flujo de eventos
        this._batchId = 0;
        this._errorId = 0;
        this._listGen = 0;
        this._containers = [];
        this._busy = new Set();       // Ids con una orden en curso
        this._busyGroups = new Set(); // proyectos con «todo» en curso
        this._errors = new Map();     // Id → {text, until}, unos segundos
        this._mode = 'list';          // 'list' | 'empty' | 'down'
        this._page = null;            // al primer uso
        this._shownCount = -1;

        this._checkSocket();
    }

    get priority() {
        return PRIORITY;
    }

    get pageTitle() {
        return this._available ? 'Docker' : '';
    }

    get pageIcon() {
        return ICON;
    }

    get pageActor() {
        this._page ??= this._buildPage();
        return this._page.actor;
    }

    // --- ¿Hay Docker? --------------------------------------------------------------

    _checkSocket() {
        const file = Gio.File.new_for_path(this._socket);
        file.query_info_async('standard::type,access::can-write', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_LOW, this._cancellable, (f, res) => {
                let info;
                try {
                    info = f.query_info_finish(res);
                } catch {
                    return;   // no hay Docker (o se canceló): sin pestaña
                }
                this._available = info.get_file_type() === Gio.FileType.SPECIAL &&
                    info.get_attribute_boolean('access::can-write');
                if (this._available)
                    this.emit('changed');
            });
    }

    // --- HTTP por el socket -------------------------------------------------------------

    _soup() {
        this._session ??= new Soup.Session({
            remote_connectable: Gio.UnixSocketAddress.new(this._socket),
            // Sin límite de E/S: el flujo de eventos pasa minutos en silencio y
            // `stop` espera a que pare el contenedor (hasta 10 s o más).
            timeout: 0,
            // Conexiones libres cerradas pronto: con la pestaña oculta no
            // queda ninguna abierta.
            idle_timeout: 5,
            max_conns_per_host: 6,
        });
        return this._session;
    }

    // Promesa con {status, text}. Rechaza si no se puede hablar con Docker.
    _request(method, path, cancellable = this._cancellable) {
        const message = Soup.Message.new(method, apiUrl(path));
        return new Promise((resolve, reject) => {
            this._soup().send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
                try {
                    const bytes = s.send_and_read_finish(res);
                    resolve({status: message.get_status(), text: decoder.decode(bytes.get_data() ?? new Uint8Array())});
                } catch (e) {
                    reject(e);
                }
            });
        });
    }

    // --- Pestaña visible: eventos + lista ----------------------------------------------

    _onViewsChanged(views) {
        if (views.has('page'))
            this._watch();
        else
            this._unwatch();
    }

    // Primero el flujo de eventos y luego la lista: así no se pierde nada
    // de lo que pase entre medias.
    _watch() {
        if (this._events)
            return;
        const cancellable = new Gio.Cancellable();
        this._events = cancellable;
        const message = Soup.Message.new('GET', eventsUrl());
        this._soup().send_async(message, GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
            let stream;
            try {
                stream = s.send_finish(res);
            } catch (e) {
                if (!isCancelled(e))
                    this._dockerDown(cancellable, e.message);
                return;
            }
            if (message.get_status() !== Soup.Status.OK) {
                this._dockerDown(cancellable, `eventos: ${message.get_status()}`);
                return;
            }
            const lines = new Gio.DataInputStream({base_stream: stream, close_base_stream: true});
            this._readEvent(lines, cancellable);
            this._refresh();
        });
    }

    _readEvent(lines, cancellable) {
        lines.read_line_async(GLib.PRIORITY_LOW, cancellable, (l, res) => {
            let line;
            try {
                [line] = l.read_line_finish_utf8(res);
            } catch (e) {
                if (!isCancelled(e))
                    this._dockerDown(cancellable, e.message);
                l.close_async(GLib.PRIORITY_LOW, null, null);
                return;
            }
            if (line === null) {
                // Docker cerró el flujo (se paró o se reinició).
                l.close_async(GLib.PRIORITY_LOW, null, null);
                this._dockerDown(cancellable, 'fin del flujo de eventos');
                return;
            }
            // No hace falta mirar qué evento es: cualquiera cambia la lista.
            this._queueRefresh();
            this._readEvent(l, cancellable);
        });
    }

    _unwatch() {
        this._events?.cancel();
        this._events = null;
        if (this._batchId) {
            GLib.source_remove(this._batchId);
            this._batchId = 0;
        }
    }

    _dockerDown(cancellable, why) {
        if (cancellable !== this._events)
            return;   // ya se cerró o se volvió a abrir
        console.log(`[agent-notch] Docker: no responde (${why})`);
        this._events = null;
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
        // Si llegan dos respuestas, solo cuenta la última pedida.
        const gen = ++this._listGen;
        let containers;
        try {
            const {status, text} = await this._request('GET', '/containers/json?all=true');
            containers = status === Soup.Status.OK ? parseContainers(text) : null;
            if (!containers)
                throw new Error(errorMessage(status, text));
        } catch (e) {
            if (isCancelled(e) || gen !== this._listGen || !this._cancellable)
                return;
            console.log(`[agent-notch] Docker: no se pudo leer la lista: ${e.message}`);
            this._setMode('down');
            return;
        }
        if (gen !== this._listGen || !this._cancellable)
            return;
        this._containers = containers;
        this._setMode(containers.length > 0 ? 'list' : 'empty');
        this._render();
    }

    // --- Órdenes ------------------------------------------------------------------------

    async _act(container, action) {
        if (this._busy.has(container.id))
            return true;
        this._busy.add(container.id);
        this._errors.delete(container.id);
        this._render();
        let ok = false;
        try {
            const {status, text} = await this._request('POST',
                `/containers/${encodeURIComponent(container.id)}/${action}`);
            ok = actionOk(status);
            if (!ok)
                this._showError(container.id, errorMessage(status, text));
        } catch (e) {
            if (isCancelled(e))
                return false;
            this._showError(container.id, e.message);
        }
        if (!this._cancellable)
            return false;   // destruido mientras tanto
        this._busy.delete(container.id);
        // El evento de Docker también lo traería, pero un 304 (ya estaba)
        // no genera evento, y con la pestaña oculta no hay flujo.
        if (this._events)
            this._queueRefresh();
        else
            this._render();
        return ok;
    }

    async _actGroup(group) {
        const key = group.project;
        if (this._busyGroups.has(key))
            return;
        const action = groupAction(group.containers);
        this._busyGroups.add(key);
        this._render();
        // Uno detrás de otro, por dependencias; si uno falla, se para.
        for (const c of groupPlan(group.containers, action)) {
            // eslint-disable-next-line no-await-in-loop
            if (!await this._act(c, action))
                break;
        }
        if (!this._cancellable)
            return;
        this._busyGroups.delete(key);
        this._render();
    }

    _showError(key, text) {
        console.log(`[agent-notch] Docker: ${key.slice(0, 12)}: ${text}`);
        this._errors.set(key, {text, until: GLib.get_monotonic_time() + ERROR_S * 1e6});
        // Un solo temporizador, solo mientras haya algún error a la vista.
        if (!this._errorId) {
            this._errorId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, ERROR_S, () => {
                const now = GLib.get_monotonic_time();
                for (const [k, e] of this._errors) {
                    if (e.until <= now)
                        this._errors.delete(k);
                }
                this._render();
                if (this._errors.size > 0)
                    return GLib.SOURCE_CONTINUE;
                this._errorId = 0;
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    // --- Página ---------------------------------------------------------------------------

    _buildPage() {
        const actor = new St.BoxLayout({
            style_class: 'agent-notch-docker-page',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.START,
        });

        const list = new St.BoxLayout({
            style_class: 'agent-notch-docker-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        const scroll = new St.ScrollView({
            style_class: 'agent-notch-docker-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            child: list,
        });
        actor.add_child(scroll);

        // Vacío o Docker sin responder: el mismo hueco con otro texto.
        const notice = new St.BoxLayout({
            style_class: 'agent-notch-docker-notice',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        notice.add_child(new St.Icon({icon_name: ICON, style_class: 'agent-notch-docker-notice-icon'}));
        const noticeTitle = new St.Label({
            style_class: 'agent-notch-docker-notice-title',
            x_align: Clutter.ActorAlign.CENTER,
        });
        notice.add_child(noticeTitle);
        const retry = new St.Button({
            style_class: 'agent-notch-docker-retry',
            label: 'Reintentar',
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        retry.connect('clicked', () => {
            this._setMode('list');
            this._watch();
        });
        notice.add_child(retry);
        actor.add_child(notice);

        const page = {actor, list, scroll, notice, noticeTitle, retry, groups: new Map(), rows: new Map()};
        this._page = page;
        this._applyMode();
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
        const notice = this._mode !== 'list';
        page.scroll.visible = !notice;
        page.notice.visible = notice;
        page.retry.visible = this._mode === 'down';
        page.noticeTitle.text = this._mode === 'down' ? 'Docker no responde' : 'No hay contenedores';
        this.emit('changed');
    }

    _newGroup(project) {
        const g = {project};
        g.actor = new St.BoxLayout({
            style_class: 'agent-notch-docker-group',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        const header = new St.BoxLayout({style_class: 'agent-notch-docker-group-header', x_expand: true});
        g.title = makeLabel('agent-notch-docker-group-title', {
            text: project || 'sin proyecto',
            y_align: Clutter.ActorAlign.CENTER,
        });
        g.count = new St.Label({
            style_class: 'agent-notch-docker-group-count',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(g.title);
        header.add_child(g.count);
        // Solo los proyectos de Compose tienen «todo».
        if (project) {
            g.buttonIcon = new St.Icon({style_class: 'agent-notch-docker-group-icon'});
            g.buttonLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER});
            const box = new St.BoxLayout({style_class: 'agent-notch-docker-group-button-box'});
            box.add_child(g.buttonIcon);
            box.add_child(g.buttonLabel);
            g.button = new St.Button({
                style_class: 'agent-notch-docker-group-button',
                child: box,
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            g.button.connect('clicked', () => {
                if (g.data)
                    this._actGroup(g.data);
            });
            header.add_child(g.button);
        }
        g.actor.add_child(header);
        g.rows = new St.BoxLayout({
            style_class: 'agent-notch-docker-rows',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        g.actor.add_child(g.rows);
        return g;
    }

    _newRow() {
        const r = {};
        r.actor = new St.BoxLayout({style_class: 'agent-notch-docker-row', x_expand: true});
        r.dot = new St.Widget({style_class: 'agent-notch-dot', y_align: Clutter.ActorAlign.CENTER});
        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        r.name = makeLabel('agent-notch-docker-row-name');
        r.detail = makeLabel('agent-notch-docker-row-detail');
        text.add_child(r.name);
        text.add_child(r.detail);
        r.ports = new St.Label({style_class: 'agent-notch-docker-row-ports', y_align: Clutter.ActorAlign.CENTER});
        r.icon = new St.Icon({style_class: 'agent-notch-docker-row-icon'});
        r.button = new St.Button({
            style_class: 'agent-notch-docker-row-button',
            child: r.icon,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        r.button.connect('clicked', () => {
            const c = r.data;
            if (c)
                this._act(c, isRunning(c.state) ? 'stop' : 'start');
        });
        for (const child of [r.dot, text, r.ports, r.button])
            r.actor.add_child(child);
        return r;
    }

    _render() {
        const page = this._page;
        if (!page)
            return;
        const groups = groupByProject(this._containers);
        const seenGroups = new Set();
        const seenRows = new Set();

        groups.forEach((group, gi) => {
            let g = page.groups.get(group.project);
            if (!g) {
                g = this._newGroup(group.project);
                page.groups.set(group.project, g);
                page.list.add_child(g.actor);
            }
            page.list.set_child_at_index(g.actor, gi);
            seenGroups.add(group.project);
            g.data = group;

            const running = group.containers.filter(c => isRunning(c.state)).length;
            g.count.text = `${running}/${group.containers.length}`;
            if (g.button) {
                const busy = this._busyGroups.has(group.project);
                const action = groupAction(group.containers);
                g.buttonIcon.icon_name = action === 'start' ? START_ICON : STOP_ICON;
                g.buttonLabel.text = busy ? '…' : action === 'start' ? 'Iniciar todo' : 'Detener todo';
                g.button.reactive = !busy;
                g.button.accessible_name = `${g.buttonLabel.text} ${group.project}`;
            }

            group.containers.forEach((c, ci) => {
                let r = page.rows.get(c.id);
                if (!r) {
                    r = this._newRow();
                    page.rows.set(c.id, r);
                }
                if (r.actor.get_parent() !== g.rows) {
                    r.actor.get_parent()?.remove_child(r.actor);
                    g.rows.add_child(r.actor);
                }
                g.rows.set_child_at_index(r.actor, ci);
                seenRows.add(c.id);
                this._renderRow(r, c);
            });
        });

        for (const [id, r] of page.rows) {
            if (!seenRows.has(id)) {
                r.actor.destroy();
                page.rows.delete(id);
            }
        }
        for (const [project, g] of page.groups) {
            if (!seenGroups.has(project)) {
                g.actor.destroy();
                page.groups.delete(project);
            }
        }

        // A la isla solo le importa si cambia el alto.
        const count = this._containers.length + groups.length;
        if (count !== this._shownCount) {
            this._shownCount = count;
            this.emit('changed');
        }
    }

    _renderRow(r, c) {
        r.data = c;
        const busy = this._busy.has(c.id);
        const running = isRunning(c.state);
        for (const cls of ['en-marcha', 'parado', 'cambiando']) {
            const on = cls === (busy ? 'cambiando' : running ? 'en-marcha' : 'parado');
            if (on)
                r.actor.add_style_class_name(cls);
            else
                r.actor.remove_style_class_name(cls);
        }
        if (r.name.text !== c.name)
            r.name.text = c.name;
        const err = this._errors.get(c.id);
        if (err)
            r.actor.add_style_class_name('con-error');
        else
            r.actor.remove_style_class_name('con-error');
        const detail = err?.text ?? `${busy ? '…' : stateText(c.state)} · ${c.image}`;
        if (r.detail.text !== detail)
            r.detail.text = detail;
        const ports = formatPorts(c.ports);
        if (r.ports.text !== ports)
            r.ports.text = ports;
        r.ports.visible = ports !== '';
        r.icon.icon_name = running ? STOP_ICON : START_ICON;
        r.button.reactive = !busy;
        r.button.accessible_name = `${running ? 'Detener' : 'Iniciar'} ${c.name}`;
    }

    destroy() {
        this._unwatch();
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._errorId) {
            GLib.source_remove(this._errorId);
            this._errorId = 0;
        }
        this._session?.abort();
        this._session = null;
        this._page?.actor.destroy();
        this._page = null;
        this._containers = [];
        this._busy.clear();
        this._busyGroups.clear();
        this._errors.clear();
    }
});
