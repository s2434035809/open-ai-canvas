"""Local-only opaque iframe test using the packaged Axios client and mock host."""
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path
import zipfile
import mimetypes
repo = Path(__file__).resolve().parent.parent
package = max((repo / 'output/dxos-app').glob('yingce-main-*.zip'), key=lambda p: p.stat().st_mtime)
archive = zipfile.ZipFile(package)
parent = '''<!doctype html><meta charset="utf-8"><title>Yingce sandbox regression</title><pre id="report">Local mock host: no credentials are sent to Yingce</pre>
<iframe style="width:98vw;height:85vh;border:0" sandbox="allow-scripts allow-forms" src="/app/index.html"></iframe>
<script>addEventListener('message',e=>{if(e.source!==document.querySelector('iframe').contentWindow)return;
const m=e.data;if(m.testReport)document.querySelector('#report').textContent=m.testReport;
if(m.action==='mcp.call'){
const isLogin=m.args.path==='/api/auth/login';
if(isLogin)document.querySelector('#report').textContent='PASS: login form reached the host bridge';
e.source.postMessage({dxos:'v1',id:m.id,ok:true,result:{text:JSON.stringify({status:isLogin?401:200,body:JSON.stringify(isLogin?{code:401,msg:'回归测试：账号校验失败（模拟响应）'}:{code:0,data:{fixture:true}})})}},'*')}});</script>'''
diagnostics = '''<script>addEventListener('error',e=>parent.postMessage({testReport:'ERROR: '+(e.message||e.target.src||e.target.href)},'*'),true);addEventListener('unhandledrejection',e=>parent.postMessage({testReport:'REJECTION: '+e.reason},'*'));</script>'''
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path=self.path.split('?')[0].lstrip('/')
        if path in ['', 'full.html']:
            data=parent.encode();mime='text/html; charset=utf-8'
        elif path.startswith('app/') and path[4:] in archive.namelist():
            name=path[4:];data=archive.read(name);mime=mimetypes.guess_type(name)[0] or 'application/octet-stream'
            if name.endswith('.html'):
                data=data.replace(b'<head>',b'<head>'+diagnostics.encode(),1)
        elif path == 'login':
            data=b'<h1>FAIL: app navigated out of package to host /login</h1>';mime='text/html'
        elif path in archive.namelist():
            data=archive.read(path);mime='text/javascript' if path.endswith('.js') else 'application/octet-stream'
        else:
            self.send_error(404);return
        self.send_response(200);self.send_header('Content-Type',mime);self.send_header('Access-Control-Allow-Origin','*');self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(data)
    def log_message(self,*args): pass
print('Local regression harness: http://127.0.0.1:8765',flush=True)
ThreadingHTTPServer(('127.0.0.1',8765),Handler).serve_forever()
