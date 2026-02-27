'use strict';
'require fs';
'require uci';
'require baseclass';

function normalizeContent(raw) {
	return String(raw || '').trim().replace(/\r\n/g, '\n');
}

function slugifyName(name) {
	var s = String(name || '').toLowerCase().trim();
	s = s.replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
	return s || 'item';
}

function resolveSectionId(sectionType, section_id) {
	if (typeof section_id !== 'string')
		return section_id;

	var m = new RegExp('^@' + sectionType + '\\[(\\d+)\\]$').exec(section_id);
	if (m) {
		var idx = +m[1];
		var secs = uci.sections('mosdns', sectionType);
		if (secs[idx] && secs[idx]['.name'])
			return secs[idx]['.name'];
	}

	if (section_id.indexOf('cbid.mosdns.') === 0) {
		var parts = section_id.split('.');
		if (parts.length >= 3)
			return resolveSectionId(sectionType, parts[2]);
	}

	return section_id;
}

function normalizeRuleRef(ref) {
	if (!ref)
		return '';

	if (ref.indexOf('/etc/mosdns/rule/') === 0)
		return ref.substring('/etc/mosdns/rule/'.length);

	return ref;
}

function normalizeRuleRefForSection(sectionType, sid, ref) {
	var r = normalizeRuleRef(ref);
	if (!r || !sid)
		return r;

	var m = new RegExp('@' + sectionType + '\\[\\d+\\]', 'g');
	return r.replace(m, sid);
}

function resolveRulePath(ref) {
	if (!ref)
		return '';

	if (ref.charAt(0) === '/')
		return ref;

	return '/etc/mosdns/rule/' + ref;
}

function parentDir(path) {
	if (!path)
		return '';

	var i = path.lastIndexOf('/');
	if (i <= 0)
		return '';

	return path.substring(0, i);
}

function uniqueSuffix() {
	return String(Date.now()) + '-' + Math.floor(Math.random() * 0x1000000).toString(16);
}

function buildVersionedRuleRef(prefix, name) {
	var safePrefix = slugifyName(prefix || 'rule');
	var safeName = slugifyName(name || 'item');
	return safePrefix + '-' + safeName + '-' + uniqueSuffix() + '.txt';
}

function ensureRuleRef(sectionType, section_id, defaultRef) {
	var sid = resolveSectionId(sectionType, section_id);
	var ref = uci.get('mosdns', sid, 'rule_file');

	if (!ref && defaultRef) {
		ref = defaultRef;
		uci.set('mosdns', sid, 'rule_file', ref);
	}

	var nref = normalizeRuleRefForSection(sectionType, sid, ref);
	if (nref && ref !== nref)
		uci.set('mosdns', sid, 'rule_file', nref);

	return nref;
}

function getRuleRef(sectionType, section_id, defaultRef) {
	var sid = resolveSectionId(sectionType, section_id);
	var ref = uci.get('mosdns', sid, 'rule_file') || defaultRef || '';
	return normalizeRuleRefForSection(sectionType, sid, ref);
}

function draftPath(prefix, ruleRef) {
	var key = resolveRulePath(normalizeRuleRef(ruleRef)).replace(/[^A-Za-z0-9_.-]/g, '_');
	return '/tmp/mosdns-draft-' + prefix + '-' + key + '.txt';
}

function readDraftOrFile(prefix, ruleRef) {
	var ref = normalizeRuleRef(ruleRef);
	if (!ref)
		return Promise.resolve('');

	var draft = draftPath(prefix, ref);
	var file = resolveRulePath(ref);

	return fs.trimmed(draft).then(function (v) {
		return String(v || '');
	}).catch(function () {
		return fs.trimmed(file).catch(function () { return ''; });
	});
}

function writeDraft(prefix, ruleRef, content) {
	var ref = normalizeRuleRef(ruleRef);
	if (!ref)
		return Promise.resolve();

	return fs.write(draftPath(prefix, ref), normalizeContent(content) + '\n');
}

function clearDraft(prefix, ruleRef) {
	var ref = normalizeRuleRef(ruleRef);
	if (!ref)
		return Promise.resolve();

	return fs.remove(draftPath(prefix, ref)).catch(function () { return null; });
}

function applyDraft(prefix, ruleRef, clearAfterApply) {
	var ref = normalizeRuleRef(ruleRef);
	if (!ref)
		return Promise.resolve();

	var draft = draftPath(prefix, ref);
	var file = resolveRulePath(ref);
	var dir = parentDir(file);

	return fs.trimmed(draft).then(function (content) {
		return fs.exec('/bin/mkdir', [ '-p', dir ]).catch(function () { return null; }).then(function () {
			return fs.write(file, normalizeContent(content) + '\n');
		}).then(function () {
			if (!clearAfterApply)
				return null;
			return clearDraft(prefix, ref);
		});
	}).catch(function () {
		return null;
	});
}

function writeRuleFile(ruleRef, content) {
	var ref = normalizeRuleRef(ruleRef);
	if (!ref)
		return Promise.resolve();

	var file = resolveRulePath(ref);
	var dir = parentDir(file);

	return fs.exec('/bin/mkdir', [ '-p', dir ]).catch(function () { return null; }).then(function () {
		return fs.write(file, normalizeContent(content) + '\n');
	});
}

return baseclass.extend({
	normalizeContent: normalizeContent,
	slugifyName: slugifyName,
	resolveSectionId: resolveSectionId,
	normalizeRuleRef: normalizeRuleRef,
	normalizeRuleRefForSection: normalizeRuleRefForSection,
	resolveRulePath: resolveRulePath,
	parentDir: parentDir,
	buildVersionedRuleRef: buildVersionedRuleRef,
	ensureRuleRef: ensureRuleRef,
	getRuleRef: getRuleRef,
	draftPath: draftPath,
	readDraftOrFile: readDraftOrFile,
	writeDraft: writeDraft,
	clearDraft: clearDraft,
	applyDraft: applyDraft,
	writeRuleFile: writeRuleFile
});
