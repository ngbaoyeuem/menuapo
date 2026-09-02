// APO Crusher System-Wide iOS Hook (AudioToolbox / AudioUnit / mediaserverd)
// by Nguyen Hoang Gia Bao
#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <AudioToolbox/AudioToolbox.h>
#import <AVFoundation/AVFoundation.h>

extern void apo_process_audio_buffer(float *bufferL, float *bufferR, int frameCount);

// Function pointer for original AudioUnitRender
static OSStatus (*orig_AudioUnitRender)(AudioUnit inUnit,
                                      AudioUnitRenderActionFlags *ioActionFlags,
                                      const AudioTimeStamp *inTimeStamp,
                                      UInt32 inOutputBusNumber,
                                      UInt32 inNumberFrames,
                                      AudioBufferList *ioData);

// Hook AudioUnitRender (CoreAudio level hook across ALL apps)
static OSStatus hooked_AudioUnitRender(AudioUnit inUnit,
                                      AudioUnitRenderActionFlags *ioActionFlags,
                                      const AudioTimeStamp *inTimeStamp,
                                      UInt32 inOutputBusNumber,
                                      UInt32 inNumberFrames,
                                      AudioBufferList *ioData) {
    OSStatus status = orig_AudioUnitRender(inUnit, ioActionFlags, inTimeStamp, inOutputBusNumber, inNumberFrames, ioData);
    if (status == noErr && ioData != NULL) {
        // Intercept PCM buffers
        for (UInt32 i = 0; i < ioData->mNumberBuffers; i++) {
            AudioBuffer buf = ioData->mBuffers[i];
            if (buf.mData != NULL && buf.mDataByteSize > 0) {
                // If float32 PCM
                float *samples = (float *)buf.mData;
                int frameCount = buf.mDataByteSize / (sizeof(float) * buf.mNumberChannels);
                if (buf.mNumberChannels == 1) {
                    apo_process_audio_buffer(samples, NULL, frameCount);
                } else if (buf.mNumberChannels == 2) {
                    apo_process_audio_buffer(samples, samples + 1, frameCount);
                }
            }
        }
    }
    return status;
}

// Floating HUD Overlay Window (Appears over ALL apps)
@interface ApoFloatingWindow : UIWindow
@property (nonatomic, strong) UIButton *floatingButton;
@property (nonatomic, strong) UIView *menuView;
@end

@implementation ApoFloatingWindow
- (instancetype)initWithFrame:(CGRect)frame {
    self = [super initWithFrame:frame];
    if (self) {
        self.windowLevel = UIWindowLevelAlert + 1000.0;
        self.backgroundColor = [UIColor clearColor];
        self.hidden = NO;

        // Floating Pill Button
        self.floatingButton = [UIButton buttonWithType:UIButtonTypeCustom];
        self.floatingButton.frame = CGRectMake(frame.size.width - 90, frame.size.height / 2, 80, 36);
        self.floatingButton.backgroundColor = [UIColor colorWithRed:0.48 green:0.36 blue:1.0 alpha:0.9];
        [self.floatingButton setTitle:@"⚡ APO VIP" forState:UIControlStateNormal];
        self.floatingButton.titleLabel.font = [UIFont boldSystemFontOfSize:12];
        self.floatingButton.layer.cornerRadius = 18;
        self.floatingButton.layer.borderWidth = 1.5;
        self.floatingButton.layer.borderColor = [UIColor cyanColor].CGColor;
        self.floatingButton.layer.shadowColor = [UIColor cyanColor].CGColor;
        self.floatingButton.layer.shadowRadius = 8;
        self.floatingButton.layer.shadowOpacity = 0.8;
        [self.floatingButton addTarget:self action:@selector(toggleMenu) forControlEvents:UIControlEventTouchUpInside];
        [self addSubview:self.floatingButton];

        UIPanGestureRecognizer *pan = [[UIPanGestureRecognizer alloc] initWithTarget:self action:@selector(handlePan:)];
        [self.floatingButton addGestureRecognizer:pan];
    }
    return self;
}

- (void)handlePan:(UIPanGestureRecognizer *)pan {
    CGPoint translation = [pan translationInView:self];
    CGPoint center = self.floatingButton.center;
    self.floatingButton.center = CGPointMake(center.x + translation.x, center.y + translation.y);
    [pan setTranslation:CGPointZero inView:self];
}

- (void)toggleMenu {
    // Switch between VIP Tiers (Nhẹ -> Vừa -> Xịn Max -> VIP Pro -> Nuke)
    static int currentTier = 0;
    currentTier = (currentTier + 1) % 5;
    NSArray *titles = @[@"🌟 NHẸ", @"⚡ VỪA", @"💎 XỊN MAX", @"👑 VIP PRO", @"☢️ NUKE"];
    [self.floatingButton setTitle:titles[currentTier] forState:UIControlStateNormal];
}
@end

static ApoFloatingWindow *g_overlay = nil;

__attribute__((constructor))
static void initialize_apo_crusher() {
    NSLog(@"[APO CRUSHER v38] System-wide Audio Hook Initialized into PID: %d", getpid());
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if (!g_overlay && [UIApplication sharedApplication].keyWindow) {
            g_overlay = [[ApoFloatingWindow alloc] initWithFrame:[UIScreen mainScreen].bounds];
        }
    });
}
