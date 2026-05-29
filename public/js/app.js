// ============================================================
// app.js — OK골프 예약 PWA
// 정의서 3-2 구현: 단골1탭(F1) / 슬롯접기(F2·F3) / 정보자동채움(F5) / 예약확인통합(F6)
// ============================================================
import { auth, db, isConfigured } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, updateProfile
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
  // Google redirect 로그인 결과 받기 (모바일)
  getRedirectResult(auth).catch(() => {});
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
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  try {
    if (isMobile) await signInWithRedirect(auth, new GoogleAuthProvider());
    else await signInWithPopup(auth, new GoogleAuthProvider());
  }
  catch (e) { alert("구글 로그인 실패: " + e.message); }
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

  // 단골 1탭: 최근 완료/예약 1건 기준 추천
  const rb = $("rebookBox");
  try {
    const rs = await getDocs(query(collection(db, "bookings"),
      where("memberId", "==", me.uid)));
    const sorted = rs.docs
      .map(d => d.data())
      .filter(b => b.createdAt)
      .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    if (sorted.length > 0) {
      const b = sorted[0];
      rb.innerHTML = `<p class="mini-label">다시 예약하기</p>
        <div class="rebook-card">
          <div class="rebook-head">
            <div class="avatar">${b.proName.slice(0,2)}</div>
            <div><b>${b.proName} · ${b.lessonName}</b>
              <div class="sub">최근 예약 패턴으로 빠르게</div></div>
          </div>
          <button class="btn-primary" onclick='quickRebook(${JSON.stringify(b).replace(/'/g,"&#39;")})'>
            ↻ 지난 예약과 동일 조건으로</button>
        </div>`;
    } else {
      rb.innerHTML = `<p class="mini-label">첫 예약을 시작해보세요</p>`;
    }
  } catch { rb.innerHTML = ""; }
}
window.renderHome = renderHome;
const fmtDate = (s) => {
  const d = new Date(s), w = ["일","월","화","수","목","금","토"][d.getDay()];
  return `${d.getMonth()+1}/${d.getDate()}(${w})`;
};

// 단골 1탭 → 그 예약에 쓴 이용권을 자동 선택해 STEP2로 점프
window.quickRebook = async (b) => {
  if (!b.passId) { alert("이 예약과 연결된 이용권을 찾을 수 없어요. 새 예약으로 진행하세요."); return startNewBooking(); }
  // 이용권 유효성 확인
  const ps = await getDoc(doc(db, "passes", b.passId));
  if (!ps.exists() || (ps.data().remaining || 0) < 1) {
    alert("이용권의 잔여 횟수가 부족합니다. 매장에 문의하세요.");
    return;
  }
  pickPassForBooking(ps.id, ps.data());
  openStep2();
};

// ---------- 신규 예약 STEP1: 내 이용권 선택 ----------
window.startNewBooking = async () => {
  show("step1View");
  const box = $("passPick");
  box.innerHTML = `<p class="hint">불러오는 중…</p>`;
  // 내 이용권 중 잔여>0, 만료 안 됨
  const today = new Date().toISOString().slice(0, 10);
  const snap = await getDocs(query(collection(db, "passes"), where("memberId", "==", me.uid)));
  const usable = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(p => (p.remaining || 0) > 0 && (!p.expireAt || p.expireAt >= today));

  // 반복 토글 초기화
  $("recurOn").checked = false;
  $("recurOptions").classList.add("hide");
  $("recurToggleBox").style.display = "none";
  $("toStep2").style.display = "none";
  $("toStep2").disabled = true;
  $("toStep2").textContent = "다음";
  draft = { proId: null, proName: null, lessonTypeId: null, lessonName: null,
            passId: null, date: null, time: null, slotId: null, people: 1 };
  draftWorkHours = null;

  if (usable.length === 0) {
    box.innerHTML = `<div class="bk-card" style="text-align:center;padding:24px">
      <div style="font-size:32px;margin-bottom:8px">🎫</div>
      <b>예약 가능한 이용권이 없습니다</b>
      <div class="sub" style="margin-top:8px">예약하려면 매장에서 이용권을 발급받으세요.</div>
    </div>`;
    return;
  }

  // 이용권 1장이면 자동 선택 → 바로 STEP2
  if (usable.length === 1) {
    pickPassForBooking(usable[0].id, usable[0]);
    openStep2();
    return;
  }

  // 여러 장: 카드 목록에서 선택
  let html = "";
  usable.forEach(p => {
    html += `<button class="pick-card pass-pick" onclick="pickPassForBooking('${p.id}', ${JSON.stringify(p).replace(/"/g,'&quot;')})">
      <div style="flex:1;text-align:left">
        <b>${esc(p.proName || "")}</b> · ${esc(p.lessonName || "")}
        <div class="sub" style="margin-top:4px">잔여 <b style="color:var(--accent)">${p.remaining}</b>/${p.total}회${p.expireAt?` · 만료 ${p.expireAt}`:""}</div>
      </div>
      <span class="chev">›</span>
    </button>`;
  });
  box.innerHTML = html;
};

// 이용권 선택 → draft에 정보 박고 반복토글·다음버튼 활성화
window.pickPassForBooking = (passId, passOrJson) => {
  const p = typeof passOrJson === "string" ? JSON.parse(passOrJson.replace(/&quot;/g,'"')) : passOrJson;
  draft.passId = passId;
  draft.proId = p.proId; draft.proName = p.proName;
  draft.lessonTypeId = p.lessonTypeId; draft.lessonName = p.lessonName;
  // 운영시간 가져오기 (반복예약 시간 옵션용)
  getDoc(doc(db, "pros", p.proId)).then(s => {
    if (s.exists()) draftWorkHours = s.data().workHours || null;
  });
  // 선택 표시
  document.querySelectorAll("#passPick .pick-card").forEach(c => c.classList.remove("on"));
  if (event && event.currentTarget) event.currentTarget.classList.add("on");
  // 반복 토글·다음 버튼 노출
  $("recurToggleBox").style.display = "block";
  $("toStep2").style.display = "block";
  $("toStep2").disabled = false;
};

// 반복 토글 ON/OFF
window.toggleRecurOptions = () => {
  const on = $("recurOn").checked;
  $("recurOptions").classList.toggle("hide", !on);
  $("toStep2").textContent = on ? "반복예약 등록" : "다음";
  if (on) {
    fillRecurTimeOptions();
    // 반복 모드: 프로·레슨이 선택돼 있으면 버튼 활성화 (날짜 불필요)
    if (draft.proId && draft.lessonTypeId) $("toStep2").disabled = false;
  } else {
    // 1회 모드로 돌아오면 레슨 선택 여부에 따라
    $("toStep2").disabled = !(draft.proId && draft.lessonTypeId);
  }
};

// 선택한 프로의 운영시간 범위로 20분 단위 시간 옵션 채우기
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

// "다음" 버튼: 반복이면 등록, 아니면 날짜선택으로
window.step1Next = () => {
  if ($("recurOn").checked) {
    if (!draft.proId || !draft.lessonTypeId) {
      return alert("프로와 레슨을 먼저 선택해주세요.");
    }
    // 시간 옵션이 비어있으면 채우고 막음
    if (!$("rcTime").value) {
      fillRecurTimeOptions();
      if (!$("rcTime").value) return alert("시간 목록을 불러오지 못했어요. 프로를 다시 선택해주세요.");
    }
    registerRecurring();
  } else openStep2();
};
window.openStep2 = openStep2;
function openStep2() {
  show("step2View");
  $("s2Pro").textContent = `${draft.proName} · ${draft.lessonName}`;
  const t = new Date(); calCursor = new Date(t.getFullYear(), t.getMonth(), 1);
  renderDateBar();
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
window.openAdmin = () => { show("adminView"); adminTab("status"); };

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
    <input type="date" id="asDate" min="${today}" onchange="onAdminSlotChange()" style="margin-top:10px">
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
    <p class="mini-label">🚫 예약 차단 (프로 개인사정 등)</p>
    <select id="blkType" onchange="onBlkType()">
      <option value="allDay">하루 전체 휴무</option>
      <option value="range">특정 시간대만 차단</option>
    </select>
    <div id="blkRange" class="hide">
      <div style="display:flex;gap:8px;align-items:center;margin-top:10px">
        <select id="blkStart" style="flex:1">${timeOptions(adminSlotState.start, adminSlotState.end, false)}</select>
        <span>~</span>
        <select id="blkEnd" style="flex:1">${timeOptions(adminSlotState.start, adminSlotState.end, true)}</select>
      </div>
    </div>
    <input id="blkReason" placeholder="차단 사유 (예: 외부 레슨, 개인 사정)" style="margin-top:10px">
    <button class="btn-ghost" onclick="addBlock()" style="margin-top:10px">차단 등록</button>`;
  // 현재 차단 목록
  if (blocks.length) {
    html += `<p class="sub" style="margin-top:16px">현재 차단 목록</p>`;
    blkSnap.docs.forEach(d => {
      const b = d.data();
      const range = b.allDay ? "🌙 하루 전체 휴무" : `⏰ ${b.startTime} ~ ${b.endTime}`;
      html += `<div class="bk-card" style="margin-top:8px"><div class="bk-top">
        <div><b>${range}</b>${b.reason ? `<div class="sub" style="margin-top:2px">${esc(b.reason)}</div>` : ""}</div>
        <button class="mini-btn danger" onclick="removeBlock('${d.id}')">해제</button></div></div>`;
    });
  }
  html += `</div>`;
  grid.innerHTML = html;
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
};

// 차단 등록 — blkType 드롭다운 값으로 명확히 분기
window.addBlock = async () => {
  const { proId, date } = adminSlotState;
  if (!proId || !date) { alert("프로와 날짜를 먼저 선택하세요."); return; }
  const type = $("blkType").value;       // "allDay" | "range"
  const reason = $("blkReason").value.trim();
  const data = { proId, date, reason, allDay: type === "allDay", createdAt: serverTimestamp() };
  if (type === "range") {
    const s = $("blkStart").value, e = $("blkEnd").value;
    if (s >= e) { alert("시작 시각이 종료 시각보다 빨라야 합니다."); return; }
    data.startTime = s; data.endTime = e;
  }
  const label = type === "allDay" ? "하루 전체 휴무" : `${data.startTime}~${data.endTime} 차단`;
  if (!confirm(`${date}\n${label}${reason ? `\n사유: ${reason}` : ""}\n\n등록할까요?`)) return;
  try { await addDoc(collection(db, "blocks"), data); onAdminSlotChange(); }
  catch (err) { alert("차단 등록 실패: " + err.message); }
};
window.removeBlock = async (id) => {
  if (!confirm("이 차단을 해제할까요?")) return;
  try { await deleteDoc(doc(db, "blocks", id)); onAdminSlotChange(); }
  catch (err) { alert("해제 실패: " + err.message); }
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
    } else {
      const d = snap.docs[0];
      if (d.data().status === "booked") { alert("예약된 시간은 닫을 수 없어요."); return; }
      await deleteDoc(doc(db, "slots", d.id)); // 닫기
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
window.openBoard = () => { show("boardView"); boardCategory = "all"; setBoardFilter("all"); };

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
  $("pmTotal").value = "10"; $("pmExpire").value = "";
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
