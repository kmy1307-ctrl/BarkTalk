(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var screens = ['home', 'upload', 'analyzing', 'result'];
  var state = { screen: 'home', blob: null, situation: null, recorder: null, result: null, timer: null };
  var SITUATIONS = [['bell', '초인종·낯선 소리'], ['alone', '혼자 있을 때'], ['walk', '산책 전·놀 때'], ['food', '밥·간식 전']];
  var HISTORY_KEY = 'barktalk.history.v1';

  function store(key, val) {
    try {
      if (val === undefined) return JSON.parse(localStorage.getItem(key) || '[]');
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) { return []; }
  }

  function show(name) {
    state.screen = name;
    screens.forEach(function (s) { $('screen-' + s).hidden = s !== name; });
    $('back').hidden = !(name === 'upload' || name === 'result');
    window.scrollTo(0, 0);
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
      var left = document.createElement('span'); left.textContent = when + ' · 음성' + (h.feedback === 'yes' ? ' · 맞음' : h.feedback === 'no' ? ' · 틀림' : '');
      var right = document.createElement('b'); right.textContent = h.title;
      li.appendChild(left); li.appendChild(right);
      $('history').appendChild(li);
    });
  }

  function renderSituations() {
    var wrap = $('situations');
    wrap.innerHTML = '';
    SITUATIONS.forEach(function (s) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'chip'; b.textContent = s[1];
      b.setAttribute('aria-pressed', String(state.situation === s[0]));
      b.onclick = function () { state.situation = state.situation === s[0] ? null : s[0]; renderSituations(); };
      wrap.appendChild(b);
    });
  }

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

  function showError(msg) { $('error').textContent = msg; $('error').hidden = false; }

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

  async function runAnalysis() {
    if (!state.blob) return;
    show('analyzing');
    var t0 = Date.now();
    var res;
    try { res = await window.MungAnalyzer.analyze(state.blob, state.situation); }
    catch (e) {
      console.error(e);
      show('upload');
      showError('소리를 읽지 못했어요. 다른 파일(mp3, m4a, wav)로 다시 시도해 주세요.');
      return;
    }
    var wait = Math.max(0, 900 - (Date.now() - t0)); // 너무 빨리 넘어가면 어색해서 최소 0.9초
    setTimeout(function () {
      if (res.noBark) {
        show('upload');
        showError('강아지 짖음이 잘 들리지 않아요. 강아지 가까이에서, 주변 소리를 줄이고 다시 녹음해 주세요.');
        return;
      }
      state.result = res;
      renderResult(res);
      var list = store(HISTORY_KEY);
      res.id = Date.now();
      list.unshift({ id: res.id, at: res.id, title: res.main.title, pct: res.main.pct, situation: state.situation, features: res.features, feedback: null });
      store(HISTORY_KEY, list.slice(0, 50));
      show('result');
    }, wait);
  }

  function renderResult(r) {
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
    setInput(null); state.situation = null; renderSituations();
  }

  $('go-audio').onclick = function () { reset(); show('upload'); window.MungAnalyzer.preload(); };
  $('back').onclick = function () { show(state.screen === 'result' ? 'upload' : 'home'); };
  $('rec').onclick = toggleRecord;
  $('file').onchange = function (e) {
    var f = e.target.files[0];
    if (f) setInput(f, f.name, (f.size / 1024).toFixed(0) + 'KB');
    e.target.value = '';
  };
  $('clear').onclick = function () { setInput(null); };
  $('analyze').onclick = runAnalysis;
  $('fb-yes').onclick = function () { setFeedback('yes'); };
  $('fb-no').onclick = function () { setFeedback('no'); };
  $('restart').onclick = function () { reset(); show('home'); };

  renderSituations();
  show('home');

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
})();
