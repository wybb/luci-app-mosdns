'use strict';
'require form';
'require fs';
'require uci';
'require ui';
'require view';

var DUPLICATE_NAME_MSG = _('An entry with this name already exists.');

function ruleUsesDnsGroup(rule, targetGroup, groups) {
	var mode = rule.mode || 'custom';
	var bt = rule.builtin_type || '';

	if (mode !== 'custom' && !(mode === 'builtin' &&
		(bt === 'cn_domain' || bt === 'noncn_domain' || bt === 'apple_domain' || bt === 'stream_media')))
		return false;

	var ref = rule.dns_group;
	if (!ref)
		return false;
	if (ref === targetGroup)
		return true;

	var m = /^@dns_group\[(\d+)\]$/.exec(ref);
	if (!m)
		return false;

	var idx = +m[1];
	return !!(groups[idx] && groups[idx]['.name'] === targetGroup);
}

function normalizeName(v) {
	return String(v || '').trim().toLowerCase();
}

function isGroupNameTaken(name, excludeSid) {
	var n = normalizeName(name);
	if (!n)
		return false;

	return uci.sections('mosdns', 'dns_group').some(function (sec) {
		if (excludeSid && sec['.name'] === excludeSid)
			return false;
		return normalizeName(sec.name) === n;
	});
}

function resolveGroupId(ref, groups) {
	if (!ref)
		return null;

	if (groups.some(function (g) { return g['.name'] === ref; }))
		return ref;

	var m = /^@dns_group\[(\d+)\]$/.exec(ref);
	if (!m)
		return null;

	var idx = +m[1];
	return groups[idx] ? groups[idx]['.name'] : null;
}

function generateDnsGroupId() {
	return 'dnsg_' + Math.random().toString(16).slice(2, 10);
}

function resolveGroupName(section_id, groups) {
	return resolveGroupId(section_id, groups);
}

function resolveGroupSectionId(section_id) {
	var groups = uci.sections('mosdns', 'dns_group');
	return resolveGroupId(section_id, groups) || section_id;
}

function flushAndRestartMosdns() {
	return fs.exec('/usr/share/mosdns/mosdns.sh', ['flush'])
		.catch(function () { return null; })
		.then(function () {
			return fs.exec('/usr/share/mosdns/mosdns.sh', ['restart_async']);
		});
}

return view.extend({
	load: function () {
		return uci.load('mosdns');
	},

	handleSave: function () {
		if (!this.map)
			return Promise.resolve();

		return this.map.save(null, false);
	},

	handleSaveApply: function (ev) {
		return this.handleSave(ev).then(function () {
			return flushAndRestartMosdns();
		}).then(function () {
			return ui.changes.apply(false);
		});
	},

	render: function () {
		var m, s, o;

		m = new form.Map('mosdns', _('DNS Groups'),
			_('Manage upstream DNS groups. One group must be set as default fallback.'));
		this.map = m;
		m.render = L.bind(function () {
			return form.Map.prototype.render.apply(m, arguments).then(function (node) {
				node.appendChild(E('style', [
					'#maincontent .cbi-section-table-row[data-title]::before { display: none !important; content: none !important; }',
					'#maincontent .cbi-section-table-titles.named::before { display: none !important; content: none !important; }',
					'#maincontent .cbi-section-table .cbi-section-table-row { display: table-row !important; }',
					'#maincontent .cbi-section-table .cbi-section-table-titles { display: table-row !important; }',
					'#maincontent .cbi-section-table .cbi-section-table-row > .td { display: table-cell !important; }',
					'#maincontent .cbi-section-table .cbi-section-table-titles > .th { display: table-cell !important; }',
					'#maincontent .cbi-section-table .cbi-section-table-row > .td[data-title]::before { display: none !important; content: none !important; }'
				]));
				return node;
			});
		}, this);

		s = m.section(form.GridSection, 'dns_group', _('DNS Group List'));
		s.anonymous = false;
		s.addremove = true;
		s.sortable = false;
		s.nodescriptions = true;
		s.modaltitle = _('DNS Group');
		s.addbtntitle = _('Add DNS Group');
		s.cfgsections = function () {
			return uci.sections('mosdns', 'dns_group')
				.sort(function (a, b) {
					return (a['.index'] || 0) - (b['.index'] || 0);
				})
				.map(function (sec) { return sec['.name']; });
		};
		s.renderSectionAdd = function (extra_class) {
			var createEl = E('div', { 'class': 'cbi-section-create' });
			var btnTitle = this.titleFn('addbtntitle') || _('Add');

			if (extra_class != null)
				createEl.classList.add(extra_class);

			createEl.appendChild(E('button', {
				'class': 'cbi-button cbi-button-add',
				'title': btnTitle,
				'click': ui.createHandlerFn(this, 'handleAdd'),
				'disabled': this.map.readonly || null
			}, [ btnTitle ]));

			return createEl;
		};
		s.handleAdd = function (ev) {
			var config_name = this.uciconfig || this.map.config;
			var section_id = this.map.data.add(config_name, this.sectiontype, generateDnsGroupId());
			var mapNode = this.getPreviousModalMap();
			var prevMap = mapNode ? dom.findClassInstance(mapNode) : this.map;

			prevMap.addedSection = section_id;
			uci.set('mosdns', section_id, 'is_default', '0');
			uci.set('mosdns', section_id, 'use_default_dns', '0');
			uci.set('mosdns', section_id, 'dns', [ '8.8.8.8' ]);

			return this.renderMoreOptionsModal(section_id);
		};
		s.handleRemove = function (section_id, ev) {
			var groups = uci.sections('mosdns', 'dns_group');
			var resolved = resolveGroupId(section_id, groups);

			if (!resolved)
				return Promise.resolve();

			if (uci.get('mosdns', resolved, 'is_default') === '1') {
				ui.addNotification(null,
					E('p', _('Default DNS group cannot be deleted. Please set another group as default first.')),
					'error');
				return Promise.resolve();
			}

			if (uci.sections('mosdns', 'rule').some(function (r) { return ruleUsesDnsGroup(r, resolved, groups); })) {
				ui.addNotification(null,
					E('p', _('This DNS group is referenced by rules and cannot be deleted.')),
					'error');
				return Promise.resolve();
			}

			return form.GridSection.prototype.handleRemove.apply(this, [ resolved, ev ]);
		};

		o = s.option(form.Value, 'name', _('Group Name'));
		o.rmempty = false;
		o.placeholder = _('DNS Group');
		o.validate = function (section_id, value) {
			var sid = resolveGroupSectionId(section_id);
			var n = normalizeName(value);

			if (!n)
				return _('Expecting: non-empty value');

			if (isGroupNameTaken(value, sid))
				return DUPLICATE_NAME_MSG;

			return true;
		};
		o.write = function (section_id, formvalue) {
			var sid = resolveGroupSectionId(section_id);
			var value = String(formvalue || '').trim();
			var n = normalizeName(value);

			if (!n)
				throw new Error(_('Expecting: non-empty value'));
			if (isGroupNameTaken(value, sid))
				throw new Error(DUPLICATE_NAME_MSG);

			uci.set('mosdns', sid, 'name', value);
		};
		o.sortable = false;

		o = s.option(form.DynamicList, 'dns', _('DNS Servers'));
		o.rmempty = false;
		o.depends('use_default_dns', '0');
		o.value('119.29.29.29', _('Tencent Public DNS (119.29.29.29)'));
		o.value('119.28.28.28', _('Tencent Public DNS (119.28.28.28)'));
		o.value('223.5.5.5', _('Aliyun Public DNS (223.5.5.5)'));
		o.value('223.6.6.6', _('Aliyun Public DNS (223.6.6.6)'));
		o.value('114.114.114.114', _('Xinfeng Public DNS (114.114.114.114)'));
		o.value('114.114.115.115', _('Xinfeng Public DNS (114.114.115.115)'));
		o.value('180.76.76.76', _('Baidu Public DNS (180.76.76.76)'));
		o.value('tls://1.1.1.1', _('CloudFlare Public DNS (DoT 1.1.1.1)'));
		o.value('tls://1.0.0.1', _('CloudFlare Public DNS (DoT 1.0.0.1)'));
		o.value('tls://8.8.8.8', _('Google Public DNS (DoT 8.8.8.8)'));
		o.value('tls://8.8.4.4', _('Google Public DNS (DoT 8.8.4.4)'));
		o.value('https://dns.alidns.com/dns-query', _('Aliyun Public DNS (DoH)'));
		o.value('h3://dns.alidns.com/dns-query', _('Aliyun Public DNS (DoH3)'));
		o.value('https://doh.pub/dns-query', _('Tencent Public DNS (DoH)'));
		o.value('quic://dns.alidns.com', _('Aliyun Public DNS (DoQ)'));
		o.textvalue = function (section_id) {
			if (uci.get('mosdns', section_id, 'use_default_dns') === '1')
				return _('Use Interface Default DNS');

			var v = uci.get('mosdns', section_id, 'dns');
			if (Array.isArray(v) && v.length)
				return v.join(', ');
			if (typeof v === 'string' && v.length)
				return v;
			return '-';
		};
		o.sortable = false;

		o = s.option(form.Flag, 'use_default_dns', _('Use Interface Default DNS'),
			_('Use DNS from WAN static config or PPPoE/DHCP dynamic assignment.'));
		o.rmempty = false;
		o.default = '0';
		o.modalonly = true;
		o.sortable = false;

		o = s.option(form.DummyValue, '_default_state', _('Default'));
		o.cfgvalue = function (section_id) {
			return uci.get('mosdns', section_id, 'is_default') === '1' ? _('Yes') : _('No');
		};
		o.sortable = false;

		o = s.option(form.Button, '_set_default', _('Set As Default'));
		o.inputtitle = _('Set As Default');
		o.inputstyle = 'apply';
		o.modalonly = true;
		o.onclick = function (arg1, arg2) {
			var section_id = null;

			if (typeof arg1 === 'string')
				section_id = arg1;
			else if (typeof arg2 === 'string')
				section_id = arg2;

			if (!section_id && this && typeof this.section === 'string')
				section_id = this.section;
			if (!section_id && this && this.section && typeof this.section.section === 'string')
				section_id = this.section.section;

			if (!section_id) {
				ui.addNotification(null, E('p', _('Failed to identify current DNS group.')), 'error');
				return Promise.resolve();
			}

			uci.sections('mosdns', 'dns_group', function (sec) {
				uci.set('mosdns', sec['.name'], 'is_default', sec['.name'] === section_id ? '1' : '0');
			});

			ui.addNotification(null,
				E('p', _('Default DNS group marked. Please click Save or Save & Apply to take effect.')),
				'info');

			return Promise.resolve();
		};
		o.sortable = false;

		o = s.option(form.Value, 'bootstrap_dns', _('Bootstrap DNS servers'));
		o.modalonly = true;
		o.sortable = false;

		o = s.option(form.Value, 'concurrent', _('Concurrent'));
		o.datatype = 'and(uinteger,min(1),max(3))';
		o.modalonly = true;
		o.sortable = false;

		return m.render();
	}
});
