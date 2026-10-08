import React,{useEffect,useMemo,useRef,useState} from 'react';
import {io} from 'socket.io-client';

function getToken(){
  let t=sessionStorage.getItem('pokerPlayerToken');
  if(!t){ t=crypto?.randomUUID?.()||Math.random().toString(36).slice(2)+Date.now(); sessionStorage.setItem('pokerPlayerToken',t); }
  return t;
}
function fmt(v){return v>0?`+${v}`:`${v}`}
function Card({card,folded=false}){
  if(card==='back') return <div className={`pc back ${folded?'foldedBack':''}`}>◆</div>;
  if(!card) return null;
  const red=card.suit==='♥'||card.suit==='♦';
  return <div className={`pc ${red?'red':''}`}><span>{card.rank}{card.suit}</span></div>;
}
function ConfirmModal({state,onClose}){
  if(!state) return null;
  return <div className="overlay"><div className="modal confirmModal"><h3>{state.title||'确认操作'}</h3><p>{state.text}</p><div className="modalBtns"><button className="primary" onClick={()=>{state.onConfirm?.();onClose();}}>确认</button><button className="secondary" onClick={onClose}>取消</button></div></div></div>;
}

function FoldChoiceModal({open,seen,onDark,onReveal,onClose}){
  if(!open) return null;
  return <div className="overlay"><div className="modal confirmModal"><h3>选择弃牌方式</h3><p className="muted">暗弃不会公开手牌；明弃会向所有玩家展示手牌。</p><div className="modalBtns"><button className="danger" onClick={onDark}>暗弃</button><button className="revealFold" disabled={!seen} onClick={onReveal}>{seen?'明弃':'明弃（需先看牌）'}</button><button className="secondary" onClick={onClose}>取消</button></div></div></div>;
}

export default function App(){
  const socket=useMemo(()=>io(window.location.origin,{path:'/socket.io/zjh'}),[]);
  const token=useMemo(()=>getToken(),[]);
  const [name,setName]=useState('');
  const [code,setCode]=useState(sessionStorage.getItem('pokerRoomCode')||'');
  const [room,setRoom]=useState(null);
  const [msg,setMsg]=useState('');
  const [rank,setRank]=useState(false);
  const [cmpOpen,setCmpOpen]=useState(false);
  const [confirm,setConfirm]=useState(null);
  const [foldOpen,setFoldOpen]=useState(false);
  const [now,setNow]=useState(Date.now());
  const [motionCards,setMotionCards]=useState([]);
  const [motionChips,setMotionChips]=useState([]);
  const autoDone=useRef(false);
  const prevRoomRef=useRef(null);
  const motionSeq=useRef(1);

  useEffect(()=>{ const t=setInterval(()=>setNow(Date.now()),1000); return()=>clearInterval(t); },[]);
  useEffect(()=>{
    const reconnect=()=>{
      const rc=sessionStorage.getItem('pokerRoomCode'), rn=sessionStorage.getItem('pokerName');
      if(rc&&rn) socket.emit('joinRoom',{code:rc,name:rn,token},r=>{ if(!r?.ok&&r?.msg==='房间不存在') sessionStorage.removeItem('pokerRoomCode'); });
    };
    const onRoom=d=>{
      setRoom(d);
      if(!d.waiting.some(p=>p.token===token)&&msg==='当前牌局进行中，你已进入观战/等待区') setMsg('');
    };
    const onKicked=({msg})=>{
      sessionStorage.removeItem('pokerRoomCode'); sessionStorage.removeItem('pokerName');
      setRoom(null); setName(''); setMsg(msg||'你已被移出房间');
    };
    socket.on('connect',reconnect); socket.on('room',onRoom); socket.on('kicked',onKicked);
    if(socket.connected) reconnect();
    return()=>{socket.off('connect',reconnect);socket.off('room',onRoom);socket.off('kicked',onKicked)};
  },[socket,token,msg]);

  const save=(res,n,c)=>{
    if(!res?.ok) return setMsg(res?.msg||'操作失败');
    sessionStorage.setItem('pokerName',n); sessionStorage.setItem('pokerRoomCode',c);
    setMsg(res.waiting?'当前牌局进行中，你已进入观战/等待区':'');
  };
  const create=()=>{
    if(!name.trim()) return setMsg('先输入玩家名');
    socket.emit('createRoom',{name:name.trim(),token},r=>{ if(r?.ok){setCode(r.code);save(r,name.trim(),r.code)}else setMsg(r?.msg||'创建失败') });
  };
  const join=()=>{
    if(!name.trim()) return setMsg('先输入玩家名');
    if(!/^\d{5}$/.test(code.trim())) return setMsg('请输入5位房间码');
    socket.emit('joinRoom',{code:code.trim(),name:name.trim(),token},r=>save(r,name.trim(),code.trim()));
  };
  useEffect(()=>{
    if(autoDone.current) return;
    const q=new URLSearchParams(window.location.search);
    const auto=q.get('auto'),qn=(q.get('name')||'').trim(),qr=(q.get('room')||'').trim();
    if(!auto||!qn) return;
    autoDone.current=true; setName(qn);
    const cleanUrl=()=>window.history.replaceState({},'',window.location.pathname);
    const joinExisting=(attempt=0)=>{
      setCode(qr);
      socket.emit('joinRoom',{code:qr,name:qn,token},r=>{
        if(r?.ok){save(r,qn,qr);cleanUrl();return}
        if(r?.msg==='该玩家名已被占用'&&attempt<5)setTimeout(()=>joinExisting(attempt+1),300);
        else setMsg(r?.msg||'加入失败');
      });
    };
    if(auto==='create'&&/^\d{5}$/.test(qr)){
      setCode(qr);
      socket.emit('createRoom',{name:qn,token,code:qr},r=>{
        if(r?.ok){setCode(r.code);save(r,qn,r.code);cleanUrl()}
        else if(r?.msg==='房间号已存在')joinExisting();
        else setMsg(r?.msg||'创建失败');
      });
    }else if(auto==='join'&&/^\d{5}$/.test(qr)){
      joinExisting();
    }
  },[socket,token]);

  const leave=()=>{
    let done=false;
    const goHub=()=>{
      if(done)return; done=true;
      sessionStorage.removeItem('pokerRoomCode'); sessionStorage.removeItem('pokerName');
      window.location.href='/';
    };
    socket.emit('leaveRoom',{},goHub);
    setTimeout(goHub,500);
  };
  const ask=(text,event,payload={},title='确认操作')=>setConfirm({title,text,onConfirm:()=>socket.emit(event,payload,r=>{if(!r?.ok)setMsg(r?.msg||'操作失败');else setMsg('')})});
  const reconnectText=p=>{
    if(p.connected) return '';
    if(p.managed) return '托管中';
    const sec=Math.max(0,Math.ceil(((p.reconnectDeadline||0)-now)/1000));
    return `重连中... ${sec}s`;
  };


  const queueZjhCard=(targetToken,delay=0)=>{
    if(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)return;
    requestAnimationFrame(()=>{
      const table=document.querySelector('.casinoTable');
      const center=document.querySelector('.casinoTable .center');
      const el=[...document.querySelectorAll('.casinoTable .seat')].find(x=>x.dataset.playerToken===targetToken);
      if(!table||!center||!el)return;
      const c=center.getBoundingClientRect(), t=(el.querySelector('.cards')||el).getBoundingClientRect();
      const deck=document.querySelector('.casinoTable .deckStack');const d=deck?.getBoundingClientRect();
      const id=motionSeq.current++;
      setMotionCards(v=>[...v,{id,sx:d?d.left+d.width/2:c.left+c.width*.72,sy:d?d.top+d.height/2:c.top+c.height*.42,tx:t.left+t.width/2,ty:t.top+t.height/2,delay}]);
      setTimeout(()=>setMotionCards(v=>v.filter(x=>x.id!==id)),delay+720);
    });
  };
  const queueZjhChip=(targetToken,amount,delay=0)=>{
    if(!amount||window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)return;
    requestAnimationFrame(()=>{
      const el=[...document.querySelectorAll('.casinoTable .seat')].find(x=>x.dataset.playerToken===targetToken);
      const pot=document.querySelector('.casinoTable .pot');
      if(!el||!pot)return;
      const a=(el.querySelector('.chipStack')||el).getBoundingClientRect(),b=pot.getBoundingClientRect();
      const id=motionSeq.current++;
      setMotionChips(v=>[...v,{id,sx:a.left+a.width/2,sy:a.top+a.height/2,tx:b.left+b.width/2,ty:b.top+b.height/2,delay,amount}]);
      setTimeout(()=>setMotionChips(v=>v.filter(x=>x.id!==id)),delay+780);
    });
  };

  useEffect(()=>{
    if(!room){prevRoomRef.current=null;return}
    const prev=prevRoomRef.current;
    if(prev){
      const newRound=room.status==='playing'&&(prev.status!=='playing'||prev.roundNo!==room.roundNo);
      if(newRound){
        const active=room.players.filter(p=>p.inRound).slice().sort((a,b)=>a.seat-b.seat);
        for(let round=0;round<3;round++)active.forEach((p,i)=>queueZjhCard(p.token,(round*active.length+i)*92));
      }
      if(room.status==='playing'){
        room.players.forEach((p,i)=>{
          const old=prev.players?.find(x=>x.token===p.token);if(!old)return;
          const spent=(old.chips||0)-(p.chips||0);
          if(spent>0)queueZjhChip(p.token,spent,i*26);
        });
      }
    }
    prevRoomRef.current=room;
  },[room]);

  if(!room) return <main className="page"><div className="brand">♠ PRIVATE POKER</div><h1>炸金花 V4.4.6</h1><div className="lobby"><input placeholder="玩家名（房间内唯一账号）" value={name} onChange={e=>setName(e.target.value)} autoComplete="off"/><button className="primary" onClick={create}>创建房间</button><input placeholder="5位房间码" value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,'').slice(0,5))}/><button onClick={join}>加入</button></div><p className="muted">同一房间内玩家名唯一：在线同名不能加入；离线同名会继承原账号、筹码和状态。</p>{msg&&<p className="msg">{msg}</p>}</main>;

  const isHost=room.hostToken===token;
  const me=room.players.find(p=>p.token===token);
  const waitMe=room.waiting.find(p=>p.token===token);
  const canStart=isHost&&room.status==='waiting'&&room.allReady;
  const myTurn=room.currentToken===token;
  const active=room.players.filter(p=>p.inRound&&!p.folded&&!p.eliminated);
  const targets=active.filter(p=>p.token!==token);
  const cmpAllowed=room.status==='playing'&&myTurn&&room.circleNo>=3&&targets.length>0&&!room.compareResult&&!room.showdownVote&&!room.showdownResult;
  const openAllowed=room.status==='playing'&&myTurn&&!room.showdownBlocked&&active.some(p=>p.token===token)&&active.length>=2&&active.length<=3&&!room.showdownVote&&!room.compareResult&&!room.showdownResult;
  const vote=room.showdownVote;
  const needVote=vote&&vote.required.includes(token)&&!vote.approvals.includes(token);
  const compareResult=room.compareResult;
  const callCost=me?room.betLevel*(me.seen?2:1):0;
  const nextBet=room.betLevel<160?({10:20,20:40,40:80,80:160}[room.betLevel]||160):160;
  const raiseCost=me?nextBet*(me.seen?2:1):0;
  const compareCost=me?room.betLevel*(me.seen?2:1):0;
  const roundPlayers=room.players.filter(p=>p.inRound);
  const myRoundIndex=roundPlayers.findIndex(p=>p.token===token);
  const tablePlayers=myRoundIndex>0?[...roundPlayers.slice(myRoundIndex),...roundPlayers.slice(0,myRoundIndex)]:roundPlayers;

  return <main className="page">
    <header className="roomHead"><div><div className="muted">房间号</div><h2>{room.id}</h2></div><div className="headBtns"><button onClick={()=>setRank(true)}>排行榜</button><button className="secondary" onClick={leave}>退出房间</button></div></header>

    {room.status==='waiting'?<>
      <div className="statusBar"><span>等待准备</span><span>准备人数 {room.readyCount}/{room.players.length}</span></div>
      <div className="grid">{room.players.map(p=><article key={p.token} className={`player ${p.token===token?'self':''}`}><div className="top"><strong>{p.name}</strong><span>{p.token===room.hostToken?'👑 房主':''}{p.token===token?' · 你':''}</span></div><div className="muted">座位 {p.seat} · 筹码 {p.chips}</div>{!p.connected&&<div className="reconnecting">{reconnectText(p)}</div>}<div className={p.lastDelta>0?'plus':'minus'}>{p.lastDelta?`上一局 ${fmt(p.lastDelta)}`:''}</div><div>{p.token===room.hostToken?'房主默认准备':p.ready?'✓ 已准备':'○ 未准备'}</div>{isHost&&p.token!==token&&<button className="danger small" onClick={()=>ask(`确认踢出 ${p.name}？`,'kickPlayer',{targetToken:p.token})}>踢出</button>}</article>)}</div>
      <div className="actions">{!isHost&&me&&!me.bankrupt&&<button className={me.ready?'secondary':'primary'} onClick={()=>socket.emit('toggleReady',{},r=>!r?.ok&&setMsg(r?.msg||'操作失败'))}>{me.ready?'取消准备':'准备'}</button>}{isHost&&<button disabled={!canStart} className={canStart?'primary':'disabled'} onClick={()=>socket.emit('startGame',{},r=>!r?.ok&&setMsg(r?.msg||'开始失败'))}>{canStart?'开始游戏':'等待所有客机准备'}</button>}</div>
    </>:room.status==='playing'?<>
      <div className="statusBar"><span>第 {room.roundNo} 轮 · 第 {room.circleNo} 圈</span><span>底池 {room.pot}</span><span>下注档 {room.betLevel}</span><span>{myTurn?'轮到你':'等待其他玩家'}</span></div>
      <section className={`table casinoTable playerCount${tablePlayers.length}`}><div className="motionLayer" aria-hidden="true">{motionCards.map(m=><div key={m.id} className="flyingCard smallFly" style={{'--sx':`${m.sx}px`,'--sy':`${m.sy}px`,'--tx':`${m.tx}px`,'--ty':`${m.ty}px`,'--delay':`${m.delay}ms`}}><span>♠</span></div>)}{motionChips.map(m=><div key={m.id} className="flyingChipWrap" style={{'--sx':`${m.sx}px`,'--sy':`${m.sy}px`,'--tx':`${m.tx}px`,'--ty':`${m.ty}px`,'--delay':`${m.delay}ms`}}><div className="flyingChip">●</div><b>{m.amount}</b></div>)}</div><div className="center"><div className="tableMark">ZHA JIN HUA</div><div className="deckStack" aria-hidden="true"><span>♠</span></div><div className="pot"><span className="chipMini">●</span> 底池 {room.pot}</div><div className="centerMessage">{room.gameMessage||'牌局进行中'}</div></div><div className="seats">{tablePlayers.map((p,i)=><article key={p.token} data-player-token={p.token} className={`seat seatPos${i} ${p.token===token?'selfSeat':''} ${p.token===room.currentToken?'turn':''} ${p.folded?'foldedSeat':''}`}><div className="avatar">{(p.name||'?').trim().slice(0,1).toUpperCase()}</div><div className="seatHead"><strong>{p.name}{p.token===room.hostToken?' 👑':''}{p.token===token?'（你）':''}</strong>{isHost&&p.token!==token&&<button className="danger tiny" onClick={()=>ask(`确认在牌局中踢出 ${p.name}？其本局已投入筹码不会退回。`,'kickPlayer',{targetToken:p.token})}>踢</button>}</div><div className="seatNo">座位 {p.seat}</div><div className="chipStack"><span>●</span>{p.chips}</div>{!p.connected&&<div className="reconnecting">{reconnectText(p)}{p.token===room.currentToken?` · 当前档${room.betLevel<=40?'自动跟注':'自动弃牌'}`:''}</div>}<div className="cards">{(p.cards||[]).map((c,j)=><Card card={c} folded={p.folded||p.eliminated} key={j}/>)}</div><div className="cardState">{p.folded?(p.foldReveal?'已明弃':'已暗弃'):p.eliminated?'比牌出局':p.seen?'已看牌':'暗牌'}</div>{p.lastAction&&<div className="lastAction">{p.lastAction}</div>}</article>)}</div></section>

      {me?.inRound&&!me.folded&&!me.eliminated&&<div className="controls">
        {!me.seen&&<button disabled={!myTurn} onClick={()=>ask('确认看牌？看牌后跟注/加注费用翻倍。','viewCards')}>看牌</button>}
        <button disabled={!myTurn} className="primary" onClick={()=>ask(`确认${me.seen?'跟注':'盲跟'}？本次花费 ${callCost} 筹码。`,'callBet')}>{me.seen?`跟注 ${callCost}`:`盲跟 ${callCost}`}</button>
        <button disabled={!myTurn||room.betLevel>=160} onClick={()=>ask(`确认加注？下注档位从 ${room.betLevel} 提升到 ${nextBet}，本次花费 ${raiseCost} 筹码。`,'raiseBet')}>{room.betLevel>=160?'加注（封顶）':`加注到 ${nextBet} / 花费 ${raiseCost}`}</button>
        <button disabled={!myTurn} className="danger" onClick={()=>setFoldOpen(true)}>弃牌</button>
        <button disabled={!cmpAllowed} onClick={()=>setCmpOpen(true)}>{me.seen?'比牌':'盲比'}{room.circleNo<3?'（第3圈开放）':''}</button>
        <button disabled={!openAllowed} onClick={()=>ask('确认发起开牌？需要其他在场玩家全部同意，不额外加筹码。若本次被拒绝，本回合不能再次申请。','requestShowdown')}>开牌{room.showdownBlocked?'（本回合已被拒绝）':''}</button>
      </div>}

      {waitMe&&<div className="info">{waitMe.bankrupt?'你已破产，当前只能观战。':waitMe.connected?'当前牌局进行中，你在等待下一局。':reconnectText(waitMe)}</div>}
      {needVote&&<div className="vote"><strong>有人申请开牌</strong><button className="primary" onClick={()=>ask('确认同意开牌？','voteShowdown',{agree:true})}>同意</button><button className="danger" onClick={()=>ask('确认拒绝开牌？拒绝后发起者本回合不能再次申请开牌。','voteShowdown',{agree:false})}>拒绝</button></div>}
    </>:null}
    {compareResult&&<div className="resultBanner compareResult">
      <strong>比牌结果</strong>
      <div className="bigResult">{compareResult.text}</div>
      <div className={`compareOwnCards ${compareResult.ownCardMode==='faceGray'?'compareLostCards':''}`}>
        <div className="muted">你的牌</div>
        <div className="cards">
          {(compareResult.ownCards||[]).map((cc,i)=>
            <Card
              key={i}
              card={compareResult.ownCardMode==='back'?'back':cc}
              folded={compareResult.ownCardMode==='faceGray'}
            />
          )}
        </div>
        <div className="compareCardHint">
          {compareResult.ownCardMode==='back'
            ?'盲比获胜：手牌继续保密'
            :compareResult.ownWon
              ?'比牌获胜'
              :'比牌失败'}
        </div>
      </div>
      <button className="primary" disabled={compareResult.acks.includes(token)} onClick={()=>socket.emit('ackCompare',{},r=>!r?.ok&&setMsg(r?.msg||'操作失败'))}>{compareResult.acks.includes(token)?'已确认，等待对方':'确认结果'}</button>
    </div>}

    {room.settlement&&<div className="settlementOverlay"><div className="settlementPanel">
      <h2>第 {room.settlement.roundNo} 轮结算结果</h2>
      <div className="settlementResult">{room.settlement.result}</div>
      <div className="settlementGrid">
        {room.settlement.players.map(p=><div key={p.token} className={`settlementPlayer ${p.winner?'settlementWinner':'settlementLoser'}`}>
          <div className="settlementName">{p.name}{p.winner?' 🏆':''}{p.token===token?'（你）':''}</div>
          <div className="cards settlementCards">{p.cards.map((cc,i)=><Card key={i} card={p.cardState==='face'?cc:'back'} folded={!p.winner}/>)}</div>
          <div className="settlementAction">最后动作：{p.lastAction||'无'}</div>
          <div className={p.delta>0?'plus':'minus'}>本局筹码变化：{fmt(p.delta)}</div>
        </div>)}
      </div>
      {room.settlement.req.includes(token)&&<button className="primary settlementAck" disabled={room.settlement.acks.includes(token)} onClick={()=>socket.emit('ackSettlement',{},r=>!r?.ok&&setMsg(r?.msg||'确认失败'))}>{room.settlement.acks.includes(token)?'已确认，等待其他玩家':'确认结算'}</button>}
    </div></div>}

    <section className="waiting"><h3>观战 / 等待区</h3>{room.waiting.length===0?<p className="muted">暂无等待玩家</p>:room.waiting.map(p=><div className={`wait ${p.token===token?'selfWait':''}`} key={p.token}><span>{p.name}{p.token===token?'（你）':''} · 筹码 {p.chips}{p.bankrupt?' · 你已破产':''}{!p.connected?` · ${reconnectText(p)}`:''}</span>{isHost&&p.token!==token&&<button className="danger small" onClick={()=>ask(`确认踢出 ${p.name}？`,'kickPlayer',{targetToken:p.token})}>踢出</button>}</div>)}</section>
    {msg&&<p className="msg">{msg}</p>}

    {cmpOpen&&<div className="overlay"><div className="modal"><h3>选择比牌对象</h3><p className="muted">第3圈开始可比牌；费用等于你当前需要跟注的金额；比牌无需对方同意，同样大时被比者胜。</p>{targets.map(p=><button className="target" key={p.token} onClick={()=>{const label=me?.seen?'比牌':'盲比';setConfirm({title:'确认比牌',text:`确认与 ${p.name} ${label}？比牌为强制操作，本次将立即花费 ${compareCost} 筹码。`,onConfirm:()=>{socket.emit('compare',{targetToken:p.token},r=>!r?.ok&&setMsg(r?.msg||'比牌失败'));setCmpOpen(false);}})}}>{p.name}</button>)}<button className="secondary" onClick={()=>setCmpOpen(false)}>取消</button></div></div>}

    {rank&&<aside className="rank"><div className="rankHead"><strong>筹码排行榜</strong><button onClick={()=>setRank(false)}>×</button></div><ol>{room.ranking.alive.map((p,i)=><li key={p.token}><span>{i+1}. {p.name}</span><span>{p.chips} <em className={p.lastDelta>0?'plus':'minus'}>{p.lastDelta?fmt(p.lastDelta):''}</em></span></li>)}</ol>{room.ranking.bankrupt.length>0&&<><div className="bankruptTitle">破产人员</div><ul>{room.ranking.bankrupt.map(p=><li key={p.token}><span>{p.name}</span><span>{p.chips} <em>{p.lastDelta?fmt(p.lastDelta):''}</em></span></li>)}</ul></>}</aside>}

    <FoldChoiceModal open={foldOpen} seen={!!me?.seen} onClose={()=>setFoldOpen(false)}
      onDark={()=>{setFoldOpen(false);ask('确认暗弃？你的牌不会向其他玩家公开。','fold',{reveal:false},'确认暗弃')}}
      onReveal={()=>{setFoldOpen(false);ask('确认明弃？你的三张牌会展示给所有玩家。','fold',{reveal:true},'确认明弃')}}/>
    <ConfirmModal state={confirm} onClose={()=>setConfirm(null)}/>
  </main>;
}
