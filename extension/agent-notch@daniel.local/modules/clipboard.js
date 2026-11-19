// Módulo Portapapeles: historial de lo copiado (solo texto), con búsqueda y
// fijados, en una pestaña del panel. Super+V la abre; al elegir una entrada
// se copia y se pega sola. Ver docs/15-modulo-portapapeles.md.
//
// Consumo:
//   - Por eventos: la señal 'owner-changed' de Meta.Selection avisa de cada
//     copia; no hay temporizadores ni sondeo.
//   - Historial en RAM con tope (50 textos de hasta 256 KB). Solo los
//     fijados van a disco, con escritura asíncrona y atómica.
//   - La página se crea la primera vez que se abre; sus filas se reutilizan
//     y solo se redibujan mientras se ve.
//
// Super+V: GNOME lo usa para su panel de notificaciones (toggle-message-tray,
// junto con Super+M). Se cambia el manejador de ese atajo SOLO dentro del
// proceso (nada en dconf): V → portapapeles; lo demás → lo de siempre.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

import {NotchModule} from './module.js';
import {makeLabel} from './widgets.js';

const PRIORITY = -10;               // pestaña después de las demás
const ICON = 'edit-paste-symbolic';
const MAX_HISTORY = 50;
const MAX_PINNED = 50;
const MAX_TEXT_LENGTH = 256 * 1024; // caracteres; más largo no se guarda
const PREVIEW_LENGTH = 200;         // lo que se muestra de cada texto
const PASTE_DELAY_MS = 60;          // que el foco vuelva a la app antes de pegar

const KEYBINDING = 'toggle-message-tray';
const KEYBINDING_SCHEMA = 'org.gnome.shell.keybindings';
const KEYBINDING_MODES = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW |
    Shell.ActionMode.POPUP;

// Convención de los gestores de contraseñas (KeePassXC y otros): no guardar.
const SECRET_MIMETYPE = 'x-kde-passwordManagerHint';
const TEXT_MIMETYPES = ['text/plain;charset=utf-8', 'text/plain', 'UTF8_STRING', 'STRING', 'TEXT'];

// En las terminales se pega con Ctrl+Shift+V.
const TERMINAL_HINTS = ['terminal', 'ptyxis', 'console', 'kgx', 'kitty', 'alacritty',
    'foot', 'wezterm', 'ghostty', 'xterm', 'tilix', 'terminator', 'konsole', 'blackbox'];

const PINNED_FILE = GLib.build_filenamev([GLib.get_user_data_dir(), 'agent-notch', 'clipboard-pinned.json']);

const log = msg => console.log(`[agent-notch] portapapeles: ${msg}`);

function preview(text) {
    return text.slice(0, PREVIEW_LENGTH)
        .replace(/\r?\n/g, ' ⏎ ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isTerminal(window) {
    const wmClass = (window?.get_wm_class() ?? '').toLowerCase();
    return TERMINAL_HINTS.some(hint => wmClass.includes(hint));
}

export const ClipboardModule = GObject.registerClass(
class ClipboardModule extends NotchModule {
    _init() {
        super._init();

        this._history = [];      // textos, el más reciente primero
        this._pinned = [];       // textos fijados, en el orden en que se fijaron
        this._items = [];        // lo que se ve ahora (tras filtrar)
        this._rows = [];         // filas reutilizables de la página
        this._selected = 0;
        this._page = null;
        this._pasteId = 0;
        this._saving = false;
        this._saveAgain = false;
        this._cancellable = new Gio.Cancellable();
        this._clipboard = St.Clipboard.get_default();

        global.display.get_selection().connectObject('owner-changed',
            (_sel, type, source) => this._onOwnerChanged(type, source), this);

        this._takeKeybinding();
        this._loadPinned();
    }

    get priority() {
        return PRIORITY;
    }

    get pageActor() {
        this._page ??= this._buildPage();
        return this._page;
    }

    get pageTitle() {
        return 'Portapapeles';
    }

    get pageIcon() {
        return ICON;
    }

    _onViewsChanged(views) {
        if (!views.has('page'))
            return;
        if (this._entry.text)
            this._entry.text = '';   // dispara _render() vía text-changed
        else
            this._render();
        this._entry.grab_key_focus();
    }

    // --- Copias -------------------------------------------------------------

    _onOwnerChanged(type, source) {
        if (type !== Meta.SelectionType.SELECTION_CLIPBOARD || !source)
            return;
        const mimetypes = source.get_mimetypes();
        if (mimetypes.includes(SECRET_MIMETYPE))
            return;
        if (!mimetypes.some(m => TEXT_MIMETYPES.includes(m)))
            return;

        this._clipboard.get_text(St.ClipboardType.CLIPBOARD, (_cb, text) => {
            if (!this._cancellable || !text || !text.trim() || text.length > MAX_TEXT_LENGTH)
                return;
            this._remember(text);
        });
    }

    _remember(text) {
        const i = this._history.indexOf(text);
        if (i === 0)
            return;
        if (i > 0)
            this._history.splice(i, 1);
        this._history.unshift(text);
        if (this._history.length > MAX_HISTORY)
            this._history.length = MAX_HISTORY;
        this._render();
    }

    // Elegir una entrada: copiarla, cerrar el panel y pegarla en la app.
    _choose(text) {
        this._remember(text);
        this._clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
        this.emit('dismiss');

        if (this._pasteId)
            GLib.source_remove(this._pasteId);
        this._pasteId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PASTE_DELAY_MS, () => {
            this._pasteId = 0;
            this._paste();
            return GLib.SOURCE_REMOVE;
        });
    }

    _paste() {
        const window = global.display.focus_window;
        if (!window)
            return;
        if (!this._keyboard) {
            const seat = Clutter.get_default_backend().get_default_seat();
            this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        }
        const keys = isTerminal(window)
            ? [Clutter.KEY_Control_L, Clutter.KEY_Shift_L, Clutter.KEY_v]
            : [Clutter.KEY_Control_L, Clutter.KEY_v];
        const time = GLib.get_monotonic_time();
        for (const key of keys)
            this._keyboard.notify_keyval(time, key, Clutter.KeyState.PRESSED);
        for (const key of keys.reverse())
            this._keyboard.notify_keyval(time, key, Clutter.KeyState.RELEASED);
    }

    // --- Fijados --------------------------------------------------------------

    _togglePin(text) {
        const i = this._pinned.indexOf(text);
        if (i >= 0) {
            this._pinned.splice(i, 1);
            // Que no desaparezca de golpe: vuelve al historial.
            if (!this._history.includes(text))
                this._history.unshift(text);
        } else {
            if (this._pinned.length >= MAX_PINNED)
                return;
            this._pinned.push(text);
        }
        this._render();
        this._savePinned();
    }

    _loadPinned() {
        const file = Gio.File.new_for_path(PINNED_FILE);
        file.load_contents_async(this._cancellable, (_f, res) => {
            try {
                const [, bytes] = file.load_contents_finish(res);
                const data = JSON.parse(new TextDecoder().decode(bytes));
                if (Array.isArray(data?.pinned)) {
                    this._pinned = data.pinned
                        .filter(t => typeof t === 'string' && t.length <= MAX_TEXT_LENGTH)
                        .slice(0, MAX_PINNED);
                    this._render();
                }
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) &&
                    !e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    log(`no se pudieron leer los fijados: ${e.message}`);
            }
        });
    }

    // Escritura asíncrona y atómica (replace_contents usa un archivo temporal),
    // con permisos 0600. Las ráfagas se agrupan: como mucho una en curso.
    _savePinned() {
        if (this._saving) {
            this._saveAgain = true;
            return;
        }
        this._saving = true;
        const file = Gio.File.new_for_path(PINNED_FILE);
        const bytes = new GLib.Bytes(new TextEncoder().encode(
            JSON.stringify({version: 1, pinned: this._pinned})));

        const done = () => {
            this._saving = false;
            if (this._saveAgain) {
                this._saveAgain = false;
                this._savePinned();
            }
        };
        const write = () => {
            file.replace_contents_bytes_async(bytes, null, false,
                Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
                null, (_f, res) => {
                    try {
                        file.replace_contents_finish(res);
                    } catch (e) {
                        log(`no se pudieron guardar los fijados: ${e.message}`);
                    }
                    done();
                });
        };

        file.get_parent().make_directory_async(GLib.PRIORITY_DEFAULT, null, (dir, res) => {
            try {
                dir.make_directory_finish(res);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
                    log(`no se pudo crear ${dir.get_path()}: ${e.message}`);
                    done();
                    return;
                }
            }
            write();
        });
    }

    // --- Super+V --------------------------------------------------------------

    _takeKeybinding() {
        Main.wm.removeKeybinding(KEYBINDING);
        Main.wm.addKeybinding(KEYBINDING,
            new Gio.Settings({schema_id: KEYBINDING_SCHEMA}),
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, KEYBINDING_MODES,
            (_display, _window, event) => {
                const key = event?.get_key_symbol?.();
                if (key === Clutter.KEY_v || key === Clutter.KEY_V)
                    this.emit('show-page');
                else
                    Main.panel.toggleCalendar();
            });
    }

    // Devolver a GNOME su atajo tal cual lo registra ui/windowManager.js.
    _restoreKeybinding() {
        Main.wm.removeKeybinding(KEYBINDING);
        Main.wm.addKeybinding(KEYBINDING,
            new Gio.Settings({schema_id: KEYBINDING_SCHEMA}),
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, KEYBINDING_MODES,
            Main.wm._toggleCalendar.bind(Main.wm));
    }

    // --- Página ---------------------------------------------------------------

    _buildPage() {
        const page = new St.BoxLayout({
            style_class: 'agent-notch-clipboard-page',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            // Pegada arriba aunque haya pocas filas (BinLayout solo respeta
            // y_align si el hijo tiene y_expand).
            y_expand: true,
            y_align: Clutter.ActorAlign.START,
        });

        this._entry = new St.Entry({
            style_class: 'agent-notch-clipboard-search',
            hint_text: 'Buscar…',
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({icon_name: 'edit-find-symbolic', style_class: 'agent-notch-clipboard-search-icon'}),
        });
        this._entry.clutter_text.connect('text-changed', () => {
            this._selected = 0;
            this._render();
        });
        this._entry.clutter_text.connect('key-press-event', (_actor, event) => this._onKeyPress(event));
        page.add_child(this._entry);

        this._list = new St.BoxLayout({
            style_class: 'agent-notch-clipboard-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._scroll = new St.ScrollView({
            style_class: 'agent-notch-clipboard-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            child: this._list,
        });
        page.add_child(this._scroll);

        this._empty = new St.Label({
            style_class: 'agent-notch-clipboard-empty',
            text: 'Copia algo y aparecerá aquí',
            x_align: Clutter.ActorAlign.CENTER,
        });
        page.add_child(this._empty);

        return page;
    }

    _onKeyPress(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Down || key === Clutter.KEY_Up) {
            const n = this._items.length;
            if (n > 0) {
                this._selected = (this._selected + (key === Clutter.KEY_Down ? 1 : -1) + n) % n;
                this._syncSelection();
            }
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
            const item = this._items[this._selected];
            if (item)
                this._choose(item.text);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _newRow() {
        const row = {text: null};
        row.actor = new St.BoxLayout({style_class: 'agent-notch-clipboard-row', x_expand: true});

        row.label = makeLabel('agent-notch-clipboard-text', {
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.button = new St.Button({
            style_class: 'agent-notch-clipboard-item',
            child: row.label,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            can_focus: true,
        });
        row.button.connect('clicked', () => this._choose(row.text));
        row.actor.add_child(row.button);

        row.pinIcon = new St.Icon({style_class: 'agent-notch-clipboard-pin-icon'});
        row.pin = new St.Button({
            style_class: 'agent-notch-clipboard-pin',
            child: row.pinIcon,
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.pin.connect('clicked', () => this._togglePin(row.text));
        row.actor.add_child(row.pin);

        this._list.add_child(row.actor);
        return row;
    }

    // Recalcula lo que se ve. Con la página cerrada no hace nada: se
    // recalcula al abrirla (_onViewsChanged).
    _render() {
        if (!this._page || !this.visibleViews.has('page'))
            return;

        const query = this._entry.text.trim().toLowerCase();
        const matches = text => !query || text.toLowerCase().includes(query);
        this._items = [
            ...this._pinned.filter(matches).map(text => ({text, pinned: true})),
            ...this._history.filter(t => !this._pinned.includes(t) && matches(t))
                .map(text => ({text, pinned: false})),
        ];

        while (this._rows.length < this._items.length)
            this._rows.push(this._newRow());

        this._rows.forEach((row, i) => {
            const item = this._items[i];
            row.actor.visible = !!item;
            if (!item) {
                row.text = null;
                return;
            }
            if (row.text !== item.text) {
                row.text = item.text;
                row.label.text = preview(item.text);
            }
            row.pinIcon.icon_name = item.pinned ? 'starred-symbolic' : 'non-starred-symbolic';
            row.pin.accessible_name = item.pinned ? 'Desfijar' : 'Fijar';
            if (item.pinned)
                row.pin.add_style_pseudo_class('checked');
            else
                row.pin.remove_style_pseudo_class('checked');
        });

        if (this._selected >= this._items.length)
            this._selected = 0;
        this._syncSelection();

        const empty = this._items.length === 0;
        this._scroll.visible = !empty;
        this._empty.visible = empty;
        this._empty.text = this._history.length + this._pinned.length === 0
            ? 'Copia algo y aparecerá aquí'
            : 'Nada coincide con la búsqueda';
    }

    _syncSelection() {
        this._rows.forEach((row, i) => {
            if (i === this._selected && row.actor.visible)
                row.button.add_style_pseudo_class('selected');
            else
                row.button.remove_style_pseudo_class('selected');
        });
        const row = this._rows[this._selected];
        if (row?.actor.visible)
            ensureActorVisibleInScrollView(this._scroll, row.actor);
    }

    destroy() {
        this._cancellable?.cancel();
        this._cancellable = null;
        global.display.get_selection().disconnectObject(this);
        this._restoreKeybinding();

        if (this._pasteId) {
            GLib.source_remove(this._pasteId);
            this._pasteId = 0;
        }
        this._keyboard?.run_dispose();
        this._keyboard = null;

        this._page?.destroy();
        this._page = this._entry = this._list = this._scroll = this._empty = null;
        this._rows = [];
        this._items = [];
        this._history = [];
        this._pinned = [];
    }
});
