// Módulo Notificaciones: muestra en la isla, como un banner, las
// notificaciones que GNOME mostraría como aviso emergente.
// Ver docs/13-rediseno.md (etapa D2).
//
// - Escucha `notification-request-banner` de cada fuente: la misma señal que
//   usa GNOME, con sus mismos filtros (No molestar, apps silenciadas,
//   urgencia baja). Las notificaciones siguen apareciendo en el calendario.
// - Mientras está activo, oculta los avisos de GNOME (`bannerBlocked`), que
//   saldrían en el mismo sitio. disable() lo deja como estaba.
// - Al mostrar una notificación hace lo mismo que GNOME: la marca como vista
//   (`acknowledged`) y reproduce su sonido.
//
// Consumo: por eventos. El único temporizador es el que oculta el banner,
// y solo existe mientras hay uno en pantalla. El color de cada app se
// calcula una vez (icono de 16 px) y se guarda.

import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {NotchModule} from './module.js';

const PRIORITY = 100;            // un banner gana a todo
const SHOW_MS = 5000;            // tiempo en pantalla (las críticas: hasta el clic)
const RESUME_AFTER_HOVER_MS = 2000;
const FALLBACK_ICON = 'preferences-system-notifications-symbolic';
const MAX_COLOR_CACHE = 64;

function makeLabel(styleClass, xExpand = false) {
    const label = new St.Label({style_class: styleClass, x_expand: xExpand});
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return label;
}

// Color "de marca" de un icono: el tono dominante. Agrupa los píxeles en
// 12 tonos, dando más peso a los saturados y opacos (ignora blancos, negros
// y transparentes), y devuelve la media del grupo con más peso. Así un
// icono de varios colores (p. ej. Chrome) no da un marrón mezclado.
function averageIconColor(pixbuf) {
    const n = pixbuf.get_n_channels();
    if (n < 3)
        return null;
    const BUCKETS = 12;
    const sums = Array.from({length: BUCKETS}, () => ({r: 0, g: 0, b: 0, w: 0}));
    const hasAlpha = pixbuf.get_has_alpha();
    const stride = pixbuf.get_rowstride();
    const pixels = pixbuf.get_pixels();
    for (let y = 0; y < pixbuf.get_height(); y++) {
        for (let x = 0; x < pixbuf.get_width(); x++) {
            const i = y * stride + x * n;
            const a = hasAlpha ? pixels[i + 3] / 255 : 1;
            const pr = pixels[i], pg = pixels[i + 1], pb = pixels[i + 2];
            const max = Math.max(pr, pg, pb), min = Math.min(pr, pg, pb);
            const delta = max - min;
            if (max === 0 || delta === 0)
                continue;
            const saturation = delta / max;
            const weight = a * saturation * saturation * (max / 255);
            let hue;
            if (max === pr)
                hue = ((pg - pb) / delta + 6) % 6;
            else if (max === pg)
                hue = (pb - pr) / delta + 2;
            else
                hue = (pr - pg) / delta + 4;
            const s = sums[Math.floor(hue / 6 * BUCKETS) % BUCKETS];
            s.r += pr * weight;
            s.g += pg * weight;
            s.b += pb * weight;
            s.w += weight;
        }
    }
    const best = sums.reduce((a, b) => (b.w > a.w ? b : a));
    if (best.w < 0.5)   // icono gris/monocromo: sin color propio
        return null;
    return {
        red: Math.round(best.r / best.w),
        green: Math.round(best.g / best.w),
        blue: Math.round(best.b / best.w),
    };
}

// Color estable a partir de un texto (para apps sin icono de color).
function hashColor(text) {
    const palette = [
        {red: 96, green: 165, blue: 250},   // azul
        {red: 167, green: 139, blue: 250},  // violeta
        {red: 52, green: 211, blue: 153},   // verde
        {red: 251, green: 191, blue: 36},   // ámbar
        {red: 244, green: 114, blue: 182},  // rosa
        {red: 45, green: 212, blue: 191},   // turquesa
    ];
    let hash = 0;
    for (const ch of text)
        hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    return palette[hash % palette.length];
}

export const NotificationsModule = GObject.registerClass(
class NotificationsModule extends NotchModule {
    _init() {
        super._init();

        this._queue = [];
        this._current = null;
        this._accent = null;
        this._timeoutId = 0;
        this._banner = null;        // se crea con la primera notificación
        this._colors = new Map();   // app -> color
        this._iconTheme = null;

        // Ocultar los avisos de GNOME mientras la isla los sustituye.
        // (MessageTray solo tiene setter público: se lee el campo interno.)
        this._previousBannerBlocked = Main.messageTray._bannerBlocked ?? false;
        Main.messageTray.bannerBlocked = true;

        Main.messageTray.connectObject(
            'source-added', (_tray, source) => this._watchSource(source),
            'source-removed', (_tray, source) => source.disconnectObject(this),
            this);
        Main.messageTray.getSources().forEach(source => this._watchSource(source));
    }

    get priority() {
        return PRIORITY;
    }

    get bannerActor() {
        return this._current ? this._banner : null;
    }

    get bannerAccent() {
        return this._current ? this._accent : null;
    }

    _watchSource(source) {
        source.connectObject('notification-request-banner',
            (_source, notification) => this._onRequestBanner(notification), this);
    }

    // Mismos filtros que MessageTray._onNotificationRequestBanner (GNOME 50).
    _onRequestBanner(notification) {
        if (notification.acknowledged)
            return;
        if (notification.urgency === MessageTray.Urgency.LOW)
            return;
        if (!notification.source.policy.showBanners &&
            notification.urgency !== MessageTray.Urgency.CRITICAL)
            return;

        // Se actualizó la que está en pantalla: refrescar y alargar el tiempo.
        if (notification === this._current) {
            this._fill(notification);
            this._startTimer(SHOW_MS);
            this.emit('changed');
            return;
        }

        if (!this._queue.includes(notification)) {
            notification.connectObject('destroy',
                () => this._onNotificationDestroyed(notification), this);
            if (notification.urgency === MessageTray.Urgency.CRITICAL)
                this._queue.unshift(notification);
            else
                this._queue.push(notification);
        }

        if (!this._current)
            this._showNext();
    }

    _showNext() {
        this._clearTimer();
        this._current = this._queue.shift() ?? null;

        if (this._current) {
            const notification = this._current;
            this._buildBanner();
            this._fill(notification);
            // Igual que GNOME al mostrar un aviso.
            notification.acknowledged = true;
            notification.playSound();
            if (notification.urgency !== MessageTray.Urgency.CRITICAL)
                this._startTimer(SHOW_MS);
        }

        this.emit('changed');
    }

    // Termina la notificación en pantalla y pasa a la siguiente.
    _dismissCurrent({activate = false} = {}) {
        const notification = this._current;
        if (!notification)
            return;
        this._current = null;
        notification.disconnectObject(this);

        if (activate)
            notification.activate();
        else if (notification.isTransient)
            notification.destroy(MessageTray.NotificationDestroyedReason.EXPIRED);

        this._showNext();
    }

    _onNotificationDestroyed(notification) {
        notification.disconnectObject(this);
        if (notification === this._current) {
            this._current = null;
            this._showNext();
        } else {
            this._queue = this._queue.filter(n => n !== notification);
        }
    }

    // --- Temporizador -----------------------------------------------------

    _startTimer(ms) {
        this._clearTimer();
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeoutId = 0;
            this._dismissCurrent();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearTimer() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    // Con el ratón encima el banner no se va (como en GNOME).
    _onBannerHover() {
        if (!this._current || this._current.urgency === MessageTray.Urgency.CRITICAL)
            return;
        if (this._banner.hover)
            this._clearTimer();
        else
            this._startTimer(RESUME_AFTER_HOVER_MS);
    }

    // --- Vista ------------------------------------------------------------

    // Icono · Título ··· App
    //         Mensaje
    _buildBanner() {
        if (this._banner)
            return;

        this._banner = new St.Button({
            style_class: 'agent-notch-banner',
            x_expand: true,
            can_focus: true,
            track_hover: true,
        });
        this._banner.connect('clicked', () => this._dismissCurrent({activate: true}));
        this._banner.connect('notify::hover', () => this._onBannerHover());

        const box = new St.BoxLayout({style_class: 'agent-notch-banner-box', x_expand: true});
        this._banner.set_child(box);

        this._bannerIcon = new St.Icon({
            style_class: 'agent-notch-banner-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._bannerIcon);

        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        box.add_child(text);

        const header = new St.BoxLayout({x_expand: true});
        text.add_child(header);
        this._bannerTitle = makeLabel('agent-notch-banner-title', true);
        this._bannerApp = makeLabel('agent-notch-banner-app');
        header.add_child(this._bannerTitle);
        header.add_child(this._bannerApp);

        this._bannerBody = makeLabel('agent-notch-banner-body');
        text.add_child(this._bannerBody);
    }

    _fill(notification) {
        const source = notification.source;
        // Si el icono no existe en el tema (p. ej. una app snap cuyo icono no
        // está instalado), usar el genérico: si no, St muestra uno de "roto".
        let gicon = notification.gicon ?? source?.icon ?? null;
        if (!this._iconExists(gicon))
            gicon = null;
        if (gicon)
            this._bannerIcon.gicon = gicon;
        else
            this._bannerIcon.icon_name = FALLBACK_ICON;

        this._bannerTitle.text = notification.title ?? '';
        this._bannerApp.text = source?.title ?? '';

        const body = (notification.body ?? '').replace(/\s*\n\s*/g, ' ');
        this._bannerBody.visible = body.length > 0;
        if (notification.useBodyMarkup) {
            try {
                this._bannerBody.clutter_text.set_markup(body);
            } catch {
                this._bannerBody.text = body;
            }
        } else {
            this._bannerBody.text = body;
        }

        this._accent = this._colorFor(source?.title ?? '', gicon);
    }

    // --- Color por app ------------------------------------------------------

    _colorFor(appName, gicon) {
        const key = `${appName}|${gicon?.to_string() ?? ''}`;
        let color = this._colors.get(key);
        if (color)
            return color;

        color = this._iconColor(gicon) ?? hashColor(appName || key);
        if (this._colors.size >= MAX_COLOR_CACHE)
            this._colors.clear();
        this._colors.set(key, color);
        return color;
    }

    _iconExists(gicon) {
        if (!gicon)
            return false;
        // Archivos e imágenes en memoria: se dan por buenos.
        if (!(gicon instanceof Gio.ThemedIcon))
            return true;
        try {
            this._iconTheme ??= new St.IconTheme();
            return this._iconTheme.lookup_by_gicon(gicon, 16, 0) !== null;
        } catch {
            return true;
        }
    }

    _iconColor(gicon) {
        if (!gicon)
            return null;
        try {
            let pixbuf = null;
            if (gicon instanceof Gio.FileIcon) {
                const path = gicon.get_file().get_path();
                if (path)
                    pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_size(path, 16, 16);
            } else {
                this._iconTheme ??= new St.IconTheme();
                const info = this._iconTheme.lookup_by_gicon(gicon, 16, 0);
                pixbuf = info?.load_icon() ?? null;
            }
            return pixbuf ? averageIconColor(pixbuf) : null;
        } catch {
            return null;
        }
    }

    destroy() {
        this._clearTimer();
        Main.messageTray.disconnectObject(this);
        for (const source of Main.messageTray.getSources())
            source.disconnectObject(this);
        this._current?.disconnectObject(this);
        for (const notification of this._queue)
            notification.disconnectObject(this);
        this._current = null;
        this._queue = [];

        // Las que quedaron sin mostrar las mostrará GNOME como siempre.
        Main.messageTray.bannerBlocked = this._previousBannerBlocked;

        this._banner?.destroy();
        this._banner = null;
        this._bannerIcon = this._bannerTitle = this._bannerApp = this._bannerBody = null;
        this._colors.clear();
        this._iconTheme = null;
    }
});
