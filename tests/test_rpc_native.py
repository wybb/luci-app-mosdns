#!/usr/bin/env python3
"""Compile RPC/maintenance and fault-inject actual ucode rule-write implementation.
Set UCODE to an installed ucode executable. Requires its standard fs module.
UCI/ubus fixture modules are compilation-only; no router state is accessed.
"""
import os, pathlib, shutil, subprocess, tempfile
root = pathlib.Path(__file__).resolve().parents[1]
binary = os.environ.get('UCODE') or shutil.which('ucode')
if not binary:
    raise SystemExit('Set UCODE to a native ucode interpreter to run these tests.')
rpc = root / 'luci-app-mosdns/root/usr/share/rpcd/ucode/luci.mosdns'
maintenance = root / 'luci-app-mosdns/root/usr/share/mosdns/mosdns.uc'
with tempfile.TemporaryDirectory(prefix='mosdns-rpc-') as directory:
    d = pathlib.Path(directory)
    (d/'uci.uc').write_text('export function cursor() { return {}; }\n')
    (d/'ubus.uc').write_text('export function connect() { return {}; }\n')
    for source in (rpc, maintenance):
        subprocess.run([binary, '-L', str(d), '-c', '-o', str(d/'compiled'), str(source)], check=True)
    source = rpc.read_text()
    implementation = source[source.index('function write_rule_file('):source.index('function read_rule_file(')]
    harness = r'''
let files = {};
let mode = '';
let renames = 0;
function exec_sys(command) { return {code:0,stdout:'/etc/mosdns/rule/.write-Ab1234'}; }
function writefile(path, content) { if (mode == 'write') return null; files[path] = mode == 'corrupt' ? content + 'bad' : content; return length(content); }
function readfile(path) { return files[path]; }
function stat(path) { return files[path] === null ? null : {}; }
function rename(source, target) { renames++; if (mode == 'rename') return false; files[target] = files[source]; delete files[source]; return true; }
function unlink(path) { delete files[path]; return true; }
function rmdir(path) { return true; }
''' + implementation + r'''
for (let failure in ['write', 'corrupt', 'rename']) {
 mode = failure; files = {}; renames = 0;
 let result = write_rule_file({section:'cfg001',content:'example.com\n'});
 assert(result.success === false, 'Failure must propagate: ' + failure);
 assert(length(keys(files)) == 0, 'Temporary files must be removed');
 if (failure != 'rename') assert(renames == 0, 'Never publish an unverified write');
}
for (let content in ['', 'example.com\n', '域名\n']) {
 mode = ''; files = {}; renames = 0;
 let result = write_rule_file({section:'cfg001',content:content});
 assert(result.success === true, 'Valid write must succeed');
 assert(files[result.rule_file] === content, 'Published content must match');
}
for (let section in ['../escape', 'x;touch /tmp/pwn', ''])
 assert(write_rule_file({section:section,content:'a'}).success === false, 'Invalid section');
assert(write_rule_file({section:'valid',content:'a\x00b'}).success === false, 'NUL must be rejected');
print('Native ucode compile and rule-file fault-injection tests passed\n');
'''
    (d/'test.uc').write_text(harness)
    subprocess.run([binary, str(d/'test.uc')], check=True)
    maintenance_source = maintenance.read_text()
    export_function = maintenance_source[maintenance_source.index('function v2dat_dump()'):maintenance_source.index('function restore_rule_defaults')]
    staging_test = r'''
let commands = [];
function checked(command) { push(commands, command); return command == 'mktemp -d' ? '/tmp/extraction-fixture' : ''; }
function shell_quote(value) { return "'" + replace('' + value, /'/g, "'\"'\"'") + "'"; }
function cursor() { return {load: () => true, get: (package, section, key) => key == 'schema_version' ? '2' : null, foreach: () => true}; }
function ad_settings(c) { return {enabled:false,sources:[]}; }
function to_array(value) { return []; }
''' + export_function + r'''
v2dat_dump();
let publication = filter(commands, command => index(command, 'for file in ') === 0)[0];
assert(index(publication, "dest='/tmp/mosdns-stage-check'") >= 0, 'Must publish into staging directory');
assert(index(publication, '/var/mosdns') < 0, 'Staged export must not mutate live geodata');
print('Native geodata staging-isolation test passed\n');
'''
    (d/'stage.uc').write_text(staging_test)
    subprocess.run([binary, str(d/'stage.uc')], check=True, env={**os.environ, 'MOSDNS_GEODATA_DIR':'/tmp/mosdns-stage-check'})
    updater = maintenance_source[maintenance_source.index('function update_adlist('):maintenance_source.index('function update_geodat(')]
    remote_name = maintenance_source[maintenance_source.index('function remote_name('):maintenance_source.index('function interface_dns(')]
    prepare_test = r'''
let sources = ['https://one.example/existing.txt', 'https://two.example/new.txt'];
let commands = [], copies = [], writes = 0, reloads = 0;
function cursor() { return {load:()=>true,get:()=>''}; }
function ad_settings(c) { return {enabled:true,sources:sources}; }
function mkdir(path, mode) { return true; }
function rmdir(path) { return true; }
function stat(path) { return path == '/etc/mosdns/rule/adlist/existing.txt' ? {} : null; }
function checked(command) { push(commands, command); return command == 'mktemp -d' ? '/tmp/download-fixture' : ''; }
function shell_quote(value) { return "'" + replace('' + value, /'/g, "'\"'\"'") + "'"; }
function atomic_copy(source, target) { push(copies, target); }
function exec_sys(command) { return {code:0,stdout:''}; }
function writefile(path, data) { writes++; return length(data); }
function reload_service() { reloads++; }
let stdout = {flush:()=>true};
''' + remote_name + updater + r'''
assert(update_adlist(true) === true, 'Missing list must be prepared');
assert(length(copies) == 1 && copies[0] == '/etc/mosdns/rule/adlist/new.txt', 'Never replace an existing live list');
assert(length(filter(commands, command => index(command, 'wget ') === 0)) == 1, 'Download only missing sources');
assert(writes == 0 && reloads == 0, 'No manifest write or reload during preparation');
sources = ['https://one.example/collision.txt', 'https://two.example/collision.txt'];
copies = []; let failed = false;
try { update_adlist(true); } catch (e) { failed = true; }
assert(failed && length(copies) == 0, 'Distinct URL basename collision must fail before publication');
sources = ['http://one.example/insecure.txt']; failed = false;
try { update_adlist(true); } catch (e) { failed = true; }
assert(failed, 'HTTPS is required');
print('Native missing-only adlist preparation tests passed\n');
'''
    (d/'prepare.uc').write_text(prepare_test)
    subprocess.run([binary, str(d/'prepare.uc')], check=True)
    import json
    logs = d/'logs'
    logs.mkdir()
    marker = d/'private-marker'
    marker.write_text('PRIVATE_MARKER_DO_NOT_READ_OR_TRUNCATE')
    logfile = logs/'mosdns.log'
    logfile.write_text('L' * 300000)
    (logs/'escape.log').symlink_to(marker)
    rpc_source = rpc.read_text()
    log_helper = rpc_source[rpc_source.index('function open_log_file('):rpc_source.index('function parse_json_safe(')]
    log_helper = log_helper.replace("'/var/log/'", json.dumps(str(logs)+'/')).replace("'/tmp/log/'", json.dumps(str(d/'alternate-logs')+'/'))
    log_methods = rpc_source[rpc_source.index('\tprint_log: {'):rpc_source.index('\n\tget_version:')]
    log_test = '''import { open as fs_open, stat, realpath, readfile, writefile, rename, symlink } from 'fs';
let requested = null, race = false;
let marker = MARKER, logfile = LOGFILE;
function get_logfile_path_internal() { return requested; }
function open(path, mode) {
 if (race) { race = false; rename(path, path + '.saved'); symlink(marker, path); }
 return fs_open(path, mode);
}
'''.replace('MARKER', json.dumps(str(marker))).replace('LOGFILE',json.dumps(str(logfile))) + log_helper + '\nconst methods = {\n' + log_methods + '\n};\n' + r'''
requested = marker;
assert(methods.print_log.call().error, 'Arbitrary root path read must be rejected');
assert(methods.clean_log.call().success === false, 'Arbitrary root path truncate must be rejected');
requested = LOGDIR + '/escape.log';
assert(methods.print_log.call().error, 'Symlink escape read must be rejected');
assert(methods.clean_log.call().success === false, 'Symlink escape truncate must be rejected');
requested = LOGDIR + '/';
assert(methods.print_log.call().error, 'Directories must be rejected');
requested = logfile;
let output = methods.print_log.call();
assert(length(output.log) == 262144 && output.truncated === true, 'Log response must be capped');
assert(methods.clean_log.call().success === true && readfile(logfile) == '', 'Allowed regular log can be cleared');
writefile(logfile, 'original log');
race = true;
assert(methods.clean_log.call().success === false, 'Symlink swap between validation and open must be rejected');
assert(readfile(marker) == 'PRIVATE_MARKER_DO_NOT_READ_OR_TRUNCATE', 'Private marker must remain unchanged');
print('Native log containment, cap, and descriptor-race marker tests passed\n');
'''.replace('LOGDIR',json.dumps(str(logs)))
    (d/'logs.uc').write_text(log_test)
    subprocess.run([binary, str(d/'logs.uc')], check=True)
