// ============================================================
// app.js — OK골프 예약 PWA
// 정의서 3-2 구현: 단골1탭(F1) / 슬롯접기(F2·F3) / 정보자동채움(F5) / 예약확인통합(F6)
// ============================================================
import { auth, db, isConfigured } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  onAuthStateChanged, GoogleAuthProvider, signInWithPopup, updateProfile
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  collection, doc, setDoc, getDoc, getDocs, query, where, orderBy, limit,
  runTransaction, serverTimestamp, updateDoc, addDoc, deleteDoc, writeBatch
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";

const $ = (id) => document.getElementById(id);
const show = (id) => {
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === id));
  window.scrollTo(0, 0);
};
window.show = show;

let me = null;          // auth user
let myProfile = null;   // users/{uid} 문서
let draft = { proId: null, proName: null, lessonTypeId: null, lessonName: null,
              date: null, time: null, slotId: null, people: 1 };

// 미설정 시 안내 배너
if (!isConfigured) {
  window.addEventListener("DOMContentLoaded", () => {
    const b = document.createElement("div");
    b.className = "config-warn";
    b.innerHTML = `⚙️ Firebase 미설정 상태입니다. <b>public/js/firebase-config.js</b>의 6개 값을 입력하면 실제 예약이 동작합니다. (README 참고)`;
    document.body.prepend(b);
  });
}

// ---------- 인증 ----------
if (isConfigured) {
  onAuthStateChanged(auth, async (user) => {
    me = user;
    if (user) {
      const ref = doc(db, "users", user.uid);
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        await setDoc(ref, {
          name: user.displayName || "회원", email: user.email, phone: "",
          role: "member", createdAt: serverTimestamp()
        });
        myProfile = { name: user.displayName || "회원", phone: "" };
      } else {
        myProfile = snap.data();
      }
      $("navUser").textContent = myProfile.name;
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
      role: "member", createdAt: serverTimestamp()
    });
  } catch (e) { alert("가입 실패: " + e.message); }
};
window.login = async () => {
  try { await signInWithEmailAndPassword(auth, $("email").value, $("password").value); }
  catch (e) { alert("로그인 실패: " + e.message); }
};
window.googleLogin = async () => {
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
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
  const up = $("upcomingBox");
  try {
    const us = await getDocs(query(collection(db, "bookings"),
      where("memberId", "==", me.uid)));
    const upcoming = us.docs
      .map(d => d.data())
      .filter(b => b.status === "confirmed" && b.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (upcoming.length > 0) {
      const b = upcoming[0];
      up.innerHTML = `<p class="mini-label">다가오는 예약</p>
        <div class="up-card">
          <div><b>${b.proName}</b> · ${b.lessonName}</div>
          <div class="up-time">${fmtDate(b.date)} ${b.time}</div>
        </div>`;
    } else { up.innerHTML = ""; }
  } catch { up.innerHTML = ""; }

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

// 단골 1탭 → 같은 프로·레슨으로 STEP2(날짜선택)로 점프
window.quickRebook = (b) => {
  draft = { proId: b.proId, proName: b.proName, lessonTypeId: b.lessonTypeId,
            lessonName: b.lessonName, date: null, time: null, slotId: null, people: b.people || 1 };
  openStep2();
};

// ---------- 신규 예약 STEP1: 프로+레슨 누적선택 ----------
window.startNewBooking = async () => {
  show("step1View");
  const pe = $("proPick"); pe.innerHTML = "불러오는 중…";
  const ps = await getDocs(query(collection(db, "pros"), where("active", "==", true)));
  pe.innerHTML = "";
  ps.forEach(d => {
    const p = d.data();
    const el = document.createElement("button");
    el.className = "pick-card";
    el.innerHTML = `<div class="avatar">${p.name.slice(0,2)}</div>
      <div><b>${p.name}</b><div class="sub">${p.title || "프로"}</div></div>`;
    el.onclick = () => { draft.proId = d.id; draft.proName = p.name; pickPro(el); loadLessonTypes(); };
    pe.appendChild(el);
  });
  $("lessonPick").innerHTML = "";
  $("toStep2").disabled = true;
  // 반복 토글 초기화
  $("recurOn").checked = false;
  $("recurOptions").classList.add("hide");
  $("toStep2").textContent = "다음";
};

// 반복 토글 ON/OFF
window.toggleRecurOptions = () => {
  const on = $("recurOn").checked;
  $("recurOptions").classList.toggle("hide", !on);
  $("toStep2").textContent = on ? "반복예약 등록" : "다음";
};

// "다음" 버튼: 반복이면 등록, 아니면 날짜선택으로
window.step1Next = () => {
  if ($("recurOn").checked) registerRecurring();
  else openStep2();
};
function pickPro(el) {
  document.querySelectorAll("#proPick .pick-card").forEach(c => c.classList.remove("on"));
  el.classList.add("on");
}
async function loadLessonTypes() {
  const le = $("lessonPick"); le.innerHTML = "";
  const lsSnap = await getDocs(query(collection(db, "lessonTypes"), where("active", "==", true)));
  const ls = lsSnap.docs.sort((a, b) => (a.data().order || 0) - (b.data().order || 0));
  ls.forEach(d => {
    const l = d.data();
    const el = document.createElement("button");
    el.className = "chip";
    el.textContent = `${l.name} · ${l.durationMin}분`;
    el.onclick = () => {
      draft.lessonTypeId = d.id; draft.lessonName = l.name;
      document.querySelectorAll("#lessonPick .chip").forEach(c => c.classList.remove("on"));
      el.classList.add("on"); $("toStep2").disabled = false;
    };
    le.appendChild(el);
  });
}
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
  const firstDay = new Date(year, month, 1).getDay();      // 0=일
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const W = ["일", "월", "화", "수", "목", "금", "토"];

  let html = `<div class="cal-head">
      <button class="cal-nav" onclick="calMove(-1)">‹</button>
      <span class="cal-title">${year}년 ${month + 1}월</span>
      <button class="cal-nav" onclick="calMove(1)">›</button>
    </div>
    <div class="cal-grid">`;
  W.forEach((w, i) => html += `<div class="cal-dow ${i===0?'sun':''} ${i===6?'sat':''}">${w}</div>`);
  for (let i = 0; i < firstDay; i++) html += `<div></div>`; // 빈칸
  for (let d = 1; d <= daysInMonth; d++) {
    const cur = new Date(year, month, d);
    const ds = `${year}-${String(month+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    const past = cur < today;
    const dow = cur.getDay();
    const sel = draft.date === ds ? "sel" : "";
    const cls = past ? "cal-day past" : `cal-day ${sel} ${dow===0?'sun':''} ${dow===6?'sat':''}`;
    html += past
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
  const ssSnap = await getDocs(query(collection(db, "slots"),
    where("proId", "==", draft.proId), where("date", "==", draft.date)));
  const ss = { empty: ssSnap.empty, docs: ssSnap.docs.sort((a, b) => a.data().time.localeCompare(b.data().time)) };
  if (ss.empty) { box.innerHTML = `<p class="hint">이 날짜에 열린 시간이 없습니다.</p>`; return; }

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
  const btn = $("cfBtn"); btn.disabled = true; btn.textContent = "예약 중…";
  try {
    await runTransaction(db, async (tx) => {
      const sRef = doc(db, "slots", draft.slotId);
      const fresh = await tx.get(sRef);
      if (!fresh.exists() || fresh.data().status !== "open")
        throw new Error("방금 다른 분이 예약했어요. 다른 시간을 선택해주세요.");
      tx.update(sRef, { status: "booked", bookedBy: me.uid });
      const bRef = doc(collection(db, "bookings"));
      tx.set(bRef, {
        slotId: draft.slotId, proId: draft.proId, proName: draft.proName,
        lessonTypeId: draft.lessonTypeId, lessonName: draft.lessonName,
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
  } catch (e) {
    box.innerHTML = `<p class="hint">목록을 불러오지 못했어요.</p>`;
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
    : (b.date < new Date().toISOString().slice(0,10) ? "완료" : "예약됨");
  const btn = cancelable
    ? `<button class="cancel-btn" onclick="cancelBooking('${b.id}','${b.slotId}')">예약 취소</button>`
    : "";
  return `<div class="bk-card ${b.status === 'cancelled' ? 'dim' : ''}">
      <div class="bk-top">
        <div><b>${b.proName}</b> · ${b.lessonName}</div>
        <span class="bk-badge">${statusLabel}</span>
      </div>
      <div class="bk-time">${fmtDate(b.date)} ${b.time} · ${b.people || 1}명</div>
      ${btn}
    </div>`;
}

// 취소: 예약을 cancelled로 + 슬롯을 다시 open으로 (트랜잭션)
window.cancelBooking = async (bookingId, slotId) => {
  if (!confirm("이 예약을 취소할까요? 취소하면 해당 시간이 다시 열립니다.")) return;
  try {
    await runTransaction(db, async (tx) => {
      const bRef = doc(db, "bookings", bookingId);
      const sRef = slotId ? doc(db, "slots", slotId) : null;
      // 1) 모든 읽기 먼저
      const bSnap = await tx.get(bRef);
      const sSnap = sRef ? await tx.get(sRef) : null;
      if (!bSnap.exists() || bSnap.data().status !== "confirmed")
        throw new Error("이미 취소되었거나 처리할 수 없는 예약입니다.");
      // 2) 그다음 모든 쓰기
      tx.update(bRef, { status: "cancelled" });
      if (sSnap && sSnap.exists())
        tx.update(sRef, { status: "open", bookedBy: null });
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
  else if (tab === "manage") renderAdminManage();
};

// ---------- 현황: 오늘 예약자 ----------
async function renderAdminStatus() {
  const box = $("adminBody");
  box.innerHTML = `<p class="hint">불러오는 중…</p>`;
  const today = new Date().toISOString().slice(0, 10);
  const snap = await getDocs(query(collection(db, "bookings"), where("date", "==", today)));
  const list = snap.docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(b => b.status === "confirmed")
    .sort((a, b) => (a.time + a.proName).localeCompare(b.time + b.proName));
  let html = `<p class="mini-label">오늘 예약 (${fmtDate(today)}) · ${list.length}건</p>`;
  if (list.length === 0) html += `<p class="hint">오늘 예약이 없습니다.</p>`;
  list.forEach(b => {
    html += `<div class="bk-card">
      <div class="bk-top"><div><b>${b.time}</b> · ${b.proName}</div>
        <span class="bk-badge">${b.lessonName}</span></div>
      <div class="bk-time" style="color:var(--ink)">${b.memberName || "회원"} · ${b.people || 1}명</div>
      ${b.request ? `<div class="sub" style="margin-top:6px">요청: ${b.request}</div>` : ""}
    </div>`;
  });
  box.innerHTML = html;
}

// ---------- 슬롯 관리: 프로·날짜 선택 → 시간 열기/닫기 ----------
let adminSlotState = { proId: null, date: null };
async function renderAdminSlots() {
  const box = $("adminBody");
  const ps = await getDocs(query(collection(db, "pros"), where("active", "==", true)));
  let opts = `<option value="">프로 선택</option>`;
  ps.forEach(d => opts += `<option value="${d.id}">${d.data().name}</option>`);
  const today = new Date().toISOString().slice(0, 10);
  box.innerHTML = `
    <p class="mini-label">슬롯 열기 / 닫기</p>
    <select id="asPro" onchange="onAdminSlotChange()">${opts}</select>
    <input type="date" id="asDate" min="${today}" onchange="onAdminSlotChange()" style="margin-top:10px">
    <div id="asGrid" style="margin-top:14px"><p class="hint">프로와 날짜를 선택하세요.</p></div>`;
}
window.onAdminSlotChange = async () => {
  adminSlotState.proId = $("asPro").value;
  adminSlotState.date = $("asDate").value;
  const grid = $("asGrid");
  if (!adminSlotState.proId || !adminSlotState.date) {
    grid.innerHTML = `<p class="hint">프로와 날짜를 선택하세요.</p>`; return;
  }
  grid.innerHTML = `<p class="hint">불러오는 중…</p>`;
  // 기존 슬롯 조회
  const snap = await getDocs(query(collection(db, "slots"),
    where("proId", "==", adminSlotState.proId), where("date", "==", adminSlotState.date)));
  const existing = {};
  snap.docs.forEach(d => existing[d.data().time] = { id: d.id, ...d.data() });
  // 10~22시 20분 단위 버튼 (있으면 상태 표시, 없으면 닫힘)
  let html = `<p class="sub" style="margin-bottom:8px">탭하여 열기/닫기 · 🟢열림 🔴예약됨 ⚪닫힘</p>
    <div class="as-grid">`;
  for (let h = 10; h < 22; h++) {
    for (const m of [0, 20, 40]) {
      const t = String(h).padStart(2,"0") + ":" + String(m).padStart(2,"0");
      const ex = existing[t];
      let cls = "closed", label = t;
      if (ex && ex.status === "open") cls = "open";
      else if (ex && ex.status === "booked") cls = "booked";
      html += `<button class="as-slot ${cls}" onclick="toggleSlot('${t}')"
        ${cls === "booked" ? "disabled" : ""}>${label}</button>`;
    }
  }
  html += `</div>`;
  grid.innerHTML = html;
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

// 하루 일괄 열기 (운영시간 10~22시 전체)
window.openWholeDay = async () => {
  const { proId, date } = adminSlotState;
  if (!proId || !date) { alert("프로와 날짜를 먼저 선택하세요."); return; }
  if (!confirm(`${date} 10~22시를 모두 열까요?`)) return;
  const snap = await getDocs(query(collection(db, "slots"),
    where("proId", "==", proId), where("date", "==", date)));
  const have = new Set(snap.docs.map(d => d.data().time));
  const batch = writeBatch(db);
  for (let h = 10; h < 22; h++) for (const m of [0,20,40]) {
    const t = String(h).padStart(2,"0")+":"+String(m).padStart(2,"0");
    if (!have.has(t)) batch.set(doc(collection(db, "slots")),
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
  let html = `<p class="mini-label">프로</p>`;
  ps.docs.forEach(d => {
    const p = d.data();
    html += `<div class="bk-card"><div class="bk-top">
      <div><b>${p.name}</b> · ${p.title || ""}</div>
      <button class="mini-btn" onclick="toggleProActive('${d.id}',${p.active})">${p.active ? "비활성" : "활성"}</button>
    </div><div class="sub">${p.active ? "활성" : "비활성"}</div></div>`;
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
}
window.toggleProActive = async (id, cur) => {
  await updateDoc(doc(db, "pros", id), { active: !cur }); renderAdminManage();
};
window.addPro = async () => {
  const name = prompt("프로 이름?"); if (!name) return;
  const title = prompt("직함? (예: 대표프로)") || "프로";
  try { await addDoc(collection(db, "pros"), { name, title, active: true }); renderAdminManage(); }
  catch (e) { alert("추가 실패: " + e.message); }
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
  // 공지 핀 먼저
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
    </div>`;
  });
  box.innerHTML = html;
}

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
  const weekday = parseInt($("rcWeekday").value, 10);   // 0=일 ~ 6=토
  const time = $("rcTime").value;                        // "HH:MM"
  const weeks = parseInt($("rcWeeks").value, 10);        // 몇 주
  const everyOther = $("rcEvery").value === "2";         // 격주
  if (!proId || !lessonTypeId || !time) return alert("프로·레슨·시간을 모두 선택하세요.");

  // 패턴 문서 저장
  await addDoc(collection(db, "recurring"), {
    memberId: me.uid, proId, proName, lessonTypeId, lessonName,
    weekday, time, everyOther, weeks, createdAt: serverTimestamp()
  });

  // 해당 요일의 향후 날짜들 계산
  const dates = [];
  const today = new Date(); today.setHours(0,0,0,0);
  let count = 0, wk = 0;
  for (let i = 0; i < weeks * 7 + 7 && count < weeks; i++) {
    const d = new Date(today); d.setDate(d.getDate() + i);
    if (d.getDay() === weekday) {
      if (!everyOther || wk % 2 === 0) { dates.push(d.toISOString().slice(0,10)); count++; }
      wk++;
    }
  }

  // 각 날짜의 슬롯을 찾아 트랜잭션 예약 (열려있는 것만)
  let ok = 0, skip = 0;
  for (const date of dates) {
    const ss = await getDocs(query(collection(db, "slots"),
      where("proId", "==", proId), where("date", "==", date), where("time", "==", time)));
    if (ss.empty || ss.docs[0].data().status !== "open") { skip++; continue; }
    const slotId = ss.docs[0].id;
    try {
      await runTransaction(db, async (tx) => {
        const sRef = doc(db, "slots", slotId);
        const fresh = await tx.get(sRef);
        if (!fresh.exists() || fresh.data().status !== "open") throw new Error("taken");
        tx.update(sRef, { status: "booked", bookedBy: me.uid });
        tx.set(doc(collection(db, "bookings")), {
          slotId, proId, proName, lessonTypeId, lessonName,
          memberId: me.uid, memberName: myProfile?.name || "회원",
          date, time, people: 1, request: "[반복예약]",
          status: "confirmed", createdAt: serverTimestamp()
        });
      });
      ok++;
    } catch { skip++; }
  }
  alert(`반복예약 완료!\n예약 성공: ${ok}건${skip ? ` / 불가(미개설·마감): ${skip}건` : ""}`);
  show("homeView"); renderHome();
};

window.deleteRecurring = async (id) => {
  if (!confirm("이 반복예약 패턴을 삭제할까요? (이미 잡힌 예약은 내 예약에서 개별 취소하세요)")) return;
  await deleteDoc(doc(db, "recurring", id)); openMyBookings();
};

// ============================================================
// [4-C] 수강권 — 보유 현황 (발급은 관리자, 차감은 예약 시)
// ============================================================
window.openPasses = async () => {
  show("passView");
  const box = $("passList");
  box.innerHTML = `<p class="hint">불러오는 중…</p>`;
  const snap = await getDocs(query(collection(db, "passes"), where("memberId", "==", me.uid)));
  if (snap.empty) { box.innerHTML = `<p class="hint">보유한 수강권이 없습니다.<br>관리자에게 발급을 요청하세요.</p>`; return; }
  const list = snap.docs.map(d => d.data());
  const active = list.filter(p => (p.remaining || 0) > 0);
  const used = list.filter(p => (p.remaining || 0) <= 0);
  let html = `<p class="mini-label">사용 가능</p>`;
  if (!active.length) html += `<p class="hint sm">사용 가능한 수강권이 없습니다.</p>`;
  active.forEach(p => {
    html += `<div class="bk-card"><div class="bk-top">
      <div><b>${p.lessonName || "수강권"}</b></div>
      <span class="bk-badge" style="color:var(--accent)">${p.remaining}/${p.total}회</span></div>
      <div class="sub">만료: ${p.expireAt || "-"}</div></div>`;
  });
  if (used.length) {
    html += `<p class="mini-label" style="margin-top:18px">소진됨</p>`;
    used.forEach(p => html += `<div class="bk-card dim"><b>${p.lessonName || "수강권"}</b> · 0/${p.total}회</div>`);
  }
  box.innerHTML = html;
};

// 관리자: 수강권 발급
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
