# __APP_NAME__

__APP_ONE_LINER__

- Slack: `#__CHANNEL__` (요구사항은 여기에)
- 프로덕션: __PRODUCTION_URL__
- 스펙: [SPEC.md](./SPEC.md)

## 로컬 실행
```bash
cd web && npm install && npm run dev
```

## 환경변수
| 이름 | 어디서 | 설명 |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | Vercel (자동) | 백엔드 API 주소. backend 워크플로가 배포 후 넣는다 |
