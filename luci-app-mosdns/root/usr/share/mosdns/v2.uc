#!/usr/bin/ucode
'use strict';

import { cursor } from 'uci';
import { readfile, writefile, rename, unlink, stat, lstat, realpath, chmod, popen, rmdir, stderr } from 'fs';
import { generate, values, rule_path } from './v2-config.uc';
import { migrate, serialize } from './v2-migrate.uc';

function fail(message) { stderr.write('mosdns v2: ' + message + '\n'); exit(1); }

function shell_quote(value) {
	return "'" + replace(value, /'/g, "'\"'\"'") + "'";
}

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
		let sanitize = true;
		for (let i = 0; i < length(sections); i++)
			if (sections[i]['.type'] == 'mosdns' && sections[i]['.name'] == 'config' && sections[i].blacklist_migration_version == '1') sanitize = false;
		let migrated = migrate(sections, { streaming_rules: has_streaming });
		if (!migrated.changed && !sanitize) exit(0);
		let path = '/etc/config/mosdns', backup = path + '.pre-v2', temporary = path + '.v2-new';
		let original = readfile(path);
		if (original == null) fail('Cannot read configuration for backup');
		if (!stat(backup)) {
			let staged_backup = backup + '.new';
			if (writefile(staged_backup, original) != length(original) || !chmod(staged_backup, 0600) || !rename(staged_backup, backup)) { unlink(staged_backup); fail('Cannot create migration backup'); }
		}
		if (readfile(backup) == null) fail('Existing migration backup is unreadable');
		let copies = [], complete = true;
		try {
			if (sanitize) {
				for (let i = 0; i < length(migrated.sections); i++) {
					let s = migrated.sections[i];
					if (s['.type'] != 'rule' || s.mode != 'blacklist' || s.blacklist_type == 'ptr') continue;
					let source = rule_path(s.rule_file, 'rule-' + s['.name'] + '.txt'), content = readfile(source);
					if (content == null) {
						complete = false;
						push(migrated.warnings, 'Blacklist reference preserved; file missing or unreadable: ' + source);
						continue;
					}
					let native = popen('/usr/bin/mosdns sanitize-domain-set --file ' + shell_quote(source) + ' 2>/dev/null', 'r');
					if (!native) die('Cannot start native blacklist sanitizer: ' + source);
					let output = native.read('all'), status = native.close();
					if (status != 0) die('Native blacklist sanitizer failed: ' + source);
					let sanitized = json(output);
					if (type(sanitized) != 'object' || type(sanitized.content) != 'string' || type(sanitized.count) != 'int' ||
						sanitized.count < 0 || sanitized.count > length(split(content, '\n')) ||
						length(sanitized.content) != length(content) + sanitized.count * length('# mosdns v2 migration: unsupported domain_set line: ') ||
						readfile(source) !== content || (!sanitized.count && sanitized.content !== content)) die('Invalid native blacklist sanitizer result: ' + source);
					if (!sanitized.count) continue;
					let root = '/etc/mosdns/rule/', p = popen('mktemp -d ' + root + '.migrate-XXXXXX', 'r');
					if (!p) die('Cannot create blacklist migration directory');
					let directory = replace(p.read('all') || '', /\s+$/, ''), code = p.close();
					if (code != 0 || index(directory, root + '.migrate-') != 0 || !match(substr(directory, length(root)), /^\.migrate-[A-Za-z0-9]+$/)) die('Cannot create blacklist migration directory');
					let staged = directory + '/content.new', target = directory + '/content.txt';
					push(copies, { directory: directory, staged: staged, target: target });
					if (writefile(staged, sanitized.content) != length(sanitized.content) || readfile(staged) !== sanitized.content ||
						!chmod(staged, 0644) || !chmod(directory, 0755) || !rename(staged, target)) die('Cannot publish migrated blacklist: ' + source);
					s.rule_file = target;
					migrated.changed = true;
					push(migrated.warnings, 'Commented ' + sanitized.count + ' unsupported domain_set lines from ' + source + '; migrated copy: ' + target);
				}
			}
			if (sanitize && complete) {
				for (let i = 0; i < length(migrated.sections); i++)
					if (migrated.sections[i]['.type'] == 'mosdns' && migrated.sections[i]['.name'] == 'config') migrated.sections[i].blacklist_migration_version = '1';
				migrated.changed = true;
			}
			if (migrated.changed) {
				let data = serialize(migrated.sections);
				if (writefile(temporary, data) != length(data) || readfile(temporary) !== data || !chmod(temporary, 0600)) die('Cannot stage migration');
				if (!rename(temporary, path)) die('Cannot publish migration');
			}
		} catch (e) {
			unlink(temporary);
			for (let i = 0; i < length(copies); i++) {
				unlink(copies[i].staged);
				unlink(copies[i].target);
				rmdir(copies[i].directory);
			}
			die(e.message || '' + e);
		}
		for (let i = 0; i < length(migrated.warnings); i++) stderr.write('mosdns v2: ' + migrated.warnings[i] + '\n');
		stderr.write('mosdns v2: migrated configuration; original backup: ' + backup + '; original rule files untouched\n');
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
