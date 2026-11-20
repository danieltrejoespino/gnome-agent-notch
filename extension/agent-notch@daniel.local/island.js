// La isla: la píldora negra arriba al centro.
//
// No sabe nada de música, agentes ni sistema:
//   - Fila compacta: la vista compacta del módulo activo de mayor prioridad.
//     Sin ninguno activo, queda mínima.
//   - Vista expandida (al pasar el ratón): apila las secciones de TODOS los
//     módulos que tengan algo que mostrar, por prioridad.
//   - Banner: un módulo (Notificaciones) puede pedir que la isla se expanda
//     sola para mostrar algo; tiene preferencia sobre todo lo demás.
//   - Panel (clic): pestañas Home + una por módulo (panel.js). Se cierra al
//     hacer clic fuera, con Esc o al sacar el ratón de la isla.
//
// Forma (docs/13-rediseno.md): la isla dibuja su propio fondo con Cairo,
// con "hombros" cóncavos arriba, como si saliera del borde de la pantalla.
// CSS no puede hacer esquinas cóncavas. Colores y medidas salen del CSS
// (propiedades -agent-notch-*), como hace la barra de volumen de GNOME.
//
// Dos capas apiladas (Clutter.BinLayout): debajo el fondo dibujado
// (St.DrawingArea) y encima el contenido. ⚠️ Si la isla misma es el
// St.DrawingArea, en GNOME 50 su contenido no se ve.
//
// Consumo: los temporizadores (retardos de hover) solo existen mientras
// el ratón entra o sale; las animaciones usan ease() (GPU) y respetan
// "reducir animaciones" de GNOME automáticamente. La forma solo se
// redibuja cuando cambia el tamaño o el estilo. Las secciones expandidas
// no se crean hasta el primer hover.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {NotchPanel} from './panel.js';

const ANIMATION_MS = 200;
// Contraer desde la vista del hover: más lento y en dos tiempos (primero se
// desvanece el contenido, luego aparece el compacto) para que no se amontone.
const HOVER_COLLAPSE_MS = 420;
const HOVER_FADE_MS = 180;
const EXPAND_FADE_MS = 120;    // al abrir: el compacto se va rápido
const EXPAND_DELAY_MS = 120;   // evita expandir al rozarla de pasada
const COLLAPSE_DELAY_MS = 300; // evita parpadeos al salir y volver

const byPriority = (a, b) => b.priority - a.priority;

export const Island = GObject.registerClass(
class Island extends St.Widget {
    _init() {
        super._init({
            name: 'agentNotchIsland',
            style_class: 'agent-notch-island minimal',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            // Activa la pseudo-clase CSS :hover y la propiedad `hover`.
            track_hover: true,
            // Recorta el contenido mientras la isla cambia de tamaño.
            clip_to_allocation: true,
        });

        this._modules = [];
        this._shownCompact = null;
        this._sections = [];   // [{actor, show(), hide()}] en la vista expandida
        this._expanded = false;
        this._hoverExpanded = false;
        this._accent = null;
        this._hoverTimeoutId = 0;
        this._suppressHover = false;   // tras 'dismiss', hasta que el ratón salga
        this._panel = null;    // se crea con el primer clic
        this._grab = null;     // captura modal mientras el panel está abierto
        this._capturedId = 0;
        this._panelOpen = false;
        this._compactBaseHeight = 0;   // alto de la barra + lo que sobresale
        this._compactTall = false;     // el módulo mostrado pide dos líneas
        this._separators = [];         // líneas entre secciones del hover (se reutilizan)
        this._anchorX = null;          // centro horizontal (coordenadas del escenario)
        this._anchorY = 0;             // borde superior
        this._tallExtra = 0;           // px de más en ese caso (CSS)

        // Capa de abajo: el fondo dibujado, ocupa toda la isla.
        this._background = new St.DrawingArea({
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._background.connect('repaint', area => this._paintShape(area));
        this.add_child(this._background);

        // Capa de arriba: el contenido. La fila compacta y la vista expandida
        // van SUPERPUESTAS (BinLayout), las dos pegadas arriba: al expandir, la
        // compacta se desvanece y la expandida empieza desde arriba (sin hueco).
        this._content = new St.Widget({
            style_class: 'agent-notch-content',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this.add_child(this._content);

        // Fila compacta: misma altura que la barra superior.
        this._compactBin = new St.Bin({
            style_class: 'agent-notch-compact',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
        });
        this._content.add_child(this._compactBin);

        // Vista expandida: secciones de los módulos, banner o panel.
        this._expandedBox = new St.BoxLayout({
            style_class: 'agent-notch-expanded',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.START,
            visible: false,
        });
        this._content.add_child(this._expandedBox);

        // Clic en la isla (fuera de sus botones): abrir el panel.
        // ⚠️ Solo si se suelta DENTRO de la isla: al cerrar el panel con un
        // clic fuera, la pulsación cierra y el soltar le llega igualmente a la
        // isla (tenía la captura modal); sin esta comprobación lo reabría
        // al instante (14-11-2026).
        this.connect('button-release-event', (_actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY || this._panelOpen)
                return Clutter.EVENT_PROPAGATE;
            if (!this.contains(global.stage.get_event_actor(event)))
                return Clutter.EVENT_PROPAGATE;
            this._openPanel();
            return Clutter.EVENT_STOP;
        });

        this.connect('notify::hover', () => this._onHoverChanged());
        this.connect('notify::mapped', () => this._syncCompactVisible());
        this.connect('notify::allocation', () => this._background.queue_repaint());
        this.connect('destroy', () => this._onDestroy());
    }

    // --- Forma ---------------------------------------------------------------

    vfunc_style_changed() {
        const node = this.get_theme_node();
        this._fillColor = node.get_color('-agent-notch-fill');
        this._highlightColor = node.get_color('-agent-notch-highlight');
        this._borderColor = node.get_color('-agent-notch-border');
        this._borderWidth = node.get_length('-agent-notch-border-width');
        this._shoulder = node.get_length('-agent-notch-shoulder');
        this._radius = node.get_length('-agent-notch-radius');
        this._glowHeight = node.get_length('-agent-notch-glow-height');
        this._glowAlpha = node.get_double('-agent-notch-glow-opacity');
        const tallExtra = node.get_length('-agent-notch-tall-extra');
        super.vfunc_style_changed();
        // Fuera del escenario (al desactivar) el tema no es el real: ignorarlo.
        if (tallExtra !== this._tallExtra && this.get_stage()) {
            this._tallExtra = tallExtra;
            this._syncCompactHeight(false);
        }
        this._background?.queue_repaint();
    }

    _paintShape(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        if (!this._fillColor) {   // aún sin estilo: nada que dibujar
            cr.$dispose();
            return;
        }

        // Que las curvas quepan aunque la isla sea pequeña.
        const s = Math.max(0, Math.min(this._shoulder, w / 4, h / 2));
        const r = Math.max(0, Math.min(this._radius, (w - 2 * s) / 2, h - s));

        // Contorno desplazado `i` hacia dentro (0 = borde exterior).
        // Hombros: arcos cóncavos centrados fuera de la isla, en (0, s) y (w, s).
        const shape = i => {
            cr.newPath();
            cr.arc(0, s, s + i, -Math.PI / 2, 0);
            cr.lineTo(s + i, h - r);
            cr.arcNegative(s + r, h - r, Math.max(0, r - i), Math.PI, Math.PI / 2);
            cr.lineTo(w - s - r, h - i);
            cr.arcNegative(w - s - r, h - r, Math.max(0, r - i), Math.PI / 2, 0);
            cr.lineTo(w - s - i, s);
            cr.arc(w, s, s + i, Math.PI, 3 * Math.PI / 2);
        };

        // Relleno de vidrio + brillo sutil que se desvanece hacia abajo.
        shape(0);
        cr.closePath();
        cr.setSourceColor(this._fillColor);
        cr.fillPreserve();

        const {red, green, blue, alpha} = this._highlightColor;
        const gradient = new Cairo.LinearGradient(0, 0, 0, h);
        gradient.addColorStopRGBA(0, red / 255, green / 255, blue / 255, alpha / 255);
        gradient.addColorStopRGBA(1, red / 255, green / 255, blue / 255, 0);
        cr.setSource(gradient);
        cr.fill();

        // Brillo de color abajo (la app del banner), recortado a la forma.
        if (this._accent) {
            const {red: ar, green: ag, blue: ab} = this._accent;
            const glowHeight = Math.min(h, this._glowHeight);
            const glow = new Cairo.LinearGradient(0, h - glowHeight, 0, h);
            glow.addColorStopRGBA(0, ar / 255, ag / 255, ab / 255, 0);
            glow.addColorStopRGBA(1, ar / 255, ag / 255, ab / 255, this._glowAlpha);
            cr.save();
            shape(0);
            cr.closePath();
            cr.clip();
            cr.setSource(glow);
            cr.paint();
            cr.restore();
        }

        // Borde en hombros, lados y abajo (arriba no: ahí "sale" de la pantalla).
        if (this._borderWidth > 0) {
            shape(this._borderWidth / 2);
            cr.setSourceColor(this._borderColor);
            cr.setLineWidth(this._borderWidth);
            cr.stroke();
        }

        cr.$dispose();
    }

    /** La isla pasa a ser dueña del módulo y lo destruirá con ella. */
    addModule(module) {
        this._modules.push(module);
        module.connectObject(
            'changed', () => this._update(),
            'dismiss', () => this._dismiss(),
            'show-page', () => this._togglePage(module),
            this);
        this._update();
    }

    /**
     * Dónde va la isla: centrada en x, con el borde de arriba en y. La isla
     * se centra sola al colocarse (vfunc_allocate), sea cual sea su ancho.
     * Antes se recolocaba desde fuera con `notify::width` → set_position(),
     * es decir, en mitad de la colocación de Clutter, que avisaba con «needs
     * an allocation» en cada cambio de la compacta (arreglado el 19-11-2026).
     */
    setAnchor(x, y) {
        if (x === this._anchorX && y === this._anchorY)
            return;
        this._anchorX = x;
        this._anchorY = y;
        this.queue_relayout();
    }

    vfunc_allocate(box) {
        if (this._anchorX !== null)
            box.set_origin(Math.round(this._anchorX - box.get_width() / 2), this._anchorY);
        super.vfunc_allocate(box);
    }

    /** Altura de la fila compacta (la de la barra superior). */
    setCompactHeight(height) {
        this._compactBaseHeight = height;
        this._syncCompactHeight(false);
    }

    // Fila compacta alta (dos líneas, docs/09) si el módulo mostrado la pide.
    // Con la isla contraída y en pantalla, el cambio de alto se anima.
    _syncCompactHeight(animate) {
        if (!this._compactBaseHeight)
            return;
        const height = this._compactBaseHeight + (this._compactTall ? this._tallExtra : 0);
        if (this._compactBin.height === height)
            return;
        // Medir solo si se va a animar (fuera de pantalla, medir obliga a
        // Clutter a colocar una isla que no está en el escenario).
        const animated = animate && !this._expanded && this.mapped;
        const [startW, startH] = animated ? this._currentSize() : [0, 0];
        this._compactBin.set_height(height);
        if (!animated)
            return;
        const [targetW, targetH] = this._naturalSize();
        this.set_size(startW, startH);
        this.ease({
            width: targetW,
            height: targetH,
            duration: ANIMATION_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                // Volver a seguir al contenido (salvo si ya se expandió:
                // entonces manda la animación de expandir/contraer).
                if (!this._expanded && this.get_stage())
                    this.set_size(-1, -1);
            },
        });
    }

    _update() {
        // Fila compacta: el módulo activo de mayor prioridad.
        let best = null;
        for (const module of this._modules) {
            if (module.active && (!best || module.priority > best.priority))
                best = module;
        }

        // Reutilizar actores: solo se cambia el hijo si cambia el módulo.
        const compact = best?.compactActor ?? null;
        if (compact !== this._shownCompact) {
            this._compactBin.set_child(compact);
            this._shownCompact = compact;
        }

        if (compact && !best.minimal)
            this.remove_style_class_name('minimal');
        else
            this.add_style_class_name('minimal');

        const tall = Boolean(compact && best.tallCompact);
        if (tall !== this._compactTall) {
            this._compactTall = tall;
            this._syncCompactHeight(true);
        }

        this._refresh();
        this._syncCompactVisible();
    }

    // Avisa a cada módulo de si su vista compacta se ve: es la mostrada,
    // la isla no está expandida y está en pantalla.
    _syncCompactVisible() {
        const visible = !this._expanded && this.mapped;
        for (const module of this._modules) {
            module.setCompactVisible(visible && this._shownCompact !== null &&
                module.compactActor === this._shownCompact);
        }
    }

    // El módulo de mayor prioridad que pide mostrar un banner (p. ej. una
    // notificación), o null.
    _bannerModule() {
        let best = null;
        for (const module of this._modules) {
            if (module.bannerActor && (!best || module.priority > best.priority))
                best = module;
        }
        return best;
    }

    // Qué mostrar en la vista expandida, por orden de preferencia:
    //   1. un banner (expande la isla sola),
    //   2. el panel, si está abierto,
    //   3. con el ratón encima, las secciones de todos los módulos.
    // Cada entrada: {actor, show(), hide()}. Lista vacía = isla contraída.
    _wantedSections() {
        const banner = this._bannerModule();
        if (banner) {
            return [{actor: banner.bannerActor, show: () => {}, hide: () => {}}];
        }
        if (this._panelOpen) {
            return [{
                actor: this._panel,
                show: () => this._panel.open(),
                hide: () => this._panel.close(),
            }];
        }
        if (!this._hoverExpanded)
            return [];
        return this._modules
            .filter(m => m.hasExpanded)
            .sort(byPriority)
            .map(m => ({
                actor: m.expandedActor,
                fromHover: true,
                show: () => m.setExpandedVisible(true),
                hide: () => m.setExpandedVisible(false),
            }));
    }

    // Decide el estado de la isla a partir de los módulos y del ratón.
    _refresh() {
        const wanted = this._wantedSections();
        this._setAccent(this._bannerModule()?.bannerAccent ?? null);

        if (wanted.length === 0) {
            this._collapse();
        } else if (!this._expanded) {
            this._expand(wanted);
        } else {
            this._syncSections(wanted);
            this._animateToNaturalSize();
        }
    }

    // Pone en la vista expandida las secciones que tocan, en orden.
    // Solo reordena actores si cambió la lista (no los recrea).
    _syncSections(wanted) {
        const same = wanted.length === this._sections.length &&
            wanted.every((s, i) => s.actor === this._sections[i].actor);
        if (same)
            return;

        const wantedActors = wanted.map(s => s.actor);
        const shownActors = this._sections.map(s => s.actor);
        for (const section of this._sections) {
            if (!wantedActors.includes(section.actor))
                section.hide();
        }
        this._expandedBox.remove_all_children();
        wanted.forEach((section, i) => {
            // Una línea sutil entre las secciones del hover (docs/09).
            if (i > 0 && section.fromHover)
                this._expandedBox.add_child(this._separator(i - 1));
            // Un actor puede venir de otra vista (p. ej. del panel).
            section.actor.get_parent()?.remove_child(section.actor);
            this._expandedBox.add_child(section.actor);
        });
        for (const section of wanted) {
            if (!shownActors.includes(section.actor))
                section.show();
        }
        this._sections = wanted;
    }

    // Separador n.º i: se crea la primera vez y se reutiliza.
    _separator(i) {
        this._separators[i] ??= new St.Widget({
            style_class: 'agent-notch-section-separator',
            x_expand: true,
        });
        return this._separators[i];
    }

    _hideSections() {
        for (const section of this._sections)
            section.hide();
        this._expandedBox.remove_all_children();
        this._sections = [];
    }

    // --- Panel ----------------------------------------------------------------

    _ensurePanel() {
        if (this._panel)
            return;
        this._panel = new NotchPanel(this._modules);
        // Cambiar de pestaña cambia el tamaño: reajustar la isla.
        this._panel.connect('size-changed', () => {
            if (this._expanded)
                this._animateToNaturalSize();
        });
    }

    // Un módulo pide su página (p. ej. Super+V → Portapapeles): abrir el
    // panel en ella, o cerrarlo si ya se estaba viendo.
    _togglePage(module) {
        if (this._panelOpen && this._panel.currentKey === module) {
            this._closePanel();
            return;
        }
        this._ensurePanel();
        this._panel.selectPage(module);
        if (!this._panelOpen)
            this._openPanel();
    }

    _openPanel() {
        this._ensurePanel();
        this._panelOpen = true;
        this._grabInput();
        this._refresh();
    }

    _closePanel() {
        if (!this._panelOpen)
            return;
        this._panelOpen = false;
        this._releaseInput();
        this._refresh();
    }

    // Con el panel abierto, la isla captura ratón y teclado (como los menús de
    // GNOME, ver ui/grabHelper.js). Sin la captura, los clics sobre ventanas y
    // escritorio van directos a las apps y la isla no se entera. Solo dura lo
    // que el panel esté abierto.
    // El panel se cierra con clic fuera, Esc o al cambiar de aplicación; NO
    // al sacar el ratón (decidido el 14-11-2026).
    _grabInput() {
        if (this._grab)
            return;
        this._grab = Main.pushModal(this, {actionMode: Shell.ActionMode.POPUP});
        this._capturedId = this.connect('captured-event', (_actor, event) => {
            const type = event.type();

            // Esc: cerrar.
            if (type === Clutter.EventType.KEY_PRESS &&
                event.get_key_symbol() === Clutter.KEY_Escape) {
                this._closePanel();
                return Clutter.EVENT_STOP;
            }

            const inside = this.contains(global.stage.get_event_actor(event));

            // Clic fuera: cerrar (y no pasar el clic, como un menú).
            if (!inside && (type === Clutter.EventType.BUTTON_PRESS ||
                            type === Clutter.EventType.TOUCH_BEGIN)) {
                this._closePanel();
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        });

        // Cambio de aplicación (p. ej. una notificación que abre su app):
        // cerrar. Solo se escucha con el panel abierto.
        global.display.connectObject('notify::focus-window',
            () => this._closePanel(), this);
    }

    _releaseInput() {
        global.display.disconnectObject(this);
        if (this._capturedId) {
            this.disconnect(this._capturedId);
            this._capturedId = 0;
        }
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
    }

    // Color del brillo inferior (el de la app del banner), o null.
    _setAccent(color) {
        const same = (a, b) => a === b ||
            (a && b && a.red === b.red && a.green === b.green && a.blue === b.blue);
        if (same(color, this._accent))
            return;
        this._accent = color;
        this._background.queue_repaint();
    }

    // --- Hover ------------------------------------------------------------

    // Minimizar: cerrar el panel y la vista del hover. Mientras el ratón siga
    // encima no se vuelve a expandir (si no, se reabriría al instante).
    _dismiss() {
        this._clearHoverTimeout();
        this._suppressHover = this.hover;
        this._hoverExpanded = false;
        if (this._panelOpen) {
            this._panelOpen = false;
            this._releaseInput();
        }
        this._refresh();
    }

    _onHoverChanged() {
        this._clearHoverTimeout();
        if (!this.hover)
            this._suppressHover = false;
        if (this._suppressHover)
            return;
        const wantExpanded = this.hover;
        if (wantExpanded === this._hoverExpanded)
            return;

        const delay = wantExpanded ? EXPAND_DELAY_MS : COLLAPSE_DELAY_MS;
        this._hoverTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._hoverTimeoutId = 0;
            this._hoverExpanded = wantExpanded;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearHoverTimeout() {
        if (this._hoverTimeoutId) {
            GLib.source_remove(this._hoverTimeoutId);
            this._hoverTimeoutId = 0;
        }
    }

    // --- Expandir / contraer ------------------------------------------------

    _expand(wanted) {
        this._expanded = true;

        // Medir ANTES de meter el contenido: después, Clutter da ya el tamaño
        // expandido y la animación no tendría desde dónde crecer.
        const [startW, startH] = this._currentSize();

        this._syncSections(wanted);
        this._expandedBox.remove_transition('opacity');
        this._expandedBox.opacity = 0;
        this._expandedBox.show();
        this.add_style_class_name('expanded');
        this._syncCompactVisible();

        // El compacto se va y el contenido aparece mientras la isla crece
        // (recortado por clip_to_allocation).
        this._compactBin.ease({
            opacity: 0,
            duration: EXPAND_FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._expandedBox.ease({
            opacity: 255,
            delay: EXPAND_FADE_MS / 2,
            duration: ANIMATION_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._animateToNaturalSize(startW, startH);
    }

    _collapse() {
        if (!this._expanded)
            return;
        this._expanded = false;

        // Medir el tamaño compacto con la vista expandida oculta…
        const [startW, startH] = this._currentSize();
        this._syncCompactVisible();
        this._expandedBox.hide();
        this.remove_style_class_name('expanded');
        const [targetW, targetH] = this._naturalSize();

        // Desde el hover: más despacio, el contenido se desvanece primero y
        // el compacto aparece después (si no, se ven los dos amontonados).
        const fromHover = this._sections.some(s => s.fromHover);
        const duration = fromHover ? HOVER_COLLAPSE_MS : ANIMATION_MS;

        // …y animar hasta él con el contenido aún visible (recortado).
        this._expandedBox.show();
        this.set_size(startW, startH);
        if (fromHover) {
            this._expandedBox.ease({
                opacity: 0,
                duration: HOVER_FADE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
        this._compactBin.ease({
            opacity: 255,
            delay: fromHover ? HOVER_FADE_MS : 0,
            duration: fromHover ? duration - HOVER_FADE_MS : ANIMATION_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this.ease({
            width: targetW,
            height: targetH,
            duration,
            mode: fromHover
                ? Clutter.AnimationMode.EASE_IN_OUT_CUBIC
                : Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                if (this._expanded)
                    return;
                this._expandedBox.hide();
                this._expandedBox.opacity = 255;
                // Avisar a los módulos (p. ej. Sistema deja de leer la RAM).
                this._hideSections();
                // Volver a tamaño natural (sigue al contenido compacto).
                this.set_size(-1, -1);
            },
        });
    }

    // Tamaño que se ve ahora en pantalla: la última asignación. A diferencia
    // de this.width/height, no da el tamaño nuevo si el contenido acaba de
    // cambiar (ni fuerza a recolocar).
    _currentSize() {
        const box = this.allocation;
        const [w, h] = [box.get_width(), box.get_height()];
        return w > 0 && h > 0 ? [w, h] : [this.width, this.height];
    }

    _animateToNaturalSize(startW, startH) {
        if (startW === undefined)
            [startW, startH] = this._currentSize();
        const [targetW, targetH] = this._naturalSize();
        this.set_size(startW, startH);
        // Mismo tamaño y sin animación en curso: no hay nada que animar.
        const animating = this.get_transition('width') || this.get_transition('height');
        if (!animating && Math.abs(targetW - startW) < 1 && Math.abs(targetH - startH) < 1)
            return;
        this.ease({
            width: targetW,
            height: targetH,
            duration: ANIMATION_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _naturalSize() {
        this.set_size(-1, -1);
        const [, width] = this.get_preferred_width(-1);
        const [, height] = this.get_preferred_height(width);
        return [width, height];
    }

    _onDestroy() {
        this._clearHoverTimeout();
        this.remove_all_transitions();
        this._releaseInput();

        // El panel suelta los actores de los módulos antes de que ellos
        // los destruyan.
        this._panelOpen = false;
        this._hideSections();
        this._panel?.destroy();
        this._panel = null;

        this._compactBin.set_child(null);
        this._shownCompact = null;
        for (const separator of this._separators)
            separator.destroy();
        this._separators = [];

        for (const module of this._modules) {
            module.disconnectObject(this);
            module.destroy();
        }
        this._modules = [];
    }
});
