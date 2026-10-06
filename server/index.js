
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { attachLong } from './long-engine.js';
import { attachShort } from './short-engine.js';

const require=createRequire(import.meta.url);
const { attachZjh }=require('./zjh-engine.cjs');

const __filename=fileURLToPath(import.meta.url);
const __dirname=path.dirname(__filename);
const publicDir=path.join(__dirname,'public');

const app=express();
app.use(express.json());

const roomRegistry=new Map();
function validMode(mode){return ['zjh','long','short'].includes(mode)}
function allocateCode(){
  let code='';
  do{code=String(Math.floor(10000+Math.random()*90000));}while(roomRegistry.has(code));
  return code;
}

app.get('/api/health',(req,res)=>res.json({ok:true,service:'private-poker',rooms:roomRegistry.size}));

app.get('/api/rooms/allocate',(req,res)=>{
  const mode=String(req.query.mode||'');
  if(!validMode(mode))return res.status(400).json({ok:false,msg:'玩法无效'});
  const code=allocateCode();
  roomRegistry.set(code,{mode,createdAt:Date.now()});
  res.json({ok:true,code,mode});
});

app.get('/api/rooms/lookup',(req,res)=>{
  const code=String(req.query.code||'').trim();
  const room=roomRegistry.get(code);
  if(!room)return res.json({ok:false,msg:'房间不存在'});
  res.json({ok:true,code,mode:room.mode});
});

app.post('/api/rooms/register',(req,res)=>{
  const code=String(req.body?.code||'').trim();
  const mode=String(req.body?.mode||'');
  if(!/^\d{5}$/.test(code)||!validMode(mode))return res.status(400).json({ok:false,msg:'参数无效'});
  const old=roomRegistry.get(code);
  if(old&&old.mode!==mode)return res.status(409).json({ok:false,msg:'房间号已被其他玩法占用'});
  roomRegistry.set(code,{mode,createdAt:old?.createdAt||Date.now()});
  res.json({ok:true});
});

app.use('/games/zjh',express.static(path.join(publicDir,'games/zjh'),{index:'index.html'}));
app.use('/games/long',express.static(path.join(publicDir,'games/long'),{index:'index.html'}));
app.use('/games/short',express.static(path.join(publicDir,'games/short'),{index:'index.html'}));
app.use(express.static(publicDir));

app.get('/games/zjh/*',(req,res)=>res.sendFile(path.join(publicDir,'games/zjh/index.html')));
app.get('/games/long/*',(req,res)=>res.sendFile(path.join(publicDir,'games/long/index.html')));
app.get('/games/short/*',(req,res)=>res.sendFile(path.join(publicDir,'games/short/index.html')));

const httpServer=http.createServer(app);

attachZjh(httpServer);
attachLong(httpServer);
attachShort(httpServer);

const port=Number(process.env.PORT||3100);
httpServer.listen(port,'0.0.0.0',()=>{
  console.log(`Private Poker unified server running on http://0.0.0.0:${port}`);
});
