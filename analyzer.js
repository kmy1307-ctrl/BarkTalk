// BarkTalk 분석기: 모든 계산은 브라우저(기기) 안에서만 실행됩니다.
// 1) YAMNet(구글 공개 소리 분류 모델)으로 짖음/으르렁/낑낑/하울링 구분
// 2) 직접 계산한 소리 특징(음높이, 짖는 횟수·간격·길이)
// 3) 규칙표 + 사용자가 고른 상황으로 의미 후보와 확신도 추정
(function () {
  'use strict';

  var SR = 16000;
  var YAMNET_URL = 'https://tfhub.dev/google/tfjs-model/yamnet/tfjs/1';
  // AudioSet/YAMNet 클래스 번호
  var CLS = { dog: 69, bark: 70, yip: 71, howl: 72, bowwow: 73, growl: 74, whimper: 75 };

  var MEANINGS = {
    alert: {
      title: '경계해요',
      desc: '낯선 소리나 사람을 알리고 있어요. 낮고 반복되는 짖음에서 자주 보여요.',
      tips: ['차분한 목소리로 이름을 불러 주세요.', '문에서 떨어진 곳으로 불러 앉게 한 뒤 간식으로 보상해요.', '소리를 질러 혼내면 같이 짖는 것으로 느껴 더 짖을 수 있어요.']
    },
    anxious: {
      title: '외로워요 · 불안해요',
      desc: '보호자를 찾거나 불안할 때 나는 소리에 가까워요. 높고 끊기는 짖음, 낑낑거림, 하울링이 섞여요.',
      tips: ['외출 전 10~15분은 조용히 지내고 인사는 짧게 해 주세요.', '노즈워크 장난감처럼 혼자 할 거리를 남겨 주세요.', '매일 길게 이어지면 분리불안일 수 있어 전문가와 상의해 보세요.']
    },
    play: {
      title: '신나요 · 놀고 싶어요',
      desc: '높고 빠르게 이어지는 짖음이에요. 기대감이나 즐거움을 표현할 때 흔해요.',
      tips: ['짖는 동안엔 반응하지 말고, 조용해지는 순간 놀이를 시작해요.', '짧은 놀이로 에너지를 먼저 풀어 주세요.', '"앉아"처럼 아는 동작을 시키고 해내면 칭찬해 주세요.']
    },
    demand: {
      title: '원해요 · 졸라요',
      desc: '간식, 놀이, 관심처럼 원하는 걸 달라고 조르는 소리에 가까워요. 보호자를 보며 짖다가 낑낑거리기를 되풀이하는 경우가 많아요.',
      tips: ['짖거나 낑낑댈 때 바로 주면 "조르면 생긴다"고 배워요. 조용해진 순간에 주세요.', '"앉아"나 "기다려"를 시키고, 해내면 그때 간식이나 놀이로 보상해 주세요.', '간식·밥·놀이 시간을 일정하게 정해 두면 조르는 횟수가 줄어요.']
    },
    threat: {
      title: '불편해요 · 다가오지 마세요',
      desc: '낮은 짖음과 으르렁거림이 섞여 있어요. 무언가가 불편하거나 위협으로 느껴질 때 나와요.',
      tips: ['억지로 다가가거나 만지지 말고 거리를 두세요.', '무엇 때문에 그러는지(사람, 다른 개, 물건) 원인을 치워 주세요.', '자주 반복되면 행동 전문가나 수의사와 상담하세요.']
    }
  };

  var SITUATION_PRIOR = { bell: 'alert', alone: 'anxious', walk: 'play', food: 'demand' };

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

  function score(f, y, situation) {
    var s = { alert: 1, anxious: 1, play: 1, demand: 1, threat: 0.6 };
    if (f.pitch) {
      if (f.pitch < 400) { s.threat += 1.2; s.alert += 1; }
      else if (f.pitch > 750) { s.play += 1; s.demand += 0.4; s.anxious += 0.5; }
      else { s.alert += 0.5; s.demand += 0.5; }
    }
    if (f.rate > 2) { s.play += 1; s.alert += 0.8; }
    else if (f.rate >= 0.9) { s.demand += 0.8; } // 보통 빠르기로 되풀이 = 조르기에 흔함
    else if (f.rate > 0 && f.rate < 0.9) { s.anxious += 0.8; s.demand += 0.4; }
    if (f.meanDur > 0.45) s.anxious += 1;
    if (f.meanDur > 0 && f.meanDur < 0.25 && f.regularity > 0.6) s.demand += 1;
    if (f.count >= 6) s.alert += 0.5;
    if (y) {
      s.threat += y.growl.max * 4;
      // 낑낑 소리: 짖음과 섞여 되풀이되면 조르기, 짖음 없이 낑낑/하울링 위주면 불안
      var begging = f.count >= 3 && y.howl.max < 0.3;
      s.demand += y.whimper.max * (begging ? 4 : 1.5);
      s.anxious += y.whimper.max * (begging ? 1.5 : 3) + y.howl.max * 3;
      s.play += y.yip.max * 2;
    }
    var prior = SITUATION_PRIOR[situation];
    if (prior) s[prior] += 2;
    var keys = Object.keys(s);
    var sq = keys.map(function (k) { return s[k] * s[k]; });
    var tot = sq.reduce(function (a, b) { return a + b; }, 0);
    var ranked = keys.map(function (k, i) { return { key: k, p: sq[i] / tot }; })
      .sort(function (a, b) { return b.p - a.p; });
    // 화면용 숫자: 1순위는 30~85% 사이로 제한(과신 방지), 나머지 두 후보에 비율대로 분배
    var top = Math.round(Math.min(0.85, Math.max(0.3, ranked[0].p * 1.6)) * 100);
    var rest = 100 - top, base = ranked[1].p + ranked[2].p;
    var p2 = Math.round(rest * ranked[1].p / base);
    return [
      { key: ranked[0].key, pct: top },
      { key: ranked[1].key, pct: p2 },
      { key: ranked[2].key, pct: rest - p2 }
    ];
  }

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

  async function analyze(blob, situation) {
    var x = await decodeTo16k(blob);
    var f = features(x);
    var y = null;
    try { y = await classify(x); } catch (e) { console.warn('[BarkTalk] 분류 실패', e); }
    var dogHeard = y ? y.dog > 0.1 : f.count > 0;
    if (!dogHeard || f.count === 0) {
      return { noBark: true, model: !!y };
    }
    var ranked = score(f, y, situation);
    return {
      noBark: false,
      model: !!y,
      main: Object.assign({ key: ranked[0].key, pct: ranked[0].pct }, MEANINGS[ranked[0].key]),
      others: ranked.slice(1).map(function (r) { return { key: r.key, pct: r.pct, title: MEANINGS[r.key].title }; }),
      heard: heardText(f, y),
      features: { count: f.count, pitch: Math.round(f.pitch), rate: +f.rate.toFixed(2), meanDur: +f.meanDur.toFixed(2) }
    };
  }

  window.MungAnalyzer = { analyze: analyze, preload: loadModel, MEANINGS: MEANINGS };
})();
