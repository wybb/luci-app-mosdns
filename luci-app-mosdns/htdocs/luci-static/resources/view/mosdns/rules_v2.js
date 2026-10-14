'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require rpc';
'require mosdns.v2 as v2';

const restoreDefaults = rpc.declare({object:'luci.mosdns', method:'restore_rule_defaults', params:['keep_groups'], expect:{'':{}}});

return view.extend({
	restore: function(keepGroups) {
		ui.showModal(_('Restore default configuration?'), [
			E('p', {}, keepGroups ? _('Replace routing rules and IP mappings with defaults, keeping DNS groups. Applies immediately. Save or discard pending edits first.') : _('Replace DNS groups, routing rules and IP mappings with defaults. Applies immediately. Save or discard pending edits first.')),
			E('div', {'class':'right'}, [
				E('button', {'class':'btn', 'click':ui.hideModal}, _('Cancel')),
				' ', E('button', {'class':'btn cbi-button-negative', 'click':ui.createHandlerFn(this, function() {
					return restoreDefaults(keepGroups).then(function(res) {
						if (!res.success) throw new Error(res.error || _('Restore failed.'));
						ui.hideModal();
						window.location.reload();
					}).catch(function(error) { ui.addNotification(null, E('p', error.message), 'error'); });
				})}, _('Restore and reload'))
			])
		]);
	},
	load: function() { return uci.load('mosdns'); },
	render: function() {
		const m = new form.Map('mosdns', _('Routing rules'), _('Rules run from top to bottom. Reorder to change priority. Unmatched requests use the default DNS group.'));
		let s = m.section(form.NamedSection, 'config', 'mosdns', _('Default fallback'));
		v2.strategy(s.option(form.ListValue, 'fallback_ip_strategy', _('Fallback IP strategy')));
		let reset = s.option(form.Button, '_restore_rules', _('Restore default rules'));
		reset.inputtitle = _('Restore rules, keep groups'); reset.onclick = this.restore.bind(this, true);
		reset = s.option(form.Button, '_restore_all', _('Restore groups and rules'));
		reset.inputtitle = _('Restore default configuration'); reset.onclick = this.restore.bind(this, false);
		s = m.section(form.GridSection, 'rule', _('Ordered rules'));
		s.anonymous = true; s.addremove = true; s.sortable = true; s.nodescriptions = true;
		let o = s.option(form.Flag, 'enabled', _('Enabled')); o.default = '1'; o.rmempty = false;
		o = s.option(form.Value, 'name', _('Name')); o.rmempty = false;
		o = s.option(form.ListValue, 'mode', _('Mode'));
		[['custom', _('Domain routing')], ['builtin', _('Built-in list')], ['blacklist', _('Blacklist')], ['hosts', _('Hosts')], ['redirect', _('Redirect')]].forEach(function(v) { o.value(v[0], v[1]); });
		o.default = 'custom'; o.rmempty = false; o.textvalue = function(sid) { return ({custom:_('Domain routing'), builtin:_('Built-in list'), blacklist:_('Blacklist'), hosts:_('Hosts'), redirect:_('Redirect')})[this.cfgvalue(sid)] || this.cfgvalue(sid); };
		o = s.option(form.ListValue, 'builtin_type', _('Built-in list')); o.modalonly = true; o.depends('mode', 'builtin'); o.rmempty = false;
		[['adblock', _('Ad blocking')], ['cn_domain', _('China domains')], ['noncn_domain', _('Global domains')], ['apple_domain', _('Apple domains')], ['stream_media', _('Streaming media domains')]].forEach(function(v) { o.value(v[0], v[1]); }); o.default = 'cn_domain';
		o = s.option(form.DynamicList, 'ad_source', _('Ad list sources'), _('geosite.dat or a supported HTTPS domain-list URL.')); o.modalonly = true; o.depends({mode:'builtin', builtin_type:'adblock'}); o.default = 'geosite.dat';
		o = s.option(form.ListValue, 'blacklist_type', _('Blacklist type')); o.modalonly = true; o.depends('mode', 'blacklist'); o.value('domain', _('Domain')); o.value('ptr', _('PTR')); o.default = 'domain';
		o = v2.groups(s.option(form.ListValue, 'dns_group', _('DNS group')));
		o.depends('mode', 'custom'); ['cn_domain', 'noncn_domain', 'apple_domain', 'stream_media'].forEach(function(type) { o.depends({mode:'builtin', builtin_type:type}); });
		o = v2.strategy(s.option(form.ListValue, 'ip_strategy', _('IP strategy'))); o.modalonly = true;
		o.depends('mode', 'custom'); ['cn_domain', 'noncn_domain', 'apple_domain', 'stream_media'].forEach(function(type) { o.depends({mode:'builtin', builtin_type:type}); });
		o = s.option(form.Value, 'ttl', _('TTL override (seconds)'), _('0 keeps the upstream TTL.')); o.datatype = 'range(0,604800)'; o.default = '0'; o.modalonly = true; o.depends('mode', 'custom');
		o = v2.content(s, '_rule_content', _('Rule content'), _('One rule per line. Domain lists use MosDNS domain syntax; hosts use “domain IP”; redirects use “source-domain target-domain”.'));
		['custom', 'blacklist', 'hosts', 'redirect'].forEach(function(mode) { o.depends('mode', mode); });
		return v2.render(m);
	}
});
