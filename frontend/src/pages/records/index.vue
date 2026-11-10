<template>
  <view class="records-page">
    <view class="top-bar">
      <text class="top-title">历史转换记录（{{ conversionRecords.length }}）</text>
      <text v-if="conversionRecords.length > 0" class="clear-all" @click="confirmClear">清空记录</text>
    </view>

    <view v-if="conversionRecords.length === 0" class="empty-box">
      <text class="empty-icon">📂</text>
      <text class="empty-title">暂无转换记录</text>
      <text class="empty-desc">你在本地或云端处理完成的文档、图片和音视频会自动保存在这里（仅存于本机缓存，保护隐私）。</text>
    </view>

    <view v-else class="record-list">
      <view v-for="item in conversionRecords" :key="item.id" class="record-card">
        <view class="rec-header">
          <view class="rec-title-wrap">
            <text class="rec-tool">{{ item.toolTitle }}</text>
            <text class="rec-mode" :class="item.mode">
              {{ item.mode === 'local' ? '本地处理' : '云端引擎' }}
            </text>
          </view>
          <text class="rec-time">{{ formatTime(item.createdAt) }}</text>
        </view>

        <view class="rec-body">
          <text class="rec-line">输出文件：{{ item.primaryFileName }}</text>
          <text class="rec-line">结果摘要：{{ item.outputSummary }}</text>
        </view>

        <view class="rec-footer">
          <view v-if="item.primaryUrl" class="rec-btn primary" @click="openSavedOutput(item)">打开/保存</view>
          <view class="rec-btn" @click="reopenTool(item.toolId)">再次使用</view>
          <view class="rec-btn danger" @click="removeConversionRecord(item.id)">删除</view>
        </view>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { saveOrDownloadOutput } from '@/utils/fileBridge';
import {
  clearConversionRecords,
  conversionRecords,
  removeConversionRecord,
  type ConversionRecordItem,
} from '@/utils/records';

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function guessMime(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (lower.endsWith('.doc')) return 'application/msword';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.aac')) return 'audio/aac';
  return 'image/jpeg';
}

function openSavedOutput(item: ConversionRecordItem) {
  if (!item.primaryUrl) return;
  saveOrDownloadOutput({
    fileId: item.primaryUrl,
    fileName: item.primaryFileName,
    size: 0,
    mimeType: guessMime(item.primaryFileName),
    downloadUrl: item.primaryUrl,
    source: item.primarySource ?? (item.mode === 'cloud' ? 'cloudbase' : 'local'),
  });
}

function reopenTool(toolId: string) {
  uni.navigateTo({ url: `/pages/tool/index?id=${toolId}` });
}

function confirmClear() {
  uni.showModal({
    title: '清空转换记录',
    content: '确定要清空本地保存的所有记录吗？',
    success: (res) => {
      if (res.confirm) clearConversionRecords();
    },
  });
}
</script>

<style lang="scss" scoped>
.records-page {
  min-height: 100vh;
  padding: 24rpx;
  background: #f4f7fc;
}

.top-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20rpx;
}

.top-title {
  font-size: 28rpx;
  font-weight: 700;
  color: #1e293b;
}

.clear-all {
  font-size: 24rpx;
  color: #ef4444;
  font-weight: 600;
}

.empty-box {
  margin-top: 120rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 0 48rpx;
}

.empty-icon {
  font-size: 72rpx;
  margin-bottom: 18rpx;
}

.empty-title {
  font-size: 30rpx;
  font-weight: 700;
  color: #1e293b;
  margin-bottom: 10rpx;
}

.empty-desc {
  font-size: 24rpx;
  color: #64748b;
  line-height: 1.6;
}

.record-list {
  display: flex;
  flex-direction: column;
  gap: 18rpx;
}

.record-card {
  background: #ffffff;
  border-radius: 24rpx;
  padding: 24rpx;
  box-shadow: 0 6rpx 20rpx rgba(30, 64, 130, 0.045);
}

.rec-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14rpx;
}

.rec-title-wrap {
  display: flex;
  align-items: center;
  gap: 12rpx;
}

.rec-tool {
  font-size: 28rpx;
  font-weight: 700;
  color: #132b54;
}

.rec-mode {
  padding: 4rpx 12rpx;
  border-radius: 999rpx;
  font-size: 20rpx;
  font-weight: 600;

  &.local {
    background: #eafaf1;
    color: #15803d;
  }
  &.cloud {
    background: #ecf3ff;
    color: #2563eb;
  }
}

.rec-time {
  font-size: 22rpx;
  color: #94a3b8;
}

.rec-body {
  display: flex;
  flex-direction: column;
  gap: 6rpx;
  margin-bottom: 16rpx;
}

.rec-line {
  font-size: 24rpx;
  color: #475569;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rec-footer {
  display: flex;
  justify-content: flex-end;
  gap: 14rpx;
}

.rec-btn {
  padding: 10rpx 22rpx;
  border-radius: 999rpx;
  background: #edf3ff;
  color: #2563eb;
  font-size: 23rpx;
  font-weight: 600;

  &.primary {
    background: #2563eb;
    color: #ffffff;
  }

  &.danger {
    background: #fef2f2;
    color: #dc2626;
  }
}
</style>
