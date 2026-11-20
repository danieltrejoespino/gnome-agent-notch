// Settings module: a gear at the end of the panel's tab bar that opens the
// preferences window (docs/20). Ubuntu does not ship the Extensions app, so
// this is the way in that needs nothing else installed.
//
// It does not launch processes: Extension.openPreferences() asks GNOME Shell's
// own extensions service over D-Bus to open the window. Nothing runs at rest;
// the button is created the first time the panel builds its tab bar.

import GObject from 'gi://GObject';
import St from 'gi://St';

import {NotchModule} from './module.js';

const ICON = 'emblem-system-symbolic';

export const SettingsModule = GObject.registerClass(
class SettingsModule extends NotchModule {
    // openPrefs: callback that opens the preferences window.
    _init(openPrefs) {
        super._init();
        this._openPrefs = openPrefs;
        this._button = null;
    }

    get tabBarActor() {
        if (!this._button) {
            this._button = new St.Button({
                style_class: 'agent-notch-tab agent-notch-settings-button',
                child: new St.Icon({icon_name: ICON, style_class: 'agent-notch-tab-icon'}),
                can_focus: true,
                accessible_name: 'Settings',
            });
            // Close the panel first (the island's 'dismiss'), then open the
            // window: otherwise the panel would stay on top of it.
            this._button.connect('clicked', () => {
                this.emit('dismiss');
                this._openPrefs?.();
            });
        }
        return this._button;
    }

    destroy() {
        this._button?.destroy();
        this._button = null;
        this._openPrefs = null;
    }
});
