
## 앱인토스(토스 미니앱)
- appName `__APP_SLUG__`. 콘솔 등록·테스트·검토·출시 방법은 [docs/apps-in-toss.md](docs/apps-in-toss.md).
- 번들 만들기: `cd web && npm run build:ait` → `web/__APP_SLUG__.ait`
- Slack 파이프라인이 PR마다 테스트 번들을 올리고(테스트 링크는 PR 스레드), [배포] 시 main 번들을 올린다. 사용자에게 나가는 건 콘솔에서 검토 요청 → 승인 → 출시를 누른 뒤다.
