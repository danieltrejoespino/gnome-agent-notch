import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {MonitorBrightness} from './brightness.js';
import {Island} from './island.js';
import {AgentsModule} from './modules/agents.js';
import {ClipboardModule} from './modules/clipboard.js';
import {DockerModule} from './modules/docker.js';
import {FocusModule} from './modules/focus.js';
import {MascotModule} from './modules/mascot.js';
import {MusicModule} from './modules/music.js';
import {NotificationsModule} from './modules/notifications.js';
import {SystemModule} from './modules/system.js';

// Cuánto sobresale la isla por debajo de la barra superior (px lógicos),
// para que se distinga aunque la barra también sea negra, como un notch.
const OVERHANG_PX = 4;

export default class AgentNotchExtension extends Extension {
    enable() {
        // El reloj ocupa el centro de la barra: lo pasamos a la derecha
        // (como en un MacBook con notch). disable() lo devuelve a su sitio.
        this._moveClock(Main.panel._rightBox);

        // La isla flota sobre la barra (no va dentro de ella) para poder
        // crecer hacia abajo al expandirse en etapas posteriores.
        this._island = new Island();
        this._island.addModule(new MusicModule());
        this._island.addModule(new SystemModule());
        this._island.addModule(new NotificationsModule());
        this._island.addModule(new FocusModule());
        this._island.addModule(new ClipboardModule());
        this._island.addModule(new AgentsModule());
        this._island.addModule(new DockerModule());
        this._island.addModule(new MascotModule());
        Main.layoutManager.addTopChrome(this._island, {trackFullscreen: true});

        const reposition = () => this._reposition();
        this._island.connectObject('notify::width', reposition, this);
        Main.panel.connectObject('notify::height', reposition, this);
        Main.layoutManager.connectObject('monitors-changed', reposition, this);
        St.ThemeContext.get_for_stage(global.stage)
            .connectObject('notify::scale-factor', reposition, this);
        this._reposition();

        // Brillo de monitores externos en Ajustes rápidos (docs/17).
        this._brightness = new MonitorBrightness();
    }

    disable() {
        this._brightness?.destroy();
        this._brightness = null;

        // Regla de oro: deshacer TODO lo que hizo enable().
        Main.layoutManager.disconnectObject(this);
        Main.panel.disconnectObject(this);
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);

        if (this._island) {
            Main.layoutManager.removeChrome(this._island);
            this._island.destroy();
            this._island = null;
        }

        this._moveClock(Main.panel._centerBox);
    }

    _moveClock(box) {
        const clock = Main.panel.statusArea.dateMenu?.container;
        if (!clock || clock.get_parent() === box)
            return;
        clock.get_parent()?.remove_child(clock);
        box.insert_child_at_index(clock, 0);
    }

    _reposition() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || !this._island)
            return;

        if (Main.panel.height > 0) {
            const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
            this._island.setCompactHeight(Main.panel.height + OVERHANG_PX * scaleFactor);
        }

        const x = monitor.x + Math.round((monitor.width - this._island.width) / 2);
        this._island.set_position(x, monitor.y);
    }
}
