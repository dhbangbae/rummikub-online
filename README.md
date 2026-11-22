# The Original Rummikub — Online Multiplayer

2~4인 실시간 온라인 멀티플레이 루미큐브 웹 게임입니다. (Node.js + Express + Socket.IO)

## 폴더 구조

```
├── package.json
├── server.js
├── README.md
└── public/
    └── index.html
```

## 로컬 실행 방법

```bash
npm install
npm start
```

브라우저에서 `http://localhost:3000`에 접속해 여러 탭을 열어 테스트할 수 있습니다.

## GitHub + Render 배포 방법

1. GitHub 저장소 최상단에 `package.json`, `server.js`, `README.md`, `public/index.html`을 업로드하고 커밋합니다.
2. Render에서 **+ New → Web Service** 선택 후 저장소를 연결합니다.
   - **Region**: `Singapore`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free`
3. **Deploy Web Service**를 클릭하면 1~2분 뒤 접속 주소가 생성됩니다.
