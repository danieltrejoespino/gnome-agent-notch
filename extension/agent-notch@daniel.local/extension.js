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
import {TailscaleModule} from './modules/tailscale.js';
import {SettingsModule} from './modules/settings.js';
import {UpdateModule} from './modules/update.js';
import {setEyeAnimations} from './modules/widgets.js';

// How far the island hangs below the top bar (logical px), so it stands
// out even when the bar is black too, like a notch.
const OVERHANG_PX = 4;

// Settings read at the moment they are used (docs/20); the rest change which
// actors exist and require rebuilding the island.
const LIVE_KEYS = new Set(['sonido-atencion', 'banner-atencion', 'banner-segundos']);
const REBUILD_DELAY_MS = 300;   // groups several changes in a row

export default class AgentNotchExtension extends Extension {
    enable() {
        // The clock sits in the middle of the bar: we move it to the right
        // (like on a MacBook with a notch). disable() puts it back.
        this._moveClock(Main.panel._rightBox);

        // Preferences window settings (docs/20), event-driven.
        this._settings = this.getSettings();
        this._rebuildId = 0;
        this._settings.connectObject('changed', (_s, key) => {
            if (!LIVE_KEYS.has(key))
                this._queueRebuild();
        }, this);

        this._buildIsland();

        // The island centers itself when its width changes (Island.setAnchor): here
        // it only needs repositioning when the monitor, the bar or the scale change.
        const reposition = () => this._reposition();
        Main.panel.connectObject('notify::height', reposition, this);
        Main.layoutManager.connectObject('monitors-changed', reposition, this);
        St.ThemeContext.get_for_stage(global.stage)
            .connectObject('notify::scale-factor', reposition, this);
        this._reposition();

        // External monitor brightness in Quick Settings (docs/17).
        this._brightness = new MonitorBrightness();
    }

    disable() {
        this._brightness?.destroy();
        this._brightness = null;

        // Golden rule: undo EVERYTHING enable() did.
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

    // The island with the modules turned on in the settings. A module that is
    // off is not created: no tab, no card, no memory (docs/20).
    _buildIsland() {
        const s = this._settings;
        const on = key => s.get_boolean(key);
        setEyeAnimations(on('animar-ojos'));

        // The island floats over the bar (it is not inside it) so it can
        // grow downwards when it expands.
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
        if (on('modulo-tailscale'))
            this._island.addModule(new TailscaleModule());
        // The version of the loaded code (version-name, written by install.sh);
        // with the update notice off, the module watches nothing.
        const running = on('aviso-actualizaciones') ? this.metadata['version-name'] ?? null : null;
        const update = new UpdateModule(running);
        this._island.addModule(update);
        // Eyes driven by the agents, and a dot when a new version is out.
        this._island.addModule(new MascotModule(agents, update));
        // Gear at the end of the tab bar: opens the preferences (docs/20).
        this._island.addModule(new SettingsModule(() => this.openPreferences()));
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
            // Stop the animations and do the pending layout now, while it is
            // still on screen. Otherwise, when disabling in the middle of a
            // size change (e.g. locking right when an agent finishes), Clutter
            // would later lay out an island that was already removed
            // ("Spurious clutter_actor_allocate", seen on 19-11-2026).
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
