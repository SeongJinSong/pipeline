export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-6">
      <h1 className="text-3xl font-bold">__APP_NAME__</h1>
      <p className="text-zinc-600">__APP_ONE_LINER__</p>
      <p className="text-sm text-zinc-400">
        Slack 채널에 요구사항을 남기면 이 화면이 바뀝니다.
      </p>
    </main>
  );
}
