'use strict';
'require form';
'require ui';
'require view';

function clone(obj) {
	return JSON.parse(JSON.stringify(obj));
}

function buildInitialData() {
	return {
		dns_group: [
			{
				'.name': 'dns_cn',
				name: '国内',
				is_default: '0'
			},
			{
				'.name': 'dns_global',
				name: '国外',
				is_default: '1'
			}
		],
		control: {
			name: 'Rules UI Test'
		},
		rule: [
			{
				'.name': 'rule_hosts',
				enabled: '1',
				name: '节点IP',
				mode: 'hosts'
			},
			{
				'.name': 'rule_ddns',
				enabled: '1',
				name: 'DDNS域名',
				mode: 'custom',
				dns_group: 'dns_cn'
			},
			{
				'.name': 'rule_apple',
				enabled: '1',
				name: 'Apple 域名优化',
				mode: 'builtin',
				builtin_type: 'apple_domain',
				dns_group: 'dns_cn'
			},
			{
				'.name': 'rule_force_global',
				enabled: '1',
				name: '强制国外解析',
				mode: 'custom',
				dns_group: 'dns_global'
			},
			{
				'.name': 'rule_force_cn',
				enabled: '1',
				name: '强制国内解析',
				mode: 'custom',
				dns_group: 'dns_cn'
			},
			{
				'.name': 'rule_cn',
				enabled: '1',
				name: '国内域名',
				mode: 'builtin',
				builtin_type: 'cn_domain',
				dns_group: 'dns_cn'
			},
			{
				'.name': 'rule_global',
				enabled: '1',
				name: '国外域名',
				mode: 'builtin',
				builtin_type: 'noncn_domain',
				dns_group: 'dns_global'
			}
		]
	};
}

function normalizeRuleType(rule) {
	var mode = rule.mode || 'custom';
	var builtinType = rule.builtin_type || '';

	if (mode === 'hosts')
		return _('HOSTS');
	if (mode === 'custom')
		return _('Custom Rule');
	if (mode !== 'builtin')
		return mode;

	switch (builtinType) {
	case 'adblock':
		return _('ADBlock Rule');
	case 'apple_domain':
		return _('Apple Domain Optimization');
	case 'cn_domain':
		return _('China Domain');
	case 'noncn_domain':
		return _('Global Domain');
	default:
		return builtinType || _('Built-in Rule');
	}
}

function usesDnsGroup(rule) {
	var mode = rule.mode || 'custom';
	var builtinType = rule.builtin_type || '';

	return mode === 'custom' || (mode === 'builtin' &&
		(builtinType === 'cn_domain' || builtinType === 'noncn_domain' || builtinType === 'apple_domain'));
}

function snapshotDnsGroups(data) {
	return (data.rule || []).map(function (rule) {
		return {
			name: rule.name || rule['.name'],
			dns_group: rule.dns_group || ''
		};
	});
}

function formatSnapshot(snapshot, groupMap) {
	return snapshot.map(function (item) {
		return {
			name: item.name,
			dns_group: groupMap[item.dns_group] || item.dns_group || '-'
		};
	});
}

function stripSection(sec) {
	var out = { '.name': sec['.name'] };

	Object.keys(sec).forEach(function (k) {
		if (k.charAt(0) === '.')
			return;
		out[k] = sec[k];
	});

	return out;
}

return view.extend({
	load: function () {
		if (!this.mockData)
			this.mockData = buildInitialData();
		if (!this.reportLog)
			this.reportLog = [];
		return Promise.resolve();
	},

	persistFromMap: function () {
		var map = this.map;
		this.mockData = {
			dns_group: map.data.sections('json', 'dns_group').map(stripSection),
			control: stripSection(map.data.get('json', 'control')),
			rule: map.data.sections('json', 'rule').map(stripSection)
		};
	},

	appendReport: function (label, before, after) {
		var groups = {};
		(this.mockData.dns_group || []).forEach(function (g) {
			groups[g['.name']] = g.name || g['.name'];
		});

		this.reportLog.unshift({
			label: label,
			time: new Date().toLocaleTimeString(),
			before: formatSnapshot(before, groups),
			after: formatSnapshot(after, groups)
		});
	},

	refreshPage: function () {
		var self = this;
		return this.render().then(function (node) {
			var old = document.getElementById('mosdns-rules-ui-test-root');
			if (old && old.parentNode)
				old.parentNode.replaceChild(node, old);
			return node;
		}).then(function () {
			return self;
		});
	},

	prependTestRule: function () {
		var rules = this.mockData.rule || [];
		var exists = rules.some(function (r) { return r['.name'] === 'rule_test_ad'; });

		if (!exists) {
			rules.unshift({
				'.name': 'rule_test_ad',
				enabled: '0',
				name: 'test广告节点',
				mode: 'builtin',
				builtin_type: 'adblock'
			});
		}

		return this.refreshPage();
	},

	removeTestRule: function () {
		this.mockData.rule = (this.mockData.rule || []).filter(function (r) {
			return r['.name'] !== 'rule_test_ad';
		});

		return this.refreshPage();
	},

	resetMockData: function () {
		this.mockData = buildInitialData();
		this.reportLog = [];
		return this.refreshPage();
	},

	handleSave: function () {
		if (!this.map)
			return Promise.resolve();

		var before = snapshotDnsGroups(this.mockData);

		return this.map.save(null, false).then(L.bind(function () {
			this.persistFromMap();
			this.appendReport('save', before, snapshotDnsGroups(this.mockData));
			return this.refreshPage();
		}, this));
	},

	handleSaveApply: function () {
		if (!this.map)
			return Promise.resolve();

		var before = snapshotDnsGroups(this.mockData);

		return this.map.save(null, false).then(L.bind(function () {
			this.persistFromMap();
			this.appendReport('save_apply', before, snapshotDnsGroups(this.mockData));
			ui.addNotification(null, E('p', _('Mock Save & Apply completed. No mosdns service or UCI config was changed.')), 'info');
			return this.refreshPage();
		}, this));
	},

	handleReset: function () {
		return this.resetMockData();
	},

	render: function () {
		var self = this;
		var m = new form.JSONMap(clone(this.mockData), _('Rules UI Test'),
			_('This page uses browser-only mock data to isolate LuCI GridSection and Save/Save & Apply behavior. It does not touch real mosdns config or restart services.'));
		this.map = m;

		var groups = m.data.sections('json', 'dns_group');
		var groupMap = {};
		var defaultGroup = groups.length ? groups[0]['.name'] : '';
		groups.forEach(function (g) {
			groupMap[g['.name']] = g.name || g['.name'];
			if (g.is_default === '1')
				defaultGroup = g['.name'];
		});

		var s = m.section(form.GridSection, 'rule', _('Mock Rule List'));
		s.anonymous = true;
		s.addremove = true;
		s.sortable = true;
		s.nodescriptions = true;
		s.modaltitle = _('Mock Rule');
		s.addbtntitle = _('Add Rule');
		s.cfgsections = function () {
			return m.data.sections('json', 'rule').map(function (sec) { return sec['.name']; });
		};

		var o = s.option(form.Flag, 'enabled', _('Enabled'));
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.Value, 'name', _('Rule Name'));
		o.rmempty = false;

		o = s.option(form.DummyValue, '_rule_type', _('Rule Type'));
		o.cfgvalue = function (section_id) {
			return normalizeRuleType(m.data.get('json', section_id));
		};

		o = s.option(form.DummyValue, '_dns_group_text', _('DNS Group'));
		o.cfgvalue = function (section_id) {
			var sec = m.data.get('json', section_id);
			if (!usesDnsGroup(sec))
				return '-';
			return groupMap[sec.dns_group] || _('Default DNS Group');
		};

		o = s.option(form.ListValue, 'mode', _('Mode'));
		o.value('custom', _('Custom Rule'));
		o.value('builtin', _('Built-in Rule'));
		o.value('hosts', _('HOSTS'));
		o.modalonly = true;

		o = s.option(form.ListValue, 'builtin_type', _('Built-in Type'));
		o.value('adblock', _('ADBlock Rule'));
		o.value('apple_domain', _('Apple Domain Optimization'));
		o.value('cn_domain', _('China Domain'));
		o.value('noncn_domain', _('Global Domain'));
		o.depends('mode', 'builtin');
		o.modalonly = true;

		o = s.option(form.ListValue, 'dns_group', _('DNS Group'));
		groups.forEach(function (g) {
			o.value(g['.name'], g.name || g['.name']);
		});
		o.default = defaultGroup;
		o.depends('mode', 'custom');
		o.depends({ mode: 'builtin', builtin_type: 'apple_domain' });
		o.depends({ mode: 'builtin', builtin_type: 'cn_domain' });
		o.depends({ mode: 'builtin', builtin_type: 'noncn_domain' });
		o.modalonly = true;

		return m.render().then(function (mapNode) {
			var reportText = self.reportLog.length ? JSON.stringify(self.reportLog, null, 2) : _('No operations yet.');

			return E('div', { 'id': 'mosdns-rules-ui-test-root' }, [
				E('div', {
					'class': 'cbi-section',
					'style': 'margin-bottom:1em;'
				}, [
					E('button', {
						'class': 'btn cbi-button cbi-button-add',
						'type': 'button',
						'click': function (ev) {
							ev.preventDefault();
							return self.prependTestRule();
						}
					}, [ _('Prepend Test AD Rule') ]),
					' ',
					E('button', {
						'class': 'btn cbi-button cbi-button-remove',
						'type': 'button',
						'click': function (ev) {
							ev.preventDefault();
							return self.removeTestRule();
						}
					}, [ _('Remove Test Rule') ]),
					' ',
					E('button', {
						'class': 'btn cbi-button cbi-button-reset',
						'type': 'button',
						'click': function (ev) {
							ev.preventDefault();
							return self.resetMockData();
						}
					}, [ _('Reset Mock Data') ])
				]),
				mapNode,
				E('div', { 'class': 'cbi-section' }, [
					E('h3', _('Operation Report')),
					E('pre', {
						'style': 'white-space:pre-wrap; word-break:break-word; max-height:28em; overflow:auto;'
					}, [ reportText ])
				])
			]);
		});
	}
});
