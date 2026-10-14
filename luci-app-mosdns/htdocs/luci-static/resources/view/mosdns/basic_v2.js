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
		const m = new form.Map('mosdns', _('MosDNS') + (data[1].version ? ' · ' + data[1].version : ''), _('MosDNS is a plugin-based DNS forwarder/traffic splitter.'));
		const s = m.section(form.NamedSection, 'config', 'mosdns');
		s.tab('basic', _('Basic Options')); s.tab('advanced', _('Advanced Options')); s.tab('api', _('API Options')); s.tab('geodata', _('GeoData Export')); s.tab('legacy', _('Legacy options'));
		function value(tab, key, title, def, datatype, description) {
			const o = s.taboption(tab, form.Value, key, title, description); o.retain = true; if (def != null) o.default = def; if (datatype) o.datatype = datatype; if (['listen_port','cache_size','lazy_cache_ttl','dump_interval','prefetch_before_expire','prefetch_min_hits','prefetch_scan_interval','stats_capacity','stats_dump_interval'].indexOf(key) < 0) o.depends('configfile', '/var/etc/mosdns.json'); return o;
		}
		function flag(tab, key, title, def, description) { const o = s.taboption(tab, form.Flag, key, title, description); o.retain = true; o.default = def || '0'; o.rmempty = false; if (['enabled','redirect','local_dns_redirect','dump_file','prefetch','stats_dump_file'].indexOf(key) < 0) o.depends('configfile', '/var/etc/mosdns.json'); return o; }
		flag('basic', 'enabled', _('Enabled'));
		let o = s.taboption('basic', form.ListValue, 'configfile', _('Config File'));
		o.value('/var/etc/mosdns.json', _('Default Config')); o.value('/etc/mosdns/config_custom.yaml', _('Custom Config')); o.default = '/var/etc/mosdns.json'; o.rmempty = false;
		value('basic', 'listen_address', _('Listen Address'), '0.0.0.0', 'ipaddr').depends('configfile', '/var/etc/mosdns.json');
		value('basic', 'listen_port', _('DNS listen / forwarding port'), '5335', 'port', _('In custom mode, this forwarding port must match the listener defined in your YAML.'));
		o = s.taboption('basic', form.ListValue, 'log_level', _('Log Level')); [['debug', _('Debug')], ['info', _('Info')], ['warn', _('Warning')], ['error', _('Error')]].forEach(function(v) { o.value(v[0], v[1]); }); o.retain = true; o.default = 'info'; o.depends('configfile', '/var/etc/mosdns.json');
		value('basic', 'log_file', _('Log File'), '/var/log/mosdns.log').rmempty = false;
		value('basic', 'log_size', _('Log File Size'), '1M', null, _('A size such as 1M.'));
		value('basic', 'log_backups', _('Log backups'), '3', 'uinteger');
		flag('basic', 'redirect', _('DNS Forward'), null, _('Forward Dnsmasq Domain Name resolution requests to MosDNS'));
		if (L.hasSystemFeature('firewall4')) flag('basic', 'local_dns_redirect', _('DNS redirect'), null, _('Force redirect all local DNS queries to MosDNS, a.k.a. DNS Hijacking')).depends('redirect', '1');
		value('basic', 'bootstrap_dns', _('Bootstrap DNS servers'), '119.29.29.29', 'ipaddr', _('Bootstrap DNS servers are used to resolve IP addresses of the DoH/DoT resolvers you specify as upstreams'));
		o = s.taboption('basic', form.TextValue, '_custom', _('Configuration Editor'), _("This is the content of the file '/etc/mosdns/config_custom.yaml' from which your MosDNS configuration will be generated. Only accepts configuration content in yaml format."));
		o.rows = 24; o.depends('configfile', '/etc/mosdns/config_custom.yaml');
		o.load = function() { return fs.read('/etc/mosdns/config_custom.yaml'); };
		o.write = function(sid, content) { return writeCustom(content.replace(/\r\n?/g, '\n')).then(function(res) { if (!res.success) throw new Error(res.error || _('Could not save custom configuration.')); }); };
		o.remove = function() {};
		value('advanced', 'concurrent', _('Concurrent'), '2', 'range(1,3)', _('DNS query request concurrency, The number of upstream DNS servers that are allowed to initiate requests at the same time'));
		value('advanced', 'idle_timeout', _('Idle Timeout'), '30', 'and(uinteger,min(1))', _('DoH/TCP/DoT Connection Multiplexing idle timeout (default 30 seconds)'));
		flag('advanced', 'enable_pipeline', _('TCP/DoT Connection Multiplexing'), null, _('Enable TCP/DoT RFC 7766 new Query Pipelining connection multiplexing mode'));
		flag('advanced', 'insecure_skip_verify', _('Disable TLS Certificate'), '0', _('Disable TLS Servers certificate validation, Can be useful if system CA certificate expires or the system time is out of order'));
		flag('advanced', 'cache', _('Enable DNS Cache'), '1');
		value('advanced', 'cache_size', _('DNS Cache Size'), '8000', 'range(1,10000000)').depends({configfile:'/var/etc/mosdns.json', cache:'1'});
		value('advanced', 'lazy_cache_ttl', _('Lazy Cache TTL'), '86400', 'uinteger', _('Lazy cache survival time (in second). To disable Lazy Cache, please set to 0.')).depends({configfile:'/var/etc/mosdns.json', cache:'1'});
		flag('advanced', 'prefetch', _('Cache Prefetching'), null, _('Proactively refresh hot cache entries in the background before they expire.')).depends({configfile:'/var/etc/mosdns.json', cache:'1'});
		value('advanced', 'prefetch_before_expire', _('Prefetch Before Expire'), '10', 'and(uinteger,min(1))', _('Prefetch when the remaining TTL is less than this value (in seconds).')).depends({configfile:'/var/etc/mosdns.json', prefetch:'1'});
		value('advanced', 'prefetch_min_hits', _('Prefetch Min Hits'), '3', 'and(uinteger,min(1))', _('Minimum cache hits required since the last refresh to trigger a prefetch.')).depends({configfile:'/var/etc/mosdns.json', prefetch:'1'});
		value('advanced', 'prefetch_scan_interval', _('Prefetch Scan Interval'), '5', 'and(uinteger,min(1))', _('Interval for the background thread to scan the cache for prefetching (in seconds).')).depends({configfile:'/var/etc/mosdns.json', prefetch:'1'});
		flag('advanced', 'dump_file', _('Cache Dump'), null, _('Save the cache locally and reload the cache dump on the next startup')).depends({configfile:'/var/etc/mosdns.json', cache:'1'});
		value('advanced', 'dump_interval', _('Auto Save Cache Interval'), '3600', 'range(1,86400)').depends({configfile:'/var/etc/mosdns.json', dump_file:'1'});
		value('api', 'listen_port_api', _('API Listen port'), '9091', 'port').depends('configfile', '/var/etc/mosdns.json');
		flag('api', 'stats_collector', _('Enable Stats Collector'), '0');
		value('api', 'stats_capacity', _('Ring Buffer Capacity'), '2000', 'and(uinteger,min(1))', _('Query log ring buffer capacity (FIFO overwrite, default 2000, larger values consume more memory)')).depends({configfile:'/var/etc/mosdns.json', stats_collector:'1'});
		flag('api', 'stats_dump_file', _('Stats Dump'), null, _('Save query statistics and logs locally and reload on next startup.')).depends({configfile:'/var/etc/mosdns.json', stats_collector:'1'});
		value('api', 'stats_dump_interval', _('Auto Save Stats Interval'), '600', 'and(uinteger,min(1))').depends({configfile:'/var/etc/mosdns.json', stats_dump_file:'1'});
		o = s.taboption('api', form.Button, '_flush', _('DNS cache')); o.inputtitle = _('Flush DNS Cache');
		o.onclick = function() { return flush().then(function(res) { if (!res.success) throw new Error(res.error || _('Flushing DNS Cache Failed, Please check if MosDNS is running.')); ui.addNotification(null, E('p', _('Flushing DNS Cache Success.')), 'info'); }); };
		s.taboption('geodata', form.DynamicList, 'geosite_tags', _('GeoSite Tags'), _('Enter the GeoSite.dat category to be exported, Allow add multiple tags'));
		s.taboption('geodata', form.DynamicList, 'geoip_tags', _('GeoIP Tags'), _('Enter the GeoIP.dat category to be exported, Allow add multiple tags'));
		[['minimal_ttl', _('Minimum TTL')], ['maximum_ttl', _('Maximum TTL')], ['enable_ecs_remote', _('Enable EDNS client subnet')], ['remote_ecs_ip', _('IP Address')], ['reject_type65', _('Disable RR Type 65 (HTTPS/SVCB)')], ['dns_leak', _('Prevent DNS Leaks')]].forEach(function(item) {
			const o = s.taboption('legacy', form.DummyValue, item[0], item[1], _('Retained from older settings; inactive.'));
			o.default = _('Not set');
		});
		return v2.render(m);
	}
});
