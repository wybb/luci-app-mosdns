#!/usr/bin/env python3
"""Real Chromium + pinned upstream LuCI; only HTTP/RPC/router state is simulated."""
import argparse, copy, json, mimetypes, pathlib, subprocess, threading, urllib.parse
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

ROOT = pathlib.Path(__file__).resolve().parents[2]
SHA = 'cae27bd8ad448b7d6216c581cd2852ffa971b1c5'

def initial():
    specs = [
        ('config', 'mosdns', dict(enabled='0', fallback_ip_strategy='auto')),
        ('dns_main', 'dns_group', dict(name='Main', is_default='1', use_default_dns='0', dns=['8.8.8.8'])),
        ('dns_spare', 'dns_group', dict(name='Spare', is_default='0', use_default_dns='0', dns=['1.1.1.1'])),
        ('rule_a', 'rule', dict(name='First rule', enabled='1', mode='custom', dns_group='dns_main', ip_strategy='auto', ttl='0', rule_file='/etc/mosdns/rule/a.txt')),
        ('rule_b', 'rule', dict(name='Second rule', enabled='1', mode='builtin', builtin_type='cn_domain', dns_group='dns_spare', ip_strategy='auto')),
        ('map_a', 'ip_map', dict(name='First mapping', enabled='1', ip_map_target=['1.2.3.4'], continue_match='1', rule_file='/etc/mosdns/rule/map.txt')),
        ('map_b', 'ip_map', dict(name='Second mapping', enabled='1', ip_map_target=['5.6.7.8'], continue_match='0', rule_file='/etc/mosdns/rule/map.txt')),
    ]
    return {sid: dict(values, **{'.name': sid, '.type': typ, '.index': i, '.anonymous': typ in ('rule','ip_map')}) for i,(sid,typ,values) in enumerate(specs)}

class State:
    def reset(self):
        self.data = initial(); self.calls=[]; self.changes=[]; self.files={'/etc/mosdns/rule/a.txt':'domain:example.org\n', '/etc/mosdns/rule/map.txt':'10.0.0.0/8\n'}; self.fail_write=False
    def rpc(self, req):
        if req.get('method') == 'list': return {'jsonrpc':'2.0', 'id':req['id'], 'result':{}}
        _, obj, method, args = req['params']; self.calls.append((obj,method,args))
        result = {}; code = 0
        if obj == 'session': result = {'access':True}
        elif obj == 'uci':
            sid=args.get('section')
            if method == 'get': result = {'values': self.data if args.get('config') == 'mosdns' else {}}
            elif method == 'changes': result = {'changes': {'mosdns':self.changes} if self.changes else {}}
            elif method == 'add':
                sid=args.get('name') or 'cfg%06x' % (len(self.data)+1)
                self.data[sid]=dict(args.get('values',{}), **{'.name':sid,'.type':args['type'],'.index':len(self.data),'.anonymous':not args.get('name')}); result={'section':sid}; self.changes.append(['add',sid,args['type']])
            elif method == 'set': self.data[sid].update(args['values']); self.changes.append(['set',sid,str(args['values'])])
            elif method == 'delete':
                if args.get('options'):
                    for k in args['options']: self.data[sid].pop(k,None)
                else: self.data.pop(sid,None)
                self.changes.append(['remove',sid])
            elif method == 'order':
                for i,s in enumerate(args['sections']): self.data[s]['.index']=i
                self.changes.append(['order',args['sections']])
        elif obj == 'luci.mosdns':
            if method == 'read_rule_file': result={'success':True,'content':self.files[args['name']]} if args['name'] in self.files else {'success':False,'error':'No such file'}
            elif method == 'write_rule_file':
                if self.fail_write: result={'success':False,'error':'Fixture disk full'}
                else:
                    path='/etc/mosdns/rule/v2_'+args['section']+'.txt'; self.files[path]=args['content']; result={'success':True,'rule_file':path}
            elif method == 'get_apply_status': result={'phase':'applied','success':True}
            else: result={'success':True}
        elif obj == 'service': result={'mosdns':{'instances':{'main':{'running':True}}}}
        elif obj == 'file': result={'data':''}
        return {'jsonrpc':'2.0','id':req['id'],'result':[code,result]}

HTML='''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/theme/cascade.css"><link rel="stylesheet" media="only screen and (max-device-width:854px)" href="/theme/mobile.css"><script src="/resources/cbi.js"></script></head><body><header><a class="brand">Isolated LuCI fixture</a><div id="indicators" class="pull-right"></div></header><div id="maincontent" class="container"><div id="view"></div></div><script src="/resources/luci.js"></script><script>window.L = new LuCI({base_url:'/resources',resource:'/resources',media:'/theme',scriptname:'/cgi-bin/luci',pathinfo:'/admin/services/mosdns',requestpath:['admin','services','mosdns'],ubuspath:'/ubus',sessionid:'fixture-only',token:'fixture-only',apply_rollback:10,apply_holdoff:0,apply_timeout:2,apply_display:1,pollinterval:1000,nodespec:{readonly:false}}); L.require('view.mosdns.'+new URLSearchParams(location.search).get('view')).then(v=>window.fixtureView=v);</script></body></html>'''

def run(args):
    source=pathlib.Path(args.luci_source).resolve()
    actual=subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()
    assert actual == SHA, f'LuCI HEAD {actual} differs from tested pin {SHA}'
    resources=source/'modules/luci-base/htdocs/luci-static/resources'; app=ROOT/'luci-app-mosdns/htdocs/luci-static/resources'; theme=source/'themes/luci-theme-bootstrap/htdocs/luci-static/bootstrap'
    state=State(); state.reset()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*a): pass
        def send(self,data,kind='application/json',status=200):
            if not isinstance(data,bytes): data=data.encode()
            self.send_response(status); self.send_header('Content-Type',kind); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)
        def do_GET(self):
            path=urllib.parse.urlparse(self.path).path
            if path == '/':
                query=urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                if 'reset' in query: state.reset()
                if 'missing' in query: state.files.pop('/etc/mosdns/rule/a.txt',None); state.data['rule_a']['enabled']='0'
                return self.send(HTML,'text/html')
            if path == '/narrow': return self.send('<!doctype html><html><head><title>390px LuCI viewport fixture</title></head><body style="margin:0;background:#ddd"><iframe title="Narrow LuCI" src="/mobile?view=rules_v2" style="width:390px;height:844px;border:0;background:white"></iframe></body></html>', 'text/html')
            if path == '/mobile': return self.send(HTML.replace('media="only screen and (max-device-width:854px)"',''), 'text/html')
            if path == '/fixture-state': return self.send(json.dumps({'data':state.data,'calls':state.calls,'files':state.files},indent=2),'text/plain')
            roots={'/resources/':resources,'/theme/':theme}
            for prefix,root in roots.items():
                if path.startswith(prefix):
                    rel=path[len(prefix):]; f=(app/rel if prefix=='/resources/' and (app/rel).is_file() else root/rel)
                    if f.is_file(): return self.send(f.read_bytes(),mimetypes.guess_type(str(f))[0] or 'text/plain')
            self.send('{}',status=404)
        def do_POST(self):
            body=self.rfile.read(int(self.headers.get('Content-Length',0)))
            if self.path.startswith('/ubus'):
                req=json.loads(body); out=[state.rpc(r) for r in req] if isinstance(req,list) else state.rpc(req); return self.send(json.dumps(out))
            state.calls.append(('http',self.path,{}))
            if 'confirm' in self.path: state.changes=[]
            self.send('{}')
    server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler); threading.Thread(target=server.serve_forever,daemon=True).start()
    url=f'http://127.0.0.1:{server.server_port}/'
    output=pathlib.Path(args.output); output.mkdir(parents=True,exist_ok=True)
    if args.serve_only:
        print(url,flush=True)
        threading.Event().wait()
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=args.chromium,headless=True)
        page=browser.new_page(viewport={'width':1280,'height':900}); errors=[]
        page.on('pageerror',lambda e: errors.append(str(e)))
        page.on('console',lambda m: print('CONSOLE',m.type,m.text) if m.type=='error' else None)
        def load(view, **kw):
            state.reset()
            if kw.get('missing'):
                state.files.pop('/etc/mosdns/rule/a.txt'); state.data['rule_a']['enabled']='0'
            page.goto(url+'?view='+view)
            page.locator('.mosdns-v2 .cbi-map').wait_for()
            assert not errors, errors
        def modal(): return page.locator('#modal_overlay .cbi-modal')
        def edit(sid):
            page.locator(f'[data-sid="{sid}"] .cbi-button-edit').click(); modal().wait_for(state='visible')
        def field(name): return modal().locator(f'[data-name="{name}"] input').first
        def dismiss():
            modal().get_by_role('button',name='Dismiss',exact=True).click(); modal().wait_for(state='hidden')
        def save_modal():
            modal().get_by_role('button',name='Save',exact=True).click(); modal().wait_for(state='hidden')
        def saved():
            page.locator('.cbi-page-actions').get_by_role('button',name='Save',exact=True).click()
            page.wait_for_function("!document.querySelector('.cbi-page-actions .spinning')")
        def screenshot(name): page.screenshot(path=str(output/(name+'.png')),full_page=True)
        results=[]
        def check(name, fn):
            errors.clear()
            try:
                fn(); assert not errors, errors
                results.append({'test':name,'status':'passed'})
            except Exception as error:
                screenshot(name+'-failure')
                (output/(name+'-failure.html')).write_text(page.content())
                results.append({'test':name,'status':'failed','error':str(error)})
            print(json.dumps(results[-1]),flush=True)
        def render_all():
            for view in ('basic_v2','dns_groups_v2','rules_v2','ip_mapping_v2'):
                load(view); screenshot(view)
        check('render-all-views',render_all)
        def cancellation():
            for view,typ in [('rules_v2','rule'),('ip_mapping_v2','ip_map'),('dns_groups_v2','dns_group')]:
                load(view); before=copy.deepcopy(state.data)
                if typ=='dns_group':
                    page.locator('.cbi-section-create-name').fill('dns_cancelled')
                    page.locator('.cbi-section-create-name').press('Tab')
                page.locator('.cbi-button-add').click(); modal().wait_for(state='visible')
                if typ=='rule':
                    options=modal().get_by_label('DNS group',exact=True).locator('option').all_text_contents()
                    assert len(options)==len(set(options))==2, options
                dismiss()
                saved(); assert state.data==before, (view,state.data)
                assert not any(c[1]=='write_rule_file' for c in state.calls), state.calls
        check('add-dismiss-without-phantom-write',cancellation)
        def group_ids():
            load('dns_groups_v2'); edit('dns_main'); field('name').fill('Renamed DNS group'); save_modal()
            assert state.data['dns_main']['name']=='Renamed DNS group'
            assert state.data['rule_a']['dns_group']=='dns_main'
            page.locator('[data-sid="dns_main"] .cbi-button-remove').click()
            assert 'dns_main' in state.data
            page.locator('[data-sid="dns_spare"] .cbi-button-remove').click()
            assert 'dns_spare' in state.data, 'referenced group must not be deleted'
        check('stable-group-rename-protected-delete',group_ids)
        def file_save():
            load('rules_v2'); edit('rule_a'); modal().locator('textarea').fill('domain:changed.example\n'); save_modal()
            ref=state.data['rule_a']['rule_file']; assert state.files[ref]=='domain:changed.example\n'
            writes=[i for i,c in enumerate(state.calls) if c[1]=='write_rule_file']
            sets=[i for i,c in enumerate(state.calls) if c[0]=='uci' and c[1]=='set' and c[2].get('section')=='rule_a' and 'rule_file' in c[2].get('values',{})]
            assert writes and sets and min(writes)<min(sets), state.calls
            edit('rule_a'); assert modal().locator('textarea').input_value()=='domain:changed.example\n'; dismiss()
        check('atomic-file-save-before-uci',file_save)
        def add_rule():
            load('rules_v2'); before=set(state.data)
            page.locator('.cbi-button-add').click(); modal().wait_for(state='visible')
            field('name').fill('New stable rule'); modal().locator('textarea').fill('domain:new.example\n'); save_modal()
            added=set(state.data)-before; assert len(added)==1, added
            sid=added.pop(); assert sid.startswith('cfg'), sid
            assert state.data[sid]['name']=='New stable rule'
            assert state.files[state.data[sid]['rule_file']]=='domain:new.example\n'
            edit(sid); field('name').fill('Renamed stable rule'); save_modal()
            assert state.data[sid]['name']=='Renamed stable rule'
            page.locator(f'[data-sid="{sid}"] .cbi-button-remove').click()
            page.locator(f'[data-sid="{sid}"]').wait_for(state='detached')
            assert sid not in state.data
        check('add-save-rename-delete-rule-id',add_rule)
        def write_failure():
            load('rules_v2'); ref=state.data['rule_a']['rule_file']; state.fail_write=True
            edit('rule_a'); modal().locator('textarea').fill('domain:must-not-save.example\n')
            modal().get_by_role('button',name='Save',exact=True).click()
            page.get_by_text('Fixture disk full',exact=False).first.wait_for()
            assert state.data['rule_a']['rule_file']==ref
            assert not any(c[0]=='uci' and c[1]=='set' and 'rule_file' in c[2].get('values',{}) for c in state.calls)
        check('failed-file-write-preserves-pointer',write_failure)
        def reorder():
            for view,a,b in [('rules_v2','rule_a','rule_b'),('ip_mapping_v2','map_a','map_b')]:
                load(view); ids=set(state.data)
                # Browser-native HTML5 drag events exercise upstream handlers, not a UCI stub.
                page.evaluate("""([a,b]) => {
                    const source=document.querySelector('[data-sid="'+b+'"] .drag-handle');
                    const target=document.querySelector('[data-sid="'+a+'"]');
                    const dataTransfer=new DataTransfer(), rect=target.getBoundingClientRect();
                    source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer}));
                    target.dispatchEvent(new DragEvent('dragenter',{bubbles:true,dataTransfer}));
                    target.dispatchEvent(new DragEvent('dragover',{bubbles:true,dataTransfer,clientY:rect.top+1}));
                    target.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer}));
                    source.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer}));
                }""",[a,b])
                saved(); assert set(state.data)==ids
                assert state.data[b]['.index']<state.data[a]['.index'], state.data
                page.reload(); page.locator(f'[data-sid="{b}"]').wait_for()
                rows=page.locator('.cbi-section-table-row[data-sid]').evaluate_all('(rows)=>rows.map(r=>r.dataset.sid)')
                assert rows.index(b)<rows.index(a), rows
        check('reorder-preserves-ids-and-reloads',reorder)
        def missing_file():
            load('rules_v2',missing=True); ref=state.data['rule_a']['rule_file']; saved()
            assert state.data['rule_a']['rule_file']==ref
            assert not any(c[1]=='write_rule_file' for c in state.calls)
            edit('rule_a'); modal().locator('textarea').fill('domain:recovered.example\n'); save_modal()
            assert state.data['rule_a']['rule_file']!=ref
            assert state.files[state.data['rule_a']['rule_file']]=='domain:recovered.example\n'
        check('missing-disabled-file-recovery',missing_file)
        def apply():
            load('rules_v2'); edit('rule_a'); field('name').fill('Apply test'); save_modal()
            page.locator('.cbi-page-actions').get_by_text('Save & Apply',exact=True).click()
            page.wait_for_function("document.body.textContent.includes('Configuration changes applied.')")
            assert any(c[0]=='http' and 'apply_rollback' in c[1] for c in state.calls), state.calls
            assert any(c[0]=='http' and '/confirm' in c[1] for c in state.calls), state.calls
        check('standard-save-apply-confirm',apply)
        def mobile():
            page.set_viewport_size({'width':390,'height':844})
            load('rules_v2'); edit('rule_a'); field('name').fill('A very long DNS routing rule display name '*8); save_modal()
            screenshot('mobile-long-rule-name')
            edit('rule_a'); screenshot('mobile-rule-editor')
            geometry=modal().bounding_box(); assert geometry and geometry['x']>=-1 and geometry['x']+geometry['width']<=391, geometry
            assert modal().get_by_role('button',name='Save',exact=True).is_visible()
            dismiss(); page.set_viewport_size({'width':1280,'height':900})
        check('mobile-modal-and-long-name',mobile)
        report={'luci_commit':actual,'browser':browser.version,'theme':'bootstrap','backend':'simulated RPC; no real router or service restart', 'results':results}
        (output/'results.json').write_text(json.dumps(report,indent=2))
        browser.close()
    server.shutdown()
    assert all(r['status']=='passed' for r in results), 'See browser results.json'

if __name__ == '__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--serve-only',action='store_true'); parser.add_argument('--port',type=int,default=0); parser.add_argument('--luci-source',required=True); parser.add_argument('--chromium',default='/usr/bin/chromium'); parser.add_argument('--output',default='/tmp/mosdns-browser-results'); run(parser.parse_args())
