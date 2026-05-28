// ============================================================
// [필수] 아래 6개 값을 본인 Firebase 프로젝트 값으로 교체하세요.
// Firebase 콘솔 > 프로젝트 설정(⚙️) > 일반 > 내 앱(</>웹) > SDK 설정 > 구성
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDttSjz65eRq8bNXyPjOyUq03Atv_7R9po",
  authDomain: "okgolfv2.firebaseapp.com",
  projectId: "okgolfv2",
  storageBucket: "okgolfv2.firebasestorage.app",
  messagingSenderId: "231497593822",
  appId: "1:231497593822:web:e764864421924aef76e34f",
  measurementId: "G-LNCT2PTK4W"
};

// 설정 여부 자동 감지 (미설정 시 데모 안내 표시)
export const isConfigured = !firebaseConfig.apiKey.startsWith("YOUR_");

let auth = null, db = null;
if (isConfigured) {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
}
export { auth, db };
