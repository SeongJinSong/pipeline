import { defineConfig } from "@apps-in-toss/web-framework/config";

// 앱인토스(토스 미니앱) 설정. appName 은 앱인토스 콘솔에 등록한 appName 과 같아야 업로드된다 (등록 후 변경 불가).
// 자세한 운영 방법: docs/apps-in-toss.md
export default defineConfig({
  appName: "__APP_SLUG__",
  // 카메라·위치 등 기기 권한이 필요하면 여기에 추가한다 (예: { name: "geolocation", access: "access" })
  permissions: [],
  // `npm run build:ait` 가 Next.js 정적 내보내기(out/)를 만든 뒤 이 폴더를 .ait 번들로 묶는다
  webBundleDir: "out",
});
