#!/usr/bin/env python3
"""Test de velocidad de agent-notch: servicio D-Bus aparte (docs/16-velocidad-internet.md).

Lo arranca el D-Bus de sesión al llamar a Start (activación D-Bus) y se
cierra solo al terminar. Mide contra speed.cloudflare.com: latencia (RTT de
TCP que devuelve Cloudflare), bajada y subida con 4 conexiones en paralelo.

Las conexiones van en hilos; las señales D-Bus se emiten siempre desde el
bucle principal (GLib.idle_add).
"""

import http.client
import re
import statistics
import sys
import threading
import time

import gi

gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib  # noqa: E402

BUS_NAME = 'dev.agentnotch.SpeedTest'
OBJECT_PATH = '/dev/agentnotch/SpeedTest'
INTERFACE = 'dev.agentnotch.SpeedTest'

INTERFACE_XML = f'''
<node>
  <interface name="{INTERFACE}">
    <method name="Start"/>
    <method name="Cancel"/>
    <signal name="Progress">
      <arg name="phase" type="s"/>
      <arg name="value" type="d"/>
    </signal>
    <signal name="Finished">
      <arg name="latency_ms" type="d"/>
      <arg name="download_mbps" type="d"/>
      <arg name="upload_mbps" type="d"/>
    </signal>
    <signal name="Failed">
      <arg name="message" type="s"/>
    </signal>
  </interface>
</node>
'''

HOST = 'speed.cloudflare.com'
HEADERS = {'User-Agent': 'agent-notch-speedtest'}
CONNECT_TIMEOUT_S = 10
CONNECTIONS = 4
CHUNK = 64 * 1024

LATENCY_SAMPLES = 10
DOWNLOAD_REQUEST_BYTES = 25_000_000
DOWNLOAD_MAX_S = 10
DOWNLOAD_MAX_BYTES = 200_000_000
UPLOAD_REQUEST_BYTES = 4 * 1024 * 1024
UPLOAD_MAX_S = 8
UPLOAD_MAX_BYTES = 50_000_000
WARMUP_S = 1.0          # el arranque lento de TCP no cuenta
PROGRESS_EVERY_S = 0.5

IDLE_EXIT_S = 15        # arrancado y nadie llama a Start
HARD_LIMIT_S = 60       # red de seguridad

RTT_RE = re.compile(r'cfL4;[^,]*?\brtt=(\d+)')


def log(msg):
    print(f'[agent-notch] speedtest: {msg}', file=sys.stderr, flush=True)


class Cancelled(Exception):
    pass


class RateLimited(Exception):
    """Cloudflare responde 429 si se repiten muchos tests seguidos."""


def check_status(response):
    if response.status == 429:
        raise RateLimited('rate-limited')
    if response.status != 200:
        raise RuntimeError(f'HTTP {response.status}')


class SpeedTest:
    """La medición completa; corre en un hilo propio."""

    def __init__(self, on_progress, on_finished, on_failed):
        self._on_progress = on_progress
        self._on_finished = on_finished
        self._on_failed = on_failed
        self._stop = threading.Event()

    def start(self):
        threading.Thread(target=self._run, daemon=True).start()

    def cancel(self):
        self._stop.set()

    def _run(self):
        try:
            latency = self._latency()
            down = self._phase('download', self._download_worker,
                               DOWNLOAD_MAX_S, DOWNLOAD_MAX_BYTES)
            up = self._phase('upload', self._upload_worker,
                             UPLOAD_MAX_S, UPLOAD_MAX_BYTES)
            self._on_finished(latency, down, up)
        except Cancelled:
            pass
        except RateLimited:
            log('Cloudflare pide esperar (HTTP 429)')
            self._on_failed('rate-limited')
        except Exception as e:  # noqa: BLE001 - cualquier fallo se avisa
            log(f'fallo: {e!r}')
            self._on_failed(str(e) or e.__class__.__name__)

    def _check(self):
        if self._stop.is_set():
            raise Cancelled()

    # --- Latencia -----------------------------------------------------------

    def _latency(self):
        conn = http.client.HTTPSConnection(HOST, timeout=CONNECT_TIMEOUT_S)
        samples = []
        try:
            for _ in range(LATENCY_SAMPLES):
                self._check()
                t = time.monotonic()
                conn.request('GET', '/__down?bytes=0', headers=HEADERS)
                response = conn.getresponse()
                response.read()
                elapsed_ms = (time.monotonic() - t) * 1000
                check_status(response)
                # RTT de TCP medido por Cloudflare (µs); si no está, el
                # tiempo de la petición.
                m = RTT_RE.search(response.getheader('server-timing') or '')
                samples.append(int(m.group(1)) / 1000 if m else elapsed_ms)
                self._on_progress('latency', statistics.median(samples))
        finally:
            conn.close()
        return statistics.median(samples)

    # --- Bajada y subida ----------------------------------------------------

    def _phase(self, name, worker, max_s, max_bytes):
        self._check()
        counter = {'bytes': 0, 'errors': []}
        lock = threading.Lock()
        phase_stop = threading.Event()

        def add(n):
            with lock:
                counter['bytes'] += n

        def should_stop():
            return phase_stop.is_set() or self._stop.is_set()

        def guarded():
            try:
                worker(add, should_stop)
            except Exception as e:  # noqa: BLE001
                if not should_stop():
                    counter['errors'].append(e)

        threads = [threading.Thread(target=guarded, daemon=True) for _ in range(CONNECTIONS)]
        start = time.monotonic()
        for t in threads:
            t.start()

        mark = None   # (bytes, tiempo) al acabar el calentamiento
        rate = 0.0
        try:
            while True:
                time.sleep(PROGRESS_EVERY_S)
                self._check()
                now = time.monotonic()
                elapsed = now - start
                with lock:
                    total = counter['bytes']
                if mark is None and elapsed >= WARMUP_S:
                    mark = (total, now)
                if mark and now - mark[1] > 0.2:
                    rate = (total - mark[0]) * 8 / (now - mark[1]) / 1e6
                elif elapsed > 0:
                    rate = total * 8 / elapsed / 1e6
                if total > 0:
                    self._on_progress(name, rate)
                if elapsed >= max_s or total >= max_bytes:
                    break
                if not any(t.is_alive() for t in threads):
                    break
        finally:
            phase_stop.set()

        if total == 0:
            errors = counter['errors']
            if any(isinstance(e, RateLimited) for e in errors):
                raise RateLimited('rate-limited')
            raise RuntimeError(f'{name}: {errors[0]!r}' if errors else f'{name}: sin datos')
        return rate

    @staticmethod
    def _download_worker(add, should_stop):
        conn = http.client.HTTPSConnection(HOST, timeout=CONNECT_TIMEOUT_S)
        try:
            while not should_stop():
                conn.request('GET', f'/__down?bytes={DOWNLOAD_REQUEST_BYTES}', headers=HEADERS)
                response = conn.getresponse()
                check_status(response)
                while not should_stop():
                    chunk = response.read(CHUNK)
                    if not chunk:
                        break
                    add(len(chunk))
        finally:
            conn.close()

    @staticmethod
    def _upload_worker(add, should_stop):
        block = bytes(CHUNK)

        def body():
            sent = 0
            while sent < UPLOAD_REQUEST_BYTES:
                if should_stop():
                    return
                n = min(CHUNK, UPLOAD_REQUEST_BYTES - sent)
                yield block[:n]
                sent += n
                add(n)

        conn = http.client.HTTPSConnection(HOST, timeout=CONNECT_TIMEOUT_S)
        headers = {**HEADERS,
                   'Content-Type': 'application/octet-stream',
                   'Content-Length': str(UPLOAD_REQUEST_BYTES)}
        try:
            while not should_stop():
                conn.request('POST', '/__up', body=body(), headers=headers)
                if should_stop():
                    break
                response = conn.getresponse()
                response.read()
                check_status(response)
        finally:
            conn.close()


class Service:
    def __init__(self):
        self._loop = GLib.MainLoop()
        self._conn = None
        self._test = None
        self._watch_id = 0
        self._node = Gio.DBusNodeInfo.new_for_xml(INTERFACE_XML)

    def run(self):
        Gio.bus_own_name(Gio.BusType.SESSION, BUS_NAME, Gio.BusNameOwnerFlags.NONE,
                         self._on_bus_acquired, None, self._on_name_lost)
        GLib.timeout_add_seconds(IDLE_EXIT_S, self._on_idle_timeout)
        GLib.timeout_add_seconds(HARD_LIMIT_S, self._on_hard_limit)
        self._loop.run()

    def _on_bus_acquired(self, conn, _name):
        self._conn = conn
        conn.register_object_with_closures2(OBJECT_PATH, self._node.interfaces[0],
                                            self._on_method_call, None, None)

    def _on_name_lost(self, _conn, _name):
        log('no se pudo tomar el nombre en el bus (¿ya hay otro?)')
        self._quit()

    def _on_method_call(self, conn, sender, _path, _iface, method, _params, invocation):
        if method == 'Start':
            invocation.return_value(None)
            if self._test is None:
                self._watch_id = Gio.bus_watch_name_on_connection(
                    conn, sender, Gio.BusNameWatcherFlags.NONE, None,
                    lambda *_: self._cancel('el cliente ha desaparecido del bus'))
                self._test = SpeedTest(
                    lambda phase, value: self._emit('Progress', '(sd)', (phase, value)),
                    self._on_finished, self._on_failed)
                self._test.start()
        elif method == 'Cancel':
            invocation.return_value(None)
            self._cancel()
        else:
            invocation.return_dbus_error('org.freedesktop.DBus.Error.UnknownMethod', method)

    def _emit(self, signal, signature, values, then_quit=False):
        def emit():
            if self._conn:
                self._conn.emit_signal(None, OBJECT_PATH, INTERFACE, signal,
                                       GLib.Variant(signature, values))
            if then_quit:
                self._quit()
            return GLib.SOURCE_REMOVE
        GLib.idle_add(emit)

    def _on_finished(self, latency, down, up):
        self._emit('Finished', '(ddd)', (latency, down, up), then_quit=True)

    def _on_failed(self, message):
        self._emit('Failed', '(s)', (message,), then_quit=True)

    def _cancel(self, reason=None):
        if reason:
            log(reason)
        if self._test:
            self._test.cancel()
        GLib.idle_add(self._quit)

    def _on_idle_timeout(self):
        if self._test is None:
            self._quit()
        return GLib.SOURCE_REMOVE

    def _on_hard_limit(self):
        log(f'límite de {HARD_LIMIT_S} s alcanzado')
        if self._test:
            self._test.cancel()
            self._on_failed('tiempo agotado')
        else:
            self._quit()
        return GLib.SOURCE_REMOVE

    def _quit(self):
        if self._watch_id:
            Gio.bus_unwatch_name(self._watch_id)
            self._watch_id = 0
        if self._conn:
            try:
                self._conn.flush_sync(None)   # que las señales salgan antes de cerrar
            except GLib.Error:
                pass
        self._loop.quit()
        return GLib.SOURCE_REMOVE


if __name__ == '__main__':
    Service().run()
