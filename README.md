# Private Poker Deploy V2.0.1

这是把原先“大厅 + 3个前端 + 3个后端 + 房间注册服务”的多端口结构，整合成 **一个 Node.js Web Service / 一个公网端口** 的部署版本。

## 整合后的结构

以前本地版需要：

- 5173 大厅
- 5174 炸金花前端
- 5175 长牌德州前端
- 5176 短牌德州前端
- 2999 房间注册
- 3001 炸金花后端
- 3002 长牌后端
- 3003 短牌后端

现在部署版只需要：

- 一个公网端口：`PORT`
- Render 会自动提供 `PORT`
- 本地默认：`3100`

所有内容都在同一个域名下面：

- `/`：统一大厅
- `/games/zjh/`：炸金花
- `/games/long/`：德州扑克（长牌）
- `/games/short/`：德州扑克（短牌）
- `/api/rooms/*`：全局房间号注册/识别
- `/socket.io/zjh`：炸金花 Socket.IO
- `/socket.io/long`：长牌 Socket.IO
- `/socket.io/short`：短牌 Socket.IO

因此部署到 Render 后，朋友只需要一个网址，例如：

`https://private-poker-xxxx.onrender.com`

不再需要访问 5174、3001 等端口。

## 房间号

三种玩法继续使用同一个 5 位全局房间号池。

创建房间时选择玩法；
加入房间时只输入房间号，系统自动识别对应玩法。

## 本地运行

第一次：

```powershell
npm install
npm run build
npm start
```

然后访问：

`http://localhost:3100`

Windows 也可以双击：

`start-unified.bat`

## Render 部署

项目已经提供 `render.yaml`。

推荐做法：

1. 把本项目上传到 GitHub。
2. Render -> New -> Blueprint。
3. 选择该 GitHub 仓库。
4. Render 会读取 `render.yaml`。
5. Build Command：
   `npm install && npm run build`
6. Start Command：
   `npm start`
7. 部署完成后直接访问 Render 给出的 `https://xxxx.onrender.com`。

不需要购买公网 IP。

## 重要说明

当前房间、筹码和昵称账号数据仍然保存在 Node 服务器内存中，与原本本地版一致。

因此如果 Render 实例重启、休眠后重新启动或重新部署：

- 当前房间会消失；
- 当前房间内的筹码/昵称账号数据会消失；
- 需要重新创建房间。

如果后续希望“服务器重启后仍保留玩家和房间数据”，下一步需要加入 Redis / 数据库持久化。

## 保留的游戏版本

- 炸金花：基于 V4.4.6
- 德州扑克（长牌）：基于当前 V1.3.1 逻辑及之后 Suite 修复
- 德州扑克（短牌）：基于当前短牌 V1.0 逻辑及之后 Suite 修复

包括：
- 等候区 / 破产区
- 昵称账号
- 断线重连
- ALL-IN
- 主池 / 边池
- 排行榜
- 上局结果
- 发牌动画
- 亮牌 / 不亮牌
- 统一房间号和自动识别玩法

## 为什么这个版本更适合 Render

Render 的 Web Service 通常对外提供一个 HTTP/HTTPS 服务入口。
本版不再要求暴露多个端口，所以：

- HTTPS 只有一个域名
- Socket.IO 也走同一个域名
- 手机/电脑无需 VPN
- 不需要 Radmin / Tailscale
- 不需要购买公网 IP


## V2.0.1 修正
本地默认端口从 3000 改为 3100，以避免 Windows 上常见的 3000 端口占用冲突。
Render 部署不受影响，因为 Render 会通过环境变量 `PORT` 指定端口。
