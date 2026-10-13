#!/usr/bin/env python3
"""Real libuci integration; set UCODE_BIN and optionally UCI_MODULE_DIR.

Only fixture paths and cursor directories are relocated. No UCI parser/cursor
mock is used, and no router configuration or service is touched.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent / 'luci-app-mosdns/root/usr/share/mosdns'
UCODE = os.environ.get('UCODE_BIN') or shutil.which('ucode')
MODULE_DIR = os.environ.get('UCI_MODULE_DIR')


class NativeUciTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not UCODE:
            raise unittest.SkipTest('Set UCODE_BIN to a native ucode executable')
        cls.command = [UCODE] + (['-L', str(Path(MODULE_DIR) / '*.so')] if MODULE_DIR else [])
        probe = subprocess.run(cls.command + ['-e', 'import { cursor } from "uci"; print(type(cursor));'], text=True, capture_output=True)
        if probe.returncode:
            if os.environ.get('REQUIRE_NATIVE_UCI') == '1':
                raise RuntimeError('Required native UCI module unavailable: ' + probe.stderr)
            raise unittest.SkipTest('Native uci.so unavailable; set UCI_MODULE_DIR')
        if probe.stdout != 'function':
            raise RuntimeError('Unexpected UCI cursor module: ' + probe.stdout)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='mosdns-native-uci-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = self.root / 'mosdns'
        self.rules = self.root / 'rules'
        self.rules.mkdir()
        self.logs = self.root / 'logs'
        self.logs.mkdir()
        self.delta = self.root / 'delta'
        self.delta.mkdir()
        self.program = self.root / 'v2.uc'
        code = (SOURCE / 'v2.uc').read_text()
        code = code.replace('cursor()', f'cursor({json.dumps(str(self.root))}, {json.dumps(str(self.delta))}, "")')
        code = code.replace('/etc/config/mosdns', str(self.config))
        code = code.replace('/etc/mosdns/rule/', str(self.rules) + '/')
        log_assignment = "let log_file = config.log.file, log_root = index(log_file, '/var/log/') == 0 ? '/var/log' : '/tmp/log';"
        code = code.replace(log_assignment, 'let log_file = ' + json.dumps(str(self.logs / 'mosdns.log')) + ', log_root = ' + json.dumps(str(self.logs)) + ';')
        self.program.write_text(code)
        for name in ['v2-config.uc', 'v2-migrate.uc']:
            (self.root / name).write_text((SOURCE / name).read_text())

    def run_cli(self, command):
        return subprocess.run(self.command + [str(self.program), command], text=True, capture_output=True)

    def read_sections(self):
        code = ('import { cursor } from "uci"; let c=cursor(' + json.dumps(str(self.root)) + ', ' + json.dumps(str(self.delta)) + ', ""); '
                'if (!c.load("mosdns")) die("UCI load failed"); let s=[]; c.foreach("mosdns", null, x=>push(s,x)); print(sprintf("%J",s));')
        result = subprocess.run(self.command + ['-e', code], text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def write_basic(self):
        self.config.write_text("config mosdns 'config'\n option schema_version '2'\n option cache '1'\n"
                               "config dns_group 'main'\n option is_default '1'\n list dns '8.8.8.8'\n list dns '1.1.1.1'\n")

    def test_real_lists_generate_json_and_manifest(self):
        self.write_basic()
        sections = self.read_sections()
        self.assertEqual(sections[1]['dns'], ['8.8.8.8', '1.1.1.1'])
        self.assertEqual(sections[1]['.index'], 1)
        result = self.run_cli('generate')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('plugins', json.loads(result.stdout))
        result = self.run_cli('manifest')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), [str(self.config)])

    def test_invalid_real_uci_and_missing_rule_publish_no_json(self):
        self.config.write_text("config mosdns 'unterminated\n")
        result = self.run_cli('generate')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        self.write_basic()
        with self.config.open('a') as stream:
            stream.write("config rule 'missing'\n option mode 'custom'\n option rule_file '/tmp/mosdns-nonexistent-native-fixture/rule.txt'\n")
        result = self.run_cli('generate')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        self.assertIn('missing or unreadable', result.stderr)

    def test_unreadable_backup_blocks_publication(self):
        original = (HERE / 'test_v2_upstream.conf').read_text()
        self.config.write_text(original)
        (self.root / 'mosdns.pre-v2').mkdir()
        result = self.run_cli('migrate')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.config.read_text(), original)


if __name__ == '__main__':
    unittest.main(verbosity=2)
