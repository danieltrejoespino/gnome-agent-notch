// Módulo Mascota: un par de ojos en la isla en reposo (cuando ningún otro
// módulo tiene nada que mostrar). Ver docs/13-rediseno.md (etapa D4) y
// docs/09 (ojos con expresión, aprobado el 19-11-2026).
//
// Diseño propio (no el de Coucou/Mochi, que no está bajo licencia MIT).
// Abiertos sin agentes; entornados si solo hay sesiones esperando. Reacciona
// a la señal `changed` del módulo Agentes: sin temporizadores.

import GObject from 'gi://GObject';

import {NotchModule} from './module.js';
import {Eyes} from './widgets.js';

const PRIORITY = -100;   // solo si no hay nada más

export const MascotModule = GObject.registerClass(
class MascotModule extends NotchModule {
    _init(agents = null) {
        super._init();
        this._eyes = new Eyes({accessible_name: 'agent-notch'});
        this._eyes.add_style_class_name('mascota');
        this._agents = agents;
        this._agents?.connectObject('changed', () => this._sync(), this);
        this._sync();
    }

    // Si Agentes tiene algo en marcha, su vista tapa a la mascota; aquí
    // solo queda el caso de sesiones que esperan.
    _sync() {
        const waiting = this._agents?.hasExpanded ?? false;
        this._eyes.setExpression(waiting ? 'entornados' : 'abiertos', {animate: this.compactVisible});
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
        return this._eyes;
    }

    destroy() {
        this._agents?.disconnectObject(this);
        this._agents = null;
        this._eyes?.destroy();
        this._eyes = null;
    }
});
