# OK골프 레슨 예약 — PWA 프로토타입

정의서 3-2 핵심 기능 구현: **단골 1탭 재예약(F1) · 슬롯 시간대 접기(F2·F3) · 정보 자동채움(F5) · 예약확인 통합(F6)** + 트랜잭션 예약 + 보안 규칙.

PWA가 Firebase(Firestore + Auth)에 직접 연결. Render는 정적 파일만 서빙.

---

## 빠른 시작 (5단계, 약 10분)

### 1) Firebase 프로젝트 만들기
1. https://console.firebase.google.com → 프로젝트 추가
2. **Authentication** → 시작하기 → 로그인 방법에서 **이메일/비밀번호**, **Google** 둘 다 사용 설정
3. **Firestore Database** → 데이터베이스 만들기 → 프로덕션 모드 → 위치 asia-northeast3(서울)

### 2) 설정 키 입력
- 프로젝트 설정(⚙️) → 일반 → 내 앱 → 웹앱 추가(</>)
- 표시되는 `firebaseConfig` 6개 값을 `public/js/firebase-config.js`에 붙여넣기
- (미입력 시 앱 상단에 노란 안내 배너가 뜸)

### 3) 보안 규칙 적용
- Firestore → 규칙 탭 → `firestore.rules` 내용 전체 붙여넣기 → 게시

### 4) 로컬 실행 & 초기 데이터
```bash
npm install
npm start          # http://localhost:3000
```
1. `http://localhost:3000` 에서 **회원가입**(이름·연락처 포함) 후 로그인
2. **본인을 admin으로 승격** (슬롯 생성 권한):
   - Firestore → users → 본인 문서 → `role` 필드를 `member` → `admin`으로 수정
3. `http://localhost:3000/seed.html` 접속 → "테스트 데이터 생성하기" 클릭
   - 프로 3인 · 레슨 4종 · 7일치 슬롯 자동 생성
4. `/` 로 돌아가 예약 테스트

### 5) Render 배포
- GitHub에 푸시 후 Render → New → Web Service
- Build Command: `npm install`
- Start Command: `npm start`
- 배포 URL을 모바일에서 열고 "홈 화면에 추가" → PWA 설치

---

## 화면 동선 (정의서 3-2)

```
로그인 → 홈 ┬ [다가오는 예약] 상시 노출 (F6)
            ├ [지난 예약과 동일하게] 1탭 → 바로 날짜선택 (F1)
            └ [+ 다른 프로·시간] → STEP1(프로+레슨) → STEP2(날짜+시간대접기, F2·F3)
                                    → 확정(정보 자동채움, F5) → 완료=예약확인 통합(F6)
```

## 검증 포인트
- **단골 1탭**: 한 번 예약하면 다음 홈 진입 시 "지난 예약과 동일하게" 카드 노출
- **슬롯 접기**: 가능 슬롯 가장 많은 시간대 자동 펼침, 빈 시간대 흐리게 닫힘
- **자동채움**: 확정 화면에 이름·연락처 자동 입력
- **동시 예약 방지**: 트랜잭션으로 open→booked 원자 처리 (이미 찬 슬롯은 거부)
- **예약확인 통합**: 완료 화면에 예약 카드 + 캘린더 추가 버튼 즉시 노출

## 운영 전환 시
- `public/seed.html` **삭제** (테스트 데이터 생성 도구)
- Render 유료 플랜($7/mo)로 슬립 제거
- 실제 프로/레슨/슬롯은 관리자 콘솔(차기 구현) 또는 콘솔에서 관리

## 기술 스택
PWA(HTML/CSS/JS) · Firebase Auth + Firestore · Express(Render) · Node 18+
