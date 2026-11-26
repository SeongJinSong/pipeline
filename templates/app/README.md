# __APP_NAME__

__APP_ONE_LINER__

- Slack: `#__CHANNEL__` (요구사항은 여기에)
- 프로덕션: __PRODUCTION_URL__
- 스펙: [SPEC.md](./SPEC.md) (PRD와 결정 기록)
- 작업 기록: [docs/plans/](./docs/plans/) (PR마다 요청·결정·검증)
- 작업 보드: __PROJECT_URL__

## 배포 구조
- 웹: Vercel 프로젝트 `__APP_SLUG__` (루트 `web/`). PR마다 프리뷰, `main` 머지 시 프로덕션.
- 백엔드(있으면): `infra/` Terraform → AWS __AWS_REGION__ (Lambda + API Gateway + DynamoDB). `main` 머지 시 `.github/workflows/backend.yml` 이 GitHub OIDC로 apply.
- 머지(=배포)는 Slack [배포] 버튼 또는 사람이 직접 한다.

## 로컬 실행
```bash
cd web && npm install && npm run dev
```

## 환경변수
| 이름 | 어디서 | 설명 |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | Vercel (자동) | 백엔드 API 주소. backend 워크플로가 배포 후 넣는다 |
