import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const files={ 'index.html':'text/html; charset=utf-8','styles.css':'text/css; charset=utf-8','app.js':'text/javascript; charset=utf-8' };
const port=Number(process.env.PORT || 3000);
const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://127.0.0.1');
    const name=url.pathname.endsWith('/')?'index.html':url.pathname.split('/').at(-1);
    if(!Object.hasOwn(files,name) || !['GET','HEAD'].includes(req.method)) {res.writeHead(404).end('Not found'); return;}
    const body=await readFile(new URL(`../${name}`,import.meta.url));
    res.writeHead(200,{'Content-Type':files[name],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
    res.end(req.method==='HEAD'?undefined:body);
  } catch {res.writeHead(500).end('Unable to load page');}
});
server.listen(port,'127.0.0.1',()=>console.log(`Ритм: http://127.0.0.1:${port}/`));
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>server.close(()=>process.exit(0)));
