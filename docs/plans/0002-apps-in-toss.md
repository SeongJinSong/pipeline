# 0002 앱인토스(토스 미니앱) 배포 지원

- 상태: 제안 (PR)
- 요청: Evan, 2026-11-26 ("앱인토스 쪽도 토큰을 추가하는 등 작업이 필요한데 진행이 안 됐을 것")
- 작성일: 2026-11-26

## 목표

아이디어를 토스 앱 안의 미니앱(앱인토스)으로도 낼 수 있게 한다. Slack 요청 → PR → [배포] 흐름은 그대로 두고, 그 사이에 앱인토스 번들 빌드·업로드를 끼운다. 사람이 콘솔에서 해야 하는 일은 봇이 정확히 알려 준다.

## 조사 (2026-11-26, 공식 문서)

- 프로젝트: 기존 웹 프로젝트에 `@apps-in-toss/web-framework` 를 넣고 `apps-in-toss.config.ts`(appName, permissions, webBundleDir)를 둔다. `ait build` 가 webBundleDir(index.html 포함)을 `<appName>.ait` 로 묶는다. ([기존 웹 프로젝트에 SDK 연동하기](https://developers-apps-in-toss.toss.im/ai-vibe-coding/tutorials/webview.md), CLI 3.11.0 `ait build --help`)
- 업로드: 콘솔 워크스페이스 **키** 메뉴의 API 키로 `ait deploy --api-key <키>` (SDK 1.4.0+). 업로드마다 deploymentId 와 테스트 스킴 `intoss-private://<appName>?_deploymentId=…` 이 생긴다. ([미니앱 테스트하기](https://developers-apps-in-toss.toss.im/guide/operation/toss.md))
- 출시: 업로드만으로는 공개되지 않는다. 콘솔에서 토스앱 테스트 1회 → 검토 요청 → 승인 → 출시하기. 새 버전도 매번 같다. ([미니앱 등록하기](https://developers-apps-in-toss.toss.im/guide/operation/console-workspace.md), [버전 관리](https://developers-apps-in-toss.toss.im/guide/operation/deploy.md))
- 앱 등록(appName)은 콘솔에서 사람이 한다. appName 은 등록 후 못 바꾼다.
- 서버 API(토스 로그인 토큰 교환, 결제, 푸시, 포인트)는 앱마다 콘솔 **개발 > mTLS 인증서**로 발급한 인증서가 필요하다. ([서버 API 이용하기](https://developers-apps-in-toss.toss.im/documentation/integration/server-api.md))
- 토스 로그인·인앱 결제·토스페이·프로모션은 사업자 등록이 먼저 필요하다. 인앱 광고는 유예가 있다. ([사업자 등록하기](https://developers-apps-in-toss.toss.im/guide/operation/register-business.md))
- 콘솔 작업 대부분(번들 업로드, 검수 신청, 롤백 등)을 하는 콘솔 MCP 가 있다(OAuth 로그인). ([AI로 콘솔 사용하기](https://developers-apps-in-toss.toss.im/guide/console-mcp.md))

## 결정

1. **스펙에 `platform: web | toss`.** PM이 사람 말(앱인토스, 토스 미니앱)을 보고 정한다. 기본은 web.
2. **같은 Next.js 코드를 정적으로 내보내 번들로.** `AIT_EXPORT=1 next build`(output: export, trailingSlash, images.unoptimized) → `out/` → `ait build`. Vercel 빌드(`npm run build`)는 그대로라 웹 주소도 유지된다. 별도 Vite 템플릿을 두지 않아 템플릿·에이전트 규칙이 하나로 유지된다. 대가로 Next.js 서버 기능은 못 쓴다 (서버 일은 기존처럼 AWS Lambda).
3. **미니앱 판별은 레포 파일로.** 루트나 `web/` 에 `apps-in-toss.config.*` 가 있으면 미니앱. DB 컬럼이 없어도 되고 `/connectapp` 기존 레포도 같은 흐름을 탄다.
4. **업로드는 봇 서버가 CLI 로.** PR 커밋마다 테스트 번들(테스트 링크를 스레드에), [배포] 머지 후 main 번들. GitHub Actions 가 아니라 봇에서 하는 이유: 결과(테스트 스킴)를 Slack 스레드에 바로 남길 수 있고, 키를 앱 레포마다 시크릿으로 뿌리지 않아도 된다.
5. **검토 요청·출시는 사람.** 사용자에게 즉시 나가는 되돌리기 어려운 단계라 콘솔 버튼으로 남긴다. 봇은 할 일을 스레드에 적는다.
6. **비밀값 격리.** 빌드는 레포 코드를 실행하므로 최소 환경(PATH, 빈 HOME)으로 돌리고, 키는 `--api-key` 인자로만 넘기고 출력·오류에서 `***` 로 가린다. 같은 이유로 코드 수정 에이전트 환경에서도 봇 토큰(Slack, GitHub, Vercel, 앱인토스)을 뺐다 (이전에는 Anthropic 키만 뺐다). 에이전트는 `ait deploy`·`ait token` 을 못 쓴다.

## 버린 대안

- 앱인토스 전용 Vite 템플릿: 공식 예시는 Vite 지만, 웹(Vercel)과 두 벌 템플릿·규칙을 유지해야 한다.
- GitHub Actions 로 업로드: 테스트 링크를 Slack 에 돌려받기 어렵고 키를 레포마다 복사해야 한다.
- 콘솔 MCP 로 검수 신청·출시까지 자동화: 서버에서 OAuth 로그인을 유지해야 하고, 출시를 사람이 누르는 게 안전하다. 필요해지면 후속으로.
- 앱 등록 자동화: API 키 CLI 로는 앱을 만들 수 없다 (콘솔 MCP `miniapp_create` 는 OAuth 필요).

## 한계와 위험

- 실제 업로드는 이 작업 환경에서 토스 서버에 닿지 않아 돌려 보지 못했다. 템플릿으로 `npm run build:ait` 까지는 실제로 실행해 `.ait` 생성을 확인했고, 업로드는 가짜 키로 네트워크 오류까지(키 비노출) 확인했다. 키를 넣은 뒤 첫 PR에서 확인해야 한다.
- appName 이 이미 쓰이면 콘솔에서 다른 이름으로 등록하고 `apps-in-toss.config.ts` 를 고쳐야 한다.
- 번들은 100MB(압축 해제) 이하. PR마다 업로드하면 콘솔 번들 목록이 늘어난다. 많아지면 `APPS_IN_TOSS_PR_UPLOADS=false`.
- 봇 서버(t4g.small)에서 `next build` 를 한 번 더 돌리므로 PR 하나에 1~2분이 늘어난다.
- 앱인토스 검수 가이드(비게임 체크리스트, TDS 권장 등)는 에이전트 규칙에 링크만 넣었다. 검수 반려가 나오면 규칙을 보강한다.

## 결과

(머지·배포 후 채움)
