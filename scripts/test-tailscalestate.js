// Tests for modules/tailscalestate.js (pure logic of the Tailscale module).
//     gjs -m scripts/test-tailscalestate.js

import System from 'system';

import {
    actionOk, allowLanPrefs, apiUrl, canWrite, errorMessage, exitNodePrefs, firstIPv4, isDenied,
    isRunning, lastSeenText, needsLogin, parsePrefs, parseStatus, peerDetail, runningPrefs,
    shortName, sortPeers, stateText, watchUrl,
} from '../extension/agent-notch@daniel.local/modules/tailscalestate.js';

let failed = 0;
let passed = 0;

function eq(actual, expected, what) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        passed++;
    } else {
        failed++;
        printerr(`FAIL ${what}\n   got:      ${a}\n   expected: ${e}`);
    }
}

// --- URLs ---------------------------------------------------------------------
eq(apiUrl('/status'), 'http://local-tailscaled.sock/localapi/v0/status', 'url');
eq(watchUrl(), 'http://local-tailscaled.sock/localapi/v0/watch-ipn-bus?mask=18', 'bus url');

// --- small helpers ------------------------------------------------------------
eq(firstIPv4(['fd7a::1', '100.1.2.3']), '100.1.2.3', 'ipv4 first');
eq(firstIPv4(['fd7a::1']), 'fd7a::1', 'only ipv6');
eq(firstIPv4([]), '', 'no ips');
eq(shortName('laptop.tail1.ts.net.', 'Laptop'), 'laptop', 'dns label');
eq(shortName('', 'S24+ de Daniel'), 'S24+ de Daniel', 'host name fallback');
eq(shortName(undefined, undefined), '', 'nothing');

// --- /status (shape seen on 21-11-2026, Tailscale 1.104.7) --------------------
const status = JSON.stringify({
    BackendState: 'Running',
    TailscaleIPs: ['100.115.84.120', 'fd7a:115c:a1e0::1'],
    MagicDNSSuffix: 'tail1.ts.net',
    CurrentTailnet: {Name: 'someone@example.com', MagicDNSSuffix: 'tail1.ts.net'},
    Self: {
        ID: 'nSelf', HostName: 'my-pc', DNSName: 'my-pc.tail1.ts.net.', OS: 'linux',
        Online: true, TailscaleIPs: ['100.115.84.120', 'fd7a:115c:a1e0::1'],
    },
    Peer: {
        'nodekey:a': {
            ID: 'nPhone', HostName: 'S24+ de Daniel', DNSName: 's24-de-daniel.tail1.ts.net.',
            OS: 'android', Online: false, ExitNode: false, ExitNodeOption: false,
            TailscaleIPs: ['100.109.245.2'], LastSeen: '2026-11-21T20:00:00Z',
        },
        'nodekey:b': {
            ID: 'nLaptop', HostName: 'laptop', DNSName: 'laptop.tail1.ts.net.', OS: 'linux',
            Online: true, ExitNode: true, ExitNodeOption: true,
            TailscaleIPs: ['fd7a:115c:a1e0::33', '100.117.0.33'], LastSeen: '0001-01-01T00:00:00Z',
        },
        'nodekey:c': {HostName: 'no-id'},
        'nodekey:d': null,
    },
});
const s = parseStatus(status);
eq(s.state, 'Running', 'state');
eq(s.dnsSuffix, 'tail1.ts.net', 'dns suffix');
eq(s.self.name, 'my-pc', 'self name');
eq(s.self.ips[0], '100.115.84.120', 'self ip');
eq(s.peers.map(p => p.id), ['nLaptop', 'nPhone'], 'peers: no-id dropped, online first');
eq(s.peers[0].exitNode, true, 'exit node in use');
eq(s.peers[0].exitNodeOption, true, 'exit node option');
eq(s.peers[0].lastSeen, '', 'never → empty');
eq(s.peers[0].dnsName, 'laptop.tail1.ts.net', 'dns name without the dot');
eq(s.peers[1].name, 's24-de-daniel', 'peer name from dns');
eq(s.peers[1].hostName, 'S24+ de Daniel', 'peer host name');
eq(JSON.stringify(s).includes('example.com'), false, 'the account e-mail is not kept');

const stopped = parseStatus(JSON.stringify({BackendState: 'Stopped', Self: {ID: 'x'}, TailscaleIPs: ['100.9.9.9']}));
eq(stopped.peers, [], 'no peers');
eq(stopped.self.ips, ['100.9.9.9'], 'self ips from the top level');
eq(stopped.dnsSuffix, '', 'no suffix');
eq(parseStatus(JSON.stringify({BackendState: 'NeedsLogin'})).self, null, 'no self');
eq(parseStatus('not json'), null, 'not json');
eq(parseStatus('[]'), null, 'not an object');
eq(parseStatus('{}'), null, 'no BackendState');

// --- /prefs -------------------------------------------------------------------
const prefs = parsePrefs(JSON.stringify({
    WantRunning: true, OperatorUser: 'dtrejo', ExitNodeID: 'nLaptop', ExitNodeAllowLANAccess: false,
}));
eq(prefs, {wantRunning: true, operator: 'dtrejo', exitNodeId: 'nLaptop', allowLan: false}, 'prefs');
eq(parsePrefs(JSON.stringify({OperatorUser: null})), {wantRunning: false, operator: '', exitNodeId: '', allowLan: false}, 'empty prefs');
eq(parsePrefs('x'), null, 'bad prefs');

eq(canWrite(prefs, 'dtrejo'), true, 'operator');
eq(canWrite(prefs, 'other'), false, 'not operator');
eq(canWrite({operator: ''}, ''), false, 'no operator, no user');
eq(canWrite({operator: ''}, 'root'), true, 'root');
eq(canWrite(null, 'dtrejo'), false, 'no prefs');

// --- states ---------------------------------------------------------------------
eq(isRunning('Running'), true, 'running');
eq(isRunning('Stopped'), false, 'stopped');
eq(needsLogin('NeedsLogin'), true, 'needs login');
eq(needsLogin('NeedsMachineAuth'), true, 'needs machine auth');
eq(needsLogin('Running'), false, 'no login needed');
eq(stateText('Running'), 'Connected', 'text running');
eq(stateText('Stopped'), 'Off', 'text stopped');
eq(stateText('Rare'), 'Rare', 'unknown state as is');
eq(stateText(''), 'Unknown', 'empty state');

// --- last seen / detail -------------------------------------------------------
const now = Date.parse('2026-11-21T23:00:00Z');
eq(lastSeenText('2026-11-21T22:59:40Z', now), 'seen just now', 'seconds');
eq(lastSeenText('2026-11-21T22:15:00Z', now), 'seen 45 min ago', 'minutes');
eq(lastSeenText('2026-11-21T20:00:00Z', now), 'seen 3 h ago', 'hours');
eq(lastSeenText('2026-11-20T22:00:00Z', now), 'seen 1 day ago', 'one day');
eq(lastSeenText('2026-11-11T22:00:00Z', now), 'seen 10 days ago', 'days');
eq(lastSeenText('', now), 'offline', 'never seen');
eq(lastSeenText('garbage', now), 'offline', 'bad date');
eq(lastSeenText('2026-11-22T00:00:00Z', now), 'seen just now', 'clock skew');
eq(peerDetail(s.peers[0], now), 'linux · 100.117.0.33', 'online detail');
eq(peerDetail(s.peers[1], now), 'android · seen 3 h ago', 'offline detail');
eq(peerDetail({os: '', online: true, ips: []}, now), '', 'empty detail');

// --- sorting ------------------------------------------------------------------
eq(sortPeers([
    {name: 'b', online: false}, {name: 'c', online: true}, {name: 'a', online: false}, {name: 'a', online: true},
]).map(p => `${p.name}${p.online ? '+' : '-'}`), ['a+', 'c+', 'a-', 'b-'], 'online first, by name');

// --- PATCH bodies ---------------------------------------------------------------
eq(runningPrefs(false), {WantRunning: false, WantRunningSet: true}, 'turn off');
eq(runningPrefs(true), {WantRunning: true, WantRunningSet: true}, 'turn on');
eq(exitNodePrefs('nLaptop'), {ExitNodeID: 'nLaptop', ExitNodeIDSet: true, ExitNodeIP: '', ExitNodeIPSet: true}, 'exit node');
eq(exitNodePrefs(''), {ExitNodeID: '', ExitNodeIDSet: true, ExitNodeIP: '', ExitNodeIPSet: true}, 'no exit node');
eq(allowLanPrefs(true), {ExitNodeAllowLANAccess: true, ExitNodeAllowLANAccessSet: true}, 'allow lan');

// --- answers ------------------------------------------------------------------
eq(actionOk(200), true, '200');
eq(actionOk(403), false, '403');
eq(isDenied(403), true, 'denied');
eq(isDenied(500), false, 'not denied');
eq(errorMessage(403, '{"error":"prefs write access denied"}'), 'prefs write access denied', 'json error');
eq(errorMessage(403, 'Access denied: prefs write access denied\n'), 'Access denied: prefs write access denied', 'plain error');
eq(errorMessage(500, ''), 'Error 500', 'no message');
eq(errorMessage(500, 'x'.repeat(200)), 'Error 500', 'too long');

print(`${passed} tests OK, ${failed} failures`);
if (failed)
    System.exit(1);
