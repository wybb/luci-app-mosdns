'use strict';
'require view';
'require form';
'require fs';
'require rpc';
'require uci';
'require ui';
'require mosdns.v2 as v2';

const version = rpc.declare({object:'luci.mosdns', method:'get_version', expect:{'':{}}});
const writeCustom = rpc.declare({object:'luci.mosdns', method:'write_custom_config', params:['content'], expect:{'':{}}});
const flush = rpc.declare({object:'luci.mosdns', method:'flush_cache', expect:{'':{}}});

return view.extend({
	load: function() { return Promise.all([uci.load('mosdns'), L.resolveDefault(version(), {})]); },
	render: function(data) {
		const m = new form.Map('mosdns', _('MosDNS v2') + (data[1].version ? ' · ' + data[1].version : ''), _('Configure DNS groups, ordered routing rules and independent IP mappings. Save stages changes; Save & Apply validates and reloads the service. A failed reload keeps the last working service where possible; check the apply status below.'));
		const s = m.section(form.NamedSection, 'config', 'mosdns');
		s.tab('basic', _('Service')); s.tab('advanced', _('Cache and upstreams')); s.tab('api', _('API and statistics')); s.tab('geodata', _('Geodata')); s.tab('legacy', _('Legacy options'));
		function value(tab, key, title, def, datatype, description) {
			const o = s.taboption(tab, form.Value, key, title, description); o.retain = true; if (def != null) o.default = def; if (datatype) o.datatype = datatype; if (['listen_port','cache_size','lazy_cache_ttl','dump_interval','prefetch_before_expire','prefetch_min_hits','prefetch_scan_interval','stats_capacity','stats_dump_interval'].indexOf(key) < 0) o.depends('configfile', '/var/etc/mosdns.json'); return o;
		}
		function flag(tab, key, title, def, description) { const o = s.taboption(tab, form.Flag, key, title, description); o.retain = true; o.default = def || '0'; o.rmempty = false; if (['enabled','redirect','local_dns_redirect','dump_file','prefetch','stats_dump_file'].indexOf(key) < 0) o.depends('configfile', '/var/etc/mosdns.json'); return o; }
		flag('basic', 'enabled', _('Enabled'));
		let o = s.taboption('basic', form.ListValue, 'configfile', _('Configuration'));
		o.value('/var/etc/mosdns.json', _('Generated v2 configuration')); o.value('/etc/mosdns/config_custom.yaml', _('Custom YAML configuration')); o.default = '/var/etc/mosdns.json'; o.rmempty = false;
		value('basic', 'listen_address', _('Listen address'), '0.0.0.0', 'ipaddr').depends('configfile', '/var/etc/mosdns.json');
		value('basic', 'listen_port', _('DNS listen / forwarding port'), '5335', 'port', _('In custom mode, this forwarding port must match the listener defined in your YAML.'));
		o = s.taboption('basic', form.ListValue, 'log_level', _('Log level')); ['debug','info','warn','error'].forEach(function(v) { o.value(v, v); }); o.retain = true; o.default = 'info'; o.depends('configfile', '/var/etc/mosdns.json');
		value('basic', 'log_file', _('Log file'), '/var/log/mosdns.log').rmempty = false;
		value('basic', 'log_size', _('Log size'), '1M', null, _('A size such as 1M.'));
		value('basic', 'log_backups', _('Log backups'), '3', 'uinteger');
		flag('basic', 'redirect', _('Forward dnsmasq queries to MosDNS'));
		if (L.hasSystemFeature('firewall4')) flag('basic', 'local_dns_redirect', _('Redirect local DNS traffic')).depends('redirect', '1');
		value('basic', 'bootstrap_dns', _('Bootstrap DNS'), '119.29.29.29', 'ipaddr', _('Resolves upstream server hostnames.'));
		o = s.taboption('basic', form.TextValue, '_custom', _('Custom YAML configuration'), _('Custom mode bypasses the generated groups and routing rules. The file is saved atomically with a backup. Startup can still fail; check apply status after reloading.'));
		o.rows = 24; o.depends('configfile', '/etc/mosdns/config_custom.yaml');
		o.load = function() { return fs.read('/etc/mosdns/config_custom.yaml'); };
		o.write = function(sid, content) { return writeCustom(content.replace(/\r\n?/g, '\n')).then(function(res) { if (!res.success) throw new Error(res.error || _('Could not save custom configuration.')); }); };
		o.remove = function() {};
		value('advanced', 'concurrent', _('Default upstream concurrency'), '2', 'range(1,3)');
		value('advanced', 'idle_timeout', _('Idle timeout (seconds)'), '30', 'and(uinteger,min(1))');
		flag('advanced', 'enable_pipeline', _('TCP/DoT pipelining'));
		flag('advanced', 'insecure_skip_verify', _('Skip TLS certificate verification'), '0', _('Reduces security. Enable only when you understand the risk.'));
		flag('advanced', 'cache', _('Enable cache'), '1');
		value('advanced', 'cache_size', _('Cache entries'), '8000', 'range(1,10000000)').depends({configfile:'/var/etc/mosdns.json', cache:'1'});
		value('advanced', 'lazy_cache_ttl', _('Lazy cache TTL (seconds)'), '86400', 'uinteger').depends({configfile:'/var/etc/mosdns.json', cache:'1'});
		flag('advanced', 'prefetch', _('Prefetch hot cache entries')).depends({configfile:'/var/etc/mosdns.json', cache:'1'});
		value('advanced', 'prefetch_before_expire', _('Prefetch before expiry (seconds)'), '10', 'and(uinteger,min(1))').depends({configfile:'/var/etc/mosdns.json', prefetch:'1'});
		value('advanced', 'prefetch_min_hits', _('Minimum prefetch hits'), '3', 'and(uinteger,min(1))').depends({configfile:'/var/etc/mosdns.json', prefetch:'1'});
		value('advanced', 'prefetch_scan_interval', _('Prefetch scan interval (seconds)'), '5', 'and(uinteger,min(1))').depends({configfile:'/var/etc/mosdns.json', prefetch:'1'});
		flag('advanced', 'dump_file', _('Persist cache')).depends({configfile:'/var/etc/mosdns.json', cache:'1'});
		value('advanced', 'dump_interval', _('Cache dump interval (seconds)'), '3600', 'range(1,86400)').depends({configfile:'/var/etc/mosdns.json', dump_file:'1'});
		value('api', 'listen_port_api', _('API port (loopback only)'), '9091', 'port', _('Generated configuration only. Custom YAML controls its own API address and must use a trusted bind address.')).depends('configfile', '/var/etc/mosdns.json');
		flag('api', 'stats_collector', _('Enable statistics collector'), '0');
		value('api', 'stats_capacity', _('Statistics capacity'), '2000', 'and(uinteger,min(1))').depends({configfile:'/var/etc/mosdns.json', stats_collector:'1'});
		flag('api', 'stats_dump_file', _('Persist statistics')).depends({configfile:'/var/etc/mosdns.json', stats_collector:'1'});
		value('api', 'stats_dump_interval', _('Statistics dump interval (seconds)'), '600', 'and(uinteger,min(1))').depends({configfile:'/var/etc/mosdns.json', stats_dump_file:'1'});
		o = s.taboption('api', form.Button, '_flush', _('DNS cache')); o.inputtitle = _('Flush cache');
		o.onclick = function() { return flush().then(function(res) { if (!res.success) throw new Error(res.error || _('Cache flush failed.')); ui.addNotification(null, E('p', _('Cache flushed.')), 'info'); }); };
		s.taboption('geodata', form.DynamicList, 'geosite_tags', _('GeoSite tags'), _('Extra tags to export for rule files.'));
		s.taboption('geodata', form.DynamicList, 'geoip_tags', _('GeoIP tags'), _('Extra tags to export for IP lists.'));
		[['minimal_ttl', _('Global minimum TTL')], ['maximum_ttl', _('Global maximum TTL')], ['enable_ecs_remote', _('Global ECS')], ['remote_ecs_ip', _('Legacy ECS address')], ['reject_type65', _('Global type 65 blocking')], ['dns_leak', _('Legacy leak prevention')]].forEach(function(item) {
			const o = s.taboption('legacy', form.DummyValue, item[0], item[1], _('Preserved for migration only. This option is not implemented by the v2 generator and has no effect.'));
			o.default = _('Not set');
		});
		return v2.render(m);
	}
});
