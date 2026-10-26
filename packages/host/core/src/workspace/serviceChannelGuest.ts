// Only stdio is connected to the host; the guest can select service IDs, not host addresses.
export const workspaceServiceGuest = String.raw`
const http=require('node:http'),h2=require('node:http2'),{Duplex}=require('node:stream');
const wire=Duplex.from({readable:process.stdin,writable:process.stdout});
const session=h2.connect('http://dim-workspace',{createConnection:()=>wire,settings:{enablePush:false}});
const blocked=new Set(['connection','keep-alive','proxy-connection','transfer-encoding','upgrade','host','te','trailer']);
const server=http.createServer({maxHeaderSize:16384},(request,response)=>{
 if(request.method==='CONNECT'||request.headers.upgrade||request.headers.origin){response.writeHead(403).end();return}
 const headers={':path':request.url,':method':request.method};
 for(const [name,value] of Object.entries(request.headers))if(!blocked.has(name)&&value!==undefined)headers[name]=value;
 let stream;try{stream=session.request(headers)}catch{response.writeHead(503).end();return}
 stream.on('response',headers=>{
  const result={};for(const [name,value] of Object.entries(headers))if(!name.startsWith(':')&&!blocked.has(name))result[name]=value;
  response.writeHead(Number(headers[':status']),result);stream.pipe(response,{end:false});
 });
 stream.on('end',()=>{if(stream.rstCode!==0)response.destroy();else response.end()});
 stream.on('aborted',()=>response.destroy());
 stream.on('error',()=>{if(!response.headersSent)response.writeHead(503).end();else response.destroy()});
 request.on('aborted',()=>stream.close(h2.constants.NGHTTP2_CANCEL));
 request.on('error',()=>stream.close(h2.constants.NGHTTP2_CANCEL));
 response.on('close',()=>{if(!stream.readableEnded)stream.close(h2.constants.NGHTTP2_CANCEL)});
 request.pipe(stream);
});
server.requestTimeout=0;server.headersTimeout=5000;
server.on('connect',(_request,socket)=>socket.destroy());
server.on('upgrade',(_request,socket)=>socket.destroy());
let closing=false;
function close(){if(closing)return;closing=true;server.close();server.closeAllConnections();session.destroy();wire.destroy();process.stdin.destroy()}
session.on('error',close);session.on('close',close);wire.on('error',close);wire.on('end',close);
process.once('SIGTERM',close);process.once('SIGINT',close);
server.on('error',()=>{process.exitCode=1;close()});
server.listen(Number(process.argv[1]),'127.0.0.1',()=>{
 const address=server.address();
 const ready=session.request({':method':'GET',':path':'/_ready','x-dim-guest-port':String(address.port)});
 ready.on('response',headers=>{if(headers[':status']!==204)close()});ready.on('error',close);ready.resume();ready.end();
});
`;

export const workspaceServiceMarker = "dim-workspace-service-channel";

export const workspaceServiceCleanup = String.raw`
const fs=require('node:fs');
for(const pid of fs.readdirSync('/proc').filter(value=>/^\d+$/.test(value))){
 let args;try{args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0').filter(Boolean)}catch{continue}
 if(args.at(-2)==='dim-workspace-service-channel'&&args.at(-1)===process.argv[1]){
  try{process.kill(Number(pid),'SIGKILL')}catch(error){if(error.code!=='ESRCH')throw error}
 }
}
`;
