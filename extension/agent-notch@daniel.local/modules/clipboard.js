// Clipboard module: history of what was copied (text only), with search and
// pinned items, in a panel tab. Super+V opens it; picking an entry
// copies it and pastes it on its own. See docs/15-modulo-portapapeles.md.
//
// Consumo:
//   - Event-driven: Meta.Selection's 'owner-changed' signal reports each
//     copy; there are no timers or polling.
//   - History in RAM with a cap (50 texts of up to 256 KB). Only the
//     pinned items go to disk, written asynchronously and atomically.
//   - The page is created the first time it opens; its rows are reused
//     and only redrawn while it is visible.
//
// Super+V: GNOME uses it for its notification panel (toggle-message-tray,
// together with Super+M). The handler of that shortcut is changed ONLY inside the
// process (nothing in dconf): V → clipboard; anything else → as usual.

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

const PRIORITY = -10;               // tab after the others
const ICON = 'edit-paste-symbolic';
const MAX_HISTORY = 50;
const MAX_PINNED = 50;
const MAX_TEXT_LENGTH = 256 * 1024; // characters; longer is not stored
const PREVIEW_LENGTH = 200;         // what is shown of each text
const PASTE_DELAY_MS = 60;          // let the focus go back to the app before pasting

const KEYBINDING = 'toggle-message-tray';
const KEYBINDING_SCHEMA = 'org.gnome.shell.keybindings';
const KEYBINDING_MODES = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW |
    Shell.ActionMode.POPUP;

// Password managers' convention (KeePassXC and others): do not store.
const SECRET_MIMETYPE = 'x-kde-passwordManagerHint';
const TEXT_MIMETYPES = ['text/plain;charset=utf-8', 'text/plain', 'UTF8_STRING', 'STRING', 'TEXT'];

// In terminals, paste is Ctrl+Shift+V.
const TERMINAL_HINTS = ['terminal', 'ptyxis', 'console', 'kgx', 'kitty', 'alacritty',
    'foot', 'wezterm', 'ghostty', 'xterm', 'tilix', 'terminator', 'konsole', 'blackbox'];

const PINNED_FILE = GLib.build_filenamev([GLib.get_user_data_dir(), 'agent-notch', 'clipboard-pinned.json']);

const log = msg => console.log(`[agent-notch] clipboard: ${msg}`);

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
    // shortcut: take Super+V (atajo-portapapeles setting, docs/20).
    _init({shortcut = true} = {}) {
        super._init();
        this._shortcut = shortcut;

        this._history = [];      // texts, the most recent first
        this._pinned = [];       // pinned texts, in the order they were pinned
        this._items = [];        // what is visible now (after filtering)
        this._rows = [];         // reusable rows of the page
        this._selected = 0;
        this._page = null;
        this._pasteId = 0;
        this._saving = false;
        this._saveAgain = false;
        this._cancellable = new Gio.Cancellable();
        this._clipboard = St.Clipboard.get_default();

        global.display.get_selection().connectObject('owner-changed',
            (_sel, type, source) => this._onOwnerChanged(type, source), this);

        if (this._shortcut)
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
        return 'Clipboard';
    }

    get pageIcon() {
        return ICON;
    }

    _onViewsChanged(views) {
        if (!views.has('page'))
            return;
        if (this._entry.text)
            this._entry.text = '';   // triggers _render() through text-changed
        else
            this._render();
        this._entry.grab_key_focus();
    }

    // --- Copies -------------------------------------------------------------

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

    // Picking an entry: copy it, close the panel and paste it into the app.
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

    // --- Pinned items --------------------------------------------------------------

    _togglePin(text) {
        const i = this._pinned.indexOf(text);
        if (i >= 0) {
            this._pinned.splice(i, 1);
            // So it does not vanish suddenly: it goes back to the history.
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
                    log(`could not read pinned items: ${e.message}`);
            }
        });
    }

    // Asynchronous, atomic write (replace_contents uses a temporary file),
    // with 0600 permissions. Bursts are grouped: at most one in progress.
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
                        log(`could not save pinned items: ${e.message}`);
                    }
                    done();
                });
        };

        file.get_parent().make_directory_async(GLib.PRIORITY_DEFAULT, null, (dir, res) => {
            try {
                dir.make_directory_finish(res);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
                    log(`could not create ${dir.get_path()}: ${e.message}`);
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

    // Give GNOME its shortcut back exactly as ui/windowManager.js registers it.
    _restoreKeybinding() {
        Main.wm.removeKeybinding(KEYBINDING);
        Main.wm.addKeybinding(KEYBINDING,
            new Gio.Settings({schema_id: KEYBINDING_SCHEMA}),
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, KEYBINDING_MODES,
            Main.wm._toggleCalendar.bind(Main.wm));
    }

    // --- Page ---------------------------------------------------------------

    _buildPage() {
        const page = new St.BoxLayout({
            style_class: 'agent-notch-clipboard-page',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            // Stuck to the top even with few rows (BinLayout only follows
            // y_align if the child has y_expand).
            y_expand: true,
            y_align: Clutter.ActorAlign.START,
        });

        this._entry = new St.Entry({
            style_class: 'agent-notch-clipboard-search',
            hint_text: 'Search…',
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({icon_name: 'edit-find-symbolic', style_class: 'agent-notch-clipboard-search-icon'}),
        });
        this._entry.clutter_text.connect('text-changed', () => {
            this._selected = 0;
            this._render();
        });
        this._entry.clutter_text.connect('key-press-event', (_actor, event) => this._onKeyPress(event));

        // Search box + "Clear": clears the history but not the pinned items.
        const toolbar = new St.BoxLayout({style_class: 'agent-notch-clipboard-toolbar', x_expand: true});
        toolbar.add_child(this._entry);
        this._clearButton = new St.Button({
            style_class: 'agent-notch-clipboard-clear',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'Clear history (pinned items stay)',
            child: new St.Icon({icon_name: 'edit-clear-all-symbolic', style_class: 'agent-notch-clipboard-clear-icon'}),
        });
        this._clearButton.connect('clicked', () => this._clearHistory());
        toolbar.add_child(this._clearButton);
        page.add_child(toolbar);

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
            text: 'Copy something and it will show up here',
            x_align: Clutter.ActorAlign.CENTER,
        });
        page.add_child(this._empty);

        return page;
    }

    // Clears the history; pinned items stay (like on Windows).
    _clearHistory() {
        this._history = [];
        this._selected = 0;
        this._entry.text = '';   // triggers _render() through text-changed
        this._render();
        this._entry.grab_key_focus();
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

    // Recomputes what is visible. With the page closed it does nothing: it is
    // recomputed when it opens (_onViewsChanged).
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
            row.pin.accessible_name = item.pinned ? 'Unpin' : 'Pin';
            if (item.pinned)
                row.pin.add_style_pseudo_class('checked');
            else
                row.pin.remove_style_pseudo_class('checked');
        });

        if (this._selected >= this._items.length)
            this._selected = 0;
        this._syncSelection();

        const unpinned = this._history.some(t => !this._pinned.includes(t));
        this._clearButton.reactive = unpinned;
        this._clearButton.can_focus = unpinned;
        if (unpinned)
            this._clearButton.remove_style_pseudo_class('insensitive');
        else
            this._clearButton.add_style_pseudo_class('insensitive');

        const empty = this._items.length === 0;
        // Fewer or more rows (search, clear, copy): the island readjusts.
        if (this._shownCount !== undefined && this._shownCount !== this._items.length) {
            this._shownCount = this._items.length;
            this.emit('changed');
        }
        this._shownCount = this._items.length;
        this._scroll.visible = !empty;
        this._empty.visible = empty;
        this._empty.text = this._history.length + this._pinned.length === 0
            ? 'Copy something and it will show up here'
            : 'Nothing matches your search';
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
        if (this._shortcut)
            this._restoreKeybinding();

        if (this._pasteId) {
            GLib.source_remove(this._pasteId);
            this._pasteId = 0;
        }
        this._keyboard?.run_dispose();
        this._keyboard = null;

        this._page?.destroy();
        this._page = this._entry = this._list = this._scroll = this._empty = this._clearButton = null;
        this._rows = [];
        this._items = [];
        this._history = [];
        this._pinned = [];
    }
});
