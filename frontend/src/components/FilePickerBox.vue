<template>
  <view class="picker-card">
    <view class="dropzone" hover-class="dropzone--hover" @click="handlePick">
      <view class="drop-icon">+</view>
      <view class="drop-title">
        {{ files.length > 0 && tool.multiple ? '继续添加文件' : `点击选择${acceptLabel}` }}
      </view>
      <view class="drop-sub">
        支持 {{ tool.extensions.map((e) => e.toUpperCase()).join(' / ') }}
        <text v-if="tool.multiple">（最多 {{ tool.maxFiles }} 份，可排序）</text>
      </view>
    </view>

    <view v-if="files.length > 0" class="file-list">
      <view class="list-header">
        <text class="list-count">已选 {{ files.length }} 个文件</text>
        <text class="clear-btn" @click="clearAll">清空重选</text>
      </view>

      <view v-for="(item, idx) in files" :key="item.id" class="file-row">
        <image
          v-if="isImageFile(item)"
          :src="item.path"
          mode="aspectFill"
          class="thumb"
          @click="previewImage(item.path)"
        />
        <view v-else class="file-badge-icon">{{ nonImageIcon }}</view>

        <view class="file-info">
          <view class="file-name">{{ item.name }}</view>
          <view class="file-size">{{ formatBytes(item.size) }}</view>
        </view>

        <view class="file-actions">
          <view v-if="tool.multiple && idx > 0" class="act-btn" @click="moveUp(idx)">↑</view>
          <view v-if="tool.multiple && idx < files.length - 1" class="act-btn" @click="moveDown(idx)">↓</view>
          <view class="act-btn danger" @click="removeAt(idx)">×</view>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { ToolMeta } from '@tool-universal/shared';
import { formatBytes, pickFilesForTool } from '@/utils/fileBridge';
import type { LocalPickedFile } from '@/utils/request';

const props = defineProps<{
  tool: ToolMeta;
  files: LocalPickedFile[];
}>();

const emit = defineEmits<{
  (e: 'update:files', files: LocalPickedFile[]): void;
}>();

const acceptLabel = computed(() => {
  if (props.tool.acceptTypes.includes('image') && props.tool.acceptTypes.length === 1) return '图片';
  if (props.tool.acceptTypes.includes('video')) return '视频文件';
  if (props.tool.acceptTypes.includes('audio')) return '音频文件';
  if (props.tool.acceptTypes.includes('pdf') && props.tool.acceptTypes.length === 1) return 'PDF 文档';
  return '文档或文件';
});

const nonImageIcon = computed(() => {
  if (props.tool.acceptTypes.includes('video')) return '🎬';
  if (props.tool.acceptTypes.includes('audio')) return '🎵';
  if (props.tool.acceptTypes.includes('pdf')) return '📑';
  return '📄';
});

function isImageFile(file: LocalPickedFile): boolean {
  if (file.mimeType?.startsWith('image/')) return true;
  return /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name) || props.tool.acceptTypes.includes('image');
}

async function handlePick() {
  try {
    const picked = await pickFilesForTool(props.tool);
    if (!picked.length) return;
    if (props.tool.multiple) {
      const merged = [...props.files, ...picked].slice(0, props.tool.maxFiles);
      emit('update:files', merged);
    } else {
      emit('update:files', [picked[0]]);
    }
  } catch (err: any) {
    uni.showToast({ title: err?.message || '选择文件失败', icon: 'none' });
  }
}

function previewImage(src: string) {
  uni.previewImage({ urls: [src], current: src });
}

function moveUp(idx: number) {
  if (idx <= 0) return;
  const copy = [...props.files];
  [copy[idx - 1], copy[idx]] = [copy[idx], copy[idx - 1]];
  emit('update:files', copy);
}

function moveDown(idx: number) {
  if (idx >= props.files.length - 1) return;
  const copy = [...props.files];
  [copy[idx], copy[idx + 1]] = [copy[idx + 1], copy[idx]];
  emit('update:files', copy);
}

function removeAt(idx: number) {
  const copy = props.files.filter((_, i) => i !== idx);
  emit('update:files', copy);
}

function clearAll() {
  emit('update:files', []);
}
</script>

<style lang="scss" scoped>
.picker-card {
  background: #ffffff;
  border-radius: 26rpx;
  padding: 24rpx;
  box-shadow: 0 6rpx 20rpx rgba(30, 64, 130, 0.045);
  margin-bottom: 24rpx;
}

.dropzone {
  border: 2rpx dashed #93c5fd;
  background: linear-gradient(180deg, #f5f9ff 0%, #eef5ff 100%);
  border-radius: 20rpx;
  padding: 36rpx 24rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.dropzone--hover {
  background: #e5effe;
}

.drop-icon {
  width: 76rpx;
  height: 76rpx;
  border-radius: 50%;
  background: #2563eb;
  color: #ffffff;
  font-size: 46rpx;
  line-height: 72rpx;
  font-weight: 400;
  margin-bottom: 14rpx;
  box-shadow: 0 8rpx 20rpx rgba(37, 99, 235, 0.28);
}

.drop-title {
  font-size: 29rpx;
  font-weight: 600;
  color: #132b54;
  margin-bottom: 6rpx;
}

.drop-sub {
  font-size: 22rpx;
  color: #64748b;
}

.file-list {
  margin-top: 22rpx;
}

.list-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12rpx;
  font-size: 24rpx;
}

.list-count {
  font-weight: 600;
  color: #334155;
}

.clear-btn {
  color: #ef4444;
  font-size: 23rpx;
}

.file-row {
  display: flex;
  align-items: center;
  gap: 16rpx;
  padding: 14rpx;
  background: #f8fafc;
  border-radius: 16rpx;
  margin-bottom: 12rpx;
}

.thumb {
  width: 84rpx;
  height: 84rpx;
  border-radius: 12rpx;
  background: #e2e8f0;
  flex-shrink: 0;
}

.file-badge-icon {
  width: 84rpx;
  height: 84rpx;
  border-radius: 12rpx;
  background: #eaf2ff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 38rpx;
  flex-shrink: 0;
}

.file-info {
  flex: 1;
  min-width: 0;
}

.file-name {
  font-size: 26rpx;
  font-weight: 500;
  color: #1e293b;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-size {
  font-size: 22rpx;
  color: #94a3b8;
  margin-top: 4rpx;
}

.file-actions {
  display: flex;
  align-items: center;
  gap: 10rpx;
}

.act-btn {
  width: 48rpx;
  height: 48rpx;
  border-radius: 12rpx;
  background: #e2e8f0;
  color: #334155;
  font-size: 26rpx;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;

  &.danger {
    background: #fee2e2;
    color: #dc2626;
  }
}
</style>
