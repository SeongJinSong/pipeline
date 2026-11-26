
## 앱인토스(토스 미니앱)
이 앱은 토스 앱 안의 미니앱으로도 나간다. 작업 전에 [docs/apps-in-toss.md](docs/apps-in-toss.md)를 읽는다.
- `web/` 은 정적으로 내보낼 수 있어야 한다: `cd web && npm run build:ait` 가 통과해야 한다 (`out/` → `__APP_SLUG__.ait`). API 라우트·서버 액션·요청 시점 렌더링 금지.
- 토스 기능은 `@apps-in-toss/web-framework` SDK로 붙인다. 모르는 API는 https://developers-apps-in-toss.toss.im/llms.txt 에서 찾아 문서를 읽고 쓴다. 추측으로 쓰지 않는다.
- `ait deploy`·`ait token` 은 실행하지 않는다. 업로드는 파이프라인이 한다.
