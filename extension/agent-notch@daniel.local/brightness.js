// Brillo de monitores externos por DDC/CI en Ajustes rápidos: una barra
// como la de brillo de GNOME, justo debajo de ella, por cada monitor externo
// que acepte DDC/CI. Ver docs/17-brillo-monitor.md.
//
// GNOME 50 solo mueve el brillo de pantallas con backlight en Mutter (la
// del portátil); los monitores externos se controlan por DDC/CI, que es
// lento (~0,8 s para buscarlos, ~0,13 s por escritura). Eso lo hace un
// servicio D-Bus aparte (services/brightness/brightness.py) que el D-Bus
// arranca al llamarlo y que se cierra solo a los 30 s sin uso.
//
// Consumo: sin monitor externo no se hace nada. Se buscan monitores solo
// al activar la extensión y cuando cambia el conjunto de monitores
// externos (señal monitors-changed); el valor se relee al abrir Ajustes
// rápidos. Mientras se arrastra la barra se manda como mucho un valor cada
// 200 ms (y siempre el último).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {QuickSlider, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

const BUS_NAME = 'dev.agentnotch.Brightness';
const OBJECT_PATH = '/dev/agentnotch/Brightness';
const INTERFACE = 'dev.agentnotch.Brightness';
const CALL_TIMEOUT_MS = 15000;

const HOTPLUG_DELAY_S = 3;     // el monitor recién conectado tarda en responder por DDC
const SEND_EVERY_MS = 200;     // mientras se arrastra
const N_COLUMNS = 2;           // las barras ocupan las dos columnas

// En el GNOME de prueba el monitor es virtual y no coincide con el real:
// scripts/dev-shell.sh pone esta variable para mostrar todos los monitores
// DDC que encuentre ddcutil.
const DEV_ANY_MONITOR = GLib.getenv('AGENT_NOTCH_DDC_ANY') === '1';

// 'SAM:S24R35x:ABC123' → monitores externos activos según Mutter, con
// el mismo formato que el campo "Monitor" de `ddcutil detect`.
function externalMonitors() {
    const found = new Map();
    const manager = global.backend.get_monitor_manager();
    for (const logical of manager.get_logical_monitors()) {
        for (const m of logical.get_monitors()) {
            if (m.is_builtin() || !m.is_active())
                continue;
            const id = `${m.get_vendor() ?? ''}:${m.get_product() ?? ''}:${m.get_serial() ?? ''}`;
            found.set(id, m.get_display_name());
        }
    }
    return found;
}

const MonitorSlider = GObject.registerClass(
class MonitorSlider extends QuickSlider {
    _init(bus, name, maximum, sendValue) {
        super._init({
            iconName: 'video-display-symbolic',
            iconLabel: name,
        });
        this.bus = bus;
        this.maximum = maximum;
        this.slider.accessible_name = name;

        this._sendValue = sendValue;
        this._blocked = false;
        this._pending = null;   // valor que falta por mandar
        this._sent = null;
        this._throttleId = 0;

        this.slider.connectObject('notify::value', () => {
            if (!this._blocked)
                this._queue(Math.round(this.slider.value * this.maximum));
        }, this);
    }

    // Valor leído del monitor (al detectar o al abrir Ajustes rápidos).
    showValue(current, maximum) {
        if (this._throttleId)
            return;   // se está arrastrando: manda lo que pide el usuario
        this.maximum = maximum;
        this._sent = current;
        this._blocked = true;
        this.slider.value = maximum > 0 ? current / maximum : 0;
        this._blocked = false;
    }

    _queue(value) {
        this._pending = value;
        if (this._throttleId)
            return;
        this._flush();
        this._throttleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEND_EVERY_MS, () => {
            if (this._pending !== null) {
                this._flush();
                return GLib.SOURCE_CONTINUE;
            }
            this._throttleId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _flush() {
        const value = this._pending;
        this._pending = null;
        if (value === this._sent)
            return;
        this._sent = value;
        this._sendValue(this.bus, value);
    }

    destroy() {
        if (this._throttleId) {
            GLib.source_remove(this._throttleId);
            this._throttleId = 0;
        }
        this.slider.disconnectObject(this);
        this.menu?.destroy();   // GNOME no lo destruye con el item
        super.destroy();
    }
});

export class MonitorBrightness {
    constructor() {
        this._indicator = new SystemIndicator();
        this._sliders = [];
        this._cancellable = new Gio.Cancellable();
        this._knownMonitors = '';
        this._hotplugId = 0;
        this._detecting = false;
        this._detectAgain = false;

        // Sin icono en la barra: solo aporta las barras de Ajustes rápidos.
        const quickSettings = Main.panel.statusArea.quickSettings;
        quickSettings.addExternalIndicator(this._indicator, N_COLUMNS);

        Main.layoutManager.connectObject('monitors-changed', () => this._onMonitorsChanged(), this);
        quickSettings.menu.connectObject('open-state-changed', (_menu, open) => {
            if (open)
                this._refresh();
        }, this);

        this._onMonitorsChanged(true);
    }

    _onMonitorsChanged(now = false) {
        const monitors = externalMonitors();
        const key = [...monitors.keys()].sort().join('|');
        if (key === this._knownMonitors && !now)
            return;   // cambio de resolución, escala…: los mismos monitores
        this._knownMonitors = key;

        if (this._hotplugId) {
            GLib.source_remove(this._hotplugId);
            this._hotplugId = 0;
        }
        if (monitors.size === 0 && !DEV_ANY_MONITOR) {
            this._setDisplays([]);
            return;
        }
        if (now) {
            this._detect();
            return;
        }
        this._hotplugId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, HOTPLUG_DELAY_S, () => {
            this._hotplugId = 0;
            this._detect();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Llamada asíncrona al servicio; el D-Bus lo arranca si no está.
    _call(method, params, replyType, onReply) {
        Gio.DBus.session.call(BUS_NAME, OBJECT_PATH, INTERFACE, method, params,
            replyType ? new GLib.VariantType(replyType) : null,
            Gio.DBusCallFlags.NONE, CALL_TIMEOUT_MS, this._cancellable,
            (conn, res) => {
                let reply = null, error = null;
                try {
                    reply = conn.call_finish(res).deepUnpack();
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                    error = e;
                }
                if (!this._cancellable.is_cancelled())
                    onReply(reply, error);
            });
    }

    _detect() {
        if (this._detecting) {
            this._detectAgain = true;
            return;
        }
        this._detecting = true;
        this._call('Detect', null, '(a(issuu))', (result, error) => {
            this._detecting = false;
            if (error) {
                console.warn(`[agent-notch] Brightness: could not look for monitors: ${error.message}`);
                this._setDisplays([]);
            } else {
                this._setDisplays(result[0]);
            }
            if (this._detectAgain) {
                this._detectAgain = false;
                this._detect();
            }
        });
    }

    _setDisplays(displays) {
        const monitors = externalMonitors();
        const wanted = displays
            .filter(([, id]) => DEV_ANY_MONITOR || monitors.has(id))
            .map(([bus, id, model, current, maximum]) =>
                ({bus, name: monitors.get(id) ?? model, current, maximum}));

        // Mismos monitores que ya hay: solo se actualizan los valores.
        const same = wanted.length === this._sliders.length &&
            wanted.every((d, i) => d.bus === this._sliders[i].bus);
        if (!same) {
            this._destroySliders();
            const quickSettings = Main.panel.statusArea.quickSettings;
            for (const d of wanted) {
                const slider = new MonitorSlider(d.bus, d.name, d.maximum,
                    (bus, value) => this._send(bus, value));
                this._sliders.push(slider);
                this._indicator.quickSettingsItems.push(slider);
                this._insert(quickSettings, slider);
            }
        }
        wanted.forEach((d, i) => this._sliders[i].showValue(d.current, d.maximum));
    }

    // Justo debajo de la barra de brillo de GNOME (o de la última de las
    // nuestras). `_brightness` es interno de GNOME: si no está, la barra va
    // donde la pone addExternalIndicator (al final).
    _insert(quickSettings, slider) {
        const menu = quickSettings.menu;
        const anchor = this._sliders.at(-2) ??
            quickSettings._brightness?.quickSettingsItems?.at(-1);
        const grid = menu._grid;
        if (anchor && grid && anchor.get_parent() === grid) {
            menu.insertItemBefore(slider, anchor.get_next_sibling(), N_COLUMNS);
            return;
        }
        const sibling = quickSettings._backgroundApps?.quickSettingsItems?.at(-1) ?? null;
        menu.insertItemBefore(slider, sibling, N_COLUMNS);
    }

    _refresh() {
        for (const slider of this._sliders) {
            this._call('Get', new GLib.Variant('(i)', [slider.bus]), '(uu)', (result, error) => {
                if (!this._sliders.includes(slider))
                    return;
                if (error) {
                    console.warn(`[agent-notch] Brightness: could not read the monitor: ${error.message}`);
                    return;
                }
                slider.showValue(result[0], result[1]);
            });
        }
    }

    _send(bus, value) {
        this._call('Set', new GLib.Variant('(iu)', [bus, value]), null, (_reply, error) => {
            if (error)
                console.warn(`[agent-notch] Brightness: could not change it: ${error.message}`);
        });
    }

    _destroySliders() {
        for (const slider of this._sliders)
            slider.destroy();
        this._sliders = [];
        this._indicator.quickSettingsItems.length = 0;
    }

    destroy() {
        this._cancellable.cancel();
        if (this._hotplugId) {
            GLib.source_remove(this._hotplugId);
            this._hotplugId = 0;
        }
        Main.layoutManager.disconnectObject(this);
        Main.panel.statusArea.quickSettings.menu.disconnectObject(this);
        this._destroySliders();
        this._indicator.destroy();
        this._indicator = null;
    }
}
