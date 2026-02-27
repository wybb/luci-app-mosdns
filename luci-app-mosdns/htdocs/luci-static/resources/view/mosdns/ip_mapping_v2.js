'use strict';
'require form';
'require fs';
'require mosdns/rulefile_utils as rulefile_utils';
'require uci';
'require ui';
'require view';

function getMapFile(section_id) {
	var sid = rulefile_utils.resolveSectionId('ip_map', section_id);
	return rulefile_utils.getRuleRef('ip_map', sid, 'ip-map-' + sid + '.txt');
}

function readRuleFile(rule_file) {
	return fs.trimmed(rulefile_utils.resolveRulePath(rule_file)).catch(function () { return ''; });
}

function deleteMapFileIfUnusedByPath(p) {
	if (!p)
		return Promise.resolve();

	var inUse = uci.sections('mosdns', 'ip_map').some(function (sec) {
		return rulefile_utils.resolveRulePath(getMapFile(sec['.name'])) === p;
	});

	if (inUse)
		return Promise.resolve();

	return fs.remove(p).catch(function () { return null; });
}

function normalizeName(v) {
	return String(v || '').trim().toLowerCase();
}

function mapFileRefByName(section_id) {
	var sid = rulefile_utils.resolveSectionId('ip_map', section_id);
	var name = uci.get('mosdns', sid, 'name') || sid;
	return rulefile_utils.buildVersionedRuleRef('rule-ip-map', name);
}

function flushAndRestartMosdns() {
	return fs.exec('/usr/share/mosdns/mosdns.sh', ['flush'])
		.catch(function () { return null; })
		.then(function () {
			return fs.exec('/etc/init.d/mosdns', ['restart']);
		});
}

function isModalVisible(modal) {
	if (!modal)
		return false;

	var st = window.getComputedStyle(modal);
	if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0')
		return false;

	var rect = modal.getBoundingClientRect();
	if (!rect.width || !rect.height)
		return false;

	var dlg = modal.querySelector('.modal, .cbi-modal');
	if (!dlg)
		return false;

	var ds = window.getComputedStyle(dlg);
	return ds.display !== 'none' && ds.visibility !== 'hidden' && ds.opacity !== '0';
}

function ensureNoOpenModal() {
	var modal = document.getElementById('modal_overlay');
	if (!isModalVisible(modal))
		return Promise.resolve();

	var btn = modal.querySelector('button.cbi-button-save, button.cbi-button-apply, button.cbi-button-positive');
	if (btn)
		btn.click();

	return new Promise(function (resolve) {
		window.setTimeout(resolve, 500);
	}).then(function () {
		var m = document.getElementById('modal_overlay');
		if (!isModalVisible(m))
			return;

		ui.addNotification(null, E('p', _('Please save or close the edit dialog first.')));
		return Promise.reject(new Error('modal still open'));
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
		return ensureNoOpenModal().then(L.bind(function () {
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
		var m, s, o;

		m = new form.Map('mosdns', _('IP Mapping'),
			_('Map response IPs by CIDR/IP lists. Rules are executed from top to bottom.') + ' ' +
			_('When multiple rules match, later rules continue to run.') + ' ' +
			_('Cloudflare legacy list is auto-migrated into IP mapping rules on service start.'));
		this.map = m;

		s = m.section(form.GridSection, 'ip_map', _('IP Mapping List'));
		s.anonymous = true;
		s.addremove = true;
		s.sortable = true;
		s.nodescriptions = true;
		s.modaltitle = _('IP Mapping Rule');
		s.addbtntitle = _('Add IP Mapping Rule');
		s.handleAdd = function (ev, name) {
			return form.GridSection.prototype.handleAdd.apply(this, [ ev, name ]).then(function (rv) {
				return new Promise(function (resolve) {
					window.setTimeout(resolve, 120);
				}).then(function () {
					var btn = document.querySelector('#modal_overlay .cbi-button-add');
					if (btn)
						btn.click();
					return rv;
				});
			});
		};
		s.handleRemove = function (section_id, ev) {
			var sid = rulefile_utils.resolveSectionId('ip_map', section_id);
			var p = rulefile_utils.resolveRulePath(getMapFile(sid));

			return form.GridSection.prototype.handleRemove.apply(this, [ sid, ev ])
				.then(function () {
					return deleteMapFileIfUnusedByPath(p);
				});
		};

		o = s.option(form.Flag, 'enabled', _('Enabled'));
		o.rmempty = false;
		o.default = '1';
		o.sortable = false;

		o = s.option(form.Value, 'name', _('Rule Name'));
		o.rmempty = false;
		o.placeholder = _('IP Mapping');
		o.validate = function (section_id, value) {
			var sid = rulefile_utils.resolveSectionId('ip_map', section_id);
			var n = normalizeName(value);
			if (!n)
				return _('Expecting: non-empty value');

			var dup = uci.sections('mosdns', 'ip_map').some(function (sec) {
				if (sec['.name'] === sid)
					return false;
				return normalizeName(sec.name) === n;
			});

			return dup ? _('A rule with this name already exists.') : true;
		};
		o.sortable = false;

		o = s.option(form.DynamicList, 'ip_map_target', _('Mapped IP'));
		o.datatype = 'ipaddr';
		o.rmempty = true;
		o.modalonly = true;
		o.sortable = false;
		o.textvalue = function (section_id) {
			var sid = rulefile_utils.resolveSectionId('ip_map', section_id);
			var v = uci.get('mosdns', sid, 'ip_map_target');
			if (Array.isArray(v) && v.length)
				return v.join(', ');
			if (typeof v === 'string' && v.length)
				return v;
			return '-';
		};

		o = s.option(form.ListValue, 'continue_match', _('Continue Matching'));
		o.value('1', _('Continue'));
		o.value('0', _('Stop after match'));
		o.default = '1';
		o.rmempty = false;
		o.modalonly = true;
		o.sortable = false;

		o = s.option(form.TextValue, '_map_content', _('IP/CIDR List'));
		o.rows = 16;
		o.modalonly = true;
		o.sortable = false;
		o.cfgvalue = function (section_id) {
			return readRuleFile(getMapFile(section_id));
		};
		o.write = function (section_id, formvalue) {
			if (formvalue == null)
				return Promise.resolve();

			var sid = rulefile_utils.resolveSectionId('ip_map', section_id);
			var ref = mapFileRefByName(sid);
			uci.set('mosdns', sid, 'rule_file', ref);

			return rulefile_utils.writeRuleFile(ref, formvalue)
				.catch(function (e) {
					ui.addNotification(null, E('p', _('Unable to save contents: %s').format(e.message)));
				});
		};

		return m.render();
	}
});
