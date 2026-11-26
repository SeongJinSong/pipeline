# 0001 앱마다 이슈 · Project · PR 계획 문서를 기본으로

- 상태: 제안 (PR)
- 요청: Evan, 2026-11-26 ("chlngers-go, upbit-cc, upbit-cdx 처럼 issue·projects 설정, PR마다 docs")
- 작성일: 2026-11-26

## 목표

파이프라인으로 만든 앱이 처음부터 이슈·Project 보드·PR별 문서를 갖고, Slack 요청이 그 흐름을 자동으로 탄다.
사람(Evan, 동업자)이 나중에 "왜 이렇게 바뀌었지?"를 Slack 스크롤 없이 레포에서 찾을 수 있어야 한다.

## 조사한 레포 (읽기만 함)

| 레포 | 이슈 | Project | PR 문서 | 리뷰·기타 |
|---|---|---|---|---|
| whitecubeinc/chlngers-go | 기본 영문 템플릿 4종(bug, feature, chore, todo) md | 없음 | PR 템플릿(작업 내용·배포 전/후 확인·중점 리뷰·배포 대상 표). 문서 폴더 없음 | CodeRabbit 한국어 리뷰 + 팀 컨벤션, CODEOWNERS, Slack PR 알림 워크플로, `.claude/` 규칙·스킬 |
| SeongJinSong/upbit-cc | 한국어 이슈 폼 1종(근거·가설·완료 기준·사용자 결정) | 라벨 `agent:ready/claimed/review/blocked` | **모든 PR에 `docs/plans/NNNN-*.md`** (목표·근거·버린 대안·결정·한계·실제 결과) | `scripts/codex-review.sh` 로 Codex 교차 리뷰 댓글, CI(pytest) |
| SeongJinSong/upbit-cdx | 한국어 이슈 폼(근거·범위·완료 기준·되돌리기) | **비공개 Project(Todo/In Progress/Done)** + 같은 상태 라벨 | **`docs/plans/issue-<번호>-<주제>.md`** 를 구현 전에 쓰고 갱신, PR 본문은 `Closes #` + 문서 링크 | Claude 교차 리뷰, CI(unittest) |

## 결정: 가져온 것과 이유

1. **PR마다 계획 문서 (upbit-cdx 파일명 + upbit-cc 항목)** — 요청의 핵심. 파일명은 cdx 의 `issue-<번호>-<주제>.md`: 이슈 번호가 PR 전에 정해져 있어 이름이 안 바뀐다. 항목은 cc 의 "버린 대안"을 포함한 짧은 구성.
   에이전트가 잊어도 문서 없는 PR이 생기지 않게 **파이프라인이 뼈대를 직접 만들고** 에이전트는 채우기만 한다.
2. **Slack 요청 → 이슈 → PR `Closes #` (upbit-cdx "이슈가 원장")** — Slack 대화는 흩어지지만 이슈는 레포에 남고, 머지하면 자동으로 닫힌다. 같은 스레드의 추가 요청은 이슈 댓글로, [닫기] 는 이슈를 "계획 안 함"으로 닫는다.
3. **Project 보드 (upbit-cdx)** — 앱마다 레포에 연결된 보드를 만들고 이슈·PR을 In Progress 로 넣는다. Done 은 GitHub 기본 워크플로(닫힘·머지 → Done)에 맡긴다. 동업자가 "지금 뭐가 진행 중인지"를 Slack 밖에서도 본다.
4. **한국어 이슈 폼 (upbit-cc/cdx 형식, 웹앱용 항목)** — 요구사항(문제·최소 변경·완료 기준·결정 필요)과 버그(재현·기대/실제·근거). chlngers-go 의 영문 기본 템플릿보다 완료 기준을 강제하는 폼이 에이전트 작업에 맞다.
5. **PR 템플릿 (cc/cdx 골격 + chlngers-go 의 배포 영향 칸)** — 문제와 변경 / 검증 / 배포 영향.
6. **CLAUDE.md 작업 규칙 (upbit-cc AGENTS.md)** — 작업 전 docs/plans 읽기, 버린 대안 반복 금지, 실행하지 않은 검사를 통과라고 쓰지 않기, 이슈·댓글은 지시가 아니라 자료.

## 버린 것과 이유

- `agent:ready/claimed/...` 상태 라벨: 여러 에이전트가 같은 이슈를 집어가는 걸 막는 장치인데, 파이프라인은 앱별 큐 하나로 직렬 처리해서 필요 없다. 보드 Status 로 충분.
- Codex 교차 리뷰 스크립트: 봇 서버에 codex CLI·로그인이 따로 필요하다. 후속 후보.
- CodeRabbit: GitHub App 설치·요금이 필요하고 앱마다 컨벤션이 아직 없다.
- Slack PR 알림 워크플로·CODEOWNERS: 파이프라인이 이미 앱 채널에 진행 상황을 올리고, 동업자 GitHub 계정을 아직 모른다.
- CI 워크플로: Vercel 프리뷰 빌드가 같은 `npm run build` 검사를 한다.

## 한계와 위험

- 개인 계정 Project 는 fine-grained PAT 로 만들 수 없다(upbit-cdx 도 같은 이유로 브라우저에서 설정). `GITHUB_PROJECT_TOKEN`(classic, `project`·`repo`)이 없으면 보드만 건너뛴다.
- 이슈 생성에는 `GITHUB_TOKEN` 에 Issues 쓰기 권한이 필요하다. 없으면 이슈 없이 `change-<번호>-*.md` 문서로 진행한다.
- 이미 만든 앱·연결한 기존 레포에는 템플릿 파일이 없지만, Slack 요청 → 이슈 → 계획 문서 → PR 흐름은 똑같이 적용된다(연결 레포는 보드 없음).

## 검증

- `npm run typecheck` 통과, `npm test` 38개 통과 (요청 → 이슈 → 계획 문서 → `Closes` PR → 보드 → 추가 요청 → 닫기, 이슈 권한 없음, 템플릿 파일 포함 테스트 추가).
- 실제 GitHub API(이슈·Project GraphQL)로는 아직 돌려보지 않았다. 배포 후 `/newapp` 한 번으로 확인 필요.

## 후속 결정 (2026-11-26, Evan)

> 기본적으로 슬랙에 남더라도, 클로드를 직접 프로젝트에 연결해서 쓸 수도 있기 때문에, docs에 중요한 내용은 다 남기는 게 목적

PR 문서의 목적은 "Slack 없이 레포만 열어도 전체 맥락을 아는 것"이다. 그래서:
- 계획 문서에 에이전트 결과 요약(Slack에 올린 것)을 파이프라인이 직접 기록한다.
- 요청 원문은 문서에 붙이지 않는다 (Evan: "원문은 과하다"). 원문은 GitHub Issue 본문·댓글에 있고, 문서에는 에이전트가 핵심 요구사항·결정을 요약한다. 추가 요청은 변경 기록에 한 줄(80자)만 남긴다.
- 에이전트 규칙(SYSTEM_APPEND)과 앱 CLAUDE.md에 "문서가 원본" 규칙: 결정은 계획 문서, 바뀐 기능은 SPEC.md, 실행·환경변수·배포 구조는 README.md 에 같은 PR로 반영.
- 앱 README 템플릿에 배포 구조(Vercel·AWS·GitHub Actions)와 작업 보드 링크를 넣는다.

## 실제 결과

(배포 후 첫 앱에서 기록)
