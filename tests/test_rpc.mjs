// Exercise actual RPC implementations with fault-injected fs, without a router.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const root = new URL('../', import.meta.url);
const read = p => fs.readFileSync(new URL(p, root), 'utf8');
const source = read('luci-app-mosdns/root/usr/share/rpcd/ucode/luci.mosdns');
function fixture(mode = '') {
 const files = new Map(); const commands = []; let writes = 0, renames = 0;
 const context = {
  type: v => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v,
  length: v => v.length, index: (v, x) => v.indexOf(x), substr: (v, ...a) => v.substr(...a),
  match: (v, re) => v.match(re), replace: (v, a, b) => v.replace(a, b), split: (v, x) => v.split(x),
  json: JSON.parse, String,
  stat: p => files.has(p) ? {type:'file',size:files.get(p).length} : null,
  realpath: p => p.includes('..') || p.includes('symlink') ? '/etc/shadow' : p,
  readfile: p => files.get(p) ?? null,
  writefile: (p,c) => { writes++; if (mode === 'write') return null; files.set(p,mode === 'corrupt' ? c+'bad':c); return c.length; },
  rename: (a,b) => { renames++; if (mode === 'rename') return false; files.set(b,files.get(a));files.delete(a);return true; },
  unlink: p => files.delete(p), rmdir: () => true, chmod: () => true,
  popen: command => { commands.push(command); return {read:()=>mode === 'exec_failure' ? 'service failed' : command.includes('.yaml-backup-') ? '/etc/mosdns/.yaml-backup-Ab1234' : '/etc/mosdns/rule/.write-Ab1234',close:()=>mode === 'exec_failure' ? 1 : 0}; },
  cursor: () => {throw Error('RPC must not commit a UCI pointer');},
 };
 let js = source.replace(/\b0600\b/g, '384').replace(/^#![^\n]*\n/,'').replace(/^import .*;$/mg,'').replace('return { "luci.mosdns": methods };','globalThis.methods = methods;');
 vm.createContext(context);vm.runInContext(js,context);
 return {call:(name,args)=>context.methods[name].call({args}),files,commands,get writes(){return writes},get renames(){return renames}};
}
for (const mode of ['', 'exec_failure']) {
 const f=fixture(mode), result=f.call('flush_cache',{});
 assert.equal(result.success,mode === '');
 assert.equal(f.commands[0],'/etc/init.d/mosdns flush_cache 2>&1');
 if(mode) assert.equal(result.error,'service failed');
}
assert.ok(!source.includes('/plugins/lazy_cache/flush'));
for (const mode of ['write','corrupt','rename']) {
 const f=fixture(mode), result=f.call('write_rule_file',{section:'cfg001',content:'example.com\n'});
 assert.equal(result.success,false,mode);assert.equal([...f.files].length,0,mode);
 if(mode !== 'rename') assert.equal(f.renames,0);
}
for (const content of ['', 'example.com\n']) {
 const f=fixture(), result=f.call('write_rule_file',{section:'cfg001',content});
 assert.equal(result.success,true);assert.equal(f.files.get(result.rule_file),content);
 assert.equal(f.call('read_rule_file',{name:result.rule_file}).content,content);
}
for (const mode of ['write','corrupt','rename','']) {
 const f=fixture(mode), target='/etc/mosdns/config_custom.yaml';
 f.files.set(target,'original');
 const result=f.call('write_custom_config',{content:'candidate'});
 assert.equal(result.success,mode === '');
 assert.equal(f.files.get(target),mode === '' ? 'candidate' : 'original');
 if(mode === '') assert.equal(f.files.get(result.backup),'original');
}
for (const section of ['../escape','x;touch /tmp/pwn','', 'x'.repeat(65)]) {
 const f=fixture();assert.equal(f.call('write_rule_file',{section,content:'a'}).success,false);assert.equal(f.writes,0);
}
for (const content of ['a\0b','a'.repeat(1048577),42]) {
 const f=fixture();assert.equal(f.call('write_rule_file',{section:'safe',content}).success,false);assert.equal(f.writes,0);
}
for (const name of ['/etc/shadow','../../shadow','symlink']) assert.equal(fixture().call('read_rule_file',{name}).success,false);
const acl=JSON.parse(read('luci-app-mosdns/root/usr/share/rpcd/acl.d/luci-app-mosdns.json'))['luci-app-mosdns'];
assert.ok(Object.values(acl.read.file).every(permissions => !permissions.includes('exec')));
for(const method of ['write_rule_file','restore_rule_defaults','start_update','clean_log','flush_cache']) {
 assert.ok(!acl.read.ubus['luci.mosdns'].includes(method));assert.ok(acl.write.ubus['luci.mosdns'].includes(method));
}
const maintenance=read('luci-app-mosdns/root/usr/share/mosdns/mosdns.uc');
assert.ok(!maintenance.includes('--no-check-certificate'));
assert.ok(!maintenance.includes('/etc/init.d/mosdns restart'));
assert.ok(!/rm -[^\n]*\/var\/mosdns\/geo/.test(maintenance));
assert.ok(!/rm -[^\n]*\/etc\/mosdns\/rule/.test(maintenance));
assert.ok(maintenance.includes('reload_service();'));
const installer=read('install.sh');assert.ok(installer.includes('exit 1'));assert.ok(!installer.includes('curl '));
console.log('RPC fault-injection, allowlist, ACL, update preservation and installer tests passed');
