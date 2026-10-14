'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require mosdns.v2 as v2';

return view.extend({
	load: function() { return uci.load('mosdns'); },
	render: function() {
		const m = new form.Map('mosdns', _('DNS groups'), _('Renaming groups preserves rule references. Save & Apply validates and reloads MosDNS.'));
		let s = m.section(form.NamedSection, 'config', 'mosdns');
		let o = v2.groups(s.option(form.ListValue, '_default_group', _('Default DNS group'), _('Used when no routing rule returns an answer. Renaming a group does not change its rule references.')));
		o.cfgvalue = function() { const g = uci.sections('mosdns', 'dns_group').filter(function(g) { return g.is_default === '1'; })[0]; return g && g['.name']; };
		o.write = function(sid, value) { uci.sections('mosdns', 'dns_group').forEach(function(g) { uci.set('mosdns', g['.name'], 'is_default', g['.name'] === value ? '1' : '0'); }); };
		s = m.section(form.GridSection, 'dns_group', _('DNS groups'));
		s.anonymous = false;
		s.sectiontitle = function(sid) { return uci.get('mosdns', sid, 'name') || _('Unnamed group'); };
		s.addremove = true;
		s.addbtntitle = _('Add DNS group');
		s.sortable = false;
		s.nodescriptions = true;
		s.handleRemove = function(sid, ev) {
			const refs = uci.sections('mosdns', 'rule').filter(function(r) { return r.dns_group === sid; });
			if (uci.get('mosdns', sid, 'is_default') === '1' || refs.length) {
				ui.addNotification(null, E('p', _('Choose another default and remove rule references before deleting this group.')), 'warning');
				return Promise.resolve();
			}
			return form.GridSection.prototype.handleRemove.call(this, sid, ev);
		};
		o = s.option(form.Value, 'name', _('Display name')); o.rmempty = false; o.modalonly = true;
		o = s.option(form.Flag, 'use_default_dns', _('Use interface DNS')); o.default = '0'; o.rmempty = false;
		o = s.option(form.DynamicList, 'dns', _('DNS servers'), _('One upstream per entry: IP, tls://, https://, h3:// or quic://.'));
		o.depends('use_default_dns', '0'); o.retain = true; o.rmempty = false; o.default = '8.8.8.8';
		o = s.option(form.Value, 'bootstrap_dns', _('Bootstrap DNS')); o.modalonly = true; o.datatype = 'ipaddr';
		o = s.option(form.Value, 'concurrent', _('Concurrency'), _('Leave empty to inherit the global setting.'));
		o.datatype = 'range(1,3)'; o.modalonly = true;
		return v2.render(m);
	}
});
