#!/usr/bin/ucode
'use strict';

import { cursor } from 'uci';
import { readfile, writefile, rename, unlink, stat, lstat, realpath, chmod, popen, stderr } from 'fs';
import { generate, values } from './v2-config.uc';
import { migrate, serialize } from './v2-migrate.uc';

function fail(message) { stderr.write('mosdns v2: ' + message + '\n'); exit(1); }

try {
	let command = ARGV[0];
	if (index(['generate', 'migrate', 'manifest'], command) < 0) fail('Usage: v2.uc generate|migrate|manifest');
	let uci = cursor(), sections = [];
	if (!uci.load('mosdns')) fail('Cannot load /etc/config/mosdns');
	uci.foreach('mosdns', null, s => push(sections, s));
	if (command == 'migrate') {
		let streaming = readfile('/etc/mosdns/rule/streaming.txt') || '';
		let has_streaming = false;
		let lines = split(streaming, '\n');
		for (let i = 0; i < length(lines); i++)
			if (match(lines[i], /^[ \t]*[^# \t\r\n]/)) has_streaming = true;
		let migrated = migrate(sections, { streaming_rules: has_streaming });
		if (!migrated.changed) exit(0);
		let path = '/etc/config/mosdns', backup = path + '.pre-v2', temporary = path + '.v2-new';
		let original = readfile(path);
		if (original == null) fail('Cannot read configuration for backup');
		if (!stat(backup)) {
			let staged_backup = backup + '.new';
			if (writefile(staged_backup, original) != length(original) || !chmod(staged_backup, 0600) || !rename(staged_backup, backup)) { unlink(staged_backup); fail('Cannot create migration backup'); }
		}
		if (readfile(backup) == null) fail('Existing migration backup is unreadable');
		let data = serialize(migrated.sections);
		if (writefile(temporary, data) != length(data) || !chmod(temporary, 0600)) { unlink(temporary); fail('Cannot stage migration'); }
		if (!rename(temporary, path)) { unlink(temporary); fail('Cannot publish migration'); }
		for (let i = 0; i < length(migrated.warnings); i++) stderr.write('mosdns v2: ' + migrated.warnings[i] + '\n');
		stderr.write('mosdns v2: migrated configuration; original backup: ' + backup + '; rule files untouched\n');
		exit(0);
	}
	let default_dns = [];
	for (let i = 0; i < length(sections); i++) {
		let s = sections[i];
		if (s['.type'] == 'dns_group' && s.use_default_dns == '1') {
			let p = popen('/usr/share/mosdns/mosdns.uc default_dns', 'r');
			if (!p) fail('Cannot query interface DNS');
			default_dns = values(p.read('all'));
			if (p.close() != 0) fail('Interface DNS lookup failed');
			break;
		}
	}
	let config = generate(sections, default_dns), files = ['/etc/config/mosdns'];
	// Validate actual locations too: lexical prefixes alone permit symlink escapes.
	let log_file = config.log.file, log_root = index(log_file, '/var/log/') == 0 ? '/var/log' : '/tmp/log';
	let actual_root = realpath(log_root), parent = replace(log_file, /\/[^/]+$/, ''), actual_parent = realpath(parent);
	function in_root(path) { return path && actual_root && (path == actual_root || index(path, actual_root + '/') == 0); }
	if (!in_root(actual_parent)) fail('Log parent directory missing or outside approved log directory');
	if (lstat(log_file) && !in_root(realpath(log_file))) fail('Log file symlink escapes approved log directory');

	for (let i = 0; i < length(config.plugins); i++) {
		let plugin = config.plugins[i];
		if (type(plugin.args) != 'object' || !plugin.args.files) continue;
		for (let j = 0; j < length(plugin.args.files); j++) {
			let file = plugin.args.files[j];
			let physical = file, geodata = getenv('MOSDNS_GEODATA_DIR');
			if (geodata && index(file, '/var/mosdns/') == 0) physical = geodata + '/' + substr(file, 12);
			if (readfile(physical) == null) fail('Rule file missing or unreadable: ' + file);
			if (index(files, file) < 0) push(files, file);
		}
	}
	for (let i = 0; i < length(sections); i++) {
		let s = sections[i];
		if (s['.type'] != 'mosdns' || s['.name'] != 'config') continue;
		if (+s.minimal_ttl > 0 || +s.maximum_ttl > 0 || s.enable_ecs_remote == '1' || s.reject_type65 == '1' || s.dns_leak == '1')
			stderr.write('mosdns v2: legacy global TTL/ECS/type-65/leak options remain inactive, as in the previous v2 generator; use explicit per-rule TTL/IP strategy settings\n');
	}
	print(command == 'manifest' ? join('\n', files) + '\n' : sprintf('%J\n', config));
} catch (e) { fail(e.message || '' + e); }
