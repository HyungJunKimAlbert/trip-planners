/* ============================================================
 * supabase-sync.js  —  여행 일정표 클라우드 동기화 (공유 편집)
 *
 * 각 페이지(index.html)에서 이 파일 로드 전에 아래를 선언해야 함:
 *   window.TRIP_ID  = "usa" | "fukuoka"   (trips 테이블의 row id)
 *   window.LOCAL_KEY = "usaTripPlanner" 등 (localStorage 키, 오프라인 백업용)
 *
 * 그리고 페이지에는 전역으로 다음 브리지가 있어야 함 (index.html에서 노출):
 *   - window.__getState()      : 현재 state 반환
 *   - window.__setState(obj)   : state 교체 + 화면 갱신
 *   - window.save()            : 저장 (이 파일이 래핑함)
 *   - window.LOCAL_KEY         : localStorage 키
 *
 * 동작:
 *   1) 페이지는 평소처럼 localStorage로 즉시 렌더 (오프라인에도 뜸)
 *   2) 클라우드에서 최신 데이터를 받아 더 최신이면 덮어씀
 *   3) 내가 저장하면 클라우드에 push
 *   4) 다른 사람이 저장하면 realtime으로 받아 내 화면 자동 갱신
 *
 * 보안: 링크 아는 사람 누구나 편집 (RLS 정책으로 열어둠). publishable 키는 공개 안전.
 * ============================================================ */
(function () {
  "use strict";

  const SUPABASE_URL = "https://gdkbvjiuymhyzioybulk.supabase.co";
  const SUPABASE_KEY = "sb_publishable_ZxO_rO1YYhn3p6d1pKGjSw_8pR2w0F3";

  const TRIP_ID = window.TRIP_ID;
  if (!TRIP_ID) { console.warn("[sync] TRIP_ID 미설정 — 동기화 비활성"); return; }

  const getState = () => (typeof window.__getState === "function" ? window.__getState() : null);
  const setState = (obj) => { if (typeof window.__setState === "function") window.__setState(obj); };

  // supabase-js CDN이 로드됐는지 확인
  if (!window.supabase || !window.supabase.createClient) {
    console.warn("[sync] supabase-js 미로드 — 동기화 비활성");
    setBadge("offline", "오프라인(로컬 저장)");
    return;
  }
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  let applyingRemote = false;   // realtime 수신 적용 중에는 다시 push하지 않음
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

  /* ---------- 클라우드 → 로컬 ---------- */
  async function pullOnce() {
    try {
      const { data, error } = await sb.from("trips").select("data, updated_at").eq("id", TRIP_ID).maybeSingle();
      if (error) throw error;
      if (data && data.data) {
        const remote = data.data;
        const remoteAt = remote._updatedAt || 0;
        const cur = getState();
        const localAt = (cur && cur._updatedAt) || 0;
        // 클라우드가 더 최신이면 덮어씀
        if (remoteAt >= localAt) {
          applyingRemote = true;
          setState(remote);
          localStorage.setItem(window.LOCAL_KEY, JSON.stringify(remote));
          applyingRemote = false;
        }
        setBadge("ok", "동기화됨");
      } else {
        // 클라우드에 아직 데이터 없음 → 내 현재 데이터를 올림(최초 1회)
        await pushNow(true);
      }
    } catch (e) {
      console.warn("[sync] pull 실패", e);
      setBadge("offline", "오프라인(로컬 저장)");
    }
  }

  /* ---------- 로컬 → 클라우드 ---------- */
  async function pushNow(silent) {
    if (applyingRemote) return;                 // 원격 적용 중엔 push 안 함
    const cur = getState();
    if (!cur) return;
    try {
      if (!silent) setBadge("saving", "저장 중…");
      cur._updatedAt = Date.now();
      lastPushAt = cur._updatedAt;
      localStorage.setItem(window.LOCAL_KEY, JSON.stringify(cur));
      const { error } = await sb.from("trips").upsert({
        id: TRIP_ID,
        data: cur,
        updated_at: new Date().toISOString()
      });
      if (error) throw error;
      setBadge("ok", "동기화됨");
    } catch (e) {
      console.warn("[sync] push 실패", e);
      setBadge("error", "저장 실패(로컬엔 저장됨)");
    }
  }

  // 짧은 디바운스로 연속 저장을 묶음
  let pushTimer = null;
  function pushDebounced() {
    if (applyingRemote) return;
    clearTimeout(pushTimer);
    setBadge("saving", "저장 중…");
    pushTimer = setTimeout(pushNow, 400);
  }

  /* ---------- 기존 save() 래핑 ---------- */
  // index.html의 save()는 localStorage 저장 + renderAll. 그 뒤에 클라우드 push를 붙임.
  const originalSave = window.save;
  window.save = function () {
    if (typeof originalSave === "function") originalSave();
    pushDebounced();
  };

  /* ---------- realtime 구독 ---------- */
  function subscribe() {
    sb.channel("trips-" + TRIP_ID)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "trips", filter: "id=eq." + TRIP_ID },
        (payload) => {
          const remote = payload.new && payload.new.data;
          if (!remote) return;
          // 내가 방금 올린 변경이면 무시
          if (remote._updatedAt && remote._updatedAt === lastPushAt) return;
          applyingRemote = true;
          setState(remote);
          localStorage.setItem(window.LOCAL_KEY, JSON.stringify(remote));
          applyingRemote = false;
          setBadge("ok", "동기화됨 (방금 업데이트)");
        })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") setBadge("ok", "동기화됨");
      });
  }

  /* ---------- 시작 ---------- */
  setBadge("saving", "연결 중…");
  pullOnce().then(subscribe);

  // 다른 탭에서 localStorage가 바뀌어도 반영 (같은 기기 멀티탭)
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
