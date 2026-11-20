// Módulo Concentración: temporizador (15 / 25 / 50 min) para trabajar sin
// distracciones. Ver docs/13-rediseno.md (etapa D4).
//
// Vistas: compacta mientras cuenta («◔ 18 min»), sección en el hover,
// tarjeta de Home («25:00 · Concentración, listo ▶») y página propia.
//
// Consumo (lo mínimo posible para un temporizador):
//   - Parado: nada.
//   - Contando y sin ninguna vista detallada: un despertar por MINUTO
//     (la compacta solo muestra minutos) + uno al terminar.
//   - Con el hover, Home o la página a la vista: un despertar por segundo,
//     solo mientras se ve.
//   - Al bloquear la pantalla GNOME desactiva la extensión: se guarda la
//     hora de fin en $XDG_RUNTIME_DIR (RAM) y se recupera al desbloquear.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {NotchModule} from './module.js';
import {Bar, formatTime, makeLabel} from './widgets.js';

const PRIORITY = 20;            // contando: gana a la música en la compacta
const PRESETS_MIN = [15, 25, 50];
const DEFAULT_MIN = 25;
const ICON = 'alarm-symbolic';
const STATE_FILE = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'agent-notch', 'focus.json']);

const STATUS_TEXT = {
    idle: 'Focus, ready',
    running: 'Focusing',
    paused: 'Paused',
};

const nowSeconds = () => GLib.get_real_time() / 1e6;

export const FocusModule = GObject.registerClass(
class FocusModule extends NotchModule {
    _init() {
        super._init();

        this._mode = 'idle';                 // 'idle' | 'running' | 'paused'
        this._duration = DEFAULT_MIN * 60;   // s
        this._endsAt = 0;                    // s (hora real) si running
        this._remaining = this._duration;    // s si paused
        this._tickId = 0;
        this._viewList = [];                    // vistas creadas (se crean al primer uso)
        this._exp = this._card = this._page = null;

        this._buildCompact();
        this._restoreState();
        this._refreshAll();
    }

    get priority() {
        return PRIORITY;
    }

    get active() {
        return this._mode !== 'idle';
    }

    get compactActor() {
        return this._compact;
    }

    get hasExpanded() {
        return this._mode !== 'idle';
    }

    get expandedActor() {
        this._exp ??= this._newView('agent-notch-focus-expanded', {presets: false});
        return this._exp.actor;
    }

    get homeCard() {
        this._card ??= this._newView('agent-notch-card agent-notch-focus-card', {presets: false, card: true});
        return this._card.actor;
    }

    get pageActor() {
        this._page ??= this._newView('agent-notch-focus-page', {presets: true, bar: true});
        return this._page.actor;
    }

    get pageTitle() {
        return 'Focus';
    }

    get pageIcon() {
        return ICON;
    }

    // --- Estado ---------------------------------------------------------------

    get _remainingSeconds() {
        if (this._mode === 'running')
            return Math.max(0, this._endsAt - nowSeconds());
        if (this._mode === 'paused')
            return this._remaining;
        return this._duration;
    }

    _start() {
        if (this._mode === 'running')
            return;
        const remaining = this._mode === 'paused' ? this._remaining : this._duration;
        this._endsAt = nowSeconds() + remaining;
        this._setMode('running');
        // Minimizar la isla: el tiempo se sigue viendo en la compacta.
        this.emit('dismiss');
    }

    _pause() {
        if (this._mode !== 'running')
            return;
        this._remaining = this._remainingSeconds;
        this._setMode('paused');
    }

    _reset() {
        this._setMode('idle');
    }

    _setDuration(minutes) {
        this._duration = minutes * 60;
        if (this._mode === 'idle')
            this._refreshAll();
        else
            this._reset();
    }

    _finish() {
        this._setMode('idle');
        this._notifyFinished();
    }

    _setMode(mode) {
        this._mode = mode;
        this._schedule();
        this._refreshAll();
        // Aparece/desaparece de la compacta y el tamaño de las vistas cambia.
        this.emit('changed');
    }

    // Un solo temporizador: cada segundo si alguna vista detallada se ve,
    // si no, al siguiente cambio de minuto (o al final, lo que llegue antes).
    _schedule() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
        if (this._mode !== 'running')
            return;

        const remaining = this._remainingSeconds;
        if (remaining <= 0) {
            this._finish();
            return;
        }

        const detailed = this.visibleViews.size > 0;
        const toNextMinute = Math.ceil(remaining) % 60 || 60;
        const delay = detailed ? 1 : Math.max(1, Math.min(Math.ceil(remaining), toNextMinute));

        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._tickId = 0;
            this._refreshAll();
            this._schedule();
            return GLib.SOURCE_REMOVE;
        });
    }

    _onViewsChanged() {
        this._refreshAll();
        this._schedule();
    }

    _notifyFinished() {
        try {
            const source = MessageTray.getSystemSource();
            source.addNotification(new MessageTray.Notification({
                source,
                title: 'Focus session done',
                body: `${Math.round(this._duration / 60)} min done. Take a break!`,
                iconName: ICON,
                urgency: MessageTray.Urgency.HIGH,
            }));
        } catch (e) {
            console.error('[agent-notch] Could not announce the end of the timer:', e.message);
        }
    }

    // --- Persistencia al bloquear la pantalla ----------------------------------

    _saveState() {
        try {
            if (this._mode === 'idle') {
                GLib.unlink(STATE_FILE);
                return;
            }
            GLib.mkdir_with_parents(GLib.path_get_dirname(STATE_FILE), 0o700);
            GLib.file_set_contents(STATE_FILE, JSON.stringify({
                mode: this._mode,
                duration: this._duration,
                endsAt: this._endsAt,
                remaining: this._remaining,
            }));
        } catch (e) {
            console.error('[agent-notch] Could not save the timer:', e.message);
        }
    }

    _restoreState() {
        let state;
        try {
            const [ok, bytes] = GLib.file_get_contents(STATE_FILE);
            GLib.unlink(STATE_FILE);
            if (!ok)
                return;
            state = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
            return;   // no había temporizador guardado
        }
        if (!['running', 'paused'].includes(state?.mode))
            return;

        this._duration = Number(state.duration) || DEFAULT_MIN * 60;
        if (state.mode === 'paused') {
            this._mode = 'paused';
            this._remaining = Number(state.remaining) || 0;
        } else if (Number(state.endsAt) > nowSeconds()) {
            this._mode = 'running';
            this._endsAt = Number(state.endsAt);
        } else {
            // Terminó mientras la pantalla estaba bloqueada.
            this._notifyFinished();
            return;
        }
        this._schedule();
    }

    // --- Vistas ----------------------------------------------------------------

    _buildCompact() {
        this._compact = new St.BoxLayout({
            style_class: 'agent-notch-focus-compact',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._compact.add_child(new St.Icon({icon_name: ICON, style_class: 'agent-notch-music-icon'}));
        this._compactLabel = new St.Label({
            style_class: 'agent-notch-focus-compact-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._compact.add_child(this._compactLabel);
    }

    _newView(styleClass, {presets = false, bar = false, card = false}) {
        const actor = new St.BoxLayout({
            style_class: styleClass,
            orientation: card ? Clutter.Orientation.HORIZONTAL : Clutter.Orientation.VERTICAL,
            x_expand: true,
        });

        const textBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        actor.add_child(textBox);

        const time = new St.Label({
            style_class: card ? 'agent-notch-focus-card-time' : 'agent-notch-focus-time',
            x_align: card ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER,
        });
        const status = makeLabel(card ? 'agent-notch-card-subtitle' : 'agent-notch-focus-status',
            {x_align: card ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER});
        textBox.add_child(time);
        textBox.add_child(status);

        const view = {actor, time, status, bar: null, play: null, reset: null, presetButtons: []};

        if (bar) {
            view.bar = new Bar({style_class: 'agent-notch-usage-trough agent-notch-focus-bar'});
            actor.add_child(view.bar);
        }

        if (presets) {
            const row = new St.BoxLayout({
                style_class: 'agent-notch-focus-presets',
                x_align: Clutter.ActorAlign.CENTER,
            });
            for (const minutes of PRESETS_MIN) {
                const button = new St.Button({
                    style_class: 'agent-notch-tab agent-notch-focus-preset',
                    label: `${minutes} min`,
                    can_focus: true,
                });
                button.connect('clicked', () => this._setDuration(minutes));
                row.add_child(button);
                view.presetButtons.push({button, minutes});
            }
            actor.add_child(row);
        }

        const controls = new St.BoxLayout({
            style_class: 'agent-notch-music-controls',
            x_align: card ? Clutter.ActorAlign.END : Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const playIcon = new St.Icon({icon_name: 'media-playback-start-symbolic'});
        view.play = new St.Button({
            style_class: 'agent-notch-music-button play',
            can_focus: true,
            child: playIcon,
        });
        view.playIcon = playIcon;
        view.play.connect('clicked', () => {
            if (this._mode === 'running')
                this._pause();
            else
                this._start();
        });
        controls.add_child(view.play);

        if (!card) {
            view.reset = new St.Button({
                style_class: 'agent-notch-music-button',
                can_focus: true,
                child: new St.Icon({icon_name: 'view-refresh-symbolic'}),
            });
            view.reset.connect('clicked', () => this._reset());
            controls.add_child(view.reset);
        }
        actor.add_child(controls);

        this._viewList.push(view);
        this._refreshView(view);
        return view;
    }

    _refreshAll() {
        const minutes = Math.ceil(this._remainingSeconds / 60);
        const text = this._mode === 'paused' ? `${minutes} min ⏸` : `${minutes} min`;
        if (this._compactLabel.text !== text)
            this._compactLabel.text = text;
        for (const view of this._viewList)
            this._refreshView(view);
    }

    _refreshView(view) {
        const remaining = this._remainingSeconds;
        const time = formatTime(Math.ceil(remaining));
        if (view.time.text !== time)
            view.time.text = time;
        const status = STATUS_TEXT[this._mode];
        if (view.status.text !== status)
            view.status.text = status;

        view.bar?.setFraction(this._duration > 0 ? 1 - remaining / this._duration : 0);
        view.playIcon.icon_name = this._mode === 'running'
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';
        if (view.reset)
            view.reset.reactive = this._mode !== 'idle';

        for (const {button, minutes} of view.presetButtons) {
            if (minutes * 60 === this._duration)
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
        }
    }

    destroy() {
        // Guardar antes de nada: se llama al bloquear la pantalla.
        this._saveState();

        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
        this._compact?.destroy();
        this._compact = this._compactLabel = null;
        for (const view of this._viewList)
            view.actor.destroy();
        this._viewList = [];
        this._exp = this._card = this._page = null;
    }
});
