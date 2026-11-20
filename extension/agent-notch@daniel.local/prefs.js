// agent-notch preferences window (docs/20-preferencias.md). It opens from the
// gear in the island's panel, from `gnome-extensions prefs` or from an
// extensions app, in a process separate from GNOME Shell and only while it is
// open. Each switch is bound to its key with settings.bind: the extension
// hears about it through the `changed` signal (no polling).

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// [key, title, subtitle]
const TABS = [
    ['modulo-agentes', 'Agents', 'Claude Code, OpenCode… on the island and in their tab'],
    ['modulo-musica', 'Music', 'What is playing and its controls'],
    ['modulo-sistema', 'System', 'RAM, CPU, network and internet speed'],
    ['modulo-docker', 'Docker', 'Containers; only shown if Docker is installed'],
    ['modulo-portapapeles', 'Clipboard', 'History with search and pinned items'],
    ['modulo-concentracion', 'Focus', 'Work timer'],
];

export default class AgentNotchPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;   // keep it alive as long as the window

        const page = new Adw.PreferencesPage({
            title: 'Settings',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        // --- Tabs -------------------------------------------------------------
        const tabs = new Adw.PreferencesGroup({
            title: 'Tabs',
            description: 'A tab that is turned off is not loaded, so it uses no memory. ' +
                'The island restarts when you change them.',
        });
        for (const [key, title, subtitle] of TABS)
            tabs.add(this._switch(settings, key, title, subtitle));
        page.add(tabs);

        // --- Agent alerts -----------------------------------------------------
        const alerts = new Adw.PreferencesGroup({
            title: 'Agent alerts',
            description: 'When an agent needs you. With GNOME’s Do Not Disturb there is ' +
                'neither a banner nor a sound.',
        });
        alerts.add(this._switch(settings, 'sonido-atencion', 'Sound',
            'A short sound from the sound theme'));
        alerts.add(this._switch(settings, 'banner-atencion', '“Needs you” banner',
            'The island opens with the alert; click → the agent’s terminal'));
        const seconds = Adw.SpinRow.new_with_range(2, 30, 1);
        seconds.title = 'Banner duration';
        seconds.subtitle = 'Seconds (with the pointer over it, it waits until it leaves)';
        settings.bind('banner-segundos', seconds, 'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('banner-atencion', seconds, 'sensitive', Gio.SettingsBindFlags.GET);
        alerts.add(seconds);
        page.add(alerts);

        // --- Appearance -------------------------------------------------------
        const look = new Adw.PreferencesGroup({title: 'Appearance'});
        look.add(this._switch(settings, 'agentes-dos-lineas', 'Agents on two lines',
            'Eyes on top and the text below; the island grows a little while agents are active'));
        look.add(this._switch(settings, 'animar-ojos', 'Animate the eyes',
            'Blink, pulse and flash. GNOME’s Reduce Animation always turns them off'));
        page.add(look);

        // --- Shortcuts and updates --------------------------------------------
        const more = new Adw.PreferencesGroup({title: 'Shortcuts and updates'});
        more.add(this._switch(settings, 'atajo-portapapeles', 'Super+V opens the Clipboard',
            'If you turn it off, GNOME gets its shortcut back'));
        more.add(this._switch(settings, 'aviso-actualizaciones', 'Notify about new versions',
            'One daily check on GitHub and the “Update” button on the island ' +
            '(only for versions installed from GitHub)'));
        more.add(new Adw.ActionRow({
            title: 'Version',
            subtitle: this.metadata['version-name'] ?? 'unknown',
        }));
        page.add(more);
    }

    _switch(settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({title, subtitle});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }
}
