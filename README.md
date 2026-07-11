# Kodlo Arena signaling

Окремий WebSocket-сервіс для авторизації, кодів кімнат і обміну WebRTC offer/answer/ICE. Gameplay-трафік через нього не проходить.

```bash
cp .env.example .env
npm install
npm test
npm run build
npm start
```

Health check: `GET /health`. WebSocket endpoint: `/ws`.
