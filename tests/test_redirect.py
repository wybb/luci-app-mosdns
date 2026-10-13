"""Native ucode redirect transaction tests with a file-backed UCI fixture."""
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
UCODE = os.environ.get('UCODE_BIN') or shutil.which('ucode')

@unittest.skipUnless(UCODE, 'Set UCODE_BIN to a native ucode interpreter')
class Redirect(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = pathlib.Path(self.tmp.name)
        self.state = self.path / 'state.json'
        self.original = {'first': {'server':['/example.test/192.0.2.1', '1.1.1.1'], 'cachesize':'1000'}, 'second': {'server':['9.9.9.9']}}
        self.state.write_text(json.dumps(self.original))
        (self.path / 'uci.uc').write_text('''
import { readfile, writefile } from 'fs';
export function cursor() {
 let data = json(readfile(getenv('TEST_STATE')));
 return {
 load: function() { return true; },
 foreach: function(pkg, kind, fn) { for (let key in data) fn({'.name':key}); },
 get: function(pkg, section, option) { return option ? data[section][option] : data[section]; },
 set: function(pkg, section, option, value) { data[section][option] = value; return true; },
 delete: function(pkg, section, option) { delete data[section][option]; return true; },
 save: function() { return true; },
 commit: function() { let text = sprintf('%J', data); return writefile(getenv('TEST_STATE'), text) == length(text); }
 };
}
''')
        source = (ROOT / 'luci-app-mosdns/root/usr/share/mosdns/redirect.uc').read_text()
        source = source.replace("from 'uci'", "from './uci.uc'").replace('/etc/mosdns', str(self.path / 'mosdns'))
        self.script = self.path / 'redirect.uc'; self.script.write_text(source)

    def tearDown(self):
        self.tmp.cleanup()

    def invoke(self, *args, success=True):
        result = subprocess.run([UCODE, str(self.script), *args], env={**os.environ, 'TEST_STATE':str(self.state)}, capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, success, result.stderr)
        return result

    def test_restore_exact_lists_absence_and_other_instances(self):
        self.invoke('apply', '5335')
        modified = json.loads(self.state.read_text())
        self.assertEqual(modified['first']['server'], ['127.0.0.1#5335'])
        self.assertEqual(modified['second'], self.original['second'])
        backup = (self.path / 'mosdns/dnsmasq-backup.json').read_bytes()
        self.invoke('apply', '5353')
        self.assertEqual((self.path / 'mosdns/dnsmasq-backup.json').read_bytes(), backup)
        self.invoke('restore')
        self.assertEqual(json.loads(self.state.read_text()), self.original)
        self.invoke('restore')
        self.assertEqual(json.loads(self.state.read_text()), self.original)

    def test_invalid_port_does_not_modify(self):
        self.invoke('apply', '1;echo exploit', success=False)
        self.assertEqual(json.loads(self.state.read_text()), self.original)
        self.invoke('apply', '65536', success=False)

    def test_legacy_lock_does_not_snapshot_redirected_state(self):
        (self.path / 'mosdns').mkdir()
        (self.path / 'mosdns/redirect.lock').write_text('noresolv=0\n')
        self.invoke('check', success=False)
        self.invoke('apply', '5335', success=False)
        self.assertEqual(json.loads(self.state.read_text()), self.original)
        self.assertFalse((self.path / 'mosdns/dnsmasq-backup.json').exists())

    def test_corrupt_backup_fails_closed(self):
        (self.path / 'mosdns').mkdir()
        (self.path / 'mosdns/dnsmasq-backup.json').write_text('{bad')
        self.invoke('apply', '5335', success=False)
        self.assertEqual(json.loads(self.state.read_text()), self.original)

if __name__ == '__main__':
    unittest.main()
