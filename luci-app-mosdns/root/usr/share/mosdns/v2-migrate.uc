'use strict';

import { values } from './v2-config.uc';

export function migrate(sections, legacy) {
	legacy = legacy || {};
	let result = [], config = null, groups = [], rules = [], changed = false, names = {}, warnings = [];
	for (let i = 0; i < length(sections); i++) {
		let section = { ...sections[i] };
		push(result, section);
		names[section['.name']] = true;
		if (section['.type'] == 'mosdns' && section['.name'] == 'config') config = section;
		if (section['.type'] == 'dns_group') push(groups, section);
		if (section['.type'] == 'rule') push(rules, section);
	}
	if (!config) die('Missing mosdns.config');
	function add(kind, wanted, fields) {
		let name = wanted, suffix = 1;
		while (names[name]) name = wanted + '_' + suffix++;
		names[name] = true;
		let s = { '.name': name, '.type': kind, ...fields };
		push(result, s);
		changed = true;
		return name;
	}
	if (!length(groups)) {
		let cn_strategy = config.prefer_ipv4_cn == '1' ? 'ipv4_first' : 'auto';
		let global_strategy = config.prefer_ipv4 == '1' ? 'ipv4_first' : 'auto';
		let cn = add('dns_group', 'dns_cn', { name: '国内', is_default: '0', use_default_dns: config.custom_local_dns == '1' ? '0' : '1', dns: values(config.local_dns || '119.29.29.29') });
		let global = add('dns_group', 'dns_global', { name: '国外', is_default: '1', use_default_dns: '0', dns: values(config.remote_dns || 'tls://8.8.8.8') });
		// Existing user rules remain byte-for-byte in value and relative order.
		if (!length(rules)) {
			add('rule', 'rule_hosts', { name: 'Hosts', enabled: '1', mode: 'hosts', rule_file: '/etc/mosdns/rule/hosts.txt' });
			add('rule', 'rule_redirect', { name: '重定向', enabled: '1', mode: 'redirect', rule_file: '/etc/mosdns/rule/redirect.txt' });
			add('rule', 'rule_apple', { name: 'Apple 域名优化', enabled: config.apple_optimization || '0', mode: 'builtin', builtin_type: 'apple_domain', dns_group: cn, ip_strategy: 'auto' });
			function route(id, label, file, group, strategy, ttl) {
				add('rule', id, { name: label, enabled: '1', mode: 'custom', rule_file: file, dns_group: group, ip_strategy: strategy, ttl: ttl || '0' });
			}
			route('rule_ddns', 'DDNS 域名', '/etc/mosdns/rule/ddnslist.txt', cn, 'auto', '5');
			route('rule_whitelist', '白名单', '/etc/mosdns/rule/whitelist.txt', cn, cn_strategy, '0');
			add('rule', 'rule_blocklist', { name: '黑名单', enabled: '1', mode: 'blacklist', blacklist_type: 'domain', rule_file: '/etc/mosdns/rule/blocklist.txt' });
			add('rule', 'rule_adblock', { name: '广告过滤', enabled: config.adblock || '0', mode: 'builtin', builtin_type: 'adblock', ad_source: values(config.ad_source || 'geosite.dat') });
			add('rule', 'rule_ptr', { name: 'PTR 黑名单', enabled: '1', mode: 'blacklist', blacklist_type: 'ptr', rule_file: '/etc/mosdns/rule/local-ptr.txt' });
			route('rule_greylist', '灰名单', '/etc/mosdns/rule/greylist.txt', global, global_strategy, '0');
			if (config.custom_stream_media_dns == '1' || legacy.streaming_rules) {
				let stream = add('dns_group', 'dns_stream', { name: '流媒体', is_default: '0', use_default_dns: '0', dns: values(config.stream_media_dns || 'tls://8.8.8.8') });
				if (config.custom_stream_media_dns == '1')
					add('rule', 'rule_stream', { name: '流媒体', enabled: '1', mode: 'builtin', builtin_type: 'stream_media', dns_group: stream, ip_strategy: global_strategy });
				else route('rule_stream', '流媒体（迁移）', '/etc/mosdns/rule/streaming.txt', stream, global_strategy, '0');
			}
			add('rule', 'rule_cn', { name: '国内域名', enabled: '1', mode: 'builtin', builtin_type: 'cn_domain', dns_group: cn, ip_strategy: cn_strategy });
			add('rule', 'rule_global', { name: '国外域名', enabled: '1', mode: 'builtin', builtin_type: 'noncn_domain', dns_group: global, ip_strategy: global_strategy });
		}
		if (config.fallback_ip_strategy == null) config.fallback_ip_strategy = global_strategy;
		if (config.cloudflare == '1' && length(values(config.cloudflare_ip)))
			add('ip_map', 'ip_map_cloudflare', { name: 'Cloudflare 映射（迁移）', enabled: '1', rule_file: '/etc/mosdns/rule/cloudflare-cidr.txt', ip_map_target: values(config.cloudflare_ip), continue_match: '1' });
	}
    // Preserve the old generator's last valid default, or first usable group.
	let first_valid = null, last_default = null, repaired = false;
	for (let i = 0; i < length(groups); i++) {
		let g = groups[i];
		if (g.use_default_dns != '1' && !length(values(g.dns))) continue;
		if (!first_valid) first_valid = g['.name'];
		if (g.is_default == '1') last_default = g['.name'];
	}
	let selected = last_default || first_valid;
	if (selected) {
		for (let i = 0; i < length(groups); i++) {
			let wanted = groups[i]['.name'] == selected ? '1' : '0';
			if (groups[i].is_default != wanted) {
				groups[i].is_default = wanted; changed = true; repaired = true;
			}
		}
	}
	if (repaired) push(warnings, 'Repaired ambiguous/missing default DNS group flags using legacy selection: ' + selected);
	// Stabilize anonymous group IDs without changing IDs or display names.
	for (let i = 0; i < length(groups); i++) {
		if (groups[i]['.anonymous']) { groups[i]['.anonymous'] = false; changed = true; }
	}
	for (let i = 0; i < length(rules); i++) {
		let r = rules[i], ref = r.dns_group, m = match(ref || '', /^@dns_group\[([0-9]+)\]$/);
		if (m) {
			if (!groups[+m[1]]) die('Invalid legacy DNS group reference');
			r.dns_group = groups[+m[1]]['.name']; changed = true;
		}
		if (ref && !m) {
			let direct = false, candidate = null, matches = 0;
			for (let j = 0; j < length(groups); j++) {
				if (groups[j]['.name'] == ref) direct = true;
				if (groups[j].name == ref) { candidate = groups[j]['.name']; matches++; }
			}
			if (!direct && matches == 1) { r.dns_group = candidate; changed = true; }
		}
		if (r.mode == 'ip_map') {
			r['.type'] = 'ip_map'; delete r.mode;
			if (r.continue_match == null) r.continue_match = '1';
			changed = true;
		}
	}
	if (config.response_ip_map != null) {
		if (config.response_ip_map == '1' && length(values(config.response_ip_map_target))) {
			let file = config.response_ip_map_file || '/etc/mosdns/rule/cloudflare-cidr.txt', duplicate = false;
			for (let i = 0; i < length(result); i++) {
				let s = result[i];
				if (s['.type'] == 'ip_map' && s.rule_file == file && join(' ', values(s.ip_map_target)) == join(' ', values(config.response_ip_map_target))) duplicate = true;
			}
			if (!duplicate) add('ip_map', 'ip_map_legacy', { name: '响应 IP 映射（迁移）', enabled: '1', rule_file: file, ip_map_target: values(config.response_ip_map_target), continue_match: '1' });
		}
		delete config.response_ip_map;
		delete config.response_ip_map_file;
		delete config.response_ip_map_target;
		changed = true;
	}
	if (config.schema_version != '2') { config.schema_version = '2'; changed = true; }
	return { sections: result, changed: changed, warnings: warnings };
}

export function serialize(sections) {
	function quote(v) { return "'" + replace('' + v, /'/g, "'\\''") + "'"; }
	let output = '';
	for (let i = 0; i < length(sections); i++) {
		let s = sections[i];
		output += 'config ' + quote(s['.type']) + (s['.anonymous'] ? '' : ' ' + quote(s['.name'])) + '\n';
		let options = keys(s);
		for (let j = 0; j < length(options); j++) {
			let key = options[j];
			if (substr(key, 0, 1) == '.') continue;
			let v = s[key];
			if (type(v) == 'array') {
				for (let k = 0; k < length(v); k++) output += '\tlist ' + quote(key) + ' ' + quote(v[k]) + '\n';
			} else output += '\toption ' + quote(key) + ' ' + quote(v) + '\n';
		}
		output += '\n';
	}
	return output;
}
