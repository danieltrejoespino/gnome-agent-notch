// Módulo Mascota: un par de ojos en la isla en reposo (cuando ningún otro
// módulo tiene nada que mostrar). Ver docs/13-rediseno.md (etapa D4).
//
// Diseño propio (no el de Coucou/Mochi, que no está bajo licencia MIT):
// dos círculos pequeños blanco azulado. Fijos, sin animación
// (decidido el 13-11-2026): coste cero, sin temporizadores.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {NotchModule} from './module.js';

const PRIORITY = -100;   // solo si no hay nada más

export const MascotModule = GObject.registerClass(
class MascotModule extends NotchModule {
    _init() {
        super._init();
        this._eyes = new St.BoxLayout({
            style_class: 'agent-notch-eyes',
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'agent-notch',
        });
        for (let i = 0; i < 2; i++) {
            this._eyes.add_child(new St.Widget({
                style_class: 'agent-notch-eye',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
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
        this._eyes?.destroy();
        this._eyes = null;
    }
});
