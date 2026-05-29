// ============================================================
// app.js — OK골프 예약 PWA
// 정의서 3-2 구현: 단골1탭(F1) / 슬롯접기(F2·F3) / 정보자동채움(F5) / 예약확인통합(F6)
// ============================================================
import { auth, db, isConfigured, GEMINI_API_KEY } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  onAuthStateChanged, GoogleAuthProvider, signInWithPopup, updateProfile
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  collection, doc, setDoc, getDoc, getDocs, query, where, orderBy, limit,
  runTransaction, serverTimestamp, updateDoc, addDoc, deleteDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";

const $ = (id) => document.getElementById(id);
// 메인 탭(폰 뒤로가기로 빠져나가도 되는 화면)
const MAIN_VIEWS = new Set(["homeView","myView","boardView","adminView","authView","loadingView"]);
const show = (id, opts = {}) => {
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === id));
  window.scrollTo(0, 0);
  // history 관리: 세부 화면 진입 시 스택에 쌓고, 뒤로가기 처리 중이면 스킵
  if (!opts.fromPop) {
    if (MAIN_VIEWS.has(id)) {
      // 메인 탭: 스택 초기화하지 않고 그냥 replace
      history.replaceState({ view: id }, "");
    } else {
      // 세부 화면: 새 항목 push (뒤로가기로 메인으로 돌아옴)
      history.pushState({ view: id }, "");
    }
  }
};
window.show = show;

// 토스트 알림 (3초 후 자동 사라짐)
window.toast = (msg) => {
  const t = $("toast"); if (!t) return;
  t.textContent = msg;
  t.classList.remove("hide");
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => t.classList.add("hide"), 3000);
};

// 큰 데이트 피커: input 값이 바뀌면 옆 레이블을 한국어로 표시
// HTML: <label class="date-picker"><span class="dp-label empty">날짜 선택</span><span class="dp-icon">📅</span><input type="date" ...></label>
window.refreshDatePickerLabel = (inputEl) => {
  const wrap = inputEl.closest(".date-picker");
  if (!wrap) return;
  const label = wrap.querySelector(".dp-label");
  if (!label) return;
  if (!inputEl.value) {
    label.textContent = label.dataset.placeholder || "날짜 선택";
    label.classList.add("empty");
    return;
  }
  const d = new Date(inputEl.value);
  const W = ["일","월","화","수","목","금","토"];
  label.textContent = `${d.getFullYear()}년 ${d.getMonth()+1}월 ${d.getDate()}일 (${W[d.getDay()]})`;
  label.classList.remove("empty");
};

window.finishBooking = () => {
  resetNlSearch();
  show("homeView");
  renderHomeSafe();
  toast("✅ 예약이 완료됐어요");
};

// 자연어 검색 초기화 (예약 완료 시)
window.resetNlSearch = () => {
  const q = $("nlQuery"); if (q) q.value = "";
  const r = $("nlResult"); if (r) r.innerHTML = "";
};
// 폰/브라우저 뒤로가기 → 이전 화면으로
window.addEventListener("popstate", (e) => {
  const target = e.state?.view || "homeView";
  show(target, { fromPop: true });
});

let me = null;          // auth user
let myProfile = null;   // users/{uid} 문서
let draft = { proId: null, proName: null, lessonTypeId: null, lessonName: null,
              date: null, time: null, slotId: null, people: 1 };
let draftWorkHours = null;  // 선택한 프로의 운영시간

// 미설정 시 안내 배너
if (!isConfigured) {
  window.addEventListener("DOMContentLoaded", () => {
    const b = document.createElement("div");
    b.className = "config-warn";
    b.innerHTML = `⚙️ Firebase 미설정 상태입니다. <b>public/js/firebase-config.js</b>의 6개 값을 입력하면 실제 예약이 동작합니다. (README 참고)`;
    document.body.prepend(b);
  });
}

// ---------- 매장 설정 (관리자가 편집) ----------
let storeName = "OK골프";
let bookWindowWeeks = 4;     // 예약 가능 범위(주)
let cutoffHours = 2;         // 예약/취소 마감: 시작 N시간 전
let noShowLimit = 3;         // 노쇼 누적 N회 시 제한
let theme = "dark";          // dark | light (개인 설정, localStorage 미사용→메모리+설정문서)
async function loadStoreName() {
  try {
    const snap = await getDoc(doc(db, "settings", "store"));
    if (snap.exists()) {
      const s = snap.data();
      if (s.name) storeName = s.name;
      if (s.bookWindowWeeks) bookWindowWeeks = s.bookWindowWeeks;
      if (s.cutoffHours != null) cutoffHours = s.cutoffHours;
      if (s.noShowLimit != null) noShowLimit = s.noShowLimit;
    }
  } catch {}
  applyStoreName();
}
function applyStoreName() {
  const a = $("storeLogo"), b = $("storeLogoLoading");
  if (a) a.textContent = storeName;
  if (b) b.textContent = storeName;
  document.title = storeName + " 레슨 예약";
}
// 테마 적용·토글 (개인 설정, users 문서에 저장)
function applyTheme() {
  document.body.setAttribute("data-theme", theme);
  const btn = $("themeBtn");
  if (btn) btn.textContent = theme === "dark" ? "🌙" : "☀️";
}
window.toggleTheme = async () => {
  theme = theme === "dark" ? "light" : "dark";
  applyTheme();
  if (me) { try { await updateDoc(doc(db, "users", me.uid), { theme }); } catch {} }
};

// ---------- 인증 ----------
if (isConfigured) {
  loadStoreName();
  onAuthStateChanged(auth, async (user) => {
    me = user;
    if (user) {
      const ref = doc(db, "users", user.uid);
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        await setDoc(ref, {
          name: user.displayName || "회원", email: user.email, phone: "",
          role: "member", penalty: { noShowCount: 0 }, createdAt: serverTimestamp()
        });
        myProfile = { name: user.displayName || "회원", phone: "", penalty: { noShowCount: 0 } };
      } else {
        myProfile = snap.data();
      }
      $("navUser").textContent = myProfile.name;
      if (myProfile.theme) { theme = myProfile.theme; applyTheme(); }
      document.body.classList.toggle("is-admin", myProfile.role === "admin");
      show("homeView");
      renderHome();
    } else {
      show("authView");
    }
  });
}

window.signup = async () => {
  const name = $("suName").value.trim();
  if (!name) return alert("이름을 입력하세요.");
  try {
    const cred = await createUserWithEmailAndPassword(auth, $("email").value, $("password").value);
    await updateProfile(cred.user, { displayName: name });
    await setDoc(doc(db, "users", cred.user.uid), {
      name, email: cred.user.email, phone: $("suPhone").value.trim(),
      role: "member", penalty: { noShowCount: 0 }, createdAt: serverTimestamp()
    });
  } catch (e) { alert("가입 실패: " + e.message); }
};
window.login = async () => {
  try { await signInWithEmailAndPassword(auth, $("email").value, $("password").value); }
  catch (e) { alert("로그인 실패: " + e.message); }
};
window.googleLogin = async () => {
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (e) {
    // 사용자가 팝업 취소한 경우는 알림 안 띄움
    if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") return;
    alert("구글 로그인 실패: " + e.message);
  }
};
window.logout = () => signOut(auth);
let signupMode = false;
window.toggleAuth = () => {
  signupMode = !signupMode;
  $("signupFields").classList.toggle("hide", !signupMode);
  $("authTitle").textContent = signupMode ? "회원가입" : "로그인";
};
window.submitAuth = () => { if (signupMode) signup(); else login(); };

// ---------- 홈: 다가오는 예약(F6) + 단골 1탭(F1) ----------
async function renderHome() {
  // 다가오는 예약 1건
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const up = $("upcomingBox");
  const alertBox = $("alertBox");
  try {
    const us = await getDocs(query(collection(db, "bookings"),
      where("memberId", "==", me.uid)));
    const upcoming = us.docs
      .map(d => d.data())
      .filter(b => b.status === "confirmed" && b.date >= today)
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

    // 오늘/내일 예약 알림 배너
    const todayBk = upcoming.filter(b => b.date === today);
    const tmrBk = upcoming.filter(b => b.date === tomorrow);
    let banner = "";
    if (todayBk.length) {
      const b = todayBk[0];
      banner = `<div class="alert-banner today">🔔 <b>오늘 ${b.time}</b> ${b.proName} 레슨이 있어요!${todayBk.length>1?` 외 ${todayBk.length-1}건`:""}</div>`;
    } else if (tmrBk.length) {
      const b = tmrBk[0];
      banner = `<div class="alert-banner">📅 <b>내일 ${b.time}</b> ${b.proName} 레슨이 예약되어 있어요.${tmrBk.length>1?` 외 ${tmrBk.length-1}건`:""}</div>`;
    }
    alertBox.innerHTML = banner;

    if (upcoming.length > 0) {
      const b = upcoming[0];
      up.innerHTML = `<p class="mini-label">다가오는 예약</p>
        <div class="up-card">
          <div><b>${b.proName}</b> · ${b.lessonName}</div>
          <div class="up-time">${fmtDate(b.date)} ${b.time}</div>
        </div>`;
    } else { up.innerHTML = ""; }
  } catch { up.innerHTML = ""; alertBox.innerHTML = ""; }

  // 내 이용권
  const pb = $("myPassBox");
  try {
    const ps = await getDocs(query(collection(db, "passes"), where("memberId", "==", me.uid)));
    const usable = ps.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(p => (p.remaining || 0) > 0 && (!p.expireAt || p.expireAt >= today));
    if (usable.length) {
      let html = `<p class="mini-label">내 이용권</p>`;
      usable.forEach(p => {
        html += `<div class="pass-card">
          <div><b>${esc(p.proName || "")}</b> · ${esc(p.lessonName || "")}</div>
          <div class="pass-rem">잔여 <b>${p.remaining}</b><span class="sub"> / ${p.total}회</span></div>
          ${p.expireAt ? `<div class="sub" style="margin-top:4px">만료 ${p.expireAt}</div>` : ""}
        </div>`;
      });
      pb.innerHTML = html;
    } else { pb.innerHTML = ""; }
  } catch { pb.innerHTML = ""; }

  // 제안 카드: 가장 최근 예약과 같은 조건으로 빠른 예약 권유
  const sb = $("suggestBox");
  try {
    const rs = await getDocs(query(collection(db, "bookings"),
      where("memberId", "==", me.uid)));
    const sorted = rs.docs
      .map(d => d.data())
      .filter(b => b.createdAt && b.passId)
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    if (sorted.length > 0) {
      const b = sorted[0];
      const W = ["일","월","화","수","목","금","토"];
      const d = new Date(b.date);
      const dow = W[d.getDay()];
      sb.innerHTML = `<div class="suggest-card">
        <span>💡 지난번처럼 <b>${dow}요일 ${b.time}</b>?</span>
        <button class="suggest-btn" onclick='quickRebook(${JSON.stringify(b).replace(/'/g,"&#39;")})'>바로 예약</button>
      </div>`;
    } else { sb.innerHTML = ""; }
  } catch { sb.innerHTML = ""; }
}
window.renderHome = renderHome;
const fmtDate = (s) => {
  const d = new Date(s), w = ["일","월","화","수","목","금","토"][d.getDay()];
  return `${d.getMonth()+1}/${d.getDate()}(${w})`;
};

// 단골 1탭 → 그 예약에 쓴 이용권을 자동 선택해 STEP2로 점프
window.quickRebook = async (b) => {
  resetNlSearch();
  if (!b.passId) { alert("이 예약과 연결된 이용권을 찾을 수 없어요. 새 예약으로 진행하세요."); return startNewBooking(); }
  // 이용권 유효성 확인
  const ps = await getDoc(doc(db, "passes", b.passId));
  if (!ps.exists() || (ps.data().remaining || 0) < 1) {
    alert("이용권의 잔여 횟수가 부족합니다. 매장에 문의하세요.");
    return;
  }
  // 지난 예약과 같은 요일의 다음 발생일 (항상 미래로 +7)
  const lastDate = new Date(b.date);
  const today = new Date(); today.setHours(0,0,0,0);
  let target = new Date(lastDate);
  target.setDate(target.getDate() + 7);              // 무조건 일주일 후로 시작
  while (target <= today) target.setDate(target.getDate() + 7);  // 그래도 과거면 더 밀기
  const targetDs = `${target.getFullYear()}-${String(target.getMonth()+1).padStart(2,"0")}-${String(target.getDate()).padStart(2,"0")}`;
  // 추천 컨텍스트를 전역 변수에 담아 STEP2에서 활용
  rebookHint = { date: targetDs, time: b.time };
  pickPassForBooking(ps.id, ps.data());
  openStep2();
};
let rebookHint = null;  // {date, time} — STEP2 진입 시 추천 안내·자동 선택용

// ---------- 신규 예약: 이용권 선택 → STEP2 ----------
window.startNewBooking = async () => {
  resetNlSearch();
  show("step1View");
  const box = $("passPick");
  box.innerHTML = `<p class="hint">불러오는 중…</p>`;
  $("toStep2").style.display = "none";
  $("toStep2").disabled = true;
  draft = { proId: null, proName: null, lessonTypeId: null, lessonName: null,
            passId: null, date: null, time: null, slotId: null, people: 1 };
  draftWorkHours = null;

  const usable = await getUsablePasses();
  if (usable.length === 0) { box.innerHTML = noPassCard(); return; }

  if (usable.length === 1) {
    pickPassForBooking(usable[0].id, usable[0]);
    openStep2();
    return;
  }
  box.innerHTML = usable.map(p => passPickCardHTML(p, "pickPassForBooking")).join("");
};

window.pickPassForBooking = (passId, passOrJson) => {
  const p = typeof passOrJson === "string" ? JSON.parse(passOrJson.replace(/&quot;/g,'"')) : passOrJson;
  draft.passId = passId;
  draft.proId = p.proId; draft.proName = p.proName;
  draft.lessonTypeId = p.lessonTypeId; draft.lessonName = p.lessonName;
  getDoc(doc(db, "pros", p.proId)).then(s => {
    if (s.exists()) draftWorkHours = s.data().workHours || null;
  });
  if (document.querySelectorAll("#passPick .pick-card").length > 1) {
    document.querySelectorAll("#passPick .pick-card").forEach(c => c.classList.remove("on"));
    if (event && event.currentTarget) event.currentTarget.classList.add("on");
    $("toStep2").style.display = "block";
    $("toStep2").disabled = false;
  }
};

// ---------- 반복 예약: 전용 화면 ----------
window.startRecurring = async () => {
  resetNlSearch();
  show("recurringView");
  const box = $("recurPassPick");
  $("recurForm").classList.add("hide");
  box.innerHTML = `<p class="hint">불러오는 중…</p>`;
  draft = { proId: null, proName: null, lessonTypeId: null, lessonName: null,
            passId: null, date: null, time: null, slotId: null, people: 1 };
  draftWorkHours = null;

  const usable = await getUsablePasses();
  if (usable.length === 0) { box.innerHTML = noPassCard(); return; }

  if (usable.length === 1) {
    pickPassForRecurring(usable[0].id, usable[0], true);
    return;
  }
  box.innerHTML = `<p class="sub" style="margin-bottom:8px">반복 예약에 사용할 이용권을 선택하세요.</p>`
    + usable.map(p => passPickCardHTML(p, "pickPassForRecurring")).join("");
};

window.pickPassForRecurring = (passId, passOrJson, autoOnly) => {
  const p = typeof passOrJson === "string" ? JSON.parse(passOrJson.replace(/&quot;/g,'"')) : passOrJson;
  draft.passId = passId;
  draft.proId = p.proId; draft.proName = p.proName;
  draft.lessonTypeId = p.lessonTypeId; draft.lessonName = p.lessonName;
  getDoc(doc(db, "pros", p.proId)).then(s => {
    if (s.exists()) draftWorkHours = s.data().workHours || null;
    fillRecurTimeOptions();
    fillRecurWeeksOptions();
  });
  // 선택된 이용권을 요약 카드 하나로만 표시
  $("recurPassPick").innerHTML = `<p class="sub" style="margin-bottom:8px">사용할 이용권</p>
    <div class="bk-card" style="background:var(--card);border-left:4px solid var(--accent)">
      <b>${esc(p.proName || "")}</b> · ${esc(p.lessonName || "")}
      <div class="sub" style="margin-top:4px">잔여 <b style="color:var(--accent)">${p.remaining}</b>/${p.total}회</div>
    </div>`;
  $("recurForm").classList.remove("hide");
};

// ---------- 이용권 헬퍼 ----------
async function getUsablePasses() {
  const today = new Date().toISOString().slice(0, 10);
  const snap = await getDocs(query(collection(db, "passes"), where("memberId", "==", me.uid)));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(p => (p.remaining || 0) > 0 && (!p.expireAt || p.expireAt >= today));
}
function passPickCardHTML(p, onclickFn) {
  return `<button class="pick-card pass-pick" onclick="${onclickFn}('${p.id}', ${JSON.stringify(p).replace(/"/g,'&quot;')})">
    <div style="flex:1;text-align:left">
      <b>${esc(p.proName || "")}</b> · ${esc(p.lessonName || "")}
      <div class="sub" style="margin-top:4px">잔여 <b style="color:var(--accent)">${p.remaining}</b>/${p.total}회${p.expireAt?` · 만료 ${p.expireAt}`:""}</div>
    </div>
    <span class="chev">›</span>
  </button>`;
}
function noPassCard() {
  return `<div class="bk-card" style="text-align:center;padding:24px">
    <div style="font-size:32px;margin-bottom:8px">🎫</div>
    <b>예약 가능한 이용권이 없습니다</b>
    <div class="sub" style="margin-top:8px">예약하려면 매장에서 이용권을 발급받으세요.</div>
  </div>`;
}

// 선택한 프로의 운영시간 범위로 20분 단위 시간 옵션 채우기 (반복 예약용)
function fillRecurTimeOptions() {
  const sel = $("rcTime"); if (!sel) return;
  const wh = draftWorkHours || { start: "10:00", end: "22:00" };
  const sh = parseInt(wh.start.slice(0,2),10), eh = parseInt(wh.end.slice(0,2),10);
  let o = "";
  for (let h = sh; h < eh; h++) for (const m of [0,20,40]) {
    const t = String(h).padStart(2,"0")+":"+String(m).padStart(2,"0");
    o += `<option value="${t}">${t}</option>`;
  }
  sel.innerHTML = o;
}

// 매장 예약 가능 범위(bookWindowWeeks)에 맞춰 반복 기간 옵션 생성
function fillRecurWeeksOptions() {
  const sel = $("rcWeeks"); if (!sel) return;
  const choices = [2, 4, 8, 12].filter(w => w <= bookWindowWeeks);
  // 최소 하나는 보이게 (매장이 1주여도 1주 옵션 노출)
  if (choices.length === 0) choices.push(bookWindowWeeks || 1);
  sel.innerHTML = choices.map(w => `<option value="${w}">${w}주</option>`).join("");
  const hint = $("rcWeeksHint");
  if (hint) hint.textContent = `현재 매장 예약 가능 범위: ${bookWindowWeeks}주`;
}

window.openStep2 = openStep2;
function openStep2() {
  show("step2View");
  $("s2Pro").textContent = `${draft.proName} · ${draft.lessonName}`;
  // 추천이 있으면 그 달로, 없으면 이번 달로
  if (rebookHint) {
    const td = new Date(rebookHint.date);
    calCursor = new Date(td.getFullYear(), td.getMonth(), 1);
  } else {
    const t = new Date(); calCursor = new Date(t.getFullYear(), t.getMonth(), 1);
  }
  renderDateBar();
  // 추천 안내 배너 + 해당 날짜 자동 선택
  const hintBox = $("s2Hint");
  if (rebookHint && hintBox) {
    const td = new Date(rebookHint.date);
    const W = ["일","월","화","수","목","금","토"];
    hintBox.innerHTML = `💡 <b>${td.getMonth()+1}월 ${td.getDate()}일(${W[td.getDay()]}) ${rebookHint.time}</b>을(를) 추천드려요. 아래에서 시간을 확인하고 눌러주세요.`;
    hintBox.classList.remove("hide");
    // 그 날짜 자동 선택 → 슬롯 시간 자동 로드
    pickDate(rebookHint.date);
    rebookHint = null;  // 1회용
  } else if (hintBox) {
    hintBox.classList.add("hide");
    hintBox.innerHTML = "";
  }
}

// ---------- STEP2: 날짜바 + 시간대 접기(F2·F3) ----------
let calCursor = null; // 현재 보고 있는 달의 1일
function renderDateBar() {
  if (!calCursor) { const t = new Date(); calCursor = new Date(t.getFullYear(), t.getMonth(), 1); }
  renderCalendar();
  $("slotZones").innerHTML = `<p class="hint">날짜를 선택하세요.</p>`;
}

window.calMove = (delta) => {
  calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + delta, 1);
  renderCalendar();
};

function renderCalendar() {
  const bar = $("dateBar");
  const year = calCursor.getFullYear(), month = calCursor.getMonth();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  // 예약 가능 마지막 날
  const maxDate = new Date(today); maxDate.setDate(maxDate.getDate() + bookWindowWeeks * 7);
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const W = ["일", "월", "화", "수", "목", "금", "토"];

  let html = `<div class="cal-head">
      <button class="cal-nav" onclick="calMove(-1)">‹</button>
      <span class="cal-title">${year}년 ${month + 1}월</span>
      <button class="cal-nav" onclick="calMove(1)">›</button>
    </div>
    <div class="cal-grid">`;
  W.forEach((w, i) => html += `<div class="cal-dow ${i===0?'sun':''} ${i===6?'sat':''}">${w}</div>`);
  for (let i = 0; i < firstDay; i++) html += `<div></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const cur = new Date(year, month, d);
    const ds = `${year}-${String(month+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    const disabled = cur < today || cur > maxDate;  // 과거 또는 오픈범위 초과
    const dow = cur.getDay();
    const sel = draft.date === ds ? "sel" : "";
    const cls = disabled ? "cal-day past" : `cal-day ${sel} ${dow===0?'sun':''} ${dow===6?'sat':''}`;
    html += disabled
      ? `<div class="${cls}">${d}</div>`
      : `<button class="${cls}" onclick="pickDate('${ds}')">${d}</button>`;
  }
  html += `</div>`;
  bar.innerHTML = html;
}

window.pickDate = (ds) => {
  draft.date = ds;
  renderCalendar();   // 선택 강조 갱신
  loadSlots();
};

async function loadSlots() {
  const box = $("slotZones");
  box.innerHTML = `<p class="hint">불러오는 중…</p>`;
  // 프로 운영시간 가져오기 (운영시간 밖 슬롯은 숨김)
  let workHours = draftWorkHours;
  if (!workHours) {
    try {
      const proSnap = await getDoc(doc(db, "pros", draft.proId));
      workHours = proSnap.exists() ? (proSnap.data().workHours || { start: "10:00", end: "22:00" })
                                   : { start: "10:00", end: "22:00" };
    } catch { workHours = { start: "10:00", end: "22:00" }; }
  }
  const [ssSnap, blkSnap] = await Promise.all([
    getDocs(query(collection(db, "slots"),
      where("proId", "==", draft.proId), where("date", "==", draft.date))),
    getDocs(query(collection(db, "blocks"),
      where("proId", "==", draft.proId), where("date", "==", draft.date)))
  ]);
  const blocks = blkSnap.docs.map(d => d.data());
  // 차단 + 운영시간 밖 슬롯 제외
  const docs = ssSnap.docs
    .filter(d => {
      const t = d.data().time;
      return !isBlocked(blocks, t)
          && t >= workHours.start && t < workHours.end;
    })
    .sort((a, b) => a.data().time.localeCompare(b.data().time));
  const ss = { empty: docs.length === 0, docs };
  if (ss.empty) { box.innerHTML = `<p class="hint">이 날짜에 예약 가능한 시간이 없습니다.</p>`; return; }

  // 시간대 3구간 분류
  const zones = { morning: [], afternoon: [], evening: [] };
  ss.docs.forEach(d => {
    const s = d.data(); const h = parseInt(s.time.slice(0, 2), 10);
    const item = { id: d.id, ...s };
    if (h < 13) zones.morning.push(item);
    else if (h < 18) zones.afternoon.push(item);
    else zones.evening.push(item);
  });
  const meta = [
    ["morning", "오전 · 10–12시", "☀"],
    ["afternoon", "오후 · 13–18시", "🌤"],
    ["evening", "저녁 · 18–22시", "🌙"]
  ];
  // 가능 슬롯 가장 많은 구간 기본 펼침
  let openZone = meta.map(([k]) => [k, zones[k].filter(s => s.status === "open").length])
    .sort((a, b) => b[1] - a[1])[0][0];

  box.innerHTML = "";
  meta.forEach(([key, label]) => {
    const arr = zones[key];
    const openCnt = arr.filter(s => s.status === "open").length;
    const zone = document.createElement("div");
    zone.className = "zone" + (openCnt === 0 ? " dim" : "") + (key === openZone ? " expanded" : "");
    zone.innerHTML = `
      <div class="zone-head" onclick="this.parentElement.classList.toggle('expanded')">
        <span>${label}</span>
        <span class="zone-cnt">${openCnt > 0 ? openCnt + "자리" : "없음"} ▾</span>
      </div>
      <div class="zone-body"></div>`;
    const body = zone.querySelector(".zone-body");
    if (arr.length === 0) body.innerHTML = `<p class="hint sm">슬롯 없음</p>`;
    arr.forEach(s => {
      const b = document.createElement("button");
      b.className = "slot " + (s.status === "open" ? "open" : "off");
      b.textContent = s.time;
      b.disabled = s.status !== "open";
      b.onclick = () => { draft.time = s.time; draft.slotId = s.id; openConfirm(); };
      body.appendChild(b);
    });
    box.appendChild(zone);
  });
}

// ---------- 확정: 정보 자동채움(F5) + 트랜잭션 예약 ----------
function openConfirm() {
  show("confirmView");
  $("cfSummary").innerHTML = `
    <div class="cf-row"><span>프로</span><b>${draft.proName}</b></div>
    <div class="cf-row"><span>레슨</span><b>${draft.lessonName}</b></div>
    <div class="cf-row"><span>일시</span><b>${fmtDate(draft.date)} ${draft.time}</b></div>`;
  $("cfName").value = myProfile?.name || "";
  $("cfPhone").value = myProfile?.phone || "";
  $("cfPeople").value = draft.people || 1;
}

window.confirmBooking = async () => {
  // 마감 시간 검사
  const slotDateTime = new Date(`${draft.date}T${draft.time}:00`);
  const cutoff = new Date(slotDateTime.getTime() - cutoffHours * 3600 * 1000);
  if (new Date() > cutoff) {
    alert(`예약 마감 시간이 지났습니다.\n레슨 시작 ${cutoffHours}시간 전까지만 예약할 수 있어요.`);
    return;
  }
  // 노쇼 제한 검사
  const noShow = myProfile?.penalty?.noShowCount || 0;
  if (noShow >= noShowLimit) {
    alert(`노쇼가 ${noShow}회 누적되어 예약이 제한되었습니다.\n매장에 문의해주세요.`);
    return;
  }
  const btn = $("cfBtn"); btn.disabled = true; btn.textContent = "예약 중…";
  if (!draft.passId) { alert("이용권 정보가 없습니다. 다시 시도해주세요."); btn.disabled = false; btn.textContent = "예약 확정"; return; }
  try {
    await runTransaction(db, async (tx) => {
      // 1) 모든 읽기 먼저
      const sRef = doc(db, "slots", draft.slotId);
      const pRef = doc(db, "passes", draft.passId);
      const fresh = await tx.get(sRef);
      const passSnap = await tx.get(pRef);
      if (!fresh.exists() || fresh.data().status !== "open")
        throw new Error("방금 다른 분이 예약했어요. 다른 시간을 선택해주세요.");
      if (!passSnap.exists()) throw new Error("이용권을 찾을 수 없습니다.");
      const rem = passSnap.data().remaining || 0;
      if (rem < 1) throw new Error("이용권 잔여 횟수가 없습니다.");
      // 2) 모든 쓰기
      tx.update(sRef, { status: "booked", bookedBy: me.uid });
      tx.update(pRef, { remaining: rem - 1 });
      const bRef = doc(collection(db, "bookings"));
      tx.set(bRef, {
        slotId: draft.slotId, proId: draft.proId, proName: draft.proName,
        lessonTypeId: draft.lessonTypeId, lessonName: draft.lessonName,
        passId: draft.passId,
        memberId: me.uid, memberName: $("cfName").value,
        date: draft.date, time: draft.time, people: parseInt($("cfPeople").value, 10),
        request: $("cfRequest").value, status: "confirmed", createdAt: serverTimestamp()
      });
    });
    // 입력한 연락처를 프로필에 저장(다음 자동채움용)
    if ($("cfPhone").value && $("cfPhone").value !== myProfile?.phone) {
      await updateDoc(doc(db, "users", me.uid), { phone: $("cfPhone").value });
      myProfile.phone = $("cfPhone").value;
    }
    showDone();
  } catch (e) {
    alert(e.message); btn.disabled = false; btn.textContent = "예약 확정";
  }
};

// ---------- 예약확인 통합(F6): 완료화면에 카드+캘린더+취소 ----------
function showDone() {
  show("doneView");
  $("doneCard").innerHTML = `
    <div class="done-check">✓</div>
    <h3>예약이 완료됐어요</h3>
    <div class="done-detail">
      <div><b>${draft.proName}</b> · ${draft.lessonName}</div>
      <div class="done-time">${fmtDate(draft.date)} ${draft.time}</div>
    </div>`;
  // 캘린더 추가 링크(구글)
  const start = draft.date.replace(/-/g, "") + "T" + draft.time.replace(":", "") + "00";
  const cal = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent("골프레슨 "+draft.proName)}&dates=${start}/${start}`;
  $("calBtn").href = cal;
  const btn = $("cfBtn"); btn.disabled = false; btn.textContent = "예약 확정";
  $("cfRequest").value = "";
}

// ============================================================
// [2번] 마이 예약 목록 + 예약 취소
// ============================================================
let myBookingsCache = [];   // 달력뷰에서 재사용
let myCalCursor = null;     // 내 예약 달력이 보는 달
window.openMyBookings = async () => {
  resetNlSearch();
  show("myView");
  const box = $("myList");
  box.innerHTML = `<p class="hint">불러오는 중…</p>`;
  try {
    const snap = await getDocs(query(collection(db, "bookings"),
      where("memberId", "==", me.uid)));
    const all = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    myBookingsCache = all;

    const today = new Date().toISOString().slice(0, 10);
    const upcoming = all.filter(b => b.status === "confirmed" && b.date >= today);
    const past = all.filter(b => !(b.status === "confirmed" && b.date >= today))
      .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));

    if (all.length === 0) {
      box.innerHTML = `<p class="hint">아직 예약 내역이 없어요.</p>`;
    } else {
      let html = "";
      if (upcoming.length) {
        html += `<p class="mini-label">다가오는 예약</p>`;
        upcoming.forEach(b => { html += bookingCard(b, true); });
      }
      if (past.length) {
        html += `<p class="mini-label" style="margin-top:20px">지난 예약</p>`;
        past.forEach(b => { html += bookingCard(b, false); });
      }
      box.innerHTML = html;
    }
    // 반복예약 패턴 목록 (예약 아래에)
    await renderMyRecurring(box);
    // 달력이 펼쳐져 있으면 갱신
    if (!$("myCalBox").classList.contains("hide")) renderMyCalendar();
  } catch (e) {
    box.innerHTML = `<p class="hint">목록을 불러오지 못했어요.</p>`;
  }
};

// 달력 보기 토글
window.toggleMyCalendar = () => {
  const box = $("myCalBox"), btn = $("myCalToggle");
  const willShow = box.classList.contains("hide");
  box.classList.toggle("hide", !willShow);
  btn.textContent = willShow ? "📋 목록만 보기" : "📅 달력으로 보기";
  btn.classList.toggle("on", willShow);
  if (willShow) { myCalCursor = null; renderMyCalendar(); }
};
window.myCalMove = (delta) => {
  myCalCursor = new Date(myCalCursor.getFullYear(), myCalCursor.getMonth() + delta, 1);
  renderMyCalendar();
};
// 내 예약 달력: 예약 있는 날에 점 표시, 날짜 탭 시 해당 예약 강조
function renderMyCalendar() {
  if (!myCalCursor) {
    // 가장 가까운 다가오는 예약의 달, 없으면 이번 달
    const today = new Date().toISOString().slice(0,10);
    const next = myBookingsCache.find(b => b.status === "confirmed" && b.date >= today);
    const base = next ? new Date(next.date) : new Date();
    myCalCursor = new Date(base.getFullYear(), base.getMonth(), 1);
  }
  const box = $("myCalBox");
  const year = myCalCursor.getFullYear(), month = myCalCursor.getMonth();
  const todayStr = new Date().toISOString().slice(0,10);
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const W = ["일","월","화","수","목","금","토"];
  // 이 달의 예약 날짜별 상태 집계
  const byDate = {};
  myBookingsCache.forEach(b => {
    if (b.date.slice(0,7) !== `${year}-${String(month+1).padStart(2,"0")}`) return;
    const st = b.status === "cancelled" ? "cancelled" : (b.status === "confirmed" && b.date >= todayStr ? "upcoming" : "done");
    // 우선순위: upcoming > done > cancelled
    if (!byDate[b.date] || (st === "upcoming") || (st === "done" && byDate[b.date] === "cancelled"))
      byDate[b.date] = st;
  });

  let html = `<div class="cal-head">
      <button class="cal-nav" onclick="myCalMove(-1)">‹</button>
      <span class="cal-title">${year}년 ${month + 1}월</span>
      <button class="cal-nav" onclick="myCalMove(1)">›</button>
    </div>
    <div class="cal-grid">`;
  W.forEach((w, i) => html += `<div class="cal-dow ${i===0?'sun':''} ${i===6?'sat':''}">${w}</div>`);
  for (let i = 0; i < firstDay; i++) html += `<div></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${year}-${String(month+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    const st = byDate[ds];
    const isToday = ds === todayStr;
    const dot = st ? `<span class="cal-dot ${st}"></span>` : "";
    html += `<div class="my-cal-day ${isToday?'today':''} ${st?'has':''}" ${st?`onclick="scrollToBooking('${ds}')"`:""}>
      <span>${d}</span>${dot}</div>`;
  }
  html += `</div>
    <div class="cal-legend">
      <span><span class="cal-dot upcoming"></span>예정</span>
      <span><span class="cal-dot done"></span>완료</span>
      <span><span class="cal-dot cancelled"></span>취소</span>
    </div>`;
  box.innerHTML = html;
}
// 달력에서 날짜 탭 → 리스트의 해당 예약 카드로 스크롤+강조
window.scrollToBooking = (ds) => {
  const card = document.querySelector(`#myList [data-date="${ds}"]`);
  if (card) {
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.add("flash");
    setTimeout(() => card.classList.remove("flash"), 1500);
  }
};

// 내 반복예약 패턴 — 내 예약 화면 하단에 표시
async function renderMyRecurring(box) {
  const snap = await getDocs(query(collection(db, "recurring"), where("memberId", "==", me.uid)));
  if (snap.empty) return;
  const W = ["일","월","화","수","목","금","토"];
  let html = `<p class="mini-label" style="margin-top:24px">🔁 반복예약 패턴</p>`;
  snap.docs.forEach(d => {
    const r = d.data();
    html += `<div class="bk-card"><div class="bk-top">
      <div><b>${r.proName}</b> · ${r.lessonName}</div>
      <button class="mini-btn danger" onclick="deleteRecurring('${d.id}')">삭제</button>
    </div><div class="bk-time">매${r.everyOther ? "격주" : "주"} ${W[r.weekday]} ${r.time}</div></div>`;
  });
  box.innerHTML += html;
}

function bookingCard(b, cancelable) {
  const statusLabel = b.status === "cancelled" ? "취소됨"
    : b.attendance === "noshow" ? "노쇼"
    : (b.status === "done" || b.date < new Date().toISOString().slice(0,10)) ? "완료" : "예약됨";
  const btn = cancelable
    ? `<button class="cancel-btn" onclick="cancelBooking('${b.id}','${b.slotId}','${b.date}','${b.time}')">예약 취소</button>`
    : "";
  // 완료(출석)된 레슨: 레슨일지 + 별점
  let extra = "";
  const isDone = b.status === "done" && b.attendance === "present";
  if (isDone) {
    if (b.journal) extra += `<div class="journal-box"><b>📝 레슨일지</b><div class="sub" style="margin-top:4px;white-space:pre-wrap">${esc(b.journal)}</div></div>`;
    if (b.rating) {
      extra += `<div class="rating-done">평가 완료 ${"★".repeat(b.rating)}${"☆".repeat(5-b.rating)}</div>`;
    } else {
      extra += `<div class="rating-input" id="rate-${b.id}">
        <span class="sub">레슨은 어떠셨나요?</span>
        <div class="stars">${[1,2,3,4,5].map(n => `<span class="star" onclick="rateBooking('${b.id}',${n})">☆</span>`).join("")}</div>
      </div>`;
    }
  }
  return `<div class="bk-card ${b.status === 'cancelled' ? 'dim' : ''}" data-date="${b.date}">
      <div class="bk-top">
        <div><b>${b.proName}</b> · ${b.lessonName}</div>
        <span class="bk-badge">${statusLabel}</span>
      </div>
      <div class="bk-time">${fmtDate(b.date)} ${b.time} · ${b.people || 1}명</div>
      ${extra}
      ${btn}
    </div>`;
}

// 회원: 별점 남기기
window.rateBooking = async (bookingId, rating) => {
  try {
    await updateDoc(doc(db, "bookings", bookingId), { rating });
    openMyBookings();
  } catch (e) { alert("평가 저장 실패: " + e.message); }
};

// 취소: 예약을 cancelled로 + 슬롯을 다시 open으로 (트랜잭션)
window.cancelBooking = async (bookingId, slotId, date, time) => {
  // 취소 마감 검사
  if (date && time) {
    const slotDateTime = new Date(`${date}T${time}:00`);
    const cutoff = new Date(slotDateTime.getTime() - cutoffHours * 3600 * 1000);
    if (new Date() > cutoff) {
      alert(`취소 마감 시간이 지났습니다.\n레슨 시작 ${cutoffHours}시간 전까지만 취소할 수 있어요.\n매장에 문의해주세요.`);
      return;
    }
  }
  if (!confirm("이 예약을 취소할까요? 취소하면 이용권이 1회 복원되고 해당 시간이 다시 열립니다.")) return;
  try {
    await runTransaction(db, async (tx) => {
      const bRef = doc(db, "bookings", bookingId);
      const sRef = slotId ? doc(db, "slots", slotId) : null;
      // 1) 모든 읽기 먼저
      const bSnap = await tx.get(bRef);
      const sSnap = sRef ? await tx.get(sRef) : null;
      if (!bSnap.exists() || bSnap.data().status !== "confirmed")
        throw new Error("이미 취소되었거나 처리할 수 없는 예약입니다.");
      const passId = bSnap.data().passId;
      const pRef = passId ? doc(db, "passes", passId) : null;
      const pSnap = pRef ? await tx.get(pRef) : null;
      // 2) 그다음 모든 쓰기
      tx.update(bRef, { status: "cancelled" });
      if (sSnap && sSnap.exists())
        tx.update(sRef, { status: "open", bookedBy: null });
      // 이용권 환원
      if (pSnap && pSnap.exists()) {
        const rem = pSnap.data().remaining || 0;
        const total = pSnap.data().total || rem + 1;
        tx.update(pRef, { remaining: Math.min(total, rem + 1) });
      }
    });
    alert("예약이 취소되었습니다.");
    window.openMyBookings();
  } catch (e) { alert(e.message); }
};

// ============================================================
// [3번] 관리자 콘솔 — 현황 / 슬롯 / 프로·레슨
// admin role 전용. 보안 규칙이 실제 권한을 강제함.
// ============================================================
window.openAdmin = () => { resetNlSearch(); show("adminView"); adminTab("status"); };

window.adminTab = (tab) => {
  document.querySelectorAll("#adminTabs button").forEach(b =>
    b.classList.toggle("on", b.dataset.tab === tab));
  const dayBtn = $("dayOpenBtn");
  if (dayBtn) dayBtn.style.display = tab === "slots" ? "block" : "none";
  if (tab === "status") renderAdminStatus();
  else if (tab === "slots") renderAdminSlots();
  else if (tab === "members") renderAdminMembers();
  else if (tab === "manage") renderAdminManage();
};

// ---------- 현황: 오늘 예약자 ----------
async function renderAdminStatus() {
  const box = $("adminBody");
  box.innerHTML = `<p class="hint">불러오는 중…</p>`;
  const today = new Date().toISOString().slice(0, 10);
  const snap = await getDocs(query(collection(db, "bookings"), where("date", "==", today)));
  const list = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(b => b.status === "confirmed" || b.status === "done")
    .sort((a, b) => (a.time + a.proName).localeCompare(b.time + b.proName));
  let html = `<p class="mini-label">오늘 예약 (${fmtDate(today)}) · ${list.length}건</p>`;
  if (list.length === 0) html += `<p class="hint">오늘 예약이 없습니다.</p>`;
  list.forEach(b => {
    const att = b.attendance;  // undefined | "present" | "noshow"
    const attLabel = att === "present" ? `<span class="att-badge ok">출석</span>`
      : att === "noshow" ? `<span class="att-badge no">노쇼</span>` : "";
    const buttons = att ? "" : `<div class="att-btns">
        <button class="att-btn ok" onclick="markAttendance('${b.id}','${b.memberId}','${b.lessonTypeId}','present')">출석</button>
        <button class="att-btn no" onclick="markAttendance('${b.id}','${b.memberId}','${b.lessonTypeId}','noshow')">노쇼</button>
      </div>`;
    // 출석 완료 건: 레슨일지 작성/표시
    let journal = "";
    if (att === "present") {
      if (b.journal) journal = `<div class="journal-box"><b>📝 레슨일지</b><div class="sub" style="margin-top:4px;white-space:pre-wrap">${esc(b.journal)}</div>
        <button class="mini-btn" onclick="writeJournal('${b.id}',${JSON.stringify(b.journal).replace(/"/g,'&quot;')})" style="margin-top:8px">수정</button></div>`;
      else journal = `<button class="mini-btn" onclick="writeJournal('${b.id}','')" style="margin-top:10px">📝 레슨일지 작성</button>`;
    }
    html += `<div class="bk-card">
      <div class="bk-top"><div><b>${b.time}</b> · ${b.proName} ${attLabel}</div>
        <span class="bk-badge">${b.lessonName}</span></div>
      <div class="bk-time" style="color:var(--ink)">${b.memberName || "회원"} · ${b.people || 1}명</div>
      ${b.request ? `<div class="sub" style="margin-top:6px">요청: ${b.request}</div>` : ""}
      ${b.rating ? `<div class="sub" style="margin-top:6px">회원 평가: ${"★".repeat(b.rating)}</div>` : ""}
      ${buttons}
      ${journal}
    </div>`;
  });
  box.innerHTML = html;
}

// 출석 처리: 예약 확정 시 이미 이용권 차감됨. 여기서는 출석/노쇼 표시만.
// 노쇼는 추가로 페널티 카운트 +1 (이용권은 환원하지 않음)
window.markAttendance = async (bookingId, memberId, lessonTypeId, status) => {
  const label = status === "present" ? "출석" : "노쇼";
  if (!confirm(`${label} 처리할까요?`)) return;
  try {
    await runTransaction(db, async (tx) => {
      const bRef = doc(db, "bookings", bookingId);
      let userRef = null, userSnap = null;
      if (status === "noshow") {
        userRef = doc(db, "users", memberId);
        userSnap = await tx.get(userRef);
      }
      tx.update(bRef, { status: "done", attendance: status });
      if (userRef && userSnap && userSnap.exists()) {
        const cur = userSnap.data().penalty?.noShowCount || 0;
        tx.update(userRef, { "penalty.noShowCount": cur + 1 });
      }
    });
    renderAdminStatus();
  } catch (e) { alert("처리 실패: " + e.message); }
};

// 관리자/프로: 레슨일지 작성
window.writeJournal = async (bookingId, current) => {
  const text = prompt("레슨일지를 입력하세요\n(회원이 '내 예약'에서 확인합니다)", current || "");
  if (text === null) return;
  try {
    await updateDoc(doc(db, "bookings", bookingId), { journal: text.trim() });
    renderAdminStatus();
  } catch (e) { alert("저장 실패: " + e.message); }
};

// ---------- 슬롯 관리: 프로·날짜 선택 → 시간 열기/닫기 ----------
let adminSlotState = { proId: null, date: null, start: 10, end: 22 };

// 차단 여부 판정 (하루 전체 or 시간대 범위)
function isBlocked(blocks, time) {
  return blocks.some(b => {
    if (b.allDay) return true;
    return b.startTime && b.endTime && time >= b.startTime && time < b.endTime;
  });
}
async function renderAdminSlots() {
  const box = $("adminBody");
  const ps = await getDocs(query(collection(db, "pros"), where("active", "==", true)));
  let opts = `<option value="">프로 선택</option>`;
  ps.forEach(d => {
    const wh = d.data().workHours || { start: "10:00", end: "22:00" };
    opts += `<option value="${d.id}" data-start="${wh.start}" data-end="${wh.end}">${d.data().name}</option>`;
  });
  const today = new Date().toISOString().slice(0, 10);
  box.innerHTML = `
    <p class="mini-label">슬롯 열기 / 닫기</p>
    <select id="asPro" onchange="onAdminSlotChange()">${opts}</select>
    <label class="date-picker" style="margin-top:10px">
      <span class="dp-label empty" data-placeholder="날짜 선택">날짜 선택</span>
      <span class="dp-icon">📅</span>
      <input type="date" id="asDate" min="${today}" onchange="refreshDatePickerLabel(this);onAdminSlotChange()">
    </label>
    <div id="asGrid" style="margin-top:14px"><p class="hint">프로와 날짜를 선택하세요.</p></div>
    <div class="block-box">
      <p class="mini-label">⚡ 기간 일괄 오픈</p>
      <div class="sub" style="margin-bottom:8px">선택한 프로의 운영시간을 향후 기간만큼 한 번에 엽니다.</div>
      <select id="bulkWeeks" style="width:100%">
        <option value="1">향후 1주</option><option value="2">향후 2주</option>
        <option value="4" selected>향후 4주</option><option value="8">향후 8주</option>
      </select>
      <div class="dow-pick" id="bulkDow">
        ${["일","월","화","수","목","금","토"].map((w,i) =>
          `<label class="dow-chip"><input type="checkbox" value="${i}" ${i>=1&&i<=5?"checked":""}><span>${w}</span></label>`).join("")}
      </div>
      <button class="btn-ghost" onclick="bulkOpen()" style="margin-top:10px">기간 일괄 오픈</button>
    </div>`;
}

// 향후 N주 일괄 오픈 (선택 프로, 요일 필터, 차단 제외)
window.bulkOpen = async () => {
  const proId = $("asPro").value;
  if (!proId) { alert("먼저 프로를 선택하세요."); return; }
  const opt = $("asPro").selectedOptions[0];
  const startH = opt?.dataset.start ? parseInt(opt.dataset.start.slice(0,2),10) : 10;
  const endH = opt?.dataset.end ? parseInt(opt.dataset.end.slice(0,2),10) : 22;
  const weeks = parseInt($("bulkWeeks").value, 10);
  const checkedDows = [...document.querySelectorAll('#bulkDow input:checked')].map(c => parseInt(c.value, 10));
  if (!checkedDows.length) { alert("요일을 하나 이상 선택하세요."); return; }
  const W = ["일","월","화","수","목","금","토"];
  const dowText = checkedDows.map(d => W[d]).join("·");
  if (!confirm(`${opt.textContent} · 향후 ${weeks}주 · ${dowText}\n${startH}~${endH}시를 일괄 오픈할까요?`)) return;

  const today = new Date(); today.setHours(0,0,0,0);
  // 대상 날짜 수집
  const dates = [];
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(today); d.setDate(d.getDate() + i);
    if (!checkedDows.includes(d.getDay())) continue;
    dates.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`);
  }
  // 기존 슬롯·차단 조회 (한 번에)
  const [allSlots, allBlocks] = await Promise.all([
    getDocs(query(collection(db, "slots"), where("proId", "==", proId))),
    getDocs(query(collection(db, "blocks"), where("proId", "==", proId)))
  ]);
  const have = new Set();
  allSlots.docs.forEach(s => have.add(s.data().date + " " + s.data().time));
  const blocksByDate = {};
  allBlocks.docs.forEach(b => { (blocksByDate[b.data().date] ||= []).push(b.data()); });

  let created = 0;
  let batch = writeBatch(db), batchCount = 0;
  for (const date of dates) {
    const dayBlocks = blocksByDate[date] || [];
    for (let h = startH; h < endH; h++) for (const m of [0,20,40]) {
      const t = String(h).padStart(2,"0")+":"+String(m).padStart(2,"0");
      if (have.has(date + " " + t)) continue;
      if (isBlocked(dayBlocks, t)) continue;
      batch.set(doc(collection(db, "slots")),
        { proId, date, time: t, durationMin: 20, status: "open", bookedBy: null });
      created++; batchCount++;
      if (batchCount >= 450) { await batch.commit(); batch = writeBatch(db); batchCount = 0; }
    }
  }
  if (batchCount > 0) await batch.commit();
  alert(`완료! ${created}개 슬롯을 열었습니다.`);
  if (adminSlotState.date) onAdminSlotChange();
};
window.onAdminSlotChange = async () => {
  const sel = $("asPro");
  adminSlotState.proId = sel.value;
  adminSlotState.date = $("asDate").value;
  const opt = sel.selectedOptions[0];
  adminSlotState.start = opt?.dataset.start ? parseInt(opt.dataset.start.slice(0,2),10) : 10;
  adminSlotState.end = opt?.dataset.end ? parseInt(opt.dataset.end.slice(0,2),10) : 22;
  const grid = $("asGrid");
  if (!adminSlotState.proId || !adminSlotState.date) {
    grid.innerHTML = `<p class="hint">프로와 날짜를 선택하세요.</p>`; return;
  }
  grid.innerHTML = `<p class="hint">불러오는 중…</p>`;
  // 기존 슬롯 + 차단 조회
  const [snap, blkSnap] = await Promise.all([
    getDocs(query(collection(db, "slots"),
      where("proId", "==", adminSlotState.proId), where("date", "==", adminSlotState.date))),
    getDocs(query(collection(db, "blocks"),
      where("proId", "==", adminSlotState.proId), where("date", "==", adminSlotState.date)))
  ]);
  const existing = {};
  snap.docs.forEach(d => existing[d.data().time] = { id: d.id, ...d.data() });
  const blocks = blkSnap.docs.map(d => d.data());
  // 운영시간 범위 20분 단위 버튼
  let html = `<p class="sub" style="margin-bottom:8px">운영시간 ${adminSlotState.start}~${adminSlotState.end}시 · 탭하여 열기/닫기 · 🟢열림 🔴예약됨 ⚪닫힘</p>
    <div class="as-grid">`;
  for (let h = adminSlotState.start; h < adminSlotState.end; h++) {
    for (const m of [0, 20, 40]) {
      const t = String(h).padStart(2,"0") + ":" + String(m).padStart(2,"0");
      const ex = existing[t];
      const blocked = isBlocked(blocks, t);
      let cls = "closed", label = t;
      if (blocked) { cls = "blocked"; label = t; }
      else if (ex && ex.status === "open") cls = "open";
      else if (ex && ex.status === "booked") cls = "booked";
      html += `<button class="as-slot ${cls}" onclick="toggleSlot('${t}')"
        ${(cls === "booked" || cls === "blocked") ? "disabled" : ""}>${label}</button>`;
    }
  }
  html += `</div>`;
  // 차단 등록 영역
  html += `<div class="block-box">
    <p class="mini-label">🚫 예약 차단 — 시간대 전체 휴무·점심 등</p>
    <div class="block-hint">💡 시간을 한 칸씩 열고 닫으려면 <b>위 시간 격자</b>를 누르세요.<br>여기는 <b>시간대 전체</b>를 한 번에 막을 때 사용합니다.</div>
    <select id="blkType" onchange="onBlkType()">
      <option value="range">특정 시간대만 차단</option>
      <option value="allDay">⚠️ 하루 전체 휴무</option>
    </select>
    <div id="blkRange">
      <div style="display:flex;gap:8px;align-items:center;margin-top:10px">
        <select id="blkStart" style="flex:1" onchange="updateBlockConflictHint()">${timeOptions(adminSlotState.start, adminSlotState.end, false)}</select>
        <span>~</span>
        <select id="blkEnd" style="flex:1" onchange="updateBlockConflictHint()">${timeOptions(adminSlotState.start, adminSlotState.end, true)}</select>
      </div>
    </div>

    <p class="mini-label" style="margin-top:14px">🔁 반복</p>
    <select id="blkRepeat" onchange="onBlkRepeat()">
      <option value="once">이 날짜에만</option>
      <option value="daily">매일 반복</option>
      <option value="weekday">평일 반복 (월~금)</option>
      <option value="weekend">주말 반복 (토·일)</option>
      <option value="sameDow">매주 같은 요일</option>
    </select>
    <div id="blkRepeatWeeks" class="hide" style="margin-top:10px">
      <label class="sub">기간</label>
      <select id="blkWeeks" onchange="updateBlockConflictHint()"></select>
    </div>

    <div id="blkConflictHint" class="hide"></div>
    <input id="blkReason" placeholder="차단 사유 (예: 점심, 외부 레슨)" style="margin-top:10px">
    <button class="btn-ghost" onclick="addBlock()" style="margin-top:10px">차단 등록</button>`;
  // 현재 차단 목록
  if (blocks.length) {
    html += `<p class="sub" style="margin-top:16px">현재 차단 목록 <span class="sub" style="opacity:.7">· ${blocks.length}건</span></p>`;
    const repeatLabelMap = {
      daily: "매일",
      weekday: "평일",
      weekend: "주말",
      sameDow: "매주 같은 요일"
    };
    blkSnap.docs.forEach(d => {
      const b = d.data();
      const range = b.allDay ? "🌙 하루 전체 휴무" : `⏰ ${b.startTime} ~ ${b.endTime}`;
      const groupBadge = b.groupId
        ? `<div class="sub" style="margin-top:2px;color:var(--accent)">🔁 ${repeatLabelMap[b.repeatInfo?.repeat] || "반복"} 차단 (총 ${b.repeatInfo?.total || "?"}일)</div>`
        : "";
      const groupBtn = b.groupId
        ? `<button class="mini-btn danger" onclick="removeBlockGroup('${b.groupId}')" style="margin-top:6px">그룹 전체 해제</button>`
        : "";
      html += `<div class="bk-card" style="margin-top:8px"><div class="bk-top">
        <div><b>${range}</b>${b.reason ? `<div class="sub" style="margin-top:2px">${esc(b.reason)}</div>` : ""}${groupBadge}</div>
        <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
          <button class="mini-btn danger" onclick="removeBlock('${d.id}')">이 날만 해제</button>
          ${groupBtn}
        </div></div></div>`;
    });
  }
  html += `</div>`;
  grid.innerHTML = html;
  // 차단 폼 로드 직후 default(range) 기준으로 충돌 힌트 미리 점검
  setTimeout(() => { if ($("blkConflictHint")) updateBlockConflictHint(); }, 0);
};

// 20분 단위 시간 옵션 (end=true면 종료용이라 마지막 시각 포함)
function timeOptions(startH, endH, isEnd) {
  let o = "";
  for (let h = startH; h < endH; h++) for (const m of [0, 20, 40]) {
    const t = String(h).padStart(2,"0")+":"+String(m).padStart(2,"0");
    o += `<option value="${t}">${t}</option>`;
  }
  // 종료 셀렉트는 운영 종료 정시도 선택 가능 (예: 22:00)
  if (isEnd) { const t = String(endH).padStart(2,"0")+":00"; o += `<option value="${t}">${t}</option>`; }
  return o;
}

window.onBlkType = () => {
  const isRange = $("blkType").value === "range";
  $("blkRange").classList.toggle("hide", !isRange);
  updateBlockConflictHint();
};

// 반복 옵션 변경: "이 날짜에만"이면 기간 숨김, 아니면 기간 셀렉트 노출
window.onBlkRepeat = () => {
  const rep = $("blkRepeat").value;
  const box = $("blkRepeatWeeks");
  if (rep === "once") {
    box.classList.add("hide");
  } else {
    // 매장 예약 가능 범위 안에서 옵션 동적 생성
    const sel = $("blkWeeks");
    const choices = [1, 2, 4, 8, 12].filter(w => w <= (bookWindowWeeks || 4));
    if (choices.length === 0) choices.push(1);
    sel.innerHTML = choices.map(w => `<option value="${w}">${w}주</option>`).join("");
    box.classList.remove("hide");
  }
  updateBlockConflictHint();
};

// 반복 옵션에 따라 차단할 날짜 목록 생성 (시작 날짜 포함)
function expandBlockDates(startDate, repeat, weeks) {
  const dates = [];
  const start = new Date(startDate);
  const totalDays = (weeks || 1) * 7;
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(start); d.setDate(d.getDate() + i);
    const dow = d.getDay();   // 0=일, 6=토
    let include = false;
    if (repeat === "once") include = (i === 0);
    else if (repeat === "daily") include = true;
    else if (repeat === "weekday") include = (dow >= 1 && dow <= 5);
    else if (repeat === "weekend") include = (dow === 0 || dow === 6);
    else if (repeat === "sameDow") include = (dow === start.getDay());
    if (include) {
      dates.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`);
    }
    if (repeat === "once" && i > 0) break;
  }
  return dates;
}

// 차단 폼 안에서 실시간 충돌 경고 표시 (선택만 해도 즉시 보임 — 사고 사전 차단)
window.updateBlockConflictHint = async () => {
  const hint = $("blkConflictHint"); if (!hint) return;
  const { proId, date } = adminSlotState;
  if (!proId || !date) { hint.classList.add("hide"); return; }
  const type = $("blkType").value;
  const repeat = $("blkRepeat")?.value || "once";
  const weeks = parseInt($("blkWeeks")?.value, 10) || 1;
  let startTime = null, endTime = null;
  if (type === "range") {
    startTime = $("blkStart").value; endTime = $("blkEnd").value;
    if (!startTime || !endTime || startTime >= endTime) { hint.classList.add("hide"); return; }
  }
  // 반복 범위 전체 날짜 계산
  const dates = expandBlockDates(date, repeat, weeks);
  try {
    // 모든 confirmed 예약을 한 번에 가져와서 클라이언트에서 필터
    const bSnap = await getDocs(query(collection(db, "bookings"),
      where("proId", "==", proId), where("status", "==", "confirmed")));
    const conflicts = bSnap.docs
      .map(d => d.data())
      .filter(b => dates.includes(b.date))
      .filter(b => type === "allDay" || (b.time >= startTime && b.time < endTime))
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

    const repeatLabel = repeat === "once" ? "" : ` (${dates.length}일)`;
    if (conflicts.length === 0) {
      // 반복 등록인 경우엔 정보 안내(파란)만 표시
      if (repeat !== "once") {
        hint.className = "info-hint";
        hint.innerHTML = `ℹ️ <b>${dates.length}일치 차단</b>이 등록됩니다 (충돌 예약 없음).`;
        hint.classList.remove("hide");
      } else {
        hint.classList.add("hide");
      }
      return;
    }
    hint.className = "warn-hint";   // 빨강
    const lines = conflicts.slice(0, 5).map(b => `• ${b.date.slice(5)} ${b.time} ${esc(b.memberName || "회원")}`).join("<br>");
    const more = conflicts.length > 5 ? `<br>외 ${conflicts.length - 5}건` : "";
    hint.innerHTML = `⚠️ <b>${dates.length}일치 차단${repeatLabel}</b> · 그 시간대에 이미 예약 <b>${conflicts.length}건</b>이 있어요.<br>
      ${lines}${more}<br>
      <span class="sub">차단해도 위 예약은 자동 취소되지 않아요. 회원에게 직접 안내해주세요.</span>`;
    hint.classList.remove("hide");
  } catch { hint.classList.add("hide"); }
};

// 차단 등록 — blkType 드롭다운 값으로 명확히 분기
window.addBlock = async () => {
  const { proId, date } = adminSlotState;
  if (!proId || !date) { alert("프로와 날짜를 먼저 선택하세요."); return; }
  const type = $("blkType").value;       // "allDay" | "range"
  const repeat = $("blkRepeat").value;   // "once" | "daily" | "weekday" | "weekend" | "sameDow"
  const weeks = parseInt($("blkWeeks")?.value, 10) || 1;
  const reason = $("blkReason").value.trim();
  const allDay = type === "allDay";
  let startTime = null, endTime = null;
  if (!allDay) {
    startTime = $("blkStart").value;
    endTime = $("blkEnd").value;
    if (startTime >= endTime) { alert("시작 시각이 종료 시각보다 빨라야 합니다."); return; }
  }
  const dates = expandBlockDates(date, repeat, weeks);
  if (dates.length === 0) { alert("차단할 날짜가 없습니다."); return; }

  const repeatLabelMap = {
    once: "이 날짜에만",
    daily: `매일 반복 (${weeks}주, ${dates.length}일)`,
    weekday: `평일 반복 (${weeks}주, ${dates.length}일)`,
    weekend: `주말 반복 (${weeks}주, ${dates.length}일)`,
    sameDow: `매주 같은 요일 (${weeks}주, ${dates.length}일)`
  };
  const timeLabel = allDay ? "하루 전체 휴무" : `${startTime}~${endTime} 차단`;

  // 전체 충돌 검사
  try {
    const bSnap = await getDocs(query(collection(db, "bookings"),
      where("proId", "==", proId), where("status", "==", "confirmed")));
    const conflicts = bSnap.docs
      .map(d => d.data())
      .filter(b => dates.includes(b.date))
      .filter(b => allDay || (b.time >= startTime && b.time < endTime))
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    if (conflicts.length > 0) {
      const lines = conflicts.slice(0, 10).map(b => `• ${b.date.slice(5)} ${b.time} — ${b.memberName || "회원"}`).join("\n");
      const more = conflicts.length > 10 ? `\n외 ${conflicts.length - 10}건` : "";
      const proceed = confirm(
        `⚠️ ${dates.length}일치 차단을 등록합니다.\n${timeLabel} · ${repeatLabelMap[repeat]}\n\n` +
        `이 시간대에 이미 예약 ${conflicts.length}건이 있어요:\n${lines}${more}\n\n` +
        `차단을 등록해도 위 예약은 자동 취소되지 않습니다.\n회원에게 직접 연락해 안내해주세요.\n\n계속 진행할까요?`
      );
      if (!proceed) return;
    } else {
      const msg = repeat === "once"
        ? `${date}\n${timeLabel}${reason ? `\n사유: ${reason}` : ""}\n\n등록할까요?`
        : `${dates.length}일치 차단을 등록합니다.\n${timeLabel} · ${repeatLabelMap[repeat]}${reason ? `\n사유: ${reason}` : ""}\n\n계속 진행할까요?`;
      if (!confirm(msg)) return;
    }
  } catch (e) {
    if (!confirm(`${dates.length}일치 차단을 등록합니다.\n${timeLabel}\n\n등록할까요?\n(기존 예약 확인 실패: ${e.message})`)) return;
  }

  // 반복 등록 시 그룹 ID 부여 (일괄 해제용)
  const groupId = repeat === "once" ? null : `g_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
  const repeatInfo = repeat === "once" ? null : { repeat, weeks, total: dates.length };

  try {
    const batch = writeBatch(db);
    dates.forEach(d => {
      const data = { proId, date: d, reason, allDay, createdAt: serverTimestamp() };
      if (!allDay) { data.startTime = startTime; data.endTime = endTime; }
      if (groupId) { data.groupId = groupId; data.repeatInfo = repeatInfo; }
      batch.set(doc(collection(db, "blocks")), data);
    });
    await batch.commit();
    toast(`✅ 차단 ${dates.length}건 등록`);
    onAdminSlotChange();
  } catch (err) { alert("차단 등록 실패: " + err.message); }
};
window.removeBlock = async (id) => {
  if (!confirm("이 차단을 해제할까요?")) return;
  try { await deleteDoc(doc(db, "blocks", id)); toast("✅ 차단 해제됨"); onAdminSlotChange(); }
  catch (err) { alert("해제 실패: " + err.message); }
};

// 반복 차단 그룹 일괄 해제 — 같은 groupId를 가진 모든 차단 삭제
window.removeBlockGroup = async (groupId) => {
  try {
    const snap = await getDocs(query(collection(db, "blocks"), where("groupId", "==", groupId)));
    if (snap.empty) { alert("해당 그룹을 찾을 수 없어요."); return; }
    if (!confirm(`이 반복 차단 그룹(총 ${snap.size}건)을 모두 해제할까요?\n취소할 수 없습니다.`)) return;
    const batch = writeBatch(db);
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    toast(`✅ ${snap.size}건 일괄 해제`);
    onAdminSlotChange();
  } catch (err) { alert("일괄 해제 실패: " + err.message); }
};

// 슬롯 토글: 닫힘→열기(생성), 열림→닫기(삭제). 예약된 건 불가.
window.toggleSlot = async (time) => {
  const { proId, date } = adminSlotState;
  const snap = await getDocs(query(collection(db, "slots"),
    where("proId", "==", proId), where("date", "==", date), where("time", "==", time)));
  try {
    if (snap.empty) {
      // 열기
      await addDoc(collection(db, "slots"), {
        proId, date, time, durationMin: 20, status: "open", bookedBy: null });
      toast(`🔓 ${time} 열림`);
    } else {
      const d = snap.docs[0];
      if (d.data().status === "booked") { alert("예약된 시간은 닫을 수 없어요."); return; }
      await deleteDoc(doc(db, "slots", d.id)); // 닫기
      toast(`✅ ${time} 닫힘`);
    }
    onAdminSlotChange(); // 새로고침
  } catch (e) { alert("처리 실패: " + e.message); }
};

// 하루 일괄 열기 (운영시간 범위, 차단 시간 제외)
window.openWholeDay = async () => {
  const { proId, date, start, end } = adminSlotState;
  if (!proId || !date) { alert("프로와 날짜를 먼저 선택하세요."); return; }
  if (!confirm(`${date} ${start}~${end}시를 모두 열까요?`)) return;
  const [snap, blkSnap] = await Promise.all([
    getDocs(query(collection(db, "slots"), where("proId", "==", proId), where("date", "==", date))),
    getDocs(query(collection(db, "blocks"), where("proId", "==", proId), where("date", "==", date)))
  ]);
  const have = new Set(snap.docs.map(d => d.data().time));
  const blocks = blkSnap.docs.map(d => d.data());
  const batch = writeBatch(db);
  for (let h = start; h < end; h++) for (const m of [0,20,40]) {
    const t = String(h).padStart(2,"0")+":"+String(m).padStart(2,"0");
    if (!have.has(t) && !isBlocked(blocks, t)) batch.set(doc(collection(db, "slots")),
      { proId, date, time: t, durationMin: 20, status: "open", bookedBy: null });
  }
  try { await batch.commit(); onAdminSlotChange(); }
  catch (e) { alert("일괄 열기 실패: " + e.message); }
};

// ---------- 프로 / 레슨 관리 ----------
async function renderAdminManage() {
  const box = $("adminBody");
  box.innerHTML = `<p class="hint">불러오는 중…</p>`;
  const [ps, ls] = await Promise.all([
    getDocs(collection(db, "pros")),
    getDocs(collection(db, "lessonTypes"))
  ]);
  let html = `<p class="mini-label">매장 설정</p>
    <div class="bk-card">
      <label class="sub">매장 이름</label>
      <div style="display:flex;gap:8px;margin-top:4px">
        <input id="storeNameInput" value="${esc(storeName)}" placeholder="매장 이름" style="flex:1;margin-top:0">
      </div>
      <label class="sub" style="display:block;margin-top:12px">예약 가능 범위</label>
      <div style="display:flex;gap:8px;margin-top:4px;align-items:center">
        <select id="bookWindowInput" style="flex:1;margin-top:0">
          <option value="1">1주 앞까지</option>
          <option value="2">2주 앞까지</option>
          <option value="4">4주 앞까지</option>
          <option value="8">8주 앞까지</option>
          <option value="12">12주 앞까지</option>
        </select>
      </div>
      <div class="sub" style="margin-top:8px">회원이 오늘부터 며칠 앞까지 예약할 수 있는지 설정합니다.</div>
      <label class="sub" style="display:block;margin-top:12px">예약·취소 마감</label>
      <select id="cutoffInput" style="margin-top:4px">
        <option value="0">마감 없음</option>
        <option value="1">1시간 전까지</option>
        <option value="2">2시간 전까지</option>
        <option value="6">6시간 전까지</option>
        <option value="24">24시간 전까지</option>
      </select>
      <label class="sub" style="display:block;margin-top:12px">노쇼 제한</label>
      <select id="noShowInput" style="margin-top:4px">
        <option value="99">제한 없음</option>
        <option value="2">2회 누적 시 차단</option>
        <option value="3">3회 누적 시 차단</option>
        <option value="5">5회 누적 시 차단</option>
      </select>
      <label class="sub" style="display:block;margin-top:12px">기본 테마 (신규 회원)</label>
      <select id="themeInput" style="margin-top:4px">
        <option value="dark">🌙 다크 모드</option>
        <option value="light">☀️ 라이트 모드</option>
      </select>
      <div class="sub" style="margin-top:4px;font-size:12px">개별 회원은 상단 🌙/☀️ 버튼으로 직접 바꿀 수 있습니다.</div>
      <button class="mini-btn" onclick="saveStoreSettings()" style="margin-top:12px;width:100%">전체 설정 저장</button>
    </div>
    <p class="mini-label" style="margin-top:20px">프로</p>`;
  ps.docs.forEach(d => {
    const p = d.data();
    const wh = p.workHours || { start: "10:00", end: "22:00" };
    const photo = p.photoURL
      ? `<img src="${p.photoURL}" class="pro-thumb">`
      : `<div class="avatar">${(p.name||"").slice(0,2)}</div>`;
    html += `<div class="bk-card pro-card" onclick="openProEdit('${d.id}')">
      <div style="display:flex;gap:12px;align-items:center">
        ${photo}
        <div style="flex:1">
          <b>${esc(p.name)}</b> · <span class="sub">${esc(p.title || "프로")}</span>
          <div class="sub" style="margin-top:2px">${p.active ? "🟢 활성" : "⚪ 비활성"} · 운영 ${wh.start}~${wh.end}</div>
        </div>
        <span class="chev">›</span>
      </div>
    </div>`;
  });
  html += `<button class="btn-ghost" onclick="addPro()" style="margin-top:6px">+ 프로 추가</button>`;
  html += `<p class="mini-label" style="margin-top:20px">레슨 종류</p>`;
  ls.docs.forEach(d => {
    const l = d.data();
    html += `<div class="bk-card"><div class="bk-top">
      <div><b>${l.name}</b> · ${l.durationMin}분</div>
      <button class="mini-btn danger" onclick="deleteLesson('${d.id}','${l.name}')">삭제</button>
    </div></div>`;
  });
  html += `<button class="btn-ghost" onclick="addLesson()" style="margin-top:6px">+ 레슨 추가</button>`;
  box.innerHTML = html;
  // select 현재값 반영
  const bw = $("bookWindowInput"); if (bw) bw.value = String(bookWindowWeeks);
  const co = $("cutoffInput"); if (co) co.value = String(cutoffHours);
  const ns = $("noShowInput"); if (ns) ns.value = String(noShowLimit);
}
window.toggleProActive = async (id, cur) => {
  await updateDoc(doc(db, "pros", id), { active: !cur }); renderAdminManage();
};

// ---------- 프로 편집 ----------
let editingProId = null;
function hourSelectOptions(selected) {
  let o = "";
  for (let h = 0; h <= 24; h++) {
    const v = String(h).padStart(2,"0")+":00";
    o += `<option value="${v}" ${v===selected?"selected":""}>${h}:00</option>`;
  }
  return o;
}
window.openProEdit = async (id) => {
  editingProId = id;
  show("proEditView");
  const snap = await getDoc(doc(db, "pros", id));
  const p = snap.exists() ? snap.data() : {};
  const wh = p.workHours || { start: "10:00", end: "22:00" };
  $("pedPhoto").value = p.photoURL || "";
  $("pedName").value = p.name || "";
  $("pedTitle").value = p.title || "";
  $("pedBio").value = p.bio || "";
  $("pedCareer").value = (p.career || []).join("\n");
  $("pedStart").innerHTML = hourSelectOptions(wh.start);
  $("pedEnd").innerHTML = hourSelectOptions(wh.end);
  $("pedActive").checked = p.active !== false;
  proEditPhotoPreview();
};
window.proEditPhotoPreview = () => {
  const url = $("pedPhoto").value.trim();
  $("proEditPhoto").innerHTML = url
    ? `<img src="${url}" class="pro-photo-lg" onerror="this.style.display='none'">`
    : `<div class="avatar lg">${($("pedName").value||"").slice(0,2)}</div>`;
};
window.saveProEdit = async () => {
  const name = $("pedName").value.trim();
  if (!name) { alert("이름을 입력하세요."); return; }
  const start = $("pedStart").value, end = $("pedEnd").value;
  if (start >= end) { alert("운영 시작 시각이 종료보다 빨라야 합니다."); return; }
  const data = {
    name, title: $("pedTitle").value.trim(), bio: $("pedBio").value.trim(),
    career: $("pedCareer").value.split("\n").map(s => s.trim()).filter(Boolean),
    photoURL: $("pedPhoto").value.trim(),
    workHours: { start, end },
    active: $("pedActive").checked
  };
  try {
    await updateDoc(doc(db, "pros", editingProId), data);
    alert("저장되었습니다.");
    adminTab("manage");
  } catch (e) { alert("저장 실패: " + e.message); }
};
window.deletePro = async () => {
  if (!confirm("이 프로를 삭제할까요?\n(이미 잡힌 예약·슬롯은 남습니다. 비활성을 권장)")) return;
  try {
    await deleteDoc(doc(db, "pros", editingProId));
    alert("삭제되었습니다.");
    adminTab("manage");
  } catch (e) { alert("삭제 실패: " + e.message); }
};
// 매장 설정 저장 (이름·범위·마감·노쇼)
window.saveStoreSettings = async () => {
  const name = $("storeNameInput").value.trim();
  const weeks = parseInt($("bookWindowInput").value, 10);
  const cutoff = parseInt($("cutoffInput").value, 10);
  const ns = parseInt($("noShowInput").value, 10);
  if (!name) { alert("매장 이름을 입력하세요."); return; }
  try {
    await setDoc(doc(db, "settings", "store"),
      { name, bookWindowWeeks: weeks, cutoffHours: cutoff, noShowLimit: ns }, { merge: true });
    storeName = name; bookWindowWeeks = weeks; cutoffHours = cutoff; noShowLimit = ns;
    applyStoreName();
    alert("매장 설정이 저장되었습니다.");
  } catch (e) { alert("저장 실패: " + e.message); }
};
window.addPro = async () => {
  const name = prompt("새 프로 이름?"); if (!name || !name.trim()) return;
  try {
    const ref = await addDoc(collection(db, "pros"),
      { name: name.trim(), title: "프로", bio: "", career: [], photoURL: "",
        active: true, workHours: { start: "10:00", end: "22:00" } });
    openProEdit(ref.id);  // 바로 편집 화면으로 → 나머지 정보 입력
  } catch (e) { alert("추가 실패: " + e.message); }
};
window.addLesson = async () => {
  const name = prompt("레슨 이름? (예: 개인 30분)"); if (!name) return;
  const dur = parseInt(prompt("시간(분)?") || "30", 10);
  try { await addDoc(collection(db, "lessonTypes"),
    { name, durationMin: dur, order: 99, active: true }); renderAdminManage(); }
  catch (e) { alert("추가 실패: " + e.message); }
};
window.deleteLesson = async (id, name) => {
  if (!confirm(`'${name}' 레슨을 삭제할까요?`)) return;
  try { await deleteDoc(doc(db, "lessonTypes", id)); renderAdminManage(); }
  catch (e) { alert("삭제 실패: " + e.message); }
};

// ============================================================
// [4-A] 게시판 — 공지/자유/질문, 작성·삭제, 댓글
// ============================================================
let boardCategory = "all";
window.openBoard = () => { resetNlSearch(); show("boardView"); boardCategory = "all"; setBoardFilter("all"); };

window.setBoardFilter = (cat) => {
  boardCategory = cat;
  document.querySelectorAll("#boardFilter button").forEach(b =>
    b.classList.toggle("on", b.dataset.cat === cat));
  loadPosts();
};

async function loadPosts() {
  const box = $("postList");
  box.innerHTML = `<p class="hint">불러오는 중…</p>`;
  const snap = await getDocs(collection(db, "posts"));
  let list = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  if (boardCategory !== "all") list = list.filter(p => p.category === boardCategory);
  list.sort((a, b) => (b.isPinned ? 1 : 0) - (a.isPinned ? 1 : 0));
  if (list.length === 0) { box.innerHTML = `<p class="hint">게시글이 없습니다.</p>`; return; }
  const catLabel = { notice: "공지", free: "자유", swing: "질문" };
  let html = "";
  list.forEach(p => {
    const isMine = p.authorId === me.uid;
    const canDelete = isMine || myProfile?.role === "admin";
    html += `<div class="post-card ${p.isPinned ? 'pinned' : ''}">
      <div class="post-top">
        <span class="post-cat">${p.isPinned ? "📌 " : ""}${catLabel[p.category] || ""}</span>
        ${canDelete ? `<button class="mini-btn danger" onclick="deletePost('${p.id}')">삭제</button>` : ""}
      </div>
      <div class="post-title">${esc(p.title)}</div>
      <div class="post-body">${esc(p.content)}</div>
      <div class="post-meta">${p.isAnonymous ? "익명" : esc(p.authorName || "회원")}</div>
      <div class="post-actions">
        <button class="like-btn" onclick="toggleLike('${p.id}')"><span id="like-ic-${p.id}">♡</span> <span id="like-cnt-${p.id}">${p.likeCount || 0}</span></button>
        <button class="cmt-toggle" onclick="toggleComments('${p.id}')">💬 댓글</button>
      </div>
      <div class="cmt-area hide" id="cmt-${p.id}"></div>
    </div>`;
  });
  box.innerHTML = html;
  // 좋아요 상태 표시 (내가 눌렀는지)
  list.forEach(p => refreshLikeUI(p.id));
}

// 내가 좋아요 눌렀는지 확인해 하트 채우기
async function refreshLikeUI(postId) {
  try {
    const mine = await getDoc(doc(db, "posts", postId, "likes", me.uid));
    const ic = $(`like-ic-${postId}`);
    if (ic) ic.textContent = mine.exists() ? "♥" : "♡";
  } catch {}
}

// 좋아요 토글 (likes/{uid} 문서 + likeCount 트랜잭션)
window.toggleLike = async (postId) => {
  const likeRef = doc(db, "posts", postId, "likes", me.uid);
  const postRef = doc(db, "posts", postId);
  try {
    await runTransaction(db, async (tx) => {
      const likeSnap = await tx.get(likeRef);
      const postSnap = await tx.get(postRef);
      const cur = postSnap.data().likeCount || 0;
      if (likeSnap.exists()) {
        tx.delete(likeRef);
        tx.update(postRef, { likeCount: Math.max(0, cur - 1) });
      } else {
        tx.set(likeRef, { createdAt: serverTimestamp() });
        tx.update(postRef, { likeCount: cur + 1 });
      }
    });
    // UI 갱신
    const fresh = await getDoc(postRef);
    $(`like-cnt-${postId}`).textContent = fresh.data().likeCount || 0;
    refreshLikeUI(postId);
  } catch (e) { alert("처리 실패: " + e.message); }
};

// 댓글 영역 토글 + 로드
window.toggleComments = async (postId) => {
  const area = $(`cmt-${postId}`);
  if (!area.classList.contains("hide")) { area.classList.add("hide"); return; }
  area.classList.remove("hide");
  area.innerHTML = `<p class="sub">불러오는 중…</p>`;
  const snap = await getDocs(collection(db, "posts", postId, "comments"));
  const cmts = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0));
  let html = "";
  cmts.forEach(c => {
    const mine = c.authorId === me.uid || myProfile?.role === "admin";
    const isStaff = c.authorRole === "admin" || c.authorRole === "pro";
    html += `<div class="cmt ${isStaff ? 'staff' : ''}">
      <div><b>${esc(c.authorName)}</b>${isStaff ? ' <span class="staff-badge">프로</span>' : ''}
        ${mine ? `<button class="cmt-del" onclick="deleteComment('${postId}','${c.id}')">×</button>` : ''}</div>
      <div class="sub">${esc(c.content)}</div></div>`;
  });
  html += `<div class="cmt-write">
    <input id="cmt-in-${postId}" placeholder="댓글 입력">
    <button onclick="addComment('${postId}')">등록</button></div>`;
  area.innerHTML = html;
};

window.addComment = async (postId) => {
  const inp = $(`cmt-in-${postId}`);
  const content = inp.value.trim(); if (!content) return;
  try {
    await addDoc(collection(db, "posts", postId, "comments"), {
      content, authorId: me.uid, authorName: myProfile?.name || "회원",
      authorRole: myProfile?.role || "member", createdAt: serverTimestamp()
    });
    $(`cmt-${postId}`).classList.add("hide");
    toggleComments(postId);  // 다시 열며 갱신
  } catch (e) { alert("댓글 등록 실패: " + e.message); }
};
window.deleteComment = async (postId, cid) => {
  if (!confirm("댓글을 삭제할까요?")) return;
  try {
    await deleteDoc(doc(db, "posts", postId, "comments", cid));
    const area = $(`cmt-${postId}`); area.classList.add("hide"); toggleComments(postId);
  } catch (e) { alert("삭제 실패: " + e.message); }
};

window.openPostWrite = () => show("postWriteView");
window.createPost = async () => {
  const title = $("pwTitle").value.trim(), content = $("pwContent").value.trim();
  const category = $("pwCategory").value;
  if (!title || !content) return alert("제목과 내용을 입력하세요.");
  const isAdminOrPro = myProfile?.role === "admin" || myProfile?.role === "pro";
  const btn = $("pwSubmit"); btn.disabled = true; btn.textContent = "등록 중…";
  try {
    await addDoc(collection(db, "posts"), {
      category, title, content,
      authorId: me.uid, authorName: myProfile?.name || "회원",
      isAnonymous: $("pwAnon").checked,
      isPinned: (category === "notice" && isAdminOrPro) ? $("pwPin").checked : false,
      createdAt: serverTimestamp()
    });
    $("pwTitle").value = ""; $("pwContent").value = ""; $("pwAnon").checked = false;
    openBoard();
  } catch (e) {
    alert("등록 실패: " + e.message);
  } finally { btn.disabled = false; btn.textContent = "등록"; }
};
window.deletePost = async (id) => {
  if (!confirm("이 글을 삭제할까요?")) return;
  try { await deleteDoc(doc(db, "posts", id)); loadPosts(); }
  catch (e) { alert("삭제 실패: " + e.message); }
};
const esc = (s) => (s || "").replace(/[&<>"]/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ============================================================
// [4-B] 반복예약 — STEP1 토글에서 진입 (별도 화면 폐지)
// ============================================================

// 반복 패턴 등록: STEP1의 draft(프로·레슨) + 요일·시간으로 향후 N주 예약
window.registerRecurring = async () => {
  const proId = draft.proId, lessonTypeId = draft.lessonTypeId;
  const proName = draft.proName, lessonName = draft.lessonName;
  const passId = draft.passId;
  const weekday = parseInt($("rcWeekday").value, 10);
  const time = $("rcTime").value;
  const weeks = parseInt($("rcWeeks").value, 10);
  const everyOther = $("rcEvery").value === "2";
  if (!passId) return alert("이용권을 먼저 선택하세요.");
  if (!time) return alert("시간을 선택하세요.");

  const btn = $("toStep2"); btn.disabled = true; btn.textContent = "등록 중…";
  try {
    // 이용권 잔여 확인
    const passSnap = await getDoc(doc(db, "passes", passId));
    if (!passSnap.exists()) throw new Error("이용권을 찾을 수 없습니다.");
    const passRem = passSnap.data().remaining || 0;
    if (passRem < 1) throw new Error("이용권 잔여 횟수가 없습니다.");

    // 패턴 문서 저장
    await addDoc(collection(db, "recurring"), {
      memberId: me.uid, proId, proName, lessonTypeId, lessonName, passId,
      weekday, time, everyOther, weeks, createdAt: serverTimestamp()
    });

    // 해당 요일의 향후 날짜 계산
    const dates = [];
    const today = new Date(); today.setHours(0,0,0,0);
    let count = 0, wk = 0;
    for (let i = 0; i < weeks * 7 + 7 && count < weeks; i++) {
      const d = new Date(today); d.setDate(d.getDate() + i);
      if (d.getDay() === weekday) {
        if (!everyOther || wk % 2 === 0) {
          const ds = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
          dates.push(ds); count++;
        }
        wk++;
      }
    }

    // 각 날짜의 열린 슬롯을 트랜잭션 예약 + 이용권 차감
    let ok = 0, skip = 0, noPass = 0;
    for (const date of dates) {
      const ss = await getDocs(query(collection(db, "slots"),
        where("proId", "==", proId), where("date", "==", date), where("time", "==", time)));
      if (ss.empty || ss.docs[0].data().status !== "open") { skip++; continue; }
      const slotId = ss.docs[0].id;
      try {
        await runTransaction(db, async (tx) => {
          const sRef = doc(db, "slots", slotId);
          const pRef = doc(db, "passes", passId);
          const fresh = await tx.get(sRef);
          const pFresh = await tx.get(pRef);
          if (!fresh.exists() || fresh.data().status !== "open") throw new Error("taken");
          const rem = pFresh.data().remaining || 0;
          if (rem < 1) throw new Error("nopass");
          tx.update(sRef, { status: "booked", bookedBy: me.uid });
          tx.update(pRef, { remaining: rem - 1 });
          tx.set(doc(collection(db, "bookings")), {
            slotId, proId, proName, lessonTypeId, lessonName, passId,
            memberId: me.uid, memberName: myProfile?.name || "회원",
            date, time, people: 1, request: "[반복예약]",
            status: "confirmed", createdAt: serverTimestamp()
          });
        });
        ok++;
      } catch (e) {
        if (e.message === "nopass") { noPass++; break; }   // 이용권 소진 → 중단
        skip++;
      }
    }

    let msg = `반복예약 완료!\n예약 성공: ${ok}건`;
    if (skip) msg += ` / 불가(미개설·마감): ${skip}건`;
    if (noPass) msg += `\n⚠️ 이용권이 소진되어 ${noPass}건 이후는 예약하지 못했습니다.`;
    if (ok === 0 && skip > 0 && !noPass)
      msg = `반복 패턴은 저장됐지만, 예약된 건이 없어요.\n\n선택한 요일·시간(${time})에 열린 슬롯이 없습니다.\n관리자가 해당 날짜의 슬롯을 먼저 열어야 자동 예약됩니다.`;
    alert(msg);
    show("homeView"); renderHome();
  } catch (e) {
    alert("반복예약 등록 실패: " + e.message);
  } finally {
    btn.disabled = false; btn.textContent = "반복예약 등록";
  }
};

window.deleteRecurring = async (id) => {
  if (!confirm("이 반복예약 패턴을 삭제할까요? (이미 잡힌 예약은 내 예약에서 개별 취소하세요)")) return;
  await deleteDoc(doc(db, "recurring", id)); openMyBookings();
};

// ============================================================
// [4-C] 수강권 — 보유 현황 (발급은 관리자, 차감은 예약 시)
// ============================================================
// (openPasses 함수는 이용권 탭 제거로 삭제됨 — 이용권은 홈에 통합)

// ---------- 회원 관리 ----------
let allMembers = [];
async function renderAdminMembers() {
  const box = $("adminBody");
  box.innerHTML = `<p class="hint">불러오는 중…</p>`;
  const snap = await getDocs(collection(db, "users"));
  allMembers = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  box.innerHTML = `
    <p class="mini-label">회원 (${allMembers.length}명)</p>
    <input id="memberSearch" placeholder="이름·연락처 검색" oninput="filterMembers()" style="margin-bottom:12px">
    <div id="memberList"></div>`;
  drawMembers(allMembers);
}
window.filterMembers = () => {
  const q = $("memberSearch").value.trim().toLowerCase();
  const filtered = !q ? allMembers : allMembers.filter(m =>
    (m.name || "").toLowerCase().includes(q) || (m.phone || "").includes(q));
  drawMembers(filtered);
};
function drawMembers(list) {
  const box = $("memberList");
  if (!list.length) { box.innerHTML = `<p class="hint">회원이 없습니다.</p>`; return; }
  let html = "";
  list.forEach(m => {
    const noShow = m.penalty?.noShowCount || 0;
    const roleBadge = m.role === "admin" ? '<span class="att-badge ok">관리자</span>'
      : m.role === "pro" ? '<span class="att-badge ok">프로</span>' : '';
    html += `<div class="bk-card">
      <div class="bk-top"><div><b>${esc(m.name || "회원")}</b> ${roleBadge}</div>
        ${noShow > 0 ? `<span class="att-badge no">노쇼 ${noShow}</span>` : ""}</div>
      <div class="sub">${esc(m.phone || "연락처 없음")} · ${esc(m.email || "")}</div>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <button class="mini-btn" onclick="issuePassFor('${m.id}','${esc(m.name||"회원")}')">🎫 발급</button>
        <button class="mini-btn" onclick="toggleMemberPasses('${m.id}')">📋 수강권 보기</button>
        ${noShow > 0 ? `<button class="mini-btn" onclick="resetNoShow('${m.id}')">노쇼 초기화</button>` : ""}
      </div>
      <div class="member-passes hide" id="mp-${m.id}"></div>
    </div>`;
  });
  box.innerHTML = html;
}
// 회원 수강권 목록 펼치기/접기
window.toggleMemberPasses = async (memberId) => {
  const area = $(`mp-${memberId}`);
  if (!area.classList.contains("hide")) { area.classList.add("hide"); return; }
  area.classList.remove("hide");
  area.innerHTML = `<p class="sub" style="margin-top:10px">불러오는 중…</p>`;
  const snap = await getDocs(query(collection(db, "passes"), where("memberId", "==", memberId)));
  if (snap.empty) { area.innerHTML = `<p class="sub" style="margin-top:10px">발급된 수강권이 없습니다.</p>`; return; }
  let html = `<div style="margin-top:10px;border-top:1px solid var(--line);padding-top:10px">`;
  snap.docs.forEach(d => {
    const p = d.data();
    html += `<div class="pass-row">
      <div><b>${esc(p.lessonName)}</b> · 잔여 ${p.remaining ?? p.total}/${p.total}회${p.expireAt?` · ~${p.expireAt}`:""}</div>
      <button class="mini-btn danger" onclick="deletePass('${d.id}','${memberId}')">삭제</button>
    </div>`;
  });
  html += `</div>`;
  area.innerHTML = html;
};
// 수강권 삭제
window.deletePass = async (passId, memberId) => {
  if (!confirm("이 수강권을 삭제할까요? 되돌릴 수 없습니다.")) return;
  try {
    await deleteDoc(doc(db, "passes", passId));
    // 목록 갱신: 닫았다 다시 열기
    $(`mp-${memberId}`).classList.add("hide");
    toggleMemberPasses(memberId);
  } catch (e) { alert("삭제 실패: " + e.message); }
};
// 특정 회원에게 수강권 발급
let passModalCtx = null;  // {memberId, memberName}
window.issuePassFor = async (memberId, memberName) => {
  passModalCtx = { memberId, memberName };
  $("passModalMember").textContent = `${memberName}님에게 발급`;
  // 프로·레슨 옵션
  const [ps, ls] = await Promise.all([
    getDocs(query(collection(db, "pros"), where("active", "==", true))),
    getDocs(query(collection(db, "lessonTypes"), where("active", "==", true)))
  ]);
  $("pmPro").innerHTML = ps.docs.map(d => `<option value="${d.id}" data-name="${esc(d.data().name)}">${esc(d.data().name)}</option>`).join("");
  $("pmLesson").innerHTML = ls.docs.sort((a,b)=>(a.data().order||0)-(b.data().order||0))
    .map(d => `<option value="${d.id}" data-name="${esc(d.data().name)}">${esc(d.data().name)}</option>`).join("");
  $("pmTotal").value = "10"; $("pmExpire").value = ""; refreshDatePickerLabel($("pmExpire"));
  $("passModal").classList.remove("hide");
};
window.closePassModal = () => { $("passModal").classList.add("hide"); passModalCtx = null; };
window.submitIssuePass = async () => {
  if (!passModalCtx) return;
  const proSel = $("pmPro"), lsSel = $("pmLesson");
  if (!proSel.value || !lsSel.value) { alert("프로와 레슨을 선택하세요."); return; }
  const total = parseInt($("pmTotal").value, 10);
  if (isNaN(total) || total < 1) { alert("총 횟수를 올바르게 입력하세요."); return; }
  const data = {
    memberId: passModalCtx.memberId, memberName: passModalCtx.memberName,
    proId: proSel.value, proName: proSel.selectedOptions[0].dataset.name,
    lessonTypeId: lsSel.value, lessonName: lsSel.selectedOptions[0].dataset.name,
    total, remaining: total, expireAt: $("pmExpire").value || "",
    status: "active", createdAt: serverTimestamp()
  };
  try {
    await addDoc(collection(db, "passes"), data);
    alert(`${data.memberName}님에게 ${data.proName}·${data.lessonName} (${total}회) 발급 완료`);
    closePassModal(); renderAdminMembers();
  } catch (e) { alert("발급 실패: " + e.message); }
};
// 노쇼 카운트 초기화
window.resetNoShow = async (memberId) => {
  if (!confirm("이 회원의 노쇼 기록을 초기화할까요?")) return;
  try {
    await updateDoc(doc(db, "users", memberId), { "penalty.noShowCount": 0 });
    renderAdminMembers();
  } catch (e) { alert("초기화 실패: " + e.message); }
};

window.issuePass = async () => {
  const phone = prompt("발급 대상 회원의 연락처? (정확히 일치해야 함)"); if (!phone) return;
  const us = await getDocs(query(collection(db, "users"), where("phone", "==", phone)));
  if (us.empty) { alert("해당 연락처의 회원을 찾을 수 없습니다."); return; }
  const memberId = us.docs[0].id, memberName = us.docs[0].data().name;
  const lessonName = prompt("수강권 이름? (예: 개인30분 10회권)") || "수강권";
  const total = parseInt(prompt("총 횟수?") || "10", 10);
  const expireAt = prompt("만료일? (YYYY-MM-DD)") || "";
  try {
    await addDoc(collection(db, "passes"),
      { memberId, memberName, lessonName, total, remaining: total, expireAt, status: "active", createdAt: serverTimestamp() });
    alert(`${memberName}님에게 ${lessonName}(${total}회) 발급 완료`);
  } catch (e) { alert("발급 실패: " + e.message); }
};

// ============================================================
// [자연어 예약] — 한국어 표현 → 슬롯 조건 → 후보 3개 제시
// ============================================================

// 파서: 자연어 문자열 → { dateRange: [from, to], timeRange: [startH, endH] }
// 입력의 "예약 의도"를 점검 — 'booking' | 'other' | 'ambiguous'
// booking: 명확한 예약 의도 (날짜·시간 키워드 있음)
// other: 명백한 무관 질문 (제외 키워드)
// ambiguous: 둘 다 아님 → AI에게 판단 위임
function classifyIntent(text) {
  const s = text.trim().toLowerCase();
  // 1. 너무 짧거나 의미없는 입력
  if (s.length < 2) return "other";
  if (/^[ㅋㅎ?!.,~\s]+$/.test(s)) return "other";

  // 2. 명백한 무관 키워드
  const otherKeywords = [
    "날씨","기온","비와","눈와","태풍",
    "몇살","나이","생일","주소","전화번호","이메일",
    "환율","주가","뉴스","주식","코인","비트",
    "맛집","음식","레시피","요리","배달",
    "영화","드라마","노래","음악",
    "축구","야구","농구","경기","승부",
    "대통령","총리","트럼프","바이든","정치",
    "이름이 뭐","넌 누구","너는 누구","너 누구","뭐 할 줄"
  ];
  if (otherKeywords.some(k => s.includes(k))) return "other";

  // 3. 예약 관련 신호 단어 (있으면 booking 쪽으로 강화)
  const bookingSignals = [
    "예약","레슨","연습","골프","프로","수강","이용권","슬롯","시간","비어","빈","가능",
    "오늘","내일","모레","주말","오전","오후","저녁","아침","점심","밤","새벽",
    "월","화","수","목","금","토","일",
    "시"  // "14시"
  ];
  const hasBookingSignal = bookingSignals.some(k => s.includes(k));
  // 숫자(날짜·시간 패턴)도 신호
  const hasNumber = /\d/.test(s);

  if (hasBookingSignal || hasNumber) return "booking";
  return "ambiguous";
}

function parseNaturalQuery(text) {
  const s = text.trim().toLowerCase().replace(/\s+/g, " ");
  const today = new Date(); today.setHours(0,0,0,0);
  const WEEK_KO = { "일":0,"월":1,"화":2,"수":3,"목":4,"금":5,"토":6 };
  let dateFrom = null, dateTo = null;
  let startH = 8, endH = 22;   // 기본: 종일
  let dateMatched = false, timeMatched = false;

  // ---- 날짜 파싱 ----
  // "오늘"
  if (/오늘/.test(s)) { dateFrom = new Date(today); dateTo = new Date(today); dateMatched = true; }
  // "내일"
  else if (/내일/.test(s)) {
    dateFrom = new Date(today); dateFrom.setDate(dateFrom.getDate()+1);
    dateTo = new Date(dateFrom); dateMatched = true;
  }
  // "모레"
  else if (/모레/.test(s)) {
    dateFrom = new Date(today); dateFrom.setDate(dateFrom.getDate()+2);
    dateTo = new Date(dateFrom); dateMatched = true;
  }
  // "이번 주말" / "주말"
  else if (/(이번\s*)?주말/.test(s)) {
    const day = today.getDay();
    const sat = new Date(today); sat.setDate(sat.getDate() + ((6 - day + 7) % 7));
    const sun = new Date(sat); sun.setDate(sun.getDate()+1);
    dateFrom = sat; dateTo = sun; dateMatched = true;
  }
  else {
    const dowMatch = s.match(/(다음\s*주|이번\s*주|담\s*주)?\s*([일월화수목금토])(?:요일)?/);
    if (dowMatch) {
      const isNext = !!dowMatch[1] && /다음|담/.test(dowMatch[1]);
      const targetDow = WEEK_KO[dowMatch[2]];
      let offset = (targetDow - today.getDay() + 7) % 7;
      if (offset === 0) offset = isNext ? 7 : 0;
      if (isNext) offset += 7;
      const d = new Date(today); d.setDate(d.getDate() + offset);
      dateFrom = d; dateTo = new Date(d); dateMatched = true;
    }
  }
  const ymd = s.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일|(\d{1,2})\/(\d{1,2})/);
  if (ymd) {
    const m = parseInt(ymd[1]||ymd[3],10), d = parseInt(ymd[2]||ymd[4],10);
    const y = today.getFullYear();
    let dt = new Date(y, m-1, d);
    if (dt < today) dt = new Date(y+1, m-1, d);
    dateFrom = dt; dateTo = new Date(dt); dateMatched = true;
  }

  // 날짜 못 잡았으면 오늘부터 7일을 검색 범위로
  if (!dateFrom) {
    dateFrom = new Date(today);
    dateTo = new Date(today); dateTo.setDate(dateTo.getDate()+7);
  }

  // ---- 시간 파싱 ----
  if (/새벽/.test(s)) { startH = 5; endH = 9; timeMatched = true; }
  if (/아침/.test(s)) { startH = 7; endH = 11; timeMatched = true; }
  if (/오전/.test(s)) { startH = 8; endH = 12; timeMatched = true; }
  if (/점심|낮/.test(s)) { startH = 11; endH = 14; timeMatched = true; }
  if (/오후/.test(s)) { startH = 12; endH = 18; timeMatched = true; }
  if (/저녁/.test(s)) { startH = 18; endH = 22; timeMatched = true; }
  if (/밤|야간/.test(s)) { startH = 20; endH = 24; timeMatched = true; }
  const hourMatch = s.match(/(\d{1,2})(?:시|:00)/);
  if (hourMatch) {
    let h = parseInt(hourMatch[1],10);
    if (/오후|저녁|밤/.test(s) && h < 12) h += 12;
    startH = h; endH = h + 2;
    if (endH > 24) endH = 24;
    timeMatched = true;
  }

  // 날짜 못 잡았으면 오늘부터 7일을 검색 범위로
  if (!dateFrom) {
    dateFrom = new Date(today);
    dateTo = new Date(today); dateTo.setDate(dateTo.getDate()+7);
  }

  return {
    dateFrom: ymdStr(dateFrom),
    dateTo: ymdStr(dateTo),
    startH, endH,
    confident: dateMatched   // 날짜라도 잡혔으면 규칙으로 충분
  };
}
function ymdStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

// Gemini API로 자연어 → JSON 조건 변환 (규칙 파서 폴백용)
// 키가 비어있거나 호출 실패 시 null 반환 → 호출자가 규칙 파서 결과로 폴백
async function geminiParseQuery(text) {
  if (!GEMINI_API_KEY) return null;
  const today = new Date();
  const todayStr = ymdStr(today);
  const W = ["일","월","화","수","목","금","토"];
  const dowStr = W[today.getDay()];

  const prompt = `당신은 한국어 골프 레슨 예약 검색 보조입니다.
오늘 날짜: ${todayStr} (${dowStr}요일)
사용자 입력: "${text}"

다음 두 가지 중 하나로만 답하세요 (JSON, 다른 설명 없이):

1) 사용자가 레슨 예약 시간을 묻는다면:
{"intent":"booking","dateFrom":"YYYY-MM-DD","dateTo":"YYYY-MM-DD","startH":숫자(0~24),"endH":숫자(0~24)}

2) 사용자가 예약과 무관한 질문(날씨, 인물, 잡담 등)을 하면:
{"intent":"other"}

규칙:
- dateFrom·dateTo는 검색 범위(같은 날이면 둘 다 동일)
- 모호한 표현("한가한", "조용한")은 평일 점심·오전을 우선
- "주말"은 가까운 토~일
- 시간 명시 없으면 startH=8, endH=22
- "저녁"=18~22, "오후"=12~18, "오전"=8~12, "점심"=11~14, "아침"=7~11`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 200 }
      })
    });
    if (!res.ok) throw new Error("Gemini HTTP " + res.status);
    const data = await res.json();
    let raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    raw = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);
    // 무관 의도면 명시 신호 반환
    if (parsed.intent === "other") return { intent: "other" };
    if (!parsed.dateFrom || !parsed.dateTo) return null;
    return {
      dateFrom: parsed.dateFrom,
      dateTo: parsed.dateTo,
      startH: Math.max(0, Math.min(24, parseInt(parsed.startH, 10) || 8)),
      endH: Math.max(0, Math.min(24, parseInt(parsed.endH, 10) || 22)),
      confident: true,
      viaAi: true
    };
  } catch (e) {
    console.warn("Gemini 파싱 실패:", e.message);
    return null;
  }
}

// 자연어 검색 실행
window.nlSearch = async () => {
  const q = $("nlQuery").value.trim();
  const box = $("nlResult");
  if (!q) { box.innerHTML = ""; return; }

  // ⛔ 의도 게이트: 명백한 무관 질문은 즉시 친근하게 거절
  const intent = classifyIntent(q);
  if (intent === "other") {
    box.innerHTML = `<p class="nl-result-head">🤔 "${esc(q)}"</p>
      <div class="nl-empty" style="text-align:left;line-height:1.6">
        죄송해요, 그건 제가 도와드릴 수 없어요.<br>
        저는 <b>레슨 예약 가능한 시간</b>을 찾아드려요.<br><br>
        <span class="sub">이렇게 말씀해보세요:</span><br>
        • "내일 저녁"<br>
        • "다음주 화요일 오후"<br>
        • "주말 아침"
      </div>`;
    return;
  }

  // 이용권 확인 (없으면 검색 의미 X)
  const usable = await getUsablePasses();
  if (usable.length === 0) {
    box.innerHTML = `<div class="nl-empty">예약 가능한 이용권이 없어요.<br>매장에서 발급받아주세요.</div>`;
    return;
  }

  let parsed = parseNaturalQuery(q);
  let viaAi = false;
  // 규칙 파서가 날짜를 못 잡았고 키가 있으면 Gemini로 재시도
  if (!parsed.confident && GEMINI_API_KEY) {
    box.innerHTML = `<p class="nl-result-head">✨ AI가 해석 중…</p>`;
    const aiResult = await geminiParseQuery(q);
    // Gemini가 무관 의도로 판단
    if (aiResult?.intent === "other") {
      box.innerHTML = `<p class="nl-result-head">🤔 "${esc(q)}"</p>
        <div class="nl-empty" style="text-align:left;line-height:1.6">
          죄송해요, 그건 제가 도와드릴 수 없어요.<br>
          저는 <b>레슨 예약 가능한 시간</b>을 찾아드려요.<br><br>
          <span class="sub">이렇게 말씀해보세요:</span><br>
          • "내일 저녁"<br>
          • "다음주 화요일 오후"<br>
          • "주말 아침"
        </div>`;
      return;
    }
    if (aiResult) { parsed = aiResult; viaAi = true; }
  }
  box.innerHTML = `<p class="nl-result-head">${viaAi ? "✨ AI 해석" : "🔍"} "${esc(q)}" 검색 중…</p>`;

  // 이용권별로 슬롯 검색해서 합치기 + 분류용 데이터 수집
  let candidates = [];
  let diagnostics = [];  // 빈 결과일 때 친근 메시지 생성용
  try {
    for (const pass of usable) {
      const [ss, blkSnap, proSnap] = await Promise.all([
        getDocs(query(collection(db, "slots"), where("proId", "==", pass.proId))),
        getDocs(query(collection(db, "blocks"), where("proId", "==", pass.proId))),
        getDoc(doc(db, "pros", pass.proId))
      ]);
      const proData = proSnap.exists() ? proSnap.data() : {};
      const workHours = proData.workHours || { start: "10:00", end: "22:00" };

      const blocksByDate = {};
      blkSnap.docs.forEach(b => {
        const d = b.data();
        if (d.date >= parsed.dateFrom && d.date <= parsed.dateTo) {
          (blocksByDate[d.date] ||= []).push(d);
        }
      });

      // 그 기간의 슬롯들 (개수 카운트용)
      const slotsInRange = ss.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(s => s.date >= parsed.dateFrom && s.date <= parsed.dateTo);

      ss.docs.forEach(d => {
        const s = d.data();
        if (s.status !== "open") return;
        if (s.date < parsed.dateFrom || s.date > parsed.dateTo) return;
        const h = parseInt(s.time.slice(0,2), 10);
        if (h < parsed.startH || h >= parsed.endH) return;
        if (isBlocked(blocksByDate[s.date] || [], s.time)) return;
        candidates.push({ slotId: d.id, ...s, pass });
      });

      diagnostics.push({
        pass, proName: pass.proName, workHours, blocksByDate, slotsInRange
      });
    }
  } catch (e) {
    box.innerHTML = `<p class="nl-result-head">${viaAi ? "✨ AI 해석" : "🔍"} "${esc(q)}"</p>
      <div class="nl-empty">검색 중 오류가 발생했어요.<br><span style="font-size:12px">${esc(e.message)}</span></div>`;
    return;
  }

  // 가까운 날짜·이른 시간 우선 정렬
  candidates.sort((a,b) => (a.date + a.time).localeCompare(b.date + b.time));
  const top3 = candidates.slice(0, 3);

  if (top3.length === 0) {
    const reason = diagnoseEmptyResult(parsed, diagnostics);
    box.innerHTML = `<p class="nl-result-head">${viaAi ? "✨ AI 해석" : "🔍"} "${esc(q)}"</p>
      <div class="nl-empty" style="text-align:left;line-height:1.6">${reason}</div>`;
    return;
  }

  const W = ["일","월","화","수","목","금","토"];
  let html = `<p class="nl-result-head">${viaAi ? "✨ AI 해석" : "🔍"} "${esc(q)}" — 추천 ${top3.length}개</p>`;
  top3.forEach(c => {
    const dt = new Date(c.date), dow = W[dt.getDay()];
    html += `<button class="nl-card" onclick="pickNlSlot('${c.pass.id}','${c.slotId}','${c.date}','${c.time}')">
      <div>
        <b>${dt.getMonth()+1}월 ${dt.getDate()}일(${dow}) ${c.time}</b>
        <div class="sub" style="margin-top:4px">${esc(c.pass.proName)} · ${esc(c.pass.lessonName)}</div>
      </div>
      <span class="chev">›</span>
    </button>`;
  });
  box.innerHTML = html;
};

// 검색 결과 카드 탭 → 평소 확정 흐름으로 진입
// 빈 결과의 원인을 분류해서 친근한 메시지로 변환
// 우선순위: 매장범위 → 차단(allDay) → 차단(range) → 운영시간 → 다 예약됨 → 슬롯 미오픈
function diagnoseEmptyResult(parsed, diagnostics) {
  const W = ["일","월","화","수","목","금","토"];
  const fmt = (ds) => {
    const d = new Date(ds);
    return `${d.getMonth()+1}월 ${d.getDate()}일(${W[d.getDay()]})`;
  };
  // 1) 매장 예약 가능 범위 초과 여부
  const today = new Date(); today.setHours(0,0,0,0);
  const maxDate = new Date(today);
  maxDate.setDate(maxDate.getDate() + (bookWindowWeeks || 4) * 7);
  const dateFromObj = new Date(parsed.dateFrom);
  if (dateFromObj > maxDate) {
    return `🗓️ 지금은 <b>${bookWindowWeeks}주 앞</b>까지만 예약할 수 있어요.<br>
      그 이후 일정은 매장 정책상 잠겨있어요. 시간이 좀 지난 후 다시 확인해주세요.`;
  }

  // 각 이용권(프로)별 분석 — 가장 적합한 메시지 1개 선택
  const reasons = [];
  for (const d of diagnostics) {
    const proName = d.proName || "프로";
    const wh = d.workHours;
    const sh = parseInt(wh.start.slice(0,2),10), eh = parseInt(wh.end.slice(0,2),10);

    // 2) 검색 첫 날이 하루 종일 차단된 경우
    const firstDateBlocks = d.blocksByDate[parsed.dateFrom] || [];
    const allDayBlock = firstDateBlocks.find(b => b.allDay);
    if (allDayBlock) {
      const reasonText = allDayBlock.reason ? ` (${esc(allDayBlock.reason)})` : "";
      reasons.push({
        priority: 2,
        msg: `📅 <b>${esc(proName)}님</b>이 ${fmt(parsed.dateFrom)}은 휴무로 정해두셨어요${reasonText}.<br>
          다른 날짜로 다시 검색해보세요.`
      });
      continue;
    }

    // 3) 검색 시간대 전체가 부분 차단으로 막힌 경우
    const rangeBlock = firstDateBlocks.find(b =>
      !b.allDay && b.startTime && b.endTime
      && parseInt(b.startTime.slice(0,2),10) <= parsed.startH
      && parseInt(b.endTime.slice(0,2),10) >= parsed.endH);
    if (rangeBlock) {
      const reasonText = rangeBlock.reason ? ` 사유: ${esc(rangeBlock.reason)}` : "";
      reasons.push({
        priority: 3,
        msg: `⏸️ <b>${esc(proName)}님</b>이 ${fmt(parsed.dateFrom)} 그 시간대(${rangeBlock.startTime}~${rangeBlock.endTime})를 비워두셨어요.${reasonText}<br>
          다른 시간이나 날짜로 검색해보세요.`
      });
      continue;
    }

    // 4) 검색 시간이 운영시간 밖
    if (parsed.endH <= sh || parsed.startH >= eh) {
      reasons.push({
        priority: 4,
        msg: `🕐 <b>${esc(proName)}님</b>의 운영시간은 ${wh.start}~${wh.end}예요.<br>
          그 시간대는 운영하지 않아 검색 결과가 없어요. 운영시간 안으로 다시 검색해보세요.`
      });
      continue;
    }

    // 5) 슬롯이 있긴 한데 모두 예약됨 또는 차단됨
    const inRangeSlots = d.slotsInRange.filter(s => {
      const h = parseInt(s.time.slice(0,2),10);
      return h >= parsed.startH && h < parsed.endH;
    });
    if (inRangeSlots.length > 0) {
      const booked = inRangeSlots.filter(s => s.status === "booked").length;
      if (booked === inRangeSlots.length) {
        reasons.push({
          priority: 5,
          msg: `🔥 그 시간대 <b>${esc(proName)}님</b> 예약이 다 차버렸어요 😅<br>
            인기 있는 시간이라 빠르게 마감됐네요. 다른 날짜·시간을 시도해보세요.`
        });
        continue;
      }
    }

    // 6) 슬롯 자체가 안 열림
    if (d.slotsInRange.length === 0) {
      reasons.push({
        priority: 6,
        msg: `⏳ 아직 그 날짜의 예약 시간이 열리지 않았어요.<br>
          보통 일정이 가까워지면 열리니, 조금 후 다시 확인해주세요.`
      });
      continue;
    }

    // 7) 위 다 아니지만 결과 없음 (드문 케이스)
    reasons.push({
      priority: 7,
      msg: `검색 조건에 맞는 빈 시간을 찾지 못했어요.<br>다른 날짜·시간으로 다시 검색해보세요.`
    });
  }

  // 가장 구체적인(낮은 priority 숫자) 메시지 선택
  if (reasons.length === 0) {
    return "검색 조건에 맞는 빈 시간을 찾지 못했어요.<br>다른 날짜·시간으로 다시 검색해보세요.";
  }
  reasons.sort((a,b) => a.priority - b.priority);
  return reasons[0].msg;
}

window.pickNlSlot = async (passId, slotId, date, time) => {
  const ps = await getDoc(doc(db, "passes", passId));
  if (!ps.exists()) return alert("이용권을 찾을 수 없어요.");
  const p = ps.data();
  draft = {
    proId: p.proId, proName: p.proName,
    lessonTypeId: p.lessonTypeId, lessonName: p.lessonName,
    passId, slotId, date, time, people: 1
  };
  try {
    const pro = await getDoc(doc(db, "pros", p.proId));
    if (pro.exists()) draftWorkHours = pro.data().workHours || null;
  } catch {}
  // STEP2로 가서 그 날짜 자동 선택 → 확정 흐름
  rebookHint = { date, time };
  openStep2();
};

// 음성 입력 (Web Speech API)
let nlRecognition = null;
let nlOriginalPlaceholder = "";
window.nlVoice = () => {
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Rec) { alert("이 브라우저는 음성 인식을 지원하지 않아요. Chrome·Safari 최신 버전을 이용해주세요."); return; }
  const btn = $("nlMicBtn");
  const input = $("nlQuery");
  const wrap = input.parentElement;
  // 이미 녹음 중이면 중지
  if (nlRecognition) {
    try { nlRecognition.stop(); } catch {}
    return;  // onend 핸들러가 정리 담당
  }
  nlRecognition = new Rec();
  nlRecognition.lang = "ko-KR";
  nlRecognition.interimResults = true;   // 실시간 인식 텍스트 표시
  nlRecognition.continuous = false;
  nlRecognition.maxAlternatives = 1;

  // 녹음 시작 UI
  btn.classList.add("recording");
  btn.textContent = "⏹";   // 정지 아이콘
  btn.title = "정지";
  wrap.classList.add("listening");
  nlOriginalPlaceholder = input.placeholder;
  input.placeholder = "🎙️  말씀하세요…";
  input.value = "";   // 새 인식 시작 시 입력창 비움

  let finalText = "";
  nlRecognition.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    // 실시간으로 입력창 업데이트 (확정 + 인식 중)
    input.value = (finalText + interim).trim();
  };
  nlRecognition.onerror = (e) => {
    const msgMap = {
      "no-speech": "말소리가 감지되지 않았어요. 다시 시도해주세요.",
      "audio-capture": "마이크를 찾을 수 없어요. 기기를 확인해주세요.",
      "not-allowed": "마이크 권한이 필요해요. 주소창 옆 자물쇠 아이콘에서 허용해주세요.",
      "aborted": null   // 사용자가 직접 멈춘 경우 — 알림 없음
    };
    const msg = msgMap[e.error];
    if (msg) alert(msg);
  };
  nlRecognition.onend = () => {
    // UI 원복
    btn.classList.remove("recording");
    btn.textContent = "🎤";
    btn.title = "음성 입력";
    wrap.classList.remove("listening");
    input.placeholder = nlOriginalPlaceholder;
    nlRecognition = null;
    // 인식된 텍스트가 있으면 자동 검색
    if (input.value.trim()) nlSearch();
  };
  nlRecognition.start();
};
