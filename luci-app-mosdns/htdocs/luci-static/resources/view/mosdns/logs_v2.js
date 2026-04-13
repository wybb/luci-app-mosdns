'use strict';
'require dom';
'require poll';
'require rpc';
'require ui';
'require view';

var scrollPosition = 0;
var userScrolled = false;
var logTextarea;

var callPrintLog = rpc.declare({
	object: 'luci.mosdns',
	method: 'print_log',
	expect: { '': {} }
});

var callCleanLog = rpc.declare({
	object: 'luci.mosdns',
	method: 'clean_log',
	expect: { '': {} }
});

function pollLog() {
	return Promise.all([
		callPrintLog().then(function (res) {
			return String((res && res.log) || '').trim().split(/\n/).join('\n');
		}),
	]).then(function (data) {
		logTextarea.value = data[0] || _('No log data.');

		if (!userScrolled) {
			logTextarea.scrollTop = logTextarea.scrollHeight;
		} else {
			logTextarea.scrollTop = scrollPosition;
		}
	});
};

return view.extend({
	handleCleanLogs: function () {
		return callCleanLog().then(function (res) {
			if (!res || !res.success)
				ui.addNotification(null, E('p', _('Failed to clean logs.')), 'error');
		}).catch(function () {
			ui.addNotification(null, E('p', _('Failed to clean logs.')), 'error');
		});
	},

	render: function () {
		logTextarea = E('textarea', {
			'class': 'cbi-input-textarea',
			'wrap': 'off',
			'readonly': 'readonly',
			'style': 'width: calc(100% - 20px);height: 535px;margin: 10px;overflow-y: scroll;',
		});

		logTextarea.addEventListener('scroll', function () {
			userScrolled = true;
			scrollPosition = logTextarea.scrollTop;
		});

		var log_textarea_wrapper = E('div', { 'id': 'log_textarea' }, logTextarea);

		poll.add(pollLog);

		var clear_logs_button = E('input', { 'class': 'btn cbi-button-action', 'type': 'button', 'style': 'margin-left: 10px; margin-top: 10px;', 'value': _('Clear logs') });
		clear_logs_button.addEventListener('click', this.handleCleanLogs.bind(this));

		return E([
			E('div', { 'class': 'cbi-map' }, [
				E('h2', { 'name': 'content' }, '%s - %s'.format(_('MosDNS'), _('Log Data'))),
				E('div', { 'class': 'cbi-section' }, [
					clear_logs_button,
					log_textarea_wrapper,
					E('div', { 'style': 'text-align:right' },
						E('small', {}, _('Refresh every %s seconds.').format(L.env.pollinterval))
					)
				])
			])
		]);
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
