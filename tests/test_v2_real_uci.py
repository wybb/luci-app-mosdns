#!/usr/bin/env python3
"""Real libuci parser tests; set UCI_MODULE_DIR for an isolated ucode UCI build."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from test_v2 import HERE, UCODE, invoke
from test_v2_cli import mock_native_sanitizer

MODULE = os.environ.get('UCI_MODULE_DIR')
CLI = HERE.parent / 'luci-app-mosdns/root/usr/share/mosdns/v2.uc'


class RealUciTests(unittest.TestCase):
    def setUp(self):
        if not UCODE or not MODULE:
            self.skipTest('Set UCODE_BIN and UCI_MODULE_DIR for native libuci tests')

    def read(self, directory):
        result = subprocess.check_output([UCODE, '-L', MODULE, str(HERE / 'test_v2_uci.uc'), str(directory)], text=True)
        return json.loads(result)

    def cli_program(self, directory):
        source = CLI.read_text()
        source = source.replace('cursor()', 'cursor(' + json.dumps(str(directory)) + ', ' + json.dumps(str(directory / 'delta')) + ', "")')
        source = source.replace("'/etc/config/mosdns'", json.dumps(str(directory / 'mosdns')))
        source = source.replace("'/etc/mosdns/rule/streaming.txt'", json.dumps(str(directory / 'streaming.txt')))
        rules = directory / 'rules'
        rules.mkdir(exist_ok=True)
        (rules / 'blocklist.txt').write_text('')
        source = source.replace("'/etc/mosdns/rule/'", json.dumps(str(rules) + '/'))
        source = mock_native_sanitizer(source)
        program = directory / 'v2.uc'
        program.write_text(source)
        for name in ['v2-config.uc', 'v2-migrate.uc']:
            (directory / name).write_text((CLI.parent / name).read_text().replace('/etc/mosdns/rule/', str(rules) + '/'))
        return program

    def run_migration(self, program):
        return subprocess.run([UCODE, '-L', MODULE, str(program), 'migrate'], text=True, capture_output=True)

    def test_historical_fixtures_parse_compile_and_serialization_roundtrip(self):
        for filename in ['test_v2_old_fork.conf', 'test_v2_upstream.conf']:
            with self.subTest(fixture=filename), tempfile.TemporaryDirectory() as temp:
                directory = Path(temp)
                (directory / 'delta').mkdir()
                path = directory / 'mosdns'
                path.write_text((HERE / filename).read_text())
                original = self.read(directory)
                serialized = invoke('serialize', original, raw=True)
                path.write_text(serialized)
                self.assertEqual(self.read(directory), original)
                migrated = invoke('migrate', original)
                path.write_text(invoke('serialize', migrated['sections'], raw=True))
                parsed = self.read(directory)
                self.assertFalse(invoke('migrate', parsed)['changed'])
                compiled = invoke('generate', parsed, ['223.5.5.5'])
                self.assertIn('plugins', compiled)

    def test_real_cli_migration_backup_and_repeat_are_idempotent(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            (directory / 'delta').mkdir()
            original = (HERE / 'test_v2_upstream.conf').read_text()
            (directory / 'mosdns').write_text(original)
            program = self.cli_program(directory)
            first = self.run_migration(program)
            self.assertEqual(first.returncode, 0, first.stderr)
            backup = directory / 'mosdns.pre-v2'
            self.assertEqual(backup.read_text(), original)
            parsed = self.read(directory)
            self.assertEqual(parsed[0]['schema_version'], '2')
            before = (directory / 'mosdns').stat().st_mtime_ns
            second = self.run_migration(program)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual((directory / 'mosdns').stat().st_mtime_ns, before)
            self.assertEqual(self.read(directory), parsed)

    def test_default_group_repairs_match_legacy_selection(self):
        for flags, expected in [('00', 'first'), ('11', 'last')]:
            with self.subTest(flags=flags), tempfile.TemporaryDirectory() as temp:
                directory = Path(temp)
                (directory / 'delta').mkdir()
                (directory / 'mosdns').write_text("config mosdns 'config'\n option schema_version '2'\nconfig dns_group 'first'\n option is_default '" + flags[0] + "'\n list dns '8.8.8.8'\nconfig dns_group 'last'\n option is_default '" + flags[1] + "'\n list dns '1.1.1.1'\n")
                program = self.cli_program(directory)
                result = self.run_migration(program)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('legacy selection', result.stderr)
                parsed = self.read(directory)
                self.assertEqual([s['.name'] for s in parsed if s.get('is_default') == '1'], [expected])
                before = (directory / 'mosdns').stat().st_mtime_ns
                self.assertEqual(self.run_migration(program).returncode, 0)
                self.assertEqual((directory / 'mosdns').stat().st_mtime_ns, before)

    def test_anonymous_group_ids_and_quoted_names_survive_real_parser(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            (directory / 'delta').mkdir()
            path = directory / 'mosdns'
            path.write_text("config mosdns 'config'\n option schema_version '2'\nconfig dns_group\n option name '国内'\n option is_default '1'\n list dns '8.8.8.8'\nconfig rule\n option dns_group '@dns_group[0]'\n option rule_file '/etc/mosdns/rule/own.txt'\n")
            before = self.read(directory)
            # Exercise the serializer's exact apostrophe and Unicode escaping.
            before[1]['name'] = "国内 'quoted' \\ backslash"
            path.write_text(invoke('serialize', before, raw=True))
            quoted = self.read(directory)
            self.assertEqual(quoted[1]['name'], before[1]['name'])
            group_id = quoted[1]['.name']
            first = self.run_migration(self.cli_program(directory))
            self.assertEqual(first.returncode, 0, first.stderr)
            after = self.read(directory)
            self.assertFalse(after[1]['.anonymous'])
            self.assertEqual(after[1]['.name'], group_id)
            self.assertEqual(after[2]['dns_group'], group_id)
            self.assertEqual(after[2]['rule_file'], '/etc/mosdns/rule/own.txt')
            self.assertFalse(invoke('migrate', after)['changed'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
