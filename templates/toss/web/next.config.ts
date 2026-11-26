import type { NextConfig } from "next";

// AIT_EXPORT=1 (npm run build:ait) 이면 앱인토스 번들용 정적 사이트를 out/ 에 만든다.
// 그 외(Vercel, npm run dev)에는 일반 Next.js 로 동작한다. 그래서 서버 기능(API 라우트, 서버 액션,
// 요청 시점 렌더링)은 쓰지 않는다: 미니앱 번들에는 서버가 없다. 서버가 필요하면 backend/(AWS Lambda)를 쓴다.
const forAppsInToss = process.env.AIT_EXPORT === "1";

const nextConfig: NextConfig = forAppsInToss
  ? { output: "export", trailingSlash: true, images: { unoptimized: true } }
  : {};

export default nextConfig;
