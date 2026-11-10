<template>
  <view v-if="processing || outputs.length > 0 || errorMessage" class="result-card">
    <!-- Processing state -->
    <view v-if="processing" class="progress-wrap">
      <view class="progress-top">
        <text class="stage-text">{{ stageText }}</text>
        <text class="pct-text">{{ progress }}%</text>
      </view>
      <view class="progress-track">
        <view class="progress-fill" :style="{ width: `${progress}%` }"></view>
      </view>
    </view>

    <!-- Error state -->
    <view v-else-if="errorMessage" class="error-box">
      <text class="err-title">{{ isComplianceError ? '🛡️ 内容合规安全拦截' : '⚠️ 处理失败' }}</text>
      <text class="err-msg">{{ errorMessage }}</text>
    </view>

    <!-- Completed state -->
    <view v-else-if="outputs.length > 0" class="done-box">
      <view class="done-header">
        <view>
          <text class="done-title">✅ 处理完成（共 {{ outputs.length }} 个文件）</text>
          <text v-if="compressionSummary" class="done-sub">{{ compressionSummary }}</text>
        </view>
        <view v-if="imageOutputs.length > 1" class="batch-btn" @click="saveAll">
          一键保存全部
        </view>
      </view>

      <!-- Image Grid Preview -->
      <view
        v-if="imageOutputs.length > 0"
        class="img-grid"
        :class="{
          single: imageOutputs.length === 1,
          'cols-3': imageOutputs.length === 9,
          'cols-2': imageOutputs.length > 1 && imageOutputs.length !== 9,
        }"
      >
        <view v-for="(img, idx) in imageOutputs" :key="img.fileId" class="img-cell">
          <view class="preview-wrap" @click="previewOutputImage(idx)">
            <image
              :src="resolvePreviewUrl(img)"
              mode="aspectFit"
              class="preview-img"
            />
            <view v-if="imageOutputs.length > 1" class="page-badge">
              {{ idx + 1 }}/{{ imageOutputs.length }}
            </view>
          </view>
          <view class="img-meta">
            <view class="img-name">{{ img.fileName }}</view>
            <view class="img-size">{{ formatBytes(img.size) }}{{ imageOutputs.length === 1 ? ' · 点击图片可放大预览' : '' }}</view>
          </view>
          <view class="img-actions">
            <view class="mini-btn primary" @click="saveOrDownloadOutput(img)">保存</view>
            <view class="mini-btn" @click="shareOutputToFriend(img)">分享</view>
          </view>
        </view>
      </view>

      <!-- Non-image Output List (PDF / Word / Audio / Video) -->
      <view v-if="nonImageOutputs.length > 0" class="doc-list">
        <view v-for="file in nonImageOutputs" :key="file.fileId" class="doc-wrap">
          <view class="doc-row">
            <view class="doc-icon">{{ resolveDocIcon(file) }}</view>
            <view class="doc-info">
              <view class="doc-name">{{ file.fileName }}</view>
              <view class="doc-size">{{ formatBytes(file.size) }}</view>
            </view>
            <view class="doc-actions">
              <view
                v-if="file.mimeType.startsWith('audio/')"
                class="mini-btn play"
                @click="toggleAudioPreview(file)"
              >
                {{ playingFileId === file.fileId ? '⏸ 暂停' : '▶ 试听' }}
              </view>
              <view class="mini-btn primary" @click="saveOrDownloadOutput(file)">
                {{ isPreviewableDoc(file) ? '预览/保存' : '保存/导出' }}
              </view>
              <view class="mini-btn" @click="shareOutputToFriend(file)">发好友</view>
            </view>
          </view>

          <!-- Inline video player for compressed MP4 -->
          <video
            v-if="file.mimeType.startsWith('video/') && canDirectMediaPreview(file)"
            :src="resolvePreviewUrl(file)"
            controls
            class="video-preview"
          />
        </view>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { isComplianceBlockMessage, type OutputFileRef } from '@tool-universal/shared';
import {
  formatBytes,
  saveAllImagesBatch,
  saveOrDownloadOutput,
  shareOutputToFriend,
} from '@/utils/fileBridge';
import { buildDownloadableUrl, downloadOutputToLocalPath } from '@/utils/request';

const props = defineProps<{
  processing: boolean;
  progress: number;
  stageText: string;
  outputs: OutputFileRef[];
  errorMessage?: string;
  originalTotalSize?: number;
}>();

const isComplianceError = computed(() => isComplianceBlockMessage(props.errorMessage));

const playingFileId = ref<string | null>(null);
let audioCtx: UniApp.InnerAudioContext | null = null;

onUnmounted(() => {
  if (audioCtx) {
    audioCtx.stop();
    audioCtx.destroy();
    audioCtx = null;
  }
});

const imageOutputs = computed(() =>
  props.outputs.filter((o) => o.mimeType.startsWith('image/'))
);

const nonImageOutputs = computed(() =>
  props.outputs.filter((o) => !o.mimeType.startsWith('image/'))
);

const compressionSummary = computed(() => {
  if (!props.originalTotalSize || props.outputs.length === 0) return '';
  const outTotal = props.outputs.reduce((s, o) => s + o.size, 0);
  if (outTotal <= 0 || props.originalTotalSize <= 0) return '';
  const savedPct = Math.round(((props.originalTotalSize - outTotal) / props.originalTotalSize) * 100);
  if (savedPct > 0) {
    return `体积 ${formatBytes(props.originalTotalSize)} → ${formatBytes(outTotal)}（瘦身 ${savedPct}%）`;
  }
  return `输出总大小 ${formatBytes(outTotal)}`;
});

function isWordDoc(file: OutputFileRef): boolean {
  return (
    file.mimeType.includes('wordprocessingml') ||
    file.mimeType === 'application/msword' ||
    /\.(docx|doc)$/i.test(file.fileName)
  );
}

function isPreviewableDoc(file: OutputFileRef): boolean {
  return file.mimeType === 'application/pdf' || isWordDoc(file);
}

function resolveDocIcon(file: OutputFileRef): string {
  if (file.mimeType.includes('pdf')) return '📑';
  if (isWordDoc(file)) return '📝';
  if (file.mimeType.startsWith('audio')) return '🎵';
  return '🎬';
}

function resolvePreviewUrl(output: OutputFileRef): string {
  return buildDownloadableUrl(output);
}

function canDirectMediaPreview(output: OutputFileRef): boolean {
  const url = resolvePreviewUrl(output);
  return Boolean(url) && !url.startsWith('cloud://');
}

async function toggleAudioPreview(file: OutputFileRef) {
  if (playingFileId.value === file.fileId && audioCtx) {
    audioCtx.stop();
    playingFileId.value = null;
    return;
  }

  try {
    if (audioCtx) {
      audioCtx.stop();
      audioCtx.destroy();
    }
    const playableSrc = file.source === 'cloudbase' ? await downloadOutputToLocalPath(file) : resolvePreviewUrl(file);
    audioCtx = uni.createInnerAudioContext();
    audioCtx.src = playableSrc;
    audioCtx.onEnded(() => {
      playingFileId.value = null;
    });
    audioCtx.onError(() => {
      playingFileId.value = null;
      uni.showToast({ title: '音频试听失败，请直接保存后播放', icon: 'none' });
    });
    playingFileId.value = file.fileId;
    audioCtx.play();
  } catch {
    playingFileId.value = null;
    uni.showToast({ title: '加载音频失败', icon: 'none' });
  }
}

function previewOutputImage(idx: number) {
  const urls = imageOutputs.value.map((i) => resolvePreviewUrl(i));
  if (!urls[idx] || urls[idx].startsWith('cloud://')) {
    saveOrDownloadOutput(imageOutputs.value[idx]);
    return;
  }
  uni.previewImage({
    urls,
    current: urls[idx],
  });
}

function saveAll() {
  saveAllImagesBatch(imageOutputs.value);
}
</script>

<style lang="scss" scoped>
.result-card {
  background: #ffffff;
  border-radius: 26rpx;
  padding: 26rpx;
  box-shadow: 0 6rpx 20rpx rgba(30, 64, 130, 0.05);
  margin-top: 24rpx;
}

.progress-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14rpx;
}

.stage-text {
  font-size: 26rpx;
  color: #1e293b;
  font-weight: 500;
}

.pct-text {
  font-size: 26rpx;
  font-weight: 700;
  color: #2563eb;
}

.progress-track {
  height: 14rpx;
  background: #e2e8f0;
  border-radius: 999rpx;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #3b82f6 0%, #2563eb 100%);
  border-radius: 999rpx;
  transition: width 0.25s ease;
}

.error-box {
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 18rpx;
  padding: 20rpx;
  display: flex;
  flex-direction: column;
  gap: 8rpx;
}

.err-title {
  font-size: 28rpx;
  font-weight: 700;
  color: #dc2626;
}

.err-msg {
  font-size: 24rpx;
  color: #7f1d1d;
  line-height: 1.5;
}

.done-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12rpx;
  margin-bottom: 20rpx;
}

.done-title {
  display: block;
  font-size: 28rpx;
  font-weight: 700;
  color: #15803d;
}

.done-sub {
  display: block;
  margin-top: 6rpx;
  font-size: 23rpx;
  color: #2563eb;
  font-weight: 500;
}

.batch-btn {
  padding: 10rpx 22rpx;
  border-radius: 999rpx;
  background: #2563eb;
  color: #ffffff;
  font-size: 23rpx;
  font-weight: 600;
  flex-shrink: 0;
}

.img-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16rpx;
  width: 100%;

  &.cols-2 {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  &.cols-3 {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12rpx;

    .preview-img {
      height: 170rpx;
    }

    .mini-btn {
      padding: 8rpx 6rpx;
      font-size: 20rpx;
    }
  }

  &.single {
    grid-template-columns: minmax(0, 1fr);

    .preview-img {
      height: 480rpx;
    }
  }
}

.img-cell {
  min-width: 0;
  overflow: hidden;
  box-sizing: border-box;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 16rpx;
  padding: 10rpx;
  display: flex;
  flex-direction: column;
  gap: 8rpx;
}

.preview-wrap {
  position: relative;
  width: 100%;
  border-radius: 10rpx;
  background: #eef2f6;
  overflow: hidden;
}

.preview-img {
  display: block;
  width: 100%;
  height: 220rpx;
  background: #eef2f6;
}

.page-badge {
  position: absolute;
  right: 8rpx;
  bottom: 8rpx;
  padding: 3rpx 10rpx;
  border-radius: 999rpx;
  background: rgba(15, 23, 42, 0.72);
  color: #ffffff;
  font-size: 19rpx;
  font-weight: 600;
  line-height: 1.3;
}

.img-meta {
  min-width: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 2rpx;
}

.img-name {
  display: block;
  width: 100%;
  font-size: 21rpx;
  color: #334155;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.img-size {
  font-size: 19rpx;
  color: #94a3b8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.img-actions,
.doc-actions {
  display: flex;
  gap: 8rpx;
  flex-wrap: wrap;
}

.mini-btn {
  flex: 1;
  min-width: 0;
  text-align: center;
  padding: 8rpx 12rpx;
  border-radius: 10rpx;
  background: #e2e8f0;
  color: #334155;
  font-size: 22rpx;
  font-weight: 600;
  white-space: nowrap;

  &.primary {
    background: #2563eb;
    color: #ffffff;
  }

  &.play {
    background: #eafaf1;
    color: #15803d;
  }
}

.doc-list {
  display: flex;
  flex-direction: column;
  gap: 14rpx;
}

.doc-wrap {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 18rpx;
  padding: 18rpx;
}

.doc-row {
  display: flex;
  align-items: center;
  gap: 16rpx;
}

.doc-icon {
  font-size: 42rpx;
  flex-shrink: 0;
}

.doc-info {
  flex: 1;
  min-width: 0;
}

.doc-name {
  font-size: 26rpx;
  font-weight: 600;
  color: #1e293b;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.doc-size {
  font-size: 22rpx;
  color: #94a3b8;
  margin-top: 4rpx;
}

.video-preview {
  width: 100%;
  height: 360rpx;
  margin-top: 16rpx;
  border-radius: 12rpx;
  background: #0f172a;
}
</style>
