// Piezas de interfaz compartidas por los módulos.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Pango from 'gi://Pango';
import St from 'gi://St';

// Barritas quietas: altura relativa (scale_y) en reposo.
const REST_SCALE = 0.35;

/** Etiqueta de una línea que se corta con "…" si no cabe. */
export function makeLabel(styleClass, params = {}) {
    const label = new St.Label({style_class: styleClass, ...params});
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return label;
}

/** Segundos → "m:ss" (o "h:mm:ss"; con padMinutes, "mm:ss"). */
export function formatTime(seconds, {padMinutes = false} = {}) {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    if (h > 0)
        return `${h}:${String(m).padStart(2, '0')}:${ss}`;
    return `${padMinutes ? String(m).padStart(2, '0') : m}:${ss}`;
}

/**
 * Barra de progreso/uso: un fondo con un relleno de ancho proporcional.
 *
 * El relleno se coloca en vfunc_allocate y la barra no pide tamaño según el
 * relleno (su ancho preferido es 0 + CSS; el alto sale del CSS).
 * ⚠️ NO cambiar el tamaño del relleno desde `notify::width`: el relleno
 * cambiaba el tamaño preferido de la barra, que cambiaba su ancho… y en las
 * tarjetas de Home (Sistema → Home) Clutter no salía nunca del bucle de
 * diseño: GNOME Shell entero se congelaba (13-11-2026).
 * ⚠️ Con Clutter.BinLayout + x_align START, GNOME 50 centraba el relleno.
 */
export const Bar = GObject.registerClass(
class Bar extends St.Widget {
    _init(params = {}) {
        super._init({
            style_class: 'agent-notch-usage-trough',
            x_expand: true,
            ...params,
        });
        this._fill = new St.Widget({style_class: 'agent-notch-usage-fill'});
        this.add_child(this._fill);
        this._fraction = 0;
    }

    get fill() {
        return this._fill;
    }

    setFraction(fraction) {
        const value = Math.max(0, Math.min(1, fraction || 0));
        if (value === this._fraction)
            return;
        this._fraction = value;
        this.queue_relayout();
    }

    vfunc_get_preferred_width(_forHeight) {
        return this.get_theme_node().adjust_preferred_width(0, 0);
    }

    vfunc_get_preferred_height(_forWidth) {
        return this.get_theme_node().adjust_preferred_height(0, 0);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const content = this.get_theme_node().get_content_box(box);
        const fillBox = new Clutter.ActorBox({
            x1: content.x1,
            y1: content.y1,
            x2: content.x1 + Math.round((content.x2 - content.x1) * this._fraction),
            y2: content.y2,
        });
        this._fill.allocate(fillBox);
    }
});

/**
 * Carátula como fondo: la imagen ocupa todo el ancho (cuadrada) y se recorta
 * arriba y abajo. El tamaño sale SOLO del CSS (width/height fijos y el
 * icon-size del icono igual al ancho), nunca del hijo: así no hay bucles de
 * diseño (ver Bar).
 */
export const CoverBackdrop = GObject.registerClass(
class CoverBackdrop extends St.Widget {
    _init(params = {}) {
        super._init({clip_to_allocation: true, ...params});
        this._icon = new St.Icon({style_class: 'agent-notch-music-hero-cover'});
        this.add_child(this._icon);
    }

    get icon() {
        return this._icon;
    }

    vfunc_get_preferred_width(_forHeight) {
        return this.get_theme_node().adjust_preferred_width(0, 0);
    }

    vfunc_get_preferred_height(_forWidth) {
        return this.get_theme_node().adjust_preferred_height(0, 0);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const w = box.x2 - box.x1;
        const h = box.y2 - box.y1;
        const top = Math.round((h - w) / 2);
        this._icon.allocate(new Clutter.ActorBox({x1: 0, y1: top, x2: w, y2: top + w}));
    }
});

/**
 * Barra de progreso con una onda FIJA sobre la parte reproducida y un
 * círculo para arrastrar. Solo se redibuja cuando cambia la fracción (una
 * vez por segundo como mucho mientras suena), nunca por fotogramas.
 * Colores en CSS: -agent-notch-wave-color y -agent-notch-wave-track.
 * Emite 'seek' (fracción 0–1) al soltar tras un clic o un arrastre.
 */
export const WaveProgress = GObject.registerClass({
    Signals: {'seek': {param_types: [GObject.TYPE_DOUBLE]}},
}, class WaveProgress extends St.DrawingArea {
    _init(params = {}) {
        super._init({
            style_class: 'agent-notch-wave',
            reactive: true,
            x_expand: true,
            ...params,
        });
        this._fraction = 0;
        this._dragFraction = null;
        this._grab = null;
        this.connect('destroy', () => this._endDrag());
    }

    setFraction(fraction) {
        const value = Math.max(0, Math.min(1, fraction || 0));
        if (value === this._fraction)
            return;
        this._fraction = value;
        if (this._dragFraction === null)
            this.queue_repaint();
    }

    vfunc_style_changed() {
        super.vfunc_style_changed();
        const node = this.get_theme_node();
        this._color = node.get_color('-agent-notch-wave-color');
        this._track = node.get_color('-agent-notch-wave-track');
        this.queue_repaint();
    }

    _knobRadius() {
        return Math.round(7 * St.ThemeContext.get_for_stage(global.stage).scale_factor);
    }

    _fractionAt(event) {
        const [x] = event.get_coords();
        const [ok, localX] = this.transform_stage_point(x, 0);
        if (!ok)
            return this._fraction;
        const r = this._knobRadius();
        const w = this.get_width() - 2 * r;
        return w > 0 ? Math.max(0, Math.min(1, (localX - r) / w)) : 0;
    }

    vfunc_button_press_event(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        this._grab = global.stage.grab(this);
        this._dragFraction = this._fractionAt(event);
        this.queue_repaint();
        return Clutter.EVENT_STOP;
    }

    vfunc_motion_event(event) {
        if (this._dragFraction === null)
            return Clutter.EVENT_PROPAGATE;
        this._dragFraction = this._fractionAt(event);
        this.queue_repaint();
        return Clutter.EVENT_STOP;
    }

    vfunc_button_release_event(event) {
        if (this._dragFraction === null)
            return Clutter.EVENT_STOP;
        const fraction = this._fractionAt(event);
        this._endDrag();
        this._fraction = fraction;
        this.queue_repaint();
        this.emit('seek', fraction);
        return Clutter.EVENT_STOP;
    }

    _endDrag() {
        this._grab?.dismiss();
        this._grab = null;
        this._dragFraction = null;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const r = this._knobRadius();
        const lineWidth = 4 * scale;
        const cy = h - r - scale;                 // la línea va abajo, la onda encima
        const amp = Math.max(0, cy - r * 0.2);    // alto máximo de la onda
        const x0 = r;
        const x1 = w - r;
        const f = this._dragFraction ?? this._fraction;
        const px = x0 + (x1 - x0) * f;
        const color = this._color;
        const track = this._track;
        const rgba = (c, a = 1) => cr.setSourceRGBA(c.red / 255, c.green / 255, c.blue / 255, a * c.alpha / 255);

        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineWidth(lineWidth);

        // Parte que queda.
        if (px < x1) {
            rgba(track);
            cr.moveTo(px, cy);
            cr.lineTo(x1, cy);
            cr.stroke();
        }

        if (px > x0) {
            // Onda fija: una "colina" suave que sube y baja sobre la parte
            // reproducida, con los extremos a ras de la línea.
            const period = 110 * scale;
            const taper = 14 * scale;
            cr.moveTo(x0, cy);
            for (let x = x0; x <= px; x += scale) {
                const t = Math.min(1, (x - x0) / taper, (px - x) / taper);
                const wave = 0.55 + 0.45 * Math.sin((x - x0) / period * 2 * Math.PI - Math.PI / 2);
                cr.lineTo(x, cy - amp * 0.8 * wave * Math.max(0, t));
            }
            cr.lineTo(px, cy);
            cr.closePath();
            rgba(color, 0.4);
            cr.fill();

            rgba(color);
            cr.moveTo(x0, cy);
            cr.lineTo(px, cy);
            cr.stroke();
        }

        // Círculo: relleno del color con aro blanco.
        cr.arc(px, cy, r - 1.5 * scale, 0, 2 * Math.PI);
        rgba(color);
        cr.fillPreserve();
        cr.setSourceRGBA(1, 1, 1, 1);
        cr.setLineWidth(2.5 * scale);
        cr.stroke();

        cr.$dispose();
    }
});

/**
 * Barritas de ecualizador para la vista compacta. Animadas con ease() en
 * bucle SOLO mientras setAnimating(true) y GNOME no tenga "reducir
 * animaciones"; si no, quietas y bajas (sin ningún trabajo por fotograma).
 */
export const EqualizerBars = GObject.registerClass(
class EqualizerBars extends St.BoxLayout {
    _init(params = {}) {
        super._init({
            style_class: 'agent-notch-bars',
            y_align: Clutter.ActorAlign.CENTER,
            ...params,
        });
        // [altura máxima (escala), duración de medio ciclo en ms]
        this._specs = [[1, 430], [0.7, 560], [0.9, 350]];
        this._bars = this._specs.map(() => {
            const bar = new St.Widget({
                style_class: 'agent-notch-bar',
                y_align: Clutter.ActorAlign.END,
                pivot_point: new Graphene.Point({x: 0.5, y: 1}),
                scale_y: REST_SCALE,
            });
            this.add_child(bar);
            return bar;
        });
        this._want = false;
        this._running = false;
        this._settings = St.Settings.get();
        this._settings.connectObject('notify::enable-animations', () => this._sync(), this);
        this.connect('destroy', () => {
            this._settings.disconnectObject(this);
            this._stop();
        });
    }

    setAnimating(animating) {
        this._want = animating;
        this._sync();
    }

    _sync() {
        const run = this._want && this._settings.enable_animations;
        if (run === this._running)
            return;
        if (run)
            this._start();
        else
            this._stop();
    }

    _start() {
        this._running = true;
        this._bars.forEach((bar, i) => {
            const [peak, duration] = this._specs[i];
            bar.scale_y = REST_SCALE;
            bar.ease({
                scale_y: peak,
                duration,
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                repeatCount: -1,
                autoReverse: true,
            });
        });
    }

    _stop() {
        this._running = false;
        for (const bar of this._bars) {
            bar.remove_all_transitions();
            bar.scale_y = REST_SCALE;
        }
    }
});

// Ojos: medidas en "unidades" (1/12 del alto), así valen a cualquier escala.
const EYE_GAP = 9;          // del centro a cada ojo
const EYE_R = 4;            // radio normal
const EYE_R_WIDE = 5.5;     // muy abiertos
const EYE_LOOK = 2;         // desplazamiento al mirar arriba o a la derecha
const EYE_STROKE = 1.8;     // grosor de ^ ^ y × ×
const BLINK_MS = 75;        // cada mitad del parpadeo

/**
 * Ojos con expresión (docs/09, aprobado el 19-11-2026): los de la mascota y
 * los que sustituyen al punto en Agentes. Dos ojos dibujados con Cairo según
 * `expression` (ver EYE_EXPRESSIONS en agentstate.js); el color es el `color`
 * CSS de su clase. Solo se repinta al cambiar de expresión o de estilo, nunca
 * por fotogramas. Al cambiar de expresión parpadea una vez (scale_y con
 * ease(), en la GPU), salvo con «reducir animaciones» o fuera de pantalla.
 */
export const Eyes = GObject.registerClass(
class Eyes extends St.DrawingArea {
    _init(params = {}) {
        super._init({
            style_class: 'agent-notch-face',
            y_align: Clutter.ActorAlign.CENTER,
            pivot_point: new Graphene.Point({x: 0.5, y: 0.5}),
            ...params,
        });
        this._expression = 'abiertos';
        this._blinkGen = 0;
    }

    get expression() {
        return this._expression;
    }

    setExpression(expression, {animate = true} = {}) {
        if (expression === this._expression)
            return;
        this._expression = expression;
        const gen = ++this._blinkGen;
        this.remove_transition('scale-y');
        if (!animate || !this.mapped || !St.Settings.get().enable_animations) {
            this.scale_y = 1;
            this.queue_repaint();
            return;
        }
        // Se cierran, se pinta la forma nueva con el ojo cerrado y se abren.
        this.ease({
            scale_y: 0.1,
            duration: BLINK_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (gen !== this._blinkGen)
                    return;   // lo sustituyó otro cambio
                this.queue_repaint();
                this.ease({
                    scale_y: 1,
                    duration: BLINK_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            },
        });
    }

    vfunc_style_changed() {
        super.vfunc_style_changed();
        this._color = this.get_theme_node().get_foreground_color();
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const c = this._color;
        if (c) {
            const u = h / 12;
            cr.setSourceRGBA(c.red / 255, c.green / 255, c.blue / 255, c.alpha / 255);
            cr.setLineWidth(EYE_STROKE * u);
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.setLineJoin(Cairo.LineJoin.ROUND);
            for (const cx of [w / 2 - EYE_GAP * u, w / 2 + EYE_GAP * u])
                this._paintEye(cr, cx, h / 2, u);
        }
        cr.$dispose();
    }

    _paintEye(cr, cx, cy, u) {
        cr.newPath();
        switch (this._expression) {
        case 'arriba':
            cr.arc(cx, cy - EYE_LOOK * u, EYE_R * u, 0, 2 * Math.PI);
            cr.fill();
            break;
        case 'derecha':
            cr.arc(cx + EYE_LOOK * u, cy, EYE_R * u, 0, 2 * Math.PI);
            cr.fill();
            break;
        case 'muy-abiertos':
            cr.arc(cx, cy, EYE_R_WIDE * u, 0, 2 * Math.PI);
            cr.fill();
            break;
        case 'entornados':   // óvalo aplastado, algo más abajo
            cr.save();
            cr.translate(cx, cy + u);
            cr.scale(1, 0.4);
            cr.arc(0, 0, EYE_R * u, 0, 2 * Math.PI);
            cr.restore();
            cr.fill();
            break;
        case 'contentos':    // ^
            cr.moveTo(cx - 3.5 * u, cy + 1.5 * u);
            cr.lineTo(cx, cy - 2 * u);
            cr.lineTo(cx + 3.5 * u, cy + 1.5 * u);
            cr.stroke();
            break;
        case 'error':        // ×
            cr.moveTo(cx - 3 * u, cy - 3 * u);
            cr.lineTo(cx + 3 * u, cy + 3 * u);
            cr.moveTo(cx + 3 * u, cy - 3 * u);
            cr.lineTo(cx - 3 * u, cy + 3 * u);
            cr.stroke();
            break;
        default:             // abiertos
            cr.arc(cx, cy, EYE_R * u, 0, 2 * Math.PI);
            cr.fill();
        }
    }
});
