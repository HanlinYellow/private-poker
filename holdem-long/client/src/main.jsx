
import React,{useEffect,useMemo,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {io} from 'socket.io-client';
import './style.css';

const socket=io(window.location.origin,{path:'/socket.io/long',transports:['websocket','polling']});
const suitSym={S:'♠',H:'♥',D:'♦',C:'♣'};
const streetName={preflop:'翻牌前',flop:'翻牌',turn:'转牌',river:'河牌'};

function Card({c,gray=false,highlight=false}){
  if(!c||c==='back')return <div className={`card back ${gray?'gray':''} ${highlight?'highlight':''}`}>★</div>;
  const rank=c[0]==='T'?'10':c[0],red=c[1]==='H'||c[1]==='D';
  return <div className={`card ${red?'red':''} ${gray?'gray':''} ${highlight?'highlight':''}`}><b>{rank}</b><span>{suitSym[c[1]]}</span></div>;
}
function Modal({children,wide=false}){return <div className="overlay"><div className={`modal ${wide?'wideModal':''}`}>{children}</div></div>}
const fmt=n=>`${n>0?'+':''}${n||0}`;

function ResultPanel({result,token,history=false,onClose,onAck}){
  if(!result)return null;
  const winnerSet=new Set(result.winnerTokens||[]);
  const bestCards=new Set();
  if(result.endedBy==='showdown'){
    result.players.filter(p=>winnerSet.has(p.token)).forEach(p=>(p.best||[]).forEach(c=>bestCards.add(c)));
  }
  return <Modal wide>
    <h2>第 {result.handNo} 局结算</h2>
    <div className="settleReason">{result.reason}</div>
    <div className="cards center">
      {(result.board||[]).map((c,i)=><Card c={c} key={i} highlight={result.endedBy==='showdown'&&bestCards.has(c)}/>)}
    </div>
    <div className="pots">
      {(result.pots||[]).map((p,i)=><div key={i} className="potLine">{i===0?'主池':`边池 ${i}`}：{p.amount} → {p.winners.join('、')}</div>)}
    </div>
    <div className="settleGrid">
      {result.players.map(p=>{
        const isWinner=winnerSet.has(p.token),show=p.cardMode==='face';
        return <div className={`settleP ${p.folded?'folded':''} ${isWinner?'winnerBox':''}`} key={p.token}>
          <b>{p.name}{p.token===token?'（你）':''}{isWinner?' 🏆':''}</b>
          <div className="cards small">
            {(p.cards||[]).map((c,i)=><Card key={i} c={show?c:'back'} gray={p.folded&&!isWinner} highlight={result.endedBy==='showdown'&&isWinner&&(p.best||[]).includes(c)}/>)}
          </div>
          {p.handName&&show&&<div>{p.handName}</div>}
          <div className={p.lastDelta>0?'plus':p.lastDelta<0?'minus':''}>本局筹码变化：{fmt(p.lastDelta)}</div>
          <div>当前筹码：{p.chips}</div>
          {p.lastAction&&<div className="lastAction">{p.lastAction}</div>}
        </div>
      })}
    </div>
    {history?<button onClick={onClose}>关闭</button>
      :result.required?.includes(token)
        ?<button disabled={result.acks?.includes(token)} onClick={onAck}>{result.acks?.includes(token)?'已确认，等待其他玩家':'确认结算'}</button>
        :<div className="muted">你无需确认本局结算</div>}
  </Modal>
}

function App(){
  const [room,setRoom]=useState(null);
  const [token,setToken]=useState(sessionStorage.getItem('texas-token')||'');
  const [name,setName]=useState('');
  const [roomId,setRoomId]=useState('');
  const [msg,setMsg]=useState('');
  const [raise,setRaise]=useState(0);
  const [showRanking,setShowRanking]=useState(false);
  const [showLast,setShowLast]=useState(false);
  const [confirm,setConfirm]=useState(null);
  const autoDone=useRef(false);

  useEffect(()=>{const h=r=>setRoom(r);socket.on('room',h);return()=>socket.off('room',h)},[]);
  useEffect(()=>{
    // 刷新具体游戏页面时，URL 的 auto 参数已经被清除，
    // 因此需要依靠 sessionStorage 自动接回原房间/原昵称账号。
    const q=new URLSearchParams(window.location.search);
    if(q.get('auto'))return;

    const savedRoom=(sessionStorage.getItem('texas-room')||'').trim();
    const savedName=(sessionStorage.getItem('texas-name')||'').trim();
    if(!/^\d{5}$/.test(savedRoom)||!savedName)return;

    let stopped=false;
    let retryTimer=null;
    const reconnectSaved=(attempt=0)=>{
      if(stopped)return;
      socket.emit('joinRoom',{roomId:savedRoom,name:savedName},r=>{
        if(stopped)return;
        if(r?.ok){
          sessionStorage.setItem('texas-token',r.token);
          setToken(r.token);setName(savedName);setRoomId(savedRoom);setMsg('');
          return;
        }
        // 页面刷新时，旧 socket 可能刚好还没触发 disconnect，
        // 短时间会被认为“同昵称仍在线”，等待旧连接释放后继续重试。
        if(r?.msg==='该昵称已在线'&&attempt<12){
          retryTimer=setTimeout(()=>reconnectSaved(attempt+1),250);
          return;
        }
        if(r?.msg==='房间不存在'){
          sessionStorage.removeItem('texas-token');
          sessionStorage.removeItem('texas-name');
          sessionStorage.removeItem('texas-room');
        }
        setMsg(r?.msg||'自动重连失败');
      });
    };

    const onConnect=()=>reconnectSaved(0);
    socket.on('connect',onConnect);
    if(socket.connected)reconnectSaved(0);

    return()=>{
      stopped=true;
      if(retryTimer)clearTimeout(retryTimer);
      socket.off('connect',onConnect);
    };
  },[]);
  const me=room?.players.find(p=>p.token===token)||room?.waiting.find(p=>p.token===token)||room?.bankrupt.find(p=>p.token===token);
  const isHost=room?.hostToken===token,turn=room?.game?.currentToken===token,g=room?.game;
  const need=g&&me?Math.max(0,g.currentBet-(me.streetBet||0)):0;
  const maxTotal=me?(me.streetBet||0)+me.chips:0;
  const minRaiseTotal=g&&me?Math.min(maxTotal,Math.max(g.currentBet+g.minRaise,g.currentBet)):0;

  useEffect(()=>{if(turn&&g&&me)setRaise(Math.min(maxTotal,Math.max(g.currentBet+g.minRaise,g.currentBet)))},[turn,g?.currentBet,g?.minRaise,me?.chips,me?.streetBet]);

  function enter(kind){
    socket.emit(kind,kind==='createRoom'?{name}:{roomId,name},r=>{
      if(!r?.ok)return setMsg(r?.msg||'失败');
      sessionStorage.setItem('texas-token',r.token);setToken(r.token);if(r.roomId)setRoomId(r.roomId);setMsg('');
    });
  }
  useEffect(()=>{
    if(autoDone.current)return;
    const q=new URLSearchParams(window.location.search);
    const auto=q.get('auto'),qn=(q.get('name')||'').trim(),qr=(q.get('room')||'').trim();
    if(!auto||!qn)return;
    if(!/^\d{5}$/.test(qr)){autoDone.current=true;setMsg('请输入5位房间号');return}
    autoDone.current=true;setName(qn);setRoomId(qr);

    const finishEntry=r=>{
      if(!r?.ok)return false;
      sessionStorage.setItem('texas-token',r.token);
      sessionStorage.setItem('texas-name',qn);
      sessionStorage.setItem('texas-room',qr);
      setToken(r.token);setRoomId(r.roomId||qr);setMsg('');
      // 进入房间后移除 auto=create/join 参数，避免刷新/后退时重复创建同一个房间。
      window.history.replaceState({},'',window.location.pathname);
      return true;
    };

    const joinExisting=(attempt=0)=>{
      socket.emit('joinRoom',{roomId:qr,name:qn},r=>{
        if(finishEntry(r))return;
        // 刷新页面时旧 socket 可能尚未完全断开，短暂出现“同昵称在线”。
        if(r?.msg==='该昵称已在线'&&attempt<5){
          setTimeout(()=>joinExisting(attempt+1),300);
        }else{
          setMsg(r?.msg||'加入失败');
        }
      });
    };

    if(auto==='create'){
      socket.emit('createRoom',{name:qn,roomId:qr},r=>{
        if(finishEntry(r))return;
        // 已经创建成功但页面刷新/后退后再次执行 auto=create：
        // 不报“房间号已存在”，而是自动尝试回到原房间。
        if(r?.msg==='房间号已存在')joinExisting();
        else setMsg(r?.msg||'创建失败');
      });
    }else{
      joinExisting();
    }
  },[]);

  function act(type,amount){
    const label=type==='fold'?'弃牌':type==='check'?'过牌':type==='call'?'跟注':'加注';
    setConfirm({text:`确认${label}${type==='raise'?`到 ${amount}`:''}？`,go:()=>socket.emit('action',{type,amount},r=>{setConfirm(null);if(!r?.ok)setMsg(r?.msg||'操作失败')})});
  }
  function leave(){
    setConfirm({text:'确认退出房间？你的昵称账号数据会保留。',go:()=>{
      setConfirm(null);
      let done=false;
      const goHub=()=>{
        if(done)return; done=true;
        sessionStorage.removeItem('texas-token');
        sessionStorage.removeItem('texas-name');
        sessionStorage.removeItem('texas-room');
        window.location.href='/';
      };
      socket.emit('leaveRoom',{},goHub);
      setTimeout(goHub,500);
    }});
  }
  function kick(t,n){setConfirm({text:`确认踢出 ${n}？`,go:()=>socket.emit('kick',{token:t},r=>{setConfirm(null);if(!r?.ok)setMsg(r?.msg||'操作失败')})})}

  if(!room)return <div className="home"><div className="panel">
    <h1>Texas Hold'em V1.3.1</h1>
    <p>2–6人 · 1500初始筹码 · 每3局涨盲</p>
    <input value={name} onChange={e=>setName(e.target.value)} placeholder="昵称"/>
    <button className="wide" onClick={()=>enter('createRoom')}>创建房间（自动生成5位房间号）</button>
    <div className="joinSep">加入已有房间</div>
    <input value={roomId} onChange={e=>setRoomId(e.target.value.replace(/\D/g,'').slice(0,5))} placeholder="5位房间号"/>
    <button className="wide" onClick={()=>enter('joinRoom')}>加入房间</button>
    <div className="msg">{msg}</div>
  </div></div>;

  const stateText=room.status==='waiting'?'等待开始':room.status==='winnerReveal'?'等待赢家选择亮牌':room.status==='settlement'?'结算中':streetName[g?.street]||'';
  return <div className="app">
    <header>
      <div><b>房间 {room.id}</b> · 第 {room.handNo} 局</div>
      <div className="headRight">
        <span>{g?`小盲 ${g.sb} / 大盲 ${g.bb}`:`下局 小盲 ${room.blind.sb} / 大盲 ${room.blind.bb}`}</span>
        {room.lastResult&&<button className="ghost" onClick={()=>setShowLast(true)}>上局结果</button>}
        <button className="ghost" onClick={()=>setShowRanking(true)}>排行榜</button>
        <button className="ghost" onClick={leave}>退出房间</button>
      </div>
    </header>

    <main><div className="table">
      <div className="board">
        <div className="street">{stateText}</div>
        <div className="cards boardCards">{(g?.board||room.settlement?.board||[]).map((c,i)=><Card c={c} key={i}/>)}</div>
        <div className="pot">底池：{g?.pot??0}</div>
        {g?.message&&<div className="gameMsg">{g.message}</div>}
      </div>

      <div className="players">
        {room.players.filter(p=>room.status!=='playing'||p.inHand).map(p=><div key={p.token} className={`player ${p.token===token?'me':''} ${g?.currentToken===p.token?'turn':''} ${p.folded?'folded':''}`}>
          <div className="pname">{p.name}{p.token===room.hostToken?' 👑':''}{p.token===token?'（你）':''}</div>
          <div>筹码 {p.chips}</div>
          {room.status==='waiting'&&<div className={p.lastDelta>0?'plus':p.lastDelta<0?'minus':''}>上局：{fmt(p.lastDelta)}</div>}
          {room.status==='waiting'&&<div className={`ready ${p.ready?'readyYes':'readyNo'}`}>{p.ready?'已准备':'未准备'}</div>}
          {room.status==='playing'&&<div>本轮下注 {p.streetBet||0}</div>}
          <div className="badges">
            {g?.dealerSeat===p.seat&&<span>庄家</span>}
            {g?.sbSeat===p.seat&&<span>小盲</span>}
            {g?.bbSeat===p.seat&&<span>大盲</span>}
            {p.allIn&&<span>ALL-IN</span>}{p.folded&&<span>弃牌</span>}{p.managed&&<span>托管中</span>}
            {!p.connected&&!p.managed&&<span>重连中</span>}
          </div>
          <div className="cards small">{(p.cards||[]).map((c,i)=><Card c={c} key={i}/>)}</div>
          {p.lastAction&&room.status==='playing'&&<div className="lastAction">{p.lastAction}</div>}
          {isHost&&p.token!==token&&<button className="kick" onClick={()=>kick(p.token,p.name)}>踢出</button>}
        </div>)}
      </div>

      {room.waiting.length>0&&<div className="waitingArea">
        <b>等候区</b>
        <div className="waitingList">{room.waiting.map(p=><span key={p.token}>{p.name}{p.token===token?'（你）':''}{isHost&&p.token!==token&&<button className="miniKick" onClick={()=>kick(p.token,p.name)}>×</button>}</span>)}</div>
      </div>}

      {room.bankrupt.length>0&&<div className="bankruptArea">
        <b>破产区</b>
        <div className="waitingList">{room.bankrupt.map(p=><span key={p.token}>{p.name}{p.token===token?'（你）':''} · 筹码 {p.chips}</span>)}</div>
      </div>}
    </div></main>

    {room.status==='waiting'&&<div className="controls waitingControls">
      <div>下局：小盲 {room.blind.sb} / 大盲 {room.blind.bb} · {room.blind.maxed?'已封顶':`本档还剩 ${room.blind.handsToNext} 局`}</div>
      {room.players.some(p=>p.token===token)&&!isHost&&<button onClick={()=>socket.emit('toggleReady',{},r=>!r?.ok&&setMsg(r?.msg||'失败'))}>{me?.ready?'取消准备':'准备'}</button>}
      {isHost&&<button disabled={!room.allReady||room.players.length<2} onClick={()=>socket.emit('start',{},r=>!r?.ok&&setMsg(r?.msg||'失败'))}>开始下一局</button>}
    </div>}

    {room.status==='playing'&&turn&&me&&!me.allIn&&!me.folded&&!g?.dealing&&<div className="controls actionbar">
      <div className="actionButtons">
        <button onClick={()=>act('fold')}>弃牌</button>
        {need===0?<button onClick={()=>act('check')}>过牌</button>:<button onClick={()=>act('call')}>{need>=me.chips?`ALL-IN ${me.chips}`:`跟注 ${need}`}</button>}
        <button disabled={need>=me.chips||(maxTotal<=g.currentBet&&raise!==maxTotal)} onClick={()=>act('raise',raise)}>{need>=me.chips?'无法加注':(raise>=maxTotal?`ALL-IN ${Math.max(0,maxTotal-(me.streetBet||0))}`:`加注到 ${raise}`)}</button>
      </div>
      <div className="betAdjust">
        <input type="range" min={Math.min(minRaiseTotal,maxTotal)} max={Math.max(minRaiseTotal,maxTotal)} value={raise||0} onChange={e=>setRaise(Number(e.target.value))}/>
        <input type="number" min={Math.min(minRaiseTotal,maxTotal)} max={maxTotal} value={raise||0} onChange={e=>setRaise(Math.min(maxTotal,Math.max(0,Number(e.target.value)||0)))}/>
      </div>
    </div>}

    {room.status==='winnerReveal'&&room.pendingReveal?.winnerToken===token&&<Modal>
      <h2>你已获胜</h2><p>其余玩家都已弃牌，是否亮出自己的手牌？</p>
      <div className="confirmBtns">
        <button onClick={()=>socket.emit('chooseReveal',{show:false},r=>!r?.ok&&setMsg(r?.msg||'失败'))}>不亮牌</button>
        <button onClick={()=>socket.emit('chooseReveal',{show:true},r=>!r?.ok&&setMsg(r?.msg||'失败'))}>亮牌</button>
      </div>
    </Modal>}

    {room.status==='settlement'&&room.settlement&&<ResultPanel result={room.settlement} token={token} onAck={()=>socket.emit('ackSettlement',{},r=>!r?.ok&&setMsg(r?.msg||'失败'))}/>}
    {showLast&&room.lastResult&&<ResultPanel result={room.lastResult} token={token} history onClose={()=>setShowLast(false)}/>}

    {showRanking&&<Modal>
      <h2>排行榜</h2>
      <div className="rankList">
        {room.ranking.active.map(p=><div key={p.name}><span>{p.rank}. {p.name}</span><span>{p.chips}</span><b className={p.lastDelta>0?'plus':p.lastDelta<0?'minus':''}>{fmt(p.lastDelta)}</b></div>)}
      </div>
      <h3 className="bankruptTitle">破产者：</h3>
      <div className="rankList bankruptList">
        {room.ranking.bankrupt.map(p=><div key={p.name}><span>{p.name}</span><span>{p.chips}</span><b className={p.lastDelta>0?'plus':p.lastDelta<0?'minus':''}>{fmt(p.lastDelta)}</b></div>)}
      </div>
      <button onClick={()=>setShowRanking(false)}>关闭</button>
    </Modal>}

    {confirm&&<Modal><h3>{confirm.text}</h3><div className="confirmBtns"><button onClick={()=>setConfirm(null)}>取消</button><button onClick={confirm.go}>确认</button></div></Modal>}
    {msg&&<div className="toast" onClick={()=>setMsg('')}>{msg}</div>}
  </div>
}
createRoot(document.getElementById('root')).render(<App/>);
