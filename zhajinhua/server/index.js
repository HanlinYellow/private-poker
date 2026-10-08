const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

const rooms = {};
const timers = new Map();
const BETS = [10, 20, 40, 80, 160];
const ANTE = 10;
const STARTING_CHIPS = 1000;
const RECONNECT_GRACE_MS = 45000;
const suits = ['♠', '♥', '♦', '♣'];
const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const rankValue = r => ({2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13,A:14})[r];

function cleanName(name){ return String(name || '').trim().slice(0,12) || '玩家'; }
function makeCode(){ let c; do c = String(Math.floor(10000 + Math.random()*90000)); while(rooms[c]); return c; }
function newDeck(){
  const d=[];
  for(const s of suits) for(const r of ranks) d.push({suit:s,rank:r});
  for(let i=d.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [d[i],d[j]]=[d[j],d[i]]; }
  return d;
}
function isOffsuit235(cards){
  const vals=cards.map(c=>rankValue(c.rank)).sort((a,b)=>a-b);
  return vals.join(',')==='2,3,5' && new Set(cards.map(c=>c.suit)).size>1;
}
function evalHand(cards){
  const vals=cards.map(c=>rankValue(c.rank)).sort((a,b)=>a-b);
  const counts=new Map(); vals.forEach(v=>counts.set(v,(counts.get(v)||0)+1));
  const flush=new Set(cards.map(c=>c.suit)).size===1;
  let straight=false, high=0;
  if(vals[0]===2&&vals[1]===3&&vals[2]===14){ straight=true; high=3; }
  else if(vals[0]+1===vals[1]&&vals[1]+1===vals[2]){ straight=true; high=vals[2]; }
  const groups=[...counts.entries()].sort((a,b)=>b[1]-a[1]||b[0]-a[0]);
  if(groups[0][1]===3) return {cat:6,score:[groups[0][0]],name:'豹子',is235:false};
  if(straight&&flush) return {cat:5,score:[high],name:'顺金',is235:false};
  if(flush) return {cat:4,score:[...vals].sort((a,b)=>b-a),name:'金花',is235:false};
  if(straight) return {cat:3,score:[high],name:'顺子',is235:false};
  if(groups[0][1]===2){
    const pair=groups.find(g=>g[1]===2)[0];
    const kicker=groups.find(g=>g[1]===1)[0];
    return {cat:2,score:[pair,kicker],name:'对子',is235:false};
  }
  return {cat:1,score:[...vals].sort((a,b)=>b-a),name:'单牌',is235:isOffsuit235(cards)};
}
function lexCompare(a,b){
  for(let i=0;i<Math.max(a.length,b.length);i++){
    const av=a[i]||0,bv=b[i]||0;
    if(av!==bv) return av>bv?1:-1;
  }
  return 0;
}
function compareHands(a,b){
  const A=evalHand(a), B=evalHand(b);
  if(A.is235&&B.cat===6) return 1;
  if(B.is235&&A.cat===6) return -1;
  if(A.is235&&!B.is235) return -1;
  if(B.is235&&!A.is235) return 1;
  if(A.cat!==B.cat) return A.cat>B.cat?1:-1;
  return lexCompare(A.score,B.score);
}

function findByToken(room, token){
  let p=room.players.find(x=>x.token===token); if(p) return {list:'players', p};
  p=room.waiting.find(x=>x.token===token); if(p) return {list:'waiting', p};
  return null;
}
function findByName(room, name){
  const n=cleanName(name);
  let p=room.players.find(x=>x.name===n); if(p) return {list:'players', p};
  p=room.waiting.find(x=>x.name===n); if(p) return {list:'waiting', p};
  return null;
}
function reseat(room){ room.players.forEach((p,i)=>p.seat=i+1); }
function activePlayers(room){ return room.players.filter(p=>p.inRound&&!p.folded&&!p.out); }
function currentPlayer(room){ return room.players[room.game.idx] || null; }
function allReady(room){
  const eligible=room.players.filter(p=>!p.bankrupt&&p.chips>0);
  return eligible.length>=2 && eligible.filter(p=>p.token!==room.host).every(p=>p.ready);
}
function rankings(room){
  const map=new Map(); [...room.players,...room.waiting].forEach(p=>map.set(p.name,p));
  const all=[...map.values()];
  return {
    alive:all.filter(p=>!p.bankrupt).sort((a,b)=>b.chips-a.chips || a.name.localeCompare(b.name)),
    bankrupt:all.filter(p=>p.bankrupt).sort((a,b)=>a.name.localeCompare(b.name))
  };
}
function nextActiveIndex(room, from){
  for(let step=1;step<=room.players.length;step++){
    const i=(from+step)%room.players.length, p=room.players[i];
    if(p&&p.inRound&&!p.folded&&!p.out) return i;
  }
  return -1;
}
function actionCost(room,p,type){
  const base=BETS[room.game.bet];
  return p.seen ? 2*base : base;
}
function pay(room,p,n){ p.chips-=n; p.delta-=n; room.game.pot+=n; }
function locked(room){ return !!(room.game.pendingCompare||room.game.compareResult||room.game.vote||room.game.showdownResult); }
function cancelTimer(token){ const t=timers.get(token); if(t) clearTimeout(t); timers.delete(token); }

function setAction(room,p,text){
  p.lastAction=text;
  room.game.msg=`${p.name}: ${text}`;
}
function chooseNextAnchor(room,winners){
  if(!winners||!winners.length) return;
  const anchor=[...winners].sort((a,b)=>(a.seat||0)-(b.seat||0)).at(-1);
  if(anchor) room.nextStartAfterName=anchor.name;
}
function settlementCardState(p,viewerToken,endedBy){
  // 自己永远能看到自己的牌。
  if(p.token===viewerToken) return 'face';
  // 其他人只有在“这个玩家实际公开过牌”时才能看到：
  // 明弃 foldReveal=true；最终开牌参与者 revealedAtEnd=true。
  // 之前已经暗弃/比牌出局的人，即使最后其他人开牌，也仍保持牌背。
  if(p.foldReveal || p.revealedAtEnd) return 'face';
  return 'back';
}

function payload(room, viewerToken){
  const R=rankings(room), vote=room.game.vote, pc=room.game.pendingCompare, cr=room.game.compareResult, sr=room.game.showdownResult;
  return {
    id:room.id, hostToken:room.host, status:room.status,
    readyCount:room.players.filter(p=>p.token===room.host||p.ready).length,
    allReady:allReady(room), pot:room.game.pot, roundNo:room.handNo||0, circleNo:room.game.round, betLevel:BETS[room.game.bet],
    currentToken:currentPlayer(room)?.token||null,
    showdownBlocked:room.game.openDeniedToken===viewerToken,
    showdownVote:vote?{initiatorToken:vote.init,approvals:[...vote.ok],required:vote.req}:null,
    pendingCompare:pc&&pc.tokens.includes(viewerToken)?{initiatorToken:pc.init,targetToken:pc.target,initiatorName:pc.initName,targetName:pc.targetName,cost:pc.cost}:null,
    compareResult:cr&&cr.tokens.includes(viewerToken)?(()=>{
      const v=(cr.views||[]).find(x=>x.token===viewerToken);
      return {
        text:cr.text,required:cr.req,acks:[...cr.acks],
        ownCards:v?.cards||[],ownSeen:!!v?.seen,ownWon:!!v?.won,
        ownCardMode:v?(v.seen?(v.won?'face':'faceGray'):(v.won?'back':'faceGray')):'back'
      };
    })():null,
    showdownResult:sr?{text:sr.text,required:sr.req,acks:[...sr.acks],winners:sr.winners,details:sr.details}:null,
    gameMessage:room.game.msg||'',
    settlement:room.settlement?{
      roundNo:room.settlement.roundNo,result:room.settlement.result,endedBy:room.settlement.endedBy,
      req:room.settlement.req,acks:[...room.settlement.acks],winners:room.settlement.winners,
      players:room.settlement.players.map(x=>({...x,cardState:settlementCardState(x,viewerToken,room.settlement.endedBy)}))
    }:null,
    players:room.players.map(p=>({
      token:p.token,name:p.name,seat:p.seat,ready:p.token===room.host?true:p.ready,connected:!!p.id,
      reconnectDeadline:p.reconnectDeadline||0,managed:!!p.managed,
      chips:p.chips,lastDelta:p.lastDelta||0,bankrupt:!!p.bankrupt,inRound:!!p.inRound,folded:!!p.folded,
      eliminated:!!p.out,seen:!!p.seen,lastAction:p.lastAction||'',foldReveal:!!p.foldReveal,
      cards:room.status==='playing'&&p.inRound?(p.reveal?p.cards:(p.token===viewerToken&&p.seen?p.cards:['back','back','back'])):[],
      revealed:!!p.reveal
    })),
    waiting:room.waiting.map(p=>({token:p.token,name:p.name,connected:!!p.id,reconnectDeadline:p.reconnectDeadline||0,managed:!!p.managed,chips:p.chips,lastDelta:p.lastDelta||0,bankrupt:!!p.bankrupt})),
    ranking:{
      alive:R.alive.map(p=>({token:p.token,name:p.name,chips:p.chips,lastDelta:p.lastDelta||0})),
      bankrupt:R.bankrupt.map(p=>({token:p.token,name:p.name,chips:p.chips,lastDelta:p.lastDelta||0}))
    }
  };
}
function broadcast(room){ [...room.players,...room.waiting].forEach(p=>{ if(p.id) io.to(p.id).emit('room',payload(room,p.token)); }); }

function transferHost(room, oldToken){
  if(room.host!==oldToken) return;
  const n=room.players.find(p=>p.id&&!p.bankrupt) || room.players.find(p=>!p.bankrupt) || room.players[0] || room.waiting.find(p=>p.id&&!p.bankrupt) || room.waiting[0];
  if(n){ room.host=n.token; n.ready=true; }
}
function replaceTokenRefs(room, oldToken, newToken){
  if(room.host===oldToken) room.host=newToken;
  const g=room.game;
  if(g.openDeniedToken===oldToken) g.openDeniedToken=newToken;
  if(g.vote){
    if(g.vote.init===oldToken) g.vote.init=newToken;
    g.vote.req=g.vote.req.map(t=>t===oldToken?newToken:t);
    if(g.vote.ok.has(oldToken)){ g.vote.ok.delete(oldToken); g.vote.ok.add(newToken); }
  }
  if(g.pendingCompare){
    if(g.pendingCompare.init===oldToken) g.pendingCompare.init=newToken;
    if(g.pendingCompare.target===oldToken) g.pendingCompare.target=newToken;
    g.pendingCompare.tokens=g.pendingCompare.tokens.map(t=>t===oldToken?newToken:t);
  }
  if(g.compareResult){
    if(g.compareResult.winner===oldToken) g.compareResult.winner=newToken;
    if(g.compareResult.loser===oldToken) g.compareResult.loser=newToken;
    g.compareResult.tokens=g.compareResult.tokens.map(t=>t===oldToken?newToken:t);
    g.compareResult.req=g.compareResult.req.map(t=>t===oldToken?newToken:t);
    if(g.compareResult.acks.has(oldToken)){ g.compareResult.acks.delete(oldToken); g.compareResult.acks.add(newToken); }
  }
  if(g.showdownResult){
    g.showdownResult.winners=g.showdownResult.winners.map(t=>t===oldToken?newToken:t);
    g.showdownResult.req=g.showdownResult.req.map(t=>t===oldToken?newToken:t);
    if(g.showdownResult.acks.has(oldToken)){ g.showdownResult.acks.delete(oldToken); g.showdownResult.acks.add(newToken); }
    g.showdownResult.details.forEach(d=>{ if(d.token===oldToken) d.token=newToken; });
  }
}

function finalizeShowdown(room){
  const sr=room.game.showdownResult;
  if(!sr) return false;
  const winners=sr.winners.map(t=>room.players.find(p=>p.token===t)).filter(Boolean);
  const text=sr.text;
  room.game.showdownResult=null;
  settle(room,winners,text,'showdown');
  return true;
}
function resolveShowdownVote(room){
  const v=room.game.vote;
  if(!v||!v.req.every(t=>v.ok.has(t))) return false;
  const a=activePlayers(room);
  a.forEach(p=>p.reveal=true);
  const q=showdown(room,a);
  room.game.vote=null;
  // 开牌一旦全员同意，直接进入统一结算界面，不再增加单独的“开牌结果确认”。
  settle(room,q.w,q.msg,'showdown');
  return true;
}

function removeTokenFromPendingStates(room,token){
  const g=room.game;
  if(g.vote){
    if(g.vote.init===token){
      g.vote=null;g.openDeniedToken=null;g.msg='开牌发起者已离开，申请取消';
    }else{
      g.vote.req=g.vote.req.filter(t=>t!==token);g.vote.ok.delete(token);
      resolveShowdownVote(room);
    }
  }
  if(g.compareResult){
    const cr=g.compareResult;
    cr.req=cr.req.filter(t=>t!==token);
    cr.acks.delete(token);
    if(cr.req.every(t=>cr.acks.has(t))){
      const loser=room.players.find(x=>x.token===cr.loser);
      if(loser){loser.out=true;loser.lastAction='比牌出局';}
      const actor=room.players[cr.idx];
      const actorStillCurrent=actor&&currentPlayer(room)?.token===actor.token;
      const detail=cr.text;
      g.compareResult=null;
      if(activePlayers(room).length===1) room.game.lastEndDetail=detail;
      if(!finishIfOne(room)&&actorStillCurrent) advance(room,cr.idx);
    }
  }
  if(g.showdownResult){
    g.showdownResult.req=g.showdownResult.req.filter(t=>t!==token);
    g.showdownResult.acks.delete(token);
    if(g.showdownResult.req.every(t=>g.showdownResult.acks.has(t))) finalizeShowdown(room);
  }
  if(room.settlement){
    room.settlement.req=room.settlement.req.filter(t=>t!==token);
    room.settlement.acks.delete(token);
    if(room.settlement.req.every(t=>room.settlement.acks.has(t))) finishSettlement(room);
  }
}
function finishSettlement(room){
  if(!room.settlement) return;
  room.settlement=null;
  room.status='waiting';
  room.game={pot:0,round:0,bet:0,idx:-1,acts:0,vote:null,pendingCompare:null,compareResult:null,showdownResult:null,openDeniedToken:null,msg:''};
  const keep=[], managedLeaving=[];
  for(const p of room.players){
    const wasManaged=!!p.managed;
    p.lastDelta=p.delta||0;p.bankrupt=p.chips<=0;
    p.inRound=false;p.folded=false;p.out=false;p.seen=false;p.cards=[];p.reveal=false;p.foldReveal=false;p.delta=0;p.lastAction='';
    if(wasManaged){managedLeaving.push(p.token);cancelTimer(p.token);continue;}
    if(p.bankrupt) room.waiting.push({...p,ready:false});
    else if(p.id){p.ready=p.token===room.host;keep.push(p);}
    else room.waiting.push({...p,ready:false});
  }
  room.players=keep;
  for(const t of managedLeaving){
    room.waiting=room.waiting.filter(x=>x.token!==t);
    if(room.host===t) transferHost(room,t);
  }
  while(room.waiting.length&&room.players.length<6){
    const i=room.waiting.findIndex(x=>!x.bankrupt&&x.id);
    if(i<0) break;
    const w=room.waiting.splice(i,1)[0];
    room.players.push({...w,seat:room.players.length+1,ready:w.token===room.host,bankrupt:false,inRound:false,folded:false,out:false,seen:false,cards:[],delta:0,reveal:false,foldReveal:false,lastAction:''});
  }
  reseat(room);
  if(!room.players.some(p=>p.token===room.host)) transferHost(room,room.host);
  broadcast(room);
}
function settle(room,winners,msg,endedBy='normal'){
  const share=Math.floor(room.game.pot/winners.length);let rem=room.game.pot-share*winners.length;
  winners.forEach(p=>{const gain=share+(rem>0?1:0);if(rem>0)rem--;p.chips+=gain;p.delta+=gain;});
  chooseNextAnchor(room,winners);
  const roundNo=room.handNo||1,winnerTokens=winners.map(p=>p.token);
  room.status='settlement';
  room.settlement={
    roundNo,result:msg,endedBy,winners:winnerTokens,
    req:room.players.filter(p=>p.id&&!p.managed).map(p=>p.token),acks:new Set(),
    players:room.players.filter(p=>p.inRound).map(p=>({
      token:p.token,name:p.name,seat:p.seat,cards:p.cards,lastAction:p.lastAction||'',
      delta:p.delta||0,winner:winnerTokens.includes(p.token),folded:!!p.folded,out:!!p.out,
      foldReveal:!!p.foldReveal,revealedAtEnd:!!p.reveal
    }))
  };
  room.game.msg=`第${roundNo}轮结算结果`;
  broadcast(room);
  if(room.settlement.req.length===0) finishSettlement(room);
}
function finishIfOne(room){
  const a=activePlayers(room);
  if(a.length===1){
    const detail=room.game.lastEndDetail||'';
    room.game.lastEndDetail=null;
    const msg=detail?`${detail}；${a[0].name} 获得底池`:`${a[0].name} 获得底池`;
    settle(room,[a[0]],msg,detail?'compare':'normal');
    return true;
  }
  return false;
}
function advance(room, from){
  if(finishIfOne(room)) return;
  const n=activePlayers(room).length;
  room.game.acts++;
  let newRound=false;
  if(room.game.acts>=n){ room.game.acts=0; room.game.round++; newRound=true; }
  room.game.openDeniedToken=null;
  room.game.idx=nextActiveIndex(room,from);
  if(newRound) room.game.msg=`第${room.game.round}圈开始`;
  processDisconnectedTurn(room);
}
function processDisconnectedTurn(room){
  let guard=0;
  while(room.status==='playing' && guard++<20){
    const p=currentPlayer(room);
    if(!p || p.id || !p.inRound || p.folded || p.out || locked(room)) break;
    const idx=room.game.idx;
    const base=BETS[room.game.bet];
    if(base<=40){
      const n=actionCost(room,p,'call');
      pay(room,p,n);
      p.lastAction=`系统自动${p.seen?'跟注':'盲跟'} ${n}`;
      room.game.msg=`${p.name}: ${p.lastAction}`;
      advance(room,idx);
    }else{
      p.folded=true;p.foldReveal=false;p.reveal=false;p.lastAction='系统自动暗弃';
      room.game.msg=`${p.name}: ${p.lastAction}`;
      advance(room,idx);
    }
    if(room.status!=='playing') break;
  }
}
function endRound(room){ finishSettlement(room); }

function showdown(room,ps){
  const es=ps.map(p=>({p,e:evalHand(p.cards)})), L=es.filter(x=>x.e.cat===6), T=es.filter(x=>x.e.is235), O=es.filter(x=>x.e.cat!==6&&!x.e.is235);
  if(L.length&&T.length&&O.length) return {w:ps,msg:'豹子、杂色235和其他牌型同时出现：平局'};
  if(ps.length===3&&T.length===2&&L.length===1) return {w:T.map(x=>x.p),msg:'两个杂色235对一个豹子：两个235平局'};
  let best=[ps[0]];
  for(let i=1;i<ps.length;i++){
    const c=compareHands(ps[i].cards,best[0].cards);
    if(c>0) best=[ps[i]]; else if(c===0) best.push(ps[i]);
  }
  return {w:best,msg:best.length>1?'开牌平局，平分底池':`${best[0].name} 开牌获胜`};
}

function kickOrExpirePlayer(room, token, {kicked=false}={}){
  const f=findByToken(room,token); if(!f) return;
  const p=f.p;
  cancelTimer(token);
  if(room.status==='playing' && f.list==='players' && p.inRound && !p.folded && !p.out){
    const currentToken=currentPlayer(room)?.token;
    const currentWas = currentToken===token;
    p.folded=true;
    if(currentWas){
      const idx=room.players.findIndex(x=>x.token===token);
      if(!finishIfOne(room)){
        room.game.idx=nextActiveIndex(room,idx);
        room.game.openDeniedToken=null;
        processDisconnectedTurn(room);
      }
    }else finishIfOne(room);
  }
  removeTokenFromPendingStates(room,token);
  const wasHost=room.host===token;
  room.players=room.players.filter(x=>x.token!==token);
  room.waiting=room.waiting.filter(x=>x.token!==token);
  if(!room.players.length&&!room.waiting.length){ delete rooms[room.id]; return; }
  if(wasHost) transferHost(room,token);
  reseat(room);
  if(room.status==='playing'){
    const ct=currentPlayer(room)?.token;
    if(ct){ const i=room.players.findIndex(x=>x.token===ct); room.game.idx=i; }
    processDisconnectedTurn(room);
  }
  broadcast(room);
}

function scheduleExpiry(room,p){
  cancelTimer(p.token);
  p.reconnectDeadline=Date.now()+RECONNECT_GRACE_MS;
  p.managed=false;
  const token=p.token;
  timers.set(token,setTimeout(()=>{
    timers.delete(token);
    const r=rooms[room.id]; if(!r) return;
    const f=findByToken(r,token); if(!f || f.p.id) return;
    const player=f.p;
    player.reconnectDeadline=0;

    if(r.status==='playing' && f.list==='players' && player.inRound){
      // 45秒仍未回来：整局进入托管。托管仍按下注档10/20/40自动跟，80/160自动弃。
      player.managed=true;
      r.game.msg=`${player.name}: 托管中`;
      if(r.game.vote&&r.game.vote.req.includes(token)){
        r.game.vote.ok.add(token);
        if(resolveShowdownVote(r)) return;
      }
      if(r.game.compareResult&&r.game.compareResult.req.includes(token)){
        r.game.compareResult.acks.add(token);
        const cr=r.game.compareResult;
        if(cr.req.every(t=>cr.acks.has(t))){
          const loser=r.players.find(x=>x.token===cr.loser);if(loser){loser.out=true;loser.lastAction='比牌出局';}
          const idx=cr.idx,detail=cr.text;r.game.compareResult=null;
          if(activePlayers(r).length===1) r.game.lastEndDetail=detail;
          if(!finishIfOne(r)){advance(r,idx);broadcast(r);}
          return;
        }
      }
      if(r.game.showdownResult&&r.game.showdownResult.req.includes(token)){
        r.game.showdownResult.acks.add(token);
        if(r.game.showdownResult.req.every(t=>r.game.showdownResult.acks.has(t))){finalizeShowdown(r);return;}
      }
      if(currentPlayer(r)?.token===token&&!player.folded&&!player.out&&!locked(r)) processDisconnectedTurn(r);
      broadcast(r);
      return;
    }

    // 非牌局阶段没有“本局”可托管，45秒后直接离开房间。
    kickOrExpirePlayer(r,token);
  },RECONNECT_GRACE_MS));
}

io.on('connection', socket=>{
  socket.on('createRoom',({name,token,code},cb=()=>{})=>{
    token=String(token||socket.id); const n=cleanName(name);
    const requested=String(code||'').trim();
    const c=/^\d{5}$/.test(requested)?requested:makeCode();
    if(rooms[c]) return cb({ok:false,msg:'房间号已存在'});
    const host={id:socket.id,token,name:n,seat:1,ready:true,chips:STARTING_CHIPS,lastDelta:0,bankrupt:false,cards:[],seen:false,inRound:false,folded:false,out:false,delta:0,reveal:false,foldReveal:false,lastAction:'',reconnectDeadline:0,managed:false};
    rooms[c]={id:c,host:token,status:'waiting',players:[host],waiting:[],settlement:null,nextStartAfterName:n,handNo:0,game:{pot:0,round:0,bet:0,idx:-1,acts:0,vote:null,pendingCompare:null,compareResult:null,showdownResult:null,openDeniedToken:null,msg:''}};
    socket.join(c); socket.data.room=c; socket.data.token=token; cb({ok:true,code:c}); broadcast(rooms[c]);
  });

  socket.on('joinRoom',({code,name,token},cb=()=>{})=>{
    const room=rooms[String(code||'').trim()]; if(!room) return cb({ok:false,msg:'房间不存在'});
    token=String(token||socket.id); const n=cleanName(name);

    // 同一标签页刷新：按token恢复
    let f=findByToken(room,token);
    if(f){
      if(f.p.managed) return cb({ok:false,msg:'该玩家已进入托管，本局结束后可重新加入'});
      cancelTimer(f.p.token); f.p.id=socket.id; f.p.reconnectDeadline=0; f.p.name=n;
      socket.join(room.id); socket.data.room=room.id; socket.data.token=f.p.token;
      // 如果之前在等待区且当前并非游戏中，尝试回到牌桌
      if(f.list==='waiting' && room.status==='waiting' && !f.p.bankrupt && room.players.length<6){
        room.waiting=room.waiting.filter(x=>x!==f.p); f.p.seat=room.players.length+1; f.p.ready=f.p.token===room.host; room.players.push(f.p);
      }
      cb({ok:true,resumed:true,waiting:room.waiting.some(p=>p.token===f.p.token)}); broadcast(room); return;
    }

    // 玩家名作为房间内账号：在线同名拒绝，离线同名继承
    const byName=findByName(room,n);
    if(byName){
      if(byName.p.id) return cb({ok:false,msg:'该玩家名已被占用'});
      if(byName.p.managed) return cb({ok:false,msg:'该玩家已进入托管，本局结束后可重新加入'});
      const oldToken=byName.p.token;
      cancelTimer(oldToken);
      replaceTokenRefs(room,oldToken,token);
      byName.p.token=token; byName.p.id=socket.id; byName.p.reconnectDeadline=0;
      socket.join(room.id); socket.data.room=room.id; socket.data.token=token;
      if(byName.list==='waiting' && room.status==='waiting' && !byName.p.bankrupt && room.players.length<6){
        room.waiting=room.waiting.filter(x=>x!==byName.p); byName.p.seat=room.players.length+1; byName.p.ready=byName.p.token===room.host; room.players.push(byName.p);
      }
      cb({ok:true,resumed:true,waiting:room.waiting.some(p=>p.token===token),inherited:true}); broadcast(room); return;
    }

    const p={id:socket.id,token,name:n,ready:false,chips:STARTING_CHIPS,lastDelta:0,bankrupt:false,cards:[],seen:false,inRound:false,folded:false,out:false,delta:0,reveal:false,foldReveal:false,lastAction:'',reconnectDeadline:0,managed:false};
    socket.join(room.id); socket.data.room=room.id; socket.data.token=token;
    if(room.status==='playing'){ room.waiting.push(p); cb({ok:true,waiting:true}); }
    else if(room.players.length>=6){ socket.leave(room.id); return cb({ok:false,msg:'牌桌已满'}); }
    else { p.seat=room.players.length+1; room.players.push(p); cb({ok:true,waiting:false}); }
    broadcast(room);
  });

  socket.on('toggleReady',(_,cb=()=>{})=>{
    const r=rooms[socket.data.room],p=r?.players.find(x=>x.token===socket.data.token);
    if(!r||!p) return cb({ok:false,msg:'不在牌桌'});
    if(p.token===r.host) return cb({ok:false,msg:'房主默认准备'});
    if(p.bankrupt) return cb({ok:false,msg:'你已破产'});
    p.ready=!p.ready; broadcast(r); cb({ok:true});
  });

  socket.on('startGame',(_,cb=()=>{})=>{
    const r=rooms[socket.data.room]; if(!r) return cb({ok:false,msg:'不在房间'});
    if(r.host!==socket.data.token) return cb({ok:false,msg:'只有房主可以开始'});
    if(r.status!=='waiting') return cb({ok:false,msg:'当前不能开始新牌局'});
    if(!allReady(r)) return cb({ok:false,msg:'至少2人且所有客机需准备'});
    const d=newDeck(); r.status='playing'; r.handNo=(r.handNo||0)+1;
    r.game={pot:0,round:1,bet:0,idx:-1,acts:0,vote:null,pendingCompare:null,compareResult:null,showdownResult:null,openDeniedToken:null,msg:''};
    for(const p of r.players){
      p.lastDelta=0;p.delta=0;p.folded=false;p.out=false;p.seen=false;p.reveal=false;p.foldReveal=false;p.lastAction='';
      p.bankrupt=p.chips<=0;
      p.inRound=!p.bankrupt&&p.chips>0&&p.ready;p.cards=[];
      if(p.inRound){ pay(r,p,ANTE); p.lastAction=`底注 ${ANTE}`; p.cards=[d.pop(),d.pop(),d.pop()]; }
    }
    let anchorIndex=r.players.findIndex(p=>p.name===r.nextStartAfterName);
    if(anchorIndex<0) anchorIndex=r.players.findIndex(p=>p.token===r.host);
    r.game.idx=nextActiveIndex(r,anchorIndex);
    r.game.msg=`第${r.game.round}圈开始`;
    processDisconnectedTurn(r); broadcast(r); cb({ok:true});
  });

  socket.on('viewCards',(_,cb=()=>{})=>{
    const r=rooms[socket.data.room],p=r?.players.find(x=>x.token===socket.data.token);
    if(!p||!p.inRound||p.folded||p.out) return cb({ok:false,msg:'不能看牌'});
    if(currentPlayer(r)?.token!==socket.data.token) return cb({ok:false,msg:'还没轮到你'});
    if(locked(r)) return cb({ok:false,msg:'请先处理当前确认流程'});
    p.seen=true; setAction(r,p,'看牌'); broadcast(r); cb({ok:true});
  });
  socket.on('callBet',(_,cb=()=>{})=>{
    const r=rooms[socket.data.room],p=r&&currentPlayer(r);
    if(!p||p.token!==socket.data.token) return cb({ok:false,msg:'还没轮到你'});
    if(locked(r)) return cb({ok:false,msg:'请先处理当前确认流程'});
    const n=actionCost(r,p,'call');
    const i=r.game.idx; pay(r,p,n); setAction(r,p,`${p.seen?'跟注':'盲跟'} ${n}`); advance(r,i); broadcast(r); cb({ok:true,cost:n});
  });
  socket.on('raiseBet',(_,cb=()=>{})=>{
    const r=rooms[socket.data.room],p=r&&currentPlayer(r);
    if(!p||p.token!==socket.data.token) return cb({ok:false,msg:'还没轮到你'});
    if(locked(r)) return cb({ok:false,msg:'请先处理当前确认流程'});
    if(r.game.bet>=BETS.length-1) return cb({ok:false,msg:'已到160'});
    const next=BETS[r.game.bet+1]; r.game.bet++; const n=actionCost(r,p,'call');
    const i=r.game.idx; pay(r,p,n); setAction(r,p,`加注到 ${next}，花费 ${n}`); advance(r,i); broadcast(r); cb({ok:true,cost:n,newLevel:next});
  });
  socket.on('fold',({reveal=false}={},cb=()=>{})=>{
    const r=rooms[socket.data.room],p=r&&currentPlayer(r);
    if(!p||p.token!==socket.data.token) return cb({ok:false,msg:'还没轮到你'});
    if(locked(r)) return cb({ok:false,msg:'请先处理当前确认流程'});
    const i=r.game.idx;
    if(reveal&&!p.seen) return cb({ok:false,msg:'未看牌不能明弃'});
    p.folded=true;p.foldReveal=!!reveal;p.reveal=!!reveal;
    setAction(r,p,p.reveal?'明弃':'暗弃');
    advance(r,i); broadcast(r); cb({ok:true});
  });

  socket.on('compare',({targetToken},cb=()=>{})=>{
    const r=rooms[socket.data.room],p=r&&currentPlayer(r);
    if(!p||p.token!==socket.data.token) return cb({ok:false,msg:'还没轮到你'});
    if(locked(r)) return cb({ok:false,msg:'请先处理当前确认流程'});
    if(r.game.round<3) return cb({ok:false,msg:'第3圈才允许比牌'});
    const t=r.players.find(x=>x.token===targetToken&&x.inRound&&!x.folded&&!x.out);
    if(!t||t.token===p.token) return cb({ok:false,msg:'无效对象'});
    const n=actionCost(r,p,'compare');
    pay(r,p,n);
    setAction(r,p,`与 ${t.name} 比牌，花费 ${n}`);
    const c=compareHands(p.cards,t.cards),winner=c>0?p:t,loser=c>0?t:p;
    loser.out=true;
    loser.lastAction='比牌出局';
    const detail=`${winner.name} 比牌胜出，${loser.name} 比牌落败`;
    r.game.msg=`比牌结果：${winner.name} 胜，${loser.name} 负`;

    // 如果这次比牌直接决出整局胜负，直接进入结算，不再出现单独比牌结果确认。
    if(activePlayers(r).length===1){
      settle(r,[winner],`${detail}；${winner.name} 获得底池`,'compare');
      return cb({ok:true,cost:n,settled:true});
    }

    // 未决出整局胜负时，仍保留比牌结果确认，避免玩家错过中途比牌结果。
    const autoAcks=new Set();
    if(!p.id||p.managed) autoAcks.add(p.token);
    if(!t.id||t.managed) autoAcks.add(t.token);
    r.game.compareResult={
      tokens:[p.token,t.token],req:[p.token,t.token],acks:autoAcks,
      winner:winner.token,loser:loser.token,text:detail,idx:r.game.idx,
      views:[
        {token:p.token,cards:p.cards,seen:!!p.seen,won:winner.token===p.token},
        {token:t.token,cards:t.cards,seen:!!t.seen,won:winner.token===t.token}
      ]
    };
    if(r.game.compareResult.req.every(x=>r.game.compareResult.acks.has(x))){
      const idx=r.game.idx;r.game.compareResult=null;advance(r,idx);broadcast(r);
    }else broadcast(r);
    cb({ok:true,cost:n});
  });
  socket.on('ackCompare',(_,cb=()=>{})=>{
    const r=rooms[socket.data.room],cr=r?.game.compareResult;
    if(!r||!cr) return cb({ok:false,msg:'当前没有待确认的比牌结果'});
    if(!cr.req.includes(socket.data.token)) return cb({ok:false,msg:'你无需确认'});
    cr.acks.add(socket.data.token);
    if(cr.req.every(t=>cr.acks.has(t))){
      const idx=cr.idx;r.game.compareResult=null;
      advance(r,idx);broadcast(r);
      return cb({ok:true,done:true});
    }
    broadcast(r);cb({ok:true});
  });

  socket.on('requestShowdown',(_,cb=()=>{})=>{
    const r=rooms[socket.data.room]; if(!r) return cb({ok:false,msg:'不在牌局'});
    if(currentPlayer(r)?.token!==socket.data.token) return cb({ok:false,msg:'只有轮到自己时才能申请开牌'});
    if(locked(r)) return cb({ok:false,msg:'请先处理当前确认流程'});
    if(r.game.openDeniedToken===socket.data.token) return cb({ok:false,msg:'本回合开牌申请已被拒绝，需执行其他操作后等待下次轮到你'});
    const a=activePlayers(r); if(a.length<2||a.length>3) return cb({ok:false,msg:'只剩2~3人时才能开牌'});
    if(!a.some(p=>p.token===socket.data.token)) return cb({ok:false,msg:'你已出局'});
    const autoOk=a.filter(p=>p.managed).map(p=>p.token);
    r.game.vote={init:socket.data.token,ok:new Set([socket.data.token,...autoOk]),req:a.map(p=>p.token)};
    setAction(r,a.find(p=>p.token===socket.data.token),'申请开牌');
    if(!resolveShowdownVote(r)) broadcast(r);
    cb({ok:true});
  });
  socket.on('voteShowdown',({agree},cb=()=>{})=>{
    const r=rooms[socket.data.room],v=r?.game.vote; if(!v) return cb({ok:false,msg:'没有投票'});
    if(!v.req.includes(socket.data.token)) return cb({ok:false,msg:'无需投票'});
    if(!agree){ const init=v.init; r.game.vote=null; r.game.openDeniedToken=init; r.game.msg='开牌申请被拒绝，发起者本回合不能再次申请'; broadcast(r); return cb({ok:true,rejected:true}); }
    v.ok.add(socket.data.token);
    const opened=resolveShowdownVote(r);
    if(!opened) broadcast(r);
    cb({ok:true,opened});
  });
  socket.on('ackShowdown',(_,cb=()=>{})=>{
    const r=rooms[socket.data.room],sr=r?.game.showdownResult;if(!r||!sr)return cb({ok:false,msg:'当前没有开牌结果'});
    if(!sr.req.includes(socket.data.token))return cb({ok:false,msg:'你无需确认'});
    sr.acks.add(socket.data.token);
    if(sr.req.every(t=>sr.acks.has(t))){finalizeShowdown(r);return cb({ok:true,done:true});}
    broadcast(r);cb({ok:true});
  });

  socket.on('ackSettlement',(_,cb=()=>{})=>{
    const r=rooms[socket.data.room],st=r?.settlement;
    if(!r||!st)return cb({ok:false,msg:'当前没有结算界面'});
    if(st.req.includes(socket.data.token))st.acks.add(socket.data.token);
    if(st.req.every(t=>st.acks.has(t))){finishSettlement(r);return cb({ok:true,done:true});}
    broadcast(r);cb({ok:true});
  });

  socket.on('kickPlayer',({targetToken},cb=()=>{})=>{
    const r=rooms[socket.data.room]; if(!r||r.host!==socket.data.token) return cb({ok:false,msg:'只有房主可以踢人'});
    if(targetToken===socket.data.token) return cb({ok:false,msg:'不能踢自己'});
    const f=findByToken(r,targetToken); if(!f) return cb({ok:false,msg:'玩家不存在'});
    if(f.p.id){ const ts=io.sockets.sockets.get(f.p.id); if(ts){ ts.emit('kicked',{msg:'你已被房主移出房间'}); ts.leave(r.id); ts.data.room=null; ts.data.token=null; } }
    kickOrExpirePlayer(r,targetToken,{kicked:true}); cb({ok:true});
  });
  socket.on('leaveRoom',(_,cb=()=>{})=>{
    const r=rooms[socket.data.room]; if(r) kickOrExpirePlayer(r,socket.data.token); socket.leave(socket.data.room||''); socket.data.room=null; socket.data.token=null; cb({ok:true});
  });
  socket.on('disconnect',()=>{
    const r=rooms[socket.data.room],t=socket.data.token; if(!r||!t) return;
    const f=findByToken(r,t); if(!f) return;
    f.p.id=null; f.p.reconnectDeadline=Date.now()+RECONNECT_GRACE_MS;
    if(r.settlement&&r.settlement.req.includes(t)){
      r.settlement.acks.add(t);
      if(r.settlement.req.every(x=>r.settlement.acks.has(x))) finishSettlement(r);
    }
    broadcast(r);
    // 当前行动者断线时立即按下注档位自动处理，不等待45秒；45秒后仍未回来则转为托管
    if(r.status==='playing' && f.list==='players' && f.p.inRound && !f.p.folded && !f.p.out && currentPlayer(r)?.token===t && !locked(r)) processDisconnectedTurn(r);
    scheduleExpiry(r,f.p); broadcast(r);
  });
});

httpServer.listen(3001,()=>console.log('V4.4.4 server running on http://0.0.0.0:3001'));
