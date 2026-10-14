#!/usr/bin/env python3
"""Native ucode regression tests. UCODE_BIN may point at a host ucode build."""
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
UCODE = os.environ.get('UCODE_BIN') or shutil.which('ucode')


def invoke(mode, sections, default_dns=None, raw=False, legacy=None):
    if not UCODE:
        raise unittest.SkipTest('ucode unavailable: set UCODE_BIN to run native tests')
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json') as fixture:
        json.dump({'sections': sections, 'default_dns': default_dns or [], 'legacy': legacy or {}}, fixture)
        fixture.flush()
        output = subprocess.check_output([UCODE, str(HERE / 'test_v2.uc'), mode, fixture.name], stderr=subprocess.PIPE, text=True)
    return output if raw else json.loads(output)


def parse_uci(text):
    """Parse fixture text; native compiler consumes the resulting UCI cursor shape."""
    result = []
    for line in text.splitlines():
        tokens = shlex.split(line, comments=True)
        if not tokens:
            continue
        if tokens[0] == 'config':
            name = tokens[2] if len(tokens) > 2 else 'cfg%06x' % len(result)
            section = {'.type': tokens[1], '.name': name}
            if len(tokens) == 2:
                section['.anonymous'] = True
            result.append(section)
        elif tokens[0] == 'option':
            result[-1][tokens[1]] = tokens[2]
        elif tokens[0] == 'list':
            result[-1].setdefault(tokens[1], []).append(tokens[2])
        else:
            raise ValueError('Unexpected UCI fixture directive')
    return result


def sections():
    return [{'.type': 'mosdns', '.name': 'config', 'cache': '1'},
            {'.type': 'dns_group', '.name': 'group_a', 'name': 'Editable display name', 'is_default': '1', 'dns': ['8.8.8.8']}]


def plugins(config):
    return {p['tag']: p for p in config['plugins']}


def map_response(config, address, sets):
    """Mirror MosDNS standalone $sequence versus jump continuation semantics."""
    all_plugins = plugins(config)
    visited = []

    def walk(tag):
        nonlocal address
        for rule in all_plugins[tag]['args']:
            condition = rule.get('matches')
            if condition == '!has_resp':
                continue
            if condition and condition.startswith('!resp_ip $') and address in sets[condition[10:]]:
                continue
            execution = rule['exec']
            if execution == 'return':
                return False
            if execution == 'accept':
                return True
            if execution.startswith('black_hole '):
                visited.append(tag)
                address = execution[11:]
            elif execution.startswith('jump '):
                if walk(execution[5:]):
                    return True
            elif execution.startswith('$'):
                walk(execution[1:])  # accept inside an independent walker is local
        return False

    walk('has_resp_sequence')
    return address, visited


class V2Tests(unittest.TestCase):
    def setUp(self):
        if not UCODE:
            self.skipTest('ucode unavailable: set UCODE_BIN to run native tests')

    def test_cache_first_optional_stats_prefetch_and_no_legacy_activation(self):
        data = sections()
        data[0].update(minimal_ttl='9', maximum_ttl='99', enable_ecs_remote='1', reject_type65='1', dns_leak='1')
        result = plugins(invoke('generate', data))
        self.assertEqual(result['main_sequence']['args'][0]['exec'], '$lazy_cache')
        self.assertNotIn('stats_collector', result)
        self.assertNotIn('prefetch', result['lazy_cache']['args'])
        encoded = json.dumps(result)
        for forbidden in ['qtype 65', 'ecs ', 'ttl 9-99']:
            self.assertNotIn(forbidden, encoded)
        data[0].update(stats_collector='1', prefetch='1')
        result = plugins(invoke('generate', data))
        self.assertTrue(result['lazy_cache']['args']['prefetch'])
        self.assertEqual(result['main_sequence']['args'][0]['exec'], '$stats_collector')
        self.assertEqual(result['main_sequence']['args'][1]['exec'], '$lazy_cache')

    def test_ip_mapping_stop_continue_original_match_and_outer_exit(self):
        data = sections() + [
            {'.type': 'ip_map', '.name': 'one', 'ip_map_target': ['1.2.3.4'], 'continue_match': '0'},
            {'.type': 'ip_map', '.name': 'two', 'ip_map_target': ['::1'], 'continue_match': '1'}]
        sets = {'ip_map_set_one': ['8.8.8.8'], 'ip_map_set_two': ['1.2.3.4']}
        config = invoke('generate', data)
        self.assertEqual(map_response(config, '8.8.8.8', sets), ('1.2.3.4', ['ip_map_exec_one']))
        self.assertEqual(map_response(config, '9.9.9.9', sets), ('9.9.9.9', []))
        data[2]['continue_match'] = '1'
        config = invoke('generate', data)
        self.assertEqual(map_response(config, '8.8.8.8', sets), ('::1', ['ip_map_exec_one', 'ip_map_exec_two']))

    def test_order_fallback_and_editable_group_names(self):
        for strategy, forbidden, preferred in [('auto', None, None), ('ipv4', 'qtype 28', 'prefer_ipv4'), ('ipv6', 'qtype 1', 'prefer_ipv6'), ('ipv4_first', None, 'prefer_ipv4'), ('ipv6_first', None, 'prefer_ipv6')]:
            data = sections()
            data[0]['fallback_ip_strategy'] = strategy
            data += [{'.type': 'rule', '.name': n, 'mode': 'custom', 'dns_group': 'group_a'} for n in ['z', 'a']]
            result = plugins(invoke('generate', data))
            main = result['main_sequence']['args']
            self.assertLess(next(i for i, r in enumerate(main) if r['exec'] == '$rule_exec_z'), next(i for i, r in enumerate(main) if r['exec'] == '$rule_exec_a'))
            if forbidden:
                self.assertIn({'matches': forbidden, 'exec': 'reject 0'}, main)
            if preferred:
                self.assertIn({'exec': preferred}, main)
            data[1]['name'] = 'Renamed'
            self.assertEqual(result, plugins(invoke('generate', data)))

    def test_invalid_inputs_fail(self):
        for option, value in [('listen_port', '70000'), ('listen_port', '53 accept'), ('listen_address', ':::'), ('fallback_ip_strategy', 'bad'), ('cache_size', '-1')]:
            data = sections()
            data[0][option] = value
            with self.assertRaises(subprocess.CalledProcessError):
                invoke('generate', data)
        for target in ['999.0.0.1', '1:::2', ':::', ':1::', '::1:', 'not-an-ip', '1.2.3.4 accept']:
            with self.assertRaises(subprocess.CalledProcessError):
                invoke('generate', sections() + [{'.type': 'ip_map', '.name': 'bad', 'ip_map_target': [target]}])
        with self.assertRaises(subprocess.CalledProcessError):
            invoke('generate', sections() + [{'.type': 'rule', '.name': 'r', 'dns_group': 'removed'}])

    def test_migration_idempotence_preserves_v2_sections_and_serialization(self):
        original = sections()
        original[0]['schema_version'] = '2'
        original[1]['.anonymous'] = True
        original[1]['name'] = "单引号 ' and space"
        original += [{'.type': 'rule', '.name': 'r', 'dns_group': '@dns_group[0]', 'rule_file': 'existing.txt'}]
        migrated = invoke('migrate', original)
        self.assertTrue(migrated['changed'])
        self.assertEqual(migrated['sections'][2]['dns_group'], 'group_a')
        self.assertEqual(migrated['sections'][2]['rule_file'], 'existing.txt')
        self.assertFalse(invoke('migrate', migrated['sections'])['changed'])
        text = invoke('serialize', migrated['sections'], raw=True)
        parsed = []
        for line in text.splitlines():
            tokens = shlex.split(line)
            if not tokens:
                continue
            if tokens[0] == 'config':
                parsed.append({'.type': tokens[1], '.name': tokens[2]})
            elif tokens[0] == 'option':
                parsed[-1][tokens[1]] = tokens[2]
            else:
                parsed[-1].setdefault(tokens[1], []).append(tokens[2])
        self.assertEqual(parsed[1]['name'], original[1]['name'])
        self.assertFalse(invoke('migrate', parsed)['changed'])

    def test_adlist_filename_collisions_and_secure_sources(self):
        rules = [{'.type': 'rule', '.name': 'ad1', 'mode': 'builtin', 'builtin_type': 'adblock', 'ad_source': ['https://one.example/ads.txt']},
                 {'.type': 'rule', '.name': 'ad2', 'mode': 'builtin', 'builtin_type': 'adblock', 'ad_source': ['https://two.example/ads.txt']}]
        with self.assertRaises(subprocess.CalledProcessError):
            invoke('generate', sections() + rules)
        rules[1]['ad_source'] = rules[0]['ad_source']
        invoke('generate', sections() + rules)
        for invalid in ['http://one.example/ads.txt', 'https://one.example/list?query=yes', 'https://bad host/ads.txt', 'file://relative.txt']:
            rules[0]['ad_source'] = [invalid]
            with self.assertRaises(subprocess.CalledProcessError):
                invoke('generate', sections() + rules[:1])

    def test_migration_repairs_missing_or_multiple_defaults_idempotently(self):
        for flags, expected in [(['0', '0'], 'group_a'), (['1', '1'], 'group_b')]:
            data = sections()
            data[0]['schema_version'] = '2'
            data[1]['is_default'] = flags[0]
            data += [{'.type': 'dns_group', '.name': 'group_b', 'name': 'B', 'dns': ['1.1.1.1'], 'is_default': flags[1]}]
            result = invoke('migrate', data)
            self.assertTrue(result['changed'])
            self.assertTrue(result['warnings'])
            self.assertEqual([s['.name'] for s in result['sections'] if s.get('is_default') == '1'], [expected])
            self.assertFalse(invoke('migrate', result['sections'])['changed'])
            invoke('generate', result['sections'])

    def test_log_paths_reject_traversal_and_protected_locations(self):
        for path in ['/etc/config/network', '/var/log/../config/mosdns', '/tmp/log/../../etc/passwd', '/var/log/evil\nname', '/var/log/']:
            data = sections()
            data[0]['log_file'] = path
            with self.assertRaises(subprocess.CalledProcessError):
                invoke('generate', data)
        for path in ['/var/log/mosdns.log', '/tmp/log/mosdns.log']:
            data = sections()
            data[0]['log_file'] = path
            self.assertEqual(invoke('generate', data)['log']['file'], path)

    def test_original_fork_config_fixture(self):
        data = parse_uci((HERE / 'test_v2_old_fork.conf').read_text())
        result = plugins(invoke('generate', data))
        main = result['main_sequence']['args']
        self.assertEqual(main[:2], [{'exec': '$lazy_cache'}, {'matches': 'has_resp', 'exec': 'accept'}])
        self.assertEqual(result['dns_group_dns_cn']['args']['upstreams'][0]['addr'], '223.5.5.5')
        self.assertEqual(result['dns_group_dns_global']['args']['upstreams'][0]['addr'], '8.8.8.8')
        self.assertNotIn('stats_collector', result)
        self.assertFalse(invoke('migrate', data)['changed'])
        self.assertEqual(invoke('generate', parse_uci(invoke('serialize', data, raw=True))), invoke('generate', data))

    def test_original_upstream_fixture_migration_and_streaming_file(self):
        data = parse_uci((HERE / 'test_v2_upstream.conf').read_text())
        result = invoke('migrate', data)
        self.assertTrue(result['changed'])
        self.assertFalse(invoke('migrate', result['sections'])['changed'])
        compiled = plugins(invoke('generate', result['sections'], ['223.5.5.5']))
        self.assertIn('stats_collector', compiled)
        self.assertIn({'exec': 'jump rule_exec_rule_redirect'}, compiled['main_sequence']['args'])
        reparsed = parse_uci(invoke('serialize', result['sections'], raw=True))
        self.assertEqual(invoke('generate', result['sections'], ['223.5.5.5']), invoke('generate', reparsed, ['223.5.5.5']))
        stream = invoke('migrate', data, legacy={'streaming_rules': True})
        custom = next(s for s in stream['sections'] if s['.name'] == 'rule_stream')
        self.assertEqual(custom['mode'], 'custom')
        self.assertEqual(custom['rule_file'], '/etc/mosdns/rule/streaming.txt')

    def test_upstream_migration_preserves_legacy_routing_priority(self):
        data = parse_uci((HERE / 'test_v2_upstream.conf').read_text())
        data[0].update(adblock='1', apple_optimization='1', custom_stream_media_dns='1')
        result = invoke('migrate', data)
        expected = ['rule_hosts', 'rule_redirect', 'rule_apple', 'rule_ddns', 'rule_whitelist',
                    'rule_blocklist', 'rule_adblock', 'rule_ptr', 'rule_greylist', 'rule_stream',
                    'rule_cn', 'rule_global']
        self.assertEqual([s['.name'] for s in result['sections'] if s['.type'] == 'rule'], expected)
        compiled = plugins(invoke('generate', result['sections'], ['223.5.5.5']))
        executions = [r['exec'] for r in compiled['main_sequence']['args']]
        positions = [executions.index(('jump ' if sid == 'rule_redirect' else '$') + 'rule_exec_' + sid)
                     for sid in expected]
        self.assertEqual(positions, sorted(positions))
        self.assertEqual(compiled['rule_set_rule_blocklist']['type'], 'domain_set')
        self.assertFalse(invoke('migrate', result['sections'])['changed'])

    def test_existing_legacy_and_v2_rule_order_is_not_rebuilt(self):
        for schema in [None, '2']:
            data = sections()
            if schema:
                data[0]['schema_version'] = schema
            original = [{'.type': 'rule', '.name': 'last_first', 'mode': 'blacklist', 'rule_file': 'own.txt'},
                        {'.type': 'rule', '.name': 'first_last', 'mode': 'hosts', 'rule_file': 'shared.txt'}]
            result = invoke('migrate', data + original)
            self.assertEqual([s for s in result['sections'] if s['.type'] == 'rule'], original)
            self.assertFalse(invoke('migrate', result['sections'])['changed'])

    def test_legacy_mapping_conversion_preserves_existing_mappings(self):
        data = sections()
        data[0].update(schema_version='2', response_ip_map='1', response_ip_map_file='old.txt', response_ip_map_target=['1.2.3.4'])
        data += [{'.type': 'ip_map', '.name': 'existing', 'name': 'My mapping', 'rule_file': 'own.txt', 'ip_map_target': ['::1'], 'continue_match': '0'},
                 {'.type': 'rule', '.name': 'oldrule', 'mode': 'ip_map', 'rule_file': 'oldrule.txt', 'ip_map_target': ['8.8.8.8']}]
        result = invoke('migrate', data)
        self.assertEqual(result['sections'][2], data[2])
        self.assertEqual(result['sections'][3]['.type'], 'ip_map')
        self.assertEqual(result['sections'][3]['rule_file'], 'oldrule.txt')
        self.assertEqual(result['sections'][-1]['rule_file'], 'old.txt')
        self.assertNotIn('response_ip_map', result['sections'][0])
        self.assertFalse(invoke('migrate', result['sections'])['changed'])

    def test_legacy_migration_preserves_explicit_stats_and_prefetch(self):
        data = [{'.type': 'mosdns', '.name': 'config', 'remote_dns': ['tls://1.1.1.1'], 'stats_collector': '1', 'prefetch': '1'}]
        result = invoke('migrate', data)
        self.assertTrue(result['changed'])
        self.assertFalse(invoke('migrate', result['sections'])['changed'])
        generated = plugins(invoke('generate', result['sections'], ['223.5.5.5']))
        self.assertIn('stats_collector', generated)
        self.assertTrue(generated['lazy_cache']['args']['prefetch'])


class NodeMigrationShimTests(unittest.TestCase):
    def test_migration_order_with_js_shims_not_native_validation(self):
        node = os.environ.get('NODE_BIN') or shutil.which('node')
        if not node:
            self.skipTest('Node unavailable for explicitly non-native migration shim test')
        script = r'''
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const root = process.argv[1];
const helpers = {
    type: v => Array.isArray(v) ? 'array' : v == null ? null : typeof v,
    length: v => v == null ? 0 : v.length,
    split: (v, s) => v.split(s), replace: (v, r, s) => v.replace(r, s),
    index: (v, s) => v.indexOf(s), match: (v, r) => r.exec(v),
    substr: (v, i, n) => v.substr(i, n), join: (s, a) => a.join(s),
    push: (a, ...v) => a.push(...v), filter: (a, f) => a.filter(f), keys: Object.keys,
    die: s => { throw Error(s); }
};
const code = ['v2-config.uc', 'v2-migrate.uc'].map(name =>
    fs.readFileSync(root + '/' + name, 'utf8').replace(/^import .*$/mg, '').replace(/export /g, '')).join('\n');
const core = vm.runInNewContext('(function(){' + code + ';return {migrate,generate};})()', helpers);
const input = [{'.type':'mosdns','.name':'config',adblock:'1',apple_optimization:'1',custom_stream_media_dns:'1'}];
const migrated = core.migrate(input);
const expected = ['rule_hosts','rule_redirect','rule_apple','rule_ddns','rule_whitelist','rule_blocklist',
    'rule_adblock','rule_ptr','rule_greylist','rule_stream','rule_cn','rule_global'];
assert.equal(JSON.stringify(migrated.sections.filter(s => s['.type'] === 'rule').map(s => s['.name'])), JSON.stringify(expected));
assert.equal(core.migrate(migrated.sections).changed, false);
const config = core.generate(migrated.sections, ['223.5.5.5']);
assert.equal(config.plugins.find(p => p.tag === 'rule_set_rule_blocklist').type, 'domain_set');
for (const schema of [null, '2']) {
    const original = [{'.type':'mosdns','.name':'config',schema_version:schema},
        {'.type':'dns_group','.name':'main',is_default:'1',dns:['8.8.8.8']},
        {'.type':'rule','.name':'z',mode:'blacklist',rule_file:'own.txt'},
        {'.type':'rule','.name':'a',mode:'hosts',rule_file:'own.txt'}];
    assert.equal(JSON.stringify(core.migrate(original).sections.slice(2)), JSON.stringify(original.slice(2)));
}
console.log('PASS: Node migration shims; no native ucode/libuci or Go regexp validation claimed');
'''
        result = subprocess.run([node, '-e', script, str(HERE.parent / 'luci-app-mosdns/root/usr/share/mosdns')],
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('PASS: Node migration shims', result.stdout)


if __name__ == '__main__':
    unittest.main(verbosity=2)
