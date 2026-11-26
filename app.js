(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var E = window.BarkEmotions;
  var screens = ['home', 'upload', 'video', 'analyzing', 'result'];
  var state = {
    screen: 'home', mode: 'audio', result: null,
    blob: null, situation: null, recorder: null, timer: null,
    vBlob: null, vSituation: null, vRecorder: null, vTimer: null, vStream: null, cues: []
  };
  var HISTORY_KEY = 'barktalk.history.v1';
  var SKIP_TIP_KEY = 'barktalk.skipVideoTip';

  function store(key, val) {
    try {
      if (val === undefined) return JSON.parse(localStorage.getItem(key) || '[]');
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) { return []; }
  }
  function flag(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key) === '1';
      localStorage.setItem(key, val ? '1' : '0');
    } catch (e) { return false; }
  }

  function show(name) {
    state.screen = name;
    screens.forEach(function (s) { $('screen-' + s).hidden = s !== name; });
    $('back').hidden = !(name === 'upload' || name === 'video' || name === 'result');
    window.scrollTo(0, 0);
    if (name !== 'video') stopCamera();
    if (name === 'home') renderHistory();
  }

  function renderHistory() {
    var list = store(HISTORY_KEY).slice(0, 5);
    $('history-card').hidden = !list.length;
    $('history').innerHTML = '';
    list.forEach(function (h) {
      var li = document.createElement('li');
      var d = new Date(h.at);
      var when = (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      var left = document.createElement('span'); left.textContent = when + (h.mode === 'video' ? ' · 영상' : ' · 음성') + (h.feedback === 'yes' ? ' · 맞음' : h.feedback === 'no' ? ' · 틀림' : '');
      var right = document.createElement('b'); right.textContent = h.title;
      li.appendChild(left); li.appendChild(right);
      $('history').appendChild(li);
    });
  }

  function renderChips(wrapId, key) {
    var wrap = $(wrapId);
    wrap.innerHTML = '';
    E.SITUATIONS.forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'chip'; b.textContent = s[1];
      b.setAttribute('aria-pressed', String(state[key] === s[0]));
      b.onclick = function () { state[key] = state[key] === s[0] ? null : s[0]; renderChips(wrapId, key); updateVideoReady(); };
      wrap.appendChild(b);
    });
  }

  function renderCues() {
    var wrap = $('cues');
    wrap.innerHTML = '';
    E.CUES.forEach(function (group) {
      var fs = document.createElement('fieldset'); fs.className = 'chips-wrap';
      var lg = document.createElement('legend'); lg.textContent = group[0]; fs.appendChild(lg);
      var row = document.createElement('div'); row.className = 'chips';
      group[1].forEach(function (c) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'chip'; b.textContent = c[1];
        b.setAttribute('aria-pressed', String(state.cues.indexOf(c[0]) >= 0));
        b.onclick = function () {
          var i = state.cues.indexOf(c[0]);
          if (i >= 0) state.cues.splice(i, 1); else state.cues.push(c[0]);
          b.setAttribute('aria-pressed', String(i < 0));
          updateVideoReady();
        };
        row.appendChild(b);
      });
      fs.appendChild(row); wrap.appendChild(fs);
    });
  }

  // ---------- 음성 ----------
  function setInput(blob, name, meta) {
    state.blob = blob;
    $('input-empty').hidden = !!blob;
    $('input-ready').hidden = !blob;
    $('analyze').disabled = !blob;
    $('error').hidden = true;
    var player = $('player');
    if (player.src) URL.revokeObjectURL(player.src);
    if (blob) {
      $('input-name').textContent = name;
      $('input-meta').textContent = meta || '';
      player.src = URL.createObjectURL(blob);
      player.hidden = false;
    } else {
      player.removeAttribute('src');
      player.hidden = true;
    }
  }

  function showError(msg, id) { $(id || 'error').textContent = msg; $(id || 'error').hidden = false; }

  async function toggleRecord() {
    if (state.recorder && state.recorder.state === 'recording') { state.recorder.stop(); return; }
    if (!navigator.mediaDevices || !window.MediaRecorder) { showError('이 브라우저는 녹음을 지원하지 않아요. 음성 파일을 골라 주세요.'); return; }
    var stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } }); }
    catch (e) { showError('마이크 사용이 허용되지 않았어요. 설정에서 허용하거나 음성 파일을 골라 주세요.'); return; }
    var chunks = [], started = Date.now();
    var rec = new MediaRecorder(stream);
    state.recorder = rec;
    rec.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data); };
    rec.onstop = function () {
      clearTimeout(state.timer);
      stream.getTracks().forEach(function (t) { t.stop(); });
      $('rec').classList.remove('recording');
      $('rec').setAttribute('aria-label', '녹음 시작');
      $('rec-label').textContent = '눌러서 녹음 (최대 10초)';
      var secs = ((Date.now() - started) / 1000).toFixed(1);
      setInput(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }), '녹음 완료', secs + '초');
    };
    rec.start();
    $('rec').classList.add('recording');
    $('rec').setAttribute('aria-label', '녹음 멈추기');
    $('rec-label').textContent = '녹음 중… 다시 누르면 멈춰요';
    state.timer = setTimeout(function () { if (rec.state === 'recording') rec.stop(); }, 10000);
  }

  // ---------- 영상 ----------
  function updateVideoReady() {
    $('v-analyze').disabled = !(state.vBlob || state.cues.length);
  }

  function setVideo(blob, name, meta) {
    state.vBlob = blob;
    $('v-empty').hidden = !!blob;
    $('v-ready').hidden = !blob;
    $('v-error').hidden = true;
    var player = $('v-player');
    if (player.src) URL.revokeObjectURL(player.src);
    if (blob) {
      $('v-name').textContent = name;
      $('v-meta').textContent = meta || '';
      player.src = URL.createObjectURL(blob);
      player.hidden = false;
    } else {
      player.removeAttribute('src');
      player.hidden = true;
    }
    updateVideoReady();
  }

  function stopCamera() {
    if (state.vRecorder && state.vRecorder.state === 'recording') state.vRecorder.stop();
    if (state.vStream) { state.vStream.getTracks().forEach(function (t) { t.stop(); }); state.vStream = null; }
    var live = $('v-live'); live.srcObject = null; live.hidden = true;
  }

  async function toggleVideoRecord() {
    if (state.vRecorder && state.vRecorder.state === 'recording') { state.vRecorder.stop(); return; }
    if (!navigator.mediaDevices || !window.MediaRecorder) { showError('이 브라우저는 녹화를 지원하지 않아요. 영상 파일을 골라 주세요.', 'v-error'); return; }
    var stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: { echoCancellation: false, noiseSuppression: false } });
    } catch (e) { showError('카메라·마이크 사용이 허용되지 않았어요. 설정에서 허용하거나 영상 파일을 골라 주세요.', 'v-error'); return; }
    state.vStream = stream;
    var live = $('v-live'); live.srcObject = stream; live.hidden = false; live.play().catch(function () {});
    var chunks = [], started = Date.now();
    var rec = new MediaRecorder(stream);
    state.vRecorder = rec;
    rec.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data); };
    rec.onstop = function () {
      clearTimeout(state.vTimer);
      stopCamera();
      $('v-rec').classList.remove('recording');
      $('v-rec').setAttribute('aria-label', '녹화 시작');
      $('v-rec-label').textContent = '눌러서 녹화 (최대 15초)';
      var secs = ((Date.now() - started) / 1000).toFixed(1);
      if (chunks.length) setVideo(new Blob(chunks, { type: rec.mimeType || 'video/webm' }), '녹화 완료', secs + '초');
    };
    rec.start();
    $('v-rec').classList.add('recording');
    $('v-rec').setAttribute('aria-label', '녹화 멈추기');
    $('v-rec-label').textContent = '녹화 중… 다시 누르면 멈춰요';
    state.vTimer = setTimeout(function () { if (rec.state === 'recording') rec.stop(); }, 15000);
  }

  // ---------- 분석 ----------
  async function runAnalysis(mode) {
    var video = mode === 'video';
    if (video ? !(state.vBlob || state.cues.length) : !state.blob) return;
    state.mode = mode;
    $('analyzing-title').textContent = video ? '몸짓과 소리를 살피는 중' : '짖음 소리를 듣는 중';
    $('analyzing-step').textContent = video
      ? '고른 몸짓과 영상 속 소리를 함께 보고 있어요. 영상은 폰 밖으로 나가지 않아요.'
      : '음높이, 짖는 간격, 반복 횟수를 살펴보고 있어요. 소리는 폰 밖으로 나가지 않아요.';
    show('analyzing');
    var t0 = Date.now();
    var res;
    try {
      res = video
        ? await window.MungAnalyzer.analyzeVideo(state.vBlob, state.cues, state.vSituation)
        : await window.MungAnalyzer.analyze(state.blob, state.situation);
    } catch (e) {
      console.error(e);
      show(video ? 'video' : 'upload');
      showError(video ? '영상을 읽지 못했어요. 다른 영상으로 다시 시도해 주세요.' : '소리를 읽지 못했어요. 다른 파일(mp3, m4a, wav)로 다시 시도해 주세요.', video ? 'v-error' : 'error');
      return;
    }
    var wait = Math.max(0, 900 - (Date.now() - t0)); // 너무 빨리 넘어가면 어색해서 최소 0.9초
    setTimeout(function () {
      if (res.noBark) {
        show('upload');
        showError('강아지 짖음이 잘 들리지 않아요. 강아지 가까이에서, 주변 소리를 줄이고 다시 녹음해 주세요.');
        return;
      }
      if (video && !state.cues.length && !res.features) {
        show('video');
        showError('짖음이 들리지 않았어요. 아래에서 영상에 보인 모습(꼬리, 귀, 자세 등)을 하나 이상 골라 주세요.', 'v-error');
        return;
      }
      state.result = res;
      renderResult(res, mode);
      var list = store(HISTORY_KEY);
      res.id = Date.now();
      list.unshift({ id: res.id, at: res.id, mode: mode, key: res.main.key, title: res.main.title, pct: res.main.pct, situation: video ? state.vSituation : state.situation, cues: video ? state.cues.slice() : undefined, features: res.features, feedback: null });
      store(HISTORY_KEY, list.slice(0, 50));
      show('result');
    }, wait);
  }

  function renderResult(r, mode) {
    $('r-eyebrow').textContent = mode === 'video' ? '영상 정밀 분석 결과' : '음성 빠른 분석 결과';
    $('r-title').textContent = r.main.title;
    $('r-pct').textContent = r.main.pct + '%';
    $('r-desc').textContent = r.main.desc;
    $('r-bar').style.width = '0';
    requestAnimationFrame(function () { requestAnimationFrame(function () { $('r-bar').style.width = r.main.pct + '%'; }); });
    var o = $('r-others'); o.innerHTML = '';
    r.others.forEach(function (x) {
      var d = document.createElement('div'); d.className = 'other';
      var row = document.createElement('div'); row.className = 'row';
      var a = document.createElement('span'); a.textContent = x.title;
      var b = document.createElement('b'); b.textContent = x.pct + '%';
      row.appendChild(a); row.appendChild(b);
      var bar = document.createElement('div'); bar.className = 'bar';
      var fill = document.createElement('div'); fill.style.width = x.pct + '%'; bar.appendChild(fill);
      d.appendChild(row); d.appendChild(bar); o.appendChild(d);
    });
    $('r-heard').textContent = r.heard;
    var tips = $('r-tips'); tips.innerHTML = '';
    r.main.tips.forEach(function (t) { var li = document.createElement('li'); li.textContent = t; tips.appendChild(li); });
    setFeedback(null);
  }

  function setFeedback(v) {
    $('fb-yes').setAttribute('aria-pressed', String(v === 'yes'));
    $('fb-no').setAttribute('aria-pressed', String(v === 'no'));
    $('fb-q').textContent = v ? '알려 주셔서 고마워요. 기록에 남겨 둘게요.' : '이 결과가 맞았나요?';
    if (v && state.result) {
      var list = store(HISTORY_KEY);
      list.forEach(function (h) { if (h.id === state.result.id) h.feedback = v; });
      store(HISTORY_KEY, list);
    }
  }

  function reset() {
    if (state.recorder && state.recorder.state === 'recording') state.recorder.stop();
    setInput(null); state.situation = null; renderChips('situations', 'situation');
  }
  function resetVideo() {
    stopCamera();
    setVideo(null); state.vSituation = null; state.cues = [];
    renderChips('v-situations', 'vSituation'); renderCues(); updateVideoReady();
  }

  // ---------- 팝업 · 목록 ----------
  var lastFocus = null;
  function openModal(id, focusId) {
    lastFocus = document.activeElement;
    $(id).hidden = false;
    document.body.classList.add('locked');
    ($(focusId) || $(id)).focus();
  }
  function closeModal(id) {
    $(id).hidden = true;
    document.body.classList.remove('locked');
    if (lastFocus) lastFocus.focus();
  }

  function startAudio() { reset(); show('upload'); window.MungAnalyzer.preload(); }
  function startVideo() { resetVideo(); show('video'); window.MungAnalyzer.preload(); }

  function openList(kind) {
    var audio = kind === 'audio';
    var list = audio ? E.AUDIO : E.VIDEO, groups = audio ? E.AUDIO_GROUPS : E.VIDEO_GROUPS;
    $('list-eyebrow').textContent = audio ? '음성 빠른 분석' : '영상 정밀 분석';
    $('list-title').textContent = (audio ? '소리로' : '영상으로') + ' 알 수 있는 표현 ' + list.length + '가지';
    $('list-sub').textContent = audio
      ? '짖음의 높이·빠르기·길이, 으르렁·낑낑·하울링 소리, 고른 상황과 시간을 함께 보고 추정해요.'
      : '꼬리·귀·자세·표정·행동과 영상 속 소리, 고른 상황을 함께 보고 추정해요.';
    var body = $('list-body'); body.innerHTML = '';
    groups.forEach(function (g) {
      var items = list.filter(function (e) { return e.g === g[0]; });
      if (!items.length) return;
      var sec = document.createElement('section'); sec.className = 'list-group';
      var h = document.createElement('h4'); h.textContent = g[1] + ' · ' + items.length; sec.appendChild(h);
      var ul = document.createElement('ul');
      items.forEach(function (e) {
        var li = document.createElement('li');
        var t = document.createElement('b'); t.textContent = e.t;
        var d = document.createElement('span'); d.textContent = e.d;
        li.appendChild(t); li.appendChild(d); ul.appendChild(li);
      });
      sec.appendChild(ul); body.appendChild(sec);
    });
    body.scrollTop = 0;
    openModal('list-modal', 'list-close');
  }

  // ---------- 연결 ----------
  $('audio-count').textContent = E.AUDIO.length;
  $('video-count').textContent = E.VIDEO.length;
  $('tip-video-count').textContent = E.VIDEO.length;

  $('go-audio').onclick = function () {
    if (flag(SKIP_TIP_KEY)) { startAudio(); return; }
    $('tip-skip').checked = false;
    openModal('tip-modal', 'tip-ok');
  };
  $('tip-ok').onclick = function () { flag(SKIP_TIP_KEY, $('tip-skip').checked); closeModal('tip-modal'); startAudio(); };
  $('tip-video').onclick = function () { flag(SKIP_TIP_KEY, $('tip-skip').checked); closeModal('tip-modal'); startVideo(); };
  $('go-video').onclick = startVideo;
  Array.prototype.forEach.call(document.querySelectorAll('[data-list]'), function (b) {
    b.onclick = function () { openList(b.getAttribute('data-list')); };
  });
  $('list-close').onclick = function () { closeModal('list-modal'); };
  ['tip-modal', 'list-modal'].forEach(function (id) {
    $(id).addEventListener('click', function (e) { if (e.target === $(id)) closeModal(id); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    ['tip-modal', 'list-modal'].forEach(function (id) { if (!$(id).hidden) closeModal(id); });
  });

  $('back').onclick = function () {
    if (state.screen === 'result') show(state.mode === 'video' ? 'video' : 'upload');
    else show('home');
  };
  $('rec').onclick = toggleRecord;
  $('file').onchange = function (e) {
    var f = e.target.files[0];
    if (f) setInput(f, f.name, (f.size / 1024).toFixed(0) + 'KB');
    e.target.value = '';
  };
  $('clear').onclick = function () { setInput(null); };
  $('analyze').onclick = function () { runAnalysis('audio'); };

  $('v-rec').onclick = toggleVideoRecord;
  $('v-file').onchange = function (e) {
    var f = e.target.files[0];
    if (f) setVideo(f, f.name, (f.size / 1024 / 1024).toFixed(1) + 'MB');
    e.target.value = '';
  };
  $('v-clear').onclick = function () { setVideo(null); };
  $('v-analyze').onclick = function () { runAnalysis('video'); };

  $('fb-yes').onclick = function () { setFeedback('yes'); };
  $('fb-no').onclick = function () { setFeedback('no'); };
  $('restart').onclick = function () { reset(); resetVideo(); show('home'); };

  renderChips('situations', 'situation');
  resetVideo();
  show('home');

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
})();
