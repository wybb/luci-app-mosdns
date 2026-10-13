'use strict';

// Pure configuration compiler. The caller owns UCI, filesystem and activation.
export function values(value) {
	if (type(value) == 'array') return value;
	return value ? filter(split(value, /\s+/), v => length(v) > 0) : [];
}

function integer(value, fallback, min, max, label) {
	if (value == null || value == '') value = fallback;
	if (!match('' + value, /^[0-9]+$/)) die(label + ': expected integer');
	let n = +value;
	if (n < min || n > max) die(label + ': out of range');
	return n;
}

function flag(value, fallback) {
	if (value == null || value == '') return fallback;
	if (value != '0' && value != '1') die('Expected a 0/1 flag');
	return value == '1';
}

export function rule_path(path, fallback) {
	path = path || fallback;
	if (!path || match(path, /[[:cntrl:]]/) || index(path, '..') >= 0)
		die('Invalid rule file path');
	if (substr(path, 0, 1) != '/') path = '/etc/mosdns/rule/' + path;
	return path;
}

function valid_ip(value) {
	function v4(v) {
		let parts = split(v, '.');
		if (length(parts) != 4) return false;
		for (let i = 0; i < 4; i++) if (!match(parts[i], /^(0|[1-9][0-9]{0,2})$/) || +parts[i] > 255) return false;
		return true;
	}
	if (type(value) != 'string') return false;
	if (index(value, ':') < 0) return v4(value);
	if (!match(value, /^[0-9a-fA-F:.]+$/) || index(value, ':::') >= 0) return false;
	if (substr(value, 0, 1) == ':' && substr(value, 0, 2) != '::') return false;
	if (substr(value, -1) == ':' && substr(value, -2) != '::') return false;
	let compressed = split(value, '::');
	if (length(compressed) > 2) return false;
	let parts = split(value, ':'), count = 0;
	for (let i = 0; i < length(parts); i++) {
		if (!length(parts[i])) continue;
		if (index(parts[i], '.') >= 0) {
			if (i != length(parts) - 1 || !v4(parts[i])) return false;
			count += 2;
		} else {
			if (!match(parts[i], /^[0-9a-fA-F]{1,4}$/)) return false;
			count++;
		}
	}
	if (length(compressed) == 2) return count < 8;
	return count == 8 && substr(value, 0, 1) != ':' && substr(value, -1) != ':';
}

function strategy(sequence, value) {
	value = value || 'auto';
	if (index(['auto', 'ipv4', 'ipv6', 'ipv4_first', 'ipv6_first'], value) < 0)
		die('Unknown IP strategy: ' + value);
	if (value == 'ipv4' || value == 'ipv6')
		push(sequence, { matches: value == 'ipv4' ? 'qtype 28' : 'qtype 1', exec: 'reject 0' });
	if (value == 'ipv4' || value == 'ipv4_first') push(sequence, { exec: 'prefer_ipv4' });
	if (value == 'ipv6' || value == 'ipv6_first') push(sequence, { exec: 'prefer_ipv6' });
}

export function generate(sections, default_dns) {
	let c = {}, groups = [], rules = [], maps = [], plugins = [], default_group = null;
	for (let i = 0; i < length(sections); i++) {
		let s = sections[i];
		if (!match(s['.name'] || '', /^[a-zA-Z0-9_]+$/)) die('Invalid section ID');
		if (s['.type'] == 'mosdns' && s['.name'] == 'config') c = s;
		if (s['.type'] == 'dns_group') push(groups, s);
		if (s['.type'] == 'rule') push(rules, s);
		if (s['.type'] == 'ip_map') push(maps, s);
	}
	function add(tag, kind, args) { push(plugins, { tag: tag, type: kind, args: args }); }
	let known = {};
	for (let i = 0; i < length(groups); i++) {
		let g = groups[i], id = g['.name'];
		if (!match(id, /^[a-zA-Z0-9_]+$/) || known[id]) die('Invalid or duplicate DNS group ID');
		let dns = flag(g.use_default_dns, false) ? default_dns : values(g.dns);
		if (!length(dns)) die('DNS group ' + id + ' has no upstream');
		let upstreams = [];
		for (let j = 0; j < length(dns); j++) {
			let addr = dns[j];
			if (type(addr) != 'string' || match(addr, /\s/) || !length(addr)) die('Invalid DNS upstream');
			let h3 = index(addr, 'h3://') == 0;
			let upstream = {
				addr: h3 ? 'https://' + substr(addr, 5) : addr,
				bootstrap: g.bootstrap_dns || c.bootstrap_dns || '119.29.29.29',
				enable_pipeline: flag(c.enable_pipeline, true),
				insecure_skip_verify: flag(c.insecure_skip_verify, false),
				idle_timeout: integer(c.idle_timeout, 30, 1, 86400, 'idle_timeout')
			};
			if (h3) upstream.enable_http3 = true;
			push(upstreams, upstream);
		}
		known[id] = 'dns_group_' + id;
		add(known[id], 'forward', { concurrent: integer(g.concurrent || c.concurrent, 2, 1, 64, 'concurrent'), upstreams: upstreams });
		if (flag(g.is_default, false)) {
			if (default_group) die('Exactly one DNS group must be default');
			default_group = id;
		}
	}
	if (!default_group) die('Exactly one DNS group must be default');
	let main = [];
	if (flag(c.stats_collector, false)) {
		let args = { capacity: integer(c.stats_capacity, 2000, 1, 1000000, 'stats_capacity') };
		if (flag(c.stats_dump_file, false)) {
			args.dump_file = '/etc/mosdns/stats.dump';
			args.dump_interval = integer(c.stats_dump_interval, 600, 1, 86400, 'stats_dump_interval');
		}
		add('stats_collector', 'stats_api', args);
		push(main, { exec: '$stats_collector' });
	}
	if (flag(c.cache, true)) {
		let args = { size: integer(c.cache_size, 8000, 1, 10000000, 'cache_size'), lazy_cache_ttl: integer(c.lazy_cache_ttl, 86400, 0, 2147483647, 'lazy_cache_ttl') };
		if (flag(c.dump_file, false)) {
			args.dump_file = '/etc/mosdns/cache.dump';
			args.dump_interval = integer(c.dump_interval, 3600, 1, 86400, 'dump_interval');
		}
		if (flag(c.prefetch, false)) {
			args.prefetch = true;
			args.prefetch_before_expire = integer(c.prefetch_before_expire, 10, 1, 86400, 'prefetch_before_expire');
			args.prefetch_min_hits = integer(c.prefetch_min_hits, 3, 1, 1000000, 'prefetch_min_hits');
			args.prefetch_scan_interval = integer(c.prefetch_scan_interval, 5, 1, 86400, 'prefetch_scan_interval');
		}
		add('lazy_cache', 'cache', args);
		// Cached answers already include response mappings. Never apply them twice.
		push(main, { exec: '$lazy_cache' }, { matches: 'has_resp', exec: 'accept' });
	}
	let builtin = {
		cn_domain: ['/var/mosdns/geosite_cn.txt'],
		noncn_domain: ['/var/mosdns/geosite_geolocation-!cn.txt'],
		apple_domain: ['/var/mosdns/geosite_apple.txt'],
		stream_media: ['/var/mosdns/geosite_disney.txt', '/var/mosdns/geosite_netflix.txt', '/var/mosdns/geosite_hulu.txt', '/etc/mosdns/rule/streaming.txt']
	};
	let ad_filenames = {};
	for (let i = 0; i < length(rules); i++) {
		let r = rules[i];
		if (!flag(r.enabled, true)) continue;
		let id = r['.name'], mode = r.mode || 'custom', set = 'rule_set_' + id, tag = 'rule_exec_' + id;
		let files = [rule_path(r.rule_file, 'rule-' + id + '.txt')], sequence = [];
		if (mode == 'builtin' && r.builtin_type == 'adblock') {
			files = [];
			let sources = values(r.ad_source || ['geosite.dat']);
			for (let j = 0; j < length(sources); j++) {
				let source = sources[j];
				if (source == 'geosite.dat') push(files, '/var/mosdns/geosite_category-ads-all.txt');
				else if (index(source, 'file://') == 0) {
					if (substr(source, 7, 1) != '/') die('Adblock file source requires an absolute path');
					push(files, rule_path(substr(source, 7), null));
				}
				else {
					if (!match(source, /^https:\/\/[^ \t\r\n]+$/)) die('Unsupported adblock source');
					let parts = split(source, '/'), filename = parts[length(parts) - 1];
					if (!match(filename, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/)) die('Adblock URL requires a safe plain filename');
					if (ad_filenames[filename] && ad_filenames[filename] != source) die('Duplicate adlist filename: ' + filename);
					ad_filenames[filename] = source;
					push(files, rule_path('/etc/mosdns/rule/adlist/' + filename, null));
				}
			}
			if (!length(files)) die('Adblock rule requires a source');
			add(set, 'adblock_set', { files: files });
			push(sequence, { matches: 'qname $' + set, exec: 'reject 3' });
		} else if (mode == 'blacklist') {
			if (r.blacklist_type && index(['domain', 'ptr'], r.blacklist_type) < 0) die('Invalid blacklist type');
			add(set, 'domain_set', { files: files });
			push(sequence, { matches: r.blacklist_type == 'ptr' ? ['qtype 12', 'qname $' + set] : 'qname $' + set, exec: 'reject 3' });
		} else if (mode == 'hosts' || mode == 'redirect') {
			add(set, mode, { files: files });
			push(sequence, { exec: '$' + set });
		} else if (mode == 'custom' || mode == 'builtin') {
			if (mode == 'builtin') {
				files = builtin[r.builtin_type];
				if (!files) die('Unknown builtin rule type');
			}
			let group = r.dns_group || default_group;
			if (!known[group]) die('Rule ' + id + ' references missing DNS group ' + group);
			add(set, 'domain_set', { files: files });
			push(sequence, { matches: '!qname $' + set, exec: 'return' });
			strategy(sequence, r.ip_strategy || (r.builtin_type == 'noncn_domain' ? 'ipv4' : r.builtin_type == 'stream_media' ? 'ipv4_first' : 'auto'));
			push(sequence, { exec: '$' + known[group] });
			let ttl = integer(r.ttl, 0, 0, 2147483647, 'rule TTL');
			if (ttl) push(sequence, { matches: 'has_resp', exec: 'ttl ' + ttl + '-' + ttl });
		} else die('Unknown rule mode: ' + mode);
		add(tag, 'sequence', sequence);
		// Redirect is recursive middleware: keep the remaining routing chain inside it.
		push(main, { exec: (mode == 'redirect' ? 'jump ' : '$') + tag }, { exec: 'jump has_resp_sequence' });
	}
	let response = [{ matches: '!has_resp', exec: 'return' }];
	for (let i = 0; i < length(maps); i++) {
		let m = maps[i];
		if (!flag(m.enabled, true)) continue;
		let id = m['.name'], set = 'ip_map_set_' + id, tag = 'ip_map_exec_' + id, targets = values(m.ip_map_target);
		if (!length(targets)) die('IP mapping ' + id + ' requires a target');
		for (let j = 0; j < length(targets); j++)
			if (!valid_ip(targets[j])) die('IP mapping target must be an IP address');
		add(set, 'ip_set', { files: [rule_path(m.rule_file, 'ip-map-' + id + '.txt')] });
		// Guard before rewriting. accept exits all enclosing sequences, not just this map.
		let sequence = [{ matches: '!resp_ip $' + set, exec: 'return' }, { exec: 'black_hole ' + join(' ', targets) }];
		if (!flag(m.continue_match, true)) push(sequence, { exec: 'accept' });
		add(tag, 'sequence', sequence);
		push(response, { exec: 'jump ' + tag });
	}
	push(response, { matches: 'has_resp', exec: 'accept' });
	add('has_resp_sequence', 'sequence', response);
	strategy(main, c.fallback_ip_strategy);
	push(main, { exec: '$' + known[default_group] }, { exec: 'jump has_resp_sequence' });
	add('main_sequence', 'sequence', main);
	let host = c.listen_address || '0.0.0.0';
	if (!valid_ip(host)) die('Invalid listen address');
	if (index(host, ':') >= 0) host = '[' + host + ']';
	let listen = host + ':' + integer(c.listen_port, 5335, 1, 65535, 'listen_port');
	add('udp_server', 'udp_server', { entry: 'main_sequence', listen: listen });
	add('tcp_server', 'tcp_server', { entry: 'main_sequence', listen: listen });
	if (c.log_level && index(['debug', 'info', 'warn', 'error', 'dpanic', 'panic', 'fatal'], c.log_level) < 0) die('Invalid log level');
	if (c.log_size && !match(c.log_size, /^[0-9]+([kKmMgG][bB]?)?$/)) die('Invalid log size');
	let log_file = c.log_file || '/var/log/mosdns.log';
	if (!(index(log_file, '/var/log/') == 0 || index(log_file, '/tmp/log/') == 0) || match(log_file, /[[:cntrl:]]/) || index(split(log_file, '/'), '..') >= 0 || substr(log_file, -1) == '/')
		die('Log file must be within /var/log/ or /tmp/log/ without traversal/control characters');
	let log = { level: c.log_level || 'error', file: log_file, size: c.log_size || '1' };
	if (c.log_backups != null) log.backups = integer(c.log_backups, 3, 0, 100, 'log_backups');
	return { log: log, api: { http: '127.0.0.1:' + integer(c.listen_port_api, 9091, 1, 65535, 'listen_port_api') }, include: [], plugins: plugins };
}
