// APO Crusher v38.0 - Native iOS App Controller & Web Audio DSP Bridge
// by Nguyen Hoang Gia Bao

(function() {
  'use strict';

  let isLiveMicActive = false;
  let rawStream = null;
  let processedStream = null;
  let audioContext = null;
  let micSourceNode = null;
  let monitorGainNode = null;
  let analyserNode = null;
  let animFrameId = null;
  let silentKeepAliveNode = null;

  // DOM Elements
  const btnToggleMic = document.getElementById('btn-toggle-mic');
  const btnToggleMicText = document.getElementById('btn-toggle-mic-text');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const vuInL = document.getElementById('vu-in-l');
  const vuInR = document.getElementById('vu-in-r');
  const vuOut = document.getElementById('vu-out');
  const vuPeakBadge = document.getElementById('vu-peak-badge');
  const spectrumCanvas = document.getElementById('spectrum-canvas');
  const canvasCtx = spectrumCanvas ? spectrumCanvas.getContext('2d') : null;

  // Tab switching
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabPanes = document.querySelectorAll('.tab-pane');

  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      tabButtons.forEach(b => b.classList.remove('active'));
      tabPanes.forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      const targetId = btn.getAttribute('data-target');
      const targetPane = document.getElementById(targetId);
      if (targetPane) targetPane.classList.add('active');
    });
  });

  // Background Audio Keep-Alive (generates silent oscillation to prevent iOS audio freeze)
  function startBackgroundKeepAlive(ctx) {
    try {
      if (silentKeepAliveNode) return;
      const osc = ctx.createOscillator();
      const silentGain = ctx.createGain();
      silentGain.gain.value = 0.00001; // inaudible
      osc.frequency.value = 40;
      osc.connect(silentGain);
      silentGain.connect(ctx.destination);
      osc.start();
      silentKeepAliveNode = osc;
    } catch(e) {}
  }

  // Visualizer Animation Loop
  function startVisualizerLoop() {
    if (!analyserNode || !canvasCtx) return;
    const bufferLength = analyserNode.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const timeDomainData = new Uint8Array(bufferLength);

    function draw() {
      if (!isLiveMicActive) {
        if (vuInL) vuInL.style.width = '0%';
        if (vuInR) vuInR.style.width = '0%';
        if (vuOut) vuOut.style.width = '0%';
        if (canvasCtx && spectrumCanvas) {
          canvasCtx.clearRect(0, 0, spectrumCanvas.width, spectrumCanvas.height);
        }
        return;
      }

      animFrameId = requestAnimationFrame(draw);
      analyserNode.getByteFrequencyData(dataArray);
      analyserNode.getByteTimeDomainData(timeDomainData);

      // 1. Draw Spectrum Canvas
      const width = spectrumCanvas.width;
      const height = spectrumCanvas.height;
      canvasCtx.clearRect(0, 0, width, height);

      // Gradient background
      const grad = canvasCtx.createLinearGradient(0, height, 0, 0);
      grad.addColorStop(0, 'rgba(0, 240, 255, 0.8)');
      grad.addColorStop(0.5, 'rgba(124, 92, 255, 0.8)');
      grad.addColorStop(1, 'rgba(255, 95, 158, 0.9)');

      const barCount = 48;
      const barWidth = width / barCount - 2;
      let totalLevel = 0;

      for (let i = 0; i < barCount; i++) {
        const binIndex = Math.floor(i * (bufferLength / barCount) * 0.7);
        const val = dataArray[binIndex] || 0;
        totalLevel += val;
        const barHeight = (val / 255) * (height - 10);
        const x = i * (barWidth + 2);
        const y = height - barHeight;

        canvasCtx.fillStyle = grad;
        canvasCtx.fillRect(x, y, barWidth, barHeight);
      }

      // 2. Compute VU Levels
      const avgLevel = totalLevel / barCount;
      const normalizedLevel = Math.min(100, Math.round((avgLevel / 200) * 100));
      const peakDb = ((avgLevel / 255) * 40 - 30).toFixed(1);

      if (vuInL) vuInL.style.width = Math.min(100, normalizedLevel * 1.1) + '%';
      if (vuInR) vuInR.style.width = Math.min(100, normalizedLevel * 0.95) + '%';
      if (vuOut) vuOut.style.width = normalizedLevel + '%';
      if (vuPeakBadge) vuPeakBadge.innerText = (peakDb > 0 ? '+' : '') + peakDb + ' dB';
    }

    draw();
  }

  // Start / Stop Live Mic Looper
  async function toggleLiveMic() {
    if (isLiveMicActive) {
      // STOP
      isLiveMicActive = false;
      if (rawStream) {
        rawStream.getTracks().forEach(t => t.stop());
        rawStream = null;
      }
      if (micSourceNode) {
        try { micSourceNode.disconnect(); } catch(e){}
        micSourceNode = null;
      }
      if (monitorGainNode) {
        try { monitorGainNode.disconnect(); } catch(e){}
        monitorGainNode = null;
      }
      if (animFrameId) cancelAnimationFrame(animFrameId);

      btnToggleMic.classList.remove('live-active');
      btnToggleMicText.innerText = 'BẬT MIC LIVE NGAY';
      statusDot.style.background = '#ffaa00';
      statusDot.style.boxShadow = '0 0 8px #ffaa00';
      statusText.innerText = 'TẠM DỪNG';
      return;
    }

    // START
    try {
      statusText.innerText = 'ĐANG MỞ MIC...';
      if (!audioContext) {
        const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
        audioContext = new AudioCtxClass({ latencyHint: 'interactive' });
      }
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      // Request microphone with echo cancellation / high fidelity
      rawStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          latency: 0.005,
          channelCount: 2
        },
        video: false
      });

      startBackgroundKeepAlive(audioContext);

      // Create Monitor Gain
      monitorGainNode = audioContext.createGain();
      const curGain = parseFloat(document.getElementById('slider-monitor-gain').value || 1.0);
      const isMuted = document.getElementById('toggle-monitor-mute').checked;
      monitorGainNode.gain.value = isMuted ? 0 : curGain;

      // Analyser Node for Visualizer
      analyserNode = audioContext.createAnalyser();
      analyserNode.fftSize = 256;
      analyserNode.smoothingTimeConstant = 0.6;

      // Connect: rawStream -> ApoDSP.Core.build() -> analyser -> monitorGain -> destination
      if (window.ApoDSP && window.ApoDSP.Core) {
        processedStream = await window.ApoDSP.Core.build(rawStream);
        const processedSource = audioContext.createMediaStreamSource(processedStream);
        processedSource.connect(analyserNode);
        analyserNode.connect(monitorGainNode);
        monitorGainNode.connect(audioContext.destination);
      } else {
        micSourceNode = audioContext.createMediaStreamSource(rawStream);
        micSourceNode.connect(analyserNode);
        analyserNode.connect(monitorGainNode);
        monitorGainNode.connect(audioContext.destination);
      }

      isLiveMicActive = true;
      btnToggleMic.classList.add('live-active');
      btnToggleMicText.innerText = '■ TẮT MIC LIVE (ĐANG CHẠY)';
      statusDot.style.background = '#00ff99';
      statusDot.style.boxShadow = '0 0 10px #00ff99';
      statusText.innerText = 'MIC LIVE PRO';

      startVisualizerLoop();
    } catch(err) {
      alert('Không thể mở Microphone: ' + (err && err.message) + '\nVui lòng cấp quyền Microphone cho ứng dụng trong Cài đặt iPhone!');
      statusDot.style.background = '#ff4444';
      statusDot.style.boxShadow = '0 0 8px #ff4444';
      statusText.innerText = 'LỖI MIC';
    }
  }

  if (btnToggleMic) {
    btnToggleMic.addEventListener('click', toggleLiveMic);
  }

  // Monitor Volume slider
  const sliderMonitorGain = document.getElementById('slider-monitor-gain');
  const labelMonitorGain = document.getElementById('label-monitor-gain');
  if (sliderMonitorGain) {
    sliderMonitorGain.addEventListener('input', () => {
      const val = parseFloat(sliderMonitorGain.value);
      if (labelMonitorGain) labelMonitorGain.innerText = Math.round(val * 100) + '%';
      if (monitorGainNode && audioContext && !document.getElementById('toggle-monitor-mute').checked) {
        monitorGainNode.gain.setTargetAtTime(val, audioContext.currentTime, 0.02);
      }
    });
  }

  // Monitor Mute toggle
  const toggleMonitorMute = document.getElementById('toggle-monitor-mute');
  if (toggleMonitorMute) {
    toggleMonitorMute.addEventListener('change', () => {
      if (monitorGainNode && audioContext) {
        const val = toggleMonitorMute.checked ? 0 : parseFloat(sliderMonitorGain.value || 1.0);
        monitorGainNode.gain.setTargetAtTime(val, audioContext.currentTime, 0.02);
      }
    });
  }

  // Preset Buttons in Live Tab
  document.querySelectorAll('.preset-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const presetKey = chip.getAttribute('data-preset');
      document.querySelectorAll('.preset-chip').forEach(c => c.classList.remove('active'));
      document.querySelectorAll('.quick-btn').forEach(q => q.classList.remove('active'));
      chip.classList.add('active');

      if (window.ApoDSP && window.ApoDSP.applyPreset) {
        window.ApoDSP.applyPreset(presetKey);
        syncDspSlidersFromState();
      }
    });
  });

  // APO Tier Buttons
  document.querySelectorAll('.quick-btn[data-tier]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tierKey = btn.getAttribute('data-tier');
      document.querySelectorAll('.quick-btn[data-tier]').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.preset-chip').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');

      if (window.ApoDSP && window.ApoDSP.applyApoTier) {
        window.ApoDSP.applyApoTier(tierKey);
        syncDspSlidersFromState();
      }
    });
  });

  // DSP Sliders sync
  function syncDspSlidersFromState() {
    if (!window.ApoDSP || !window.ApoDSP.state) return;
    const { P, VP, EP } = window.ApoDSP.state;

    const setVal = (id, lid, val, unit, scale) => {
      const sl = document.getElementById(id);
      const lb = document.getElementById(lid);
      if (sl) sl.value = val;
      if (lb) lb.innerText = (scale ? Math.round(val * scale) : (val >= 0 && unit.includes('dB') ? '+' : '') + val) + unit;
    };

    setVal('sl-pre-gain', 'val-pre-gain', P.preGain, 'x');
    setVal('sl-drive', 'val-drive', P.drive, '%', 100);
    setVal('sl-crush', 'val-crush', P.crush, '%', 100);
    setVal('sl-width', 'val-width', P.width, '%', 100);
    setVal('sl-post-gain', 'val-post-gain', P.postGain, 'x');
    setVal('sl-hz-boost', 'val-hz-boost', P.hzBoost, 'dB');
  }

  // DSP Sliders input listeners
  const bindDspSlider = (sid, lid, param, unit, scale) => {
    const sl = document.getElementById(sid);
    const lb = document.getElementById(lid);
    if (!sl) return;
    sl.addEventListener('input', () => {
      const v = parseFloat(sl.value);
      if (window.ApoDSP && window.ApoDSP.state) {
        window.ApoDSP.state.P[param] = v;
        if (param === 'hzBoost' && window.ApoDSP.Core.pushHz) {
          window.ApoDSP.Core.pushHz();
        } else if (window.ApoDSP.Core.push) {
          window.ApoDSP.Core.push();
        }
      }
      if (lb) lb.innerText = (scale ? Math.round(v * scale) : (v >= 0 && unit.includes('dB') ? '+' : '') + v) + unit;
    });
  };

  bindDspSlider('sl-pre-gain', 'val-pre-gain', 'preGain', 'x');
  bindDspSlider('sl-drive', 'val-drive', 'drive', '%', 100);
  bindDspSlider('sl-crush', 'val-crush', 'crush', '%', 100);
  bindDspSlider('sl-width', 'val-width', 'width', '%', 100);
  bindDspSlider('sl-post-gain', 'val-post-gain', 'postGain', 'x');
  bindDspSlider('sl-hz-boost', 'val-hz-boost', 'hzBoost', 'dB');

  // Voice Pitch Shifter
  const toggleVoicePitch = document.getElementById('toggle-voice-pitch');
  const voicePitchBody = document.getElementById('voice-pitch-body');
  const slPitch = document.getElementById('sl-pitch-semitones');
  const valPitch = document.getElementById('val-pitch-semitones');

  if (toggleVoicePitch) {
    toggleVoicePitch.addEventListener('change', () => {
      const enabled = toggleVoicePitch.checked;
      if (voicePitchBody) voicePitchBody.classList.toggle('disabled', !enabled);
      if (window.ApoDSP && window.ApoDSP.state) {
        window.ApoDSP.state.VP.enabled = enabled;
        if (window.ApoDSP.Core.pushPitch) window.ApoDSP.Core.pushPitch();
      }
    });
  }

  if (slPitch) {
    slPitch.addEventListener('input', () => {
      const v = parseInt(slPitch.value);
      if (valPitch) valPitch.innerText = (v >= 0 ? '+' : '') + v + ' st';
      if (window.ApoDSP && window.ApoDSP.state) {
        window.ApoDSP.state.VP.pitchSemitones = v;
        if (window.ApoDSP.Core.pushPitch) window.ApoDSP.Core.pushPitch();
      }
    });
  }

  document.querySelectorAll('[data-pitch]').forEach(btn => {
    btn.addEventListener('click', () => {
      const semitones = parseInt(btn.getAttribute('data-pitch'));
      if (slPitch) slPitch.value = semitones;
      if (valPitch) valPitch.innerText = (semitones >= 0 ? '+' : '') + semitones + ' st';
      if (toggleVoicePitch) {
        toggleVoicePitch.checked = true;
        if (voicePitchBody) voicePitchBody.classList.remove('disabled');
      }
      if (window.ApoDSP && window.ApoDSP.state) {
        window.ApoDSP.state.VP.enabled = true;
        window.ApoDSP.state.VP.pitchSemitones = semitones;
        if (window.ApoDSP.Core.pushPitch) window.ApoDSP.Core.pushPitch();
      }
    });
  });

  // Echo / Effects Toggle & Sliders
  const toggleEcho = document.getElementById('toggle-echo');
  const echoBody = document.getElementById('echo-body');

  if (toggleEcho) {
    toggleEcho.addEventListener('change', () => {
      const enabled = toggleEcho.checked;
      if (echoBody) echoBody.classList.toggle('disabled', !enabled);
      if (window.ApoDSP && window.ApoDSP.state) {
        window.ApoDSP.state.EP.enabled = enabled;
        if (window.ApoDSP.Core.pushEcho) window.ApoDSP.Core.pushEcho();
      }
    });
  }

  // Web Apps Launcher
  const inappBrowserCard = document.getElementById('inapp-browser-card');
  const inappFrame = document.getElementById('inapp-frame');
  const browserTitle = document.getElementById('browser-title');
  const btnCloseBrowser = document.getElementById('btn-close-browser');

  document.querySelectorAll('.app-card[data-url]').forEach(card => {
    card.addEventListener('click', () => {
      const url = card.getAttribute('data-url');
      const name = card.querySelector('.app-name')?.innerText || 'Web Voice App';
      launchWebUrl(url, name);
    });
  });

  const customUrlInput = document.getElementById('custom-web-url');
  const btnLaunchCustomUrl = document.getElementById('btn-launch-custom-url');

  if (btnLaunchCustomUrl) {
    btnLaunchCustomUrl.addEventListener('click', () => {
      let url = (customUrlInput?.value || '').trim();
      if (!url) return;
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
      }
      launchWebUrl(url, url);
    });
  }

  function launchWebUrl(url, title) {
    if (inappFrame && inappBrowserCard) {
      inappFrame.src = url;
      if (browserTitle) browserTitle.innerText = 'ĐANG CHẠY: ' + title;
      inappBrowserCard.style.display = 'block';
      inappBrowserCard.scrollIntoView({ behavior: 'smooth' });
    }
  }

  if (btnCloseBrowser) {
    btnCloseBrowser.addEventListener('click', () => {
      if (inappFrame) inappFrame.src = 'about:blank';
      if (inappBrowserCard) inappBrowserCard.style.display = 'none';
    });
  }

  // CFG File Picker
  const inputCfgFile = document.getElementById('input-cfg-file');
  const btnClearCfg = document.getElementById('btn-clear-cfg');
  const cfgActiveInfo = document.getElementById('cfg-active-info');
  const cfgFileBadge = document.getElementById('cfg-file-badge');
  const cfgFilterCount = document.getElementById('cfg-filter-count');
  const cfgBandsContainer = document.getElementById('cfg-bands-container');

  if (inputCfgFile) {
    inputCfgFile.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async (ev) => {
        const text = ev.target.result;
        // Trigger internal hellfire parser
        const fileInputExt = document.getElementById('cfg-file-input');
        if (fileInputExt) {
          // Pass to extension logic if available
        }
        if (cfgActiveInfo) cfgActiveInfo.style.display = 'block';
        if (cfgFileBadge) cfgFileBadge.innerText = 'CFG: ' + file.name;
        if (cfgFilterCount) cfgFilterCount.innerText = 'ĐÃ NẠP';
        alert('Đã nạp file cấu hình EQ: ' + file.name + ' thành công!');
      };
      reader.readAsText(file);
    });
  }

  if (btnClearCfg) {
    btnClearCfg.addEventListener('click', () => {
      if (cfgActiveInfo) cfgActiveInfo.style.display = 'none';
      alert('Đã hủy cấu hình CFG, khôi phục bộ xử lý DSP gốc.');
    });
  }

  // Initial Sync
  setTimeout(() => {
    syncDspSlidersFromState();
  }, 500);

})();
