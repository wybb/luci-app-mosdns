#!/usr/bin/env ucode

'use strict';

import { popen, mkdir, unlink, writefile, open, stat, stdout, readfile, rename, rmdir } from 'fs';
import { cursor } from 'uci';
import { connect } from 'ubus';

function to_array(val) {
	let res =[];
	if (type(val) == 'array') {
		for (let i = 0; i < length(val); i++) {
			if (type(val[i]) == 'string') {
				let s = replace(val[i], /^\s+|\s+$/g, '');
				if (s != "") push(res, s);
			}
		}
	} else if (type(val) == 'string') {
		let parts = split(val, /[ \t\n]+/);
		for (let i = 0; i < length(parts); i++) {
			if (parts[i] != "") push(res, parts[i]);
		}
	}
	return res;
}

function exec_sys(cmd) {
	let p = popen(cmd + " 2>&1", "r");
	if (!p) return { code: -1, stdout: "" };
	let stdout = p.read("all");
	let code = p.close();
	if (type(stdout) == 'string') {
		stdout = replace(stdout, /^\s+|\s+$/g, '');
	}
	return { code: code, stdout: stdout || "" };
}

function shell_quote(value) {
	return "'" + replace('' + value, /'/g, "'\"'\"'") + "'";
}

function checked(cmd) {
	let res = exec_sys(cmd);
	if (res.code !== 0) die('Command failed: ' + res.stdout);
	return res.stdout;
}

function reload_service() {
	checked('/etc/init.d/mosdns reload');
}

// Copy to a same-directory temporary file, then atomically publish. Never
// remove a live/custom file to make room for a replacement.
function atomic_copy(source, target) {
	let tmp = checked('mktemp ' + shell_quote(target + '.XXXXXX'));
	let res = exec_sys('cp ' + shell_quote(source) + ' ' + shell_quote(tmp) +
		' && chmod ' + (index(target, '/etc/config/') === 0 ? '0600' : '0644') + ' ' + shell_quote(tmp));
	if (res.code !== 0 || !rename(tmp, target)) {
		unlink(tmp);
		die('Could not publish ' + target);
	}
}

function remote_name(url) {
	if (!match(url, /^https:\/\/[^ \t\r\n]+$/)) die('Only HTTPS adlist sources are supported.');
	let parts = split(url, '/');
	let name = parts[length(parts) - 1];
	if (!match(name, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/)) die('Invalid adlist filename.');
	return name;
}

function interface_dns(wan_only) {
	let uci_cursor = cursor();
	uci_cursor.load('mosdns');
	let dns_list =[];

	if (!wan_only && uci_cursor.get('mosdns', 'config', 'custom_local_dns') === '1') {
		dns_list = to_array(uci_cursor.get('mosdns', 'config', 'local_dns'));
	} else {
		uci_cursor.load('network');
		let peerdns = uci_cursor.get('network', 'wan', 'peerdns');
		let proto = uci_cursor.get('network', 'wan', 'proto');

		if (peerdns === '0' || proto === 'static') {
			dns_list = to_array(uci_cursor.get('network', 'wan', 'dns'));
		} else {
			let ubus_conn = connect();
			if (ubus_conn) {
				let status = ubus_conn.call('network.interface.wan', 'status');
				if (status && type(status['dns-server']) == 'array' && length(status['dns-server']) > 0) {
					dns_list = status['dns-server'];
				}
			}
		}
	}

	if (length(dns_list) === 0) {
		dns_list =['119.29.29.29', '223.5.5.5'];
	}
	print(join(" ", dns_list) + "\n");
}

function ad_settings(c) {
	let enabled = false;
	let sources = [];
	if (c.get('mosdns', 'config', 'schema_version') === '2') {
		c.foreach('mosdns', 'rule', function(rule) {
			if (rule.enabled !== '0' && rule.mode == 'builtin' && rule.builtin_type == 'adblock') {
				enabled = true;
				for (let source in to_array(rule.ad_source || 'geosite.dat')) {
					if (index(sources, source) < 0) push(sources, source);
				}
			}
		});
	} else {
		enabled = c.get('mosdns', 'config', 'adblock') === '1';
		sources = to_array(c.get('mosdns', 'config', 'ad_source'));
	}
	return { enabled: enabled, sources: sources };
}

function get_adlist() {
	let uci_cursor = cursor();
	uci_cursor.load('mosdns');
	let ads = ad_settings(uci_cursor);
	let adblock = ads.enabled ? '1' : '0';

	if (adblock !== '1') {
		mkdir('/var/mosdns', 0755);
		// Existing files may still be referenced by custom YAML or other rules.
		writefile('/var/mosdns/disable-ads.txt', '');
		print("/var/mosdns/disable-ads.txt\n");
		return;
	}

	mkdir('/etc/mosdns/rule/adlist', 0755);
	let ad_source = ads.sources;
	let adlist =[];

	for (let i = 0; i < length(ad_source); i++) {
		let url = ad_source[i];
		if (!url) continue;

		if (url === 'geosite.dat') {
			push(adlist, '/var/mosdns/geosite_category-ads-all.txt');
		} else if (index(url, 'file://') === 0) {
			push(adlist, substr(url, 7));
		} else {
			let filename = remote_name(url);
			let local_path = `/etc/mosdns/rule/adlist/${filename}`;
			if (!stat(local_path)) {
				writefile(local_path, '');
			}
			push(adlist, local_path);
		}
	}
	print(join("\n", adlist) + "\n");
}

function update_adlist(missing_only) {
	let uci_cursor = cursor();
	uci_cursor.load('mosdns');
	let ads = ad_settings(uci_cursor);
	if (!ads.enabled) return false;
	let lock = '/var/lock/mosdns_ad_update.lock';
	if (!mkdir(lock, 0700)) die('Another adlist update is already in progress.');
	let tmpdir = null;
	let changed = false;
	try {
		tmpdir = checked('mktemp -d');
		let sources = ads.sources;
		let proxy = uci_cursor.get('mosdns', 'config', 'github_proxy') || '';
		let files = [];
		let names = {};
		let manifest = '';
		for (let url in sources) {
			if (url == 'geosite.dat' || index(url, 'file://') === 0) continue;
			let name = remote_name(url);
			if (names[name]) die('Duplicate adlist filename: ' + name);
			names[name] = true;
			// First-enable preparation never changes an existing live list.
			if (missing_only && stat('/etc/mosdns/rule/adlist/' + name)) continue;
			let mirror = match(url, /^https:\/\/raw\.githubusercontent\.com\//) && proxy ? proxy + '/' : '';
			let destination = mirror + url;
			if (!match(destination, /^https:\/\//)) die('The update proxy must use HTTPS.');
			print('Downloading ' + destination + '\n');
			stdout.flush();
			checked('wget -4 -q -T 90 -O ' + shell_quote(tmpdir + '/' + name) + ' ' + shell_quote(destination));
			push(files, name);
			manifest += url + '\n';
		}
		mkdir('/etc/mosdns/rule/adlist', 0755);
		for (let name in files) {
			if (missing_only && stat('/etc/mosdns/rule/adlist/' + name)) continue;
			atomic_copy(tmpdir + '/' + name, '/etc/mosdns/rule/adlist/' + name);
			changed = true;
		}
		if (!missing_only) {
			if (writefile(tmpdir + '/manifest', manifest) !== length(manifest)) die('Could not write adlist manifest.');
			atomic_copy(tmpdir + '/manifest', '/etc/mosdns/rule/.ad_source');
		}
	} catch (e) {
		if (tmpdir) exec_sys('rm -rf ' + shell_quote(tmpdir));
		rmdir(lock);
		// A partial multi-file publication still invalidates live cached answers.
		if (changed && !missing_only) reload_service();
		die('Adlist update failed: ' + e);
	}
	if (tmpdir) exec_sys('rm -rf ' + shell_quote(tmpdir));
	rmdir(lock);
	return changed;
}

function update_geodat() {
	let uci_cursor = cursor();
	uci_cursor.load('mosdns');

	let github_proxy = uci_cursor.get('mosdns', 'config', 'github_proxy') || '';
	let mirror = github_proxy ? github_proxy + '/' : '';
	if (mirror && !match(mirror, /^https:\/\//)) die('The update proxy must use HTTPS.');
	let geoip_type = uci_cursor.get('mosdns', 'config', 'geoip_type') || 'geoip-only-cn-private';
	if (!match(geoip_type, /^[A-Za-z0-9_-]+$/)) die('Invalid geoip type.');
	let v2dat_dir = '/usr/share/v2ray';

	let tmp_res = exec_sys('mktemp -d');
	if (tmp_res.code !== 0) die("Failed to create temp directory for geodata.");
	let tmpdir = tmp_res.stdout;

	exec_sys(`mkdir -p "${v2dat_dir}"`);

	let geoip_updated = false;
	let geoip_url = mirror + "https://github.com/Loyalsoldier/geoip/releases/latest/download/" + geoip_type + ".dat";

	print(`Downloading ${geoip_url}.sha256sum\n`);
	stdout.flush();
	if (exec_sys(`wget -4 -q -T 20 -O "${tmpdir}/geoip.dat.sha256sum" ${shell_quote(geoip_url + ".sha256sum")}`).code !== 0) {
		exec_sys(`rm -rf "${tmpdir}"`);
		die("Failed to download geoip.dat.sha256sum");
	}

	let geoip_sum_remote = split(exec_sys(`cat "${tmpdir}/geoip.dat.sha256sum"`).stdout, /[ \t\n]+/)[0];
	if (!match(geoip_sum_remote || '', /^[a-fA-F0-9]{64}$/)) {
		exec_sys('rm -rf ' + shell_quote(tmpdir));
		die('Invalid geoip checksum manifest.');
	}
	let geoip_sum_local = "";
	if (stat(`${v2dat_dir}/geoip.dat`)) {
		geoip_sum_local = split(exec_sys(`sha256sum "${v2dat_dir}/geoip.dat"`).stdout, /[ \t\n]+/)[0];
	}

	if (geoip_sum_local === geoip_sum_remote) {
		print("geoip.dat is up to date.\n");
		stdout.flush();
	} else {
		print(`Downloading ${geoip_url}\n`);
		stdout.flush();
		if (exec_sys(`wget -4 -q -T 120 -O "${tmpdir}/geoip.dat" ${shell_quote(geoip_url)}`).code !== 0) {
			exec_sys(`rm -rf "${tmpdir}"`);
			die("Failed to download geoip.dat");
		}

		let sum_downloaded = split(exec_sys(`sha256sum "${tmpdir}/geoip.dat"`).stdout, /[ \t\n]+/)[0];
		if (sum_downloaded !== geoip_sum_remote) {
			exec_sys(`rm -rf "${tmpdir}"`);
			die("geoip.dat checksum error");
		}
		geoip_updated = true;
	}

	let geosite_updated = false;
	let geosite_url = mirror + "https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geosite.dat";

	print(`Downloading ${geosite_url}.sha256sum\n`);
	stdout.flush();
	if (exec_sys(`wget -4 -q -T 20 -O "${tmpdir}/geosite.dat.sha256sum" ${shell_quote(geosite_url + ".sha256sum")}`).code !== 0) {
		exec_sys(`rm -rf "${tmpdir}"`);
		die("Failed to download geosite.dat.sha256sum");
	}

	let geosite_sum_remote = split(exec_sys(`cat "${tmpdir}/geosite.dat.sha256sum"`).stdout, /[ \t\n]+/)[0];
	if (!match(geosite_sum_remote || '', /^[a-fA-F0-9]{64}$/)) {
		exec_sys('rm -rf ' + shell_quote(tmpdir));
		die('Invalid geosite checksum manifest.');
	}
	let geosite_sum_local = "";
	if (stat(`${v2dat_dir}/geosite.dat`)) {
		geosite_sum_local = split(exec_sys(`sha256sum "${v2dat_dir}/geosite.dat"`).stdout, /[ \t\n]+/)[0];
	}

	if (geosite_sum_local === geosite_sum_remote) {
		print("geosite.dat is up to date.\n");
		stdout.flush();
	} else {
		print(`Downloading ${geosite_url}\n`);
		stdout.flush();
		if (exec_sys(`wget -4 -q -T 120 -O "${tmpdir}/geosite.dat" ${shell_quote(geosite_url)}`).code !== 0) {
			exec_sys(`rm -rf "${tmpdir}"`);
			die("Failed to download geosite.dat");
		}

		let sum_downloaded = split(exec_sys(`sha256sum "${tmpdir}/geosite.dat"`).stdout, /[ \t\n]+/)[0];
		if (sum_downloaded !== geosite_sum_remote) {
			exec_sys(`rm -rf "${tmpdir}"`);
			die("geosite.dat checksum error");
		}
		geosite_updated = true;
	}

	if (geoip_updated) {
		atomic_copy(tmpdir + '/geoip.dat', v2dat_dir + '/geoip.dat');
	}

	if (geosite_updated) {
		atomic_copy(tmpdir + '/geosite.dat', v2dat_dir + '/geosite.dat');
	}

	exec_sys(`rm -rf "${tmpdir}"`);
}

function v2dat_dump() {
	let uci_cursor = cursor();
	uci_cursor.load('mosdns');
	let v2dat_dir = '/usr/share/v2ray';
	let configfile = uci_cursor.get('mosdns', 'config', 'configfile') || '/var/etc/mosdns.json';
	let ads = ad_settings(uci_cursor);
	let adblock = ads.enabled ? '1' : '0';
	let ad_source = ads.sources;
	let streaming_media = uci_cursor.get('mosdns', 'config', 'custom_stream_media_dns');
	if (uci_cursor.get('mosdns', 'config', 'schema_version') === '2') {
		streaming_media = '0';
		uci_cursor.foreach('mosdns', 'rule', function(rule) {
			if (rule.enabled !== '0' && rule.mode == 'builtin' && rule.builtin_type == 'stream_media')
				streaming_media = '1';
		});
	}

	let outputdir = getenv('MOSDNS_GEODATA_DIR') || '/var/mosdns';
	if (substr(outputdir, 0, 1) != '/' || match(outputdir, /[[:cntrl:]]/)) die('Invalid geodata staging directory.');
	checked('mkdir -p ' + shell_quote(outputdir));
	let dumpdir = checked('mktemp -d');

	if (configfile === "/var/etc/mosdns.json") {
		checked(`geo2txt geoip -f ${v2dat_dir}/geoip.dat -e cn -o ${shell_quote(dumpdir)}`);
		checked(`geo2txt geosite -f ${v2dat_dir}/geosite.dat -e cn -e apple -e 'geolocation-!cn' -o ${shell_quote(dumpdir)}`);

		if (adblock === '1' && index(ad_source, 'geosite.dat') !== -1) {
			checked(`geo2txt geosite -f ${v2dat_dir}/geosite.dat -e category-ads-all -o ${shell_quote(dumpdir)}`);
		}

		if (streaming_media === '1') {
			checked(`geo2txt geosite -f ${v2dat_dir}/geosite.dat -e netflix -e disney -e hulu -o ${shell_quote(dumpdir)}`);
		}
	} else {
		checked(`geo2txt geoip -f ${v2dat_dir}/geoip.dat -e cn -o ${shell_quote(dumpdir)}`);
		checked(`geo2txt geosite -f ${v2dat_dir}/geosite.dat -e cn -e 'geolocation-!cn' -o ${shell_quote(dumpdir)}`);

		let geoip_tags = to_array(uci_cursor.get('mosdns', 'config', 'geoip_tags'));
		if (length(geoip_tags) > 0) {
			let tags_str = join(' ', map(geoip_tags, (tag) => '-e ' + shell_quote(tag)));
			checked(`geo2txt geoip -f ${v2dat_dir}/geoip.dat ${tags_str} -o ${shell_quote(dumpdir)}`);
		}

		let geosite_tags = to_array(uci_cursor.get('mosdns', 'config', 'geosite_tags'));
		if (length(geosite_tags) > 0) {
			let tags_str = join(' ', map(geosite_tags, (tag) => '-e ' + shell_quote(tag)));
			checked(`geo2txt geosite -f ${v2dat_dir}/geosite.dat ${tags_str} -o ${shell_quote(dumpdir)}`);
		}
	}
	// Keep custom/YAML-referenced outputs; publish only successfully extracted files.
	checked('for file in ' + shell_quote(dumpdir) + '/*.txt; do [ -f "$file" ] || continue; name="${file##*/}"; dest=' + shell_quote(outputdir) + '/"$name"; tmp="$(mktemp "$dest.XXXXXX")" || exit 1; cp "$file" "$tmp" && chmod 0644 "$tmp" && mv -f "$tmp" "$dest" || exit 1; done');
	checked('rm -rf ' + shell_quote(dumpdir));
}

function restore_rule_defaults(keep_groups) {
	mkdir('/etc/mosdns', 0755);
	let backup = checked('mktemp /etc/mosdns/config-backup.XXXXXX');
	checked('cp /etc/config/mosdns ' + shell_quote(backup) + ' && chmod 0600 ' + shell_quote(backup));
	let c = cursor();
	if (!c.load('mosdns')) die('Could not load configuration. Backup: ' + backup);
	let groups = [];
	let remove = [];
	c.foreach('mosdns', null, function(section) {
		if (section['.type'] == 'dns_group') push(groups, section);
		if (section['.type'] == 'rule' || section['.type'] == 'ip_map' || (!keep_groups && section['.type'] == 'dns_group'))
			push(remove, section['.name']);
	});
	if (keep_groups && !length(groups)) die('There are no DNS groups to preserve.');
	function set(section, option, value) {
		if (!c.set('mosdns', section, option, value)) die('Could not set ' + section + '.' + option);
	}
	function add(kind, values) {
		let section;
		if (kind == 'dns_group') {
			section = values.is_default == '1' ? 'dns_global' : 'dns_cn';
			while (c.get('mosdns', section)) section += '_restored';
			if (!c.set('mosdns', section, 'dns_group')) die('Could not create named DNS group.');
		} else {
			section = c.add('mosdns', kind);
		}
		if (!section) die('Could not add ' + kind);
		for (let key, value in values) set(section, key, value);
		return section;
	}
	try {
		for (let section in remove) if (!c.delete('mosdns', section)) die('Could not remove section ' + section);
		let cn = null;
		let global = null;
		if (keep_groups) {
			cn = groups[0]['.name'];
			global = cn;
			for (let group in groups) {
				if (group.name == '国内' || group['.name'] == 'dns_cn') cn = group['.name'];
				if (group.is_default == '1') global = group['.name'];
			}
		} else {
			cn = add('dns_group', { name: '国内', is_default: '0', use_default_dns: '0', dns: ['223.5.5.5'] });
			global = add('dns_group', { name: '国外', is_default: '1', use_default_dns: '0', dns: ['8.8.8.8'] });
		}
		set('config', 'schema_version', '2');
		set('config', 'adblock', '0');
		set('config', 'ad_source', ['geosite.dat']);
		add('rule', { enabled: '0', name: '广告过滤', mode: 'builtin', builtin_type: 'adblock', ad_source: ['geosite.dat'] });
		// Restore the factory-empty DDNS list without truncating a file which
		// another retained rule or custom YAML may still reference.
		checked('mkdir -p /etc/mosdns/rule');
		let defaults_dir = checked('mktemp -d /etc/mosdns/rule/.defaults-XXXXXX');
		let defaults_ddns = defaults_dir + '/ddnslist.txt';
		if (writefile(defaults_ddns, '') !== 0) die('Could not prepare default DDNS file.');
		add('rule', { enabled: '1', name: 'DDNS域名', mode: 'custom', dns_group: cn, ip_strategy: 'auto', ttl: '5', rule_file: defaults_ddns });
		add('rule', { enabled: '0', name: 'Apple 域名优化', mode: 'builtin', builtin_type: 'apple_domain', dns_group: cn, ip_strategy: 'auto', rule_file: '/var/mosdns/geosite_apple.txt' });
		add('rule', { enabled: '1', name: '国内域名', mode: 'builtin', builtin_type: 'cn_domain', dns_group: cn, ip_strategy: 'auto', rule_file: '/var/mosdns/geosite_cn.txt' });
		add('rule', { enabled: '1', name: '国外域名', mode: 'builtin', builtin_type: 'noncn_domain', dns_group: global, ip_strategy: 'ipv4', rule_file: '/var/mosdns/geosite_geolocation-!cn.txt' });
		if (!c.save('mosdns') || !c.commit('mosdns')) die('Could not commit default configuration.');
		reload_service();
	} catch (e) {
		c.revert('mosdns');
		atomic_copy(backup, '/etc/config/mosdns');
		exec_sys('/etc/init.d/mosdns reload');
		die('Default restore failed; previous configuration restored. Backup: ' + backup + '. ' + e);
	}
	print('Default rules restored; previous configuration: ' + backup + '\n');
}

let action = ARGV[0];

switch (action) {
	case "prepare_adlist":
		update_adlist(true);
		break;
	case "restore_rule_defaults":
		restore_rule_defaults(false);
		break;
	case "restore_rule_defaults_keep_groups":
		restore_rule_defaults(true);
		break;
	case "default_dns":
		interface_dns(true);
		break;
	case "interface_dns":
		interface_dns(false);
		break;
	case "get_adlist":
		get_adlist();
		break;
	case "update":
		if (!mkdir('/var/lock/mosdns_update.lock', 0700)) {
			print("Another update is already in progress.\n");
			exit(1);
		}
		try {
			update_geodat();
			update_adlist();
			// Reload stages geodata before validation and publishes only after stopping.
			reload_service();
			print("UPDATE_FINISHED\n");
			stdout.flush();
		} catch (e) {
			exec_sys('/etc/init.d/mosdns reload');
			print("Update failed: " + e + "\n");
			print("UPDATE_EXITED\n");
			stdout.flush();
			rmdir('/var/lock/mosdns_update.lock');
			exit(1);
		}
		rmdir('/var/lock/mosdns_update.lock');
		break;
	case "update_adlist":
		if (update_adlist()) reload_service();
		break;
	case "v2dat_dump":
		v2dat_dump();
		break;
	default:
		exit(0);
}
