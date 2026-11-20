// Panel grande con pestañas (docs/13-rediseno.md, etapa D3).
//
//   VIE 13 NOV
//   ┌──────────────────────────────┐
//   │  página actual               │   Home: reloj grande + tarjetas
//   └──────────────────────────────┘   Música, Sistema…: página del módulo
//   [⌂ HOME] [♪] [▤]                    pestañas
//
// La isla lo crea la primera vez que se hace clic y llama a open()/close().
//
// Consumo: con el panel cerrado no hace nada. Abierto, el reloj es el de
// GNOME (GnomeDesktop.WallClock: avisa una vez por minuto y respeta el
// formato 12/24 h de Ajustes); cada módulo trabaja solo mientras su vista
// se ve (setHomeVisible / setPageVisible).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import GObject from 'gi://GObject';
import St from 'gi://St';

const HOME = 'home';
const HOME_COLUMNS = 2;   // tarjetas de Home por fila (docs/09)

const byPriority = (a, b) => b.priority - a.priority;

// Saca un actor de su padre actual (si lo tiene) para poder ponerlo en otro.
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

        this._modules = modules;   // la lista de la isla (no se copia)
        this._currentKey = HOME;
        this._shownModule = null;  // módulo cuya página/tarjetas se ven
        this._homeModules = [];
        this._isOpen = false;
        this._clock = null;
        this._home = null;         // se crea al primer uso
        this._tabs = new Map();    // key -> {button, label}
        this._extraActors = null;  // actores de los módulos al final de las pestañas

        // Cabecera: fecha.
        this._date = new St.Label({style_class: 'agent-notch-panel-date'});
        this.add_child(this._date);

        // Página actual.
        this._pageBin = new St.Bin({
            style_class: 'agent-notch-panel-page',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });
        this.add_child(this._pageBin);

        // Pestañas.
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

    /** Página actual: HOME o el módulo cuya página se ve. */
    get currentKey() {
        return this._currentKey;
    }

    /** Ir a la página de un módulo (o a HOME); si está cerrado, al abrir. */
    selectPage(key) {
        if (this._isOpen)
            this._showPage(key);
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
        this._hidePage();
        this._clock?.run_dispose();
        this._clock = null;
    }

    // --- Pestañas -------------------------------------------------------------

    _pageModules() {
        return this._modules.filter(m => m.pageTitle).sort(byPriority);
    }

    _buildTabs() {
        // Los módulos no cambian mientras la extensión está activa: se
        // construyen una vez.
        if (this._tabs.size > 0)
            return;

        this._addTab(HOME, 'Home', 'go-home-symbolic');
        for (const module of this._pageModules())
            this._addTab(module, module.pageTitle, module.pageIcon);

        // Lo que los módulos añaden al final (p. ej. «Actualizar», docs/18).
        this._extraActors = this._modules.map(m => m.tabBarActor).filter(Boolean);
        for (const actor of this._extraActors)
            this._tabBar.add_child(actor);
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
        button.connect('clicked', () => this._showPage(key));
        this._tabBar.add_child(button);
        this._tabs.set(key, {button, label});
    }

    // --- Páginas --------------------------------------------------------------

    _showPage(key) {
        if (!this._isOpen)
            return;
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

        // Cuadrícula de 2 columnas iguales (docs/09, revisión del 19-11-2026):
        // con el ancho fijo del panel no caben 4 tarjetas en una fila. Filas
        // con `homogeneous` (columnas alineadas); se crean una vez.
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

        // Tarjetas de los módulos, por prioridad (los actores son de los
        // módulos: se reutilizan, no se recrean).
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

    // Suelta las tarjetas (son de los módulos) y quita las filas del panel.
    _clearCards() {
        for (const row of this._cardRows ?? [])
            row.remove_all_children();
        this._cards?.remove_all_children();
    }

    // --- Reloj y fecha ----------------------------------------------------------

    _updateClock() {
        if (!this._clock)
            return;
        if (this._bigClock)
            this._bigClock.text = this._clock.clock;
        const date = GLib.DateTime.new_now_local().format('%a %-d %b').toUpperCase();
        if (this._date.text !== date)
            this._date.text = date;
    }

    // Señal 'destroy' (no un destroy() sobrescrito: Clutter no lo llama al
    // destruir a los hijos de la isla).
    _onDestroy() {
        this.close();
        // Soltar los actores de los módulos: son de ellos, no del panel.
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
