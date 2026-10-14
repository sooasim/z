# Runbook — 서버 1대에 플랫폼 올리기 + 도메인 연결

(Single-server deployment: the whole JETPOOL stack on one Ubuntu 22.04 VM behind Caddy, with its own
Let's Encrypt certificates. Korean, because the operator of this box reads Korean.)

대상: Ubuntu 22.04 · 2 vCPU · 8 GB RAM · SSD 50 GB 한 대. 이 사양으로 **전체 스택**(web, api, worker,
PostgreSQL, Redis, Meilisearch, MinIO, Caddy)이 돌아갑니다. 관리형 환경(ECS / k8s / Fly)에 올릴 때는
이 문서가 아니라 `infra/scripts/deploy.sh` 와 `.github/workflows/deploy-*.yml` 을 쓰세요.

사용하는 파일은 모두 `infra/single-server/` 안에 있습니다.

| 파일 | 역할 |
|---|---|
| `bootstrap.sh` | 서버 1회 준비: Docker, swap, 방화벽, UTC 시계 |
| `jetpool.sh` | 실제 운영 명령 전부 (init / deploy / seed / logs / backup …) |
| `docker-compose.prod.yml` | 9개 서비스 정의 |
| `Caddyfile` | 도메인 + HTTPS (운영용) · `Caddyfile.ip` 는 IP 임시 확인용 |
| `.env.example` | 설정 템플릿. 실제 `.env` 는 `jetpool.sh init` 이 만들고 git에 올라가지 않습니다 |

---

## 무엇이 어디로 열리는가

인터넷에서 접근 가능한 것은 **Caddy의 80 / 443 뿐**입니다. PostgreSQL · Redis · Meilisearch ·
MinIO 콘솔은 호스트 포트에 아예 노출되지 않고, API와 MinIO의 S3 포트는 `127.0.0.1` 에만 묶입니다
(서버 안에서 `curl` 로 확인하거나 SSH 터널로 볼 때만 사용).

| 주소 | 가는 곳 | 비고 |
|---|---|---|
| `https://도메인` | web (Next.js) | `www.` 는 여기로 301 |
| `https://api.도메인` | api (Fastify) | `/metrics`, `/docs` 는 edge에서 404로 차단 |
| `https://s3.도메인` | MinIO | 브라우저 직접 업로드(presigned PUT) + 공개 미디어 |

`s3.도메인` 이 왜 공개되어야 하는지: 사진·서류 업로드는 웹서버를 거치지 않고 브라우저가 스토리지로
바로 PUT 합니다(STAY-02). presigned 서명에 **호스트와 경로가 포함**되므로 내부 주소로 바꿔치기할 수
없고, 경로 앞에 `/s3` 같은 접두어를 붙여 프록시할 수도 없습니다.

---

## 0단계 — 클라우드 콘솔에서 먼저 할 일

지금 이 서버에는 **공인 IP가 없습니다**(사설 192.168.x.x 만 있음). 공인 IP가 없으면 외부에서 접속도,
Let's Encrypt 인증서 발급도 불가능합니다.

1. **공인 IP 할당** — 콘솔에서 이 서버(`Server-261014134258`)에 공인 IP를 붙입니다.
2. **보안 그룹 인바운드 허용** — 보안 그룹에 아래 3개를 엽니다.

| 포트 | 프로토콜 | 원본 | 왜 |
|---|---|---|---|
| 22 | TCP | 내 사무실/집 IP 만 | SSH. `0.0.0.0/0` 로 열지 마세요 |
| 80 | TCP | `0.0.0.0/0` | **필수.** Let's Encrypt가 HTTP로 소유 확인 후 인증서를 발급/갱신합니다 |
| 443 | TCP | `0.0.0.0/0` | HTTPS 서비스 |

> 80을 닫아두면 HTTPS도 영구히 실패합니다(발급 자체가 안 됨). 갱신도 90일마다 80으로 일어납니다.

3. **비밀번호 로그인 → SSH 키**로 바꾸는 것을 권합니다. 지금 쓰고 있는 비밀번호는 채팅/메모에 한 번
   노출되었으므로, 접속 후 `passwd` 로 즉시 교체하고 키 기반 로그인으로 전환하세요.

---

## 1단계 — 접속하고 서버 준비

```bash
ssh ubuntu@<공인-IP>        # 또는 root@<공인-IP>
sudo passwd $(whoami)        # 노출된 비밀번호 교체
```

```bash
sudo apt-get update && sudo apt-get install -y git
git clone <이-저장소-URL> ~/jetpool     # 비공개 저장소면 deploy key 또는 PAT 사용
cd ~/jetpool
sudo bash infra/single-server/bootstrap.sh
```

`bootstrap.sh` 가 하는 일: 시계를 **UTC**로(앱이 `toISOString()` 기준으로 기간 경계를 계산합니다),
Docker Engine + compose 플러그인 설치, **4 GB swap**(8 GB에서 Next.js 빌드가 메모리 정점), 컨테이너
로그 로테이션(10 MB × 5), 호스트 방화벽 ufw 22/80/443, 로그인 사용자를 `docker` 그룹에 추가.

그룹 변경이 적용되도록 **한 번 로그아웃 후 재접속**하세요 (`newgrp docker` 도 가능).

---

## 2단계 — 도메인 연결 (DNS)

### 2-1. 레코드 4개를 추가합니다

도메인을 산 곳(가비아·후이즈·Cloudflare·Route 53 등)의 **DNS 관리 / 레코드 설정** 화면에서,
`<공인-IP>` 를 가리키는 A 레코드를 만듭니다. `example.com` 을 실제 도메인으로 바꿔 읽으세요.

| 호스트(이름) | 타입 | 값 | TTL |
|---|---|---|---|
| `@` (또는 비워둠 / `example.com`) | A | `<공인-IP>` | 300 |
| `www` | A | `<공인-IP>` | 300 |
| `api` | A | `<공인-IP>` | 300 |
| `s3` | A | `<공인-IP>` | 300 |

- `@` 는 도메인 자체(apex)를 뜻합니다. 가비아 등 일부 UI에서는 호스트 칸을 **비워두거나** `@` 를 넣습니다.
- `www`·`api`·`s3` 는 A 대신 `example.com` 을 가리키는 **CNAME**으로 해도 됩니다. apex(`@`)는 CNAME이
  규격상 불가하니 반드시 A로 두세요.
- TTL은 처음에 300초(5분)로 두면 잘못 입력했을 때 빨리 고쳐집니다. 안정화 후 3600으로 올리세요.
- 도메인 등록기관의 **네임서버**를 다른 DNS 서비스(Cloudflare 등)로 바꿨다면, 레코드는 그 서비스 쪽에
  넣어야 합니다. 양쪽에 나눠 넣으면 반영되지 않습니다.

### 2-2. Cloudflare를 쓴다면

레코드의 프록시 상태를 **DNS only(회색 구름)** 로 두고 시작하세요. 주황 구름(프록시 ON) 상태에서는
Cloudflare가 자기 인증서로 TLS를 종료하므로 Caddy의 HTTP-01 발급이 실패할 수 있고, `s3` 는 프록시의
업로드 크기 제한에 걸립니다. 전부 정상 동작한 뒤에 web 호스트만 프록시를 켜고(SSL 모드는 **Full
(strict)**), `api` 와 `s3` 는 DNS only로 남기는 것을 권합니다.

### 2-3. 전파 확인

```bash
dig +short example.com A
dig +short www.example.com A
dig +short api.example.com A
dig +short s3.example.com A
```

4개 모두 공인 IP가 나와야 다음 단계로 갑니다. 보통 수 분, 네임서버를 막 바꿨다면 최대 수 시간입니다.
아직이라면 그 사이에 아래 "도메인 없이 먼저 확인하기"로 동작만 점검해 두세요.

---

## 3단계 — 설정과 배포

```bash
cd ~/jetpool
./infra/single-server/jetpool.sh init --domain example.com --email you@example.com
./infra/single-server/jetpool.sh deploy
```

`init` 은 `infra/single-server/.env` 를 만들고 공개 주소들을 채우며, 비밀값
(`JWT_SECRET`, `DATA_ENCRYPTION_KEY`, DB/MinIO/Meili 비밀번호, 데모 로그인 비밀번호)을 난수로
생성합니다. **다시 실행해도 이미 들어있는 비밀값은 건드리지 않습니다** — `JWT_SECRET` 을 바꾸면 모든
세션이 로그아웃되고, `DATA_ENCRYPTION_KEY` 를 바꾸면 이미 암호화된 데이터(MFA 시크릿)를 못 읽습니다.
`.env` 는 이 플랫폼의 모든 비밀을 담고 있고 git에 올라가지 않으니 **별도로 안전하게 백업**하세요.

`deploy` 는 이미지 2개 빌드 → 마이그레이션(forward-only) → 전체 기동 → smoke 테스트까지 합니다.
**첫 빌드는 2 vCPU에서 10~25분** 걸립니다. 중간에 끊기면 그냥 다시 실행하면 됩니다(캐시가 남습니다).

끝나면 이렇게 확인됩니다.

```
  ok   /health 200
  ok   /ready {"status":"ready"}
  ok   web through caddy (200)
  ok   https://example.com/
  ok   https://api.example.com/health
```

인증서는 Caddy가 처음 요청 때 자동으로 받아오고(수십 초), 이후 알아서 갱신합니다.

### 데모 콘텐츠와 로그인

```bash
./infra/single-server/jetpool.sh seed     # 숙소 24개, 가이드, 여행상품, 레거시 WONT 페이지, 번역 캐시
./infra/single-server/jetpool.sh logins   # 생성된 로그인 정보 다시 보기
```

- 회원 로그인: `https://example.com/login` — 페르소나 이메일은 seed 출력에 표시, 비밀번호는 `logins` 출력
- 관리자 콘솔: `https://example.com/admin/login` — 핸들 `admin`, 비밀번호는 `logins` 출력
- 관리자(staff) 화면은 **AAL2 세션**이 필요합니다. 첫 로그인에서 인증 앱(OTP)을 등록하세요.
- 메인 페이지(`/`)는 **Admin → Content → Main page**(`/admin/home`)에서 편집합니다.

seed는 멱등합니다(여러 번 돌려도 중복이 안 생김). `NODE_ENV=production` 에서는 실행을 거부합니다.

---

## 도메인 없이 먼저 확인하기 (선택)

DNS 전파를 기다리는 동안 공인 IP로 동작만 점검할 수 있습니다.

```bash
./infra/single-server/jetpool.sh init --ip <공인-IP>
./infra/single-server/jetpool.sh deploy
# http://<공인-IP>        web
# http://<공인-IP>:4000   api
```

이 모드는 **TLS가 없습니다** — 비밀번호와 세션이 평문으로 흐릅니다. 점검용으로만 쓰고, 실제 사용자가
접속하기 전에 `init --domain ... --email ...` 로 다시 설정하고 `deploy` 하세요(공개 주소가 웹 번들과
CSP에 박히므로 `up` 이 아니라 `deploy` 여야 합니다). IP 모드는 4000/9000 포트를 외부로 여니, 보안
그룹에서 임시로 열었다면 전환 후 **다시 닫으세요**.

---

## 평소 운영

```bash
./infra/single-server/jetpool.sh ps              # 상태
./infra/single-server/jetpool.sh logs api        # 로그 따라가기 (web / worker / caddy / postgres …)
./infra/single-server/jetpool.sh smoke           # 헬스 재확인
./infra/single-server/jetpool.sh backup          # pg_dump → infra/single-server/backups/*.sql.gz
./infra/single-server/jetpool.sh update          # git pull + 재빌드 + 재배포
./infra/single-server/jetpool.sh psql            # DB 셸
./infra/single-server/jetpool.sh prune           # 오래된 이미지/빌드 캐시 정리 (디스크 확보)
./infra/single-server/jetpool.sh down            # 전체 정지 (데이터 볼륨은 유지)
```

### 백업 — 두 군데를 받아야 합니다

1. **DB**: `jetpool.sh backup`. 매일 새벽으로 cron에 걸어두세요.
   ```bash
   sudo crontab -e
   # 매일 03:10 UTC (12:10 KST)
   10 3 * * * cd /home/ubuntu/jetpool && ./infra/single-server/jetpool.sh backup >> /var/log/jetpool-backup.log 2>&1
   ```
2. **미디어**: `miniodata` 도커 볼륨.
   ```bash
   docker run --rm -v jetpool_miniodata:/data:ro -v "$PWD/infra/single-server/backups:/out" \
     alpine tar czf /out/media-$(date -u +%Y%m%d).tar.gz -C /data .
   ```
   두 백업 모두 **서버 밖**(오브젝트 스토리지, 다른 서버)으로 복사하세요. 서버가 통째로 사라지면
   같은 디스크 위의 백업도 같이 사라집니다.

복구 절차와 분기 리허설은 `docs/runbooks/db-restore-drill.md` 를 따릅니다.

---

## 실서비스(결제 포함) 전환 체크리스트

현재 `.env` 는 `NODE_ENV=staging` 입니다. 실제 돈과 실제 로그인을 받으려면 아래를 모두 채운 뒤에
`NODE_ENV=production` 으로 올리세요. production에서는 API가 **MOCK 결제와 mock OAuth로는 아예 기동하지
않습니다**(`apps/api/src/platform/config.ts`).

| 항목 | `.env` 키 | 비고 |
|---|---|---|
| 토스페이먼츠 | `PAYMENT_PROVIDER=TOSS`, `TOSS_SECRET_KEY`, `TOSS_CLIENT_KEY`, `TOSS_WEBHOOK_SECRET` | 가맹점 계약 후 발급. 웹훅 수신 주소 `https://api.도메인/v1/webhooks/toss` |
| 소셜 로그인 | `OAUTH_MOCK=false` + `GOOGLE_*` / `KAKAO_*` / `NAVER_*` | 각 제공자 콘솔에 redirect URI 등록: `https://도메인/auth/callback/google`, `.../kakao`, `.../naver` (웹 주소 기준 — `PUBLIC_WEB_URL` 로 만들어집니다) |
| 메일 발송 | `SMTP_URL` | 없으면 production에서 인증코드 발송이 거부됩니다 |
| 지오코딩 | `GEOCODER=KAKAO` + `KAKAO_REST_API_KEY` | 기본 `STATIC` 은 키가 필요 없지만 정확하지 않습니다 |
| AI 도우미 | `ANTHROPIC_API_KEY` | 기능 플래그 `ai.assistant` 는 기본 OFF |

바꾼 뒤 `./infra/single-server/jetpool.sh deploy`. 또 production 전에 법무/세무 승인이 필요한 항목은
릴리스 게이트 G9(`docs/CHECKLIST.md`)에 정리돼 있습니다.

> 서버 1대 구성은 **단일 장애점**입니다. 이 서버가 죽으면 서비스 전체가 멈추고, 복구는 백업에서
> 되살리는 시간이 걸립니다. 운영 SLO(가용성 99.9 %, `docs/OPERATIONS.md`)를 실제로 지키려면
> 관리형 DB + 다중 인스턴스 구성으로 옮겨야 합니다. 초기 오픈/시연 단계에는 이 구성으로 충분합니다.

---

## 문제가 생기면

**인증서가 발급되지 않음 / `https` 가 안 열림**
```bash
./infra/single-server/jetpool.sh logs caddy
```
거의 항상 셋 중 하나입니다. ① DNS A 레코드가 아직 이 서버를 가리키지 않음(`dig +short api.도메인`),
② 보안 그룹에서 **80**이 막혀 있음, ③ Cloudflare 프록시가 켜져 있음. Let's Encrypt는 실패를 반복하면
속도 제한에 걸리니, 원인을 고친 뒤 `jetpool.sh restart caddy` 로 다시 시도하세요.

**API가 ready가 되지 않음**
```bash
./infra/single-server/jetpool.sh logs api
./infra/single-server/jetpool.sh logs migrate
```
환경변수 검증 실패(키 길이/형식), 마이그레이션 실패, DB 연결 중 하나가 로그 첫 줄에 나옵니다.

**업로드가 안 되고 콘솔에 CSP 오류**
`s3.도메인` A 레코드와 인증서를 확인하세요. 주소를 바꿨다면 반드시 `deploy`(재빌드)여야 합니다 —
스토리지 주소는 빌드 시점에 웹 번들과 CSP에 박힙니다.

**빌드 중 메모리 부족 / 컨테이너가 죽음**
```bash
free -h && swapon --show     # bootstrap.sh 가 만든 4 GB swap 이 보여야 합니다
docker stats --no-stream
```

**디스크가 찼다**
```bash
df -h
./infra/single-server/jetpool.sh prune
docker system df
```
50 GB에서 이미지 2개 + 빌드 캐시가 가장 큽니다. 배포 후 `prune` 을 습관으로 두세요.

**포트 80/443이 이미 사용 중** — 이 서버에 nginx/apache가 깔려 있으면 Caddy가 바인딩에 실패합니다.
`sudo ss -tlnp | grep -E ':(80|443)'` 로 확인하고 기존 웹서버를 멈추세요.
