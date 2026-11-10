<template>
  <view class="ws-panel">
    <view class="ws-section-title">音视频转码参数</view>

    <!-- 1. 音频格式互转 / 视频提取音频 -->
    <template v-if="tool.id === 'audio-convert' || tool.id === 'video-extract-audio'">
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">导出音频格式</text></view>
        <view class="ws-chips">
          <view v-for="fmt in audioFormats" :key="fmt" class="ws-chip" :class="{ active: audioFormat === fmt }" @click="audioFormat = fmt">
            {{ fmt.toUpperCase() }}
          </view>
        </view>
      </view>
      <view v-if="audioFormat !== 'wav'" class="ws-field">
        <view class="ws-label-row"><text class="ws-label">音质比特率</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: bitrate === '128k' }" @click="bitrate = '128k'">128 kbps（标准）</view>
          <view class="ws-chip" :class="{ active: bitrate === '192k' }" @click="bitrate = '192k'">192 kbps（高音质）</view>
          <view class="ws-chip" :class="{ active: bitrate === '320k' }" @click="bitrate = '320k'">320 kbps（无损感）</view>
        </view>
      </view>
      <view class="ws-hint">
        通过云托管 FFmpeg 音频引擎无损剥离与重编码，完美支持 MP3 / WAV / M4A / AAC，兼容微信好友直接播放与转发。
      </view>
    </template>

    <!-- 2. 视频转码与压缩 -->
    <template v-else-if="tool.id === 'video-compress'">
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">转码压缩引擎</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: videoEngine === 'cloud' }" @click="videoEngine = 'cloud'">☁️ 云端 FFmpeg（MOV转MP4）</view>
          <view class="ws-chip" :class="{ active: videoEngine === 'local' }" @click="videoEngine = 'local'">⚡ 微信本地极速压缩</view>
        </view>
      </view>

      <template v-if="videoEngine === 'cloud'">
        <view class="ws-field">
          <view class="ws-label-row"><text class="ws-label">输出分辨率</text></view>
          <view class="ws-chips">
            <view class="ws-chip" :class="{ active: resolution === 'original' }" @click="resolution = 'original'">保持原画</view>
            <view class="ws-chip" :class="{ active: resolution === '1080p' }" @click="resolution = '1080p'">1080P</view>
            <view class="ws-chip" :class="{ active: resolution === '720p' }" @click="resolution = '720p'">720P（推荐）</view>
            <view class="ws-chip" :class="{ active: resolution === '480p' }" @click="resolution = '480p'">480P（极小）</view>
          </view>
        </view>
        <view class="ws-field">
          <view class="ws-label-row"><text class="ws-label">压缩强度</text></view>
          <view class="ws-chips">
            <view class="ws-chip" :class="{ active: crf === 22 }" @click="crf = 22">画质优先 (CRF 22)</view>
            <view class="ws-chip" :class="{ active: crf === 26 }" @click="crf = 26">均衡推荐 (CRF 26)</view>
            <view class="ws-chip" :class="{ active: crf === 30 }" @click="crf = 30">极限瘦身 (CRF 30)</view>
          </view>
        </view>
      </template>
      <view v-else class="ws-hint">
        调用微信客户端内置视频压缩器（仅支持小程序端已有的 MP4 常见视频；若是苹果 MOV 或需要强制转 MP4，请切换回云端 FFmpeg 引擎）。
      </view>
    </template>

    <!-- 3. 视频转 GIF 动图 -->
    <template v-else-if="tool.id === 'video-to-gif'">
      <view v-if="files.length > 0 && files[0].path" class="ws-field">
        <view class="ws-label-row">
          <text class="ws-label">原视频预览（可拖动进度条查看时间点）</text>
        </view>
        <video :src="files[0].path" controls class="gif-source-video" />
      </view>

      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">截取片段模式</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: gifDurationPreset === 3 }" @click="selectDurationPreset(3)">
            3 秒（表情包）
          </view>
          <view class="ws-chip" :class="{ active: gifDurationPreset === 5 }" @click="selectDurationPreset(5)">
            5 秒（推荐）
          </view>
          <view class="ws-chip" :class="{ active: gifDurationPreset === 10 }" @click="selectDurationPreset(10)">
            10 秒片段
          </view>
          <view class="ws-chip" :class="{ active: gifDurationPreset === 0 }" @click="selectDurationPreset(0)">
            整段导出（≤20秒）
          </view>
        </view>
      </view>

      <view class="ws-field">
        <view class="gif-time-grid">
          <view class="gif-time-col">
            <view class="ws-label-row">
              <text class="ws-label">起始时间（秒）</text>
            </view>
            <input
              v-model="gifStartSecInput"
              type="digit"
              class="ws-input"
              placeholder="默认 0"
            />
          </view>
          <view class="gif-time-col">
            <view class="ws-label-row">
              <text class="ws-label">截取时长（秒）</text>
            </view>
            <input
              v-model="gifDurationSecInput"
              type="digit"
              class="ws-input"
              placeholder="0 表示整段≤20秒"
              @input="onManualDurationInput"
            />
          </view>
        </view>
      </view>

      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">输出画面宽度</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: gifWidth === 240 }" @click="gifWidth = 240">240 px（极小表情）</view>
          <view class="ws-chip" :class="{ active: gifWidth === 320 }" @click="gifWidth = 320">320 px（微信推荐）</view>
          <view class="ws-chip" :class="{ active: gifWidth === 480 }" @click="gifWidth = 480">480 px（高清）</view>
          <view class="ws-chip" :class="{ active: gifWidth === 640 }" @click="gifWidth = 640">640 px（超清）</view>
        </view>
      </view>

      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">动图流畅度（帧率 FPS）</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: gifFps === 8 }" @click="gifFps = 8">8 FPS（省体积）</view>
          <view class="ws-chip" :class="{ active: gifFps === 10 }" @click="gifFps = 10">10 FPS（均衡）</view>
          <view class="ws-chip" :class="{ active: gifFps === 15 }" @click="gifFps = 15">15 FPS（丝滑）</view>
        </view>
      </view>

      <view class="ws-hint">
        采用 FFmpeg 专属调色盘优化算法生成高清无杂色 GIF 动图。生成后支持直接预览、保存相册或点击「分享」发送给微信好友保存为动态表情。
      </view>
    </template>
  </view>

  <button class="tu-primary-btn" :disabled="files.length === 0 || processing" @click="startConvert">
    {{ processing ? '正在转码处理中...' : tool.id === 'video-to-gif' ? '开始生成 GIF 动图' : '开始音视频处理' }}
  </button>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import type { OutputFileRef, ToolMeta, ToolParams } from '@tool-universal/shared';
import { executeCloudToolTask, type LocalPickedFile } from '@/utils/request';

const props = defineProps<{
  tool: ToolMeta;
  files: LocalPickedFile[];
  processing: boolean;
}>();

const emit = defineEmits<{
  (e: 'start'): void;
  (e: 'progress', progress: number, stageText: string): void;
  (e: 'done', outputs: OutputFileRef[], mode: 'local' | 'cloud'): void;
  (e: 'error', msg: string): void;
}>();

const audioFormats = ['mp3', 'wav', 'm4a', 'aac'] as const;
const audioFormat = ref<'mp3' | 'wav' | 'm4a' | 'aac'>('mp3');
const bitrate = ref<'128k' | '192k' | '320k'>('192k');

const videoEngine = ref<'cloud' | 'local'>('cloud');
const resolution = ref<'original' | '1080p' | '720p' | '480p'>('720p');
const crf = ref(26);

const gifWidth = ref<number>(480);
const gifFps = ref<number>(10);
const gifDurationPreset = ref<number | null>(5);
const gifStartSecInput = ref('0');
const gifDurationSecInput = ref('5');

function selectDurationPreset(sec: number) {
  gifDurationPreset.value = sec;
  gifDurationSecInput.value = String(sec);
}

function onManualDurationInput() {
  const n = Number(gifDurationSecInput.value);
  if ([0, 3, 5, 10].includes(n) && gifDurationSecInput.value.trim() !== '') {
    gifDurationPreset.value = n;
  } else {
    gifDurationPreset.value = null;
  }
}

async function compressVideoLocally(file: LocalPickedFile): Promise<OutputFileRef[]> {
  // #ifdef MP-WEIXIN
  return new Promise<OutputFileRef[]>((resolve, reject) => {
    uni.compressVideo({
      src: file.path,
      quality: 'medium',
      success: (res) => {
        resolve([
          {
            fileId: res.tempFilePath,
            fileName: `${file.name.replace(/\.[^.]+$/, '')}_本地压缩.mp4`,
            size: Number(res.size || 0) * 1024,
            mimeType: 'video/mp4',
            downloadUrl: res.tempFilePath,
            source: 'local',
            previewableImage: false,
          },
        ]);
      },
      fail: (err) => reject(new Error(err?.errMsg || '本地视频压缩失败')),
    });
  });
  // #endif

  // #ifndef MP-WEIXIN
  throw new Error('H5 浏览器环境不支持本地视频压缩，请切换回「云端 FFmpeg」引擎');
  // #endif
}

async function startConvert() {
  if (props.files.length === 0) return;
  emit('start');

  try {
    if (props.tool.id === 'video-compress' && videoEngine.value === 'local') {
      emit('progress', 45, '正在调用手机本地视频压缩器...');
      const outputs = await compressVideoLocally(props.files[0]);
      emit('done', outputs, 'local');
      return;
    }

    let params: ToolParams;
    if (props.tool.id === 'video-to-gif') {
      const startSec = Number(gifStartSecInput.value.trim() || '0');
      const durationSec = Number(gifDurationSecInput.value.trim() || '5');
      if (!Number.isFinite(startSec) || startSec < 0) {
        emit('error', '请输入大于或等于 0 的起始秒数');
        return;
      }
      if (!Number.isFinite(durationSec) || durationSec < 0) {
        emit('error', '请输入有效的截取秒数（0 表示整段≤20秒）');
        return;
      }
      params = {
        gifStartSec: startSec,
        gifDurationSec: durationSec,
        gifFps: gifFps.value,
        gifWidth: gifWidth.value,
      };
    } else {
      params = {
        audioFormat: audioFormat.value,
        bitrate: bitrate.value,
        resolution: resolution.value,
        crf: crf.value,
      };
    }

    const task = await executeCloudToolTask(props.tool.id, props.files, params, (p, s) => {
      emit('progress', p, s);
    });
    emit('done', task.outputs, 'cloud');
  } catch (err: any) {
    emit('error', err?.message || '音视频处理失败');
  }
}
</script>

<style lang="scss" scoped>
@use './workspace.scss' as *;

.gif-source-video {
  width: 100%;
  height: 320rpx;
  border-radius: 16rpx;
  background: #0f172a;
}

.gif-time-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16rpx;
}

.gif-time-col {
  min-width: 0;
}
</style>
