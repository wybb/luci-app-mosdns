"""Real engine regression using loopback only; set MOSDNS_BIN to a built engine."""
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import tempfile
import time
import unittest


def query(port):
    name = b'\x06reload\x04test\x00'
    wire = struct.pack('!6H', 173, 0x100, 1, 0, 0, 0) + name + struct.pack('!2H', 1, 1)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(.2)
        sock.sendto(wire, ('127.0.0.1', port))
        reply = sock.recv(4096)
    _, flags, qd, an, _, _ = struct.unpack_from('!6H', reply)
    if flags & 15:
        return None
    def skip_name(offset):
        while reply[offset]:
            if reply[offset] & 0xc0 == 0xc0:
                return offset + 2
            offset += 1 + reply[offset]
        return offset + 1
    offset = 12
    for _ in range(qd):
        offset = skip_name(offset) + 4
    for _ in range(an):
        offset = skip_name(offset)
        kind, _, _, size = struct.unpack_from('!HHIH', reply, offset)
        offset += 10
        if kind == 1 and size == 4:
            return socket.inet_ntoa(reply[offset:offset + 4])
        offset += size
    return None


class LiveHotReload(unittest.TestCase):
    def test_cached_hosts_reload_and_malformed_file_retention(self):
        binary = os.environ.get('MOSDNS_BIN') or os.environ.get('MOSDNS_BINARY')
        if not binary:
            self.skipTest('Set MOSDNS_BIN to run loopback-only engine integration')
        with tempfile.TemporaryDirectory(prefix='mosdns-live-reload-') as directory:
            root = Path(directory)
            hosts = root / 'hosts.txt'
            hosts.write_text('reload.test 192.0.2.1\n')
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
                probe.bind(('127.0.0.1', 0))
                port = probe.getsockname()[1]
            config = {'log': {'level': 'error'}, 'plugins': [
                {'tag': 'c', 'type': 'cache', 'args': {'size': 1024, 'lazy_cache_ttl': 86400}},
                {'tag': 'h', 'type': 'hosts', 'args': {'files': [str(hosts)]}},
                {'tag': 'main', 'type': 'sequence', 'args': [
                    {'exec': '$c'}, {'matches': 'has_resp', 'exec': 'accept'},
                    {'exec': '$h'}, {'matches': 'has_resp', 'exec': 'accept'}, {'exec': 'reject 3'}]},
                {'tag': 'udp', 'type': 'udp_server', 'args': {'entry': 'main', 'listen': f'127.0.0.1:{port}'}}
            ]}
            (root / 'config.json').write_text(json.dumps(config))
            with (root / 'engine.log').open('w') as log:
                ready = root / 'ready.pid'
                proc = subprocess.Popen([binary, 'start', '-c', str(root / 'config.json'), '-d', directory], stdout=log, stderr=log, env={**os.environ, 'MOSDNS_READY_FILE': str(ready)})
                try:
                    def expect(address, timeout=8):
                        deadline = time.monotonic() + timeout
                        last = None
                        while time.monotonic() < deadline:
                            if proc.poll() is not None:
                                self.fail('Engine exited: ' + (root / 'engine.log').read_text())
                            try:
                                last = query(port)
                                if last == address:
                                    return
                            except (OSError, ValueError):
                                pass
                            time.sleep(.1)
                        self.fail(f'Expected {address}, got {last}; ' + (root / 'engine.log').read_text())
                    expect('192.0.2.1')
                    self.assertEqual(ready.read_text(), str(proc.pid) + '\n')
                    self.assertEqual(query(port), '192.0.2.1')  # prime cache
                    hosts.write_text('reload.test 192.0.2.2\n')
                    expect('192.0.2.2')  # old cache entry would otherwise live for minutes
                    hosts.write_text('reload.test invalid-ip\n')
                    time.sleep(3.5)  # one full watcher interval after malformed edit
                    self.assertEqual(query(port), '192.0.2.2')
                    hosts.write_text('reload.test 192.0.2.3\n')
                    expect('192.0.2.3')
                finally:
                    proc.terminate()
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait()
                self.assertFalse(ready.exists(), 'owned readiness marker survived shutdown')


if __name__ == '__main__':
    unittest.main()
