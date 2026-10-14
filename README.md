# 조물조물 — 나만의 찰흙 친구 만들기

브라우저에서 돌아가는 3D 찰흙 공방입니다. 기본 반죽(사람·고양이·강아지·토끼·곰·덩어리)을 고르고,
마우스로 찰흙을 빚듯 모양을 바꾸고, 가마에 구운 뒤 색칠해서 나만의 캐릭터를 만듭니다.

## 실행

```bash
pnpm install
pnpm dev        # http://localhost:5173  (Express + Vite 미들웨어, 한 포트)
pnpm build      # 타입 검사 + dist/ 빌드
pnpm start      # 프로덕션 서버 (dist/ + /api)
```

## 서버 · 배포 (Replit)

`server/index.ts` 하나가 프론트엔드와 API를 같이 서빙합니다. `.replit`에 Autoscale 배포 설정이 있습니다.

| 환경 변수 | 용도 |
| --- | --- |
| `DATABASE_URL` | 모두의 작품(공개 갤러리) 저장소. Replit PostgreSQL을 붙이면 자동 설정. 없으면 `data/works/`에 파일로 저장(로컬 개발용) |
| `AI_INTEGRATIONS_ANTHROPIC_API_KEY`, `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` | Replit AI Integrations(Anthropic, Replit managed). 유료 플랜 필요, 사용량은 Replit 크레딧에서 차감 |
| `ANTHROPIC_API_KEY` | 위 대신 내 키를 쓸 때 |
| `AI_MODEL` | 기본 `claude-sonnet-4-6` |
| `AI_PER_IP_LIMIT`, `AI_DAILY_LIMIT` | AI 반죽 호출 제한 (기본 IP당 10분 8회, 하루 전체 400회) |

API: `GET /api/works` · `GET /api/works/:id/{thumb,mesh}` · `PUT /api/works/:id` (작품 토큰으로 본인만 덮어쓰기) ·
`DELETE /api/works/:id` · `POST /api/ai/shape` · `GET /api/config`

## 흐름

1. **고르기** — 기본 반죽과 세밀함(해상도)을 고릅니다. **✨ AI와 첫 모형 만들기**에 "날개 달린 아기 용"처럼 적으면
   Claude가 같은 SDF 원시 도형 형식으로 첫 반죽을 잡아 주고(`server/ai.ts`), 그 뒤로는 직접 빚습니다.
   **📂 GLB 불러오기**로 기존 모델(.glb)을 가져와 이어서 빚을 수도 있습니다(`src/importer.ts`).
   랜딩 배경에는 다른 사람들이 공개한 작품이 최대 15개 무작위로 떠다니고, 눌러서 감상하거나 이어 빚을 수 있습니다. 반죽은 SDF(부호 거리 함수)로 정의된 원시 도형들을
   smooth-min으로 섞은 뒤 마칭큐브로 메시를 뽑아 만듭니다 (`src/bases.ts`, `src/sdf.ts`, `src/mesher.ts`).
2. **빚기** — 당기기·밀기·부풀리기·매끄럽게·잡아끌기·평평하게 6가지 붓. 좌우 대칭, 되돌리기/다시 실행 지원 (`src/sculpt.ts`).
3. **굽기** — 가마 연출과 함께 모양이 굳고(약간 수축) 테라코타 색으로 바뀝니다 (`src/bake.ts`).
4. **색칠** — 정점 색 기반 붓·지우개·전체 칠하기·색 뽑기, 유약 광택 (`src/paint.ts`).
5. **완성** — 저장하면 IndexedDB(내 작품)에 저장되고, "모두의 작품에 공개"가 켜져 있으면 서버에도 올라갑니다
   (`src/storage.ts`, `src/cloud.ts`). GLB·PNG 내려받기, 턴테이블 감상 (`src/exporter.ts`).

## 조작

| 동작 | 입력 |
| --- | --- |
| 빚기 / 색칠 | 찰흙 위에서 왼쪽 드래그 |
| 돌려보기 | 오른쪽 드래그 또는 빈 곳 왼쪽 드래그 |
| 확대·축소 / 이동 | 휠 / 가운데 드래그 |
| 붓 크기 / 세기 | `[` `]` / `-` `=` |
| 도구 바꾸기 | `1`~`6` (색칠은 `1`~`4`) |
| 좌우 대칭 | `M` |
| 잠깐 매끄럽게 / 반대로 | `Shift` 드래그 / `Alt` 드래그 |
| 되돌리기 / 다시 실행 | `⌘Z` / `⇧⌘Z` |

## 구조

```
index.html          화면 뼈대(패널·오버레이·갤러리·도움말)
src/main.ts         단계 상태 머신, 포인터·키보드 입력, 패널 배선
src/scene.ts        렌더러·카메라·조명·물레(받침대)
src/sdf.ts          SDF 원시 도형 + smooth-min
src/bases.ts        기본 반죽 정의
src/mesher.ts       마칭큐브 → 인덱스 메시, 인접 리스트, Taubin 스무딩
src/sculpt.ts       조각 붓
src/paint.ts        정점 색칠
src/bake.ts         굽기 연출·재질 전환
src/storage.ts      IndexedDB 저장(idb-keyval)
src/cloud.ts        서버 통신: 공개 갤러리, 메시 압축(gzip) 업로드, AI 반죽 요청
src/importer.ts     GLB 불러오기: 메시 합치기·용접·정규화·텍스처→정점색·세분화
server/index.ts     Express: /api + 프론트엔드(개발=Vite 미들웨어, 운영=dist)
server/store.ts     공개 작품 저장소 (Postgres / 로컬 파일)
server/ai.ts        Claude로 첫 반죽 SDF 생성 + 검증·정규화
src/exporter.ts     GLB / PNG 내보내기
src/ui.ts           DOM 헬퍼
```

## 다음에 할 만한 것

- 계정·좋아요·신고(지금은 브라우저별 작품 토큰으로만 소유를 구분)
- 동적 토폴로지(국소 재메싱) — 크게 당겨도 삼각형이 늘어나지 않게
- UV 전개 후 텍스처 색칠 — 정점 색보다 또렷한 무늬·스티커
- 부품 붙이기(눈·모자·날개 같은 파츠를 찰흙에 눌러 붙이기)
- 모바일 터치 최적화(두 손가락 회전·확대는 이미 동작)
