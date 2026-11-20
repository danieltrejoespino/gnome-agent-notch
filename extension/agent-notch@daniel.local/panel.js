// Large panel with tabs (docs/13-rediseno.md, stage D3).
//
//   FRI 13 NOV
//   ┌──────────────────────────────┐
//   │  current page                │   Home: big clock + cards
//   └──────────────────────────────┘   Music, System…: the module's page
//   [⌂ HOME] [♪] [▤]                    tabs
//
// The island creates it on the first click and calls open()/close().
//
// Cost: with the panel closed it does nothing. Open, the clock is GNOME's
// (GnomeDesktop.WallClock: it notifies once a minute and follows the
// 12/24 h format from Settings); each module only works while its view
// is visible (setHomeVisible / setPageVisible).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const HOME = 'home';
const HOME_COLUMNS = 2;   // Home cards per row (docs/09)
const PAGE_FADE_MS = 120;  // fade when switching tabs (docs/09)
const HINT_FADE_MS = 100;  // tab name bubble
const HINT_GAP = 6;        // px between the bubble and the icon

const byPriority = (a, b) => b.priority - a.priority;

// Takes an actor out of its current parent (if any) so it can go into another.
function detach(actor) {
    actor.get_parent()?.remove_child(actor);
}

export const NotchPanel = GObject.registerClass({
    Signals: {'size-changed': {}},
}, class NotchPanel extends St.BoxLayout {
    _init(modules) {
        super._init({
            style_class: 'agent-notch-panel',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        this._modules = modules;   // the island's list (not copied)
        this._currentKey = HOME;
        this._shownModule = null;  // module whose page/cards are visible
        this._homeModules = [];
        this._isOpen = false;
        this._clock = null;
        this._home = null;         // created on first use
        this._tabs = new Map();    // key -> {button, label}
        this._extraActors = null;  // module actors at the end of the tabs
        this._hint = null;         // tab name bubble, created on first hover

        // Header: date.
        this._date = new St.Label({style_class: 'agent-notch-panel-date'});
        this.add_child(this._date);

        // Current page.
        this._pageBin = new St.Bin({
            style_class: 'agent-notch-panel-page',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });
        this.add_child(this._pageBin);

        // Tabs.
        this._tabBar = new St.BoxLayout({
            style_class: 'agent-notch-tabs',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._tabBar);

        this.connect('destroy', () => this._onDestroy());
    }

    get isOpen() {
        return this._isOpen;
    }

    /** Current page: HOME or the module whose page is visible. */
    get currentKey() {
        return this._currentKey;
    }

    /** Go to a module's page (or HOME); if closed, when it opens. */
    selectPage(key) {
        if (this._isOpen)
            this._showPage(key, {fade: true});
        else
            this._currentKey = key;
    }

    open() {
        if (this._isOpen)
            return;
        this._isOpen = true;

        this._buildTabs();
        if (this._currentKey !== HOME && !this._tabs.has(this._currentKey))
            this._currentKey = HOME;

        this._clock = new GnomeDesktop.WallClock({time_only: true});
        this._clock.connect('notify::clock', () => this._updateClock());
        this._updateClock();

        this._showPage(this._currentKey);
    }

    close() {
        if (!this._isOpen)
            return;
        this._isOpen = false;
        this._hideHint();
        this._hidePage();
        this._clock?.run_dispose();
        this._clock = null;
    }

    // --- Tabs -------------------------------------------------------------

    _pageModules() {
        return this._modules.filter(m => m.pageTitle).sort(byPriority);
    }

    _buildTabs() {
        // The modules do not change while the extension is enabled: they are
        // built once.
        if (this._tabs.size > 0)
            return;

        this._addTab(HOME, 'Home', 'go-home-symbolic');
        for (const module of this._pageModules())
            this._addTab(module, module.pageTitle, module.pageIcon);

        // What the modules add at the end (e.g. "Update", docs/18).
        this._extraActors = this._modules.map(m => m.tabBarActor).filter(Boolean);
        for (const actor of this._extraActors) {
            this._tabBar.add_child(actor);
            // Icon-only buttons (the settings gear) also get the name bubble.
            if (actor instanceof St.Button && actor.get_child() instanceof St.Icon)
                this._hintOnHover(actor, () => actor.accessible_name);
        }
    }

    _addTab(key, title, iconName) {
        const box = new St.BoxLayout({style_class: 'agent-notch-tab-box'});
        box.add_child(new St.Icon({icon_name: iconName, style_class: 'agent-notch-tab-icon'}));
        const label = new St.Label({
            text: title.toUpperCase(),
            style_class: 'agent-notch-tab-label',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        box.add_child(label);

        const button = new St.Button({
            style_class: 'agent-notch-tab',
            can_focus: true,
            child: box,
            accessible_name: title,
        });
        button.connect('clicked', () => this._showPage(key, {fade: true}));
        // The name shows in a bubble over the icon, not inside the button:
        // that would widen it, shift the centered bar and the icon would slip
        // out from under the pointer (docs/09). The active tab already shows it.
        this._hintOnHover(button, () => (key === this._currentKey ? null : title));
        this._tabBar.add_child(button);
        this._tabs.set(key, {button, label});
    }

    _hintOnHover(button, text) {
        button.track_hover = true;
        button.connect('notify::hover', () => {
            const name = button.hover ? text() : null;
            if (name)
                this._showHint(button, name);
            else
                this._hideHint(button);
        });
    }

    // --- Tab name bubble ------------------------------------------------------

    _showHint(button, name) {
        if (!this._hint) {
            this._hint = new St.Label({style_class: 'agent-notch-tab-hint', opacity: 0});
            Main.layoutManager.uiGroup.add_child(this._hint);
        }
        const hint = this._hint;
        hint.text = name;
        this._hintOwner = button;
        // Above the island (it lives in uiGroup too).
        Main.layoutManager.uiGroup.set_child_above_sibling(hint, null);
        const [bx, by] = button.get_transformed_position();
        const [bw] = button.get_transformed_size();
        const [, hw] = hint.get_preferred_width(-1);
        const [, hh] = hint.get_preferred_height(hw);
        hint.set_position(Math.round(bx + bw / 2 - hw / 2), Math.round(by - hh - HINT_GAP));
        hint.show();
        hint.remove_transition('opacity');
        hint.ease({opacity: 255, duration: HINT_FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    // Hides the bubble (only if it belongs to `button`, when one is given).
    _hideHint(button = null) {
        const hint = this._hint;
        if (!hint || (button && this._hintOwner !== button))
            return;
        this._hintOwner = null;
        hint.remove_transition('opacity');
        hint.opacity = 0;
        hint.hide();
    }

    // --- Keyboard (docs/09) ---------------------------------------------------

    /**
     * Keys while the panel is open (called from the island's grab).
     * Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+PgDn / Ctrl+PgUp: next / previous tab.
     * Left/Right and 1-9: the same, unless typing in a text field (the
     * Clipboard search box keeps its digits, and its arrows while it has text;
     * when it is empty the arrows switch tabs, so you are not stuck there).
     * Returns true if handled.
     */
    handleKey(event) {
        if (!this._isOpen || this._tabs.size === 0)
            return false;
        const sym = event.get_key_symbol();
        const state = event.get_state();
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const alt = (state & Clutter.ModifierType.MOD1_MASK) !== 0;

        if (ctrl && (sym === Clutter.KEY_Tab || sym === Clutter.KEY_ISO_Left_Tab))
            return this._moveTab(shift || sym === Clutter.KEY_ISO_Left_Tab ? -1 : 1);
        if (ctrl && sym === Clutter.KEY_Page_Down)
            return this._moveTab(1);
        if (ctrl && sym === Clutter.KEY_Page_Up)
            return this._moveTab(-1);

        if (ctrl || alt)
            return false;
        const arrow = sym === Clutter.KEY_Right ? 1 : sym === Clutter.KEY_Left ? -1 : 0;
        const focus = global.stage.get_key_focus();
        if (focus instanceof Clutter.Text && focus.editable) {
            // Typing: the field keeps its digits, and its arrows while it has
            // text (there is a cursor to move). Empty, the arrows switch tabs.
            if (arrow && focus.text === '')
                return this._moveTab(arrow);
            return false;
        }

        if (arrow)
            return this._moveTab(arrow);
        const digit = [Clutter.KEY_1, Clutter.KEY_KP_1].map(base => sym - base)
            .find(d => d >= 0 && d <= 8);
        if (digit !== undefined) {
            const keys = [...this._tabs.keys()];
            if (digit < keys.length) {
                this._showPage(keys[digit], {fade: true});
                return true;
            }
        }
        return false;
    }

    _moveTab(step) {
        const keys = [...this._tabs.keys()];
        const i = Math.max(0, keys.indexOf(this._currentKey));
        this._showPage(keys[(i + step + keys.length) % keys.length], {fade: true});
        return true;
    }

    // --- Pages --------------------------------------------------------------

    // fade: fade the new content in (switching tabs, not when opening).
    _showPage(key, {fade = false} = {}) {
        if (!this._isOpen)
            return;
        this._hideHint();
        this._hidePage();
        this._currentKey = key;

        for (const [tabKey, {button, label}] of this._tabs) {
            const active = tabKey === key;
            label.visible = active;
            if (active)
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
        }

        if (key === HOME) {
            this._showHome();
        } else {
            const page = key.pageActor;
            detach(page);
            this._pageBin.set_child(page);
            this._shownModule = key;
            key.setPageVisible(true);
        }
        // With "reduce animations" GNOME makes the duration 0.
        this._pageBin.remove_transition('opacity');
        this._pageBin.opacity = 255;
        if (fade) {
            this._pageBin.opacity = 0;
            this._pageBin.ease({
                opacity: 255,
                duration: PAGE_FADE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
        this.emit('size-changed');
    }

    _hidePage() {
        this._shownModule?.setPageVisible(false);
        this._shownModule = null;
        for (const module of this._homeModules)
            module.setHomeVisible(false);
        this._homeModules = [];
    }

    _buildHome() {
        const home = new St.BoxLayout({
            style_class: 'agent-notch-home',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._bigClock = new St.Label({
            style_class: 'agent-notch-home-clock',
            x_align: Clutter.ActorAlign.CENTER,
        });
        home.add_child(this._bigClock);

        // Grid of 2 equal columns (docs/09, review of 19-11-2026):
        // with the panel's fixed width 4 cards do not fit in one row. Rows
        // with `homogeneous` (aligned columns); created once.
        this._cards = new St.BoxLayout({
            style_class: 'agent-notch-home-cards',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._cardRows = [];
        home.add_child(this._cards);
        return home;
    }

    _showHome() {
        this._home ??= this._buildHome();
        detach(this._home);
        this._pageBin.set_child(this._home);
        this._updateClock();

        // Module cards, by priority (the actors belong to the
        // modules: reused, not recreated).
        this._clearCards();
        this._homeModules = this._modules.filter(m => m.homeCard).sort(byPriority);
        this._homeModules.forEach((module, i) => {
            const card = module.homeCard;
            detach(card);
            card.x_expand = true;
            this._cardRow(Math.floor(i / HOME_COLUMNS)).add_child(card);
            module.setHomeVisible(true);
        });
    }

    _cardRow(i) {
        if (!this._cardRows[i]) {
            const row = new St.BoxLayout({style_class: 'agent-notch-home-row', x_expand: true});
            row.layout_manager.homogeneous = true;
            this._cardRows[i] = row;
        }
        const row = this._cardRows[i];
        if (!row.get_parent())
            this._cards.add_child(row);
        return row;
    }

    // Releases the cards (they belong to the modules) and removes the panel's rows.
    _clearCards() {
        for (const row of this._cardRows ?? [])
            row.remove_all_children();
        this._cards?.remove_all_children();
    }

    // --- Clock and date ----------------------------------------------------------

    _updateClock() {
        if (!this._clock)
            return;
        if (this._bigClock)
            this._bigClock.text = this._clock.clock;
        const date = GLib.DateTime.new_now_local().format('%a %-d %b').toUpperCase();
        if (this._date.text !== date)
            this._date.text = date;
    }

    // 'destroy' signal (not an overridden destroy(): Clutter does not call it when
    // destroying the island's children).
    _onDestroy() {
        this.close();
        this._hint?.destroy();
        this._hint = this._hintOwner = null;
        // Release the modules' actors: they are theirs, not the panel's.
        this._pageBin.set_child(null);
        for (const actor of this._extraActors ?? [])
            this._tabBar.remove_child(actor);
        this._extraActors = null;
        this._clearCards();
        for (const row of this._cardRows ?? [])
            row.destroy();
        this._cardRows = [];
        this._home?.destroy();
        this._home = this._bigClock = this._cards = null;
    }
});
