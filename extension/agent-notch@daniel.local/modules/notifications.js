// Notifications module: shows on the island, as a banner, the
// notifications GNOME would show as a popup.
// See docs/13-rediseno.md (stage D2).
//
// - Listens to each source's `notification-request-banner`: the same signal
//   GNOME uses, with the same filters (Do Not Disturb, muted apps,
//   low urgency). Notifications still show up in the calendar.
// - While active, it hides GNOME's popups (`bannerBlocked`), which
//   would show in the same place. disable() leaves it as it was.
// - When showing a notification it does the same as GNOME: marks it as seen
//   (`acknowledged`) and plays its sound.
//
// Cost: event-driven. The only timer is the one that hides the banner,
// and it only exists while one is on screen. Each app's color is
// computed once (16 px icon) and stored.

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

const PRIORITY = 100;            // a banner beats everything
const SHOW_MS = 5000;            // time on screen (critical ones: until clicked)
const RESUME_AFTER_HOVER_MS = 2000;
const FALLBACK_ICON = 'preferences-system-notifications-symbolic';
const MAX_COLOR_CACHE = 64;

function makeLabel(styleClass, xExpand = false) {
    const label = new St.Label({style_class: styleClass, x_expand: xExpand});
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return label;
}

// "Brand" color of an icon: the dominant hue. Groups the pixels into
// 12 hues, giving more weight to saturated and opaque ones (ignores whites, blacks
// and transparent ones), and returns the average of the heaviest group. That way a
// multicolored icon (e.g. Chrome) does not give a muddy brown.
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
    if (best.w < 0.5)   // gray/monochrome icon: no color of its own
        return null;
    return {
        red: Math.round(best.r / best.w),
        green: Math.round(best.g / best.w),
        blue: Math.round(best.b / best.w),
    };
}

// Stable color from a text (for apps without a colored icon).
function hashColor(text) {
    const palette = [
        {red: 96, green: 165, blue: 250},   // azul
        {red: 167, green: 139, blue: 250},  // violeta
        {red: 52, green: 211, blue: 153},   // verde
        {red: 251, green: 191, blue: 36},   // amber
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
        this._banner = null;        // created with the first notification
        this._colors = new Map();   // app -> color
        this._iconTheme = null;

        // Hide GNOME's popups while the island replaces them.
        // (MessageTray only has a public setter: the internal field is read.)
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

    // Same filters as MessageTray._onNotificationRequestBanner (GNOME 50).
    _onRequestBanner(notification) {
        if (notification.acknowledged)
            return;
        if (notification.urgency === MessageTray.Urgency.LOW)
            return;
        if (!notification.source.policy.showBanners &&
            notification.urgency !== MessageTray.Urgency.CRITICAL)
            return;

        // The one on screen was updated: refresh it and extend its time.
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
            // Same as GNOME when showing a popup.
            notification.acknowledged = true;
            notification.playSound();
            if (notification.urgency !== MessageTray.Urgency.CRITICAL)
                this._startTimer(SHOW_MS);
        }

        this.emit('changed');
    }

    // Ends the notification on screen and moves on to the next one.
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

    // --- Timer -----------------------------------------------------

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

    // With the pointer over it the banner does not go away (like in GNOME).
    _onBannerHover() {
        if (!this._current || this._current.urgency === MessageTray.Urgency.CRITICAL)
            return;
        if (this._banner.hover)
            this._clearTimer();
        else
            this._startTimer(RESUME_AFTER_HOVER_MS);
    }

    // --- View ------------------------------------------------------------

    // Icon · Title ··· App
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
        // If the icon does not exist in the theme (e.g. a snap app whose icon is not
        // installed), use the generic one: otherwise St shows a "broken" one.
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

    // --- Color per app ------------------------------------------------------

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
        // Files and in-memory images: taken as valid.
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

        // The ones left unshown will be shown by GNOME as always.
        Main.messageTray.bannerBlocked = this._previousBannerBlocked;

        this._banner?.destroy();
        this._banner = null;
        this._bannerIcon = this._bannerTitle = this._bannerApp = this._bannerBody = null;
        this._colors.clear();
        this._iconTheme = null;
    }
});
