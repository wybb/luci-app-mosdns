'use strict';
'require form';
'require fs';
'require mosdns/rulefile_utils as rulefile_utils';
'require rpc';
'require uci';
'require ui';
'require view';

var PRESET_AD_SOURCES = [
	'geosite.dat',
	'https://raw.githubusercontent.com/privacy-protection-tools/anti-AD/master/anti-ad-domains.txt',
	'https://raw.githubusercontent.com/Cats-Team/AdRules/main/mosdns_adrules.txt',
	'https://raw.githubusercontent.com/neodevpro/neodevhost/master/domain'
];

var PRESET_AD_SOURCE_MAP = PRESET_AD_SOURCES.reduce(function (m, v) {
	m[v] = true;
	return m;
}, {});

var RULE_TYPE_META = {
	adblock: {
		label: _('ADBlock Rule'),
		desc: _('Filter advertisement domains using preset sources.')
	},
	apple_domain: {
		label: _('Apple Domain Optimization'),
		desc: _('Route Apple domains to the selected DNS group.')
	},
	cn_domain: {
		label: _('China Domain'),
		desc: _('Route China domains to the selected DNS group.')
	},
	noncn_domain: {
		label: _('Global Domain'),
		desc: _('Route non-China domains to the selected DNS group.')
	},
	hosts: {
		label: _('HOSTS'),
		desc: _('Resolve domains from HOSTS list with fixed IP mapping.')
	},
	redirect: {
		label: _('Redirect'),
		desc: _('Rewrite queried domains to another domain.')
	},
	blacklist_ptr: {
		label: _('PTR Blacklist'),
		desc: _('Block PTR reverse-lookup domains in list.')
	},
	blacklist_domain: {
		label: _('Domain Blacklist'),
		desc: _('Block domains in list.')
	},
	custom: {
		label: _('Custom Rule'),
		desc: _('Apply custom domain rules (plain/full/keyword/regexp). You can set TTL as needed.')
	}
};

var callUciOrder = rpc.declare({
	object: 'uci',
	method: 'order',
	params: [ 'config', 'sections' ],
	expect: { '': 0 }
});

var RULE_CONTENT_SAMPLES = {
	blacklist_domain: [
		'# domain blacklist examples',
		'ads.example.com',
		'tracker.example.net'
	].join('\n'),
	blacklist_ptr: [
		'# ptr blacklist examples',
		'10.in-addr.arpa',
		'127.in-addr.arpa',
		'16.172.in-addr.arpa',
		'17.172.in-addr.arpa',
		'18.172.in-addr.arpa',
		'19.172.in-addr.arpa',
		'20.172.in-addr.arpa',
		'21.172.in-addr.arpa',
		'22.172.in-addr.arpa',
		'23.172.in-addr.arpa',
		'24.172.in-addr.arpa',
		'25.172.in-addr.arpa',
		'26.172.in-addr.arpa',
		'27.172.in-addr.arpa',
		'28.172.in-addr.arpa',
		'29.172.in-addr.arpa',
		'30.172.in-addr.arpa',
		'31.172.in-addr.arpa',
		'64.100.in-addr.arpa',
		'65.100.in-addr.arpa',
		'66.100.in-addr.arpa',
		'67.100.in-addr.arpa',
		'68.100.in-addr.arpa',
		'69.100.in-addr.arpa',
		'70.100.in-addr.arpa',
		'71.100.in-addr.arpa',
		'72.100.in-addr.arpa',
		'73.100.in-addr.arpa',
		'74.100.in-addr.arpa',
		'75.100.in-addr.arpa',
		'76.100.in-addr.arpa',
		'77.100.in-addr.arpa',
		'78.100.in-addr.arpa',
		'79.100.in-addr.arpa',
		'80.100.in-addr.arpa',
		'81.100.in-addr.arpa',
		'82.100.in-addr.arpa',
		'83.100.in-addr.arpa',
		'84.100.in-addr.arpa',
		'85.100.in-addr.arpa',
		'86.100.in-addr.arpa',
		'87.100.in-addr.arpa',
		'88.100.in-addr.arpa',
		'89.100.in-addr.arpa',
		'90.100.in-addr.arpa',
		'91.100.in-addr.arpa',
		'92.100.in-addr.arpa',
		'93.100.in-addr.arpa',
		'94.100.in-addr.arpa',
		'95.100.in-addr.arpa',
		'96.100.in-addr.arpa',
		'97.100.in-addr.arpa',
		'98.100.in-addr.arpa',
		'99.100.in-addr.arpa',
		'100.100.in-addr.arpa',
		'101.100.in-addr.arpa',
		'102.100.in-addr.arpa',
		'103.100.in-addr.arpa',
		'104.100.in-addr.arpa',
		'105.100.in-addr.arpa',
		'106.100.in-addr.arpa',
		'107.100.in-addr.arpa',
		'108.100.in-addr.arpa',
		'109.100.in-addr.arpa',
		'110.100.in-addr.arpa',
		'111.100.in-addr.arpa',
		'112.100.in-addr.arpa',
		'113.100.in-addr.arpa',
		'114.100.in-addr.arpa',
		'115.100.in-addr.arpa',
		'116.100.in-addr.arpa',
		'117.100.in-addr.arpa',
		'118.100.in-addr.arpa',
		'119.100.in-addr.arpa',
		'120.100.in-addr.arpa',
		'121.100.in-addr.arpa',
		'122.100.in-addr.arpa',
		'123.100.in-addr.arpa',
		'124.100.in-addr.arpa',
		'125.100.in-addr.arpa',
		'126.100.in-addr.arpa',
		'127.100.in-addr.arpa',
		'2.0.192.in-addr.arpa',
		'168.192.in-addr.arpa',
		'255.255.255.255.in-addr.arpa',
		'domain:ip6.arpa'
	].join('\n'),
	hosts: [
		'# hosts rewrite examples',
		'a.com 127.0.0.4',
		'b.com 127.0.0.5'
	].join('\n'),
	redirect: [
		'# redirect examples',
		'a.com b.com',
		'foo.example bar.example'
	].join('\n'),
	custom: [
		'# custom rule examples',
		'example.com',
		'full:www.example.com',
		'keyword:stream',
		'regexp:^ads[0-9]*\\.example\\.com$'
	].join('\n'),
	ip_map: [
		'# ip or cidr list examples',
		'1.1.1.1',
		'1.0.0.0/24'
	].join('\n')
};

function normalizeRuleContent(raw) {
	return rulefile_utils.normalizeContent(raw);
}

function commentizeSampleContent(raw) {
	return String(raw || '').split('\n').map(function (line) {
		var t = line.trim();
		if (!t || t.charAt(0) === '#')
			return line;
		return '# ' + t;
	}).join('\n');
}

function readRuleFile(rule_file) {
	return fs.trimmed(rulefile_utils.resolveRulePath(rule_file)).catch(function () { return ''; });
}

function normalizeName(v) {
	return String(v || '').trim().toLowerCase();
}

function isRuleNameTaken(name, excludeSid) {
	var n = normalizeName(name);
	if (!n)
		return false;

	return uci.sections('mosdns', 'rule').some(function (sec) {
		if (excludeSid && sec['.name'] === excludeSid)
			return false;
		return normalizeName(sec.name) === n;
	});
}

function nextRuleFileRef(section_id) {
	var sid = resolveRuleSectionId(section_id);
	var mode = uci.get('mosdns', sid, 'mode') || 'custom';
	var name = uci.get('mosdns', sid, 'name') || sid;
	var prefix = (mode === 'ip_map') ? 'rule-ip-map' : 'rule-dns';
	return rulefile_utils.buildVersionedRuleRef(prefix, name);
}

function getRuleTypeId(section_id) {
	section_id = resolveRuleSectionId(section_id);
	var mode = uci.get('mosdns', section_id, 'mode') || 'custom';
	var bt = uci.get('mosdns', section_id, 'builtin_type') || '';
	var blt = uci.get('mosdns', section_id, 'blacklist_type') || 'domain';

	if (mode === 'builtin')
		return bt || 'custom';

	if (mode === 'blacklist')
		return blt === 'ptr' ? 'blacklist_ptr' : 'blacklist_domain';

	if (mode === 'hosts')
		return 'hosts';

	if (mode === 'redirect')
		return 'redirect';

	if (mode === 'ip_map')
		return 'ip_map';

	return 'custom';
}

function ruleTypeLabel(section_id) {
	var t = getRuleTypeId(section_id);
	return (RULE_TYPE_META[t] && RULE_TYPE_META[t].label) || _('Custom Rule');
}

function ensureRuleSample(section_id) {
	section_id = resolveRuleSectionId(section_id);
	var mode = uci.get('mosdns', section_id, 'mode') || 'custom';
	var bt = uci.get('mosdns', section_id, 'blacklist_type') || 'domain';
	var key = null;

	if (mode === 'blacklist')
		key = bt === 'ptr' ? 'blacklist_ptr' : 'blacklist_domain';
	else if (mode === 'hosts')
		key = 'hosts';
	else if (mode === 'redirect')
		key = 'redirect';
	else if (mode === 'custom')
		key = 'custom';
	else if (mode === 'ip_map')
		key = 'ip_map';

	if (!key)
		return Promise.resolve();

	var file = ensureRuleFile(section_id);
	if (!file)
		return Promise.resolve();

	return readRuleFile(file).then(function (old) {
		if (old && old.trim().length)
			return;
		return rulefile_utils.writeRuleFile(file, commentizeSampleContent(RULE_CONTENT_SAMPLES[key]));
	}).catch(function () {
		return;
	});
}

function createRuleByType(typeId, ruleName, defaultGroup, cnGroup, globalGroup) {
	var sid = uci.add('mosdns', 'rule', 'rule_' + String(Date.now()));
	var name = String(ruleName || '').trim() || _('New Rule');

	if (!sid)
		return Promise.reject(new Error('failed to add uci rule section'));

	uci.set('mosdns', sid, 'enabled', '0');
	uci.set('mosdns', sid, 'ip_strategy', 'auto');
	uci.set('mosdns', sid, 'ttl', '0');

	if (typeId === 'builtin_adblock') {
		uci.set('mosdns', sid, 'name', name);
		uci.set('mosdns', sid, 'mode', 'builtin');
		uci.set('mosdns', sid, 'builtin_type', 'adblock');
		uci.set('mosdns', sid, 'ad_source', 'geosite.dat');
		uci.set('mosdns', sid, 'enabled', '0');
	} else if (typeId === 'builtin_apple') {
		uci.set('mosdns', sid, 'name', name);
		uci.set('mosdns', sid, 'mode', 'builtin');
		uci.set('mosdns', sid, 'builtin_type', 'apple_domain');
		uci.set('mosdns', sid, 'dns_group', cnGroup || defaultGroup || '');
		uci.set('mosdns', sid, 'rule_file', '/var/mosdns/geosite_apple.txt');
		uci.set('mosdns', sid, 'enabled', '0');
	} else if (typeId === 'builtin_cn') {
		uci.set('mosdns', sid, 'name', name);
		uci.set('mosdns', sid, 'mode', 'builtin');
		uci.set('mosdns', sid, 'builtin_type', 'cn_domain');
		uci.set('mosdns', sid, 'dns_group', cnGroup || defaultGroup || '');
		uci.set('mosdns', sid, 'rule_file', '/var/mosdns/geosite_cn.txt');
	} else if (typeId === 'builtin_global') {
		uci.set('mosdns', sid, 'name', name);
		uci.set('mosdns', sid, 'mode', 'builtin');
		uci.set('mosdns', sid, 'builtin_type', 'noncn_domain');
		uci.set('mosdns', sid, 'dns_group', globalGroup || defaultGroup || '');
		uci.set('mosdns', sid, 'ip_strategy', 'ipv4');
		uci.set('mosdns', sid, 'rule_file', '/var/mosdns/geosite_geolocation-!cn.txt');
	} else if (typeId === 'blacklist_domain') {
		uci.set('mosdns', sid, 'name', name);
		uci.set('mosdns', sid, 'mode', 'blacklist');
		uci.set('mosdns', sid, 'blacklist_type', 'domain');
		ensureRuleFile(sid);
	} else if (typeId === 'blacklist_ptr') {
		uci.set('mosdns', sid, 'name', name);
		uci.set('mosdns', sid, 'mode', 'blacklist');
		uci.set('mosdns', sid, 'blacklist_type', 'ptr');
		ensureRuleFile(sid);
	} else if (typeId === 'hosts') {
		uci.set('mosdns', sid, 'name', name);
		uci.set('mosdns', sid, 'mode', 'hosts');
		ensureRuleFile(sid);
	} else if (typeId === 'redirect') {
		uci.set('mosdns', sid, 'name', name);
		uci.set('mosdns', sid, 'mode', 'redirect');
		ensureRuleFile(sid);
	} else {
		uci.set('mosdns', sid, 'name', name);
		uci.set('mosdns', sid, 'mode', 'custom');
		uci.set('mosdns', sid, 'dns_group', defaultGroup || '');
		ensureRuleFile(sid);
	}

	return ensureRuleSample(sid).then(function () { return sid; });
}

function moveRuleToTop(section_id) {
	if (!section_id)
		return Promise.resolve();

	var order = [ section_id ];
	uci.sections('mosdns', 'rule').forEach(function (sec) {
		if (sec['.name'] !== section_id)
			order.push(sec['.name']);
	});

	return callUciOrder('mosdns', order);
}

function isIpToken(s) {
	return /^(\d{1,3}\.){3}\d{1,3}$/.test(s) || /:/.test(s);
}

function normalizeHostsContent(raw) {
	return (raw || '').split(/\n/).map(function (line) {
		var t = line.trim();
		if (!t || t.charAt(0) === '#')
			return line;

		var parts = t.split(/\s+/);
		if (parts.length >= 2 && isIpToken(parts[0]) && !isIpToken(parts[1]))
			return [ parts[1], parts[0] ].concat(parts.slice(2)).join(' ');

		return t;
	}).join('\n');
}

function ensureRuleModalHiddenFieldsStyle() {
	var id = 'mosdns-rules-modal-hidden-fields';
	if (document.getElementById(id))
		return;

	var style = document.createElement('style');
	style.id = id;
	style.textContent = [
		'#modal_overlay .cbi-value[data-name="mode"] { display: none !important; }',
		'#modal_overlay .cbi-value[data-name="builtin_type"] { display: none !important; }',
		'#modal_overlay .cbi-value[data-name="blacklist_type"] { display: none !important; }'
	].join('\n');
	document.head.appendChild(style);
}

function hideRuleInternalFieldsInModal() {
	var modal = document.getElementById('modal_overlay');
	if (!modal)
		return;

	var rows = modal.querySelectorAll('.cbi-value');
	for (var i = 0; i < rows.length; i++) {
		var row = rows[i];
		var name = row.getAttribute('data-name') || '';
		var title = (row.querySelector('.cbi-value-title') && row.querySelector('.cbi-value-title').textContent || '').trim();

		if (name === 'mode' || name === 'builtin_type' || name === 'blacklist_type' ||
			title === 'Mode' || title === 'Built-in Type' || title === 'Blacklist Type' || title === '模式') {
			row.style.display = 'none';
		}
	}
}

function logUiEvent(evt) {
	return fs.exec('/usr/share/mosdns/mosdns.sh', [ 'ui_event', evt, 'rules_v2' ]).catch(function () { return null; });
}

function flushAndRestartMosdns() {
	return fs.exec('/usr/share/mosdns/mosdns.sh', [ 'flush' ])
		.catch(function () { return null; })
		.then(function () {
			return fs.exec('/etc/init.d/mosdns', [ 'restart' ]);
		});
}

function ensureRuleFile(section_id) {
	section_id = resolveRuleSectionId(section_id);
	if (!isRuleContentEditable(section_id))
		return rulefile_utils.getRuleRef('rule', section_id, '');

	return rulefile_utils.ensureRuleRef('rule', section_id, 'rule-' + section_id + '.txt');
}

function isRuleContentEditable(section_id) {
	section_id = resolveRuleSectionId(section_id);
	var mode = uci.get('mosdns', section_id, 'mode');
	return mode === 'blacklist' || mode === 'ip_map' || mode === 'hosts' ||
		mode === 'redirect' || mode === 'custom';
}

function resolveRuleSectionId(section_id) {
	return rulefile_utils.resolveSectionId('rule', section_id);
}

function isRuleFileBacked(section_id) {
	return isRuleContentEditable(section_id);
}

function getRuleFileForSection(section_id) {
	section_id = resolveRuleSectionId(section_id);
	if (!isRuleFileBacked(section_id))
		return '';

	return ensureRuleFile(section_id);
}

function deleteRuleFileIfUnusedByPath(p) {
	if (!p)
		return Promise.resolve();

	if (p.indexOf('/etc/mosdns/rule/') !== 0)
		return Promise.resolve();

	var inUse = uci.sections('mosdns', 'rule').some(function (sec) {
		if (!isRuleFileBacked(sec['.name']))
			return false;

		return rulefile_utils.resolveRulePath(uci.get('mosdns', sec['.name'], 'rule_file') || ensureRuleFile(sec['.name'])) === p;
	});

	if (inUse)
		return Promise.resolve();

	return fs.remove(p).catch(function () { return null; });
}

return view.extend({
	load: function () {
		return uci.load('mosdns');
	},

	handleSave: function () {
		if (!this.map)
			return Promise.resolve();

		return logUiEvent('save_click').then(L.bind(function () {
			return this.map.save(null, false);
		}, this));
	},

	handleSaveApply: function (ev) {
		return logUiEvent('save_apply_click').then(L.bind(function () {
			return this.handleSave(ev);
		}, this)).then(function () {
			return ui.changes.apply(false);
		}).then(function () {
			return flushAndRestartMosdns();
		});
	},

	handleReset: function () {
		if (!this.map)
			return Promise.resolve();

		return this.map.reset().then(function () {
			return uci.load('mosdns');
		});
	},

	render: function () {
		var m, s, o, a;
		ensureRuleModalHiddenFieldsStyle();
		var groups = uci.sections('mosdns', 'dns_group');
		var groupNameMap = {};
		var defaultGroup = null;
		var cnGroup = null;
		var globalGroup = null;

		groups.forEach(function (g, idx) {
			var label = g.name || g['.name'];
			groupNameMap[g['.name']] = label;
			if (g.is_default === '1')
				defaultGroup = g['.name'];
			if (label === '国内' && !cnGroup)
				cnGroup = g['.name'];
			if (label === '国外' && !globalGroup)
				globalGroup = g['.name'];
		});

		if (!defaultGroup && groups.length)
			defaultGroup = groups[0]['.name'];

		m = new form.Map('mosdns', _('Rule Settings'),
			_('Rules are matched from top to bottom. If no rule matches, the default DNS group is used as fallback.'));
		this.map = m;

		a = m.section(form.TypedSection, 'mosdns', _('Default Actions'));
		a.anonymous = true;
		a.addremove = false;
		a.cfgsections = function () {
			return [ 'config' ];
		};

		o = a.option(form.Button, '_restore_defaults', _('Restore Default Rules'));
		o.inputtitle = _('Restore Default Rules');
		o.inputstyle = 'remove';
		o.onclick = function () {
			if (!confirm(_('This operation will clear current rule settings and restore default DNS groups (CN/Global). Continue?')))
				return Promise.resolve();

			return fs.exec('/usr/share/mosdns/mosdns.sh', ['restore_rule_defaults'])
				.then(function (res) {
					if (res.code !== 0) {
						ui.addNotification(null, E('p', _('Failed to restore default rules.')), 'error');
						return;
					}

					return fs.exec('/etc/init.d/mosdns', ['restart'])
						.then(function () {
							ui.addNotification(null, E('p', _('Default rules restored.')), 'info');
							window.location.reload();
						});
				});
		};

		o = a.option(form.Button, '_restore_rules_only', _('Restore Default Rules (Keep DNS Groups)'));
		o.inputtitle = _('Restore Default Rules (Keep DNS Groups)');
		o.inputstyle = 'remove';
		o.onclick = function () {
			if (!confirm(_('This operation will clear current rule settings only and keep current DNS groups. Continue?')))
				return Promise.resolve();

			return fs.exec('/usr/share/mosdns/mosdns.sh', ['restore_rule_defaults_keep_groups'])
				.then(function (res) {
					if (res.code !== 0) {
						ui.addNotification(null, E('p', _('Failed to restore default rules.')), 'error');
						return;
					}

					return fs.exec('/etc/init.d/mosdns', ['restart'])
						.then(function () {
							ui.addNotification(null, E('p', _('Default rules restored.')), 'info');
							window.location.reload();
						});
				});
		};

		o = a.option(form.ListValue, 'fallback_ip_strategy', _('Fallback IP Strategy'),
			_('IP resolve strategy for fallback queries when no rule matches.'));
		o.value('auto', _('Auto'));
		o.value('ipv4', _('IPv4 Only'));
		o.value('ipv6', _('IPv6 Only'));
		o.value('ipv4_first', _('IPv4 First'));
		o.value('ipv6_first', _('IPv6 First'));
		o.default = 'auto';
		o.rmempty = false;

		s = m.section(form.GridSection, 'rule', _('Rule List'));
		s.anonymous = true;
		s.addremove = true;
		s.sortable = true;
		s.nodescriptions = true;
		s.modaltitle = _('Rule');
		s.addbtntitle = _('Add Rule');
		s.handleRemove = function (section_id, ev) {
			var self = this;

			return m.save(null, false)
				.catch(function () { return null; })
				.then(function () {
					return uci.load('mosdns');
				})
				.then(function () {
					var sid = resolveRuleSectionId(section_id);
					var f = getRuleFileForSection(sid);

					return form.GridSection.prototype.handleRemove.apply(self, [ sid, ev ])
						.then(function () {
							if (f)
								return deleteRuleFileIfUnusedByPath(rulefile_utils.resolveRulePath(f));
							return Promise.resolve();
						});
				});
		};
		s.cfgsections = function () {
			return uci.sections('mosdns', 'rule')
				.sort(function (a, b) {
					return (a['.index'] || 0) - (b['.index'] || 0);
				})
				.map(function (sec) { return sec['.name']; });
		};
		s.handleAdd = function (ev) {
			if (ev)
				ev.preventDefault();

			return new Promise(function (resolve) {
				var builtinChoices = [
					{ id: 'builtin_adblock', key: 'adblock' },
					{ id: 'builtin_apple', key: 'apple_domain' },
					{ id: 'builtin_cn', key: 'cn_domain' },
					{ id: 'builtin_global', key: 'noncn_domain' }
				];
				var otherChoices = [
					{ id: 'hosts', key: 'hosts' },
					{ id: 'redirect', key: 'redirect' },
					{ id: 'blacklist_ptr', key: 'blacklist_ptr' },
					{ id: 'blacklist_domain', key: 'blacklist_domain' },
					{ id: 'custom', key: 'custom' }
				];
				var choices = builtinChoices.concat(otherChoices);
				var optionNodes = [];

				builtinChoices.forEach(function (it) {
					optionNodes.push(E('option', { value: it.id }, [ RULE_TYPE_META[it.key].label ]));
				});
				optionNodes.push(E('option', { value: '__sep__', disabled: 'disabled' }, [ '--------' ]));
				otherChoices.forEach(function (it) {
					optionNodes.push(E('option', { value: it.id }, [ RULE_TYPE_META[it.key].label ]));
				});

				var selector = E('select', { 'class': 'cbi-input-select' }, optionNodes);
				var nameInput = E('input', {
					'class': 'cbi-input-text',
					'type': 'text',
					'placeholder': _('New Rule')
				});
				var descBox = E('p', { 'style': 'margin-top:0.6em; opacity:.9' }, [ '' ]);
				var errBox = E('p', { 'style': 'margin-top:0.4em; color:#b22222; display:none;' }, [ '' ]);

				var updateDesc = function () {
					var t = selector.value || 'custom';
					var row = choices.filter(function (x) { return x.id === t; })[0] || choices[choices.length - 1];
					descBox.textContent = RULE_TYPE_META[row.key].desc;
				};
				selector.addEventListener('change', updateDesc);
				updateDesc();

				ui.showModal(_('Add Rule'), [
					E('div', { 'class': 'cbi-section' }, [
						E('p', _('Select a rule type to create. Type cannot be changed later.')),
						E('p', _('Rule Name')),
						nameInput,
						E('p', { 'style': 'margin-top:0.6em;' }, _('Rule Type')),
						selector,
						descBox,
						errBox
					]),
					E('div', { 'class': 'right' }, [
						E('button', {
							'class': 'btn cbi-button cbi-button-reset',
							'click': function (e) {
								e.preventDefault();
								ui.hideModal();
								resolve();
							}
						}, [ _('Cancel') ]),
						' ',
						E('button', {
							'class': 'btn cbi-button cbi-button-add important',
							'click': function (e) {
								e.preventDefault();
								var inputName = String(nameInput.value || '').trim();
								var row = choices.filter(function (x) { return x.id === (selector.value || 'custom'); })[0] || choices[choices.length - 1];
								var defaultName = (RULE_TYPE_META[row.key] && RULE_TYPE_META[row.key].label) || _('New Rule');
								var finalName = inputName || defaultName || _('New Rule');
								var typeId = selector.value || 'custom';

								errBox.style.display = 'none';
								errBox.textContent = '';
								if (typeId === '__sep__')
									typeId = 'custom';

								if (!finalName.length) {
									errBox.textContent = _('Expecting: non-empty value');
									errBox.style.display = 'block';
									return;
								}

								if (isRuleNameTaken(finalName)) {
									errBox.textContent = _('A rule with this name already exists.');
									errBox.style.display = 'block';
									return;
								}

								var createdSid = null;
								createRuleByType(typeId, finalName, defaultGroup, cnGroup, globalGroup).then(function (sid) {
									createdSid = sid;
									return uci.save();
								}).then(function () {
									return moveRuleToTop(createdSid);
								}).then(function () {
									window.location.reload();
									resolve();
								}).catch(function (err) {
									ui.addNotification(null, E('p', _('Failed to create rule.') + ' ' + (err && err.message ? err.message : '')), 'error');
									resolve();
								});
							}
						}, [ _('Add') ])
					])
				]);
			});
		};

		var _renderMoreOptionsModal = s.renderMoreOptionsModal;
		s.renderMoreOptionsModal = function (section_id) {
			var rv = _renderMoreOptionsModal.apply(this, arguments);
			return Promise.resolve(rv).then(function () {
				hideRuleInternalFieldsInModal();
				return rv;
			});
		};

		o = s.option(form.Flag, 'enabled', _('Enabled'));
		o.rmempty = false;
		o.default = '1';
		o.sortable = false;

		o = s.option(form.Value, 'name', _('Rule Name'));
		o.rmempty = false;
		o.placeholder = _('New Rule');
		o.validate = function (section_id, value) {
			var sid = resolveRuleSectionId(section_id);
			var n = normalizeName(value);
			if (!n)
				return _('Expecting: non-empty value');

			var dup = uci.sections('mosdns', 'rule').some(function (sec) {
				if (sec['.name'] === sid)
					return false;
				return normalizeName(sec.name) === n;
			});

			return dup ? _('A rule with this name already exists.') : true;
		};
		o.sortable = false;

		o = s.option(form.DummyValue, '_rule_type', _('Rule Type'));
		o.cfgvalue = function (section_id) {
			return ruleTypeLabel(section_id);
		};
		o.sortable = false;

		o = s.option(form.ListValue, 'mode', _('Mode'));
		o.value('blacklist', _('Blacklist'));
		o.value('builtin', _('Built-in Rule'));
		o.value('ip_map', _('IP Mapping'));
		o.value('hosts', _('HOSTS'));
		o.value('redirect', _('Redirect'));
		o.value('custom', _('Custom Rule'));
		o.default = 'custom';
		o.readonly = true;
		o.modalonly = true;
		o.textvalue = function (section_id) {
			return ruleTypeLabel(section_id);
		};
		o.sortable = false;

		o = s.option(form.ListValue, 'blacklist_type', _('Blacklist Type'));
		o.value('domain', _('Domain Blacklist'));
		o.value('ptr', _('PTR Blacklist'));
		o.default = 'domain';
		o.readonly = true;
		o.modalonly = true;
		o.depends('mode', 'blacklist');
		o.sortable = false;

		o = s.option(form.ListValue, 'builtin_type', _('Built-in Type'));
		o.value('adblock', _('ADBlock Rule'));
		o.value('cn_domain', _('China Domain'));
		o.value('noncn_domain', _('Global Domain'));
		o.value('apple_domain', _('Apple Domain Optimization'));
		o.default = 'adblock';
		o.readonly = true;
		o.modalonly = true;
		o.depends('mode', 'builtin');
		o.sortable = false;

		o = s.option(form.DynamicList, 'ad_source', _('ADblock Source'),
			_('Use preset AD rule sources only. Custom URLs or local files are not allowed.'));
		o.value('geosite.dat', 'v2ray-geosite');
		o.value('https://raw.githubusercontent.com/privacy-protection-tools/anti-AD/master/anti-ad-domains.txt', 'anti-AD');
		o.value('https://raw.githubusercontent.com/Cats-Team/AdRules/main/mosdns_adrules.txt', 'Cats-Team/AdRules');
		o.value('https://raw.githubusercontent.com/neodevpro/neodevhost/master/domain', 'NEO DEV HOST');
		o.default = 'geosite.dat';
		o.validate = function (section_id, value) {
			if (!value || PRESET_AD_SOURCE_MAP[value])
				return true;
			return _('Only preset ADblock sources are allowed.');
		};
		o.depends({ mode: 'builtin', builtin_type: 'adblock' });
		o.modalonly = true;
		o.sortable = false;

		o = s.option(form.DynamicList, 'ip_map_target', _('Mapped IP'));
		o.datatype = 'ipaddr';
		o.depends('mode', 'ip_map');
		o.modalonly = true;
		o.sortable = false;

		o = s.option(form.ListValue, 'dns_group', _('DNS Group'));
		groups.forEach(function (g) {
			var label = g.name || g['.name'];
			o.value(g['.name'], label);
		});
		if (defaultGroup)
			o.default = defaultGroup;
		o.textvalue = function (section_id) {
			var mode = uci.get('mosdns', section_id, 'mode');
			var bt = uci.get('mosdns', section_id, 'builtin_type');
			if (mode !== 'custom' && !(mode === 'builtin' && (bt === 'cn_domain' || bt === 'noncn_domain' || bt === 'apple_domain')))
				return '-';

			var v = uci.get('mosdns', section_id, 'dns_group');
			if (!v)
				return _('Default DNS Group');

			var m = /^@dns_group\[(\d+)\]$/.exec(v || '');
			if (m) {
				var idx = +m[1];
				return (groups[idx] && (groups[idx].name || groups[idx]['.name'])) || _('Default DNS Group');
			}
			return groupNameMap[v] || _('Default DNS Group');
		};
		o.depends('mode', 'custom');
		o.depends({ mode: 'builtin', builtin_type: 'cn_domain' });
		o.depends({ mode: 'builtin', builtin_type: 'noncn_domain' });
		o.depends({ mode: 'builtin', builtin_type: 'apple_domain' });
		o.sortable = false;

		o = s.option(form.ListValue, 'ip_strategy', _('IP Resolve Strategy'));
		o.value('auto', _('Auto'));
		o.value('ipv4', _('IPv4 Only'));
		o.value('ipv6', _('IPv6 Only'));
		o.value('ipv4_first', _('IPv4 First'));
		o.value('ipv6_first', _('IPv6 First'));
		o.default = 'auto';
		o.modalonly = true;
		o.depends('mode', 'custom');
		o.depends({ mode: 'builtin', builtin_type: 'cn_domain' });
		o.depends({ mode: 'builtin', builtin_type: 'noncn_domain' });
		o.depends({ mode: 'builtin', builtin_type: 'apple_domain' });
		o.sortable = false;

		o = s.option(form.Value, 'ttl', _('TTL Override'));
		o.datatype = 'and(uinteger,min(0),max(604800))';
		o.default = '0';
		o.modalonly = true;
		o.depends('mode', 'custom');
		o.sortable = false;

		o = s.option(form.TextValue, '_rule_content', _('Rule Content'));
		o.rows = 16;
		o.modalonly = true;
		o.sortable = false;
		o.depends('mode', 'blacklist');
		o.depends('mode', 'ip_map');
		o.depends('mode', 'hosts');
		o.depends('mode', 'redirect');
		o.depends('mode', 'custom');
		o.cfgvalue = function (section_id) {
			if (!isRuleContentEditable(section_id))
				return '';
			return readRuleFile(ensureRuleFile(section_id));
		};
		o.write = function (section_id, formvalue) {
			if (!isRuleContentEditable(section_id) || formvalue == null)
				return Promise.resolve();

			var sid = resolveRuleSectionId(section_id);
			var normalized = normalizeRuleContent(formvalue);
			if (uci.get('mosdns', sid, 'mode') === 'hosts')
				normalized = normalizeHostsContent(normalized);

			var ref = nextRuleFileRef(sid);
			uci.set('mosdns', sid, 'rule_file', ref);

			return rulefile_utils.writeRuleFile(ref, normalized)
				.catch(function (e) {
					ui.addNotification(null, E('p', _('Unable to save contents: %s').format(e.message)));
				});
		};

		return m.render();
	}
});
