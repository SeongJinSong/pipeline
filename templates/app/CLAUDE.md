# __APP_NAME__

__APP_ONE_LINER__

이 레포는 Slack 채널 `#__CHANNEL__` 의 요구사항을 받아 파이프라인 에이전트가 수정한다.

## 구조
- `web/` — Next.js (App Router, TypeScript, Tailwind). Vercel이 이 폴더를 루트로 배포한다. PR마다 프리뷰 URL이 생긴다.
- `backend/src/` — AWS Lambda 핸들러 (Node.js 22, ESM). 백엔드가 없는 앱이면 이 폴더는 없다.
- `infra/` — Terraform (Lambda + API Gateway + DynamoDB). main 머지 시 GitHub Actions가 apply 한다.
- `SPEC.md` — 처음 아이디어에서 정리한 MVP 스펙.

## 규칙
- 웹 수정 후 `cd web && npm install && npm run build` 가 통과해야 한다.
- 프런트에서 백엔드 호출은 `process.env.NEXT_PUBLIC_API_URL` 을 쓴다.
- 새 AWS 리소스는 `infra/` 에 Terraform으로만 추가한다. 콘솔 수동 작업 금지.
- 비밀값은 코드에 넣지 않는다. 필요한 환경변수는 README의 표에 적는다.
