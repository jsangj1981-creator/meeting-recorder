/* 미팅 녹음 — 앱 로직 (녹음, 화면 전환, 변환, Claude용 내보내기) */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const SETTINGS_KEY = 'meetingRecorder.settings.v1';

  const DEFAULT_PROMPT = [
    '아래는 외부 미팅 녹음을 자동으로 텍스트로 변환한 기록입니다.',
    '연자는 "연자 1, 2, 3…"으로 자동 구분되어 있으며, 음성인식 오류나 연자 구분 오류가 있을 수 있습니다.',
    '문맥으로 바로잡아 읽고 아래 형식으로 정리해 주세요.',
    '',
    '1. 미팅 개요 (연자별로 추정되는 역할·소속 포함)',
    '2. 핵심 요약 (3~5줄)',
    '3. 주요 논의 내용 (주제별)',
    '4. 고객 요구사항 · 우려사항',
    '5. 결정사항',
    '6. 후속 조치 (할 일 · 담당 · 기한)',
    '7. 확인이 필요한 부분 (불명확하거나 인식이 어려웠던 내용)',
  ].join('\n');

  // ---------- 설정 ----------
  function loadSettings() {
    const def = { apiKey: '', autoStart: true, prompt: DEFAULT_PROMPT };
    try { return Object.assign(def, JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}); } catch (e) { return def; }
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { toast('설정을 저장하지 못했습니다.'); }
  }
  let settings = loadSettings();

  // ---------- 유틸 ----------
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pad = (n) => String(n).padStart(2, '0');

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtClock(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  }
  function fmtDate(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fmtDuration(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}초`;
    const m = Math.round(s / 60);
    return m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`;
  }
  function defaultTitle(ts = Date.now()) {
    const d = new Date(ts);
    return `${d.getMonth() + 1}월 ${d.getDate()}일 ${pad(d.getHours())}:${pad(d.getMinutes())} 미팅`;
  }
  function safeName(s) {
    return s.replace(/[\\/:*?"<>|]/g, '_').trim() || 'meeting';
  }

  let toastTimer;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  // ---------- 화면 전환 ----------
  function show(name) {
    document.querySelectorAll('.screen').forEach((s) => { s.hidden = s.id !== 'screen-' + name; });
    window.scrollTo(0, 0);
    if (name !== 'detail') { releaseAudioUrls(); detail = null; }
  }
  function goList() {
    show('list');
    renderList();
  }
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-go="list"]')) goList();
    if (e.target.closest('[data-open-settings]')) openSettings();
  });

  // ---------- 녹음 ----------
  const R = {
    meeting: null,
    stream: null,
    recorder: null,
    seg: null,
    activeMs: 0,
    lastTick: 0,
    starting: false,
    startToken: 0,
    stopping: false,
    interrupted: false,
    restarting: false,
    onStopped: null,
    writeChain: Promise.resolve(),
    wakeLock: null,
    timer: null,
    audioCtx: null,
    analyser: null,
    meterSrc: null,
    levelBuf: null,
  };

  function pickMime() {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    const types = ['audio/mp4', 'audio/mp4;codecs=mp4a.40.2', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm'];
    return types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  }

  function getMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      const e = new Error('이 브라우저는 녹음을 지원하지 않습니다. 아이폰 Safari에서 열어 주세요.');
      e.kind = 'unsupported';
      return Promise.reject(e);
    }
    // 회의 녹음이므로 소리 보정은 자동 음량 조절만 사용
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true, channelCount: 1 },
    });
  }

  function micErrorMessage(e) {
    if (e.kind === 'unsupported') return e.message;
    if (!window.isSecureContext) return 'https 주소에서만 마이크를 사용할 수 있습니다.';
    switch (e.name) {
      case 'NotAllowedError':
      case 'SecurityError': return '마이크 권한이 허용되지 않았습니다.';
      case 'NotFoundError': return '마이크를 찾을 수 없습니다.';
      case 'NotReadableError':
      case 'AbortError': return '다른 앱(통화 등)이 마이크를 사용 중입니다.';
      default: return `마이크를 시작하지 못했습니다. (${e.name || e.message})`;
    }
  }

  function showPermission(msg) {
    $('permReason').textContent = msg;
    show('permission');
  }

  async function startNewMeeting() {
    if (R.meeting || R.starting) return;
    R.starting = true;
    const token = ++R.startToken;
    $('recTitle').textContent = '';
    setRecState('마이크 준비 중…', 'paused');
    $('recTimer').textContent = '00:00';
    $('btnPause').disabled = true;
    show('record');

    let stream;
    try {
      stream = await getMic();
    } catch (e) {
      if (token !== R.startToken) return;
      R.starting = false;
      showPermission(micErrorMessage(e));
      return;
    }
    if (token !== R.startToken) { // 준비 중에 취소됨
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    const m = { id: uid(), title: defaultTitle(), createdAt: Date.now(), durationMs: 0, mimeType: '', segments: [], status: 'recording' };
    await Store.putMeeting(m);
    R.meeting = m;
    R.activeMs = 0;
    R.interrupted = false;
    R.starting = false;
    $('recTitle').textContent = m.title;
    startSegment(stream);
    requestWakeLock();
    clearInterval(R.timer);
    R.lastTick = Date.now();
    R.timer = setInterval(tick, 250);
    updateRecUI();
  }

  function startSegment(stream) {
    const m = R.meeting;
    const mime = pickMime();
    const opts = { audioBitsPerSecond: 64000 };
    if (mime) opts.mimeType = mime;
    let rec;
    try { rec = new MediaRecorder(stream, opts); } catch (e) { rec = new MediaRecorder(stream); }

    const seg = { seg: m.segments.length, startMs: R.activeMs, durationMs: 0, hasData: false };
    m.segments.push(seg);
    R.stream = stream;
    R.recorder = rec;
    R.seg = seg;

    rec.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      if (!m.mimeType) m.mimeType = (e.data.type || rec.mimeType || mime || 'audio/mp4').split(';')[0];
      R.writeChain = R.writeChain
        .then(() => Store.addChunk(m.id, seg.seg, e.data))
        .then(() => { seg.hasData = true; return Store.putMeeting(m); })
        .catch(() => toast('저장 공간이 부족해 녹음 일부를 저장하지 못했습니다.'));
    };
    rec.onstop = () => {
      if (R.recorder !== rec) return;
      if (R.onStopped) { const done = R.onStopped; R.onStopped = null; done(); } else handleInterruption();
    };
    rec.onerror = () => { if (R.recorder === rec) handleInterruption(); };
    stream.getAudioTracks().forEach((t) => {
      t.onended = () => { if (R.recorder === rec && !R.stopping) handleInterruption(); };
    });

    rec.start(5000); // 5초마다 조각 저장
    setupMeter(stream);
  }

  // 현재 구간을 닫는다 (마지막 조각은 ondataavailable에서 계속 저장됨)
  function closeSegment() {
    const rec = R.recorder;
    R.recorder = null;
    if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch (e) { /* 무시 */ } }
    if (R.stream) R.stream.getTracks().forEach((t) => t.stop());
    R.stream = null;
    teardownMeter();
  }

  function handleInterruption() {
    if (!R.meeting || R.stopping || R.restarting) return;
    closeSegment();
    R.interrupted = true;
    updateRecUI();
    if (document.visibilityState === 'visible') resumeAfterInterruption();
  }

  async function resumeAfterInterruption() {
    if (!R.meeting || !R.interrupted || R.restarting) return;
    R.restarting = true;
    try {
      const s = await getMic();
      if (!R.meeting) { s.getTracks().forEach((t) => t.stop()); return; }
      R.interrupted = false;
      R.lastTick = Date.now();
      startSegment(s);
      toast('녹음이 잠시 끊겼다가 이어서 녹음됩니다.');
    } catch (e) {
      toast(micErrorMessage(e) + ' 화면을 눌러 다시 시도하세요.');
    } finally {
      R.restarting = false;
      updateRecUI();
    }
  }

  function tick() {
    const now = Date.now();
    const d = now - R.lastTick;
    R.lastTick = now;
    if (R.recorder && R.recorder.state === 'recording' && !R.interrupted) {
      R.activeMs += d;
      R.seg.durationMs = R.activeMs - R.seg.startMs;
    }
    $('recTimer').textContent = fmtClock(R.activeMs);
    drawMeter();
  }

  function setRecState(text, cls) {
    const el = $('recState');
    el.innerHTML = `<span class="dot"></span>${esc(text)}`;
    el.className = 'rec-state' + (cls ? ' ' + cls : '');
  }

  function updateRecUI() {
    const r = R.recorder;
    const btn = $('btnPause');
    if (R.interrupted) setRecState('녹음이 끊김 — 화면을 누르면 다시 시작', 'paused');
    else if (r && r.state === 'paused') setRecState('일시정지', 'paused');
    else if (r) setRecState('녹음 중');
    const paused = r && r.state === 'paused';
    btn.classList.toggle('resume', !!paused);
    btn.querySelector('.round-label').textContent = paused ? '계속' : '일시정지';
    btn.setAttribute('aria-label', paused ? '녹음 계속' : '일시정지');
    btn.disabled = !r;
  }

  $('btnPause').addEventListener('click', () => {
    const r = R.recorder;
    if (!r) return;
    if (r.state === 'recording') r.pause();
    else if (r.state === 'paused') r.resume();
    R.lastTick = Date.now();
    updateRecUI();
  });

  $('screen-record').addEventListener('click', (e) => {
    if (R.interrupted && !e.target.closest('button')) resumeAfterInterruption();
  });

  async function finishRecording({ discard = false } = {}) {
    const m = R.meeting;
    if (!m || R.stopping) return;
    R.stopping = true;
    tick();
    clearInterval(R.timer);

    const rec = R.recorder;
    if (rec && rec.state !== 'inactive') {
      await new Promise((resolve) => {
        R.onStopped = resolve;
        try { rec.stop(); } catch (e) { resolve(); }
        setTimeout(resolve, 3000);
      });
    }
    R.onStopped = null;
    R.recorder = null;
    if (R.stream) R.stream.getTracks().forEach((t) => t.stop());
    R.stream = null;
    teardownMeter();
    releaseWakeLock();
    await R.writeChain;

    R.meeting = null;
    R.stopping = false;
    R.interrupted = false;

    m.segments = m.segments.filter((s) => s.hasData);
    m.durationMs = R.activeMs;
    m.status = 'recorded';

    if (discard || !m.segments.length) {
      await Store.deleteMeeting(m.id);
      toast(discard ? '녹음을 삭제했습니다.' : '녹음된 내용이 없어 저장하지 않았습니다.');
      goList();
      return;
    }
    await Store.putMeeting(m);
    openDetail(m.id);
  }

  $('btnStop').addEventListener('click', () => finishRecording());
  $('btnCancelRec').addEventListener('click', () => {
    if (R.starting && !R.meeting) {
      R.startToken++;
      R.starting = false;
      goList();
      return;
    }
    if (confirm('이번 녹음을 저장하지 않고 삭제할까요?')) finishRecording({ discard: true });
  });
  $('btnRetryMic').addEventListener('click', () => startNewMeeting());
  $('btnNew').addEventListener('click', () => startNewMeeting());
  $('btnNew2').addEventListener('click', () => startNewMeeting());

  document.addEventListener('visibilitychange', () => {
    if (!R.meeting) return;
    if (document.visibilityState === 'visible') {
      requestWakeLock();
      const track = R.stream && R.stream.getAudioTracks()[0];
      const broken = !R.recorder || R.recorder.state === 'inactive' || !track || track.readyState === 'ended';
      if (R.interrupted) resumeAfterInterruption();
      else if (broken) handleInterruption();
    } else {
      Store.putMeeting(R.meeting);
    }
  });
  window.addEventListener('pagehide', () => { if (R.meeting) Store.putMeeting(R.meeting); });

  // 화면 꺼짐 방지 (iOS 18.4 이상 홈 화면 앱에서 동작)
  async function requestWakeLock() {
    if (!('wakeLock' in navigator) || R.wakeLock) return;
    try {
      R.wakeLock = await navigator.wakeLock.request('screen');
      R.wakeLock.addEventListener('release', () => { R.wakeLock = null; });
    } catch (e) { /* 지원하지 않음 */ }
  }
  function releaseWakeLock() {
    if (R.wakeLock) { R.wakeLock.release().catch(() => {}); R.wakeLock = null; }
  }

  // 입력 음량 표시
  function setupMeter(stream) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!R.audioCtx) R.audioCtx = new AC();
      const src = R.audioCtx.createMediaStreamSource(stream);
      const an = R.audioCtx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      R.meterSrc = src;
      R.analyser = an;
      R.levelBuf = new Uint8Array(an.fftSize);
      if (R.audioCtx.state === 'suspended') R.audioCtx.resume().catch(() => {});
    } catch (e) { /* 음량 표시는 선택 기능 */ }
  }
  function teardownMeter() {
    try { if (R.meterSrc) R.meterSrc.disconnect(); } catch (e) { /* 무시 */ }
    R.meterSrc = null;
    R.analyser = null;
    $('meterFill').style.width = '0';
  }
  function drawMeter() {
    if (!R.analyser) return;
    R.analyser.getByteTimeDomainData(R.levelBuf);
    let sum = 0;
    for (const v of R.levelBuf) { const x = (v - 128) / 128; sum += x * x; }
    const rms = Math.sqrt(sum / R.levelBuf.length);
    $('meterFill').style.width = Math.min(100, rms * 400) + '%';
  }
  document.addEventListener('touchstart', () => {
    if (R.audioCtx && R.audioCtx.state === 'suspended') R.audioCtx.resume().catch(() => {});
  }, { passive: true });

  // 앱이 녹음 중에 꺼졌던 경우, 저장된 조각으로 녹음을 살린다
  async function recoverUnfinished() {
    const all = await Store.allMeetings();
    let recovered = 0;
    for (const m of all) {
      if (m.status !== 'recording') continue;
      m.segments = m.segments.filter((s) => s.hasData);
      if (!m.segments.length) { await Store.deleteMeeting(m.id); continue; }
      m.durationMs = m.segments.reduce((a, s) => Math.max(a, s.startMs + s.durationMs), 0);
      m.status = 'recorded';
      await Store.putMeeting(m);
      recovered++;
    }
    if (recovered) toast('앱이 종료되기 전까지의 녹음을 저장해 두었습니다.');
  }

  // ---------- 목록 ----------
  const STATUS_LABEL = { recorded: '변환 전', transcribing: '변환 중', done: '기록 완료', error: '변환 실패' };

  async function renderList() {
    const all = (await Store.allMeetings()).filter((m) => m.status !== 'recording').sort((a, b) => b.createdAt - a.createdAt);
    $('listEmpty').hidden = all.length > 0;
    $('meetingList').innerHTML = all.map((m) => `
      <li data-id="${m.id}">
        <div class="l-title">${esc(m.title)}</div>
        <div class="l-meta">
          <span>${fmtDate(m.createdAt)}</span><span>${fmtDuration(m.durationMs || 0)}</span>
          <span class="tag${m.status === 'done' ? ' done' : ''}">${STATUS_LABEL[m.status] || ''}</span>
        </div>
      </li>`).join('');
    const standalone = navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
    $('installTip').hidden = standalone || !/iPhone|iPad|iPod/.test(navigator.userAgent);
    $('keyTip').hidden = !!settings.apiKey;
  }
  $('meetingList').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    if (li) openDetail(li.dataset.id);
  });

  // ---------- 상세 ----------
  let detail = null;
  let audioUrls = [];

  function releaseAudioUrls() {
    audioUrls.forEach((u) => URL.revokeObjectURL(u));
    audioUrls = [];
    const box = $('detAudio');
    if (box) box.innerHTML = '';
  }

  async function openDetail(id) {
    const m = await Store.getMeeting(id);
    if (!m) { goList(); return; }
    show('detail');
    detail = m;
    renderDetail();
    renderAudio(m);
    if (m.status === 'transcribing') pollTranscription(m.id);
  }

  function renderDetail() {
    const m = detail;
    if (!m) return;
    $('detTitle').value = m.title;
    $('detMeta').textContent = `${fmtDate(m.createdAt)} · ${fmtDuration(m.durationMs || 0)}`;
    const n = m.segments.length;
    $('detSegNote').hidden = n <= 1;
    $('detSegNote').textContent = `녹음이 중간에 끊겨 ${n}개 구간으로 저장되었습니다. 구간마다 연자 번호가 따로 매겨질 수 있습니다.`;

    const state = m.status === 'done' ? 'Done' : m.status === 'transcribing' ? 'Busy' : m.status === 'error' ? 'Error' : 'Idle';
    ['Idle', 'Busy', 'Error', 'Done'].forEach((s) => { $('tr' + s).hidden = s !== state; });
    $('trSpeakers').value = m.speakersExpected || '';
    if (m.status === 'error') $('trErrorMsg').textContent = m.error || '';
    if (m.status === 'transcribing') $('trProgress').textContent = m.progress || '변환을 준비하는 중…';
    if (m.status === 'done') renderTranscript(m);
  }

  async function renderAudio(m) {
    releaseAudioUrls();
    const box = $('detAudio');
    for (const s of m.segments) {
      const blob = await Store.segmentBlob(m.id, s.seg, m.mimeType);
      if (!detail || detail.id !== m.id) return;
      const url = URL.createObjectURL(blob);
      audioUrls.push(url);
      const a = document.createElement('audio');
      a.controls = true;
      a.preload = 'metadata';
      a.src = url;
      box.appendChild(a);
    }
  }

  function renderTranscript(m) {
    const utts = (m.transcript && m.transcript.utterances) || [];
    const count = utts.filter((u) => !u.segBreak).length;
    const speakers = new Set(utts.filter((u) => !u.segBreak).map((u) => u.speaker));
    $('trCount').textContent = count ? `연자 ${speakers.size}명 · 발언 ${count}개` : '';
    $('transcript').innerHTML = count
      ? utts.map((u) => u.segBreak
        ? `<div class="seg-break">구간 ${u.segBreak}</div>`
        : `<div class="utt"><div class="utt-head"><span class="utt-who">연자 ${esc(u.speaker)}</span><span class="utt-time">${fmtClock(u.start)}</span></div><p class="utt-text">${esc(u.text)}</p></div>`).join('')
      : '<p class="sub">인식된 말소리가 없습니다.</p>';
  }

  $('detTitle').addEventListener('change', async () => {
    if (!detail) return;
    detail.title = $('detTitle').value.trim() || defaultTitle(detail.createdAt);
    $('detTitle').value = detail.title;
    await Store.putMeeting(detail);
  });
  $('detTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) e.target.blur(); });

  // ---------- 텍스트 변환 ----------
  const polling = new Set();

  async function updateMeeting(id, patch) {
    const m = await Store.getMeeting(id);
    if (!m) return null;
    Object.assign(m, patch);
    await Store.putMeeting(m);
    if (detail && detail.id === id) { detail = m; renderDetail(); }
    return m;
  }

  async function startTranscription() {
    if (!detail) return;
    if (!settings.apiKey) {
      toast('설정에서 AssemblyAI API 키를 먼저 입력하세요.');
      openSettings();
      return;
    }
    const id = detail.id;
    const key = settings.apiKey;
    let m = await updateMeeting(id, {
      status: 'transcribing', speakersExpected: $('trSpeakers').value || '', jobs: [], error: '', transcript: null, progress: '음성 파일 업로드 준비 중…',
    });
    try {
      const jobs = [];
      for (let i = 0; i < m.segments.length; i++) {
        const s = m.segments[i];
        const part = m.segments.length > 1 ? ` (${i + 1}/${m.segments.length})` : '';
        const blob = await Store.segmentBlob(id, s.seg, m.mimeType);
        const url = await Transcriber.upload(key, blob, (p) => {
          $('trProgress').textContent = `음성 파일 업로드 중${part} ${Math.round(p * 100)}%`;
        });
        const jobId = await Transcriber.create(key, url, m.speakersExpected);
        jobs.push({ seg: s.seg, id: jobId });
        m = await updateMeeting(id, { jobs: jobs.slice(), progress: '업로드 완료, 변환 시작…' });
      }
    } catch (e) {
      await updateMeeting(id, { status: 'error', error: e.message });
      return;
    }
    pollTranscription(id);
  }

  async function pollTranscription(id) {
    if (polling.has(id)) return;
    polling.add(id);
    try {
      let m = await Store.getMeeting(id);
      if (!m || !m.jobs || m.jobs.length < m.segments.length) {
        await updateMeeting(id, { status: 'error', error: '업로드가 중간에 멈췄습니다. 다시 시도해 주세요.' });
        return;
      }
      for (;;) {
        let results;
        try {
          results = await Promise.all(m.jobs.map((j) => Transcriber.get(settings.apiKey, j.id)));
        } catch (e) {
          if (/API 키/.test(e.message)) { await updateMeeting(id, { status: 'error', error: e.message }); return; }
          if (detail && detail.id === id) $('trProgress').textContent = '연결을 다시 확인하는 중… ' + e.message;
          await sleep(6000);
          continue;
        }
        const failed = results.find((r) => r.status === 'error');
        if (failed) {
          await updateMeeting(id, { status: 'error', error: '변환 오류: ' + (failed.error || '알 수 없는 오류') });
          return;
        }
        if (results.every((r) => r.status === 'completed')) {
          await updateMeeting(id, { status: 'done', progress: '', transcript: buildTranscript(m, results) });
          m.jobs.forEach((j) => Transcriber.remove(settings.apiKey, j.id));
          return;
        }
        const done = results.filter((r) => r.status === 'completed').length;
        const part = results.length > 1 ? ` (${done}/${results.length} 구간 완료)` : '';
        if (detail && detail.id === id) $('trProgress').textContent = `텍스트로 변환하는 중${part}… 보통 몇 분 정도 걸립니다.`;
        await sleep(4000);
        m = (await Store.getMeeting(id)) || m;
        if (m.status !== 'transcribing') return;
      }
    } finally {
      polling.delete(id);
    }
  }

  function buildTranscript(m, results) {
    const utterances = [];
    m.jobs.forEach((j, k) => {
      const seg = m.segments.find((s) => s.seg === j.seg);
      if (m.jobs.length > 1) utterances.push({ segBreak: k + 1 });
      Transcriber.toUtterances(results[k]).forEach((u) => {
        utterances.push({ speaker: u.speaker, text: u.text, start: u.start + (seg ? seg.startMs : 0) });
      });
    });
    return { utterances, createdAt: Date.now() };
  }

  $('btnTranscribe').addEventListener('click', startTranscription);
  $('btnRetryTr').addEventListener('click', startTranscription);
  $('btnRetranscribe').addEventListener('click', () => {
    if (confirm('다시 변환하면 현재 기록을 새 결과로 바꿉니다. 계속할까요?')) {
      ['Idle', 'Busy', 'Error', 'Done'].forEach((s) => { $('tr' + s).hidden = s !== 'Idle'; });
    }
  });

  // ---------- 내보내기 ----------
  function transcriptText(m) {
    return ((m.transcript && m.transcript.utterances) || []).map((u) => u.segBreak
      ? (u.segBreak === 1 ? '--- 구간 1 ---' : `--- 구간 ${u.segBreak} (녹음이 끊긴 뒤 이어진 부분, 연자 번호가 앞 구간과 다를 수 있음) ---`)
      : `[${fmtClock(u.start)}] 연자 ${u.speaker}: ${u.text}`).join('\n');
  }

  function claudeText(m) {
    const head = [`미팅: ${m.title}`, `일시: ${fmtDate(m.createdAt)}`, `녹음 길이: ${fmtDuration(m.durationMs || 0)}`];
    if (m.speakersExpected) head.push(`참석 인원: ${m.speakersExpected}명`);
    return `${settings.prompt.trim()}\n\n---\n${head.join('\n')}\n\n${transcriptText(m)}`;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (err) { /* 무시 */ }
      ta.remove();
      return ok;
    }
  }

  async function shareFiles(files, title) {
    if (navigator.canShare && navigator.canShare({ files })) {
      try { await navigator.share({ files, title }); return true; } catch (e) { return e.name === 'AbortError'; }
    }
    return false;
  }

  $('btnCopyClaude').addEventListener('click', async () => {
    if (!detail) return;
    const ok = await copyText(claudeText(detail));
    toast(ok ? '복사했습니다. Claude 앱에 붙여 넣으세요.' : '복사하지 못했습니다. "공유"를 이용해 주세요.');
  });

  $('btnShareText').addEventListener('click', async () => {
    if (!detail) return;
    const text = claudeText(detail);
    const file = new File([text], `${safeName(detail.title)}.txt`, { type: 'text/plain' });
    if (await shareFiles([file], detail.title)) return;
    if (navigator.share) {
      try { await navigator.share({ title: detail.title, text }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const ok = await copyText(text);
    toast(ok ? '공유를 지원하지 않아 복사했습니다.' : '공유하지 못했습니다.');
  });

  $('btnShareAudio').addEventListener('click', async () => {
    if (!detail) return;
    const m = detail;
    const ext = /webm/.test(m.mimeType) ? 'webm' : 'm4a';
    const files = [];
    for (let i = 0; i < m.segments.length; i++) {
      const blob = await Store.segmentBlob(m.id, m.segments[i].seg, m.mimeType);
      const suffix = m.segments.length > 1 ? `_${i + 1}` : '';
      files.push(new File([blob], `${safeName(m.title)}${suffix}.${ext}`, { type: m.mimeType || 'audio/mp4' }));
    }
    if (await shareFiles(files, m.title)) return;
    files.forEach((f) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(f);
      a.download = f.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
  });

  $('btnDelete').addEventListener('click', async () => {
    if (!detail) return;
    if (!confirm(`"${detail.title}" 녹음과 기록을 삭제할까요? 되돌릴 수 없습니다.`)) return;
    await Store.deleteMeeting(detail.id);
    toast('삭제했습니다.');
    goList();
  });

  // ---------- 설정 ----------
  async function openSettings() {
    $('setKey').value = settings.apiKey;
    $('setAutoStart').checked = settings.autoStart;
    $('setPrompt').value = settings.prompt;
    $('storageInfo').textContent = '';
    $('settingsDialog').returnValue = '';
    $('settingsDialog').showModal();
    try {
      const est = await navigator.storage.estimate();
      $('storageInfo').textContent = `이 휴대폰에 저장된 녹음 용량: 약 ${Math.round((est.usage || 0) / 1048576)}MB`;
    } catch (e) { /* 무시 */ }
  }
  $('btnSettings').addEventListener('click', openSettings);
  $('btnResetPrompt').addEventListener('click', () => { $('setPrompt').value = DEFAULT_PROMPT; });
  $('settingsDialog').addEventListener('close', () => {
    if ($('settingsDialog').returnValue !== 'save') return;
    settings.apiKey = $('setKey').value.trim();
    settings.autoStart = $('setAutoStart').checked;
    settings.prompt = $('setPrompt').value.trim() || DEFAULT_PROMPT;
    saveSettings();
    toast('설정을 저장했습니다.');
    if (!$('screen-list').hidden) renderList();
  });

  // ---------- 시작 ----------
  async function boot() {
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* 무시 */ }
    await recoverUnfinished();
    const params = new URLSearchParams(location.search);
    if (settings.autoStart && !params.has('list')) startNewMeeting();
    else goList();
  }

  boot();
})();
