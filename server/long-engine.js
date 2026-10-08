
import crypto from 'crypto';
import { Server } from 'socket.io';

let io;
const rooms={};

const START_CHIPS=1500;
const MAX_SEATED=6;
const RECONNECT_MS=45000;
const DEAL_CARD_MS=450;
const DEAL_STREET_MS=1200;
const BLIND_LEVELS=[10,15,20,25,30,40,50,60,75,100,125,150];

const suits=['S','H','D','C'];
const ranks=['2','3','4','5','6','7','8','9','T','J','Q','K','A'];

const clone=x=>JSON.parse(JSON.stringify(x));
function makeDeck(){
  const d=[]; for(const s of suits)for(const r of ranks)d.push(r+s);
  for(let i=d.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[d[i],d[j]]=[d[j],d[i]]}
  return d;
}
function genRoomId(){let id='';do{id=String(Math.floor(10000+Math.random()*90000))}while(rooms[id]);return id}
function genToken(){return crypto.randomUUID()}
function blindForHand(handNo){
  const h=Math.max(1,handNo),level=Math.min(Math.floor((h-1)/3),BLIND_LEVELS.length-1);
  const sb=BLIND_LEVELS[level],bb=sb*2,maxed=level===BLIND_LEVELS.length-1;
  return {level,sb,bb,handsToNext:maxed?0:3-((h-1)%3),nextSB:BLIND_LEVELS[Math.min(level+1,BLIND_LEVELS.length-1)],nextBB:BLIND_LEVELS[Math.min(level+1,BLIND_LEVELS.length-1)]*2,maxed};
}
function allMembers(r){return [...r.players,...r.waiting,...r.bankrupt]}
function findMember(r,token){return allMembers(r).find(p=>p.token===token)}
function findByName(r,name){return allMembers(r).find(p=>p.name===name)}
function roomOf(socket){return rooms[socket.data.room]}
function seatedSorted(r){return [...r.players].sort((a,b)=>a.seat-b.seat)}
function nextFreeSeat(r){const used=new Set(r.players.map(p=>p.seat));for(let i=0;i<MAX_SEATED;i++)if(!used.has(i))return i;return MAX_SEATED}
function compactSeatedPlayers(r,before=null){
  // 座位采用连续编号：有人在非游戏阶段离开后，后面的玩家依次前移；新加入者排到末位。
  const old=before||seatedSorted(r);
  const oldDealerSeat=r.dealerSeat;
  const oldDealer=oldDealerSeat==null?null:old.find(p=>p.seat===oldDealerSeat);
  const remaining=new Set(r.players.map(p=>p.token));
  let nextDealerToken=null;
  if(oldDealerSeat!=null && (!oldDealer || !remaining.has(oldDealer.token)) && r.players.length){
    const ordered=[...old].sort((a,b)=>a.seat-b.seat);
    const after=ordered.filter(p=>p.seat>oldDealerSeat).concat(ordered.filter(p=>p.seat<=oldDealerSeat));
    nextDealerToken=after.find(p=>remaining.has(p.token))?.token||null;
  }
  r.players=seatedSorted(r);
  r.players.forEach((p,i)=>{p.seat=i});
  if(oldDealerSeat!=null){
    if(oldDealer && remaining.has(oldDealer.token)){
      r.dealerSeat=r.players.find(p=>p.token===oldDealer.token)?.seat??null;
    }else if(nextDealerToken){
      const next=r.players.find(p=>p.token===nextDealerToken);
      r.dealerSeat=next?(next.seat===0?r.players.length-1:next.seat-1):null;
    }else if(!r.players.length){
      r.dealerSeat=null;
    }
  }
}
function nextSeated(r,seat,pred=()=>true){
  const ps=seatedSorted(r); if(!ps.length)return null;
  let idx=ps.findIndex(p=>p.seat===seat); if(idx<0)idx=-1;
  for(let k=1;k<=ps.length;k++){const p=ps[(idx+k)%ps.length];if(pred(p))return p}
  return null;
}
function active(r){return r.players.filter(p=>p.inHand&&!p.folded)}
function actors(r){return r.players.filter(p=>p.inHand&&!p.folded&&!p.allIn)}
function currentPlayer(r){return r.players.find(p=>p.token===r.game?.currentToken)}
function syncAccount(r,p){
  if(!r.accounts[p.name])r.accounts[p.name]={name:p.name,token:p.token,chips:p.chips,lastDelta:p.lastDelta||0,bankruptAt:null,joinedAt:Date.now()};
  const a=r.accounts[p.name];a.token=p.token;a.chips=p.chips;a.lastDelta=p.lastDelta||0;
  if(p.chips<=0 && !a.bankruptAt)a.bankruptAt=Date.now();
  if(p.chips>0)a.bankruptAt=null;
}
function syncAll(r){for(const p of allMembers(r))syncAccount(r,p)}
function pay(p,n){
  const paid=Math.min(p.chips,Math.max(0,Number(n)||0));
  p.chips-=paid;p.streetBet+=paid;p.totalBet+=paid;if(p.chips===0)p.allIn=true;
  return paid;
}
function addAction(r,p,text){p.lastAction=text;r.game.message=`${p.name}：${text}`}
function callNeed(r,p){return Math.max(0,r.game.currentBet-p.streetBet)}

const RV={2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,T:10,J:11,Q:12,K:13,A:14};
const HAND_NAMES=['高牌','一对','两对','三条','顺子','同花','葫芦','四条','同花顺'];
function cmpVal(a,b){for(let i=0;i<Math.max(a.length,b.length);i++){const x=a[i]||0,y=b[i]||0;if(x!==y)return x-y}return 0}
function handValue(cards){
  const vals=cards.map(c=>RV[c[0]]).sort((a,b)=>b-a),ss=cards.map(c=>c[1]),count={};
  vals.forEach(v=>count[v]=(count[v]||0)+1);
  let uniq=[...new Set(vals)].sort((a,b)=>b-a);if(uniq.includes(14))uniq.push(1);
  let straight=0;for(let i=0;i<=uniq.length-5;i++)if(uniq[i]-uniq[i+4]===4){straight=uniq[i];break}
  const flush=ss.every(s=>s===ss[0]);
  const groups=Object.entries(count).map(([v,n])=>[n,+v]).sort((a,b)=>b[0]-a[0]||b[1]-a[1]);
  if(flush&&straight)return [8,straight];
  if(groups[0][0]===4)return [7,groups[0][1],groups[1][1]];
  if(groups[0][0]===3&&groups[1]?.[0]===2)return [6,groups[0][1],groups[1][1]];
  if(flush)return [5,...vals];
  if(straight)return [4,straight];
  if(groups[0][0]===3)return [3,groups[0][1],...groups.filter(g=>g[0]===1).map(g=>g[1]).sort((a,b)=>b-a)];
  if(groups[0][0]===2&&groups[1]?.[0]===2){const ps=[groups[0][1],groups[1][1]].sort((a,b)=>b-a);return [2,...ps,groups.find(g=>g[0]===1)?.[1]||0]}
  if(groups[0][0]===2)return [1,groups[0][1],...groups.filter(g=>g[0]===1).map(g=>g[1]).sort((a,b)=>b-a)];
  return [0,...vals];
}
function best7(cards){
  let best=null,best5=null;
  for(let a=0;a<cards.length-4;a++)for(let b=a+1;b<cards.length-3;b++)for(let c=b+1;c<cards.length-2;c++)for(let d=c+1;d<cards.length-1;d++)for(let e=d+1;e<cards.length;e++){
    const five=[cards[a],cards[b],cards[c],cards[d],cards[e]],v=handValue(five);
    if(!best||cmpVal(v,best)>0){best=v;best5=five}
  }
  return {v:best,cards:best5};
}
function handInfo(p,board){const b=best7([...p.cards,...board]);return {best:b.cards,rank:b.v[0],name:HAND_NAMES[b.v[0]]}}
function buildSidePots(r){
  const c=r.players.filter(p=>p.totalBet>0).map(p=>({p,amt:p.totalBet}));
  const levels=[...new Set(c.map(x=>x.amt))].sort((a,b)=>a-b);let prev=0;const pots=[];
  for(const lev of levels){
    const group=c.filter(x=>x.amt>=lev),amount=(lev-prev)*group.length;
    if(amount>0)pots.push({amount,eligible:group.map(x=>x.p).filter(p=>!p.folded)});
    prev=lev;
  }
  return pots;
}
function moveBankruptNow(r){
  const before=seatedSorted(r);
  const busted=r.players.filter(p=>p.chips<=0);
  if(!busted.length)return;
  for(const p of busted){
    p.seat=null;p.ready=false;p.inHand=false;
    if(!p.bankruptAt)p.bankruptAt=Date.now();
    r.bankrupt.push(p);syncAccount(r,p);
  }
  r.players=r.players.filter(p=>p.chips>0);
  compactSeatedPlayers(r,before);
  if(!r.players.some(p=>p.token===r.host)){
    const nh=r.players[0]||r.waiting[0];
    if(nh)r.host=nh.token;
  }
}
function promoteWaiting(r){
  while(r.players.length<MAX_SEATED && r.waiting.length){
    const p=r.waiting.shift();p.seat=nextFreeSeat(r);p.ready=p.token===r.host;p.inHand=false;p.wasInHand=false;p.folded=false;p.allIn=false;r.players.push(p);
  }
}
function prepareSettlement(r,reason,pots,revealTokens,winnerTokens,endedBy){
  const participants=[...r.players,...r.bankrupt].filter(p=>p.wasInHand);
  for(const p of participants){p.lastDelta=p.chips-(p.handStartChips??p.chips);syncAccount(r,p)}
  // 本局 ALL-IN 后破产的玩家仍属于本局参与者，需要确认本局结算。
  // 等他本人确认后再立即移入破产区。
  const required=participants.filter(p=>p.id&&!p.managed&&!p.kicked).map(p=>p.token);
  const players=participants.map(p=>{
    const info=r.game.board.length===5&&!p.folded?handInfo(p,r.game.board):null;
    return {token:p.token,name:p.name,seat:p.seat,cards:[...p.cards],folded:!!p.folded,allIn:!!p.allIn,chips:p.chips,lastDelta:p.lastDelta||0,lastAction:p.lastAction||'',best:info?.best||[],handName:info?.name||'',winner:winnerTokens.includes(p.token)};
  });
  r.status='settlement';r.game.currentToken=null;
  r.settlement={handNo:r.handNo,reason,pots,board:[...r.game.board],players,revealedTokens:[...revealTokens],winnerTokens:[...winnerTokens],endedBy,required,acks:new Set()};
  r.lastResult=clone({...r.settlement,acks:[],required:[]});
  r.game.message=`第${r.handNo}局结算`;
  syncAll(r);broadcast(r);maybeFinishSettlement(r);
}
function finishSettlement(r){
  r.players=r.players.filter(p=>!p.managed&&!p.kicked);
  r.waiting=r.waiting.filter(p=>!p.managed&&!p.kicked);
  r.bankrupt=r.bankrupt.filter(p=>!p.managed&&!p.kicked);
  // 防止掉线/托管等无需确认的破产玩家残留在正式座位。
  moveBankruptNow(r);
  promoteWaiting(r);
  for(const p of r.players){
    p.ready=p.token===r.host;p.inHand=false;p.wasInHand=false;p.folded=false;p.allIn=false;p.cards=[];p.streetBet=0;p.totalBet=0;p.acted=false;p.lastAction='';
  }
  for(const p of r.waiting){p.wasInHand=false;p.inHand=false}
  for(const p of r.bankrupt){p.wasInHand=false;p.inHand=false}
  r.status='waiting';r.settlement=null;r.game={message:'等待开始'};syncAll(r);broadcast(r);
}
function moveBustedAfterAck(r,token){
  const before=seatedSorted(r);
  const p=r.players.find(x=>x.token===token);
  if(!p||p.chips>0)return;
  r.players=r.players.filter(x=>x.token!==token);
  compactSeatedPlayers(r,before);
  p.seat=null;p.ready=false;p.inHand=false;
  if(!p.bankruptAt)p.bankruptAt=Date.now();
  if(!r.bankrupt.some(x=>x.token===p.token))r.bankrupt.push(p);
  syncAccount(r,p);
  if(r.host===p.token){
    const nh=r.players[0]||r.waiting[0]||r.bankrupt.find(x=>x.token!==p.token);
    if(nh)r.host=nh.token;
  }
}
function maybeFinishSettlement(r){const s=r.settlement;if(s&&s.required.every(t=>s.acks.has(t)))finishSettlement(r)}
function awardShowdown(r,reason){
  const pots=buildSidePots(r),results=[],allWinners=new Set();
  for(const pot of pots){
    if(!pot.eligible.length)continue;
    let winners=[],best=null;
    for(const p of pot.eligible){
      const h=best7([...p.cards,...r.game.board]);
      if(!best||cmpVal(h.v,best)>0){best=h.v;winners=[p]}else if(cmpVal(h.v,best)===0)winners.push(p);
    }
    const share=Math.floor(pot.amount/winners.length);let rem=pot.amount-share*winners.length;
    winners.sort((a,b)=>a.seat-b.seat).forEach(p=>{p.chips+=share+(rem>0?1:0);if(rem>0)rem--;allWinners.add(p.token)});
    results.push({amount:pot.amount,winners:winners.map(p=>p.name)});
  }
  const reveal=active(r).map(p=>p.token);
  prepareSettlement(r,reason,results,reveal,[...allWinners],'showdown');
}
function askFoldWinnerReveal(r,winner){
  const pot=r.players.reduce((s,p)=>s+p.totalBet,0);
  winner.chips+=pot;
  r.status='winnerReveal';r.pendingReveal={winnerToken:winner.token,pot,reason:'其余玩家弃牌'};
  r.game.currentToken=null;r.game.message=`${winner.name} 获胜，等待选择是否亮牌`;
  if(!winner.id||winner.managed){
    setTimeout(()=>{const rr=rooms[r.id];if(rr?.status==='winnerReveal'&&rr.pendingReveal?.winnerToken===winner.token)resolveFoldReveal(rr,false)},300);
  }
  broadcast(r);
}
function resolveFoldReveal(r,show){
  const pr=r.pendingReveal;if(!pr)return;
  const w=allMembers(r).find(p=>p.token===pr.winnerToken);
  const pots=[{amount:pr.pot,winners:[w.name]}];
  r.pendingReveal=null;
  prepareSettlement(r,pr.reason,pots,show?[w.token]:[],[w.token],'fold');
}
function bettingComplete(r){
  const aa=actors(r);if(!aa.length)return true;
  return aa.every(p=>p.acted&&p.streetBet===r.game.currentBet);
}
function dealCardsAnimated(r,cards,streetName,after){
  r.game.dealing=true;r.game.currentToken=null;r.game.street=streetName;r.game.message='发牌中';broadcast(r);
  let i=0;
  const step=()=>{
    if(!rooms[r.id]||r.status!=='playing')return;
    if(i<cards){
      r.game.board.push(r.game.deck.pop());i++;broadcast(r);
      if(i<cards)setTimeout(step,DEAL_CARD_MS);
      else setTimeout(()=>{r.game.dealing=false;after?.()},DEAL_STREET_MS);
    }
  };
  step();
}
function startStreetAction(r){
  r.players.forEach(p=>{p.streetBet=0;p.acted=false});
  r.game.currentBet=0;r.game.minRaise=r.game.bb;
  const aa=actors(r);
  if(aa.length<=1 && active(r).length>1)return continueAllInRunout(r);
  if(!aa.length)return continueAllInRunout(r);
  const first=nextSeated(r,r.game.dealerSeat,p=>p.inHand&&!p.folded&&!p.allIn);
  if(!first)return continueAllInRunout(r);
  r.game.currentToken=first.token;r.game.message=`${streetCN(r.game.street)}开始`;broadcast(r);maybeAuto(r);
}
function nextStreet(r){
  if(active(r).length===1)return askFoldWinnerReveal(r,active(r)[0]);
  if(r.game.street==='preflop')dealCardsAnimated(r,3,'flop',()=>startStreetAction(r));
  else if(r.game.street==='flop')dealCardsAnimated(r,1,'turn',()=>startStreetAction(r));
  else if(r.game.street==='turn')dealCardsAnimated(r,1,'river',()=>startStreetAction(r));
  else awardShowdown(r,'河牌后摊牌');
}
function continueAllInRunout(r){
  if(active(r).length===1)return askFoldWinnerReveal(r,active(r)[0]);
  if(r.game.street==='preflop')dealCardsAnimated(r,3,'flop',()=>continueAllInRunout(r));
  else if(r.game.street==='flop')dealCardsAnimated(r,1,'turn',()=>continueAllInRunout(r));
  else if(r.game.street==='turn')dealCardsAnimated(r,1,'river',()=>continueAllInRunout(r));
  else awardShowdown(r,'ALL-IN 后摊牌');
}
function streetCN(s){return ({preflop:'翻牌前',flop:'翻牌',turn:'转牌',river:'河牌'})[s]||''}
function advance(r,fromSeat){
  if(active(r).length===1)return askFoldWinnerReveal(r,active(r)[0]);
  if(bettingComplete(r))return nextStreet(r);
  const nx=nextSeated(r,fromSeat,p=>p.inHand&&!p.folded&&!p.allIn&&(!p.acted||p.streetBet!==r.game.currentBet));
  if(!nx)return nextStreet(r);
  r.game.currentToken=nx.token;broadcast(r);maybeAuto(r);
}
function doAction(r,p,type,amount,{auto=false}={}){
  if(r.status!=='playing'||r.game.dealing)return {ok:false,msg:'当前不能操作'};
  if(r.game.currentToken!==p.token)return {ok:false,msg:'还没轮到你'};
  const from=p.seat,need=callNeed(r,p);
  if(type==='fold'){p.folded=true;p.acted=true;addAction(r,p,auto?'托管弃牌':'弃牌')}
  else if(type==='check'){if(need)return {ok:false,msg:'当前不能过牌'};p.acted=true;addAction(r,p,auto?'托管过牌':'过牌')}
  else if(type==='call'){if(need<=0)return {ok:false,msg:'无需跟注'};const x=pay(p,need);p.acted=true;addAction(r,p,p.allIn?`ALL-IN ${x}`:`跟注 ${x}`)}
  else if(type==='raise'){
    if(need>=p.chips)return {ok:false,msg:'当前筹码只能选择 ALL-IN 跟注，不能加注'};
    let target=Number(amount);if(!Number.isFinite(target))return {ok:false,msg:'金额无效'};
    const max=p.streetBet+p.chips;target=Math.min(target,max);if(target<=p.streetBet)return {ok:false,msg:'金额无效'};
    const old=r.game.currentBet;
    if(target<=old){
      if(target!==max)return {ok:false,msg:'加注必须高于当前下注'};
      const x=pay(p,target-p.streetBet);p.acted=true;addAction(r,p,`ALL-IN ${x}`);
    }else{
      const inc=target-old,isAll=target===max;if(!isAll&&inc<r.game.minRaise)return {ok:false,msg:`最小加注到 ${old+r.game.minRaise}`};
      pay(p,target-p.streetBet);if(inc>=r.game.minRaise){r.game.minRaise=inc;for(const x of actors(r))if(x.token!==p.token)x.acted=false}
      r.game.currentBet=target;p.acted=true;addAction(r,p,p.allIn?`ALL-IN 到 ${target}`:`加注到 ${target}`);
    }
  }else return {ok:false,msg:'未知操作'};
  syncAccount(r,p);advance(r,from);return {ok:true};
}
function autoChoice(r,p){const need=callNeed(r,p);if(need===0)return 'check';if(need<=r.game.bb*2||need>=p.chips)return 'call';return 'fold'}
function maybeAuto(r){
  if(r.status!=='playing'||r.game.dealing)return;
  const p=currentPlayer(r);if(!p||p.id&&!p.managed)return;
  setTimeout(()=>{const rr=rooms[r.id],cp=rr&&currentPlayer(rr);if(!rr||rr.status!=='playing'||rr.game.dealing||!cp||cp.token!==p.token)return;doAction(rr,cp,autoChoice(rr,cp),undefined,{auto:true})},250);
}
function startHand(r){
  const entrants=r.players.filter(p=>p.chips>0&&(p.token===r.host||p.ready));
  if(entrants.length<2)return {ok:false,msg:'至少需要2名已准备玩家'};
  r.handNo++;const bi=blindForHand(r.handNo);r.status='playing';r.settlement=null;r.pendingReveal=null;
  for(const p of r.players){
    const on=entrants.includes(p);p.inHand=on;p.wasInHand=on;p.folded=false;p.allIn=false;p.cards=[];p.streetBet=0;p.totalBet=0;p.acted=false;p.lastAction='';if(on)p.handStartChips=p.chips;
  }
  let dealer=r.dealerSeat==null?[...entrants].sort((a,b)=>a.seat-b.seat)[0]:nextSeated(r,r.dealerSeat,p=>entrants.includes(p));
  r.dealerSeat=dealer.seat;
  let sbP,bbP;if(entrants.length===2){sbP=dealer;bbP=nextSeated(r,sbP.seat,p=>entrants.includes(p))}else{sbP=nextSeated(r,dealer.seat,p=>entrants.includes(p));bbP=nextSeated(r,sbP.seat,p=>entrants.includes(p))}
  const deck=makeDeck();
  for(let round=0;round<2;round++){let seat=dealer.seat;for(let i=0;i<entrants.length;i++){const p=nextSeated(r,seat,x=>entrants.includes(x));p.cards.push(deck.pop());seat=p.seat}}
  r.game={deck,board:[],street:'preflop',dealerSeat:dealer.seat,sbSeat:sbP.seat,bbSeat:bbP.seat,sb:bi.sb,bb:bi.bb,currentBet:0,minRaise:bi.bb,currentToken:null,message:'发牌',dealing:false};
  pay(sbP,bi.sb);pay(bbP,bi.bb);sbP.lastAction=`小盲 ${sbP.streetBet}`;bbP.lastAction=`大盲 ${bbP.streetBet}`;r.game.currentBet=Math.max(sbP.streetBet,bbP.streetBet);
  const first=nextSeated(r,bbP.seat,p=>p.inHand&&!p.folded&&!p.allIn);r.game.currentToken=first?.token||null;
  broadcast(r);if(first)maybeAuto(r);else continueAllInRunout(r);return {ok:true};
}
function removeActiveReference(r,p){
  const before=seatedSorted(r),wasSeated=r.players.some(x=>x.token===p.token);
  r.players=r.players.filter(x=>x.token!==p.token);r.waiting=r.waiting.filter(x=>x.token!==p.token);r.bankrupt=r.bankrupt.filter(x=>x.token!==p.token);
  if(wasSeated)compactSeatedPlayers(r,before);
  if(r.host===p.token){
    const nh=r.players[0]||r.waiting[0]||r.bankrupt[0];
    if(nh)r.host=nh.token;
  }
}
function createPlayerFromAccount(r,name,id){
  let a=r.accounts[name];
  if(!a){a=r.accounts[name]={name,token:genToken(),chips:START_CHIPS,lastDelta:0,bankruptAt:null,joinedAt:Date.now()}}
  return {token:a.token,name,id,seat:null,chips:a.chips,lastDelta:a.lastDelta||0,bankruptAt:a.bankruptAt||null,ready:false,connected:true,managed:false,kicked:false,reconnectDeadline:0,inHand:false,wasInHand:false,folded:false,allIn:false,cards:[],streetBet:0,totalBet:0,acted:false,lastAction:''};
}
function reconnect(r,p,socket){p.id=socket.id;p.connected=true;p.reconnectDeadline=0;socket.data={room:r.id,token:p.token};socket.join(r.id)}
function scheduleDisconnect(r,p){
  p.reconnectDeadline=Date.now()+RECONNECT_MS;
  setTimeout(()=>{const rr=rooms[r.id],pp=rr&&findMember(rr,p.token);if(!pp||pp.id||pp.reconnectDeadline>Date.now())return;if(rr.status==='playing'&&pp.inHand){pp.managed=true;if(rr.game.currentToken===pp.token)maybeAuto(rr)}else{removeActiveReference(rr,pp)}broadcast(rr)},RECONNECT_MS+100);
}
function rankingPayload(r){
  const vals=Object.values(r.accounts);
  const active=vals.filter(a=>a.chips>0).sort((a,b)=>b.chips-a.chips);
  const busted=vals.filter(a=>a.chips<=0).sort((a,b)=>(a.bankruptAt||0)-(b.bankruptAt||0));
  return {active:active.map((a,i)=>({rank:i+1,name:a.name,chips:a.chips,lastDelta:a.lastDelta||0})),bankrupt:busted.map(a=>({name:a.name,chips:a.chips,lastDelta:a.lastDelta||0,bankruptAt:a.bankruptAt||0}))};
}
function resultForViewer(result,viewer){
  if(!result)return null;
  return {...result,players:result.players.map(p=>({...p,cardMode:p.token===viewer||result.revealedTokens.includes(p.token)?'face':'back'}))};
}
function payload(r,viewer){
  const b=blindForHand(r.status==='waiting'?r.handNo+1:r.handNo);
  return {
    id:r.id,status:r.status,hostToken:r.host,handNo:r.handNo,blind:b,
    allReady:r.players.filter(p=>p.chips>0).every(p=>p.token===r.host||p.ready),
    players:seatedSorted(r).map(p=>({token:p.token,name:p.name,seat:p.seat,chips:p.chips,lastDelta:p.lastDelta||0,ready:p.token===r.host?true:!!p.ready,connected:!!p.id,managed:!!p.managed,inHand:!!p.inHand,folded:!!p.folded,allIn:!!p.allIn,streetBet:p.streetBet||0,totalBet:p.totalBet||0,lastAction:p.lastAction||'',cards:r.status==='playing'?(p.inHand?(p.token===viewer?p.cards:['back','back']):[]):[]})),
    waiting:r.waiting.map(p=>({token:p.token,name:p.name,chips:p.chips,lastDelta:p.lastDelta||0,connected:!!p.id,ready:false})),
    bankrupt:r.bankrupt.map(p=>({token:p.token,name:p.name,chips:p.chips,lastDelta:p.lastDelta||0,connected:!!p.id,bankruptAt:p.bankruptAt||0})),
    game:(r.status==='playing'||r.status==='winnerReveal')?{street:r.game.street,board:r.game.board,currentBet:r.game.currentBet,minRaise:r.game.minRaise,currentToken:r.game.currentToken,dealerSeat:r.game.dealerSeat,sbSeat:r.game.sbSeat,bbSeat:r.game.bbSeat,sb:r.game.sb,bb:r.game.bb,pot:r.players.reduce((s,p)=>s+p.totalBet,0),message:r.game.message||'',dealing:!!r.game.dealing}:null,
    pendingReveal:r.status==='winnerReveal'&&r.pendingReveal?{winnerToken:r.pendingReveal.winnerToken,reason:r.pendingReveal.reason}:null,
    settlement:r.settlement?resultForViewer({...r.settlement,acks:[...r.settlement.acks]},viewer):null,
    lastResult:resultForViewer(r.lastResult,viewer),
    ranking:rankingPayload(r)
  };
}
function broadcast(r){syncAll(r);for(const p of allMembers(r))if(p.id)io.to(p.id).emit('room',payload(r,p.token))}

export function attachLong(httpServer){
  io=new Server(httpServer,{path:'/socket.io/long',cors:{origin:'*'}});
  io.on('connection',socket=>{
  socket.on('createRoom',({name,roomId},cb=()=>{})=>{
    name=(name||'').trim();if(!name)return cb({ok:false,msg:'请输入昵称'});
    const requested=String(roomId||'').trim();
    const id=/^\d{5}$/.test(requested)?requested:genRoomId();
    if(rooms[id])return cb({ok:false,msg:'房间号已存在'});
    const r=rooms[id]={id,host:null,players:[],waiting:[],bankrupt:[],accounts:{},status:'waiting',handNo:0,dealerSeat:null,game:{message:'等待开始'},settlement:null,lastResult:null,pendingReveal:null};
    const p=createPlayerFromAccount(r,name,socket.id);p.seat=0;p.ready=true;r.players.push(p);r.host=p.token;reconnect(r,p,socket);syncAccount(r,p);cb({ok:true,token:p.token,roomId:id});broadcast(r);
  });
  socket.on('joinRoom',({roomId,name},cb=()=>{})=>{
    const r=rooms[String(roomId||'').trim()];if(!r)return cb({ok:false,msg:'房间不存在'});
    name=(name||'').trim();if(!name)return cb({ok:false,msg:'请输入昵称'});
    let p=findByName(r,name);
    if(p){
      if(p.id)return cb({ok:false,msg:'该昵称已在线'});
      if(p.managed&&r.status==='playing'&&p.inHand)return cb({ok:false,msg:'该账号已进入托管，本局结束后再加入'});
      reconnect(r,p,socket);cb({ok:true,token:p.token,roomId:r.id,reconnected:true});broadcast(r);return;
    }
    p=createPlayerFromAccount(r,name,socket.id);
    if(p.chips<=0){p.bankruptAt=r.accounts[name].bankruptAt||Date.now();r.bankrupt.push(p)}
    else if(r.status==='waiting'&&r.players.length<MAX_SEATED){p.seat=nextFreeSeat(r);r.players.push(p)}
    else r.waiting.push(p);
    reconnect(r,p,socket);cb({ok:true,token:p.token,roomId:r.id});broadcast(r);
  });
  socket.on('toggleReady',(_,cb=()=>{})=>{
    const r=roomOf(socket),p=r&&findMember(r,socket.data.token);if(!r||!p)return cb({ok:false});
    if(r.status!=='waiting'||!r.players.includes(p))return cb({ok:false,msg:'当前不能准备'});
    if(p.token===r.host)return cb({ok:false,msg:'房主自动准备'});
    p.ready=!p.ready;broadcast(r);cb({ok:true});
  });
  socket.on('start',(_,cb=()=>{})=>{
    const r=roomOf(socket);if(!r||r.host!==socket.data.token)return cb({ok:false,msg:'仅房主可开始'});
    if(r.status!=='waiting')return cb({ok:false,msg:'当前不能开始'});
    const ok=r.players.filter(p=>p.chips>0).every(p=>p.token===r.host||p.ready);if(!ok)return cb({ok:false,msg:'还有玩家未准备'});
    cb(startHand(r));
  });
  socket.on('action',({type,amount},cb=()=>{})=>{const r=roomOf(socket),p=r&&findMember(r,socket.data.token);if(!r||!p)return cb({ok:false});cb(doAction(r,p,type,amount))});
  socket.on('chooseReveal',({show},cb=()=>{})=>{
    const r=roomOf(socket);if(!r||r.status!=='winnerReveal'||r.pendingReveal?.winnerToken!==socket.data.token)return cb({ok:false,msg:'当前无需选择'});
    resolveFoldReveal(r,!!show);cb({ok:true});
  });
  socket.on('ackSettlement',(_,cb=()=>{})=>{
    const r=roomOf(socket);if(!r||!r.settlement)return cb({ok:false});
    if(!r.settlement.required.includes(socket.data.token))return cb({ok:false,msg:'你无需确认本局结算'});
    r.settlement.acks.add(socket.data.token);
    moveBustedAfterAck(r,socket.data.token);
    broadcast(r);maybeFinishSettlement(r);cb({ok:true});
  });
  socket.on('kick',({token},cb=()=>{})=>{
    const r=roomOf(socket);if(!r||r.host!==socket.data.token)return cb({ok:false,msg:'仅房主可踢人'});
    const p=findMember(r,token);if(!p||p.token===r.host)return cb({ok:false,msg:'不能踢出该玩家'});
    if(r.status==='playing'&&p.inHand){p.kicked=true;p.folded=true;p.id=null;if(r.game.currentToken===p.token)advance(r,p.seat);else broadcast(r)}
    else{removeActiveReference(r,p);broadcast(r)}cb({ok:true});
  });
  socket.on('leaveRoom',(_,cb=()=>{})=>{
    const r=roomOf(socket),p=r&&findMember(r,socket.data.token);if(!r||!p)return cb({ok:true});
    syncAccount(r,p);
    if(r.status==='playing'&&p.inHand){p.kicked=true;p.folded=true;p.id=null;if(r.game.currentToken===p.token)advance(r,p.seat);else broadcast(r)}
    else{removeActiveReference(r,p);broadcast(r)}cb({ok:true});
  });
  socket.on('disconnect',()=>{
    const r=roomOf(socket),p=r&&findMember(r,socket.data.token);if(!r||!p)return;
    p.id=null;p.connected=false;scheduleDisconnect(r,p);if(r.status==='playing'&&r.game.currentToken===p.token)maybeAuto(r);broadcast(r);
  });
});

}
