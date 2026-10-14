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
let maps=[],modal;
function MockOption(type,key,title,description) { this.type=type; this.option=key; this.title=title; this.description=description; this.choices=[]; this.dependencies=[]; }
MockOption.prototype.value=function(value,label){this.choices.push([value,label]);};
MockOption.prototype.depends=function(...args){this.dependencies.push(args);};
function Section(type,name){this.type=type;this.name=name;this.options=[];this.tabs=[];}
Section.prototype.option=function(type,key,title,description){let o=new MockOption(type,key,title,description);this.options.push(o);return o;};
Section.prototype.taboption=function(tab,...args){return this.option(...args);};
Section.prototype.tab=function(name,title){this.tabs.push([name,title]);};
function MapMock(config,title,description){this.config=config;this.title=title;this.description=description;this.sections=[];maps.push(this);}
MapMock.prototype.section=function(type,name){let s=new Section(type,name);this.sections.push(s);return s;};
MapMock.prototype.render=function(){return Promise.resolve(this);};
const schemaForm={Map:MapMock, NamedSection:'NamedSection',GridSection:'GridSection',Value:'Value',ListValue:'ListValue',Flag:'Flag',DummyValue:'DummyValue',Button:'Button',DynamicList:'DynamicList',TextValue:'TextValue'};
const v2Mock={render:m=>m,strategy:o=>o,groups:(o,idsOnly)=>{o.idsOnly=idsOnly;return o;},content:(s,key)=>s.option('TextValue',key)};
function loadView(name){return vm.runInNewContext('(function(){'+fs.readFileSync(root+'view/mosdns/'+name+'.js','utf8')+'})()', {view:{extend:x=>x},form:schemaForm,uci,rpc,fs:{},ui:{showModal:(title,content)=>{modal={title,content};},hideModal:()=>{},createHandlerFn:(context,handler)=>handler.bind(context)},v2:v2Mock,L:{hasSystemFeature:()=>true},E:(tag,attrs,text)=>({tag,attrs,text}),_:s=>s});}
const basic=loadView('basic_v2').render([null,{}]);
const options=basic.sections[0].options;
assert.equal(basic.title,'MosDNS');
assert.equal(loadView('basic_v2').render([null,{version:'v5.3.4'}]).title,'MosDNS · v5.3.4');
assert.equal(basic.description,'MosDNS is a plugin-based DNS forwarder/traffic splitter.');
assert.deepEqual(basic.sections[0].tabs,[['basic','Basic Options'],['advanced','Advanced Options'],['api','API Options'],['geodata','GeoData Export'],['legacy','Legacy options']]);
assert.equal(options.find(o=>o.option==='configfile').title,'Config File');
assert.deepEqual(options.find(o=>o.option==='configfile').choices,[['/var/etc/mosdns.json','Default Config'],['/etc/mosdns/config_custom.yaml','Custom Config']]);
assert.equal(options.find(o=>o.option==='configfile').default,'/var/etc/mosdns.json');
assert.equal(options.find(o=>o.option==='_custom').title,'Configuration Editor');
assert.equal(options.find(o=>o.option==='_custom').description,"This is the content of the file '/etc/mosdns/config_custom.yaml' from which your MosDNS configuration will be generated. Only accepts configuration content in yaml format.");
assert.equal(options.find(o=>o.option==='listen_port_api').description,undefined);
assert.equal(options.find(o=>o.option==='insecure_skip_verify').description,'Disable TLS Servers certificate validation, Can be useful if system CA certificate expires or the system time is out of order');
assert.deepEqual(options.find(o=>o.option==='log_level').choices,[['debug','Debug'],['info','Info'],['warn','Warning'],['error','Error']]);
assert.equal(options.find(o=>o.option==='log_level').default,'info');
for(const [key,title] of [['listen_address','Listen Address'],['log_level','Log Level'],['log_file','Log File'],['log_size','Log File Size'],['redirect','DNS Forward'],['local_dns_redirect','DNS redirect'],['bootstrap_dns','Bootstrap DNS servers'],['concurrent','Concurrent'],['idle_timeout','Idle Timeout'],['enable_pipeline','TCP/DoT Connection Multiplexing'],['insecure_skip_verify','Disable TLS Certificate'],['cache','Enable DNS Cache'],['cache_size','DNS Cache Size'],['lazy_cache_ttl','Lazy Cache TTL'],['prefetch','Cache Prefetching'],['prefetch_before_expire','Prefetch Before Expire'],['prefetch_min_hits','Prefetch Min Hits'],['prefetch_scan_interval','Prefetch Scan Interval'],['dump_file','Cache Dump'],['dump_interval','Auto Save Cache Interval'],['listen_port_api','API Listen port'],['stats_collector','Enable Stats Collector'],['stats_capacity','Ring Buffer Capacity'],['stats_dump_file','Stats Dump'],['stats_dump_interval','Auto Save Stats Interval'],['geosite_tags','GeoSite Tags'],['geoip_tags','GeoIP Tags']]) assert.equal(options.find(o=>o.option===key).title,title);
assert.equal(options.find(o=>o.option==='_flush').inputtitle,'Flush DNS Cache');
assert.equal(options.find(o=>o.option==='listen_port').title,'DNS listen / forwarding port');
assert.equal(options.find(o=>o.option==='listen_port').description,'In custom mode, this forwarding port must match the listener defined in your YAML.');
assert.deepEqual(options.find(o=>o.option==='listen_port').dependencies,[]);
assert.deepEqual(options.find(o=>o.option==='_custom').dependencies,[['configfile','/etc/mosdns/config_custom.yaml']]);
for(const [key,def,datatype] of [['listen_address','0.0.0.0','ipaddr'],['listen_port','5335','port'],['log_size','1M',undefined],['concurrent','2','range(1,3)'],['cache_size','8000','range(1,10000000)'],['dump_interval','3600','range(1,86400)'],['listen_port_api','9091','port']]) {
 const option=options.find(o=>o.option===key);assert.equal(option.default,def);assert.equal(option.datatype,datatype);
}
assert.equal(options.find(o=>o.option==='cache').default,'1');
assert.equal(options.find(o=>o.option==='stats_collector').default,'0');
for(const field of ['minimal_ttl','maximum_ttl','enable_ecs_remote','remote_ecs_ip','reject_type65','dns_leak']) {
 assert.equal(options.find(o=>o.option===field).type,'DummyValue');
 assert.equal(options.find(o=>o.option===field).description,'Retained from older settings; inactive.');
}
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
assert.equal(groups.description,'Manage upstream DNS servers for routing rules.');
assert.equal(groups.sections[0].options.find(o=>o.option==='_default_group').description,'Used when no routing rule returns an answer.');
const rulesView=loadView('rules_v2'),rules=rulesView.render();assert.equal(rules.sections[1].sortable,true);
assert.equal(rules.description,'Rules run from top to bottom. Reorder to change priority. Unmatched requests use the default DNS group.');
assert.equal(rules.sections[0].options.find(o=>o.option==='_restore_rules').inputtitle,'Restore rules, keep groups');
assert.equal(rules.sections[0].options.find(o=>o.option==='_restore_all').inputtitle,'Restore default configuration');
for(const keepGroups of [true,false]) {
 rules.sections[0].options.find(o=>o.option===(keepGroups?'_restore_rules':'_restore_all')).onclick();
 assert.equal(modal.title,'Restore default configuration?');
 assert.equal(modal.content[0].text,keepGroups?'Replace routing rules and IP mappings with defaults, keeping DNS groups. Applies immediately. Save or discard pending edits first.':'Replace DNS groups, routing rules and IP mappings with defaults. Applies immediately. Save or discard pending edits first.');
 assert.equal(modal.content[1].text[0].text,'Cancel');
 assert.equal(modal.content[1].text[2].text,'Restore and reload');
}
console.log('PASS: upstream configuration, tab and option labels; translated log levels; original YAML instruction; core version and forwarding semantics retained; restore confirmation; unchanged defaults and validation.');
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

function decodeGettextString(literal) {
 assert(/^"(?:[^"\\\r\n]|\\(?:[abfnrtv\\"'?]|[0-7]{1,3}|x[0-9a-fA-F]+))*"$/.test(literal),'Invalid gettext string: '+literal);
 const escapes={a:'\x07',b:'\b',f:'\f',n:'\n',r:'\r',t:'\t',v:'\v','\\':'\\','"':'"',"'":"'",'?':'?'};
 return literal.slice(1,-1).replace(/\\(x[0-9a-fA-F]+|[0-7]{1,3}|[abfnrtv\\"'?])/g,(_,escape)=>Object.hasOwn(escapes,escape)?escapes[escape]:String.fromCodePoint(parseInt(escape[0]==='x'?escape.slice(1):escape,escape[0]==='x'?16:8)));
}
function parseGettext(text) {
 const entries=new global.Map();let entry={},field=null;
 function finish() {
  if(Object.hasOwn(entry,'msgid')) {
   assert(Object.hasOwn(entry,'msgstr'),'Missing msgstr: '+entry.msgid);
   assert(!entries.has(entry.msgid),'Duplicate msgid: '+entry.msgid);
   entries.set(entry.msgid,{msgstr:entry.msgstr,fuzzy:entry.fuzzy===true});
  }
  entry={};field=null;
 }
 for(const raw of text.replace(/^\uFEFF/,'').split(/\r?\n/)) {
  const line=raw.trim();
  if(!line){finish();continue;}
  if(line.startsWith('#')) {
   if(Object.hasOwn(entry,'msgstr'))finish();
   if(line.startsWith('#,'))entry.fuzzy=entry.fuzzy===true||line.slice(2).split(',').some(flag=>flag.trim()==='fuzzy');
   continue;
  }
  const directive=/^(msgid|msgstr)\s+(".*")$/.exec(line);
  if(directive) {
   if(directive[1]==='msgid'&&Object.hasOwn(entry,'msgid'))finish();
   field=directive[1];
   assert(!Object.hasOwn(entry,field),'Duplicate gettext field: '+field);
   if(field==='msgstr')assert(Object.hasOwn(entry,'msgid'),'msgstr without msgid');
   entry[field]=decodeGettextString(directive[2]);
  } else {
   assert(line.startsWith('"')&&field,'Unsupported gettext line: '+line);
   entry[field]+=decodeGettextString(line);
  }
 }
 finish();return entries;
}
function translationLiterals(source) {
 const tokens=[];let offset=0,previous='';
 const string=/(['"])(?:\\[\s\S]|(?!\1)[^\\\r\n])*?\1/y;
 const identifier=/[A-Za-z_$][\w$]*/y;
 while(offset<source.length) {
  const char=source[offset],next=source[offset+1];
  if(/\s/.test(char)){offset++;continue;}
  if(char==='/'&&(next==='/'||next==='*')) {
   const end=next==='/'?source.indexOf('\n',offset+2):source.indexOf('*/',offset+2);
   assert(next==='/'||end>=0,'Unterminated JS comment');
   offset=end<0?source.length:end+(next==='*'?2:1);continue;
  }
  if(char==='\''||char==='"') {
   string.lastIndex=offset;const match=string.exec(source);assert(match,'Invalid JS string at '+offset);
   tokens.push({kind:'string',text:match[0]});offset=string.lastIndex;previous='literal';continue;
  }
  if(char==='`') {
   const start=offset++;
   while(offset<source.length&&source[offset]!=='`'){if(source[offset]==='\\')offset++;offset++;}
   assert(offset<source.length,'Unterminated JS template');
   const template=source.slice(start,++offset);
   assert(!/\$\{[\s\S]*\b_\s*\(/.test(template),'Translation in template interpolation needs extraction support');
   tokens.push({kind:'template',text:template});previous='literal';continue;
  }
  if(char==='/'&&(['','(','[','{','=','==','===',':',',','!','?',';','return','=>','&&','||'].includes(previous))) {
   let inClass=false,closed=false;offset++;
   while(offset<source.length) {
    const current=source[offset++];
    if(current==='\\'){offset++;continue;}
    if(current==='[')inClass=true;
    if(current===']')inClass=false;
    if(current==='/'&&!inClass){closed=true;break;}
    assert(current!=='\n'&&current!=='\r','Unterminated JS regexp');
   }
   assert(closed,'Unterminated JS regexp');
   while(/[a-z]/i.test(source[offset]||'')&&offset<source.length)offset++;
   tokens.push({kind:'regexp',text:'/regexp/'});previous='literal';continue;
  }
  identifier.lastIndex=offset;const name=identifier.exec(source);
  const operator=/^(?:===|!==|=>|==|!=|&&|\|\||\?\.|\+\+|--)/.exec(source.slice(offset));
  const token=name?name[0]:operator?operator[0]:char;
  tokens.push({kind:'token',text:token});previous=token;offset+=token.length;
 }
 const ids=[];
 for(let i=0;i<tokens.length;i++) {
  if(tokens[i].text!=='_'||tokens[i+1]?.text!=='('||['.','?.'].includes(tokens[i-1]?.text))continue;
  assert(tokens[i+2]?.kind==='string'&&tokens[i+3]?.text===')','Translation call must contain one pure string literal');
  ids.push(vm.runInNewContext('('+tokens[i+2].text+')',Object.create(null),{timeout:1000}));
 }
 return ids;
}
function printfPlaceholders(text) {
 return Array.from(text.matchAll(/%%|%(?:\d+\$)?[-+ #0']*(?:\d+|\*(?:\d+\$)?)?(?:\.(?:\d+|\*(?:\d+\$)?))?(?:hh|ll|[hljztL])?[diuoxXfFeEgGaAcspn]/g),match=>match[0]);
}
function assertTranslations(ids,po,pot) {
 for(const id of ids) {
  assert(pot.has(id),'Missing POT msgid: '+id);
  const entry=po.get(id);assert(entry,'Missing PO msgid: '+id);
  assert(entry.msgstr.trim(),'Empty PO translation: '+id);
  assert(!entry.fuzzy,'Fuzzy PO translation: '+id);
  assert.deepEqual(printfPlaceholders(entry.msgstr),printfPlaceholders(id),'Printf placeholders changed: '+id);
 }
}
const gettextFixture=String.raw`msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\n"

# Translator comment with fuzzy in plain text
#. Extracted comment
#: view.js:1
#| msgid "Old"
#, c-format
msgid ""
"Quoted \"DNS\" "
"path \\server\n\t\a\b\f\r\v\077\x21 %s"
msgstr ""
"Translated \"DNS\" "
"path \\server\n\t\a\b\f\r\v?! %s"
#, fuzzy, c-format
msgid "Unused Cloudflare"
msgstr "Unused translation"

#~ msgid "Obsolete"
#~ msgstr "Obsolete translation"

msgid "Fresh"
msgstr "Current"`;
const fixturePO=parseGettext('\uFEFF'+gettextFixture.replace(/\n/g,'\r\n'));
const escapedId='Quoted "DNS" path \\server\n\t\x07\b\f\r\v?! %s';
assert.equal(fixturePO.size,4);
assert.equal(fixturePO.get('').msgstr,'Content-Type: text/plain; charset=UTF-8\n');
assert.deepEqual(fixturePO.get(escapedId),{msgstr:'Translated "DNS" path \\server\n\t\x07\b\f\r\v?! %s',fuzzy:false});
assert.equal(fixturePO.get('Unused Cloudflare').fuzzy,true);assert.equal(fixturePO.get('Fresh').fuzzy,false);
const fixturePOT=parseGettext(String.raw`msgid ""
"Quoted \"DNS\" "
"path \\server\n\t\a\b\f\r\v?! %s"
msgstr ""`);
assertTranslations([escapedId],fixturePO,fixturePOT);
assert.throws(()=>assertTranslations(['Unused Cloudflare'],fixturePO,fixturePO),/Fuzzy PO/);
assert.throws(()=>assertTranslations(['Missing'],fixturePO,fixturePOT),/Missing POT/);
assert.throws(()=>assertTranslations([escapedId],new global.Map(),fixturePOT),/Missing PO/);
for(const [msgstr,fuzzy,error] of [['',false,/Empty PO/],['   ',false,/Empty PO/],['Changed %d',false,/Printf placeholders/],['Changed %s %s',false,/Printf placeholders/],['Changed %s',true,/Fuzzy PO/]]) {
 assert.throws(()=>assertTranslations([escapedId],new global.Map([[escapedId,{msgstr,fuzzy}]]),fixturePOT),error);
}
assert.deepEqual(printfPlaceholders('100%% %s %d %d %02d %.2f %1$s %*.*f'),['%%','%s','%d','%d','%02d','%.2f','%1$s','%*.*f']);
assert.throws(()=>parseGettext('msgid "Missing"'),/Missing msgstr/);
assert.throws(()=>parseGettext('msgid "Bad\\q"\nmsgstr "x"'),/Invalid gettext/);
assert.throws(()=>parseGettext('msgid "Same"\nmsgstr "x"\nmsgid "Same"\nmsgstr "y"'),/Duplicate msgid/);
assert.deepEqual(translationLiterals(String.raw`// _('Line comment')
/* _("Block comment") */
const text="_('String contents')";
const template=\`_('Template contents')\`;
const pattern=/_\('Regexp contents'\)/;
const ratio=4/2;
other_('Other function');object._('Method');
_ /* between tokens */ ('Quoted \'DNS\' \\path\n');
_("Double \"quotes\"");_('Unicode \u0041');
if(false){_('Unreachable literal');}`.replace(/\\`/g,'`')),['Quoted \'DNS\' \\path\n','Double "quotes"','Unicode A','Unreachable literal']);
assert.throws(()=>translationLiterals("_('part' + 'rest')"),/pure string literal/);
assert.throws(()=>translationLiterals('_(getLabel())'),/pure string literal/);
function filesWithExtension(directory,extension) {
 return fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{
  const filename=require('path').join(directory,entry.name);
  return entry.isDirectory()?filesWithExtension(filename,extension):entry.isFile()&&entry.name.endsWith(extension)?[filename]:[];
 });
}
const translationFiles=[...filesWithExtension(root+'mosdns','.js'),...filesWithExtension(root+'view/mosdns','.js')];
const usedIds=new Set();let literalCalls=0;
for(const filename of translationFiles) {
 const ids=translationLiterals(fs.readFileSync(filename,'utf8'));literalCalls+=ids.length;
 assert(ids.length>0,filename+': no translation literals extracted');
 for(const id of ids) {
  assert(!/\bv2\b|schema version/i.test(id),filename+': internal version in visible wording: '+id);
  assert(!/^Automatic\b/.test(id),filename+': invented automatic-mode wording: '+id);
  assert(!/Save & Apply|Save stages changes|atomically|configuration backup|failed reload keeps/i.test(id),filename+': implementation details in visible wording: '+id);
  usedIds.add(id);
 }
}
const menuFiles=filesWithExtension(require('path').join(__dirname,'../luci-app-mosdns/root/usr/share/luci/menu.d'),'.json');
let menuTitles=0;
for(const filename of menuFiles) {
 const menu=JSON.parse(fs.readFileSync(filename,'utf8'));
 for(const entry of Object.values(menu)) {
  if(!Object.hasOwn(entry,'title'))continue;
  assert.equal(typeof entry.title,'string',filename+': nonliteral menu title');
  assert(!/\bv2\b|schema version/i.test(entry.title),filename+': internal version in menu title');
  usedIds.add(entry.title);menuTitles++;
 }
}
assert(usedIds.size>0&&usedIds.size<=literalCalls+menuTitles,'Translation extraction must cover JS literals and menu titles');
const po=parseGettext(fs.readFileSync(require('path').join(__dirname,'../luci-app-mosdns/po/zh_Hans/mosdns.po'),'utf8'));
const pot=parseGettext(fs.readFileSync(require('path').join(__dirname,'../luci-app-mosdns/po/templates/mosdns.pot'),'utf8'));
assertTranslations(usedIds,po,pot);
for(const [id,translation] of [['Config File','配置文件'],['Default Config','内置预设'],['Custom Config','自定义'],['Configuration Editor','配置编辑器'],['Basic Options','基本选项'],['Advanced Options','高级选项'],['API Options','API 选项'],['GeoData Export','GeoData 导出'],['Debug','调试'],['Info','信息'],['Warning','警告'],['Error','错误'],['Restore default configuration','恢复默认配置'],['Restore default configuration?','恢复默认配置？'],['Restore rules, keep groups','恢复规则，保留 DNS 组'],['Retained from older settings; inactive.','保留自旧设置，不生效。'],['MosDNS is a plugin-based DNS forwarder/traffic splitter.','MosDNS 是一个插件化的 DNS 转发/分流器。']]) {
 assert(usedIds.has(id),'Expected current UI wording: '+id);
 assert.equal(po.get(id).msgstr,translation);
}
for(const id of ['Automatic','Automatic mode only. Custom YAML sets its own API address; use a trusted bind address.','Custom configuration editor','Custom mode ignores DNS groups and routing rules. Enter your YAML configuration here.','Generated v2 configuration','MosDNS v2','Restore all v2 defaults','Restore v2 defaults?']) {
 assert(!usedIds.has(id),'Legacy wording still used: '+id);
 assert(po.has(id)&&pot.has(id),'Legacy translation must remain compatible: '+id);
}
console.log('PASS: gettext multiline, C escapes, comments/fuzzy and extraction regressions; '+translationFiles.length+' JS files, '+literalCalls+' literal calls, '+menuTitles+' menu titles, '+usedIds.size+' unique used msgids; '+(po.size-1)+' PO and '+(pot.size-1)+' POT msgids; '+Array.from(usedIds).filter(id=>printfPlaceholders(id).length).length+' used printf msgids preserved.');
