const fs=require('fs'), vm=require('vm'), assert=require('assert');
const root=require('path').join(__dirname, '../luci-app-mosdns/htdocs/luci-static/resources/');
let written=[], rpcResult, calls=[];
const uci={sections:()=>[{'.name':'dns_main','.type':'dns_group',name:'Main'}],get:(c,s,k)=>k==='rule_file'?'old.txt':k==='.type'?'dns_group':null,set:(...args)=>written.push(args)};
function Option(){this.depends=()=>{};this.value=()=>{};}
Option.prototype.load=()=>Promise.resolve();
const form={TextValue:Option,ListValue:Option,DummyValue:Option};
const rpc={declare:spec=>(...args)=>{calls.push([spec.method,args]);return Promise.resolve(rpcResult)}};
const helper=vm.runInNewContext('(function(){'+fs.readFileSync(root+'mosdns/v2.js','utf8')+'})()', {baseclass:{extend:x=>x},form,rpc,uci,poll:{},_:s=>s});
const section={option:()=>new Option()};
(async()=>{
 const groupOption=new Option();groupOption.value=(k,v)=>{groupOption.keylist.push(k);groupOption.vallist.push(v);};helper.groups(groupOption);await groupOption.load('r1');await groupOption.load('r2');assert.equal(groupOption.keylist.length,1);
 const o=helper.content(section,'_content','Rules');
 rpcResult={success:true,content:'old'}; await o.load('r1'); assert.equal(o.cfgvalue('r1'),'old');
 rpcResult={success:false,error:'disk full'};await assert.rejects(o.write('r1','new'),/disk full/);assert.equal(written.length,0);assert.equal(o.cfgvalue('r1'),'old');
 rpcResult={success:true,rule_file:'/etc/mosdns/rule/new.txt'};await o.write('r1','new\r\n');assert.deepEqual(written[0],['mosdns','r1','rule_file','/etc/mosdns/rule/new.txt']);assert.equal(o.cfgvalue('r1'),'new\n');assert.equal(calls.at(-1)[1][1],'new\n');
 await o.remove('r1');assert.equal(calls.at(-1)[1][1],'');assert.equal(o.retain,true);
 rpcResult={success:false,error:'permission denied'};await o.load('r1');assert.equal(o.cfgvalue('r1'),'');
 const before=calls.length, pointers=written.length;await o.write('r1','');await o.remove('r1');assert.equal(calls.length,before);assert.equal(written.length,pointers);
 rpcResult={success:true,rule_file:'/etc/mosdns/rule/replacement.txt'};await o.write('r1','replacement');assert.equal(written.at(-1)[3],'/etc/mosdns/rule/replacement.txt');
 console.log('PASS: read errors preserve the original reference and allow recovery; write errors do not change pointer; success awaits RPC; normalization; empty editor writes; hidden editor retained.');
})().catch(e=>{console.error(e);process.exitCode=1});

// Exercise each view's public form schema without claiming browser coverage.
let maps=[];
function MockOption(type,key) { this.type=type; this.option=key; this.choices=[]; this.dependencies=[]; }
MockOption.prototype.value=function(value,label){this.choices.push([value,label]);};
MockOption.prototype.depends=function(...args){this.dependencies.push(args);};
function Section(type,name){this.type=type;this.name=name;this.options=[];}
Section.prototype.option=function(type,key){let o=new MockOption(type,key);this.options.push(o);return o;};
Section.prototype.taboption=function(tab,...args){return this.option(...args);};
Section.prototype.tab=function(){};
function MapMock(){this.sections=[];maps.push(this);}
MapMock.prototype.section=function(type,name){let s=new Section(type,name);this.sections.push(s);return s;};
MapMock.prototype.render=function(){return Promise.resolve(this);};
const schemaForm={Map:MapMock, NamedSection:'NamedSection',GridSection:'GridSection',Value:'Value',ListValue:'ListValue',Flag:'Flag',DummyValue:'DummyValue',Button:'Button',DynamicList:'DynamicList',TextValue:'TextValue'};
const v2Mock={render:m=>m,strategy:o=>o,groups:o=>o,content:(s,key)=>s.option('TextValue',key)};
function loadView(name){return vm.runInNewContext('(function(){'+fs.readFileSync(root+'view/mosdns/'+name+'.js','utf8')+'})()', {view:{extend:x=>x},form:schemaForm,uci,rpc,fs:{},ui:{},v2:v2Mock,L:{hasSystemFeature:()=>true},_:s=>s});}
const basic=loadView('basic_v2').render([null,{}]);
const options=basic.sections[0].options;
assert.equal(options.find(o=>o.option==='stats_collector').default,'0');
for(const field of ['minimal_ttl','maximum_ttl','enable_ecs_remote','remote_ecs_ip','reject_type65','dns_leak']) assert.equal(options.find(o=>o.option===field).type,'DummyValue');
const groups=loadView('dns_groups_v2').render();assert.equal(groups.sections[1].anonymous,false);
const rules=loadView('rules_v2').render();assert.equal(rules.sections[1].sortable,true);
assert(rules.sections[1].options.find(o=>o.option==='builtin_type').choices.some(x=>x[0]==='stream_media'));
const mappings=loadView('ip_mapping_v2').render();assert.equal(mappings.sections[0].sortable,true);
assert.deepEqual(mappings.sections[0].options.find(o=>o.option==='continue_match').choices.map(x=>x[0]),['1','0']);
for(const name of ['basic_v2','dns_groups_v2','rules_v2','ip_mapping_v2']) {
 const text=fs.readFileSync(root+'view/mosdns/'+name+'.js','utf8');
 assert(!/handleSaveApply\s*[:(]|setTimeout|\.querySelector|fs\.exec/.test(text));
}
console.log('PASS: public form construction, read-only legacy controls, opt-in statistics, stable group IDs, ordered rules/mappings, continued/stopped mappings, no private save/DOM hooks.');

// Retained views must call only RPCs actually granted by the package ACL.
const acl=JSON.parse(fs.readFileSync(require('path').join(__dirname,'../luci-app-mosdns/root/usr/share/rpcd/acl.d/luci-app-mosdns.json'),'utf8'))['luci-app-mosdns'];
const allowed=new Set([...(acl.read.ubus['luci.mosdns']||[]),...(acl.write.ubus['luci.mosdns']||[])]);
for(const filename of fs.readdirSync(root+'view/mosdns').filter(name=>name.endsWith('.js'))) {
 const text=fs.readFileSync(root+'view/mosdns/'+filename,'utf8');
 assert(!/fs\.(write|exec)\s*\(/.test(text),filename+' bypasses atomic RPC');
 for(const match of text.matchAll(/object:\s*'luci\.mosdns'\s*,\s*method:\s*'([^']+)'/g)) assert(allowed.has(match[1]),filename+': missing RPC ACL '+match[1]);
}
const statsSource=fs.readFileSync(root+'view/mosdns/statistics.js','utf8');
assert(!/promptAddRule|WHITELIST_FILE|BLOCKLIST_FILE/.test(statsSource));
assert(statsSource.includes('Statistics does not change rule files.'));
assert(statsSource.includes("L.url('admin', 'services', 'mosdns', 'rules')"));
console.log('PASS: all retained view RPCs allowed by ACL; no raw writes/exec; statistics routes rule editing to ordered v2 rules.');
