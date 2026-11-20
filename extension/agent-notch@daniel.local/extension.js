import GLib from 'gi://GLib';
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
import {UpdateModule} from './modules/update.js';
import {setEyeAnimations} from './modules/widgets.js';

// Cuánto sobresale la isla por debajo de la barra superior (px lógicos),
// para que se distinga aunque la barra también sea negra, como un notch.
const OVERHANG_PX = 4;

// Ajustes que se leen en el momento de usarlos (docs/20); el resto cambia qué
// actores existen y obliga a rehacer la isla.
const LIVE_KEYS = new Set(['sonido-atencion', 'banner-atencion', 'banner-segundos']);
const REBUILD_DELAY_MS = 300;   // agrupa varios cambios seguidos

export default class AgentNotchExtension extends Extension {
    enable() {
        // El reloj ocupa el centro de la barra: lo pasamos a la derecha
        // (como en un MacBook con notch). disable() lo devuelve a su sitio.
        this._moveClock(Main.panel._rightBox);

        // Ajustes de la ventana de preferencias (docs/20), por eventos.
        this._settings = this.getSettings();
        this._rebuildId = 0;
        this._settings.connectObject('changed', (_s, key) => {
            if (!LIVE_KEYS.has(key))
                this._queueRebuild();
        }, this);

        this._buildIsland();

        // La isla se centra sola al cambiar de ancho (Island.setAnchor): aquí
        // solo hace falta recolocarla si cambian el monitor, la barra o la escala.
        const reposition = () => this._reposition();
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

        this._settings?.disconnectObject(this);
        if (this._rebuildId) {
            GLib.source_remove(this._rebuildId);
            this._rebuildId = 0;
        }
        this._destroyIsland();
        this._settings = null;
        setEyeAnimations(true);

        this._moveClock(Main.panel._centerBox);
    }

    // La isla con los módulos encendidos en los ajustes. Un módulo apagado no
    // se crea: ni pestaña, ni tarjeta, ni memoria (docs/20).
    _buildIsland() {
        const s = this._settings;
        const on = key => s.get_boolean(key);
        setEyeAnimations(on('animar-ojos'));

        // La isla flota sobre la barra (no va dentro de ella) para poder
        // crecer hacia abajo al expandirse.
        this._island = new Island();
        if (on('modulo-musica'))
            this._island.addModule(new MusicModule());
        if (on('modulo-sistema'))
            this._island.addModule(new SystemModule());
        this._island.addModule(new NotificationsModule());
        if (on('modulo-concentracion'))
            this._island.addModule(new FocusModule());
        if (on('modulo-portapapeles'))
            this._island.addModule(new ClipboardModule({shortcut: on('atajo-portapapeles')}));
        let agents = null;
        if (on('modulo-agentes')) {
            agents = new AgentsModule({settings: s, twoLines: on('agentes-dos-lineas')});
            this._island.addModule(agents);
        }
        if (on('modulo-docker'))
            this._island.addModule(new DockerModule());
        // La versión del código cargado (version-name, la escribe install.sh);
        // sin aviso de actualizaciones, el módulo no vigila nada.
        const running = on('aviso-actualizaciones') ? this.metadata['version-name'] ?? null : null;
        const update = new UpdateModule(running);
        this._island.addModule(update);
        // Ojos según los agentes y puntito si hay versión nueva.
        this._island.addModule(new MascotModule(agents, update));
        Main.layoutManager.addTopChrome(this._island, {trackFullscreen: true});
    }

    _queueRebuild() {
        if (this._rebuildId)
            GLib.source_remove(this._rebuildId);
        this._rebuildId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REBUILD_DELAY_MS, () => {
            this._rebuildId = 0;
            this._destroyIsland();
            this._buildIsland();
            this._reposition();
            return GLib.SOURCE_REMOVE;
        });
    }

    _destroyIsland() {
        if (this._island) {
            // Parar las animaciones y hacer ya la colocación pendiente,
            // mientras sigue en pantalla. Si no, al desactivar a mitad de un
            // cambio de tamaño (p. ej. al bloquear justo cuando termina un
            // agente), Clutter colocaría luego una isla ya quitada
            // («Spurious clutter_actor_allocate», visto el 19-11-2026).
            this._island.remove_all_transitions();
            this._island.get_allocation_box();
            Main.layoutManager.removeChrome(this._island);
            this._island.destroy();
            this._island = null;
        }
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

        this._island.setAnchor(monitor.x + monitor.width / 2, monitor.y);
    }
}
