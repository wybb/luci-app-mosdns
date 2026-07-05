'use strict';
'require form';
'require fs';
'require rpc';
'require ui';
'require view';

var callStartUpdate = rpc.declare({
	object: 'luci.mosdns',
	method: 'start_update',
	expect: { '': {} }
});

var callGetUpdateLog = rpc.declare({
	object: 'luci.mosdns',
	method: 'get_update_log',
	expect: { '': {} }
});

function flushAndRestartMosdns() {
	return fs.exec('/usr/share/mosdns/mosdns.sh', ['flush'])
		.catch(function () { return null; })
		.then(function () {
			return fs.exec('/usr/share/mosdns/mosdns.sh', ['restart_async']);
		});
}
 
return view.extend({
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

	handleUpdate: function (m, section_id, ev) {
		var statusMsg = E('p', { 'class': 'spinning' }, _('Please wait, this may take a few moments...'));
		var logTextarea = E('textarea', {
			'readonly': 'readonly',
			'style': 'width: 100%; height: 300px; font-family: monospace; font-size: 12px; margin-top: 10px;',
			'placeholder': _('Starting update...')
		});
		var closeButton = E('button', {
			'class': 'btn',
			'style': 'display: none;',
			'click': ui.hideModal
		}, _('Close'));

		ui.showModal(_('Updating Database...'), [
			statusMsg,
			logTextarea,
			E('div', { 'class': 'right' }, [ closeButton ])
		]);

		var pollLog = function() {
			return callGetUpdateLog().then(function(res) {
				if (res && res.log) {
					logTextarea.value = res.log;
					logTextarea.scrollTop = logTextarea.scrollHeight;

					if (res.log.match(/UPDATE_FINISHED/)) {
						statusMsg.textContent = _('Update success');
						statusMsg.classList.remove('spinning');
						closeButton.style.display = '';
						return;
					}

					if (res.log.match(/UPDATE_FAILED/)) {
						statusMsg.textContent = _('Update failed, Please check the network status');
						statusMsg.classList.remove('spinning');
						closeButton.style.display = '';
						return;
					}
				}

				return new Promise(function(resolve) {
					window.setTimeout(resolve, 1000);
				}).then(pollLog);
			});
		};

		return callStartUpdate().then(function(res) {
			if (!res || !res.success) {
				statusMsg.textContent = (res && res.error) ? res.error : _('Update failed, Please check the network status');
				statusMsg.classList.remove('spinning');
				closeButton.style.display = '';
				return;
			}

			return pollLog();
		});
	},

		render: function () {
		var m, s, o;

		m = new form.Map('mosdns', _('Update GeoIP & GeoSite databases'),
			_('Automatically update GeoIP and GeoSite databases as well as ad filtering rules through scheduled tasks.'));
		this.map = m;

		s = m.section(form.TypedSection, 'mosdns');
		s.anonymous = true;
		s.addremove = false;
		s.cfgsections = function () {
			return [ 'config' ];
		};

		o = s.option(form.Flag, 'geo_auto_update', _('Enable Auto Database Update'));
		o.rmempty = false;

		o = s.option(form.ListValue, 'geo_update_week_time', _('Update Cycle'));
		o.value('*', _('Every Day'));
		o.value('1', _('Every Monday'));
		o.value('2', _('Every Tuesday'));
		o.value('3', _('Every Wednesday'));
		o.value('4', _('Every Thursday'));
		o.value('5', _('Every Friday'));
		o.value('6', _('Every Saturday'));
		o.value('0', _('Every Sunday'));
		o.default = 3;

		o = s.option(form.ListValue, 'geo_update_day_time', _('Update Time'));
		for (let t = 0; t < 24; t++) {
			o.value(t, t + ':00');
		};
		o.default = 3;

		o = s.option(form.ListValue, 'geoip_type', _('GeoIP Type'),
			_('Little: only include Mainland China and Private IP addresses.') +
			'<br>' +
			_('Full: includes all Countries and Private IP addresses.')
			);
		o.value('geoip', _('Full'));
		o.value('geoip-only-cn-private', _('Little'));
		o.rmempty = false;
		o.default = 'geoip-only-cn-private';

		o = s.option(form.Value, 'github_proxy', _('GitHub Proxy'),
			_('Update data files with GitHub Proxy, leave blank to disable proxy downloads.'));
		o.value('https://gh-proxy.com', _('https://gh-proxy.com'));
		o.rmempty = true;
		o.default = '';

		o = s.option(form.Button, '_udpate', null,
			_('Check And Update GeoData.'));
		o.title = _('Database Update');
		o.inputtitle = _('Check And Update');
		o.inputstyle = 'apply';
		o.onclick = L.bind(this.handleUpdate, this, m);

		return m.render();
	}
});
