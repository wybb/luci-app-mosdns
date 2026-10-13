#!/usr/bin/env python3
"""Native CLI filesystem validation with a read-only UCI cursor test double."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from test_v2 import HERE, UCODE, sections, parse_uci

CLI = HERE.parent / 'luci-app-mosdns/root/usr/share/mosdns/v2.uc'
CURSOR = '''
import { readfile } from 'fs';
export function cursor() {
    let sections = json(readfile(getenv('V2_TEST_FIXTURE')));
    return {
        load: function(name) { return name == 'mosdns'; },
        foreach: function(name, kind, callback) {
            for (let i = 0; i < length(sections); i++)
                if (!kind || sections[i]['.type'] == kind) callback(sections[i]);
        }
    };
}
'''


class V2CliTests(unittest.TestCase):
    def invoke(self, command, data, directory, extra_env=None, program=None):
        if not UCODE:
            self.skipTest('ucode unavailable: set UCODE_BIN')
        (directory / 'uci.uc').write_text(CURSOR)
        fixture = directory / 'cursor.json'
        fixture.write_text(json.dumps(data))
        env = {**os.environ, 'V2_TEST_FIXTURE': str(fixture), **(extra_env or {})}
        if program is None and command != 'migrate':
            # Some build hosts have no /var/log. Relocate only the fs validation
            # roots while leaving production lexical path validation unchanged.
            log_root = directory / 'test-logs'
            log_root.mkdir(exist_ok=True)
            source = CLI.read_text()
            old = "let log_file = config.log.file, log_root = index(log_file, '/var/log/') == 0 ? '/var/log' : '/tmp/log';"
            source = source.replace(old, 'let log_file = ' + json.dumps(str(log_root / 'mosdns.log')) + ', log_root = ' + json.dumps(str(log_root)) + ';')
            program = directory / 'v2-relocated.uc'
            program.write_text(source)
            for name in ['v2-config.uc', 'v2-migrate.uc']:
                (directory / name).write_text((CLI.parent / name).read_text())

        return subprocess.run([UCODE, '-L', str(directory), str(program or CLI), command], env=env, text=True, capture_output=True)

    def test_generate_stdout_is_only_json_and_legacy_warning_is_stderr(self):
        with tempfile.TemporaryDirectory() as temp:
            data = sections()
            data[0]['reject_type65'] = '1'
            result = self.invoke('generate', data, Path(temp))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('plugins', json.loads(result.stdout))
            self.assertIn('remain inactive', result.stderr)

    def test_missing_rule_file_fails_without_candidate_output(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            data = sections() + [{'.type': 'rule', '.name': 'missing', 'rule_file': str(directory / 'missing.txt')}]
            result = self.invoke('generate', data, directory)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, '')
            self.assertIn('missing or unreadable', result.stderr)

    def test_log_realpath_rejects_symlink_escape_and_accepts_alias_root(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            root = directory / 'logs'
            root.mkdir()
            alias = directory / 'log-alias'
            alias.symlink_to(root, target_is_directory=True)
            protected = directory / 'outside.txt'
            protected.write_text('untouched')
            unsafe = root / 'escape.log'
            unsafe.symlink_to(protected)
            dangling = root / 'dangling.log'
            dangling.symlink_to(directory / 'missing-protected-file')
            for target, success in [(unsafe, False), (dangling, False), (alias / 'safe.log', True)]:
                source = CLI.read_text()
                old = "let log_file = config.log.file, log_root = index(log_file, '/var/log/') == 0 ? '/var/log' : '/tmp/log';"
                source = source.replace(old, 'let log_file = ' + json.dumps(str(target)) + ', log_root = ' + json.dumps(str(alias)) + ';')
                program = directory / 'v2-test-log.uc'
                program.write_text(source)
                for name in ['v2-config.uc', 'v2-migrate.uc']:
                    (directory / name).write_text((CLI.parent / name).read_text())
                result = self.invoke('generate', sections(), directory, program=program)
                self.assertEqual(result.returncode == 0, success, result.stderr)
                self.assertEqual(protected.read_text(), 'untouched')
                if not success:
                    self.assertEqual(result.stdout, '')

    def migration_program(self, directory):
        # Relocate only fixed router paths; execute the real native fs/CLI logic.
        config = directory / 'mosdns'
        source = CLI.read_text().replace("'/etc/config/mosdns'", repr(str(config))).replace("'/etc/mosdns/rule/streaming.txt'", repr(str(directory / 'streaming.txt')))
        program = directory / 'v2.uc'
        program.write_text(source)
        for name in ['v2-config.uc', 'v2-migrate.uc']:
            (directory / name).write_text((CLI.parent / name).read_text())
        return program, config

    def test_migration_filesystem_backup_idempotence_and_preserved_rules(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            program, config = self.migration_program(directory)
            original = (HERE / 'test_v2_upstream.conf').read_text()
            config.write_text(original)
            streaming = directory / 'streaming.txt'
            streaming.write_text('# user streaming rules\nfull:video.test\n')
            result = self.invoke('migrate', parse_uci(original), directory, program=program)
            self.assertEqual(result.returncode, 0, result.stderr)
            backup = directory / 'mosdns.pre-v2'
            self.assertEqual(backup.read_text(), original)
            self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
            self.assertEqual(streaming.read_text(), '# user streaming rules\nfull:video.test\n')
            migrated = parse_uci(config.read_text())
            self.assertEqual(next(s for s in migrated if s['.name'] == 'rule_stream')['mode'], 'custom')
            before = config.stat().st_mtime_ns
            second = self.invoke('migrate', migrated, directory, program=program)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual(config.stat().st_mtime_ns, before)
            self.assertEqual(backup.read_text(), original)

    def test_unreadable_backup_prevents_migration_publication(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            program, config = self.migration_program(directory)
            original = (HERE / 'test_v2_upstream.conf').read_text()
            config.write_text(original)
            (directory / 'mosdns.pre-v2').mkdir()
            result = self.invoke('migrate', parse_uci(original), directory, program=program)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(config.read_text(), original)

    def test_staged_geodata_validates_but_manifest_and_config_stay_canonical(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            (directory / 'geosite_cn.txt').write_text('full:local.test\n')
            data = sections() + [{'.type': 'rule', '.name': 'cn', 'mode': 'builtin', 'builtin_type': 'cn_domain'}]
            env = {'MOSDNS_GEODATA_DIR': temp}
            result = self.invoke('generate', data, directory, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            plugin = next(p for p in json.loads(result.stdout)['plugins'] if p['tag'] == 'rule_set_cn')
            self.assertEqual(plugin['args']['files'], ['/var/mosdns/geosite_cn.txt'])
            manifest = self.invoke('manifest', data, directory, env)
            self.assertEqual(manifest.returncode, 0, manifest.stderr)
            self.assertEqual(manifest.stdout.splitlines(), ['/etc/config/mosdns', '/var/mosdns/geosite_cn.txt'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
