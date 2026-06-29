/* ============================================================
 * firebase-sync.js  —  여행 일정표 클라우드 동기화 (공유 편집, Firestore)
 *
 * 각 페이지(index.html)에서 이 파일 로드 전에 아래를 선언해야 함:
 *   window.TRIP_ID    = "usa" | "fukuoka"   (Firestore 문서 id)
 *   window.LOCAL_KEY  = "usaTripPlanner" 등 (localStorage 키, 오프라인 백업)
 *   window.__getState()      : 현재 state 반환
 *   window.__setState(obj)   : state 교체 + 화면 갱신
 *   window.save()            : 저장 (이 파일이 래핑함)
 *
 * 필요 SDK (compat 빌드, 이 파일 앞에서 <script>로 로드):
 *   firebase-app-compat.js, firebase-firestore-compat.js
 *
 * 동작:
 *   1) 페이지는 localStorage로 즉시 렌더 (오프라인에도 뜸)
 *   2) Firestore에서 최신 문서를 받아 더 최신이면 덮어씀
 *   3) 내가 저장하면 Firestore에 push (1MB 초과 시 로컬만 저장 + 경고)
 *   4) 다른 사람이 저장하면 onSnapshot으로 받아 화면 자동 갱신
 *
 * 보안: Firestore 규칙(allow read, write: if true)으로 링크 아는 사람 누구나 편집.
 * 아래 config는 공개돼도 안전한 값 (실제 보안은 규칙이 담당).
 *
 * 비활성 자동정지 없음: Firestore 무료(Spark) 플랜은 방치해도 멈추지 않음.
 * ============================================================ */
(function () {
  "use strict";

  const firebaseConfig = {
    apiKey: "AIzaSyBRZrTEQWsFFDzXJZRcRi6w-2IE4o69Lag",
    authDomain: "trip-planners-68091.firebaseapp.com",
    projectId: "trip-planners-68091",
    storageBucket: "trip-planners-68091.firebasestorage.app",
    messagingSenderId: "26070874814",
    appId: "1:26070874814:web:d272c7dcc75f90d882bcef"
  };

  const TRIP_ID = window.TRIP_ID;
  if (!TRIP_ID) { console.warn("[sync] TRIP_ID 미설정 — 동기화 비활성"); return; }

  const getState = () => (typeof window.__getState === "function" ? window.__getState() : null);
  const setState = (obj) => { if (typeof window.__setState === "function") window.__setState(obj); };

  // Firebase SDK 로드 확인
  if (!window.firebase || !window.firebase.initializeApp) {
    console.warn("[sync] firebase SDK 미로드 — 동기화 비활성");
    setBadge("offline", "오프라인(로컬 저장)");
    return;
  }

  let db;
  try {
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
  } catch (e) {
    console.warn("[sync] firebase 초기화 실패", e);
    setBadge("offline", "오프라인(로컬 저장)");
    return;
  }
  const docRef = db.collection("trips").doc(TRIP_ID);

  const MAX_BYTES = 1000000;     // Firestore 문서 한계 1MB 안쪽으로 여유
  let applyingRemote = false;    // 원격 수신 적용 중에는 다시 push 안 함
  let lastPushAt = 0;

  /* ---------- 상태 배지 ---------- */
  function setBadge(kind, text) {
    const el = document.getElementById("syncBadge");
    if (!el) return;
    const color = kind === "ok" ? "#4a7c59" : kind === "saving" ? "#3a6ea5"
      : kind === "offline" ? "#8a8a82" : "#c0563a";
    const icon = kind === "ok" ? "☁️" : kind === "saving" ? "⏳"
      : kind === "offline" ? "📴" : "⚠️";
    el.textContent = `${icon} ${text}`;
    el.style.color = color;
  }

  function byteSize(str) {
    try { return new Blob([str]).size; } catch (_) { return str.length; }
  }

  /* ---------- Firestore → 로컬 적용 ---------- */
  function applyRemote(remote, note) {
    const remoteAt = (remote && remote._updatedAt) || 0;
    const cur = getState();
    const localAt = (cur && cur._updatedAt) || 0;
    if (remoteAt < localAt) return false;   // 내 게 더 최신이면 무시
    applyingRemote = true;
    setState(remote);
    localStorage.setItem(window.LOCAL_KEY, JSON.stringify(remote));
    applyingRemote = false;
    setBadge("ok", note || "동기화됨");
    return true;
  }

  /* ---------- 로컬 → Firestore ---------- */
  async function pushNow(silent) {
    if (applyingRemote) return;
    const cur = getState();
    if (!cur) return;
    cur._updatedAt = Date.now();
    const json = JSON.stringify(cur);
    localStorage.setItem(window.LOCAL_KEY, json);   // 로컬은 항상 저장

    const size = byteSize(json);
    if (size > MAX_BYTES) {
      console.warn("[sync] 문서 크기 초과", size);
      setBadge("error", `사진이 많아 클라우드 저장 불가(${Math.round(size/1024)}KB). 로컬엔 저장됨`);
      return;
    }
    try {
      if (!silent) setBadge("saving", "저장 중…");
      lastPushAt = cur._updatedAt;
      await docRef.set({ json: json, updatedAt: cur._updatedAt });
      setBadge("ok", "동기화됨");
    } catch (e) {
      console.warn("[sync] push 실패", e);
      setBadge("error", "저장 실패(로컬엔 저장됨)");
    }
  }

  let pushTimer = null;
  function pushDebounced() {
    if (applyingRemote) return;
    clearTimeout(pushTimer);
    setBadge("saving", "저장 중…");
    pushTimer = setTimeout(pushNow, 400);
  }

  /* ---------- 기존 save() 래핑 ---------- */
  const originalSave = window.save;
  window.save = function () {
    if (typeof originalSave === "function") originalSave();
    pushDebounced();
  };

  /* ---------- 최초 1회 로드 ---------- */
  async function pullOnce() {
    try {
      const snap = await docRef.get();
      if (snap.exists && snap.data() && snap.data().json) {
        applyRemote(JSON.parse(snap.data().json));
      } else {
        await pushNow(true);   // 클라우드에 아직 없으면 내 현재 데이터 업로드
      }
    } catch (e) {
      console.warn("[sync] pull 실패", e);
      setBadge("offline", "오프라인(로컬 저장)");
    }
  }

  /* ---------- 실시간 구독 ---------- */
  function subscribe() {
    docRef.onSnapshot((snap) => {
      if (!snap.exists) return;
      if (snap.metadata.hasPendingWrites) return;   // 내 로컬 쓰기 echo 무시
      const d = snap.data();
      if (!d || !d.json) return;
      let remote;
      try { remote = JSON.parse(d.json); } catch (_) { return; }
      if (remote._updatedAt && remote._updatedAt === lastPushAt) return; // 방금 내가 올린 것
      applyRemote(remote, "동기화됨 (방금 업데이트)");
    }, (err) => {
      console.warn("[sync] 구독 오류", err);
      setBadge("offline", "오프라인(로컬 저장)");
    });
  }

  /* ---------- 시작 ---------- */
  setBadge("saving", "연결 중…");
  pullOnce().then(subscribe);

  // 같은 기기 멀티탭 동기화
  window.addEventListener("storage", (e) => {
    if (e.key === window.LOCAL_KEY && e.newValue) {
      try {
        const v = JSON.parse(e.newValue);
        const cur = getState();
        if ((v._updatedAt || 0) > ((cur && cur._updatedAt) || 0)) {
          applyingRemote = true;
          setState(v);
          applyingRemote = false;
        }
      } catch (_) {}
    }
  });
})();
