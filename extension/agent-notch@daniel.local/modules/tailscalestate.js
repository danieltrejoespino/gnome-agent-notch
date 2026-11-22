// Pure logic of the Tailscale module (docs/21-modulo-tailscale.md): interpret
// the answers of tailscaled's local API and build the preference changes.
// Without GNOME Shell, so it can be tested with
//     gjs -m scripts/test-tailscalestate.js

export const SOCKET = '/var/run/tailscale/tailscaled.sock';

// watch-ipn-bus: NotifyInitialState (2) + NotifyNoPrivateKeys (16)
// (✅ 21-11-2026, Tailscale 1.104.7).
export const WATCH_MASK = 2 | 16;

// What to run once so the island can change Tailscale's settings.
export const OPERATOR_HINT = 'sudo tailscale set --operator=$USER';

const NEVER = '0001-01-01T00:00:00Z';

/** Local API URL for a path ("/status"). */
export function apiUrl(path) {
    return `http://local-tailscaled.sock/localapi/v0${path}`;
}

/** URL of the notification bus. */
export function watchUrl() {
    return apiUrl(`/watch-ipn-bus?mask=${WATCH_MASK}`);
}

const str = v => typeof v === 'string' ? v : '';
const strList = v => Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : [];

/** First IPv4 of a list of addresses, or the first one, or ''. */
export function firstIPv4(ips) {
    return ips.find(ip => !ip.includes(':')) ?? ips[0] ?? '';
}

/** 'laptop.tail1234.ts.net.' → 'laptop'; without a DNS name, the host name. */
export function shortName(dnsName, hostName = '') {
    const first = str(dnsName).split('.')[0];
    return first || str(hostName);
}

function parseNode(n) {
    return {
        id: str(n.ID),
        name: shortName(n.DNSName, n.HostName),
        hostName: str(n.HostName),
        dnsName: str(n.DNSName).replace(/\.$/, ''),
        os: str(n.OS),
        online: n.Online === true,
        ips: strList(n.TailscaleIPs),
        exitNode: n.ExitNode === true,
        exitNodeOption: n.ExitNodeOption === true,
        lastSeen: str(n.LastSeen) === NEVER ? '' : str(n.LastSeen),
    };
}

/**
 * Answer of GET /status (text) → {state, self, dnsSuffix, peers} or null.
 * Peers without an ID are dropped.
 */
export function parseStatus(text) {
    let raw;
    try {
        raw = JSON.parse(text);
    } catch {
        return null;
    }
    if (!raw || typeof raw !== 'object' || typeof raw.BackendState !== 'string')
        return null;

    const peers = [];
    if (raw.Peer && typeof raw.Peer === 'object') {
        for (const p of Object.values(raw.Peer)) {
            if (p && typeof p === 'object' && str(p.ID))
                peers.push(parseNode(p));
        }
    }
    const self = raw.Self && typeof raw.Self === 'object' ? parseNode(raw.Self) : null;
    if (self && self.ips.length === 0)
        self.ips = strList(raw.TailscaleIPs);
    return {
        state: raw.BackendState,
        self,
        dnsSuffix: str(raw.MagicDNSSuffix) || str(raw.CurrentTailnet?.MagicDNSSuffix),
        peers: sortPeers(peers),
    };
}

/** Answer of GET /prefs (text) → {wantRunning, operator, exitNodeId, allowLan} or null. */
export function parsePrefs(text) {
    let raw;
    try {
        raw = JSON.parse(text);
    } catch {
        return null;
    }
    if (!raw || typeof raw !== 'object')
        return null;
    return {
        wantRunning: raw.WantRunning === true,
        operator: str(raw.OperatorUser),
        exitNodeId: str(raw.ExitNodeID),
        allowLan: raw.ExitNodeAllowLANAccess === true,
    };
}

/** true if `user` can change the preferences (root or the operator). */
export function canWrite(prefs, user) {
    return user === 'root' || (!!prefs?.operator && prefs.operator === user);
}

/** Online first, then by name. */
export function sortPeers(peers) {
    return [...peers].sort((a, b) => {
        if (a.online !== b.online)
            return a.online ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
}

/** true while the backend is connected. */
export function isRunning(state) {
    return state === 'Running';
}

/** true if signing in is needed before it can connect. */
export function needsLogin(state) {
    return state === 'NeedsLogin' || state === 'NeedsMachineAuth';
}

/** Header text for the backend state. */
export function stateText(state) {
    switch (state) {
    case 'Running': return 'Connected';
    case 'Starting': return 'Connecting…';
    case 'Stopped': return 'Off';
    case 'NeedsLogin': return 'Sign-in needed';
    case 'NeedsMachineAuth': return 'Waiting for approval';
    case 'NoState': return 'Starting…';
    default: return state || 'Unknown';
    }
}

/** '2026-11-21T21:18:45Z' → 'seen 3 h ago' (nowMs = Date.now()). */
export function lastSeenText(iso, nowMs) {
    const t = Date.parse(iso);
    if (!iso || Number.isNaN(t))
        return 'offline';
    const min = Math.floor(Math.max(0, nowMs - t) / 60000);
    if (min < 1)
        return 'seen just now';
    if (min < 60)
        return `seen ${min} min ago`;
    const h = Math.floor(min / 60);
    if (h < 24)
        return `seen ${h} h ago`;
    const d = Math.floor(h / 24);
    return `seen ${d} day${d === 1 ? '' : 's'} ago`;
}

/** Second line of a device row: 'linux · 100.1.2.3' or 'android · seen 2 h ago'. */
export function peerDetail(peer, nowMs) {
    const where = peer.online ? firstIPv4(peer.ips) : lastSeenText(peer.lastSeen, nowMs);
    return [peer.os, where].filter(Boolean).join(' · ');
}

// --- Preference changes (PATCH /prefs bodies) ------------------------------------

/** Turn on (`tailscale up`) or off (`tailscale down`), without signing out. */
export function runningPrefs(on) {
    return {WantRunning: on, WantRunningSet: true};
}

/** Use a peer as exit node ('' = none). The IP form is cleared too. */
export function exitNodePrefs(id) {
    return {ExitNodeID: id, ExitNodeIDSet: true, ExitNodeIP: '', ExitNodeIPSet: true};
}

/** Allow reaching the local network while an exit node is in use. */
export function allowLanPrefs(on) {
    return {ExitNodeAllowLANAccess: on, ExitNodeAllowLANAccessSet: true};
}

/** true if the answer to a PATCH is a success. */
export function actionOk(status) {
    return status >= 200 && status < 300;
}

/** true if the answer means "not allowed" (no operator). */
export function isDenied(status) {
    return status === 403 || status === 401;
}

/** Error text of the local API ({"error": "…"} or plain text) or a generic one. */
export function errorMessage(status, text) {
    try {
        const msg = JSON.parse(text)?.error;
        if (typeof msg === 'string' && msg)
            return msg;
    } catch {
        // It was not JSON.
    }
    const plain = str(text).trim().split('\n')[0];
    return plain && plain.length <= 120 ? plain : `Error ${status}`;
}
