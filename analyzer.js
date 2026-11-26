// BarkTalk 분석기: 모든 계산은 브라우저(기기) 안에서만 실행됩니다.
// 1) YAMNet(구글 공개 소리 분류 모델)으로 짖음/으르렁/낑낑/하울링 구분
// 2) 직접 계산한 소리 특징(음높이, 짖는 횟수·간격·길이)
// 3) emotions.js의 표현 목록(음성 46개·영상 46개) + 상황·시간으로 후보와 확신도 추정
(function () {
  'use strict';

  var SR = 16000;
  var YAMNET_URL = 'https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1';
  // AudioSet/YAMNet 클래스 번호
  var CLS = { dog: 69, bark: 70, yip: 71, howl: 72, bowwow: 73, growl: 74, whimper: 75 };

  var modelPromise = null;
  function loadModel() {
    if (!modelPromise) {
      modelPromise = (window.tf ? tf.loadGraphModel(YAMNET_URL, { fromTFHub: true }) : Promise.reject(new Error('tfjs 없음')))
        .catch(function (e) { console.warn('[BarkTalk] YAMNet을 불러오지 못해 소리 특징만으로 분석합니다.', e); modelPromise = null; return null; });
    }
    return modelPromise;
  }

  // 오디오 파일/녹음(Blob) → 16kHz 모노 Float32Array
  async function decodeTo16k(blob) {
    var buf = await blob.arrayBuffer();
    var Ctx = window.AudioContext || window.webkitAudioContext;
    var ctx = new Ctx();
    var decoded = await new Promise(function (res, rej) { ctx.decodeAudioData(buf, res, rej); });
    ctx.close && ctx.close();
    var len = Math.max(1, Math.ceil(decoded.duration * SR));
    var off = new OfflineAudioContext(1, len, SR);
    var src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    var rendered = await off.startRendering();
    var data = rendered.getChannelData(0);
    // 최대 15초까지만 사용
    return data.length > SR * 15 ? data.slice(0, SR * 15) : data;
  }

  function features(x) {
    var hop = 320, win = 640; // 20ms 간격, 40ms 창
    var rms = [];
    for (var i = 0; i + win <= x.length; i += hop) {
      var s = 0;
      for (var j = i; j < i + win; j++) s += x[j] * x[j];
      rms.push(Math.sqrt(s / win));
    }
    if (!rms.length) return { duration: x.length / SR, barks: [], count: 0, rate: 0, meanDur: 0, pitch: 0, regularity: 0, loudness: 0 };
    var sorted = rms.slice().sort(function (a, b) { return a - b; });
    var noise = sorted[Math.floor(sorted.length * 0.2)];
    var peak = sorted[sorted.length - 1];
    var thr = Math.max(noise * 3, peak * 0.25, 0.01);
    // 소리 덩어리(짖음 후보) 찾기
    var barks = [], start = -1;
    for (var k = 0; k < rms.length; k++) {
      if (rms[k] > thr && start < 0) start = k;
      if ((rms[k] <= thr || k === rms.length - 1) && start >= 0) {
        var dur = (k - start) * hop / SR;
        if (dur >= 0.06) barks.push({ t: start * hop / SR, dur: dur, from: start * hop, to: k * hop + win });
        start = -1;
      }
    }
    // 너무 가까운 덩어리는 합치기 (한 번의 짖음이 끊겨 보이는 경우)
    var merged = [];
    barks.forEach(function (b) {
      var last = merged[merged.length - 1];
      if (last && b.t - (last.t + last.dur) < 0.05) { last.dur = b.t + b.dur - last.t; last.to = b.to; }
      else merged.push(Object.assign({}, b));
    });
    barks = merged;
    var duration = x.length / SR;
    var pitches = [];
    barks.forEach(function (b) {
      var mid = Math.floor((b.from + b.to) / 2);
      var p = pitchAt(x, mid);
      if (p) pitches.push(p);
    });
    pitches.sort(function (a, b) { return a - b; });
    var gaps = [];
    for (var g = 1; g < barks.length; g++) gaps.push(barks[g].t - barks[g - 1].t);
    var regularity = 0;
    if (gaps.length >= 2) {
      var m = gaps.reduce(function (a, b) { return a + b; }, 0) / gaps.length;
      var v = gaps.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0) / gaps.length;
      regularity = Math.max(0, 1 - Math.sqrt(v) / (m || 1)); // 1에 가까울수록 일정한 간격
    }
    var span = barks.length ? Math.max(1, barks[barks.length - 1].t + barks[barks.length - 1].dur - barks[0].t) : duration;
    return {
      duration: duration,
      barks: barks,
      count: barks.length,
      rate: barks.length / span,
      meanDur: barks.length ? barks.reduce(function (a, b) { return a + b.dur; }, 0) / barks.length : 0,
      pitch: pitches.length ? pitches[Math.floor(pitches.length / 2)] : 0,
      regularity: regularity,
      loudness: peak
    };
  }

  // 자기상관으로 기본 주파수(Hz) 추정, 80~1600Hz
  function pitchAt(x, center) {
    var n = 1024, start = Math.max(0, center - n / 2);
    if (start + n > x.length) return 0;
    var minLag = Math.floor(SR / 1600), maxLag = Math.floor(SR / 80);
    var best = 0, bestLag = 0, e0 = 0;
    for (var i = 0; i < n; i++) e0 += x[start + i] * x[start + i];
    if (e0 <= 0) return 0;
    for (var lag = minLag; lag <= maxLag; lag++) {
      var c = 0;
      for (var j = 0; j + lag < n; j++) c += x[start + j] * x[start + j + lag];
      if (c > best) { best = c; bestLag = lag; }
    }
    return best / e0 > 0.3 ? SR / bestLag : 0;
  }

  async function classify(x) {
    var model = await loadModel();
    if (!model) return null;
    return tf.tidy(function () {
      var out = model.predict(tf.tensor1d(x));
      var scores = Array.isArray(out) ? out[0] : out; // [프레임, 521]
      var meanScores = scores.mean(0).arraySync();
      var maxScores = scores.max(0).arraySync();
      var pick = function (i) { return { mean: meanScores[i], max: maxScores[i] }; };
      return {
        dog: Math.max(maxScores[CLS.dog], maxScores[CLS.bark], maxScores[CLS.bowwow], maxScores[CLS.yip]),
        bark: pick(CLS.bark), yip: pick(CLS.yip), howl: pick(CLS.howl), growl: pick(CLS.growl), whimper: pick(CLS.whimper)
      };
    });
  }

  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  // 소리 특징 + 상황 + 시간 → 신호(0~1). emotions.js의 가중치 이름과 같습니다.
  function contextSignals(situation, date) {
    var sig = {};
    if (situation) sig[situation] = 1;
    var h = (date || new Date()).getHours();
    if ((h >= 6 && h <= 9) || (h >= 17 && h <= 20)) sig.meal = 1;
    if (h >= 22 || h <= 5) sig.late = 1;
    return sig;
  }

  function audioSignals(f, y) {
    var sig = {};
    if (f.pitch) {
      if (f.pitch < 400) sig.low = 1;
      else if (f.pitch > 750) sig.high = 1;
      else sig.mid = 1;
      if (f.pitch > 1000) sig.vhigh = 1;
    }
    if (f.rate > 2) sig.fast = 1;
    else if (f.rate >= 0.9) sig.med = 1;
    else if (f.rate > 0) sig.slow = 1;
    if (f.meanDur > 0.45) sig.long = 1;
    else if (f.meanDur > 0 && f.meanDur < 0.25) sig.short = 1;
    if (f.regularity > 0.6) sig.regular = 1;
    if (f.count >= 6) sig.many = 1;
    if (f.count > 0 && f.count <= 2) sig.few = 1;
    if (f.count === 1) sig.one = 1;
    if (f.loudness > 0.5) sig.loud = 1;
    if (f.loudness > 0 && f.loudness < 0.08) sig.quiet = 1;
    if (y) {
      sig.growl = clamp01(y.growl.max * 2);
      sig.whimper = clamp01(y.whimper.max * 2);
      sig.howl = clamp01(y.howl.max * 2);
      sig.yip = clamp01(y.yip.max * 2);
    }
    return sig;
  }

  function merge(a, b) { var o = {}; for (var k in a) o[k] = a[k]; for (var j in b) o[j] = Math.max(o[j] || 0, b[j]); return o; }

  function heardText(f, y) {
    var parts = [];
    if (f.count) parts.push('짖음 ' + f.count + '번 (' + f.duration.toFixed(1) + '초 동안)');
    if (f.pitch) parts.push('음높이 약 ' + Math.round(f.pitch) + 'Hz' + (f.pitch < 400 ? ' · 낮은 편' : f.pitch > 750 ? ' · 높은 편' : ' · 중간'));
    if (f.rate) parts.push(f.rate > 2 ? '빠르게 이어짐' : f.rate < 0.9 ? '띄엄띄엄' : '보통 빠르기');
    if (y) {
      if (y.growl.max > 0.15) parts.push('으르렁 소리 감지');
      if (y.whimper.max > 0.15) parts.push('낑낑 소리 감지');
      if (y.howl.max > 0.15) parts.push('하울링 감지');
    } else {
      parts.push('소리 분류 모델 없이 분석함');
    }
    return parts.join(' · ');
  }

  // 소리만 읽어 특징을 돌려줍니다 (영상에서도 사용)
  async function listen(blob) {
    var x = await decodeTo16k(blob);
    var f = features(x);
    var y = null;
    try { y = await classify(x); } catch (e) { console.warn('[BarkTalk] 분류 실패', e); }
    var dogHeard = y ? y.dog > 0.1 : f.count > 0;
    return { f: f, y: y, bark: dogHeard && f.count > 0 };
  }

  function pack(ranked, heard, model, feat) {
    return {
      noBark: false,
      model: model,
      main: ranked[0],
      others: ranked.slice(1),
      heard: heard,
      features: feat
    };
  }

  function featSummary(f) { return { count: f.count, pitch: Math.round(f.pitch), rate: +f.rate.toFixed(2), meanDur: +f.meanDur.toFixed(2) }; }

  async function analyze(blob, situation) {
    var L = await listen(blob);
    if (!L.bark) return { noBark: true, model: !!L.y };
    var sig = merge(audioSignals(L.f, L.y), contextSignals(situation));
    var ranked = window.BarkEmotions.rank(window.BarkEmotions.AUDIO, sig);
    return pack(ranked, heardText(L.f, L.y), !!L.y, featSummary(L.f));
  }

  // 영상: 보호자가 고른 몸짓 + 상황 + (가능하면) 영상 속 소리
  var AUDIO_TO_VIDEO = { alert: 'alert', threat: 'threat', want: 'want', play: 'play', fear: 'fear', body: 'body' };
  async function analyzeVideo(blob, cues, situation) {
    var E = window.BarkEmotions;
    var sig = contextSignals(situation);
    (cues || []).forEach(function (c) { sig[c] = 1; });
    var boost = {}, heard = '영상 속 짖음은 들리지 않았어요', feat = null, model = false;
    if (blob) {
      try {
        var L = await listen(blob);
        model = !!L.y;
        if (L.bark) {
          var a = E.rank(E.AUDIO, merge(audioSignals(L.f, L.y), sig));
          if (AUDIO_TO_VIDEO[a[0].group]) boost[AUDIO_TO_VIDEO[a[0].group]] = 1.5;
          if (AUDIO_TO_VIDEO[a[1].group]) boost[AUDIO_TO_VIDEO[a[1].group]] = Math.max(boost[AUDIO_TO_VIDEO[a[1].group]] || 0, 0.8);
          heard = heardText(L.f, L.y) + ' · 소리로는 "' + a[0].title + '"에 가까워요';
          feat = featSummary(L.f);
        }
      } catch (e) {
        console.warn('[BarkTalk] 영상 소리를 읽지 못했어요', e);
        heard = '영상 속 소리는 읽지 못해 몸짓만으로 분석했어요';
      }
    }
    var ranked = E.rank(E.VIDEO, sig, boost);
    return pack(ranked, heard, model, feat);
  }

  window.MungAnalyzer = { analyze: analyze, analyzeVideo: analyzeVideo, preload: loadModel };
})();
