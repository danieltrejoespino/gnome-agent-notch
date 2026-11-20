// The island: the black pill at the top center.
//
// It knows nothing about music, agents or the system:
//   - Compact row: the compact view of the active module with the highest priority.
//     With none active, it stays minimal.
//   - Expanded view (on hover): stacks the sections of ALL the modules that
//     have something to show, by priority.
//   - Banner: a module (Notifications) can ask the island to expand on its
//     own to show something; it takes precedence over everything else.
//   - Panel (click): Home tab + one per module (panel.js). It closes on a
//     click outside, with Esc or when the pointer leaves the island.
//
// Shape (docs/13-rediseno.md): the island draws its own background with Cairo,
// with concave "shoulders" on top, as if it came out of the screen edge.
// CSS cannot do concave corners. Colors and sizes come from the CSS
// (-agent-notch-* properties), like GNOME's volume bar does.
//
// Two stacked layers (Clutter.BinLayout): the drawn background below
// (St.DrawingArea) and the content on top. ⚠️ If the island itself is the
// St.DrawingArea, its content does not show in GNOME 50.
//
// Cost: the timers (hover delays) only exist while the pointer enters or
// leaves; animations use ease() (GPU) and follow GNOME's
// "reduce animations" automatically. The shape is only
// redrawn when the size or the style changes. The expanded sections
// are not created until the first hover.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {NotchPanel} from './panel.js';

const ANIMATION_MS = 200;
// Collapsing from the hover view: slower and in two steps (first the
// content fades out, then the compact view appears) so they do not pile up.
const HOVER_COLLAPSE_MS = 420;
const HOVER_FADE_MS = 180;
const EXPAND_FADE_MS = 120;    // when opening: the compact view leaves quickly
const EXPAND_DELAY_MS = 120;   // avoids expanding when brushing past it
const COLLAPSE_DELAY_MS = 300; // avoids flicker when leaving and coming back

const byPriority = (a, b) => b.priority - a.priority;

export const Island = GObject.registerClass(
class Island extends St.Widget {
    _init() {
        super._init({
            name: 'agentNotchIsland',
            style_class: 'agent-notch-island minimal',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            // Enables the CSS :hover pseudo-class and the `hover` property.
            track_hover: true,
            // Clips the content while the island changes size.
            clip_to_allocation: true,
        });

        this._modules = [];
        this._shownCompact = null;
        this._sections = [];   // [{actor, show(), hide()}] in the expanded view
        this._expanded = false;
        this._hoverExpanded = false;
        this._accent = null;
        this._hoverTimeoutId = 0;
        this._suppressHover = false;   // after 'dismiss', until the pointer leaves
        this._panel = null;    // created on the first click
        this._grab = null;     // modal grab while the panel is open
        this._capturedId = 0;
        this._panelOpen = false;
        this._compactBaseHeight = 0;   // bar height + how far it hangs below
        this._compactTall = false;     // the shown module asks for two lines
        this._separators = [];         // lines between hover sections (reused)
        this._anchorX = null;          // horizontal center (stage coordinates)
        this._anchorY = 0;             // top edge
        this._tallExtra = 0;           // extra px in that case (CSS)

        // Bottom layer: the drawn background, it fills the whole island.
        this._background = new St.DrawingArea({
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._background.connect('repaint', area => this._paintShape(area));
        this.add_child(this._background);

        // Top layer: the content. The compact row and the expanded view
        // OVERLAP (BinLayout), both stuck to the top: when expanding, the
        // compact view fades out and the expanded one starts from the top (no gap).
        this._content = new St.Widget({
            style_class: 'agent-notch-content',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this.add_child(this._content);

        // Compact row: same height as the top bar.
        this._compactBin = new St.Bin({
            style_class: 'agent-notch-compact',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.START,
        });
        this._content.add_child(this._compactBin);

        // Expanded view: module sections, banner or panel.
        this._expandedBox = new St.BoxLayout({
            style_class: 'agent-notch-expanded',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.START,
            visible: false,
        });
        this._content.add_child(this._expandedBox);

        // Click on the island (outside its buttons): open the panel.
        // ⚠️ Only if released INSIDE the island: when the panel is closed with a
        // click outside, the press closes it and the release still reaches the
        // island (it had the modal grab); without this check it reopened
        // right away (14-11-2026).
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

    // --- Shape ---------------------------------------------------------------

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
        // Off stage (when disabling) the theme is not the real one: ignore it.
        if (tallExtra !== this._tallExtra && this.get_stage()) {
            this._tallExtra = tallExtra;
            this._syncCompactHeight(false);
        }
        this._background?.queue_repaint();
    }

    _paintShape(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        if (!this._fillColor) {   // no style yet: nothing to draw
            cr.$dispose();
            return;
        }

        // Make the curves fit even if the island is small.
        const s = Math.max(0, Math.min(this._shoulder, w / 4, h / 2));
        const r = Math.max(0, Math.min(this._radius, (w - 2 * s) / 2, h - s));

        // Outline moved `i` inwards (0 = outer edge).
        // Shoulders: concave arcs centered outside the island, at (0, s) and (w, s).
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

        // Glass fill + subtle highlight that fades downwards.
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

        // Colored glow at the bottom (the banner's app), clipped to the shape.
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

        // Border on shoulders, sides and bottom (not on top: there it "comes out" of the screen).
        if (this._borderWidth > 0) {
            shape(this._borderWidth / 2);
            cr.setSourceColor(this._borderColor);
            cr.setLineWidth(this._borderWidth);
            cr.stroke();
        }

        cr.$dispose();
    }

    /** The island becomes the module's owner and will destroy it along with itself. */
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
     * Where the island goes: centered on x, with its top edge at y. The island
     * centers itself when laid out (vfunc_allocate), whatever its width.
     * It used to be repositioned from outside with `notify::width` → set_position(),
     * that is, in the middle of Clutter's layout, which warned with "needs
     * an allocation" on every compact change (fixed on 19-11-2026).
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

    /** Height of the compact row (the top bar's). */
    setCompactHeight(height) {
        this._compactBaseHeight = height;
        this._syncCompactHeight(false);
    }

    // Tall compact row (two lines, docs/09) if the shown module asks for it.
    // With the island collapsed and on screen, the height change is animated.
    _syncCompactHeight(animate) {
        if (!this._compactBaseHeight)
            return;
        const height = this._compactBaseHeight + (this._compactTall ? this._tallExtra : 0);
        if (this._compactBin.height === height)
            return;
        // Measure only if it will animate (off screen, measuring forces
        // Clutter to lay out an island that is not on the stage).
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
                // Follow the content again (unless it already expanded:
                // then the expand/collapse animation is in charge).
                if (!this._expanded && this.get_stage())
                    this.set_size(-1, -1);
            },
        });
    }

    _update() {
        // Compact row: the active module with the highest priority.
        let best = null;
        for (const module of this._modules) {
            if (module.active && (!best || module.priority > best.priority))
                best = module;
        }

        // Reuse actors: the child only changes if the module changes.
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

    // Tells each module whether its compact view is visible: it is the shown one,
    // the island is not expanded and it is on screen.
    _syncCompactVisible() {
        const visible = !this._expanded && this.mapped;
        for (const module of this._modules) {
            module.setCompactVisible(visible && this._shownCompact !== null &&
                module.compactActor === this._shownCompact);
        }
    }

    // The highest-priority module that asks to show a banner (e.g. a
    // notification), or null.
    _bannerModule() {
        let best = null;
        for (const module of this._modules) {
            if (module.bannerActor && (!best || module.priority > best.priority))
                best = module;
        }
        return best;
    }

    // What to show in the expanded view, in order of preference:
    //   1. a banner (expands the island on its own),
    //   2. the panel, if it is open,
    //   3. with the pointer over it, the sections of all modules.
    // Each entry: {actor, show(), hide()}. Empty list = collapsed island.
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

    // Decides the island's state from the modules and the pointer.
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

    // Puts the sections that apply in the expanded view, in order.
    // Only reorders actors if the list changed (it does not recreate them).
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
            // A subtle line between the hover sections (docs/09).
            if (i > 0 && section.fromHover)
                this._expandedBox.add_child(this._separator(i - 1));
            // An actor can come from another view (e.g. from the panel).
            section.actor.get_parent()?.remove_child(section.actor);
            this._expandedBox.add_child(section.actor);
        });
        for (const section of wanted) {
            if (!shownActors.includes(section.actor))
                section.show();
        }
        this._sections = wanted;
    }

    // Separator no. i: created the first time and reused.
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
        // Changing tabs changes the size: readjust the island.
        this._panel.connect('size-changed', () => {
            if (this._expanded)
                this._animateToNaturalSize();
        });
    }

    // A module asks for its page (e.g. Super+V → Clipboard): open the
    // panel on it, or close it if it was already showing.
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

    // With the panel open, the island grabs pointer and keyboard (like GNOME's
    // menus, see ui/grabHelper.js). Without the grab, clicks on windows and the
    // desktop go straight to the apps and the island never knows. It only lasts
    // while the panel is open.
    // The panel closes with a click outside, Esc or when switching apps; NOT
    // when the pointer leaves (decided on 14-11-2026).
    _grabInput() {
        if (this._grab)
            return;
        this._grab = Main.pushModal(this, {actionMode: Shell.ActionMode.POPUP});
        this._capturedId = this.connect('captured-event', (_actor, event) => {
            const type = event.type();

            // Esc: close. Other keys: switching tabs (panel.handleKey, docs/09).
            if (type === Clutter.EventType.KEY_PRESS) {
                if (event.get_key_symbol() === Clutter.KEY_Escape) {
                    this._closePanel();
                    return Clutter.EVENT_STOP;
                }
                if (this._panel?.handleKey(event))
                    return Clutter.EVENT_STOP;
            }

            const inside = this.contains(global.stage.get_event_actor(event));

            // Click outside: close (and do not pass the click on, like a menu).
            if (!inside && (type === Clutter.EventType.BUTTON_PRESS ||
                            type === Clutter.EventType.TOUCH_BEGIN)) {
                this._closePanel();
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        });

        // App switch (e.g. a notification that opens its app):
        // close. Only listened to while the panel is open.
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

    // Color of the bottom glow (the banner's app), or null.
    _setAccent(color) {
        const same = (a, b) => a === b ||
            (a && b && a.red === b.red && a.green === b.green && a.blue === b.blue);
        if (same(color, this._accent))
            return;
        this._accent = color;
        this._background.queue_repaint();
    }

    // --- Hover ------------------------------------------------------------

    // Minimize: close the panel and the hover view. While the pointer stays
    // over it, it does not expand again (otherwise it would reopen right away).
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

    // --- Expand / collapse ------------------------------------------------

    _expand(wanted) {
        this._expanded = true;

        // Measure BEFORE putting the content in: afterwards, Clutter already gives
        // the expanded size and the animation would have nothing to grow from.
        const [startW, startH] = this._currentSize();

        this._syncSections(wanted);
        this._expandedBox.remove_transition('opacity');
        this._expandedBox.opacity = 0;
        this._expandedBox.show();
        this.add_style_class_name('expanded');
        this._syncCompactVisible();

        // The compact view leaves and the content appears while the island grows
        // (clipped by clip_to_allocation).
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

        // Measure the compact size with the expanded view hidden…
        const [startW, startH] = this._currentSize();
        this._syncCompactVisible();
        this._expandedBox.hide();
        this.remove_style_class_name('expanded');
        const [targetW, targetH] = this._naturalSize();

        // From the hover: slower, the content fades out first and
        // the compact view appears later (otherwise both pile up).
        const fromHover = this._sections.some(s => s.fromHover);
        const duration = fromHover ? HOVER_COLLAPSE_MS : ANIMATION_MS;

        // …and animate to it with the content still visible (clipped).
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
                // Tell the modules (e.g. System stops reading the RAM).
                this._hideSections();
                // Back to natural size (it follows the compact content).
                this.set_size(-1, -1);
            },
        });
    }

    // Size currently on screen: the last allocation. Unlike
    // this.width/height, it does not give the new size if the content just
    // changed (nor does it force a relayout).
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
        // Same size and no animation running: nothing to animate.
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

        // The panel releases the modules' actors before they
        // destroy them.
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
