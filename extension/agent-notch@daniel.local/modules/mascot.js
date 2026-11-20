// Módulo Mascota: un par de ojos en la isla en reposo (cuando ningún otro
// módulo tiene nada que mostrar). Ver docs/13-rediseno.md (etapa D4) y
// docs/09 (ojos con expresión, aprobado el 19-11-2026).
//
// Diseño propio (no el de Coucou/Mochi, que no está bajo licencia MIT).
// Abiertos sin agentes; entornados si solo hay sesiones esperando. Con una
// versión nueva de agent-notch, un puntito azul fijo al lado (docs/18).
// Reacciona a la señal `changed` de Agentes y Actualización: sin temporizadores.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {NotchModule} from './module.js';
import {Eyes} from './widgets.js';

const PRIORITY = -100;   // solo si no hay nada más

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

    // Si Agentes tiene algo en marcha, su vista tapa a la mascota; aquí
    // solo queda el caso de sesiones que esperan.
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

    // Es la vista "de reposo": la isla mantiene su tamaño mínimo.
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
