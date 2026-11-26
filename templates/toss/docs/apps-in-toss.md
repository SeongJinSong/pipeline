# 앱인토스(토스 미니앱) 운영

이 앱은 웹(Vercel)과 함께 **앱인토스 WebView 미니앱**으로도 나간다. 같은 `web/` 코드를 정적으로 내보내 `.ait` 번들로 묶어 토스 앱에 올린다.

- appName: `__APP_SLUG__` (콘솔 등록값과 같아야 함, 등록 후 변경 불가)
- 설정: [`web/apps-in-toss.config.ts`](../web/apps-in-toss.config.ts)
- SDK: `@apps-in-toss/web-framework` (CLI 이름 `ait`)
- 공식 문서: https://developers-apps-in-toss.toss.im (에이전트용 목차: https://developers-apps-in-toss.toss.im/llms.txt)
- 콘솔: https://apps-in-toss.toss.im

## 처음 한 번 (사람이 콘솔에서)
1. 워크스페이스 → **앱 +등록하기** → appName 에 `__APP_SLUG__` 입력. 이미 쓰는 이름이면 다른 이름으로 등록하고 `web/apps-in-toss.config.ts` 의 `appName` 을 같은 값으로 바꾼다.
2. 테스트할 사람은 워크스페이스 멤버여야 한다 (토스 앱 로그인, 만 19세 이상).
3. 토스 로그인·인앱 결제·토스페이·프로모션을 쓰려면 워크스페이스 **내 정보**에서 사업자 등록이 먼저 필요하다. 인앱 광고만 쓰면 당장은 없어도 된다.

## 빌드와 업로드
```bash
cd web
npm install
npm run build:ait            # AIT_EXPORT=1 next build → out/ → ait build → __APP_SLUG__.ait
npx ait deploy --api-key <키> -m "메모"   # 콘솔 '키' 메뉴에서 발급한 API 키
```
- 업로드할 때마다 `deploymentId` 가 새로 생기고 테스트 스킴 `intoss-private://__APP_SLUG__?_deploymentId=...` 이 나온다. 토스 앱에서 이 스킴(또는 콘솔 QR)으로 테스트한다. `intoss://__APP_SLUG__` 는 출시 후에만 열린다.
- Slack 파이프라인을 쓰면 위 과정을 봇이 한다: PR마다 테스트 번들을 올려 테스트 링크를 스레드에 남기고, [배포] 때 main 번들을 올린다. API 키는 봇 서버에만 있고 이 레포에는 없다.
- 번들은 압축 해제 기준 100MB 이하. 큰 이미지·영상은 번들 밖(CDN)에 둔다.

## 출시 (사람이 콘솔에서)
업로드만으로는 사용자에게 나가지 않는다. 콘솔 **앱 출시**에서:
1. 업로드한 번들로 토스앱 테스트를 최소 1번 한다 (테스트해야 검토 요청 가능).
2. 앱 정보(부제, 상세 설명, 로고 600×600 PNG, 카테고리, 고객문의 이메일)를 채우고 **검토 요청**.
3. 승인되면 **출시하기**. 1시간쯤 뒤 토스 미니앱 목록에 반영된다. 새 버전도 매번 검토 → 승인 → 출시를 거친다.
4. 문제가 생기면 같은 메뉴에서 이전 버전을 골라 다시 출시(롤백)한다.

## 코드 규칙
- 미니앱 번들에는 서버가 없다. Next.js API 라우트·서버 액션·요청 시점 렌더링을 쓰지 않는다. 서버가 필요하면 `backend/`(AWS Lambda)를 HTTPS로 부른다.
- 외부 API 서버는 CORS 허용 Origin 에 `https://__APP_SLUG__.apps.tossmini.com`(운영)과 `https://__APP_SLUG__.private-apps.tossmini.com`(QR 테스트)을 넣는다.
- 토스 앱에서는 HTTPS만 허용되고, iOS는 서드파티 쿠키를 막는다. 쿠키 대신 토큰 인증을 쓴다.
- 토스 기능(로그인, 결제, 광고, 공유 등)은 `@apps-in-toss/web-framework` SDK를 쓴다. 공식 문서의 출시 체크리스트(비게임)를 지킨다: https://developers-apps-in-toss.toss.im/checklist/app-nongame.md
- 앱인토스 서버 API(토스 로그인 토큰 교환, 결제, 푸시, 포인트)는 mTLS 인증서가 필요하다. 콘솔 **개발 > mTLS 인증서**에서 앱마다 발급하고, 인증서·개인 키는 레포에 넣지 않고 백엔드 비밀값(예: AWS Secrets Manager)으로 둔다. 서버가 방화벽을 쓰면 `apps-in-toss-api.toss.im` 등으로 나가는 443을 연다.
