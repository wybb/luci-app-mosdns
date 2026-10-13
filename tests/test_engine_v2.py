#!/usr/bin/env python3
"""Isolated live DNS tests: generated config, loopback fake upstream, no Internet."""
import contextlib
import ipaddress
import json
import os
import re
from pathlib import Path
import socket
import struct
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.request

from test_v2 import HERE, invoke, parse_uci, sections

ENGINE = os.environ.get('MOSDNS_BIN')


def encode_name(name):
    return b''.join(bytes([len(label)]) + label.encode('ascii') for label in name.rstrip('.').split('.')) + b'\x00'


def decode_name(packet, offset):
    labels, end, seen = [], None, set()
    while True:
        if offset in seen:
            raise ValueError('DNS pointer loop')
        seen.add(offset)
        count = packet[offset]
        if count & 0xC0 == 0xC0:
            if end is None:
                end = offset + 2
            offset = ((count & 0x3F) << 8) | packet[offset + 1]
            continue
        offset += 1
        if not count:
            return '.'.join(labels) + '.', end or offset
        labels.append(packet[offset:offset + count].decode('ascii'))
        offset += count


def question(packet):
    name, end = decode_name(packet, 12)
    kind, cls = struct.unpack_from('!HH', packet, end)
    return name, kind, cls, end + 4


def query(port, name, kind=1):
    packet = os.urandom(2) + struct.pack('!HHHHH', 0x0100, 1, 0, 0, 0) + encode_name(name) + struct.pack('!HH', kind, 1)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(3)
        sock.sendto(packet, ('127.0.0.1', port))
        response = sock.recv(65535)
    if response[:2] != packet[:2]:
        raise ValueError('Unexpected DNS transaction')
    _, flags, _, answers, _, _ = struct.unpack_from('!HHHHHH', response)
    response_name, _, _, offset = question(response)
    records = []
    for _ in range(answers):
        owner, offset = decode_name(response, offset)
        record_type, cls, ttl, size = struct.unpack_from('!HHIH', response, offset)
        offset += 10
        value = response[offset:offset + size]
        if record_type in (1, 28):
            value = str(ipaddress.ip_address(value))
        elif record_type == 5:
            value = decode_name(response, offset)[0]
        records.append((record_type, value, ttl, owner))
        offset += size
    return {'rcode': flags & 15, 'question': response_name, 'records': records}


class Upstream:
    def __init__(self, first_response_delay=0):
        self.first_response_delay = first_response_delay

    def transactions(self, name=None, kind=None):
        # UDP retransmits reuse the same connection and assigned query ID.
        # Distinct logical exchanges increment that ID (or use a new peer).
        return {(d['name'], d['kind'], d['peer'], d['qid']) for d in self.datagrams
                if (name is None or d['name'] == name) and (kind is None or d['kind'] == kind)}

    def __enter__(self):
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.socket.bind(('127.0.0.1', 0))
        self.socket.settimeout(0.1)
        self.port = self.socket.getsockname()[1]
        self.requests = []
        self.datagrams = []
        self.running = True
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()
        return self

    def run(self):
        while self.running:
            try:
                packet, peer = self.socket.recvfrom(65535)
            except socket.timeout:
                continue
            except OSError:
                break
            name, kind, cls, end = question(packet)
            self.requests.append((name, kind))
            self.datagrams.append({'name': name, 'kind': kind, 'qid': struct.unpack_from('!H', packet)[0],
                                   'peer': peer, 'timestamp': time.monotonic()})
            if len(self.datagrams) == 1 and self.first_response_delay:
                time.sleep(self.first_response_delay)
            answer = b''
            if kind in (1, 28):
                value = ipaddress.ip_address('198.18.0.10' if kind == 1 else '2001:db8::10').packed
                answer = b'\xc0\x0c' + struct.pack('!HHIH', kind, cls, 120, len(value)) + value
            response = packet[:2] + struct.pack('!HHHHH', 0x8180, 1, bool(answer), 0, 0) + packet[12:end] + answer
            self.socket.sendto(response, peer)

    def __exit__(self, *exc):
        self.running = False
        self.socket.close()
        self.thread.join(timeout=1)


def cache_counters(config):
    with urllib.request.urlopen('http://' + config['api']['http'] + '/metrics', timeout=3) as response:
        text = response.read().decode()
    result = {}
    for counter in ('query_total', 'hit_total'):
        pattern = r'^mosdns_cache_' + counter + r'\{[^\n]*tag="lazy_cache"[^\n]*\} ([0-9.eE+-]+)$'
        match = re.search(pattern, text, re.MULTILINE)
        if not match:
            raise AssertionError('Missing cache metric ' + counter + ': ' + text)
        result[counter] = float(match.group(1))
    return result


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


@contextlib.contextmanager
def running_engine(data, directory, empty_rule_files=False):
    if not ENGINE:
        raise unittest.SkipTest('Set MOSDNS_BIN to run real-engine tests')
    port, api = free_port(), free_port()
    data[0].update(listen_address='127.0.0.1', listen_port=str(port), listen_port_api=str(api), log_size='1M')
    config = invoke('generate', data, ['127.0.0.1'])
    # The production generator restricts logs to router log roots. Relocate only
    # this generated test artifact so a host test never writes router paths.
    config['log']['file'] = str(directory / 'mosdns.log')
    if empty_rule_files:
        # Replay historical config structure without touching router paths.
        for plugin in config['plugins']:
            args = plugin.get('args')
            if isinstance(args, dict) and 'files' in args:
                args['files'] = [file_rule(directory, plugin['tag'] + '-' + str(i) + '.txt', '') for i in range(len(args['files']))]
    path = directory / 'config.json'
    path.write_text(json.dumps(config))
    with (directory / 'process.log').open('w+') as logs:
        process = subprocess.Popen([ENGINE, 'start', '-c', str(path), '-d', str(directory)], stdout=logs, stderr=logs)
        try:
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    logs.seek(0)
                    raise AssertionError('Engine failed to start: ' + logs.read())
                try:
                    with urllib.request.urlopen('http://127.0.0.1:' + str(api) + '/ready', timeout=0.2) as response:
                        if response.read() == b'ready\n':
                            break
                except OSError:
                    time.sleep(0.05)
            else:
                raise AssertionError('Engine listener did not become ready')
            yield port, config
        finally:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def file_rule(directory, name, content):
    path = directory / name
    path.write_text(content)
    return str(path)


def with_upstream(upstream):
    data = sections()
    data[0]['lazy_cache_ttl'] = '0'
    data[1]['dns'] = ['udp://127.0.0.1:' + str(upstream.port)]
    data[1]['concurrent'] = '1'
    return data


class EngineV2Tests(unittest.TestCase):
    def test_historical_configs_start_with_real_engine(self):
        for name, migration in [('test_v2_old_fork.conf', False), ('test_v2_upstream.conf', True)]:
            with self.subTest(fixture=name), tempfile.TemporaryDirectory() as temp, Upstream() as upstream:
                data = parse_uci((HERE / name).read_text())
                if migration:
                    data = invoke('migrate', data)['sections']
                for section in data:
                    if section['.type'] == 'dns_group':
                        section.update(dns=['udp://127.0.0.1:' + str(upstream.port)], use_default_dns='0')
                with running_engine(data, Path(temp), empty_rule_files=True) as (port, _):
                    response = query(port, 'historical-fixture.test')
                    self.assertEqual(response['rcode'], 0)
                    self.assertIn('198.18.0.10', [r[1] for r in response['records'] if r[0] == 1])

    def test_redirect_keeps_downstream_continuation_and_caches_final_answer(self):
        with tempfile.TemporaryDirectory() as temp, Upstream() as upstream:
            directory = Path(temp)
            data = with_upstream(upstream)
            data += [{'.type': 'rule', '.name': 'alias', 'mode': 'redirect', 'rule_file': file_rule(directory, 'redirect.txt', 'alias.test target.test\n')}]
            with running_engine(data, directory) as (port, config):
                first = query(port, 'alias.test')
                self.assertEqual(first['rcode'], 0)
                self.assertEqual(first['question'], 'alias.test.')
                self.assertIn((5, 'target.test.', 1, 'alias.test.'), first['records'])
                self.assertIn(('target.test.', 1), upstream.requests)
                self.assertNotIn(('alias.test.', 1), upstream.requests)
                transactions = upstream.transactions()
                second = query(port, 'alias.test')
                self.assertEqual(second['records'], first['records'])
                self.assertEqual(upstream.transactions(), transactions, upstream.datagrams)
                self.assertEqual(cache_counters(config), {'query_total': 2, 'hit_total': 1})

    def test_mapping_stop_and_continue_are_stable_on_cache_hits(self):
        for continuation, expected, delay in [('0', '203.0.113.1', 0), ('1', '203.0.113.2', 0), ('1', '203.0.113.2', 1.15)]:
            with self.subTest(continuation=continuation, first_response_delay=delay), tempfile.TemporaryDirectory() as temp, Upstream(first_response_delay=delay) as upstream:
                directory = Path(temp)
                data = with_upstream(upstream)
                data += [
                    {'.type': 'ip_map', '.name': 'one', 'rule_file': file_rule(directory, 'one.txt', '198.18.0.10/32\n'), 'ip_map_target': ['203.0.113.1'], 'continue_match': continuation},
                    {'.type': 'ip_map', '.name': 'two', 'rule_file': file_rule(directory, 'two.txt', '203.0.113.1/32\n'), 'ip_map_target': ['203.0.113.2'], 'continue_match': '0'}]
                with running_engine(data, directory) as (port, config):
                    for _ in range(3):
                        response = query(port, 'mapping.test')
                        self.assertEqual([r[1] for r in response['records'] if r[0] == 1], [expected])
                    self.assertEqual(len(upstream.transactions('mapping.test.', 1)), 1, upstream.datagrams)
                    self.assertEqual(cache_counters(config), {'query_total': 3, 'hit_total': 2})
                    if delay:
                        # Prove that actual transport retries do not masquerade
                        # as cache misses. More retries under load are valid too.
                        self.assertGreaterEqual(upstream.requests.count(('mapping.test.', 1)), 2, upstream.datagrams)

    def test_ordered_rule_ttl_blacklist_hosts_and_ipv4(self):
        with tempfile.TemporaryDirectory() as temp, Upstream() as upstream:
            directory = Path(temp)
            data = with_upstream(upstream)
            data += [
                {'.type': 'rule', '.name': 'hosts', 'mode': 'hosts', 'rule_file': file_rule(directory, 'hosts.txt', 'hosts.test 192.0.2.10\n')},
                {'.type': 'rule', '.name': 'blocked', 'mode': 'blacklist', 'rule_file': file_rule(directory, 'blocked.txt', 'full:blocked.test\n')},
                {'.type': 'rule', '.name': 'ttl', 'mode': 'custom', 'dns_group': 'group_a', 'ip_strategy': 'ipv4', 'ttl': '5', 'rule_file': file_rule(directory, 'ttl.txt', 'full:ttl.test\n')}]
            with running_engine(data, directory) as (port, _):
                self.assertEqual(query(port, 'hosts.test')['records'][0][1], '192.0.2.10')
                self.assertEqual(query(port, 'blocked.test')['rcode'], 3)
                self.assertEqual(query(port, 'ttl.test')['records'][0][2], 5)
                self.assertEqual(query(port, 'ttl.test', 28)['records'], [])
                self.assertNotIn(('hosts.test.', 1), upstream.requests)
                self.assertNotIn(('blocked.test.', 1), upstream.requests)
                self.assertNotIn(('ttl.test.', 28), upstream.requests)


if __name__ == '__main__':
    unittest.main(verbosity=2)
