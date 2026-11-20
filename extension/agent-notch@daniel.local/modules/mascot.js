// Mascot module: a pair of eyes on the island at rest (when no other
// module has anything to show). See docs/13-rediseno.md (stage D4) and
// docs/09 (eyes with expression, approved on 19-11-2026).
//
// Our own design (not Coucou/Mochi's, which is not under the MIT license).
// Open without agents; half-closed if there are only waiting sessions. With a
// new agent-notch version, a fixed blue dot next to them (docs/18).
// Reacts to the `changed` signal of Agents and Update: no timers.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {NotchModule} from './module.js';
import {Eyes} from './widgets.js';

const PRIORITY = -100;   // only if there is nothing else

export const MascotModule = GObject.registerClass(
class MascotModule extends NotchModule {
    _init(agents = null, update = null) {
        super._init();
        this._box = new St.BoxLayout({
            style_class: 'agent-notch-mascot',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._eyes = new Eyes({accessible_name: 'agent-notch'});
        this._eyes.add_style_class_name('mascota');
        this._dot = new St.Widget({
            style_class: 'agent-notch-update-dot',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._box.add_child(this._eyes);
        this._box.add_child(this._dot);
        this._agents = agents;
        this._agents?.connectObject('changed', () => this._sync(), this);
        this._updater = update;
        this._updater?.connectObject('changed', () => this._sync(), this);
        this._sync();
    }

    // If Agents has something running, its view covers the mascot; here
    // only the case of waiting sessions is left.
    _sync() {
        const waiting = this._agents?.hasExpanded ?? false;
        this._eyes.setExpression(waiting ? 'entornados' : 'abiertos', {animate: this.compactVisible});
        this._dot.visible = this._updater?.available ?? false;
    }

    get priority() {
        return PRIORITY;
    }

    get active() {
        return true;
    }

    // It is the "resting" view: the island keeps its minimal size.
    get minimal() {
        return true;
    }

    get compactActor() {
        return this._box;
    }

    destroy() {
        this._agents?.disconnectObject(this);
        this._updater?.disconnectObject(this);
        this._agents = this._updater = null;
        this._box?.destroy();
        this._box = this._eyes = this._dot = null;
    }
});
