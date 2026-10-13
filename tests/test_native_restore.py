"""Exercise production default restoration against real libuci and isolated files."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
UCODE = os.environ.get('UCODE_BIN')
MODULES = os.environ.get('UCI_MODULE_DIR')

@unittest.skipUnless(UCODE and MODULES, 'Set UCODE_BIN and UCI_MODULE_DIR for actual UCI tests')
class NativeRestore(unittest.TestCase):
    def test_keep_groups_preserves_files_and_resets_ddns(self):
        self._check_restoration('restore_rule_defaults_keep_groups')

    def test_full_restore_preserves_files_and_resets_ddns(self):
        self._check_restoration('restore_rule_defaults')

    def _check_restoration(self, action):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            config = root / 'config'; config.mkdir()
            state = root / 'state'; state.mkdir()
            data = root / 'mosdns'; (data / 'rule').mkdir(parents=True)
            config.joinpath('mosdns').write_text((ROOT / 'tests/test_v2_old_fork.conf').read_text())
            original = data / 'rule/ddnslist.txt'; original.write_text('keep.user.example\n')
            custom = data / 'rule/custom.txt'; custom.write_text('preserve\n')
            reload = root / 'reload'; reload.write_text('#!/bin/sh\nexit 0\n'); reload.chmod(0o755)
            source = (ROOT / 'luci-app-mosdns/root/usr/share/mosdns/mosdns.uc').read_text()
            source = source.replace("import { connect } from 'ubus';", "const connect = () => null;")
            source = source.replace('cursor()', f'cursor({str(config)!r}, {str(state)!r})')
            source = source.replace('/etc/config', str(config)).replace('/etc/mosdns', str(data)).replace('/etc/init.d/mosdns', str(reload))
            script = root / 'restore.uc'; script.write_text(source)
            result = subprocess.run([UCODE, '-L', MODULES + '/*.so', str(script), action], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            read = root / 'inspect.uc'
            read.write_text("import {cursor} from 'uci'; let c=cursor(ARGV[0]); c.load('mosdns'); c.foreach('mosdns','rule',s=>{if(s.ttl=='5')print(s.rule_file);});")
            restored = subprocess.check_output([UCODE, '-L', MODULES + '/*.so', str(read), str(config)], text=True).strip()
            self.assertNotEqual(restored, str(original))
            self.assertEqual(Path(restored).read_text(), '')
            self.assertEqual(original.read_text(), 'keep.user.example\n')
            self.assertEqual(custom.read_text(), 'preserve\n')
            self.assertTrue(list(data.glob('config-backup.*')))

if __name__ == '__main__':
    unittest.main()
