'use strict';
'require view';
'require form';
'require uci';
'require mosdns.v2 as v2';

return view.extend({
	load: function() { return uci.load('mosdns'); },
	render: function() {
		const m = new form.Map('mosdns', _('IP mappings'), _('Independent response-IP mappings run in this order. Continue passes the transformed answer to the next mapping; Stop ends mapping after a match.'));
		const s = m.section(form.GridSection, 'ip_map', _('Ordered IP mappings'));
		s.anonymous = true; s.addremove = true; s.sortable = true; s.nodescriptions = true;
		let o = s.option(form.Flag, 'enabled', _('Enabled')); o.default = '1'; o.rmempty = false;
		o = s.option(form.Value, 'name', _('Name')); o.rmempty = false;
		o = s.option(form.DynamicList, 'ip_map_target', _('Mapped IP addresses')); o.datatype = 'ipaddr'; o.rmempty = false;
		o = s.option(form.ListValue, 'continue_match', _('After a match')); o.value('1', _('Continue')); o.value('0', _('Stop')); o.default = '1'; o.rmempty = false; o.textvalue = function(sid) { return this.cfgvalue(sid) === '0' ? _('Stop') : _('Continue'); };
		v2.content(s, '_map_content', _('IP/CIDR list'), _('One source IP address or CIDR per line.'));
		return v2.render(m);
	}
});
