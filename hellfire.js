(function () {
    'use strict';
    if (window.__ApoKTapAm__) return;
    window.__ApoKTapAm__ = true;

    const P = {
        preGain:  1.0,
        drive:    0.0,
        crush:    0.0,
        width:    0.0,
        postGain: 1.0,
        hzBoost:  0.0,   // dB, high-shelf presence boost ~3kHz — "Hz cao" = cảm giác to/rõ hơn
    };

    // Giới hạn an toàn cho Hz Boost — trên 12dB dễ gây chói/rè (nghe như
    // tạp âm) dù bản chất là do khuếch đại quá mức 1 dải tần, không phải
    // noise thật. Giữ trong khoảng 0–12dB để "to/rõ" mà vẫn sạch tiếng.
    const HZ_MIN = 0, HZ_MAX = 12;
    function clampHz(v) { return Math.max(HZ_MIN, Math.min(HZ_MAX, v)); }

    const VP = {
        pitchSemitones: 0,
        enabled: false,
    };

    const EP = {
        enabled: false,
        echoDelay: 0.18,
        echoFeedback: 0.55,
        echoMix: 0.5,
        rumble: 0.0,
        grind: 0.0,
        noiseType: 'off', // off | white | pink | hum | cb | phone | tunnel | broken
    };

    const DELAY_SPEECH = {
        enabled: false,
        delayAmount: 0.15, // 0 to 1 second
    };

    // ── CFG FILE STATE ──
    // Khi active=true: tắt toàn bộ worklet hook, chỉ chạy chuỗi BiquadFilter
    // được parse từ file .txt (định dạng Equalizer APO / FabFilter Pro-Q).
    const CFG_STATE = {
        active: false,
        name: '',
        filters: [],       // APO EQ filters [{type, freq, gain, Q}]
        format: 'apo',     // 'apo' | 'bufmic'
        bufMicParams: null,// parsed P params từ bufmic script
        compressor: null,  // { threshold, ratio, attack, release, knee } — từ VST Compressor/Expander nếu có
        preampDb: 0,        // Preamp: X dB — bù/chỉnh gain tổng trước EQ (dòng APO chuẩn)
        spatialOps: [],     // [{kind,label,...}] — cho format 'spatial' (Psypan/Haas/Wider ops theo thứ tự file)
        eqFilters: [],      // [{type,freq,gain,Q}] — EQ bands trong file spatial (basiQ / APO Filter)
        preGain: 4.0       // GainNode trước chain — user-controlled
    };

    // ── Noise-gate worklet cho BufMic chain ──
    const NOISE_GATE_WORKLET = `
        class GateNodeCfg extends AudioWorkletProcessor {
            static get parameterDescriptors() {
                return [{ name: 'threshold', defaultValue: 0.01, minValue: 0, maxValue: 1 }];
            }
            process(inputs, outputs, parameters) {
                const inp = inputs[0], out = outputs[0];
                const thr = parameters.threshold[0];
                if (!inp || !inp.length) return true;
                for (let c = 0; c < out.length; c++) {
                    const ic = inp[c] || inp[0];
                    for (let i = 0; i < out[c].length; i++) {
                        const v = ic[i];
                        out[c][i] = Math.abs(v) < thr ? 0 : v;
                    }
                }
                return true;
            }
        }
        registerProcessor('noise-gate-cfg', GateNodeCfg);
    `;
    let _noiseGateReady = false;

    async function ensureNoiseGate() {
        if (_noiseGateReady || !_ctx) return;
        try {
            const blob = new Blob([NOISE_GATE_WORKLET], { type: 'application/javascript' });
            await _ctx.audioWorklet.addModule(URL.createObjectURL(blob));
            _noiseGateReady = true;
        } catch(e) { /* fallback: skip gate */ }
    }

    // Auto-detect format từ nội dung file
    function detectCfgFormat(text) {
        if (/const\s+P\s*=\s*\{/.test(text) && /noiseGate|compThresh|highpass/.test(text)) return 'bufmic';
        // Spatial/pan: Psypan, GFM_Psypan, QuickHaas, Panipulator — kể cả dòng bị comment
        if (/(?:#\s*)?VSTPlugin:\s+Library\s+"?(?:GFM_)?Psypan/im.test(text)) return 'spatial';
        if (/(?:#\s*)?VSTPlugin:\s+Library\s+"?QuickHaas/im.test(text)) return 'spatial';
        if (/(?:#\s*)?VSTPlugin:\s+Library\s+"?Panipulator/im.test(text)) return 'spatial';
        if (/^Filter:\s+ON\s+(PK|LP|HP|LPQ|HPQ|LS|LSC|HS|HSC|NO|BP|AP)\b/im.test(text)) return 'apo';
        if (/^VSTPlugin:\s+Library/im.test(text)) return 'apo';
        if (/^Preamp:\s*[-\d.]+\s*dB/im.test(text)) return 'apo';
        return null;
    }

    // Parse định dạng Spatial/Pan Config (Psypan, GFM_Psypan, QuickHaas, Wider, Panipulator, basiQ)
    // Lấy TẤT CẢ dòng, kể cả dòng bị comment (#) — đây là yêu cầu: build hết
    function parseSpatialCfg(text) {
        const VST_RE    = /(?:#\s*)?VSTPlugin:\s+Library\s+"?([^"\s]+)"?\s+(.*)/i;
        const PSYPAN_RE = /width\s+([\d.]+)\s+pan\s+([\d.]+)\s+x-itd\s+(\d)/i;
        const CHUNK_RE  = /ChunkData\s+"([A-Za-z0-9+/=]+)"/i;

        // Kết quả: danh sách operation theo thứ tự file
        const ops = [];   // { kind, ...params }
        let preampDb = 0;
        let eqFilters = [];   // basiQ / APO Filter dòng thường vẫn được parse
        let compressor = null;

        function b64ToBytes(b64) {
            const raw = atob(b64);
            const u8  = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
            return u8;
        }
        function f32le(u8, off) {
            if (off + 4 > u8.length) return null;
            return new DataView(u8.buffer).getFloat32(off, true);
        }
        function decodeHaas(b64) {
            try {
                const u8  = b64ToBytes(b64);
                const xml = new TextDecoder().decode(u8.slice(8)).replace(/\0/g, '');
                const m   = xml.match(/hdelayf="([-\d.]+)"/);
                return m ? parseFloat(m[1]) : null;
            } catch(e) { return null; }
        }
        function decodeWider(b64) {
            try { return f32le(b64ToBytes(b64), 0) || 0; } catch(e) { return 0; }
        }
        function decodeBasiQ(b64) {
            try {
                const u8 = b64ToBytes(b64);
                const FREQS = [100, 500, 2000, 10000];
                const TYPES = ['lowshelf','peaking','peaking','highshelf'];
                const filters = [];
                for (let i = 0; i < 4; i++) {
                    const gRaw = f32le(u8, 40 + i * 4);
                    if (gRaw === null) continue;
                    const gainDb = (gRaw - 0.5) * 2 * 12;
                    if (Math.abs(gainDb) < 0.05) continue;
                    filters.push({ type: TYPES[i], freq: FREQS[i], gain: Math.round(gainDb*10)/10, Q: 0.707 });
                }
                return filters;
            } catch(e) { return []; }
        }

        // Preamp line
        const preM = text.match(/^Preamp:\s*([-\d.]+)\s*dB/im);
        if (preM) preampDb = parseFloat(preM[1]);

        for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // APO Filter lines (nếu mix với EQ)
            const fmQ  = trimmed.match(/^(?:#\s*)?Filter:\s+ON\s+(\w+)\s+Fc\s+([\d.]+)\s+Hz\s+Gain\s+([-\d.]+)\s+dB\s+Q\s+([\d.]+)/i);
            const fmBW = trimmed.match(/^(?:#\s*)?Filter:\s+ON\s+(\w+)\s+Fc\s+([\d.]+)\s+Hz\s+Gain\s+([-\d.]+)\s+dB\s+BW\s+Oct\s+([\d.]+)/i);
            if (fmQ || fmBW) {
                const fm = fmQ || fmBW;
                const tmap = {PK:'peaking',HSC:'highshelf',LSC:'lowshelf',HS:'highshelf',LS:'lowshelf',LP:'lowpass',HP:'highpass',NO:'notch',BP:'bandpass',AP:'allpass'};
                const wt = tmap[fm[1].toUpperCase()];
                if (wt) eqFilters.push({ type:wt, freq:parseFloat(fm[2]), gain:parseFloat(fm[3]),
                    Q: fmQ ? parseFloat(fm[4]) : 1/(2*Math.sinh(Math.LN2/2*parseFloat(fm[4]))) });
                continue;
            }

            const vm = trimmed.match(VST_RE);
            if (!vm) continue;
            const lib  = vm[1].replace(/\\/g, '/').split('/').pop().toLowerCase();
            const rest = vm[2];

            // ── Psypan / GFM_Psypan ──
            if (lib.includes('psypan')) {
                const pm = rest.match(PSYPAN_RE);
                if (pm) {
                    const width = parseFloat(pm[1]);   // 0..1
                    const pan   = parseFloat(pm[2]);   // 0..1
                    const itd   = parseInt(pm[3]);
                    // pan 0..1 → StereoPannerNode -1..+1
                    const panVal = (pan - 0.5) * 2;
                    ops.push({ kind:'pan', panVal, width, itd, label:`Psypan pan=${(panVal*100).toFixed(1)} width=${(width*100).toFixed(0)}%` });
                }
                continue;
            }

            // ── QuickHaas ── Haas delay: delay>0 = right channel, <0 = left channel
            if (lib.includes('quickhaas') || lib.includes('haas')) {
                const cm = rest.match(CHUNK_RE);
                if (cm) {
                    const delayS = decodeHaas(cm[1]);
                    if (delayS !== null) {
                        ops.push({ kind:'haas', delayS, label:`Haas ${(delayS*1000).toFixed(2)}ms` });
                    }
                }
                continue;
            }

            // ── Wider ──
            if (lib.includes('wider') && !lib.includes('panipulator')) {
                const cm = rest.match(CHUNK_RE);
                if (cm) {
                    const w = decodeWider(cm[1]);
                    ops.push({ kind:'wider', width: w, label:`Wider ${(w*100).toFixed(1)}%` });
                }
                continue;
            }

            // ── basiQ (có thể xuất hiện trong file spatial như 1m2) ──
            if (lib.includes('basiq')) {
                const cm = rest.match(CHUNK_RE);
                if (cm) {
                    const bands = decodeBasiQ(cm[1]);
                    eqFilters.push(...bands);
                }
                continue;
            }

            // ── Panipulator / VUMTdeluxe / Effector / ReverbSolo → ghi nhận nhưng bỏ qua (proprietary) ──
            if (lib.includes('panipulator') || lib.includes('vumt') || lib.includes('effector') || lib.includes('reverb')) {
                ops.push({ kind:'skip', label:`[skip] ${lib}` });
                continue;
            }
        }

        return { ops, eqFilters, preampDb, compressor };
    }

    // Parse định dạng APO Equalizer:
    //   Filter: ON PK  Fc 1200 Hz Gain 15.8 dB Q 42.8
    //   Filter: ON HSC Fc 16500 Hz Gain 12.5 dB Q 0.4196
    //   Filter: ON LSC Fc 28    Hz Gain  9.2 dB Q 0.707
    // VSTPlugin / ChunkData bị bỏ qua (browser không chạy VST).
    function parseCfgText(text) {
        // Bảng ánh xạ đầy đủ loại filter của Equalizer APO sang BiquadFilterNode.type
        // PK=peaking, LP/HP=lowpass/highpass (12dB/oct), LPQ/HPQ=lowpass/highpass có Q riêng,
        // LS/LSC=lowshelf, HS/HSC=highshelf, NO=notch, BP=bandpass, AP=allpass
        const typeMap = {
            PK:  'peaking',
            LP:  'lowpass',  LPQ: 'lowpass',
            HP:  'highpass', HPQ: 'highpass',
            LS:  'lowshelf', LSC: 'lowshelf',
            HS:  'highshelf',HSC: 'highshelf',
            NO:  'notch',
            BP:  'bandpass',
            AP:  'allpass',
        };
        // Loại filter không có tham số Gain trong cú pháp APO (LP/HP/BP/NO/AP dùng Fc [+ Q]) —
        // BiquadFilterNode vẫn cần field gain nhưng giá trị bị bỏ qua với các type này.
        const NO_GAIN_TYPES = new Set(['LP', 'HP', 'LPQ', 'HPQ', 'NO', 'BP', 'AP']);

        const filters = [];
        let compressor = null;
        let preampDb = 0;

        // Chuyển bandwidth (octave) sang Q — công thức chuẩn RBJ cookbook.
        // Q = 1 / (2*sinh(ln(2)/2 * BW))
        function bwToQ(bwOct) {
            const v = 2 * Math.sinh(Math.LN2 / 2 * bwOct);
            return v > 0 ? 1 / v : 0.707;
        }

        // ── 0) Dòng "Preamp: X dB" — APO chuẩn dùng để bù/chỉnh gain tổng trước EQ ──
        const preampMatch = text.match(/^Preamp:\s*([-\d.]+)\s*dB/im);
        if (preampMatch) preampDb = parseFloat(preampMatch[1]);

        // ── 1) Dòng "Filter: ON ..." — hỗ trợ Q, BW Oct, và filter không-gain (LP/HP/BP/NO/AP) ──
        for (const line of text.split('\n')) {
            // Dạng có Gain (PK, LS/LSC, HS/HSC): Filter: ON PK Fc 1200 Hz Gain 6 dB Q 1.4
            const mGainQ = line.match(
                /^Filter:\s+ON\s+(\w+)\s+Fc\s+([\d.]+)\s+Hz\s+Gain\s+([-\d.]+)\s+dB\s+Q\s+([\d.]+)/i
            );
            const mGainBW = line.match(
                /^Filter:\s+ON\s+(\w+)\s+Fc\s+([\d.]+)\s+Hz\s+Gain\s+([-\d.]+)\s+dB\s+BW\s+Oct\s+([\d.]+)/i
            );
            // Dạng không Gain (LP, HP, NO, BP, AP): Filter: ON HP Fc 80 Hz Q 0.707   (Q có thể vắng mặt)
            const mNoGainQ = line.match(
                /^Filter:\s+ON\s+(LP|HP|LPQ|HPQ|NO|BP|AP)\s+Fc\s+([\d.]+)\s+Hz(?:\s+Q\s+([\d.]+))?/i
            );

            if (mGainQ || mGainBW) {
                const m = mGainQ || mGainBW;
                const key = m[1].toUpperCase();
                const webType = typeMap[key];
                if (webType) filters.push({
                    type: webType,
                    freq: parseFloat(m[2]),
                    gain: parseFloat(m[3]),
                    Q:    mGainQ ? parseFloat(m[4]) : bwToQ(parseFloat(m[4]))
                });
            } else if (mNoGainQ) {
                const key = mNoGainQ[1].toUpperCase();
                const webType = typeMap[key];
                if (webType) filters.push({
                    type: webType,
                    freq: parseFloat(mNoGainQ[2]),
                    gain: 0,
                    Q:    mNoGainQ[3] ? parseFloat(mNoGainQ[3]) : 0.707
                });
            }
        }

        // ── 2) VSTPlugin: Library <name>.dll ChunkData "<base64>" — auto-decode EQ/dynamics plugin thường gặp ──
        const vstLineRe = /^VSTPlugin:\s+Library\s+"?([^"\s]+)"?\s+ChunkData\s+"([A-Za-z0-9+/=]+)"/i;
        for (const line of text.split('\n')) {
            const m = line.match(vstLineRe);
            if (!m) continue;
            const libName = m[1].toLowerCase();
            let raw;
            try { raw = atob(m[2]); } catch(e) { continue; }
            const bytes = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
            const dv = new DataView(bytes.buffer);
            function f32(off) { return off + 4 <= bytes.length ? dv.getFloat32(off, true) : null; }

            // 7Q.dll — 7-band peaking EQ, gain floats @ byte16 (7×f32), Q @ byte76, enable @ byte104
            if (libName.includes('7q')) {
                const FREQS_7Q = [125, 250, 500, 1000, 2000, 4000, 8000];
                for (let i = 0; i < 7; i++) {
                    const gRaw = f32(16 + i * 4);
                    const qRaw = f32(76 + i * 4);
                    const enRaw = f32(104 + i * 4);
                    if (gRaw === null || enRaw === null || enRaw < 0.5) continue; // band tắt → bỏ qua
                    const gainDb = (gRaw - 0.5) * 2 * 12; // normalized 0..1 → ±12dB
                    filters.push({
                        type: 'peaking',
                        freq: FREQS_7Q[i],
                        gain: Math.round(gainDb * 10) / 10,
                        Q: qRaw !== null ? qRaw : 1.0
                    });
                }
            }

            // basiQ.dll — 4-band (Low shelf/Peak/Peak/High shelf), gain floats @ byte40 (4×f32)
            if (libName.includes('basiq')) {
                const BASIQ_FREQS = [100, 500, 2000, 10000];
                const BASIQ_TYPES = ['lowshelf', 'peaking', 'peaking', 'highshelf'];
                for (let i = 0; i < 4; i++) {
                    const gRaw = f32(40 + i * 4);
                    if (gRaw === null) continue;
                    const gainDb = (gRaw - 0.5) * 2 * 12;
                    if (Math.abs(gainDb) < 0.05) continue; // ~flat → bỏ qua để đỡ rác band
                    filters.push({
                        type: BASIQ_TYPES[i],
                        freq: BASIQ_FREQS[i],
                        gain: Math.round(gainDb * 10) / 10,
                        Q: 0.707
                    });
                }
            }

            // Deft Compressor.dll / ATKExpander*.dll — không decode chi tiết chunk nén được (proprietary),
            // nhưng đánh dấu có compressor/expander trong chain để build DynamicsCompressorNode với giá trị an toàn mặc định.
            if (libName.includes('compressor') || libName.includes('deft')) {
                if (!compressor) compressor = { threshold: -24, ratio: 4, attack: 0.003, release: 0.25, knee: 6 };
            }
        }

        // ── 3) VSTPlugin dòng tham số text-based (không phải ChunkData base64), vd:
        //    "VSTPlugin: Library ATKExpander_x64.dll Attack 1 Release 1 Threshold 1 Softness 1 Slope 1"
        for (const line of text.split('\n')) {
            if (!/ATKExpander/i.test(line)) continue;
            const mAtk = line.match(/Attack\s+([\d.]+)/i);
            const mRel = line.match(/Release\s+([\d.]+)/i);
            const mThr = line.match(/Threshold\s+([\d.]+)/i);
            if (!compressor) compressor = { threshold: -24, ratio: 3, attack: 0.01, release: 0.2, knee: 4 };
            // Threshold VST thường normalized 0..1 → map sang dB range -60..0
            if (mThr) compressor.threshold = -60 + parseFloat(mThr[1]) * 60;
            if (mAtk) compressor.attack  = Math.max(0.001, parseFloat(mAtk[1]) / 100);
            if (mRel) compressor.release = Math.max(0.01, parseFloat(mRel[1]) / 4);
        }

        return { filters, compressor, preampDb };
    }

    // Parse định dạng BufMic — đọc const P = { ... } block
    // Trả về object params hoặc null nếu không tìm thấy.
    function parseBufMic(text) {
        // Strip script tags nếu có
        text = text.replace(/<\/?script[^>]*>/gi, '');
        const blockMatch = text.match(/const\s+P\s*=\s*\{([^}]+)\}/);
        if (!blockMatch) return null;
        const defaults = {
            gain: 1.0, noiseGate: 0.01, compThresh: -24, compRatio: 4,
            compAttack: 0.003, compRelease: 0.25, highpass: 80, lowpass: 16000
        };
        const block = blockMatch[1];
        for (const line of block.split('\n')) {
            const m = line.match(/(\w+)\s*:\s*([-\d.]+)/);
            if (m && m[1] in defaults) defaults[m[1]] = parseFloat(m[2]);
        }
        return defaults;
    }

    /* ── WORKLET 1: Crusher ── */
    const WORKLET_CRUSHER = `
class KhangEngine extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            { name:'preGain',  defaultValue:1,   minValue:0.001, maxValue:99999 },
            { name:'drive',    defaultValue:0,   minValue:0,     maxValue:1    },
            { name:'crush',    defaultValue:0,   minValue:0,     maxValue:1    },
            { name:'width',    defaultValue:0,   minValue:0,     maxValue:2    },
            { name:'postGain', defaultValue:1,   minValue:0.001, maxValue:99999 }
        ];
    }
    constructor() { super(); this._limL=1; this._limR=1; }
    _sat(x,k){ if(k<0.001)return x; var d=k*20; return Math.atan(x*d)/Math.atan(d); }
    _hardclip(x,th){ return x>th?th:x<-th?-th:x; }
    _limit(x,env){ var abs=Math.abs(x); if(abs>1.0)env=Math.max(env,abs); env*=0.9998; if(env<1)env=1; return{y:x/env,env:env}; }
    process(inputs,outputs,params){
        var inp=inputs[0],out=outputs[0];
        if(!inp||inp.length===0){ for(var c=0;c<out.length;c++) for(var i=0;i<out[c].length;i++) out[c][i]=(Math.random()-0.5)*0.000001; return true; }
        var preGain=params.preGain[0],drive=params.drive[0],crush=params.crush[0],width=params.width[0],postGain=params.postGain[0];
        for(var i=0;i<inp[0].length;i++){
            var L=inp[0][i]*preGain;
            var R=(inp[1]?inp[1][i]:inp[0][i])*preGain;
            L=this._sat(L,drive); R=this._sat(R,drive);
            if(crush>0){ var th=Math.max(0.001,1.0-crush*0.98); L=this._hardclip(L,th)/th; R=this._hardclip(R,th)/th; L=this._sat(L,drive*0.5+0.3); R=this._sat(R,drive*0.5+0.3); }
            if(width>0){ var mid=(L+R)*0.5,side=(L-R)*0.5*(1+width*2); L=mid+side; R=mid-side; }
            var rL=this._limit(L,this._limL); L=rL.y; this._limL=rL.env;
            var rR=this._limit(R,this._limR); R=rR.y; this._limR=rR.env;
            L*=postGain; R*=postGain;
            // Clean mode check: when drive & crush are 0, maintain 100% crystal clean signal without saturation distortion
            if (drive < 0.001 && crush < 0.001) {
                // Smooth ceiling clipping protection
                if (L > 0.99) L = 0.99; else if (L < -0.99) L = -0.99;
                if (R > 0.99) R = 0.99; else if (R < -0.99) R = -0.99;
            } else {
                L=this._sat(L,0.35)*0.98; R=this._sat(R,0.35)*0.98;
            }
            if(!isFinite(L))L=0; if(!isFinite(R))R=0;
            out[0][i]=L; if(out[1])out[1][i]=R;
        }
        return true;
    }
}
registerProcessor('khang-engine', KhangEngine);
`;

    /* ── WORKLET 2: Pitch Shifter ── */
    const WORKLET_PITCH = `
class PitchShifter extends AudioWorkletProcessor {
    static get parameterDescriptors() { return [{ name:'pitch', defaultValue:1.0, minValue:0.25, maxValue:4.0 }]; }
    constructor() { super(); this._bufSize=8192; this._buf=new Float32Array(8192); this._writePos=0; this._readPos=0.0; }
    process(inputs,outputs,params){
        var inp=inputs[0],out=outputs[0];
        if(!inp||!inp[0]||!out||!out[0]) return true;
        var pitch=params.pitch[0],src=inp[0],dst=out[0],len=src.length,bufSize=this._bufSize;
        if(Math.abs(pitch-1.0)<0.02){ for(var i=0;i<len;i++) dst[i]=src[i]; if(out[1]) for(var i=0;i<len;i++) out[1][i]=src[i]; return true; }
        for(var i=0;i<len;i++){
            this._buf[this._writePos % bufSize]=src[i]; this._writePos++;
            var ri=Math.floor(this._readPos)%bufSize,ri2=(ri+1)%bufSize,frac=this._readPos-Math.floor(this._readPos);
            dst[i]=this._buf[ri]*(1-frac)+this._buf[ri2]*frac;
            this._readPos+=pitch; if(this._readPos>=bufSize*2) this._readPos-=bufSize;
        }
        if(out[1]) for(var i=0;i<len;i++) out[1][i]=dst[i];
        return true;
    }
}
registerProcessor('pitch-shifter', PitchShifter);
`;

    /* ── WORKLET 2b: DELAY SPEECH ── */
    const WORKLET_DELAY_SPEECH = `
class DelaySpeechProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            { name:'delayAmount', defaultValue:0.15, minValue:0.01, maxValue:1.0 }
        ];
    }
    constructor() {
        super();
        this._bufSize = Math.ceil(sampleRate * 1.2); // ~1.2s buffer theo sampleRate thật, đủ trần cho delayAmount max 1.0s
        this._bufL = new Float32Array(this._bufSize);
        this._bufR = new Float32Array(this._bufSize);
        this._writePos = 0;
    }
    process(inputs, outputs, params) {
        var inp = inputs[0], out = outputs[0];
        if (!inp || inp.length === 0) return true;
        
        var delay = params.delayAmount[0];
        var sr = sampleRate; // dùng sampleRate thật của AudioContext, không hard-code — tránh lệch delay trên máy chạy 44.1kHz
        var delaySamples = Math.min(Math.floor(delay * sr), this._bufSize - 1);
        if (delaySamples < 1) delaySamples = 1;
        
        var srcL = inp[0], srcR = inp[1] ? inp[1] : inp[0];
        var dstL = out[0], dstR = out[1] ? out[1] : dstL;
        var len = srcL.length;
        var bufSize = this._bufSize;
        
        for (var i = 0; i < len; i++) {
            // Write to delay buffer
            this._bufL[this._writePos % bufSize] = srcL[i];
            this._bufR[this._writePos % bufSize] = srcR[i];
            
            // Read from delay buffer
            var readPos = (this._writePos - delaySamples + bufSize) % bufSize;
            dstL[i] = this._bufL[readPos];
            if (dstR) dstR[i] = this._bufR[readPos];
            
            this._writePos = (this._writePos + 1) % bufSize;
        }
        
        return true;
    }
}
registerProcessor('delay-speech', DelaySpeechProcessor);
`;

    /* ── WORKLET 3: ECHO + RUMBLE + GRIND + NOISE ── */
    const WORKLET_ECHO = `
class EchoRumbleEngine extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            { name:'echoDelay',    defaultValue:0.18, minValue:0.01, maxValue:2.0   },
            { name:'echoFeedback', defaultValue:0.55, minValue:0,    maxValue:0.999 },
            { name:'echoMix',      defaultValue:0.5,  minValue:0,    maxValue:1.0   },
            { name:'rumble',       defaultValue:0,    minValue:0,    maxValue:1.0   },
            { name:'grind',        defaultValue:0,    minValue:0,    maxValue:1.0   },
            { name:'noiseAmt',     defaultValue:0,    minValue:0,    maxValue:1.0   },
            { name:'noiseType',    defaultValue:0,    minValue:0,    maxValue:7     },
        ];
    }
    constructor() {
        super();
        // delay buffer: 2s max @ 48kHz
        this._bufSize = 96000;
        this._bufL = new Float32Array(this._bufSize);
        this._bufR = new Float32Array(this._bufSize);
        this._pos  = 0;
        // rumble LFO state
        this._lfoPhase = 0;
        // pink noise state
        this._pink = [0,0,0,0,0,0,0];
        // hum phase
        this._humPhase = 0;
        // grind history
        this._prevL = 0; this._prevR = 0;
        // broken stutter
        this._stutterCount = 0; this._stutterLen = 0; this._holdL = 0; this._holdR = 0;
    }
    _pinkNoise(){
        // Paul Kellet algorithm
        var w = (Math.random()*2-1);
        this._pink[0] = 0.99886*this._pink[0] + w*0.0555179;
        this._pink[1] = 0.99332*this._pink[1] + w*0.0750759;
        this._pink[2] = 0.96900*this._pink[2] + w*0.1538520;
        this._pink[3] = 0.86650*this._pink[3] + w*0.3104856;
        this._pink[4] = 0.55000*this._pink[4] + w*0.5329522;
        this._pink[5] =-0.7616*this._pink[5]  - w*0.0168980;
        return (this._pink[0]+this._pink[1]+this._pink[2]+this._pink[3]+this._pink[4]+this._pink[5]+this._pink[6]+w*0.5362)*0.11;
    }
    _getNoise(type, sampleRate){
        // 0=off,1=white,2=pink,3=hum60,4=cb(cheap mic buzz),5=phone,6=tunnel,7=broken
        switch(Math.round(type)){
            case 0: return 0;
            case 1: return (Math.random()-0.5)*2;
            case 2: return this._pinkNoise();
            case 3: // 60Hz hum + harmonics
                this._humPhase += (2*Math.PI*60)/sampleRate;
                if(this._humPhase>2*Math.PI) this._humPhase-=2*Math.PI;
                return Math.sin(this._humPhase)*0.7 + Math.sin(this._humPhase*2)*0.3 + Math.sin(this._humPhase*3)*0.15;
            case 4: // cheap condenser buzz: 50Hz hum + white
                this._humPhase += (2*Math.PI*50)/sampleRate;
                if(this._humPhase>2*Math.PI) this._humPhase-=2*Math.PI;
                return Math.sin(this._humPhase)*0.5 + (Math.random()-0.5)*0.6 + this._pinkNoise()*0.4;
            case 5: // phone/landline: bandpass-ish (simulate with harmonics only mid)
                this._humPhase += (2*Math.PI*300)/sampleRate;
                if(this._humPhase>2*Math.PI) this._humPhase-=2*Math.PI;
                return (Math.sin(this._humPhase)*0.4 + this._pinkNoise()*0.35 + (Math.random()-0.5)*0.25);
            case 6: // tunnel/stadium reverb rumble: deep LFO + pink
                this._lfoPhase += (2*Math.PI*0.3)/sampleRate;
                if(this._lfoPhase>2*Math.PI) this._lfoPhase-=2*Math.PI;
                return Math.sin(this._lfoPhase)*0.5 * (1 + this._pinkNoise()*0.4) + (Math.random()-0.5)*0.08;
            case 7: // broken mic: random stutter hold + crackle
                if(this._stutterCount<=0){
                    this._stutterLen = Math.floor(Math.random()*800+20);
                    this._stutterCount = this._stutterLen;
                    this._holdL = (Math.random()-0.5)*1.2;
                }
                this._stutterCount--;
                return this._holdL + (Math.random()-0.5)*0.3;
            default: return 0;
        }
    }
    process(inputs,outputs,params){
        var inp=inputs[0],out=outputs[0];
        var sr = sampleRate || 48000;
        var delay    = params.echoDelay[0];
        var feedback = params.echoFeedback[0];
        var mix      = params.echoMix[0];
        var rumble   = params.rumble[0];
        var grind    = params.grind[0];
        var noiseAmt = params.noiseAmt[0];
        var noiseType= params.noiseType[0];

        var delaySamples = Math.min(Math.floor(delay * sr), this._bufSize - 1);
        if(delaySamples < 1) delaySamples = 1;

        var hasInput = inp && inp[0] && inp[0].length > 0;
        var frameLen = hasInput ? inp[0].length : (out[0]?out[0].length:128);

        for(var i=0; i<frameLen; i++){
            var inL = hasInput ? inp[0][i] : 0;
            var inR = hasInput ? (inp[1]?inp[1][i]:inp[0][i]) : 0;

            // --- Rumble: low-freq LFO tremolo on input ---
            if(rumble > 0){
                this._lfoPhase += (2*Math.PI*2.5*rumble)/sr; // 0-2.5Hz
                if(this._lfoPhase>2*Math.PI) this._lfoPhase-=2*Math.PI;
                var lfo = 1.0 + Math.sin(this._lfoPhase)*rumble*4.0
                              + Math.sin(this._lfoPhase*3.7)*rumble*2.0;
                inL *= lfo; inR *= lfo;
                // Add sub-frequency thump
                inL += Math.sin(this._lfoPhase*0.5)*rumble*0.6;
                inR += Math.sin(this._lfoPhase*0.5)*rumble*0.6;
            }

            // --- Grind: inter-sample distortion (rè) ---
            if(grind > 0){
                var dL = inL - this._prevL, dR = inR - this._prevR;
                var gAmt = grind * 18;
                inL += Math.tanh(dL*gAmt)*grind*0.9;
                inR += Math.tanh(dR*gAmt)*grind*0.9;
                // Hard fold for maximum rè
                inL = inL > 1.5 ? 1.5 - (inL-1.5) : inL < -1.5 ? -1.5-(inL+1.5) : inL;
                inR = inR > 1.5 ? 1.5 - (inR-1.5) : inR < -1.5 ? -1.5-(inR+1.5) : inR;
                this._prevL = inL; this._prevR = inR;
            }

            // --- Noise injection ---
            if(noiseAmt > 0){
                var n = this._getNoise(noiseType, sr);
                inL += n * noiseAmt;
                inR += n * noiseAmt;
            }

            // --- Echo / vang vọng ---
            var readPos = ((this._pos - delaySamples) + this._bufSize) % this._bufSize;
            var echoL = this._bufL[readPos];
            var echoR = this._bufR[readPos];

            var outL = inL + echoL * mix;
            var outR = inR + echoR * mix;

            // Write into delay buffer with feedback
            this._bufL[this._pos] = inL + echoL * feedback;
            this._bufR[this._pos] = inR + echoR * feedback;
            this._pos = (this._pos + 1) % this._bufSize;

            if(out[0]) out[0][i] = outL;
            if(out[1]) out[1][i] = outR;
        }
        return true;
    }
}
registerProcessor('echo-rumble-engine', EchoRumbleEngine);
`;

    const _NativeCtx = window.AudioContext || window.webkitAudioContext;
    let _ctx = null;
    let _workletReady = false;
    let _initPromise = null;

    // BUGFIX: dùng 1 Promise dùng chung — dù Discord tự tạo AudioContext
    // trước hay extension tạo trước, worklet vẫn LUÔN được load đủ 1 lần
    // trước khi Core.build() được phép chạy tiếp. Trước đây nếu Discord tạo
    // context trước, initCtx() bị return sớm do check "if(_ctx) return"
    // trong khi _ctx đã bị gán tạm bởi KhangAudioContext -> worklet không
    // bao giờ load -> AudioWorkletNode('khang-engine') lỗi -> mic bị bypass
    // hoàn toàn (không qua xử lý gì) -> đây là lý do mic vẫn nhỏ.
    function initCtx() {
        if (_initPromise) return _initPromise;
        if (!_ctx) _ctx = new _NativeCtx({ latencyHint:'interactive' });
        _initPromise = (async () => {
            try {
                var b1 = new Blob([WORKLET_CRUSHER], { type:'application/javascript' });
                await _ctx.audioWorklet.addModule(URL.createObjectURL(b1));
                var b2 = new Blob([WORKLET_PITCH], { type:'application/javascript' });
                await _ctx.audioWorklet.addModule(URL.createObjectURL(b2));
                var b_delay = new Blob([WORKLET_DELAY_SPEECH], { type:'application/javascript' });
                await _ctx.audioWorklet.addModule(URL.createObjectURL(b_delay));
                var b3 = new Blob([WORKLET_ECHO], { type:'application/javascript' });
                await _ctx.audioWorklet.addModule(URL.createObjectURL(b3));
                _workletReady = true;
                UI.badge && UI.badge('READY','#00ff99');
            } catch(e) {
                UI.badge && UI.badge('ERR','#ff4444');
            }
        })();
        return _initPromise;
    }

    class KhangAudioContext extends _NativeCtx {
        constructor(...args) {
            super({ latencyHint:'interactive' });
            if (!_ctx) _ctx = this;
            initCtx();
        }
    }
    try {
        window.AudioContext = KhangAudioContext;
        if (window.webkitAudioContext) window.webkitAudioContext = KhangAudioContext;
    } catch(e) {}

    initCtx().catch(()=>{});

    // Safety net: WebKit (Orion/Safari) có thể giữ AudioContext ở trạng
    // thái 'suspended' cho tới khi có thao tác chạm/click thật sự của
    // người dùng. Nếu bỏ sót, toàn bộ audio graph sẽ câm lặng dù mic vẫn
    // "LIVE" trên UI. Bắt mọi lần tap/click đầu tiên để đảm bảo resume.
    function nudgeResume() {
        if (_ctx && _ctx.state === 'suspended') _ctx.resume().catch(()=>{});
    }
    document.addEventListener('pointerdown', nudgeResume, { passive:true });
    document.addEventListener('keydown', nudgeResume);

    const _nativeGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async function(constraints) {
        let raw;
        try { raw = await _nativeGUM(constraints); }
        catch(e) { UI.badge('MIC ERR','#ff4444'); throw e; }
        try {
            const proc = await Core.build(raw);
            UI.badge('LIVE','#00ff99');
            return proc;
        } catch(e) {
            UI.badge('BYPASS','#ffaa00');
            return raw;
        }
    };

    const Core = {
        node: null,
        pitchNode: null,
        echoNode: null,
        delayNode: null,
        hzFilter: null,
        // ── CFG mode: tham chiếu raw stream + dest để rebuild live ──
        _rawStream: null,
        _dest: null,
        _src:  null,
        cfgEqNodes: [],

        // Ngắt toàn bộ BiquadFilter node của CFG chain
        _disconnectCfgEq() {
            for (const n of this.cfgEqNodes) { try { n.disconnect(); } catch(e){} }
            this.cfgEqNodes = [];
        },

        // Dispatch đến đúng chain builder theo format
        async _buildCfgChain(src, dest) {
            if (CFG_STATE.format === 'bufmic' && CFG_STATE.bufMicParams) {
                await this._buildBufMicChain(src, dest, CFG_STATE.bufMicParams);
            } else if (CFG_STATE.format === 'spatial') {
                this._buildSpatialChain(src, dest);
            } else {
                this._buildApoEqChain(src, dest);
            }
        },

        // ── SPATIAL chain: src → [EQ bands] → [Psypan: panner] → [Haas: splitter+delay] → [Wider: M/S] → dest ──
        // Mỗi op trong CFG_STATE.spatialOps được chain nối tiếp theo đúng thứ tự file gốc.
        _buildSpatialChain(src, dest) {
            try {
                const nodes = [];
                // 1) Preamp + EQ (basiQ / APO Filter nếu có trong file)
                const gainNode = _ctx.createGain();
                const preampLin = Math.pow(10, (CFG_STATE.preampDb || 0) / 20);
                gainNode.gain.value = CFG_STATE.preGain * preampLin;
                nodes.push(gainNode);

                // EQ filters (basiQ / APO mixed)
                const eqNodes = (CFG_STATE.eqFilters || []).map(({ type, freq, gain, Q }) => {
                    const n = _ctx.createBiquadFilter();
                    n.type = type; n.frequency.value = freq;
                    n.gain.value = gain; n.Q.value = Math.min(Q, 30);
                    return n;
                });
                nodes.push(...eqNodes);

                // 2) Process spatial ops in order
                for (const op of (CFG_STATE.spatialOps || [])) {
                    if (op.kind === 'pan') {
                        // StereoPannerNode — clamp panVal to -1..+1
                        const panner = _ctx.createStereoPanner();
                        panner.pan.value = Math.max(-1, Math.min(1, op.panVal));
                        nodes.push(panner);
                        // Width: nếu <1 thì blend mono vào — GainNode pair (M/S)
                        if (op.width < 0.99) {
                            const splitter = _ctx.createChannelSplitter(2);
                            const merger   = _ctx.createChannelMerger(2);
                            const gainL    = _ctx.createGain();
                            const gainR    = _ctx.createGain();
                            // width 0=mono (L+R scaled equal), 1=full stereo
                            const s = op.width;
                            gainL.gain.value = 0.5 + s * 0.5;
                            gainR.gain.value = 0.5 + s * 0.5;
                            splitter.connect(gainL, 0); splitter.connect(gainR, 1);
                            gainL.connect(merger, 0, 0); gainR.connect(merger, 0, 1);
                            nodes.push(splitter, gainL, gainR, merger);
                        }
                    } else if (op.kind === 'haas') {
                        // Haas delay: delayS>0 → right lags (left arrives first = perceived left), <0 → left lags
                        const absDelay = Math.abs(op.delayS);
                        const splitter = _ctx.createChannelSplitter(2);
                        const merger   = _ctx.createChannelMerger(2);
                        const dlyNode  = _ctx.createDelay(0.1);
                        dlyNode.delayTime.value = absDelay;
                        if (op.delayS > 0) {
                            // right channel delayed
                            splitter.connect(merger, 0, 0);   // L direct
                            splitter.connect(dlyNode, 1);
                            dlyNode.connect(merger, 0, 1);    // R delayed
                        } else {
                            // left channel delayed
                            splitter.connect(dlyNode, 0);
                            dlyNode.connect(merger, 0, 0);    // L delayed
                            splitter.connect(merger, 1, 1);   // R direct
                        }
                        nodes.push(splitter, dlyNode, merger);
                    } else if (op.kind === 'wider') {
                        // Mid-Side stereo widening: S = side * width, M unchanged
                        // Using splitter/merger + gain on side channel
                        const w = op.width;
                        if (w > 0.001) {
                            const splitter = _ctx.createChannelSplitter(2);
                            const merger   = _ctx.createChannelMerger(2);
                            const gL = _ctx.createGain(); gL.gain.value = 1 + w;
                            const gR = _ctx.createGain(); gR.gain.value = 1 + w;
                            splitter.connect(gL, 0); splitter.connect(gR, 1);
                            gL.connect(merger, 0, 0); gR.connect(merger, 0, 1);
                            nodes.push(splitter, gL, gR, merger);
                        }
                        // w=0 → mono (pass through unchanged = correct)
                    }
                    // kind==='skip' → bỏ qua
                }

                // Chain tất cả nodes
                let prev = src;
                // Connect linear-connectable nodes (skip splitter/merger middle nodes — already wired internally)
                const LINEAR = ['GainNode', 'BiquadFilterNode', 'StereoPannerNode', 'DelayNode'];
                const connectableNodes = nodes.filter(n => n && n.constructor &&
                    (LINEAR.includes(n.constructor.name) ||
                     n instanceof GainNode || n instanceof BiquadFilterNode ||
                     n instanceof StereoPannerNode || n instanceof DelayNode));

                // Actually connect all directly-connectable: gain, biquad, panner nodes
                // and sub-chains (splitter→...→merger) as blocks
                // Rebuild the pure linear list: gainNode, eqNodes[], then per-op the "entry node" of each sub-chain
                const linearHead = [gainNode, ...eqNodes];
                const opHeads = [];
                for (const op of (CFG_STATE.spatialOps || [])) {
                    if (op.kind === 'pan') {
                        // panner is the last node pushed before potential width splitter
                        // we need to track them — rebuild
                    }
                }

                // Simpler approach: rebuild ordered entry-points
                const chainEntries = [gainNode, ...eqNodes];
                for (const op of (CFG_STATE.spatialOps || [])) {
                    if (op.kind === 'pan') {
                        const panner = _ctx.createStereoPanner();
                        panner.pan.value = Math.max(-1, Math.min(1, op.panVal));
                        chainEntries.push(panner);
                    } else if (op.kind === 'haas') {
                        const absDelay = Math.abs(op.delayS);
                        const spl = _ctx.createChannelSplitter(2);
                        const mrg = _ctx.createChannelMerger(2);
                        const dly = _ctx.createDelay(0.1);
                        dly.delayTime.value = absDelay;
                        if (op.delayS > 0) {
                            spl.connect(mrg, 0, 0); spl.connect(dly, 1); dly.connect(mrg, 0, 1);
                        } else {
                            spl.connect(dly, 0); dly.connect(mrg, 0, 0); spl.connect(mrg, 1, 1);
                        }
                        // entry=spl, exit=mrg — store as pair
                        chainEntries.push({ _isSplitMerge: true, entry: spl, exit: mrg });
                    } else if (op.kind === 'wider') {
                        const w = op.width;
                        if (w > 0.001) {
                            const spl = _ctx.createChannelSplitter(2);
                            const mrg = _ctx.createChannelMerger(2);
                            const gL  = _ctx.createGain(); gL.gain.value = 1 + w;
                            const gR  = _ctx.createGain(); gR.gain.value = 1 + w;
                            spl.connect(gL, 0); spl.connect(gR, 1);
                            gL.connect(mrg, 0, 0); gR.connect(mrg, 0, 1);
                            chainEntries.push({ _isSplitMerge: true, entry: spl, exit: mrg });
                        }
                        // w=0 → skip (mono/no widening needed)
                    }
                }

                // Wire chainEntries in series: prev → entry, and if _isSplitMerge: exit becomes prev
                // Safety limiter cuối chain — Wider (gain lên tới 1+width) và cộng dồn nhiều op dễ vượt 0dBFS
                const limiter = _ctx.createDynamicsCompressor();
                limiter.threshold.value = -1.0;
                limiter.knee.value      = 0;
                limiter.ratio.value     = 20;
                limiter.attack.value    = 0.001;
                limiter.release.value   = 0.05;

                let cur = src;
                const allNodes = [];
                for (const e of chainEntries) {
                    if (e && e._isSplitMerge) {
                        cur.connect(e.entry);
                        cur = e.exit;
                        allNodes.push(e.entry, e.exit);
                    } else if (e) {
                        cur.connect(e);
                        cur = e;
                        allNodes.push(e);
                    }
                }
                cur.connect(limiter);
                limiter.connect(dest);
                allNodes.push(limiter);
                this.cfgEqNodes = allNodes;

                const opSummary = (CFG_STATE.spatialOps || []).map(o => o.label).join(', ');
                logSystem('Spatial chain OK: ' + opSummary + (eqNodes.length ? ' + ' + eqNodes.length + ' EQ bands' : '') + ' + Limiter');
            } catch(e) {
                logSystem('Spatial chain ERR: ' + e.message);
                try { src.connect(dest); } catch(_) {}
            }
        },

        // ── APO EQ chain: src → GainNode(preGain × Preamp) → bq[0] → … → bq[N-1] → [Compressor] → dest ──
        _buildApoEqChain(src, dest) {
            try {
                const gainNode = _ctx.createGain();
                // Preamp: X dB (APO chuẩn) — nhân thêm vào gain người dùng chỉnh, không thay thế
                const preampLin = Math.pow(10, (CFG_STATE.preampDb || 0) / 20);
                gainNode.gain.value = CFG_STATE.preGain * preampLin;

                // Compressor từ file CFG (nếu VST Compressor/Expander được decode) — tùy chọn, đặt trước limiter
                let compNode = null;
                if (CFG_STATE.compressor) {
                    const c = CFG_STATE.compressor;
                    compNode = _ctx.createDynamicsCompressor();
                    compNode.threshold.value = c.threshold;
                    compNode.ratio.value     = c.ratio;
                    compNode.attack.value    = c.attack;
                    compNode.release.value   = c.release;
                    compNode.knee.value      = c.knee;
                }

                // Safety limiter — LUÔN có, bất kể file CFG có khai báo compressor hay không.
                // Gain slider lên tới 100x + Preamp + nhiều band cộng dồn dễ vượt 0dBFS → clip cứng → rè/vỡ tiếng.
                // Đặt ở cuối cùng trước dest để chặn clipping mà không đổi màu âm EQ phía trước.
                const limiter = _ctx.createDynamicsCompressor();
                limiter.threshold.value = -1.0;   // chỉ nén khi gần chạm 0dBFS
                limiter.knee.value      = 0;      // hard knee — limiter thật, không nén sớm làm đục tiếng
                limiter.ratio.value     = 20;      // gần như brickwall
                limiter.attack.value    = 0.001;   // bắt kịp transient ngay, tránh vỡ tiếng đột ngột
                limiter.release.value   = 0.05;

                if (!CFG_STATE.filters.length) {
                    src.connect(gainNode);
                    if (compNode) { gainNode.connect(compNode); compNode.connect(limiter); }
                    else { gainNode.connect(limiter); }
                    limiter.connect(dest);
                    this.cfgEqNodes = compNode ? [gainNode, compNode, limiter] : [gainNode, limiter];
                    logSystem('APO EQ chain: gain=' + CFG_STATE.preGain + 'x, 0 band' + (compNode ? ' + Compressor' : '') + ' + Limiter (bypass EQ)');
                    return;
                }
                const eqNodes = CFG_STATE.filters.map(({ type, freq, gain, Q }) => {
                    const n = _ctx.createBiquadFilter();
                    n.type = type; n.frequency.value = freq;
                    n.gain.value = gain; n.Q.value = Math.min(Q, 30);
                    return n;
                });
                src.connect(gainNode); gainNode.connect(eqNodes[0]);
                for (let i = 0; i < eqNodes.length - 1; i++) eqNodes[i].connect(eqNodes[i + 1]);
                const lastEq = eqNodes[eqNodes.length - 1];
                if (compNode) { lastEq.connect(compNode); compNode.connect(limiter); }
                else { lastEq.connect(limiter); }
                limiter.connect(dest);
                this.cfgEqNodes = compNode ? [gainNode, ...eqNodes, compNode, limiter] : [gainNode, ...eqNodes, limiter];
                logSystem('APO EQ chain OK: gain=' + CFG_STATE.preGain + 'x, ' + eqNodes.length + ' band' + (compNode ? ' + Compressor' : '') + ' + Limiter');
            } catch(e) {
                logSystem('APO EQ chain ERR: ' + e.message + ' — fallback bypass');
                try { src.connect(dest); } catch(_) {}
            }
        },

        // ── BufMic chain: src → preGain → hp → lp → [gate] → comp → gain → dest ──
        async _buildBufMicChain(src, dest, p) {
            try {
                await ensureNoiseGate();

                const preGain = _ctx.createGain();
                preGain.gain.value = CFG_STATE.preGain;

                const hp = _ctx.createBiquadFilter();
                hp.type = 'highpass'; hp.frequency.value = p.highpass; hp.Q.value = 0.7;

                const lp = _ctx.createBiquadFilter();
                lp.type = 'lowpass'; lp.frequency.value = p.lowpass; lp.Q.value = 0.7;

                const comp = _ctx.createDynamicsCompressor();
                comp.threshold.value = p.compThresh;
                comp.ratio.value     = p.compRatio;
                comp.attack.value    = p.compAttack;
                comp.release.value   = p.compRelease;
                comp.knee.value      = 6;

                const gainNode = _ctx.createGain();
                gainNode.gain.value = p.gain * CFG_STATE.preGain;

                let gateNode = null;
                if (_noiseGateReady) {
                    try {
                        gateNode = new AudioWorkletNode(_ctx, 'noise-gate-cfg');
                        gateNode.parameters.get('threshold').value = p.noiseGate;
                    } catch(e) { gateNode = null; }
                }

                // chain: src → preGain → hp → lp → [gate →] comp → gain → dest
                src.connect(preGain);
                preGain.connect(hp);
                hp.connect(lp);
                if (gateNode) { lp.connect(gateNode); gateNode.connect(comp); }
                else { lp.connect(comp); }
                comp.connect(gainNode);
                gainNode.connect(dest);

                const nodes = [preGain, hp, lp, comp, gainNode];
                if (gateNode) nodes.push(gateNode);
                this.cfgEqNodes = nodes;
                logSystem('BufMic chain OK: hp=' + p.highpass + 'Hz lp=' + p.lowpass + 'Hz comp=' + p.compThresh + 'dB gate=' + (_noiseGateReady ? 'ON' : 'SKIP'));
            } catch(e) {
                logSystem('BufMic chain ERR: ' + e.message + ' — fallback bypass');
                try { src.connect(dest); } catch(_) {}
            }
        },

        // Rebuild chain mà không cần người dùng rời/vào lại voice.
        // Reuse _dest đang được Discord giữ — chỉ thay nội bộ.
        // statusEl là element cfg-status truyền vào trực tiếp — tránh getElementById
        // bị null trên iOS Safari khi gọi từ bên trong async callback lồng nhau.
        async rebuildChain(statusEl) {
            // Resolve statusEl nếu không được truyền vào
            if (!statusEl) statusEl = document.getElementById('cfg-status');

            if (!this._rawStream || !this._dest || !_ctx) {
                if (statusEl && CFG_STATE.active) {
                    statusEl.innerText = '⚠ Chưa vào voice channel. Tham gia voice để áp dụng CFG.';
                }
                return;
            }

            try {
                try { this.node       && this.node.disconnect();       } catch(e){}
                try { this.pitchNode  && this.pitchNode.disconnect();  } catch(e){}
                try { this.echoNode   && this.echoNode.disconnect();   } catch(e){}
                try { this.delayNode  && this.delayNode.disconnect();  } catch(e){}
                try { this.hzFilter   && this.hzFilter.disconnect();   } catch(e){}
                try { this._src       && this._src.disconnect();       } catch(e){}
                this._disconnectCfgEq();

                if (_ctx.state === 'suspended') await _ctx.resume();
                const src = _ctx.createMediaStreamSource(this._rawStream);
                this._src = src;

                if (CFG_STATE.active) {
                    await this._buildCfgChain(src, this._dest);
                    if (statusEl) statusEl.innerText = '✅ CFG đang chạy — gain ' + CFG_STATE.preGain + 'x' + (CFG_STATE.format === 'bufmic' ? ' [BufMic]' : ' [APO EQ ' + CFG_STATE.filters.length + ' band]') + '.';
                } else {
                    await this._buildNormalChain(src, this._dest);
                    if (statusEl) statusEl.innerText = '';
                }
            } catch(err) {
                logSystem('rebuildChain ERR: ' + (err && err.message));
                if (statusEl) statusEl.innerText = '⚠ Lỗi kết nối chain: ' + (err && err.message) + '. Thử rời + vào lại voice.';
            }
        },

        // Normal chain (tách ra từ build() để dùng lại trong rebuildChain)
        async _buildNormalChain(src, dest) {
            this.hzFilter = _ctx.createBiquadFilter();
            this.hzFilter.type            = 'highshelf';
            this.hzFilter.frequency.value = 3000;
            this.hzFilter.gain.value      = clampHz(P.hzBoost);

            this.node = new AudioWorkletNode(_ctx, 'khang-engine', { numberOfOutputs:1, outputChannelCount:[2] });
            this.push();

            if (_workletReady) {
                this.echoNode = new AudioWorkletNode(_ctx, 'echo-rumble-engine', { numberOfOutputs:1, outputChannelCount:[2] });
                this.pushEcho();
                try {
                    this.pitchNode = new AudioWorkletNode(_ctx, 'pitch-shifter', { numberOfOutputs:1, outputChannelCount:[2] });
                    this.pushPitch();
                    src.connect(this.pitchNode);
                    this.pitchNode.connect(this.node);
                } catch(e) {
                    src.connect(this.node);
                    this.pitchNode = null;
                }
                try {
                    this.delayNode = new AudioWorkletNode(_ctx, 'delay-speech', { numberOfOutputs:1, outputChannelCount:[2] });
                    this.pushDelaySpeech();
                } catch(e) { this.delayNode = null; }
                this.node.connect(this.echoNode);
                if (this.delayNode) {
                    this.echoNode.connect(this.delayNode);
                    this.delayNode.connect(this.hzFilter);
                } else {
                    this.echoNode.connect(this.hzFilter);
                }
                this.hzFilter.connect(dest);
            } else {
                src.connect(this.node);
                this.node.connect(this.hzFilter);
                this.hzFilter.connect(dest);
            }
        },

        async build(stream) {
            await initCtx();
            // BUGFIX: dọn dẹp node cũ trước khi build lại — nếu không, mỗi
            // lần rời/vào lại voice sẽ chồng thêm 1 bộ node chạy song song
            // mãi mãi, tích tụ dần gây tụt hiệu năng -> giật tiếng.
            try { this.node && this.node.disconnect(); } catch(e){}
            try { this.pitchNode && this.pitchNode.disconnect(); } catch(e){}
            try { this.echoNode && this.echoNode.disconnect(); } catch(e){}
            try { this.delayNode && this.delayNode.disconnect(); } catch(e){}
            try { this.hzFilter && this.hzFilter.disconnect(); } catch(e){}
            this._disconnectCfgEq();
            try {
                if (_ctx.state === 'suspended') await _ctx.resume();
                const src  = _ctx.createMediaStreamSource(stream);
                const dest = _ctx.createMediaStreamDestination();

                // Lưu tham chiếu để rebuildChain() reuse dest khi CFG thay đổi
                this._rawStream = stream;
                this._src       = src;
                this._dest      = dest;

                if (CFG_STATE.active) {
                    // ── CHẾ ĐỘ CFG: bypass tất cả worklet hook, chỉ chạy CFG chain ──
                    await this._buildCfgChain(src, dest);
                } else {
                    // ── Chế độ bình thường ──
                    await this._buildNormalChain(src, dest);
                }
                return dest.stream;
            } catch(e) { return stream; }
        },
        push() {
            if (!this.node || !_ctx) return;
            const mp = this.node.parameters, t = _ctx.currentTime;
            mp.get('preGain').setTargetAtTime(P.preGain,   t, 0.015);
            mp.get('drive').setTargetAtTime(P.drive,       t, 0.015);
            mp.get('crush').setTargetAtTime(P.crush,       t, 0.015);
            mp.get('width').setTargetAtTime(P.width,       t, 0.015);
            mp.get('postGain').setTargetAtTime(P.postGain, t, 0.015);
        },
        pushHz() {
            if (!this.hzFilter || !_ctx) return;
            this.hzFilter.gain.setTargetAtTime(clampHz(P.hzBoost), _ctx.currentTime, 0.02);
        },
        pushPitch() {
            if (!this.pitchNode || !_ctx) return;
            const semitones = VP.enabled ? VP.pitchSemitones : 0;
            const ratio = Math.pow(2, semitones / 12);
            this.pitchNode.parameters.get('pitch').setTargetAtTime(ratio, _ctx.currentTime, 0.02);
        },
        pushEcho() {
            if (!this.echoNode || !_ctx) return;
            const mp = this.echoNode.parameters, t = _ctx.currentTime;
            if (!EP.enabled) {
                mp.get('echoMix').setTargetAtTime(0,  t, 0.02);
                mp.get('rumble').setTargetAtTime(0,   t, 0.02);
                mp.get('grind').setTargetAtTime(0,    t, 0.02);
                mp.get('noiseAmt').setTargetAtTime(0, t, 0.02);
                return;
            }
            mp.get('echoDelay').setTargetAtTime(EP.echoDelay,       t, 0.02);
            mp.get('echoFeedback').setTargetAtTime(EP.echoFeedback, t, 0.02);
            mp.get('echoMix').setTargetAtTime(EP.echoMix,           t, 0.02);
            mp.get('rumble').setTargetAtTime(EP.rumble,             t, 0.02);
            mp.get('grind').setTargetAtTime(EP.grind,               t, 0.02);
            mp.get('noiseAmt').setTargetAtTime(EP.noiseAmt||0,      t, 0.02);
            const noiseMap = { off:0, white:1, pink:2, hum:3, cb:4, phone:5, tunnel:6, broken:7 };
            mp.get('noiseType').setTargetAtTime(noiseMap[EP.noiseType]||0, t, 0.02);
        },
        pushDelaySpeech() {
            if (!this.delayNode || !_ctx) return;
            const mp = this.delayNode.parameters, t = _ctx.currentTime;
            const delayAmt = DELAY_SPEECH.enabled ? DELAY_SPEECH.delayAmount : 0.01;
            mp.get('delayAmount').setTargetAtTime(delayAmt, t, 0.02);
        }
    };

    const PRESETS = {
        'CLEAN':          { preGain:4,     drive:0,     crush:0,     width:0,   postGain:1    },
        'WARM':           { preGain:8,     drive:0.3,   crush:0,     width:0.2, postGain:1.2  },
        'LOUD':           { preGain:25,    drive:0.55,  crush:0.35,  width:0,   postGain:2    },
        'SIÊU ỒN':        { preGain:80,    drive:0.75,  crush:0.7,   width:0,   postGain:3    },
        '⚡ APO VANG':     { preGain:4999,  drive:0.92,  crush:0.88,  width:1.2, postGain:10   },
        'NUKE':           { preGain:1500,  drive:0.995, crush:0.995, width:0,   postGain:9    },
        '⚡ VANG NUKE':    { preGain:2500,  drive:0.65,  crush:0.25,  width:1.8, postGain:10   },
        '☢ MEGATON':      { preGain:4999,  drive:0.999, crush:0.999, width:0,   postGain:10   },
        '☢️ ULTIMATE NUKE':{ preGain:4999,  drive:0.999, crush:0.999, width:1.8, postGain:10   },
        '💀 ULTIMATE NUKE ECHO': { preGain:99999, drive:0.9999, crush:0.9999, width:2.0, postGain:99999 },
    };

    // Echo/Effect presets applied alongside audio presets
    const ECHO_COMBOS = {
        '💀 ULTIMATE NUKE ECHO': {
            enabled: true,
            echoDelay: 0.22,
            echoFeedback: 0.96,
            echoMix: 0.999,
            rumble: 1.0,
            grind: 1.0,
            noiseAmt: 0.85,
            noiseType: 'broken',
        },
    };

    // ── APO K TẠP ÂM VIP: By Nguyen Hoang Gia Bao (Volume Siêu To + 100% Sạch Tạp Âm) ──
    const APO_TIERS = {
        '🌟 NHẸ - TRONG TRẺO':         { preGain:20,  drive:0, crush:0, width:0,    postGain:6,   hzBoost:4 },
        '⚡ VỪA - DÀY GIỌNG RÕ':        { preGain:50,  drive:0, crush:0, width:0,    postGain:12,  hzBoost:7 },
        '💎 XỊN MAX - TO KHỦNG':        { preGain:100, drive:0, crush:0, width:0.02, postGain:25,  hzBoost:10 },
        '👑 APO VIP PRO - MAX VOLUME':   { preGain:250, drive:0, crush:0, width:0.04, postGain:50,  hzBoost:12 },
    };
    let apoActiveTier = null;

    const VOICE_PRESETS = {
        '👶 EM BÉ':   { semitones: +12 },
        '🎅 ÔNG GIÀ': { semitones: -6  },
        '👽 ROBOT':   { semitones: +12 },
        '🐸 ẾCH':     { semitones: -10 },
    };

    const NOISE_LABELS = {
        off:    '🔇 TẮT',
        white:  '🌫 WHITE',
        pink:   '🌸 PINK',
        hum:    '⚡ HUM 60Hz',
        cb:     '🎙 CB MIC RÈ',
        phone:  '📞 PHONE',
        tunnel: '🌀 TUNNEL',
        broken: '💀 MIC VỠ',
    };

    function applyPreset(key) {
        Object.assign(P, PRESETS[key]);
        if (P.hzBoost === undefined) P.hzBoost = 0;
        P.hzBoost = clampHz(P.hzBoost);
        if (ECHO_COMBOS[key]) {
            Object.assign(EP, ECHO_COMBOS[key]);
        }
        Core.push();
        Core.pushEcho();
        Core.pushHz();
        Core.pushDelaySpeech();
        syncUI();
        logActivity('Preset: ' + key);
        document.querySelectorAll('.kp-btn').forEach(b =>
            b.classList.toggle('kp-on', b.dataset.k === key));
        document.querySelectorAll('.ka-btn').forEach(b => b.classList.remove('ka-on'));
        apoActiveTier = null;
        const kaBadge = document.getElementById('ka-active');
        if (kaBadge) kaBadge.innerText = 'CHƯA BẬT';
        // sync echo toggle badge
        const etog = document.getElementById('echo-toggle');
        if (etog) etog.checked = EP.enabled;
        const eb = document.getElementById('kh-echo-body');
        if (eb) eb.style.opacity = EP.enabled ? '1' : '0.65';
        if (eb) eb.style.pointerEvents = EP.enabled ? 'auto' : 'none';
        syncEchoUI();
        syncDelaySpeechUI();
    }

    function applyApoTier(key) {
        apoActiveTier = key;
        Object.assign(P, APO_TIERS[key]);
        P.hzBoost = clampHz(P.hzBoost);
        // Đảm bảo TUYỆT ĐỐI không vang/echo/tạp âm khi dùng module này —
        // trước đây chỉ tắt noise/rumble/grind, quên tắt echoMix/feedback
        // nên nếu người dùng từng bật "VANG VỌNG" trước đó, tiếng vẫn bị vang.
        EP.enabled = false;
        Object.assign(EP, { echoMix:0, echoFeedback:0, rumble:0, grind:0, noiseAmt:0, noiseType:'off' });
        Core.push();
        Core.pushEcho();
        Core.pushHz();
        Core.pushDelaySpeech();
        syncUI();
        syncEchoUI();
        syncDelaySpeechUI();
        logActivity('APO K TẠP ÂM: ' + key);
        // Đồng bộ lại toggle + giao diện phần VANG VỌNG về trạng thái tắt
        const echoToggle = document.getElementById('echo-toggle');
        if (echoToggle) echoToggle.checked = false;
        const echoBody = document.getElementById('kh-echo-body');
        if (echoBody) { echoBody.style.opacity = '0.65'; echoBody.style.pointerEvents = 'none'; }
        document.querySelectorAll('.kp-btn').forEach(b => b.classList.remove('kp-on'));
        document.querySelectorAll('.ka-btn').forEach(b =>
            b.classList.toggle('ka-on', b.dataset.a === key));
        const badge = document.getElementById('ka-active');
        if (badge) badge.innerText = key;
    }

    function applyVoicePreset(key) {
        VP.pitchSemitones = VOICE_PRESETS[key].semitones;
        VP.enabled = true;
        Core.pushPitch();
        const sl = document.getElementById('sl-pitch');
        if (sl) { sl.value = VP.pitchSemitones; sl.style.setProperty('--v',(((VP.pitchSemitones+12)/24)*100).toFixed(1)+'%'); }
        setLabel('lb-pitch', (VP.pitchSemitones>=0?'+':'')+VP.pitchSemitones+' st');
        document.querySelectorAll('.kv-btn').forEach(b => b.classList.toggle('kv-on', b.dataset.v === key));
        const tog = document.getElementById('voice-toggle');
        if (tog && !tog.checked) { tog.checked = true; tog.dispatchEvent(new Event('change')); }
        logActivity('Đổi giọng: ' + key);
    }

    function syncUI() {
        setSlider('sl-pg', P.preGain, 99999); setSlider('sl-dr', P.drive, 1);
        setSlider('sl-cr', P.crush,   1);     setSlider('sl-wd', P.width, 2);
        setSlider('sl-po', P.postGain, 99999); setSlider('sl-hz', P.hzBoost, HZ_MAX, HZ_MIN);
        setLabel('lb-pg', P.preGain.toFixed(0)+'x');
        setLabel('lb-dr', (P.drive*100).toFixed(0)+'%');
        setLabel('lb-cr', (P.crush*100).toFixed(0)+'%');
        setLabel('lb-wd', (P.width*100).toFixed(0)+'%');
        setLabel('lb-po', P.postGain.toFixed(0)+'x');
        setLabel('lb-hz', (P.hzBoost>=0?'+':'')+P.hzBoost.toFixed(0)+'dB');
        renderDashboard();
    }

    function syncEchoUI() {
        setSlider('sl-ed',  EP.echoDelay,    2.0); setLabel('lb-ed', EP.echoDelay.toFixed(2)+'s');
        setSlider('sl-ef',  EP.echoFeedback, 0.999); setLabel('lb-ef', (EP.echoFeedback*100).toFixed(0)+'%');
        setSlider('sl-em',  EP.echoMix,      1.0); setLabel('lb-em', (EP.echoMix*100).toFixed(0)+'%');
        setSlider('sl-rum', EP.rumble,       1.0); setLabel('lb-rum', (EP.rumble*100).toFixed(0)+'%');
        setSlider('sl-grd', EP.grind,        1.0); setLabel('lb-grd', (EP.grind*100).toFixed(0)+'%');
        setSlider('sl-nz',  EP.noiseAmt||0,  1.0); setLabel('lb-nz', ((EP.noiseAmt||0)*100).toFixed(0)+'%');
        document.querySelectorAll('.kn-btn').forEach(b => b.classList.toggle('kn-on', b.dataset.n === EP.noiseType));
    }

    function syncDelaySpeechUI() {
        setSlider('sl-delay', DELAY_SPEECH.delayAmount, 1.0); setLabel('lb-delay', DELAY_SPEECH.delayAmount.toFixed(2)+'s');
        const delayToggle = document.getElementById('delay-toggle'); if(delayToggle) delayToggle.checked = DELAY_SPEECH.enabled;
    }

    function setSlider(id,val,max,min){
        const e=document.getElementById(id); if(!e)return;
        const mn = min!==undefined ? min : 0;
        e.value=val; e.style.setProperty('--v',(((val-mn)/(max-mn))*100).toFixed(1)+'%');
    }
    function setLabel(id,txt){ const e=document.getElementById(id); if(e)e.innerText=txt; }

    /* ══════════════ STATE, PERSISTENCE, i18n ══════════════ */
    const STORAGE_KEY = 'apoKTapAm_state_v5';
    const APP_STATE = {
        theme: 'dark',
        lang: 'vi',
        autoRestore: true,
        lastType: null,   // 'preset' | 'tier' | null
        lastKey: null,
        log: [],          // activity log: {t, msg}
        sysLog: [],        // system/engine log: {t, msg}
        sessionStart: Date.now(),
    };
    function loadState() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const saved = JSON.parse(raw);
            Object.assign(APP_STATE, saved, { sessionStart: Date.now() });
            if (!Array.isArray(APP_STATE.log)) APP_STATE.log = [];
            if (!Array.isArray(APP_STATE.sysLog)) APP_STATE.sysLog = [];
        } catch(e) {}
    }
    function saveState() {
        try {
            const { theme, lang, autoRestore, lastType, lastKey, log, sysLog } = APP_STATE;
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme, lang, autoRestore, lastType, lastKey, log, sysLog }));
        } catch(e) {}
    }
    function nowStr() {
        const d = new Date();
        return d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0')+':'+d.getSeconds().toString().padStart(2,'0');
    }
    function logActivity(msg) {
        APP_STATE.log.unshift({ t: nowStr(), msg });
        if (APP_STATE.log.length > 20) APP_STATE.log.length = 20;
        saveState();
        renderAutomation();
        renderDashboard();
    }
    function logSystem(msg) {
        APP_STATE.sysLog.unshift({ t: nowStr(), msg });
        if (APP_STATE.sysLog.length > 30) APP_STATE.sysLog.length = 30;
        saveState();
        renderAutomation();
    }

    const STRINGS = {
        vi: {
            dashboard:'Dashboard', tools:'Tools', automation:'Automation', account:'Account', settings:'Settings',
            dash_overview:'Tổng quan hệ thống', dash_engine:'Trạng thái Engine', dash_mode:'Chế độ đang bật',
            dash_hz:'Hz Boost', dash_recent:'Hoạt động gần đây', dash_empty:'Chưa có hoạt động nào',
            dash_notif_ok:'✅ Mọi thứ hoạt động bình thường', dash_notif_wait:'⏳ Đang khởi tạo engine…',
            auto_running:'Hiệu ứng đang chạy', auto_bypass:'Tắt toàn bộ hiệu ứng (Bypass)',
            auto_history:'Lịch sử hoạt động', auto_syslog:'Nhật ký hệ thống', auto_empty:'Trống',
            acc_device:'Thông tin thiết bị', acc_session:'Phiên làm việc', acc_ext:'Tiện ích',
            acc_domain:'Đang chạy trên', acc_uptime:'Thời gian mở panel', acc_reset:'↺ Đặt lại toàn bộ cấu hình',
            set_theme:'Giao diện', set_theme_dark:'Tối', set_theme_light:'Sáng',
            set_lang:'Ngôn ngữ', set_advanced:'Cấu hình nâng cao',
            set_autorestore:'Tự khôi phục preset gần nhất khi mở lại',
            set_clearlog:'🗑 Xoá lịch sử hoạt động',
            search_ph:'🔍 Tìm công cụ…', filter_all:'Tất cả', filter_basic:'Cơ bản', filter_extreme:'Hiệu ứng mạnh',
        },
        en: {
            dashboard:'Dashboard', tools:'Tools', automation:'Automation', account:'Account', settings:'Settings',
            dash_overview:'System overview', dash_engine:'Engine status', dash_mode:'Active mode',
            dash_hz:'Hz Boost', dash_recent:'Recent activity', dash_empty:'No activity yet',
            dash_notif_ok:'✅ Everything running normally', dash_notif_wait:'⏳ Initializing engine…',
            auto_running:'Active effect chain', auto_bypass:'Bypass all effects',
            auto_history:'Activity history', auto_syslog:'System log', auto_empty:'Empty',
            acc_device:'Device info', acc_session:'Session', acc_ext:'Extension',
            acc_domain:'Running on', acc_uptime:'Panel open time', acc_reset:'↺ Reset all settings',
            set_theme:'Theme', set_theme_dark:'Dark', set_theme_light:'Light',
            set_lang:'Language', set_advanced:'Advanced',
            set_autorestore:'Auto-restore last preset on reload',
            set_clearlog:'🗑 Clear activity log',
            search_ph:'🔍 Search tools…', filter_all:'All', filter_basic:'Basic', filter_extreme:'Extreme',
        },
    };
    function T(key) { return (STRINGS[APP_STATE.lang] || STRINGS.vi)[key] || key; }

    const PRESET_CAT = {
        'CLEAN':'basic','WARM':'basic','LOUD':'basic','SIÊU ỒN':'basic',
        '⚡ APO VANG':'extreme','NUKE':'extreme','⚡ VANG NUKE':'extreme','☢ MEGATON':'extreme',
        '☢️ ULTIMATE NUKE':'extreme','💀 ULTIMATE NUKE ECHO':'extreme',
    };

    /* ══════════════ UI ══════════════ */
    const UI = {
        el:null, minimized:false, dragging:false, ox:0, oy:0, activeTab:'dashboard',
        badge(t,c){
            const e=document.getElementById('kh-st'),d=document.getElementById('kh-dot');
            if(e){e.innerText=t;e.style.color=c;} if(d){d.style.background=c;d.style.boxShadow=`0 0 7px ${c}`;}
            logSystem('Engine → ' + t);
            renderDashboard();
        },
        init(){
            loadState();
            const el=document.createElement('div'); el.id='kh-root'; el.setAttribute('data-theme', APP_STATE.theme);
            const noiseButtons = Object.keys(NOISE_LABELS).map(k =>
                `<button class="kn-btn${k==='off'?' kn-on':''}" data-n="${k}">${NOISE_LABELS[k]}</button>`
            ).join('');

            const navIcons = [
                ['dashboard','📊'], ['tools','🎛️'], ['automation','⚙️'], ['account','👤'], ['settings','🔧'],
            ];

            el.innerHTML=`
<div id="kh-sidebar">
  <div id="kh-logo"><span id="kh-logo-glyph">⚡</span></div>
  <nav id="kh-navrail">${navIcons.map(([k,ic])=>`<button class="kh-nav-item${k==='dashboard'?' kh-nav-active':''}" data-tab="${k}" title="${k}"><span>${ic}</span></button>`).join('')}</nav>
  <button id="kh-col" title="Thu gọn">⟨</button>
</div>
<div id="kh-main">
  <div id="kh-topbar">
    <div id="kh-topbar-left">
      <div style="display:flex;flex-direction:column;">
        <div style="display:flex;align-items:center;gap:6px;">
          <span id="kh-tab-title">Dashboard</span>
          <span id="kh-tag">v5 PRO</span>
        </div>
        <span style="font-size:9.5px;color:var(--accent3);font-weight:700;letter-spacing:0.5px;margin-top:1px;">by Nguyen Hoang Gia Bao</span>
      </div>
    </div>
    <div id="kh-badge"><span id="kh-dot"></span><span id="kh-st">WAIT</span></div>
  </div>
  <div id="kh-content">

    <section class="kh-tab kh-tab-active" data-tab="dashboard">
      <div class="kh-card-grid">
        <div class="kh-stat-card">
          <div class="kh-stat-label" data-i="dash_engine">Trạng thái Engine</div>
          <div class="kh-stat-value" id="dash-engine-val">WAIT</div>
        </div>
        <div class="kh-stat-card">
          <div class="kh-stat-label" data-i="dash_mode">Chế độ đang bật</div>
          <div class="kh-stat-value" id="dash-mode-val">CLEAN</div>
        </div>
        <div class="kh-stat-card">
          <div class="kh-stat-label" data-i="dash_hz">Hz Boost</div>
          <div class="kh-stat-value" id="dash-hz-val">+0dB</div>
        </div>
      </div>
      <div class="kh-notif" id="dash-notif">⏳ Đang khởi tạo engine…</div>
      <div class="kh-section-title" data-i="dash_recent">Hoạt động gần đây</div>
      <div id="dash-recent-list" class="kh-loglist"></div>
    </section>

    <section class="kh-tab" data-tab="tools">
      <input id="kh-search" class="kh-search" type="text" placeholder="🔍 Tìm công cụ…" data-i-ph="search_ph">
      <div id="kh-filterchips">
        <button class="kh-chip kh-chip-on" data-cat="all" data-i="filter_all">Tất cả</button>
        <button class="kh-chip" data-cat="basic" data-i="filter_basic">Cơ bản</button>
        <button class="kh-chip" data-cat="extreme" data-i="filter_extreme">Hiệu ứng mạnh</button>
      </div>
      <div id="kh-presets">${Object.keys(PRESETS).map(k=>`<button class="kp-btn${
        k==='NUKE'?' kp-nuke':
        k==='⚡ APO VANG'?' kp-apovang':
        k==='☢ MEGATON'?' kp-mega':
        k==='⚡ VANG NUKE'?' kp-vangnuke':
        k==='☢️ ULTIMATE NUKE'?' kp-ultimate':
        k==='💀 ULTIMATE NUKE ECHO'?' kp-unuke-echo':
        ''}" data-k="${k}" data-cat="${PRESET_CAT[k]||'basic'}">${k}</button>`).join('')}</div>
      <div class="kh-sep"></div>

      <div id="ka-section">
        <div id="ka-header">
          <span>🔊 APO K TẠP ÂM VIP <small style="color:var(--accent3);font-weight:700;">(by Nguyen Hoang Gia Bao)</small></span>
          <span id="ka-active">CHƯA BẬT</span>
        </div>
        <div id="ka-btns">${Object.keys(APO_TIERS).map(k=>`<button class="ka-btn" data-a="${k}">${k}</button>`).join('')}</div>
        <div id="ka-note">✨ 100% Sạch Tạp Âm · 📢 Volume Siêu To VIP · 🎚 Giọng Sắc Nét</div>
      </div>
      <div class="kh-sep"></div>
      ${[['sl-pg','lb-pg','PRE GAIN','🔊',1,99999,4],['sl-dr','lb-dr','DRIVE','🔥',0,1,0],['sl-cr','lb-cr','CRUSH','💥',0,1,0],['sl-wd','lb-wd','WIDTH','🌐',0,2,0],['sl-po','lb-po','POSTGAIN','⚡',0.1,99999,1]].map(([sid,lid,name,ico,mn,mx,def])=>`<div class="kh-row"><div class="kh-rowlabel"><span>${ico} ${name}</span><span id="${lid}">${def}${sid==='sl-pg'||sid==='sl-po'?'x':'%'}</span></div><input type="range" id="${sid}" min="${mn}" max="${mx}" step="${mx<=1?0.01:1}" value="${def}" style="--v:${((def-mn)/(mx-mn)*100).toFixed(0)}%"></div>`).join('')}
      <div class="kh-row"><div class="kh-rowlabel"><span>🎚️ HZ CAO (chói/rõ = to hơn, đã giới hạn an toàn)</span><span id="lb-hz">+0dB</span></div><input type="range" id="sl-hz" min="0" max="12" step="0.5" value="0" style="--v:0%"></div>
      <div class="kh-sep"></div>

      <div id="kh-echo-header"><span>🌀 VANG VỌNG + HIỆU ỨNG</span><label class="kh-toggle-wrap"><input type="checkbox" id="echo-toggle"><span class="kh-toggle-track"><span class="kh-toggle-thumb"></span></span></label></div>
      <div id="kh-echo-body" style="opacity:0.65;pointer-events:none;">
        <div class="kh-row"><div class="kh-rowlabel"><span>⏱ DELAY</span><span id="lb-ed">0.18s</span></div><input type="range" id="sl-ed" min="0.01" max="2.0" step="0.01" value="0.18" style="--v:9%"></div>
        <div class="kh-row"><div class="kh-rowlabel"><span>🔁 FEEDBACK (VANG SÂU)</span><span id="lb-ef">55%</span></div><input type="range" id="sl-ef" min="0" max="0.999" step="0.001" value="0.55" style="--v:55%"></div>
        <div class="kh-row"><div class="kh-rowlabel"><span>🌊 MIX (HÒA TRỘN)</span><span id="lb-em">50%</span></div><input type="range" id="sl-em" min="0" max="1.0" step="0.01" value="0.5" style="--v:50%"></div>
        <div class="kh-row"><div class="kh-rowlabel"><span>🌋 RUMBLE (GẦM GÚ)</span><span id="lb-rum">0%</span></div><input type="range" id="sl-rum" min="0" max="1.0" step="0.01" value="0" style="--v:0%"></div>
        <div class="kh-row"><div class="kh-rowlabel"><span>🔩 GRIND (RÈ VỠ)</span><span id="lb-grd">0%</span></div><input type="range" id="sl-grd" min="0" max="1.0" step="0.01" value="0" style="--v:0%"></div>
        <div class="kh-row"><div class="kh-rowlabel"><span>🎛 NOISE (NHIỄU MIC)</span><span id="lb-nz">0%</span></div><input type="range" id="sl-nz" min="0" max="1.0" step="0.01" value="0" style="--v:0%"></div>
        <div id="kh-noise-btns">${noiseButtons}</div>
      </div>

      <div class="kh-sep"></div>
      <div id="kh-delay-header"><span>⏰ DELAY GIỌNG (NÓI LIÊN TỤC)</span><label class="kh-toggle-wrap"><input type="checkbox" id="delay-toggle"><span class="kh-toggle-track"><span class="kh-toggle-thumb"></span></span></label></div>
      <div id="kh-delay-body" style="opacity:0.65;pointer-events:none;">
        <div class="kh-row"><div class="kh-rowlabel"><span>⏱️ MỨC DELAY</span><span id="lb-delay">0.15s</span></div><input type="range" id="sl-delay" min="0.01" max="1.0" step="0.01" value="0.15" style="--v:15%"></div>
      </div>

      <div class="kh-sep"></div>
      <div id="kh-voice-header"><span>🎙 ĐỔI GIỌNG</span><label class="kh-toggle-wrap"><input type="checkbox" id="voice-toggle"><span class="kh-toggle-track"><span class="kh-toggle-thumb"></span></span></label></div>
      <div id="kh-voice-body" style="opacity:0.65;pointer-events:none;">
        <div id="kh-voice-presets">${Object.keys(VOICE_PRESETS).map(k=>`<button class="kv-btn" data-v="${k}">${k}</button>`).join('')}</div>
        <div class="kh-row" style="margin-top:8px"><div class="kh-rowlabel"><span>🎚 PITCH</span><span id="lb-pitch">0 st</span></div><input type="range" id="sl-pitch" min="-12" max="12" step="1" value="0" style="--v:50%"></div>
      </div>
      <div class="kh-sep"></div>
      <div class="kh-card" id="kh-cfg-card">
        <div class="kh-card-title">📂 CFG FILE — APO EQ</div>
        <div id="cfg-active-name" style="font-size:11px;color:var(--accent3);font-weight:600;margin-bottom:8px;word-break:break-all;display:flex;justify-content:space-between;align-items:center;gap:6px;min-height:16px;"></div>
        <div style="display:flex;gap:8px;align-items:stretch;">
          <label for="cfg-file-input" class="kh-btn-outline" style="cursor:pointer;flex:1;text-align:center;padding:7px 6px;font-size:11.5px;display:flex;align-items:center;justify-content:center;gap:4px;margin-top:0;">
            📂 Nhập file .txt
          </label>
          <input type="file" id="cfg-file-input" accept=".txt,.md,.js" style="display:none">
          <button id="cfg-clear-btn" class="kh-btn-outline" style="flex:0 0 36px;font-size:15px;padding:0;margin-top:0;" title="Xoá CFG, khôi phục hook">✕</button>
        </div>
        <div class="kh-row" style="margin-top:10px;">
          <div class="kh-rowlabel"><span>🔊 GAIN (khuếch đại)</span><span id="lb-cfg-gain">4x</span></div>
          <input type="range" id="sl-cfg-gain" min="1" max="100" step="1" value="4" style="--v:3%">
        </div>
        <div id="cfg-band-table" style="display:none;margin-top:9px;border:1px solid rgba(255,255,255,0.08);border-radius:8px;overflow:hidden;"></div>
        <div id="cfg-status" style="font-size:10px;color:var(--text-dim);margin-top:7px;line-height:1.45;"></div>
      </div>
      <div class="kh-sep"></div>
      <button id="kh-rst">↺ RESET</button>
    </section>

    <section class="kh-tab" data-tab="automation">
      <div class="kh-card">
        <div class="kh-card-title" data-i="auto_running">Hiệu ứng đang chạy</div>
        <div id="auto-running-val" class="kh-card-big">CLEAN</div>
        <div class="kh-toggle-row">
          <span data-i="auto_bypass">Tắt toàn bộ hiệu ứng (Bypass)</span>
          <label class="kh-toggle-wrap"><input type="checkbox" id="bypass-toggle"><span class="kh-toggle-track"><span class="kh-toggle-thumb"></span></span></label>
        </div>
      </div>
      <div class="kh-section-title" data-i="auto_history">Lịch sử hoạt động</div>
      <div id="auto-history-list" class="kh-loglist kh-loglist-tall"></div>
      <div class="kh-section-title" data-i="auto_syslog">Nhật ký hệ thống</div>
      <div id="auto-syslog-list" class="kh-loglist kh-loglist-tall"></div>
    </section>

    <section class="kh-tab" data-tab="account">
      <div class="kh-card">
        <div class="kh-card-title" data-i="acc_device">Thông tin thiết bị & Tác giả</div>
        <div class="kh-kv"><span data-i="acc_ext">Tiện ích</span><span>APO K TẠP ÂM v5 PRO</span></div>
        <div class="kh-kv"><span>Tác giả / Dev</span><span style="color:var(--accent3);font-weight:700;">Nguyen Hoang Gia Bao</span></div>
        <div class="kh-kv"><span data-i="acc_domain">Đang chạy trên</span><span>discord.com</span></div>
      </div>
      <div class="kh-card">
        <div class="kh-card-title" data-i="acc_session">Phiên làm việc</div>
        <div class="kh-kv"><span data-i="acc_uptime">Thời gian mở panel</span><span id="acc-uptime">0:00</span></div>
      </div>
      <button id="acc-reset" class="kh-btn-outline" data-i="acc_reset">↺ Đặt lại toàn bộ cấu hình</button>
    </section>

    <section class="kh-tab" data-tab="settings">
      <div class="kh-card">
        <div class="kh-card-title" data-i="set_theme">Giao diện</div>
        <div class="kh-toggle-row">
          <span id="set-theme-label" data-i="set_theme_dark">Tối</span>
          <label class="kh-toggle-wrap"><input type="checkbox" id="theme-toggle"><span class="kh-toggle-track"><span class="kh-toggle-thumb"></span></span></label>
        </div>
      </div>
      <div class="kh-card">
        <div class="kh-card-title" data-i="set_lang">Ngôn ngữ</div>
        <div id="kh-lang-switch">
          <button class="kh-chip kh-chip-on" data-lang="vi">Tiếng Việt</button>
          <button class="kh-chip" data-lang="en">English</button>
        </div>
      </div>
      <div class="kh-card">
        <div class="kh-card-title" data-i="set_advanced">Cấu hình nâng cao</div>
        <div class="kh-toggle-row">
          <span data-i="set_autorestore">Tự khôi phục preset gần nhất khi mở lại</span>
          <label class="kh-toggle-wrap"><input type="checkbox" id="autorestore-toggle" checked><span class="kh-toggle-track"><span class="kh-toggle-thumb"></span></span></label>
        </div>
        <button id="set-clearlog" class="kh-btn-outline" data-i="set_clearlog">🗑 Xoá lịch sử hoạt động</button>
      </div>
    </section>

  </div>
</div>`;
            document.body.appendChild(el);
            this.el=el; this.css(); this.events(); this.badge('WAIT','#888');
            this.applyLang(); this.applyTheme();
            document.getElementById('theme-toggle').checked = APP_STATE.theme === 'light';
            document.getElementById('autorestore-toggle').checked = APP_STATE.autoRestore;
            renderAutomation(); renderDashboard();
            this.startUptimeClock();
            // Auto-restore preset/tier gần nhất
            if (APP_STATE.autoRestore && APP_STATE.lastKey) {
                try {
                    if (APP_STATE.lastType === 'tier' && APO_TIERS[APP_STATE.lastKey]) applyApoTier(APP_STATE.lastKey);
                    else if (APP_STATE.lastType === 'preset' && PRESETS[APP_STATE.lastKey]) applyPreset(APP_STATE.lastKey);
                } catch(e) {}
            }
            requestAnimationFrame(()=> el.classList.add('kh-mounted'));
        },
        startUptimeClock(){
            setInterval(()=>{
                const secs = Math.floor((Date.now()-APP_STATE.sessionStart)/1000);
                const m = Math.floor(secs/60), s = secs%60;
                const e = document.getElementById('acc-uptime');
                if (e) e.innerText = m+':'+s.toString().padStart(2,'0');
            }, 1000);
        },
        applyTheme(){
            this.el.setAttribute('data-theme', APP_STATE.theme);
            const lbl = document.getElementById('set-theme-label');
            if (lbl) lbl.innerText = APP_STATE.theme==='light' ? T('set_theme_light') : T('set_theme_dark');
        },
        applyLang(){
            document.querySelectorAll('[data-i]').forEach(e=>{ e.innerText = T(e.getAttribute('data-i')); });
            const s = document.getElementById('kh-search');
            if (s) s.placeholder = T('search_ph');
            document.querySelectorAll('.kh-nav-item').forEach(b=>{
                const tab = b.dataset.tab;
                b.title = T(tab);
            });
            document.querySelectorAll('#kh-lang-switch .kh-chip').forEach(b=>
                b.classList.toggle('kh-chip-on', b.dataset.lang===APP_STATE.lang));
            const titleEl = document.getElementById('kh-tab-title');
            if (titleEl) titleEl.innerText = T(this.activeTab);
        },
        switchTab(tab){
            this.activeTab = tab;
            document.querySelectorAll('.kh-tab').forEach(s=>{
                s.classList.toggle('kh-tab-active', s.dataset.tab===tab);
            });
            document.querySelectorAll('.kh-nav-item').forEach(b=>{
                b.classList.toggle('kh-nav-active', b.dataset.tab===tab);
            });
            const titleEl = document.getElementById('kh-tab-title');
            if (titleEl) titleEl.innerText = T(tab);
        },
        events(){
            // Sidebar nav
            document.querySelectorAll('.kh-nav-item').forEach(b=>{
                b.onclick=()=>this.switchTab(b.dataset.tab);
            });

            // Minimize/collapse
            document.getElementById('kh-col').onclick=()=>{
                this.minimized=!this.minimized;
                this.el.classList.toggle('kh-minimized', this.minimized);
                document.getElementById('kh-col').innerText=this.minimized?'⟩':'⟨';
            };

            // Main sliders
            [['sl-pg','lb-pg','preGain',99999,'x'],['sl-dr','lb-dr','drive',1,'%',100],['sl-cr','lb-cr','crush',1,'%',100],['sl-wd','lb-wd','width',2,'%',100],['sl-po','lb-po','postGain',99999,'x']].forEach(([sid,lid,param,max,unit,scale=1])=>{
                const sl=document.getElementById(sid);
                sl.oninput=()=>{ const v=parseFloat(sl.value); P[param]=v; setLabel(lid,(v*scale).toFixed(scale===100?0:1)+unit); sl.style.setProperty('--v',((v-parseFloat(sl.min))/(max-parseFloat(sl.min))*100).toFixed(1)+'%'); Core.push(); renderDashboard(); };
            });

            // Hz slider
            const slHz = document.getElementById('sl-hz');
            slHz.oninput = () => {
                const v = clampHz(parseFloat(slHz.value)); P.hzBoost = v;
                setLabel('lb-hz', (v>=0?'+':'')+v.toFixed(1)+'dB');
                slHz.style.setProperty('--v', (((v-HZ_MIN)/(HZ_MAX-HZ_MIN))*100).toFixed(1)+'%');
                Core.pushHz();
                renderDashboard();
            };

            document.querySelectorAll('.kp-btn').forEach(b=>b.onclick=()=>{
                applyPreset(b.dataset.k);
                APP_STATE.lastType='preset'; APP_STATE.lastKey=b.dataset.k; saveState();
            });
            document.querySelectorAll('.ka-btn').forEach(b=>b.onclick=()=>{
                applyApoTier(b.dataset.a);
                APP_STATE.lastType='tier'; APP_STATE.lastKey=b.dataset.a; saveState();
            });

            // Tools search + filter
            const searchEl = document.getElementById('kh-search');
            let curFilter = 'all';
            function applyToolFilter(){
                const q = (searchEl.value||'').toLowerCase().trim();
                document.querySelectorAll('#kh-presets .kp-btn').forEach(b=>{
                    const matchesText = b.dataset.k.toLowerCase().includes(q);
                    const matchesCat = curFilter==='all' || b.dataset.cat===curFilter;
                    b.style.display = (matchesText && matchesCat) ? '' : 'none';
                });
            }
            searchEl.oninput = applyToolFilter;
            document.querySelectorAll('#kh-filterchips .kh-chip').forEach(chip=>{
                chip.onclick=()=>{
                    curFilter = chip.dataset.cat;
                    document.querySelectorAll('#kh-filterchips .kh-chip').forEach(c=>c.classList.toggle('kh-chip-on', c===chip));
                    applyToolFilter();
                };
            });

            // Echo toggle
            const echoToggle = document.getElementById('echo-toggle');
            const echoBody = document.getElementById('kh-echo-body');
            echoToggle.onchange = () => {
                EP.enabled = echoToggle.checked;
                echoBody.style.opacity = EP.enabled ? '1' : '0.65';
                echoBody.style.pointerEvents = EP.enabled ? 'auto' : 'none';
                Core.pushEcho();
                logActivity(EP.enabled ? 'Bật VANG VỌNG' : 'Tắt VANG VỌNG');
            };

            // Echo sliders
            [
                ['sl-ed','lb-ed','echoDelay',2.0,'s',1],
                ['sl-ef','lb-ef','echoFeedback',0.999,'%',100],
                ['sl-em','lb-em','echoMix',1.0,'%',100],
                ['sl-rum','lb-rum','rumble',1.0,'%',100],
                ['sl-grd','lb-grd','grind',1.0,'%',100],
                ['sl-nz','lb-nz','noiseAmt',1.0,'%',100],
            ].forEach(([sid,lid,param,max,unit,scale])=>{
                const sl=document.getElementById(sid);
                if(!sl) return;
                sl.oninput=()=>{
                    const v=parseFloat(sl.value); EP[param]=v;
                    setLabel(lid, scale===1 ? v.toFixed(2)+unit : (v*scale).toFixed(0)+unit);
                    sl.style.setProperty('--v',((v/max)*100).toFixed(1)+'%');
                    Core.pushEcho();
                };
            });

            // Noise type buttons
            document.querySelectorAll('.kn-btn').forEach(b=>b.onclick=()=>{
                EP.noiseType = b.dataset.n;
                document.querySelectorAll('.kn-btn').forEach(x=>x.classList.toggle('kn-on', x.dataset.n===b.dataset.n));
                Core.pushEcho();
            });

            // Delay speech toggle
            const delayToggle=document.getElementById('delay-toggle');
            const delayBody=document.getElementById('kh-delay-body');
            if(delayToggle) {
                delayToggle.onchange=()=>{
                    DELAY_SPEECH.enabled=delayToggle.checked;
                    delayBody.style.opacity=DELAY_SPEECH.enabled?'1':'0.65';
                    delayBody.style.pointerEvents=DELAY_SPEECH.enabled?'auto':'none';
                    Core.pushDelaySpeech();
                    logActivity(DELAY_SPEECH.enabled ? 'Bật DELAY GIỌNG' : 'Tắt DELAY GIỌNG');
                };
            }

            // Delay speech slider
            const delaySl=document.getElementById('sl-delay');
            if(delaySl) {
                delaySl.oninput=()=>{
                    const v=parseFloat(delaySl.value);
                    DELAY_SPEECH.delayAmount=v;
                    setLabel('lb-delay',v.toFixed(2)+'s');
                    delaySl.style.setProperty('--v',((v/1.0)*100).toFixed(1)+'%');
                    Core.pushDelaySpeech();
                };
            }

            // Voice toggle
            const voiceToggle=document.getElementById('voice-toggle');
            const voiceBody=document.getElementById('kh-voice-body');
            voiceToggle.onchange=()=>{
                VP.enabled=voiceToggle.checked;
                voiceBody.style.opacity=VP.enabled?'1':'0.65';
                voiceBody.style.pointerEvents=VP.enabled?'auto':'none';
                Core.pushPitch();
                if(!VP.enabled) document.querySelectorAll('.kv-btn').forEach(b=>b.classList.remove('kv-on'));
            };
            document.querySelectorAll('.kv-btn').forEach(b=>b.onclick=()=>applyVoicePreset(b.dataset.v));
            const pitchSl=document.getElementById('sl-pitch');
            pitchSl.oninput=()=>{
                const v=parseInt(pitchSl.value); VP.pitchSemitones=v;
                setLabel('lb-pitch',(v>=0?'+':'')+v+' st');
                pitchSl.style.setProperty('--v',(((v+12)/24)*100).toFixed(1)+'%');
                document.querySelectorAll('.kv-btn').forEach(b=>b.classList.remove('kv-on'));
                Core.pushPitch();
            };

            // Reset
            document.getElementById('kh-rst').onclick=()=>{
                applyPreset('CLEAN');
                apoActiveTier = null;
                document.querySelectorAll('.ka-btn').forEach(b=>b.classList.remove('ka-on'));
                const kaB = document.getElementById('ka-active'); if(kaB) kaB.innerText='CHƯA BẬT';
                document.querySelectorAll('.kp-btn').forEach(b=>b.classList.remove('kp-on'));
                VP.pitchSemitones=0; VP.enabled=false; voiceToggle.checked=false;
                voiceBody.style.opacity='0.65'; voiceBody.style.pointerEvents='none';
                document.querySelectorAll('.kv-btn').forEach(b=>b.classList.remove('kv-on'));
                const sl=document.getElementById('sl-pitch'); if(sl){sl.value=0;sl.style.setProperty('--v','50%');}
                setLabel('lb-pitch','0 st'); Core.pushPitch();
                EP.enabled=false; echoToggle.checked=false;
                echoBody.style.opacity='0.65'; echoBody.style.pointerEvents='none';
                Object.assign(EP,{echoDelay:0.18,echoFeedback:0.55,echoMix:0.5,rumble:0,grind:0,noiseAmt:0,noiseType:'off'});
                Core.pushEcho(); syncEchoUI();
                DELAY_SPEECH.enabled=false; if(delayToggle) delayToggle.checked=false;
                delayBody.style.opacity='0.65'; delayBody.style.pointerEvents='none';
                DELAY_SPEECH.delayAmount=0.15;
                const delSlider=document.getElementById('sl-delay'); if(delSlider){delSlider.value=0.15;delSlider.style.setProperty('--v','15%');}
                setLabel('lb-delay','0.15s'); Core.pushDelaySpeech();
                APP_STATE.lastType=null; APP_STATE.lastKey=null; saveState();
                logActivity('Đã RESET toàn bộ');
            };

            // Automation: bypass toggle
            document.getElementById('bypass-toggle').onchange = (e) => {
                if (e.target.checked) { document.getElementById('kh-rst').click(); }
                logActivity(e.target.checked ? 'Bật Bypass (tắt hiệu ứng)' : 'Tắt Bypass');
            };

            // ── CFG FILE LOADER ──
            // Nhãn hiển thị loại filter theo chuẩn APO
            const CFG_TYPE_LABEL = {
                peaking: 'PK', lowshelf: 'LS', highshelf: 'HS',
                lowpass: 'LP', highpass: 'HP', notch: 'NO',
                bandpass: 'BP', allpass: 'AP'
            };
            let cfgTableExpanded = false;

            function renderCfgBandTable() {
                const tableEl = document.getElementById('cfg-band-table');
                if (!tableEl) return;
                if (!CFG_STATE.active || CFG_STATE.format === 'bufmic') {
                    tableEl.style.display = 'none';
                    tableEl.innerHTML = '';
                    return;
                }

                // ── Spatial format: hiển thị op list (Pan/Haas/Wider/EQ) ──
                if (CFG_STATE.format === 'spatial') {
                    const kindIcon = { pan:'🎧', haas:'↔️', wider:'🔊', skip:'⏭', apo:'🎚' };
                    const opRows = (CFG_STATE.spatialOps || []).map((op, i) => {
                        const bg = i % 2 ? 'background:rgba(255,255,255,0.03);' : '';
                        const icon = kindIcon[op.kind] || '•';
                        return `<div style="display:flex;gap:6px;padding:4px 8px;font-size:10px;font-family:monospace;${bg}">
                            <span style="color:var(--accent3)">${icon}</span>
                            <span style="color:var(--text-dim)">${op.label}</span>
                        </div>`;
                    }).join('');
                    const eqRows = (CFG_STATE.eqFilters || []).map((f, i) => {
                        const tl = {peaking:'PK',lowshelf:'LS',highshelf:'HS',lowpass:'LP',highpass:'HP',notch:'NO',bandpass:'BP',allpass:'AP'}[f.type]||f.type;
                        return `<div style="display:flex;justify-content:space-between;padding:4px 8px;font-size:10px;font-family:monospace;background:rgba(255,255,255,0.02);">
                            <span style="color:var(--accent3)">${tl}</span>
                            <span style="flex:1;text-align:right;color:var(--text-dim)">${f.freq>=1000?(f.freq/1000)+'k':f.freq} Hz</span>
                            <span style="width:60px;text-align:right;color:${f.gain>=0?'#4ade80':'#f87171'}">${f.gain>=0?'+':''}${f.gain.toFixed(1)} dB</span>
                            <span style="width:40px;text-align:right;color:var(--text-dim)">Q ${f.Q.toFixed(2)}</span>
                        </div>`;
                    }).join('');
                    const allCount = (CFG_STATE.spatialOps||[]).length + (CFG_STATE.eqFilters||[]).length;
                    tableEl.innerHTML = `
                        <div id="cfg-band-toggle" style="cursor:pointer;padding:6px 8px;font-size:10.5px;font-weight:600;color:var(--accent3);display:flex;justify-content:space-between;align-items:center;background:rgba(255,255,255,0.04);">
                            <span>🌐 Spatial — ${allCount} op ${cfgTableExpanded ? '— chi tiết' : ''}</span>
                            <span>${cfgTableExpanded ? '▴ Thu gọn' : '▾ Xem chi tiết'}</span>
                        </div>
                        <div style="max-height:${cfgTableExpanded?'280px':'0'};overflow-y:auto;transition:max-height 0.2s ease;">
                            ${opRows}${eqRows}
                        </div>`;
                    tableEl.style.display = 'block';
                    const tgl = document.getElementById('cfg-band-toggle');
                    if (tgl) tgl.onclick = () => { cfgTableExpanded = !cfgTableExpanded; renderCfgBandTable(); };
                    return;
                }

                if (!CFG_STATE.filters.length) {
                    tableEl.style.display = 'none'; tableEl.innerHTML = ''; return;
                }
                const rows = CFG_STATE.filters.map((f, i) => {
                    const label = CFG_TYPE_LABEL[f.type] || f.type;
                    const gainTxt = (f.gain > 0 ? '+' : '') + f.gain.toFixed(1) + ' dB';
                    return `<div style="display:flex;justify-content:space-between;padding:4px 8px;font-size:10px;font-family:monospace;${i % 2 ? 'background:rgba(255,255,255,0.03);' : ''}">
                        <span style="color:var(--accent3);width:28px;">${label}</span>
                        <span style="flex:1;text-align:right;color:var(--text-dim);">${f.freq >= 1000 ? (f.freq/1000)+'k' : f.freq} Hz</span>
                        <span style="width:60px;text-align:right;color:${f.gain >= 0 ? '#4ade80' : '#f87171'};">${gainTxt}</span>
                        <span style="width:44px;text-align:right;color:var(--text-dim);">Q ${f.Q.toFixed(2)}</span>
                    </div>`;
                }).join('');

                const extraRows = [];
                if (CFG_STATE.preampDb) {
                    extraRows.push(`<div style="display:flex;justify-content:space-between;padding:4px 8px;font-size:10px;font-family:monospace;background:rgba(255,200,0,0.08);">
                        <span style="color:#ffcc00;">PREAMP</span><span style="flex:1;text-align:right;color:var(--text-dim);">—</span>
                        <span style="width:60px;text-align:right;color:#ffcc00;">${CFG_STATE.preampDb > 0 ? '+' : ''}${CFG_STATE.preampDb} dB</span><span style="width:44px;"></span>
                    </div>`);
                }
                if (CFG_STATE.compressor) {
                    const c = CFG_STATE.compressor;
                    extraRows.push(`<div style="display:flex;justify-content:space-between;padding:4px 8px;font-size:10px;font-family:monospace;background:rgba(0,200,255,0.08);">
                        <span style="color:#38bdf8;">COMP</span>
                        <span style="flex:1;text-align:right;color:var(--text-dim);">thr ${c.threshold.toFixed(0)}dB</span>
                        <span style="width:60px;text-align:right;color:#38bdf8;">${c.ratio.toFixed(1)}:1</span><span style="width:44px;"></span>
                    </div>`);
                }

                tableEl.innerHTML = `
                    <div id="cfg-band-toggle" style="cursor:pointer;padding:6px 8px;font-size:10.5px;font-weight:600;color:var(--accent3);display:flex;justify-content:space-between;align-items:center;background:rgba(255,255,255,0.04);">
                        <span>🎚 ${CFG_STATE.filters.length} band ${cfgTableExpanded ? '— chi tiết' : ''}</span>
                        <span>${cfgTableExpanded ? '▴ Thu gọn' : '▾ Xem chi tiết'}</span>
                    </div>
                    <div style="max-height:${cfgTableExpanded ? '260px' : '0'};overflow-y:auto;transition:max-height 0.2s ease;">
                        ${rows}${extraRows.join('')}
                    </div>`;
                tableEl.style.display = 'block';

                const toggleEl = document.getElementById('cfg-band-toggle');
                if (toggleEl) toggleEl.onclick = () => { cfgTableExpanded = !cfgTableExpanded; renderCfgBandTable(); };
            }

            function updateCfgUI() {
                const nameEl = document.getElementById('cfg-active-name');
                if (!nameEl) return;
                if (CFG_STATE.active) {
                    let bandInfo;
                    if (CFG_STATE.format === 'bufmic') {
                        bandInfo = '[BufMic]';
                    } else if (CFG_STATE.format === 'spatial') {
                        const realOps = (CFG_STATE.spatialOps||[]).filter(o=>o.kind!=='skip');
                        bandInfo = '🌐 ' + realOps.length + ' op' + ((CFG_STATE.eqFilters||[]).length ? ' + ' + CFG_STATE.eqFilters.length + ' EQ' : '');
                    } else {
                        bandInfo = CFG_STATE.filters.length + ' band' + (CFG_STATE.compressor ? ' +Comp' : '') + (CFG_STATE.preampDb ? ' +Preamp' : '');
                    }
                    nameEl.innerText = '✅ ' + CFG_STATE.name + ' — ' + bandInfo;
                } else {
                    nameEl.innerText = '';
                    const statusEl = document.getElementById('cfg-status');
                    if (statusEl) statusEl.innerText = '';
                    cfgTableExpanded = false;
                }
                renderCfgBandTable();
            }

            // Gain slider cho CFG chain
            const cfgGainSl = document.getElementById('sl-cfg-gain');
            const cfgGainLb = document.getElementById('lb-cfg-gain');
            if (cfgGainSl) {
                cfgGainSl.oninput = () => {
                    const v = parseInt(cfgGainSl.value);
                    CFG_STATE.preGain = v;
                    if (cfgGainLb) cfgGainLb.innerText = v + 'x';
                    cfgGainSl.style.setProperty('--v', (((v - 1) / 99) * 100).toFixed(1) + '%');
                    // Cập nhật GainNode trực tiếp nếu đang chạy — không cần rebuild
                    const gainNode = Core.cfgEqNodes && Core.cfgEqNodes[0];
                    if (gainNode && gainNode.gain) {
                        const preampLin = Math.pow(10, (CFG_STATE.preampDb || 0) / 20);
                        gainNode.gain.setTargetAtTime(v * preampLin, _ctx ? _ctx.currentTime : 0, 0.02);
                    }
                };
            }

            const cfgFileInput = document.getElementById('cfg-file-input');
            if (cfgFileInput) {
                cfgFileInput.onchange = async (e) => {
                    const file = e.target.files && e.target.files[0];
                    if (!file) return;
                    const statusEl = document.getElementById('cfg-status');
                    if (statusEl) statusEl.innerText = '⏳ Đang đọc file…';
                    const reader = new FileReader();
                    reader.onload = async (ev) => {
                        try {
                            const text = ev.target.result;
                            const fmt  = detectCfgFormat(text);
                            if (!fmt) {
                                if (statusEl) statusEl.innerText = '⚠ Không nhận ra format. Cần APO Equalizer (.txt) hoặc BufMic (.md/.js).';
                                cfgFileInput.value = '';
                                return;
                            }
                            CFG_STATE.format      = fmt;
                            CFG_STATE.bufMicParams = null;
                            CFG_STATE.filters      = [];
                            CFG_STATE.compressor   = null;
                            CFG_STATE.preampDb     = 0;
                            CFG_STATE.spatialOps   = [];
                            CFG_STATE.eqFilters    = [];

                            if (fmt === 'bufmic') {
                                const p = parseBufMic(text);
                                if (!p) {
                                    if (statusEl) statusEl.innerText = '⚠ Không parse được block P = {...} từ file BufMic.';
                                    cfgFileInput.value = ''; return;
                                }
                                CFG_STATE.bufMicParams = p;
                                if (statusEl) statusEl.innerText = '⏳ BufMic — hp=' + p.highpass + 'Hz lp=' + p.lowpass + 'Hz comp=' + p.compThresh + 'dB — đang kết nối…';
                            } else if (fmt === 'spatial') {
                                const sp = parseSpatialCfg(text);
                                // Filter out skip-ops for display but keep all for chain
                                const realOps = sp.ops.filter(o => o.kind !== 'skip');
                                if (!realOps.length && !sp.eqFilters.length) {
                                    if (statusEl) statusEl.innerText = '⚠ Không tìm thấy op spatial hợp lệ (Psypan/QuickHaas/Wider).';
                                    cfgFileInput.value = ''; return;
                                }
                                CFG_STATE.spatialOps = sp.ops;   // ALL ops kể cả skip (để debug)
                                CFG_STATE.eqFilters  = sp.eqFilters;
                                CFG_STATE.preampDb   = sp.preampDb || 0;
                                CFG_STATE.compressor = sp.compressor;
                                const panCount  = sp.ops.filter(o => o.kind === 'pan').length;
                                const haasCount = sp.ops.filter(o => o.kind === 'haas').length;
                                const widerCount= sp.ops.filter(o => o.kind === 'wider').length;
                                const skipCount = sp.ops.filter(o => o.kind === 'skip').length;
                                const eqNote    = sp.eqFilters.length ? ' + ' + sp.eqFilters.length + ' EQ' : '';
                                const preNote   = sp.preampDb ? ' + Preamp ' + sp.preampDb + 'dB' : '';
                                if (statusEl) statusEl.innerText = '⏳ Spatial — Pan×' + panCount + ' Haas×' + haasCount + ' Wider×' + widerCount + (skipCount ? ' skip×' + skipCount : '') + eqNote + preNote + ' — đang kết nối…';
                            } else {
                                const parsed = parseCfgText(text);
                                const filters = parsed.filters;
                                if (!filters.length) {
                                    if (statusEl) statusEl.innerText = '⚠ Không tìm thấy Filter/EQ hợp lệ (cần định dạng APO Equalizer hoặc VST EQ hỗ trợ).';
                                    cfgFileInput.value = ''; return;
                                }
                                CFG_STATE.filters    = filters;
                                CFG_STATE.compressor = parsed.compressor;
                                CFG_STATE.preampDb   = parsed.preampDb || 0;
                                const compNote   = parsed.compressor ? ' + Comp' : '';
                                const preampNote = CFG_STATE.preampDb ? ' + Preamp ' + CFG_STATE.preampDb + 'dB' : '';
                                if (statusEl) statusEl.innerText = '⏳ APO EQ — ' + filters.length + ' band' + compNote + preampNote + ' — đang kết nối…';
                            }

                            CFG_STATE.active = true;
                            CFG_STATE.name   = file.name;
                            updateCfgUI();
                            logActivity('Nhập CFG [' + fmt.toUpperCase() + ']: ' + file.name + ' gain=' + CFG_STATE.preGain + 'x');
                            await Core.rebuildChain(statusEl);
                        } catch(err) {
                            if (statusEl) statusEl.innerText = '⚠ Lỗi: ' + (err && err.message);
                        } finally {
                            cfgFileInput.value = '';
                        }
                    };
                    reader.onerror = () => {
                        if (statusEl) statusEl.innerText = '⚠ Không đọc được file.';
                        cfgFileInput.value = '';
                    };
                    reader.readAsText(file);
                };
            }

            const cfgClearBtn = document.getElementById('cfg-clear-btn');
            if (cfgClearBtn) {
                cfgClearBtn.onclick = async () => {
                    if (!CFG_STATE.active) return;
                    const statusEl = document.getElementById('cfg-status');
                    CFG_STATE.active  = false;
                    CFG_STATE.name    = '';
                    CFG_STATE.filters = [];
                    CFG_STATE.compressor = null;
                    CFG_STATE.preampDb   = 0;
                    CFG_STATE.spatialOps = [];
                    CFG_STATE.eqFilters  = [];
                    updateCfgUI();
                    logActivity('Xoá CFG — khôi phục hook hiệu ứng');
                    await Core.rebuildChain(statusEl);
                };
            }

            // Account: reset button (same as kh-rst + clears saved state)
            document.getElementById('acc-reset').onclick = () => {
                document.getElementById('kh-rst').click();
                APP_STATE.log = []; APP_STATE.sysLog = [];
                saveState(); renderAutomation();
            };

            // Settings: theme toggle
            document.getElementById('theme-toggle').onchange = (e) => {
                APP_STATE.theme = e.target.checked ? 'light' : 'dark';
                this.applyTheme(); saveState();
            };

            // Settings: language switch
            document.querySelectorAll('#kh-lang-switch .kh-chip').forEach(b=>{
                b.onclick = () => {
                    APP_STATE.lang = b.dataset.lang;
                    this.applyLang(); saveState();
                };
            });

            // Settings: auto-restore toggle
            document.getElementById('autorestore-toggle').onchange = (e) => {
                APP_STATE.autoRestore = e.target.checked; saveState();
            };

            // Settings: clear log
            document.getElementById('set-clearlog').onclick = () => {
                APP_STATE.log = []; APP_STATE.sysLog = [];
                saveState(); renderAutomation();
            };

            // Drag (topbar as handle)
            const topbar=document.getElementById('kh-topbar');
            topbar.addEventListener('touchstart',e=>{const t=e.touches[0],r=this.el.getBoundingClientRect();this.dragging=true;this.ox=t.clientX-r.left;this.oy=t.clientY-r.top;},{passive:true});
            document.addEventListener('touchmove',e=>{if(!this.dragging)return;const t=e.touches[0];this.el.style.left=(t.clientX-this.ox)+'px';this.el.style.top=(t.clientY-this.oy)+'px';this.el.style.right='auto';},{passive:true});
            document.addEventListener('touchend',()=>{this.dragging=false;});
            topbar.addEventListener('mousedown',e=>{const r=this.el.getBoundingClientRect();this.dragging=true;this.ox=e.clientX-r.left;this.oy=e.clientY-r.top;e.preventDefault();});
            document.addEventListener('mousemove',e=>{if(!this.dragging)return;this.el.style.left=(e.clientX-this.ox)+'px';this.el.style.top=(e.clientY-this.oy)+'px';this.el.style.right='auto';});
            document.addEventListener('mouseup',()=>{this.dragging=false;});
        },
        css(){
            const s=document.createElement('style');
            s.textContent=`
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Rajdhani:wght@600;700&family=Share+Tech+Mono&display=swap');

#kh-root{
  --bg:#0b0a12; --bg2:#131120; --glass:rgba(24,20,38,0.62); --glass-hi:rgba(255,255,255,0.06);
  --border:rgba(255,255,255,0.09); --text:#f1eefc; --text-dim:#a9a4c4;
  --accent:#7c5cff; --accent2:#ff5f9e; --accent3:#00e0c6;
  --radius:16px; --radius-sm:10px;
  position:fixed;top:55px;right:14px;width:min(360px,92vw);max-height:88vh;
  background:linear-gradient(160deg,var(--bg) 0%,var(--bg2) 100%);
  border:1px solid var(--border);border-radius:var(--radius);
  z-index:2147483647;box-shadow:0 20px 60px rgba(0,0,0,0.55),0 0 0 1px rgba(124,92,255,0.08),inset 0 1px 0 rgba(255,255,255,0.04);
  font-family:'Inter',sans-serif;color:var(--text);
  backdrop-filter:blur(20px) saturate(140%);-webkit-backdrop-filter:blur(20px) saturate(140%);
  overflow:hidden;display:flex;
  opacity:0;transform:scale(0.92) translateY(-8px);
  transition:opacity .28s cubic-bezier(.2,.9,.25,1),transform .28s cubic-bezier(.2,.9,.25,1),width .25s ease;
}
#kh-root.kh-mounted{opacity:1;transform:scale(1) translateY(0);}
#kh-root[data-theme="light"]{
  --bg:#f5f3fb; --bg2:#ffffff; --glass:rgba(255,255,255,0.7); --glass-hi:rgba(0,0,0,0.03);
  --border:rgba(20,10,40,0.08); --text:#1c1830; --text-dim:#6a637f;
  box-shadow:0 20px 60px rgba(30,20,60,0.18),0 0 0 1px rgba(124,92,255,0.10);
}
#kh-root.kh-minimized{width:64px;}
#kh-root.kh-minimized #kh-main{display:none;}
#kh-root.kh-minimized #kh-sidebar{border-radius:var(--radius);}

/* ── Sidebar (icon rail) ── */
#kh-sidebar{width:64px;flex:0 0 64px;display:flex;flex-direction:column;align-items:center;
  padding:14px 0;background:var(--glass-hi);border-right:1px solid var(--border);gap:6px;}
#kh-logo{width:38px;height:38px;border-radius:12px;display:flex;align-items:center;justify-content:center;
  background:linear-gradient(135deg,var(--accent),var(--accent2));box-shadow:0 4px 18px rgba(124,92,255,0.45);
  margin-bottom:10px;font-size:18px;}
#kh-navrail{display:flex;flex-direction:column;gap:4px;flex:1;width:100%;align-items:center;}
.kh-nav-item{width:42px;height:42px;border-radius:12px;border:none;background:transparent;color:var(--text-dim);
  font-size:17px;cursor:pointer;display:flex;align-items:center;justify-content:center;
  transition:background .18s,color .18s,transform .12s;}
.kh-nav-item:hover{background:var(--glass-hi);color:var(--text);transform:translateY(-1px);}
.kh-nav-item.kh-nav-active{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;
  box-shadow:0 4px 16px rgba(124,92,255,0.4);}
#kh-col{width:30px;height:30px;border-radius:9px;border:1px solid var(--border);background:transparent;
  color:var(--text-dim);cursor:pointer;font-size:12px;margin-top:6px;transition:all .15s;}
#kh-col:hover{background:var(--glass-hi);color:var(--text);}

/* ── Main area ── */
#kh-main{flex:1;display:flex;flex-direction:column;min-width:0;}
#kh-topbar{display:flex;justify-content:space-between;align-items:center;padding:14px 16px 12px;
  cursor:grab;border-bottom:1px solid var(--border);}
#kh-topbar:active{cursor:grabbing;}
#kh-topbar-left{display:flex;align-items:center;gap:8px;}
#kh-tab-title{font-size:15px;font-weight:700;letter-spacing:.2px;}
#kh-tag{font-size:9px;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;
  padding:2px 6px;border-radius:6px;font-weight:700;}
#kh-badge{display:flex;align-items:center;gap:6px;background:var(--glass-hi);padding:4px 10px;border-radius:20px;
  border:1px solid var(--border);}
#kh-dot{width:7px;height:7px;border-radius:50%;background:#888;transition:all .3s;}
#kh-st{font-size:9px;color:var(--text-dim);font-family:'Share Tech Mono',monospace;letter-spacing:1px;}

#kh-content{padding:14px 16px 16px;overflow-y:auto;overflow-x:hidden;max-height:calc(88vh - 62px);}
#kh-content::-webkit-scrollbar{width:5px;}
#kh-content::-webkit-scrollbar-track{background:transparent;}
#kh-content::-webkit-scrollbar-thumb{background:var(--accent);border-radius:3px;}

.kh-tab{display:none;animation:khFadeUp .22s cubic-bezier(.2,.9,.25,1);}
.kh-tab.kh-tab-active{display:block;}
@keyframes khFadeUp{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:translateY(0);}}

/* ── Dashboard ── */
.kh-card-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px;}
.kh-stat-card{background:var(--glass);border:1px solid var(--border);border-radius:var(--radius-sm);
  padding:10px 8px;text-align:center;backdrop-filter:blur(8px);}
.kh-stat-label{font-size:9px;color:var(--text-dim);margin-bottom:4px;letter-spacing:.3px;}
.kh-stat-value{font-size:13px;font-weight:800;background:linear-gradient(135deg,var(--accent),var(--accent2));
  -webkit-background-clip:text;background-clip:text;color:transparent;}
.kh-notif{background:var(--glass);border:1px solid var(--border);border-radius:var(--radius-sm);
  padding:10px 12px;font-size:12px;margin-bottom:14px;}
.kh-section-title{font-size:11px;font-weight:700;color:var(--text-dim);letter-spacing:.5px;
  text-transform:uppercase;margin:10px 0 8px;}
.kh-loglist{display:flex;flex-direction:column;gap:6px;max-height:140px;overflow-y:auto;}
.kh-loglist-tall{max-height:180px;}
.kh-log-item{display:flex;gap:8px;font-size:11px;background:var(--glass);border:1px solid var(--border);
  border-radius:8px;padding:6px 10px;align-items:baseline;}
.kh-log-time{color:var(--accent3);font-family:'Share Tech Mono',monospace;font-size:9px;flex:0 0 auto;}
.kh-log-msg{color:var(--text-dim);}
.kh-log-empty{font-size:11px;color:var(--text-dim);text-align:center;padding:10px;opacity:.6;}

/* ── Generic cards (Automation/Account/Settings) ── */
.kh-card{background:var(--glass);border:1px solid var(--border);border-radius:var(--radius-sm);
  padding:12px 14px;margin-bottom:10px;backdrop-filter:blur(8px);}
.kh-card-title{font-size:11px;font-weight:700;color:var(--text-dim);letter-spacing:.4px;
  text-transform:uppercase;margin-bottom:8px;}
.kh-card-big{font-size:16px;font-weight:800;background:linear-gradient(135deg,var(--accent),var(--accent2));
  -webkit-background-clip:text;background-clip:text;color:transparent;margin-bottom:10px;}
.kh-toggle-row{display:flex;justify-content:space-between;align-items:center;font-size:11.5px;
  color:var(--text);padding:4px 0;}
.kh-kv{display:flex;justify-content:space-between;font-size:11.5px;color:var(--text-dim);padding:4px 0;}
.kh-kv span:last-child{color:var(--text);font-weight:600;}
.kh-btn-outline{width:100%;padding:10px;margin-top:4px;background:transparent;
  border:1px solid var(--border);color:var(--text);font-family:'Inter',sans-serif;font-size:12.5px;
  font-weight:600;border-radius:var(--radius-sm);cursor:pointer;transition:all .15s;}
.kh-btn-outline:hover{background:var(--glass-hi);border-color:var(--accent);}
#kh-lang-switch{display:flex;gap:6px;}

/* ── Search + filter chips ── */
.kh-search{width:100%;padding:9px 12px;margin-bottom:8px;background:var(--glass);
  border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);
  font-family:'Inter',sans-serif;font-size:12px;outline:none;transition:border-color .15s;}
.kh-search:focus{border-color:var(--accent);}
.kh-search::placeholder{color:var(--text-dim);}
#kh-filterchips{display:flex;gap:6px;margin-bottom:10px;}
.kh-chip{padding:5px 12px;background:var(--glass);border:1px solid var(--border);color:var(--text-dim);
  border-radius:20px;font-size:10.5px;font-weight:600;cursor:pointer;transition:all .15s;}
.kh-chip:hover{border-color:var(--accent);color:var(--text);}
.kh-chip.kh-chip-on{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;border-color:transparent;}

/* ── Preset buttons (Tools) ── */
#kh-presets{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;}
.kp-btn{flex:1 1 auto;padding:7px 9px;font-family:'Inter',sans-serif;font-size:11px;font-weight:600;
  background:var(--glass);border:1px solid var(--border);color:var(--text);border-radius:10px;
  cursor:pointer;letter-spacing:.2px;transition:all .15s;white-space:nowrap;}
.kp-btn:hover{border-color:var(--accent);transform:translateY(-1px);box-shadow:0 4px 12px rgba(124,92,255,.25);}
.kp-btn:active{transform:translateY(0);}
.kp-btn.kp-on{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;border-color:transparent;
  box-shadow:0 4px 16px rgba(124,92,255,.5);}
.kp-vangnuke{border-color:#ffff0088!important;color:#ffff00!important;animation:vangpulse 0.6s infinite alternate;}
.kp-vangnuke.kp-on{background:#333300!important;box-shadow:0 0 22px #ffff00cc!important;}
@keyframes vangpulse{from{box-shadow:0 0 6px #ffff0066;}to{box-shadow:0 0 18px #ffff00cc,0 0 35px #ffff0044;}}
.kp-apovang{border-color:#ff880088!important;color:#ffaa44!important;animation:apovangpulse 0.5s infinite alternate;}
.kp-apovang.kp-on{background:#ff4400!important;box-shadow:0 0 28px #ff8800cc,0 0 50px #ff550055!important;}
.kp-nuke{border-color:#ff00ff88!important;color:#ff88ff!important;}
.kp-nuke.kp-on{background:#990099!important;box-shadow:0 0 18px #ff00ffaa!important;}
.kp-mega{border-color:#00ffffff!important;color:#00ffff!important;animation:megapulse 0.8s infinite alternate;}
.kp-mega.kp-on{background:#003333!important;box-shadow:0 0 28px #00ffffff!important;}
@keyframes megapulse{from{box-shadow:0 0 8px #00ffff88;}to{box-shadow:0 0 22px #00ffffcc,0 0 40px #00ffff55;}}
@keyframes apovangpulse{from{box-shadow:0 0 10px #ff550088;}to{box-shadow:0 0 30px #ff8800cc,0 0 60px #ff550066;}}
.kp-ultimate{border:2px solid #ff0000!important;color:#fff!important;background:linear-gradient(135deg,#1a0000,#2a0000)!important;animation:ultimatepulse 0.4s infinite alternate;font-size:11px!important;width:100%!important;flex:1 1 100%!important;margin-top:3px!important;padding:8px!important;letter-spacing:2px!important;text-shadow:0 0 10px #ff0000;}
.kp-ultimate.kp-on{background:linear-gradient(135deg,#ff0000,#ff6600,#ffff00)!important;color:#000!important;box-shadow:0 0 40px #ff0000cc,0 0 80px #ff660066,0 0 120px #ffff0033!important;text-shadow:none!important;}
@keyframes ultimatepulse{from{box-shadow:0 0 10px #ff000088,0 0 20px #ff440044;}to{box-shadow:0 0 30px #ff0000cc,0 0 60px #ff6600aa,0 0 100px #ffff0066;border-color:#ffff00!important;}}
.kp-unuke-echo{border:2.5px solid #ff00ff!important;color:#fff!important;background:linear-gradient(135deg,#0a0022,#22002a)!important;animation:unukepulse 0.3s infinite alternate;font-size:11px!important;width:100%!important;flex:1 1 100%!important;margin-top:3px!important;padding:9px!important;letter-spacing:2px!important;text-shadow:0 0 12px #ff00ff,0 0 24px #ff0000;}
.kp-unuke-echo.kp-on{background:linear-gradient(135deg,#ff00ff,#ff0066,#ff0000,#ff6600)!important;color:#fff!important;box-shadow:0 0 60px #ff00ffcc,0 0 100px #ff0000aa,0 0 140px #ff660066!important;text-shadow:0 0 8px #fff,0 0 20px #ff00ff!important;}
@keyframes unukepulse{
  0%{box-shadow:0 0 15px #ff00ff99,0 0 30px #ff000066;border-color:#ff00ff!important;}
  50%{box-shadow:0 0 40px #ff0000cc,0 0 70px #ff00ffaa,0 0 100px #ff666644;border-color:#ff6600!important;}
  100%{box-shadow:0 0 25px #ffff00aa,0 0 60px #ff00ffcc,0 0 120px #ff000088;border-color:#ffff00!important;}
}

#ka-section{background:linear-gradient(160deg,rgba(0,240,255,0.12),rgba(124,92,255,0.08),rgba(255,51,136,0.05));
  border:1.5px solid var(--accent3);border-radius:var(--radius-sm);padding:14px 14px 12px;
  box-shadow:0 0 30px rgba(0,240,255,0.2),inset 0 0 25px rgba(0,240,255,0.08);margin-bottom:6px;
  position:relative;overflow:hidden;}
#ka-section::before{content:'';position:absolute;top:0;left:-100%;width:100%;height:100%;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,0.15),transparent);
  animation:kaShine 4s infinite;}
@keyframes kaShine{0%{left:-100%;}30%{left:200%;}100%{left:200%;}}
#ka-header{display:flex;justify-content:space-between;align-items:center;font-size:12px;font-weight:700;
  color:var(--accent3);letter-spacing:.5px;margin-bottom:10px;}
#ka-header small{display:inline-block;font-size:9.5px;font-weight:700;color:var(--accent3);margin-left:4px;}
#ka-active{font-size:9.5px;font-weight:700;font-family:'Share Tech Mono',monospace;background:rgba(0,240,255,.18);
  color:var(--accent3);padding:3px 9px;border-radius:12px;border:1px solid rgba(0,240,255,.5);white-space:nowrap;
  box-shadow:0 0 10px rgba(0,240,255,0.3);}
#ka-btns{display:flex;flex-direction:column;gap:7px;margin-bottom:10px;}
.ka-btn{width:100%;padding:11px 12px;font-family:'Inter',sans-serif;font-size:12px;font-weight:700;
  background:rgba(0,240,255,0.08);border:1.5px solid rgba(0,240,255,0.4);color:var(--text);
  border-radius:var(--radius-sm);cursor:pointer;letter-spacing:.3px;transition:all .2s ease;
  display:flex;align-items:center;justify-content:center;}
.ka-btn:hover{background:rgba(0,240,255,0.22);border-color:var(--accent3);transform:translateY(-2px);
  box-shadow:0 6px 20px rgba(0,240,255,0.35);}
.ka-btn.ka-on{background:linear-gradient(135deg,#00f0ff,#0099ff,#7c5cff);color:#020b18;border-color:#fff;
  box-shadow:0 6px 25px rgba(0,240,255,.6);text-shadow:none;font-weight:800;}
#ka-note{font-size:9.5px;color:var(--text-dim);text-align:center;letter-spacing:.3px;opacity:.9;font-weight:500;}

.kh-sep{height:1px;background:linear-gradient(90deg,transparent,var(--border),transparent);margin:12px 0;}
.kh-row{margin-bottom:11px;}
.kh-rowlabel{display:flex;justify-content:space-between;font-size:10.5px;font-weight:600;color:var(--text-dim);
  margin-bottom:5px;letter-spacing:.3px;}
.kh-rowlabel span:last-child{color:var(--text);font-family:'Share Tech Mono',monospace;font-size:10.5px;}
input[type=range]{-webkit-appearance:none;width:100%;height:5px;
  background:linear-gradient(90deg,var(--accent) var(--v,0%),var(--border) var(--v,0%));
  border-radius:3px;outline:none;}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:15px;height:15px;
  background:radial-gradient(circle,#fff,var(--accent));border-radius:50%;cursor:pointer;
  border:2px solid var(--accent2);box-shadow:0 2px 8px rgba(124,92,255,.6);}
#kh-echo-header,#kh-voice-header{display:flex;justify-content:space-between;align-items:center;
  font-size:11.5px;font-weight:700;color:var(--accent2);letter-spacing:.4px;margin-bottom:8px;}
#kh-noise-btns{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;}
.kn-btn{flex:1 1 auto;padding:5px 6px;font-family:'Inter',sans-serif;font-size:9px;font-weight:600;
  background:var(--glass);border:1px solid var(--border);color:var(--text-dim);border-radius:6px;
  cursor:pointer;letter-spacing:.2px;transition:all .15s;white-space:nowrap;}
.kn-btn:hover{border-color:var(--accent3);color:var(--text);}
.kn-btn.kn-on{background:var(--accent3);color:#001a18;border-color:transparent;}
#kh-voice-body{transition:opacity .2s;}
#kh-voice-presets{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:4px;}
.kv-btn{flex:1 1 auto;padding:7px 8px;font-family:'Inter',sans-serif;font-size:10.5px;font-weight:600;
  background:var(--glass);border:1px solid var(--border);color:var(--text-dim);border-radius:10px;
  cursor:pointer;letter-spacing:.2px;transition:all .15s;white-space:nowrap;}
.kv-btn:hover{border-color:var(--accent2);color:var(--text);}
.kv-btn.kv-on{background:linear-gradient(135deg,var(--accent2),var(--accent));color:#fff;border-color:transparent;
  box-shadow:0 4px 14px rgba(255,95,158,.4);}
.kh-toggle-wrap{position:relative;display:inline-block;cursor:pointer;}
.kh-toggle-wrap input{display:none;}
.kh-toggle-track{display:block;width:34px;height:18px;background:var(--glass);border:1px solid var(--border);
  border-radius:9px;transition:background .2s;}
.kh-toggle-wrap input:checked + .kh-toggle-track{background:linear-gradient(135deg,var(--accent),var(--accent2));
  border-color:transparent;}
.kh-toggle-thumb{position:absolute;top:3px;left:3px;width:12px;height:12px;border-radius:50%;
  background:var(--text-dim);transition:left .2s,background .2s;}
.kh-toggle-wrap input:checked + .kh-toggle-track .kh-toggle-thumb{left:19px;background:#fff;}
#kh-rst{width:100%;padding:10px;margin-top:2px;background:transparent;border:1px solid var(--border);
  color:var(--text);font-family:'Inter',sans-serif;font-size:12.5px;font-weight:700;border-radius:var(--radius-sm);
  cursor:pointer;letter-spacing:.5px;transition:all .15s;}
#kh-rst:hover{background:rgba(255,80,80,.12);border-color:#ff5050;color:#ff8080;}

@media (max-width:380px){
  #kh-root{width:94vw;right:3vw;}
}
`;
            document.head.appendChild(s);
        }
    };

    /* ══════════════ Renderers ══════════════ */
    function renderDashboard(){
        const engineVal = document.getElementById('dash-engine-val');
        const stEl = document.getElementById('kh-st');
        if (engineVal && stEl) engineVal.innerText = stEl.innerText;
        const modeVal = document.getElementById('dash-mode-val');
        if (modeVal) modeVal.innerText = apoActiveTier ? apoActiveTier.split(' – ')[0] : (APP_STATE.lastType==='preset' ? APP_STATE.lastKey : 'CLEAN');
        const hzVal = document.getElementById('dash-hz-val');
        if (hzVal) hzVal.innerText = (P.hzBoost>=0?'+':'')+P.hzBoost.toFixed(0)+'dB';
        const notif = document.getElementById('dash-notif');
        if (notif) {
            const live = stEl && (stEl.innerText==='LIVE' || stEl.innerText==='READY');
            notif.innerText = live ? T('dash_notif_ok') : T('dash_notif_wait');
        }
        const runVal = document.getElementById('auto-running-val');
        if (runVal) runVal.innerText = apoActiveTier || (APP_STATE.lastType==='preset' ? APP_STATE.lastKey : 'CLEAN');
        const list = document.getElementById('dash-recent-list');
        if (list) {
            list.innerHTML = APP_STATE.log.slice(0,5).map(item=>
                `<div class="kh-log-item"><span class="kh-log-time">${item.t}</span><span class="kh-log-msg">${item.msg}</span></div>`
            ).join('') || `<div class="kh-log-empty">${T('dash_empty')}</div>`;
        }
    }
    function renderAutomation(){
        const hist = document.getElementById('auto-history-list');
        if (hist) {
            hist.innerHTML = APP_STATE.log.map(item=>
                `<div class="kh-log-item"><span class="kh-log-time">${item.t}</span><span class="kh-log-msg">${item.msg}</span></div>`
            ).join('') || `<div class="kh-log-empty">${T('auto_empty')}</div>`;
        }
        const sys = document.getElementById('auto-syslog-list');
        if (sys) {
            sys.innerHTML = APP_STATE.sysLog.map(item=>
                `<div class="kh-log-item"><span class="kh-log-time">${item.t}</span><span class="kh-log-msg">${item.msg}</span></div>`
            ).join('') || `<div class="kh-log-empty">${T('auto_empty')}</div>`;
        }
    }

    if(document.readyState==='loading')
        document.addEventListener('DOMContentLoaded',()=>UI.init());
    else UI.init();

    window.ApoDSP = {
        P, VP, EP, DELAY_SPEECH, CFG_STATE, PRESETS, APO_TIERS,
        Core, UI, applyPreset, applyApoTier, applyVoicePreset,
        initCtx,
        get state() { return { P, VP, EP, DELAY_SPEECH, CFG_STATE, activeTier: apoActiveTier }; }
    };

    function setupUniversalFloatingBtn() {
        if (document.getElementById('kh-float-toggle')) return;
        const btn = document.createElement('div');
        btn.id = 'kh-float-toggle';
        btn.innerHTML = '⚡ MIC VIP';
        btn.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483646;background:linear-gradient(135deg,#7c5cff,#ff5f9e);color:#fff;font-family:sans-serif;font-size:12px;font-weight:bold;padding:8px 14px;border-radius:24px;box-shadow:0 4px 20px rgba(124,92,255,0.6);cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px;border:1px solid rgba(255,255,255,0.3);backdrop-filter:blur(10px);transition:transform 0.2s,box-shadow 0.2s;';
        btn.onclick = () => {
            const root = document.getElementById('kh-root');
            if (root) {
                if (root.style.display === 'none') {
                    root.style.display = 'flex';
                } else if (UI && UI.minimized) {
                    const col = document.getElementById('kh-col');
                    if (col) col.click();
                } else {
                    root.style.display = (root.style.display === 'none') ? 'flex' : 'none';
                }
            } else if (UI && UI.init) {
                UI.init();
            }
        };
        let isDragging = false, startX = 0, startY = 0;
        btn.addEventListener('touchstart', (e) => {
            isDragging = false;
            const t = e.touches[0];
            startX = t.clientX; startY = t.clientY;
        }, { passive: true });
        btn.addEventListener('touchmove', (e) => {
            const t = e.touches[0];
            if (Math.abs(t.clientX - startX) > 5 || Math.abs(t.clientY - startY) > 5) isDragging = true;
            if (isDragging) {
                btn.style.left = (t.clientX - 30) + 'px';
                btn.style.top = (t.clientY - 20) + 'px';
                btn.style.bottom = 'auto';
                btn.style.right = 'auto';
            }
        }, { passive: true });
        document.body.appendChild(btn);
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupUniversalFloatingBtn);
    } else {
        setupUniversalFloatingBtn();
    }

})();
