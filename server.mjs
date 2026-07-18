import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root=path.dirname(fileURLToPath(import.meta.url));
const certDir=path.join(root,'.certs');
const port=Number(process.env.ZOUJUP_TEST_PORT||8443);
const caPort=Number(process.env.ZOUJUP_CA_PORT||8080);
const ips=Object.values(os.networkInterfaces()).flat().filter(x=>x&&x.family==='IPv4'&&!x.internal).map(x=>x.address);
const run=(args)=>{const result=spawnSync('openssl',args,{stdio:'inherit'});if(result.status!==0)throw new Error(`openssl failed: ${args.join(' ')}`)};
fs.mkdirSync(certDir,{recursive:true});
const caKey=path.join(certDir,'zoujup-test-ca.key');const caCert=path.join(certDir,'zoujup-test-ca.crt');
if(!fs.existsSync(caCert)){run(['genrsa','-out',caKey,'2048']);run(['req','-x509','-new','-nodes','-key',caKey,'-sha256','-days','3650','-out',caCert,'-subj','/CN=ZoujUp Local WebRTC Test CA'])}
const serverKey=path.join(certDir,'server.key');const csr=path.join(certDir,'server.csr');const serverCert=path.join(certDir,'server.crt');const ext=path.join(certDir,'server.ext');
const sans=['DNS:localhost','IP:127.0.0.1',...ips.map(ip=>`IP:${ip}`)].join(',');
fs.writeFileSync(ext,`subjectAltName=${sans}\nextendedKeyUsage=serverAuth\n`);
run(['genrsa','-out',serverKey,'2048']);run(['req','-new','-key',serverKey,'-out',csr,'-subj','/CN=ZoujUp WebRTC Diagnostic']);run(['x509','-req','-in',csr,'-CA',caCert,'-CAkey',caKey,'-CAcreateserial','-out',serverCert,'-days','825','-sha256','-extfile',ext]);

const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.crt':'application/x-x509-ca-cert'};
const bundledSocketClient=path.join(root,'socket.io.min.js');
const siblingSocketClient=path.resolve(root,'../language_websockets-dev/node_modules/socket.io/client-dist/socket.io.min.js');
const socketClient=fs.existsSync(bundledSocketClient)?bundledSocketClient:siblingSocketClient;
https.createServer({key:fs.readFileSync(serverKey),cert:fs.readFileSync(serverCert)},(req,res)=>{
  const pathname=new URL(req.url,'https://localhost').pathname;
  const publicFiles=new Map([
    ['/',path.join(root,'index.html')],['/index.html',path.join(root,'index.html')],
    ['/app.js',path.join(root,'app.js')],['/styles.css',path.join(root,'styles.css')],
    ['/socket.io.min.js',socketClient],['/ca.crt',caCert],
  ]);
  const file=publicFiles.get(pathname);
  if(!file){res.writeHead(404);return res.end('Not found')}
  fs.readFile(file,(err,data)=>{if(err){res.writeHead(404);return res.end('Not found')}res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(data)});
}).listen(port,'0.0.0.0',()=>{
  console.log('\nZoujUp WebRTC diagnostic is running (production backend only):');
  console.log(`  Laptop: https://localhost:${port}`);
  for(const ip of ips)console.log(`  Phone:  https://${ip}:${port}`);
  console.log('\nPhone certificate setup:');
  console.log(`  1. Open http://<laptop-ip>:${caPort}/ca.crt and install the CA profile.`);
  console.log('  2. Trust "ZoujUp Local WebRTC Test CA" in the phone security/profile settings.');
  console.log(`  3. Reopen https://<laptop-ip>:${port} and allow camera + microphone.\n`);
});

http.createServer((req,res)=>{
  if(new URL(req.url,'http://localhost').pathname==='/ca.crt'){
    res.writeHead(200,{'Content-Type':'application/x-x509-ca-cert','Content-Disposition':'attachment; filename="zoujup-test-ca.crt"'});
    return res.end(fs.readFileSync(caCert));
  }
  res.writeHead(302,{Location:`https://${req.headers.host?.split(':')[0]||'localhost'}:${port}/`});res.end();
}).listen(caPort,'0.0.0.0',()=>console.log(`  CA:     http://<laptop-ip>:${caPort}/ca.crt`));
