'use strict';
'require baseclass';
'require form';
'require rpc';
'require poll';
'require uci';

const readFile = rpc.declare({object: 'luci.mosdns', method: 'read_rule_file', params: ['name'], expect: {'': {}}});
const writeFile = rpc.declare({object: 'luci.mosdns', method: 'write_rule_file', params: ['section', 'content'], expect: {'': {}}});

const applyStatus = rpc.declare({object:'luci.mosdns', method:'get_apply_status', expect:{'':{}}});
const serviceStatus = rpc.declare({object:'service', method:'list', params:['name'], expect:{'':{}}});

return baseclass.extend({
	render: function(map) {
		const status = E('p', {'role':'status', 'aria-live':'polite'}, _('Checking service status…'));
		const update = function() {
			return Promise.all([applyStatus(), serviceStatus('mosdns')]).then(function(result) {
				const instances = ((result[1].mosdns || {}).instances || {});
				const running = Object.keys(instances).some(function(key) { return instances[key].running; });
				const state = result[0];
				status.textContent = (running ? _('MosDNS is running.') : _('MosDNS is stopped.')) + ' ' +
					(state.phase === 'unknown' ? _('No apply result recorded.') :
					 state.success === false ? _('Last apply failed: ') + (state.error || _('Unknown error')) :
					 state.phase === 'validating' ? _('Applying configuration…') :
					 state.success === true ? _('Last apply succeeded.') : _('No apply result recorded.'));
				status.className = state.success === false && state.phase !== 'unknown' ? 'alert-message error' : '';
			}).catch(function(error) { status.textContent = _('Unable to check apply status: ') + error.message; status.className = 'alert-message warning'; });
		};
		return map.render().then(function(node) { poll.add(update); update(); return E('div', {'class':'mosdns-v2'}, [E('link', {rel:'stylesheet', href:L.resource('mosdns/v2.css')}), status, node]); });
	},
	strategy: function(option) {
		[['auto', _('Auto')], ['ipv4', _('IPv4 only')], ['ipv6', _('IPv6 only')],
		 ['ipv4_first', _('IPv4 first')], ['ipv6_first', _('IPv6 first')]].forEach(function(v) { option.value(v[0], v[1]); });
		option.default = 'auto';
		option.rmempty = false;
		return option;
	},
	groups: function(option, idsOnly) {
		function choices() {
			// Rebuild LuCI's choice model at load time, including deleted IDs.
			// No widget nodes or private event handlers are touched.
			option.keylist = [];
			option.vallist = [];
			uci.sections('mosdns', 'dns_group').forEach(function(g) {
				const id = g['.name'];
				option.value(id, !idsOnly && g.name ? g.name + ' (' + id + ')' : id);
			});
		}
		choices();
		option.load = function(sid) { choices(); return form.ListValue.prototype.load.call(this, sid); };
		option.validate = function(sid, value) {
			return uci.get('mosdns', value, '.type') === 'dns_group' ? true : _('Select an existing DNS group.');
		};
		option.rmempty = false;
		return option;
	},
	content: function(section, key, title, description) {
		const values = {}, errors = {};
		const warning = section.option(form.DummyValue, key + '_read_error', _('Rule file status'));
		warning.modalonly = true;
		warning.cfgvalue = function(sid) { return errors[sid] || ''; };
		warning.write = function() {};
		warning.remove = function() {};
		const option = section.option(form.TextValue, key, title, description);
		option.rows = 16;
		option.modalonly = true;
		option.rmempty = true;
		option.retain = true;
		option.load = function(sid) {
			if (uci.get('mosdns', sid, 'mode') === 'builtin') return Promise.resolve(values[sid] = '');
			const ref = uci.get('mosdns', sid, 'rule_file');
			if (!ref) return Promise.resolve(values[sid] = '');
			return readFile(ref).then(function(res) {
				if (res.success === false || typeof res.content !== 'string')
					throw new Error(res.error || _('Could not read rule file.'));
				delete errors[sid];
				return values[sid] = res.content;
			}).catch(function(error) {
				errors[sid] = _('The original file could not be read and its reference is preserved: ') + ref + '. ' + error.message + ' ' + _('Disable or delete this rule, or enter replacement content to save a new managed file. Leaving this editor empty will not overwrite the original reference.');
				return values[sid] = '';
			});
		};
		option.cfgvalue = function(sid) { return values[sid] || ''; };
		option.write = function(sid, value) {
			const content = String(value || '').replace(/\r\n?/g, '\n');
			if (errors[sid] && content === '') return Promise.resolve();
			// A failed write rejects the form save. Never persist a pointer to an unwritten file.
			return writeFile(sid, content).then(function(res) {
				if (!res.success || !res.rule_file)
					throw new Error(res.error || _('Could not save rule file.'));
				uci.set('mosdns', sid, 'rule_file', res.rule_file);
				values[sid] = content;
				delete errors[sid];
			});
		};
		option.remove = function(sid) { return option.write(sid, ''); };
		return option;
	}
});
