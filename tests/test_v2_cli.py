#!/usr/bin/env python3
"""Native CLI filesystem validation with a read-only UCI cursor test double."""
import json
import os
from pathlib import Path
import subprocess
import shutil
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


ANNOTATION = '# mosdns v2 migration: unsupported domain_set line: '
SANITIZER_RESPONSES = {
    'domain:good.test\n||ads.test^\nregexp:^ads[.]test$\n! comment\n': {
        'content': 'domain:good.test\n' + ANNOTATION + '||ads.test^\nregexp:^ads[.]test$\n' + ANNOTATION + '! comment\n', 'count': 2},
    'good.test\n0.0.0.0 ads.test\n': {'content': 'good.test\n' + ANNOTATION + '0.0.0.0 ads.test\n', 'count': 1},
    '||user.test^\n': {'content': ANNOTATION + '||user.test^\n', 'count': 1},
    '': {'content': '', 'count': 0}
}
for response in list(SANITIZER_RESPONSES.values()):
    SANITIZER_RESPONSES[response['content']] = {'content': response['content'], 'count': 0}


def mock_native_sanitizer(source):
    source = source.replace("popen('/usr/bin/mosdns sanitize-domain-set --file ' + shell_quote(source) + ' 2>/dev/null', 'r')", 'mock_sanitizer(source)')
    mock = '''
function mock_sanitizer(source) {
    let responses = RESPONSES;
    let result = responses[readfile(source)];
    if (result == null) die('Missing explicit native sanitizer fixture: ' + source);
    let response = getenv('V2_TEST_SANITIZER_RESPONSE');
    let code = getenv('V2_TEST_SANITIZER_STATUS') || '0';
    return { read: () => response || sprintf('%J', result), close: () => +code };
}
'''.replace('RESPONSES', json.dumps(SANITIZER_RESPONSES))
    return source.replace('function fail(message)', mock + '\nfunction fail(message)')


class V2CliTests(unittest.TestCase):
    def setUp(self):
        if not UCODE:
            self.skipTest('ucode unavailable: set UCODE_BIN')

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
        config = directory / 'mosdns'
        source = CLI.read_text().replace("'/etc/config/mosdns'", repr(str(config))).replace("'/etc/mosdns/rule/streaming.txt'", repr(str(directory / 'streaming.txt')))
        rules = directory / 'rules'
        rules.mkdir(exist_ok=True)
        source = source.replace("'/etc/mosdns/rule/'", repr(str(rules) + '/'))
        source = mock_native_sanitizer(source)
        (rules / 'blocklist.txt').write_text('')
        program = directory / 'v2.uc'
        program.write_text(source)
        for name in ['v2-config.uc', 'v2-migrate.uc']:
            module = (CLI.parent / name).read_text().replace('/etc/mosdns/rule/', str(rules) + '/')
            (directory / name).write_text(module)
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

    def test_blacklist_copy_preserves_shared_source_disabled_state_and_missing_refs(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            program, config = self.migration_program(directory)
            rules = directory / 'rules'
            shared = rules / 'shared.txt'
            content = 'domain:good.test\n||ads.test^\nregexp:^ads[.]test$\n! comment\n'
            shared.write_text(content)
            original = ("config mosdns 'config'\nconfig dns_group 'main'\n option is_default '1'\n list dns '8.8.8.8'\n"
                        "config rule 'block'\n option mode 'blacklist'\n option rule_file 'shared.txt'\n"
                        "config rule 'other'\n option mode 'custom'\n option rule_file 'shared.txt'\n"
                        "config rule 'ptr'\n option mode 'blacklist'\n option blacklist_type 'ptr'\n option rule_file 'shared.txt'\n"
                        "config rule 'disabled'\n option mode 'blacklist'\n option enabled '0'\n option rule_file 'shared.txt'\n"
                        "config rule 'missing'\n option mode 'blacklist'\n option enabled '0'\n option rule_file 'missing.txt'\n"
                        "config rule 'missing_active'\n option mode 'blacklist'\n option rule_file 'missing.txt'\n")
            config.write_text(original)
            result = self.invoke('migrate', parse_uci(original), directory, program=program)
            self.assertEqual(result.returncode, 0, result.stderr)
            migrated = parse_uci(config.read_text())
            refs = {s['.name']: s.get('rule_file') for s in migrated if s['.type'] == 'rule'}
            copy = Path(refs['block'])
            self.assertNotEqual(copy, shared)
            self.assertEqual(copy.read_text(), 'domain:good.test\n# mosdns v2 migration: unsupported domain_set line: ||ads.test^\nregexp:^ads[.]test$\n# mosdns v2 migration: unsupported domain_set line: ! comment\n')
            for sid in ['other', 'ptr']:
                self.assertEqual(refs[sid], 'shared.txt')
            self.assertEqual(Path(refs['disabled']).read_text(), copy.read_text())
            self.assertEqual(next(s for s in migrated if s['.name'] == 'disabled')['enabled'], '0')
            self.assertNotIn('blacklist_migration_version', migrated[0])
            for sid in ['missing', 'missing_active']:
                self.assertEqual(refs[sid], 'missing.txt')
            self.assertEqual(shared.read_text(), content)
            self.assertEqual((directory / 'mosdns.pre-v2').read_text(), original)
            before = sorted(str(p) for p in rules.rglob('*'))
            self.assertEqual(self.invoke('migrate', migrated, directory, program=program).returncode, 0)
            self.assertEqual(sorted(str(p) for p in rules.rglob('*')), before)
            self.assertEqual(shared.read_text(), content)
            (rules / 'missing.txt').write_text('||user.test^\n')
            self.assertEqual(self.invoke('migrate', migrated, directory, program=program).returncode, 0)
            completed = parse_uci(config.read_text())
            self.assertEqual(completed[0]['blacklist_migration_version'], '1')
            for sid in ['missing', 'missing_active']:
                ref = next(s['rule_file'] for s in completed if s['.name'] == sid)
                self.assertEqual(Path(ref).read_text(), ANNOTATION + '||user.test^\n')
            before = sorted(str(p) for p in rules.rglob('*'))
            self.assertEqual(self.invoke('migrate', completed, directory, program=program).returncode, 0)
            self.assertEqual(sorted(str(p) for p in rules.rglob('*')), before)
            self.assertEqual((directory / 'mosdns.pre-v2').read_text(), original)

    def test_upstream_blocklist_copy_and_filesystem_failures_are_atomic(self):
        failures = [None, 'write', 'verify', 'chmod', 'rename', 'config']
        for failure in failures:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temp:
                directory = Path(temp)
                program, config = self.migration_program(directory)
                source = directory / 'rules' / 'blocklist.txt'
                source.write_text('good.test\n0.0.0.0 ads.test\n')
                original = (HERE / 'test_v2_upstream.conf').read_text()
                config.write_text(original)
                code = program.read_text()
                if failure:
                    code = code.replace('writefile, rename,', 'writefile as fs_writefile, rename as fs_rename,')
                    code = code.replace('chmod, popen,', 'chmod as fs_chmod, popen,')
                    wrappers = '''
function writefile(path, content) {
    if (index(path, '.migrate-') >= 0 && getenv('V2_TEST_FAILURE') == 'write') return null;
    if (index(path, '.migrate-') >= 0 && getenv('V2_TEST_FAILURE') == 'verify') return fs_writefile(path, content + 'bad');
    return fs_writefile(path, content);
}
function chmod(path, mode) {
    if (index(path, '.migrate-') >= 0 && getenv('V2_TEST_FAILURE') == 'chmod') return false;
    return fs_chmod(path, mode);
}
function rename(source, target) {
    if (index(source, '.migrate-') >= 0 && getenv('V2_TEST_FAILURE') == 'rename') return false;
    if (substr(source, -7) == '.v2-new' && getenv('V2_TEST_FAILURE') == 'config') return false;
    return fs_rename(source, target);
}
'''
                    code = code.replace('function fail(message)', wrappers + '\nfunction fail(message)')
                    program.write_text(code)
                result = self.invoke('migrate', parse_uci(original), directory,
                                     {'V2_TEST_FAILURE': failure or ''}, program=program)
                self.assertEqual(source.read_text(), 'good.test\n0.0.0.0 ads.test\n')
                self.assertEqual((directory / 'mosdns.pre-v2').read_text(), original)
                if failure:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(config.read_text(), original)
                    self.assertEqual(list((directory / 'rules').glob('.migrate-*')), [])
                    self.assertFalse((directory / 'mosdns.v2-new').exists())
                else:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    migrated = parse_uci(config.read_text())
                    ref = next(s['rule_file'] for s in migrated if s['.name'] == 'rule_blocklist')
                    self.assertEqual(Path(ref).read_text(), 'good.test\n# mosdns v2 migration: unsupported domain_set line: 0.0.0.0 ads.test\n')
                    self.assertEqual(self.invoke('migrate', migrated, directory, program=program).returncode, 0)
                    self.assertEqual(len(list((directory / 'rules').glob('.migrate-*'))), 1)

    def test_schema_v2_blacklist_sanitized_once_without_other_migration_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            program, config = self.migration_program(directory)
            source = directory / 'rules' / 'user.txt'
            source.write_text('||user.test^\n')
            original = ("config mosdns 'config'\n option schema_version '2'\n"
                        "config dns_group 'main'\n option is_default '1'\n list dns '8.8.8.8'\n"
                        "config rule 'block'\n option mode 'blacklist'\n option rule_file 'user.txt'\n")
            config.write_text(original)
            result = self.invoke('migrate', parse_uci(original), directory, program=program)
            self.assertEqual(result.returncode, 0, result.stderr)
            migrated = parse_uci(config.read_text())
            self.assertEqual(migrated[0]['blacklist_migration_version'], '1')
            self.assertEqual(Path(migrated[-1]['rule_file']).read_text(), ANNOTATION + '||user.test^\n')
            self.assertEqual(source.read_text(), '||user.test^\n')
            before = config.read_text()
            self.assertEqual(self.invoke('migrate', migrated, directory, program=program).returncode, 0)
            self.assertEqual(config.read_text(), before)
            self.assertEqual(len(list((directory / 'rules').glob('.migrate-*'))), 1)

    def test_native_sanitizer_error_and_invalid_json_do_not_publish(self):
        cases = [{'V2_TEST_SANITIZER_STATUS': '1'}] + [
            {'V2_TEST_SANITIZER_RESPONSE': response} for response in [
                'not json', 'null', '[]', '{"content":4,"count":1}', '{"content":"x","count":"1"}',
                '{"content":"x","count":-1}', '{"content":"x","count":100}', '{"content":"x","count":0}',
                '{"content":"x","count":1.5}']]
        for env in cases:
            with self.subTest(env=env), tempfile.TemporaryDirectory() as temp:
                directory = Path(temp)
                program, config = self.migration_program(directory)
                original = ("config mosdns 'config'\n option schema_version '2'\n"
                            "config dns_group 'main'\n option is_default '1'\n list dns '8.8.8.8'\n"
                            "config rule 'block'\n option mode 'blacklist'\n option enabled '0'\n option rule_file 'user.txt'\n")
                config.write_text(original)
                source = directory / 'rules' / 'user.txt'
                source.write_text('||user.test^\n')
                result = self.invoke('migrate', parse_uci(original), directory, env, program=program)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(config.read_text(), original)
                self.assertEqual(source.read_text(), '||user.test^\n')
                self.assertEqual(list((directory / 'rules').glob('.migrate-*')), [])

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


class NodeMigrationFilesystemShimTests(unittest.TestCase):
    def test_cli_publication_faults_with_js_fs_shims_not_native_filesystem(self):
        node = os.environ.get('NODE_BIN') or shutil.which('node')
        if not node:
            self.skipTest('Node unavailable for explicitly non-native filesystem shim test')
        script = r'''
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const root = process.argv[1];
const modules = ['v2-config.uc', 'v2-migrate.uc'].map(name => fs.readFileSync(root + '/' + name, 'utf8')
    .replace(/^import .*$/mg, '').replace(/export /g, '')).join('\n');
const cli = fs.readFileSync(root + '/v2.uc', 'utf8').replace(/^#!.*$/m, '').replace(/^import .*$/mg, '')
    .replace(/\b0([0-7]{3})\b/g, '0o$1')
    .replace('} catch (e) { fail(e.message', '} catch (e) { if (e.exit) throw e; fail(e.message');
const helpers = {
    type: v => Array.isArray(v) ? 'array' : v == null ? null : typeof v === 'number' ? (Number.isInteger(v) ? 'int' : 'double') : typeof v,
    length: v => v == null ? 0 : v.length, split: (v, s) => v.split(s),
    replace: (v, r, s) => v.replace(r, s), index: (v, s) => v.indexOf(s), match: (v, r) => r.exec(v),
    substr: (v, i, n) => v.substr(i, n), join: (s, a) => a.join(s), push: (a, ...v) => a.push(...v),
    filter: (a, f) => a.filter(f), keys: Object.keys, json: JSON.parse, die: s => { throw Error(s); }
};
const core = vm.runInNewContext('(function(){' + modules + ';return {serialize};})()', helpers);
function run(failure, schema, upstream, marked=false, quoted=false) {
    const data = upstream ? [{'.type':'mosdns','.name':'config'}] : [
        {'.type':'mosdns','.name':'config', ...(schema ? {schema_version:schema} : {}), ...(marked ? {blacklist_migration_version:'1'} : {})},
        {'.type':'dns_group','.name':'main',is_default:'1',dns:['8.8.8.8']},
        {'.type':'rule','.name':'block',mode:'blacklist',rule_file:'shared.txt'},
        {'.type':'rule','.name':'other',mode:'custom',rule_file:'shared.txt'},
        {'.type':'rule','.name':'ptr',mode:'blacklist',blacklist_type:'ptr',rule_file:'shared.txt'},
        {'.type':'rule','.name':'disabled',mode:'blacklist',enabled:'0',rule_file:'shared.txt'},
        {'.type':'rule','.name':'missing',mode:'blacklist',rule_file:'missing.txt'}];
    if (quoted) {
        const ref="quoted ' file;$(touch marker).txt";
        data.filter(s=>s.rule_file === 'shared.txt').forEach(s=>s.rule_file=ref);
    }
    const config = '/etc/config/mosdns', source = '/etc/mosdns/rule/' + (upstream ? 'blocklist.txt' : data[2].rule_file);
    const original = core.serialize(data), content = 'full:good.test\n||ads.test^\nregexp:^ads[.]test$\n';
    const files = {[config]:original, [source]:content}, dirs = new Set();
    const cleaned = 'full:good.test\n# mosdns v2 migration: unsupported domain_set line: ||ads.test^\nregexp:^ads[.]test$\n';
    const responses = new Map([[content, {content:cleaned,count:1}], [cleaned, {content:cleaned,count:0}], ['', {content:'',count:0}]]);
    let warnings = '', counter = 0, sanitizerCalls = 0;
    function execute(sections) {
        let exitCode = null;
        const env = {...helpers, ARGV:['migrate'],
            cursor: () => ({load:()=>true, foreach:(c,k,f)=>sections.forEach(f)}),
            readfile: path => {
                if (failure === 'verify' && path.endsWith('/content.new')) return 'corrupt';
                return files[path] ?? null;
            },
            writefile: (path, text) => {
                if (failure === 'write' && path.endsWith('/content.new')) return null;
                files[path] = text; return text.length;
            },
            stat: path => files[path] != null || dirs.has(path) ? {} : null,
            chmod: path => !(failure === 'chmod' && path.includes('.migrate-')),
            rename: (a,b) => {
                if ((failure === 'rename' && a.endsWith('/content.new')) || (failure === 'config' && a.endsWith('.v2-new'))) return false;
                files[b]=files[a]; delete files[a]; return true;
            },
            unlink: path => {delete files[path]; return true;},
            rmdir: path => dirs.delete(path),
            popen: command => {
                if (command.startsWith('/usr/bin/mosdns sanitize-domain-set --file ')) {
                    sanitizerCalls++;
                    const prefix='/usr/bin/mosdns sanitize-domain-set --file ';
                    const argument=command.slice(prefix.length,-' 2>/dev/null'.length);
                    assert(argument.startsWith("'") && argument.endsWith("'"));
                    const path=argument.slice(1,-1).split("'\"'\"'").join("'");
                    assert.equal(argument, "'" + path.split("'").join("'\"'\"'") + "'");
                    const result=responses.get(files[path]);
                    assert(result, 'Explicit native sanitizer JSON fixture required');
                    let output=JSON.stringify(result);
                    if (failure === 'json') output='invalid JSON';
                    if (failure === 'types') output=JSON.stringify({content:4,count:'1'});
                    if (failure === 'count') output=JSON.stringify({content:cleaned,count:100});
                    if (failure === 'fraction') output=JSON.stringify({content:cleaned,count:1.5});
                    if (failure === 'zero') output=JSON.stringify({content:'changed',count:0});
                    if (failure === 'length') output=JSON.stringify({content:'short',count:1});
                    if (failure === 'negative') output=JSON.stringify({content:cleaned,count:-1});
                    if (failure === 'race') files[path]='changed concurrently';
                    return {read:()=>output,close:()=>failure === 'native' ? 1 : 0};
                }
                assert(command.startsWith('mktemp -d '));
                const directory='/etc/mosdns/rule/.migrate-Test' + ++counter;
                dirs.add(directory); return {read:()=>directory+'\n',close:()=>0};
            },
            stderr:{write:s=>{warnings+=s;}},
            exit: code => {exitCode=code; throw {exit:true};}
        };
        try {vm.runInNewContext('(function(){' + modules + '\n' + cli + '})()', env);}
        catch (e) {if (!e.exit) throw e;}
        return exitCode;
    }
    assert.equal(execute(data), failure ? 1 : 0, warnings);
    assert.equal(files[source],failure === 'race' ? 'changed concurrently' : content);
    if (marked) {
        assert.equal(files[config],original);
        assert.equal(sanitizerCalls,0);
        assert.equal(counter,0);
        return;
    }
    assert.equal(files[config+'.pre-v2'],original);
    if (failure) {
        assert.equal(files[config],original);
        assert.equal(dirs.size,0);
        assert(!Object.keys(files).some(p=>p.includes('.migrate-') || p.endsWith('.v2-new')));
        return;
    }
    const targets=Object.keys(files).filter(p=>p.endsWith('/content.txt'));
    assert.equal(targets.length,upstream ? 1 : 2);
    targets.forEach(path=>assert.equal(files[path],cleaned));
    if (!upstream) {
        if (!quoted) assert.equal((files[config].match(/option 'rule_file' 'shared.txt'/g)||[]).length,2);
        assert(!files[config].includes("blacklist_migration_version"));
    }
    function parsed() {
        const next=[];
        for (const line of files[config].split('\n')) {
            const fields=Array.from(line.matchAll(/'([^']*)'/g),m=>m[1]);
            if (line.startsWith('config ')) next.push({'.type':fields[0],'.name':fields[1]});
            else if (line.startsWith('\toption ')) next.at(-1)[fields[0]]=fields[1];
            else if (line.startsWith('\tlist ')) (next.at(-1)[fields[0]]??=[]).push(fields[1]);
        }
        return next;
    }
    if (quoted) {
        assert.equal(counter,2);
        assert.equal(files[source],content);
        return;
    }
    const before=JSON.stringify(files), copies=counter;
    assert.equal(execute(parsed()),0);
    assert.equal(JSON.stringify(files),before);
    assert.equal(counter,copies);
    if (!upstream) {
        files['/etc/mosdns/rule/missing.txt']='';
        assert.equal(execute(parsed()),0);
        assert(files[config].includes("option 'blacklist_migration_version' '1'"));
        assert.equal(parsed().find(s=>s['.name']==='disabled').enabled,'0');
    }
    const complete=JSON.stringify(files), calls=sanitizerCalls;
    assert.equal(execute(parsed()),0);
    assert.equal(JSON.stringify(files),complete);
    assert.equal(sanitizerCalls,calls);
}
for (const failure of [null,'write','verify','chmod','rename','config','native','json','types','count','fraction','zero','length','negative','race']) run(failure,null,false);
run(null,null,true);
run(null,'2',false);
run(null,'2',false,true);
run(null,'2',false,false,true);
console.log('PASS: Node CLI filesystem shims with explicit native sanitizer JSON mocks; disabled/missing refs, marker retry, command errors and atomic cleanup; no Go regexp validation claimed');
'''
        result = subprocess.run([node, '-e', script, str(CLI.parent)], text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('PASS: Node CLI filesystem shims', result.stdout)


if __name__ == '__main__':
    unittest.main(verbosity=2)
