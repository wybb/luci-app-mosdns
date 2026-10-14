const fs=require('fs'), vm=require('vm'), assert=require('assert');
const root=require('path').join(__dirname, '../luci-app-mosdns/htdocs/luci-static/resources/');
let written=[], rpcResult, calls=[];
let groupRows=[{'.name':'dns_main','.type':'dns_group','.anonymous':false,name:'Main'}];
const uci={sections:()=>groupRows,get:(c,s,k)=>k==='rule_file'?'old.txt':(groupRows.find(g=>g['.name']===s)||{})[k]||null,set:(...args)=>written.push(args)};
function Option(){this.depends=()=>{};this.value=()=>{};}
Option.prototype.load=()=>Promise.resolve();
const form={TextValue:Option,ListValue:Option,DummyValue:Option};
const rpc={declare:spec=>(...args)=>{calls.push([spec.method,args]);return Promise.resolve(rpcResult)}};
const helper=vm.runInNewContext('(function(){'+fs.readFileSync(root+'mosdns/v2.js','utf8')+'})()', {baseclass:{extend:x=>x},form,rpc,uci,poll:{},E:(tag,attrs,text)=>({tag,attrs,text}),_:s=>s});
const section={option:()=>new Option()};
(async()=>{
 const groupOption=new Option();groupOption.value=(k,v)=>{groupOption.keylist.push(k);groupOption.vallist.push(v);};helper.groups(groupOption);await groupOption.load('r1');await groupOption.load('r2');assert.deepEqual(groupOption.keylist,['dns_main']);assert.deepEqual(groupOption.vallist,['Main']);groupOption.cfgvalue=()=> 'dns_main';assert.equal(groupOption.textvalue('r1').text,'Main');
 groupRows.push({'.name':'dns_spare','.type':'dns_group','.anonymous':false,name:'Main'},{'.name':'dns_other','.type':'dns_group','.anonymous':false,name:'Other'});
 await groupOption.load('r1');assert.deepEqual(groupOption.keylist,['dns_main','dns_spare','dns_other']);assert.deepEqual(groupOption.vallist,['Main (dns_main)','Main (dns_spare)','Other']);assert.equal(groupOption.textvalue('r1').text,'Main (dns_main)');
 groupRows[0].name='Renamed';await groupOption.load('r1');assert.deepEqual(groupOption.vallist,['Renamed','Main','Other']);assert.equal(groupOption.textvalue('r1').text,'Renamed');assert.equal(groupOption.validate('r1','dns_main'),true);
 groupOption.cfgvalue=()=>null;assert.equal(groupOption.textvalue('r1'),null);groupOption.cfgvalue=()=> 'missing_group';assert.equal(groupOption.textvalue('r1').text,'missing_group');groupOption.cfgvalue=()=> 'dns_main';
 groupRows.splice(1,1);await groupOption.load('r1');assert.deepEqual(groupOption.keylist,['dns_main','dns_other']);assert.notEqual(groupOption.validate('r1','dns_spare'),true);
 groupRows.push({'.name':'dns_unnamed','.type':'dns_group','.anonymous':false});await groupOption.load('r1');assert.deepEqual(groupOption.vallist,['Renamed','Other','dns_unnamed']);
 groupRows[1].name='dns_unnamed';await groupOption.load('r1');assert.deepEqual(groupOption.vallist,['Renamed','dns_unnamed (dns_other)','dns_unnamed']);
 groupRows[1].name='__proto__';groupRows[0].name='__proto__';await groupOption.load('r1');assert.deepEqual(groupOption.vallist,['__proto__ (dns_main)','__proto__ (dns_other)','dns_unnamed']);
 const idOption=new Option();idOption.value=(k,v)=>{idOption.keylist.push(k);idOption.vallist.push(v);};helper.groups(idOption,true);assert.deepEqual(idOption.vallist,['dns_main','dns_other','dns_unnamed']);
 console.log('PASS: name-only group labels, duplicate-name and unnamed-ID disambiguation, rename/delete refresh, stable choice keys, explicit ID labels.');
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
const v2Mock={render:m=>m,strategy:o=>o,groups:(o,idsOnly)=>{o.idsOnly=idsOnly;return o;},content:(s,key)=>s.option('TextValue',key)};
function loadView(name){return vm.runInNewContext('(function(){'+fs.readFileSync(root+'view/mosdns/'+name+'.js','utf8')+'})()', {view:{extend:x=>x},form:schemaForm,uci,rpc,fs:{},ui:{},v2:v2Mock,L:{hasSystemFeature:()=>true},_:s=>s});}
const basic=loadView('basic_v2').render([null,{}]);
const options=basic.sections[0].options;
assert.equal(options.find(o=>o.option==='stats_collector').default,'0');
for(const field of ['minimal_ttl','maximum_ttl','enable_ecs_remote','remote_ecs_ip','reject_type65','dns_leak']) assert.equal(options.find(o=>o.option===field).type,'DummyValue');
const groups=loadView('dns_groups_v2').render();const groupSection=groups.sections[1];assert.equal(groupSection.anonymous,false);assert.equal(groupSection.addremove,true);
assert.equal(groupSection.sectiontitle('dns_main'),'Main');assert.equal(groupSection.sectiontitle('dns_missing'),'Unnamed group');
assert.equal(groupSection.options.find(o=>o.option==='name').modalonly,true);
assert.equal(groupSection.options.find(o=>o.option==='name').rmempty,false);
assert(!groupSection.options.some(o=>o.option==='.name'||o.option==='_id'));
assert(!Object.hasOwn(groupSection,'handleAdd'));assert(!Object.hasOwn(groupSection,'renderSectionAdd'));assert(!Object.hasOwn(groupSection,'cfgsections'));
const originalId=groupRows[0]['.name'];groupRows[0].name='Renamed group';assert.equal(groupSection.sectiontitle(originalId),'Renamed group');assert.equal(groupRows[0]['.name'],originalId);assert.equal(groupRows[0]['.anonymous'],false);groupRows[0].name='Main';
const groupColumns=[groupSection.sectiontitle(originalId),...groupSection.options.filter(o=>!o.modalonly).map(o=>o.option)];
assert.deepEqual(groupColumns,['Main','use_default_dns','dns']);assert(!groupColumns.includes(originalId));
assert.equal(groups.sections[0].options.find(o=>o.option==='_default_group').idsOnly,undefined);
const rules=loadView('rules_v2').render();assert.equal(rules.sections[1].sortable,true);
assert(rules.sections[1].options.find(o=>o.option==='builtin_type').choices.some(x=>x[0]==='stream_media'));
const mappings=loadView('ip_mapping_v2').render();assert.equal(mappings.sections[0].sortable,true);
assert.deepEqual(mappings.sections[0].options.find(o=>o.option==='continue_match').choices.map(x=>x[0]),['1','0']);
for(const name of ['basic_v2','dns_groups_v2','rules_v2','ip_mapping_v2']) {
 const text=fs.readFileSync(root+'view/mosdns/'+name+'.js','utf8');
 assert(!/handleSaveApply\s*[:(]|setTimeout|\.querySelector|fs\.exec/.test(text));
}
const css=fs.readFileSync(root+'mosdns/v2.css','utf8');
assert(!/nth-child|(?:background|color)\s*:/.test(css));
assert.equal((css.match(/!important/g)||[]).length,2);
assert(/width:\s*100% !important;\s*min-width:\s*0 !important/.test(css));
assert(/\.tr\[data-title\]::before,\s*\.mosdns-v2 \.cbi-section-table \.tr\.cbi-section-table-titles\.named::before\s*\{\s*content:\s*none/.test(css));
assert(/\.td\.cbi-value-field\s*\{\s*width:\s*auto/.test(css));
assert(/\.td\[data-name="dns"\]\s*\{\s*min-width:\s*16rem/.test(css));
assert(!/min-width:\s*42rem/.test(css));
assert(/\.tr\.cbi-section-table-row\s*\{\s*display:\s*block/.test(css));
assert(/\.tr\.cbi-section-table-row > \.td\s*\{[^}]*min-width:\s*0/.test(css));
assert(/\.td\[data-title\]::before\s*\{\s*content:\s*attr\(data-title\)/.test(css));
assert(/\.tr\.cbi-section-table-row > \.td\s*\{[^}]*margin:\s*0/.test(css));
assert(/#cbi-mosdns \.cbi-value:not\(\.hidden\)\s*\{\s*display:\s*block/.test(css));
assert.equal(groupSection.addbtntitle,'Add DNS group');
for(const match of css.matchAll(/([^{}]+)\{/g)) {
 const selector=match[1].trim();if(selector.startsWith('@media'))continue;
 assert(selector==='.mosdns-v2'||selector.startsWith('.mosdns-v2 ')||selector.startsWith('#modal_overlay .cbi-modal #cbi-mosdns '),selector+' is not scoped to MosDNS');
}
assert(/\.mosdns-v2 \.cbi-tblsection\s*\{[^}]*overflow-x:\s*auto/.test(css));
assert(/\.mosdns-v2 \.cbi-section-create\s*\{[^}]*flex-wrap:\s*wrap/.test(css));
assert(!/\.querySelector|renderSectionAdd|getPreviousModalMap|renderMoreOptionsModal/.test(fs.readFileSync(root+'mosdns/v2.js','utf8')));
console.log('PASS: public form schema; name-only table without duplicate/ID columns; native named-group creation; stable IDs; ordered rules/mappings; scoped theme-neutral CSS and mobile overflow; no private save/DOM hooks.');

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
