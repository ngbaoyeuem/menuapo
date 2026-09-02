// APO Crusher Ultra-Low-Latency DSP Engine in C
// by Nguyen Hoang Gia Bao
#include <math.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    float preGain;
    float drive;
    float crush;
    float width;
    float postGain;
    float hzBoost;
    float limL;
    float limR;
    int isVipActive;
} ApoDSPState;

static ApoDSPState g_dsp = {
    .preGain = 50.0f,     // Default: VIP Vừa - Dày Giọng Rõ
    .drive = 0.0f,
    .crush = 0.0f,
    .width = 0.0f,
    .postGain = 12.0f,
    .hzBoost = 7.0f,
    .limL = 1.0f,
    .limR = 1.0f,
    .isVipActive = 1
};

static inline float apo_sat(float x, float k) {
    if (k < 0.001f) return x;
    float d = k * 20.0f;
    return atanf(x * d) / atanf(d);
}

static inline float apo_hardclip(float x, float th) {
    if (x > th) return th;
    if (x < -th) return -th;
    return x;
}

void apo_process_audio_buffer(float *bufferL, float *bufferR, int frameCount) {
    if (!bufferL) return;
    float pre = g_dsp.preGain;
    float drv = g_dsp.drive;
    float crs = g_dsp.crush;
    float w   = g_dsp.width;
    float post= g_dsp.postGain;
    float th  = 1.0f - crs * 0.98f;
    if (th < 0.001f) th = 0.001f;

    for (int i = 0; i < frameCount; i++) {
        float L = bufferL[i] * pre;
        float R = bufferR ? (bufferR[i] * pre) : L;

        L = apo_sat(L, drv);
        R = apo_sat(R, drv);

        if (crs > 0.001f) {
            L = apo_hardclip(L, th) / th;
            R = apo_hardclip(R, th) / th;
            L = apo_sat(L, drv * 0.5f + 0.3f);
            R = apo_sat(R, drv * 0.5f + 0.3f);
        }

        if (w > 0.001f) {
            float mid = (L + R) * 0.5f;
            float side = (L - R) * 0.5f * (1.0f + w * 2.0f);
            L = mid + side;
            R = mid - side;
        }

        // Limiter Protection
        float absL = fabsf(L);
        if (absL > 1.0f && absL > g_dsp.limL) g_dsp.limL = absL;
        g_dsp.limL *= 0.9998f;
        if (g_dsp.limL < 1.0f) g_dsp.limL = 1.0f;
        L = L / g_dsp.limL;

        float absR = fabsf(R);
        if (absR > 1.0f && absR > g_dsp.limR) g_dsp.limR = absR;
        g_dsp.limR *= 0.9998f;
        if (g_dsp.limR < 1.0f) g_dsp.limR = 1.0f;
        R = R / g_dsp.limR;

        L *= post;
        R *= post;

        if (drv < 0.001f && crs < 0.001f) {
            if (L > 0.99f) L = 0.99f; else if (L < -0.99f) L = -0.99f;
            if (R > 0.99f) R = 0.99f; else if (R < -0.99f) R = -0.99f;
        } else {
            L = apo_sat(L, 0.35f) * 0.98f;
            R = apo_sat(R, 0.35f) * 0.98f;
        }

        bufferL[i] = L;
        if (bufferR) bufferR[i] = R;
    }
}
