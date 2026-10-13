#!/usr/bin/env ucode
'use strict';
// Only the first dnsmasq instance is changed. A JSON snapshot preserves option
// absence and every server entry; never source a legacy lock as shell code.
import { cursor } from 'uci';
import { readfile, writefile, rename, unlink, stat, mkdir } from 'fs';
const path = '/etc/mosdns/dnsmasq-backup.json';
const keys = ['server', 'noresolv', 'rebind_protection', 'cachesize'];
let u = cursor();
u.load('dhcp');
let sid;
u.foreach('dhcp', 'dnsmasq', s => { if (!sid) sid = s['.name']; });
function fail(message) { die(`mosdns redirect: ${message}\n`); }
function put(section, key, value) {
	if (value == null) u.delete('dhcp', section, key);
	else if (!u.set('dhcp', section, key, value)) fail(`cannot stage ${key}`);
}
function commit() { if (!u.save('dhcp') || !u.commit('dhcp')) fail('cannot commit DHCP changes; backup retained'); }
let action = ARGV[0];
let raw = readfile(path);
let backup = raw ? json(raw) : null;
if (!backup && stat('/etc/mosdns/redirect.lock'))
	fail('Legacy redirect.lock has no recoverable original DNS server list. Restore dnsmasq DNS settings and archive that lock before migration; it was left untouched.');
if (action == 'check') exit(0);
if (action == 'restore') {
	if (!backup) exit(0);
	if (!backup.section || type(backup.values) != 'object') fail('invalid backup');
	if (!u.get('dhcp', backup.section)) fail('original dnsmasq section is missing; backup retained');
	for (let key in keys) put(backup.section, key, backup.values[key]);
	commit();
	if (!unlink(path)) fail('restored, but could not remove backup');
	exit(0);
}
if (action != 'apply') fail('expected apply or restore');
let port = ARGV[1];
if (!match(port || '', /^[0-9]+$/) || +port < 1 || +port > 65535) fail('invalid DNS port');
if (!sid) fail('no dnsmasq instance');
if (!backup) {
	// An old upstream redirect.lock cannot recover deleted server lists. Keep it
	// for manual recovery; never silently overwrite its historical evidence.
	backup = {section: sid, values: {}};
	for (let key in keys) backup.values[key] = u.get('dhcp', sid, key);
	mkdir('/etc/mosdns', 0755);
	let tmp = path + '.tmp';
	let text = sprintf('%J\n', backup);
	if (writefile(tmp, text) != length(text) || !rename(tmp, path)) fail('could not persist backup; DHCP is unchanged');
} else if (backup.section != sid) fail('dnsmasq section changed; restore original snapshot first');
put(sid, 'server', [`127.0.0.1#${port}`]);
put(sid, 'noresolv', '1');
put(sid, 'rebind_protection', '0');
put(sid, 'cachesize', '0');
commit();
