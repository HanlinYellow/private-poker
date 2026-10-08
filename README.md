# Private Poker Deploy V2.0.10

Render 单 Web Service 部署版，对应本地套件 V1.0.10。

- `/`：统一大厅
- `/games/zjh/`：炸金花
- `/games/long/`：德州扑克（长牌）
- `/games/short/`：德州扑克（短牌）
- `/socket.io/zjh`、`/socket.io/long`、`/socket.io/short`：三套实时连接
- `/api/rooms/*`：统一房间注册/查找

## Render
- Build Command: `npm install && npm run build`
- Start Command: `npm start`
- Health Check: `/api/health`

本版包含 V1.0.10 的座位规则修复、圆桌美术、发牌飞行动画和下注筹码入池动画。
