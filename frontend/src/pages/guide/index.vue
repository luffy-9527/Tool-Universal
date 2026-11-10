<template>
  <view class="guide-page">
    <view class="guide-card">
      <view class="g-title">1. 如何导入手机里的 Word / PDF / 音频？</view>
      <view class="g-text">
        受限于微信小程序沙盒机制，小程序无法直接读取手机所有文件夹。你可以先把文档发给自己（如「文件传输助手」或任一微信聊天框），再点击工具内的「选择文件」，即可直接从微信聊天记录中秒选文档或音频。
      </view>
    </view>

    <view class="guide-card">
      <view class="g-title">2. 哪些功能纯离线？哪些走云端高保真引擎？</view>
      <view class="g-text">
        • <text class="bold">纯离线本地（0延迟不耗流量）：</text>朋友圈九宫格、长图拼接、长图拆分、图片防盗水印、证件照冲印排版、图片格式转换、图片智能压缩、发票扫描增强、离线多图合成 PDF。
        {{ '\n' }}• <text class="bold">云端高保真引擎：</text>Word/Excel/PPT 高保真互转、PDF 转 Word/图片、PDF 拆分合并、提取文档原图、音视频格式互转、视频转 GIF 动图与 MOV 转 MP4 压缩。
      </view>
    </view>

    <view class="guide-card">
      <view class="g-title">3. 转换后的文件如何保存或传回电脑？</view>
      <view class="g-text">
        图片与视频结果可直接点击「保存」存入手机系统相册；PDF、Word 与音频文件可点击「预览/保存」打开菜单转发，或直接点击「发好友」发送至微信文件传输助手。
      </view>
    </view>

    <view class="guide-card">
      <view class="g-title">4. 隐私与安全声明</view>
      <view class="g-text">
        所有纯离线工具仅在你的手机本地内存中完成处理，不上传任何服务器；云端高保真转换的临时文件会在 30 分钟后由后台任务自动彻底销毁，充分保障证件与商业文档隐私。
      </view>
    </view>

    <!-- Live Backend Diagnostics -->
    <view class="guide-card">
      <view class="diag-top">
        <view class="g-title" style="margin-bottom: 0;">5. 云端服务连接诊断</view>
        <view class="diag-btn" @click="checkBackend">
          {{ checking ? '检测中...' : '立即检测' }}
        </view>
      </view>

      <view v-if="diagMessage" class="diag-result" :class="{ err: diagError }">
        <text>{{ diagMessage }}</text>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import type { CapabilitiesResponse } from '@tool-universal/shared';
import { callBackendApi } from '@/utils/request';

const checking = ref(false);
const diagMessage = ref('');
const diagError = ref(false);

async function checkBackend() {
  checking.value = true;
  diagError.value = false;
  diagMessage.value = '';
  try {
    const caps = await callBackendApi<CapabilitiesResponse>('/api/capabilities', 'GET');
    diagMessage.value = `✅ 连接正常 | FFmpeg: ${caps.ffmpeg ? '可用' : '未启用'} | PDF渲染: ${
      caps.pdftoppm ? '可用' : '未启用'
    } | Office排版: ${caps.libreoffice ? 'LibreOffice' : '内置轻量引擎'} | 存储模式: ${caps.storageMode}`;
  } catch (err: any) {
    diagError.value = true;
    diagMessage.value = `❌ ${err?.message || '无法连接后端服务'}`;
  } finally {
    checking.value = false;
  }
}
</script>

<style lang="scss" scoped>
.guide-page {
  min-height: 100vh;
  padding: 24rpx;
  background: #f4f7fc;
  display: flex;
  flex-direction: column;
  gap: 20rpx;
}

.guide-card {
  background: #ffffff;
  border-radius: 24rpx;
  padding: 26rpx;
  box-shadow: 0 6rpx 20rpx rgba(30, 64, 130, 0.045);
}

.g-title {
  font-size: 29rpx;
  font-weight: 700;
  color: #132b54;
  margin-bottom: 12rpx;
}

.g-text {
  font-size: 25rpx;
  color: #475569;
  line-height: 1.65;
  white-space: pre-line;
}

.bold {
  font-weight: 700;
  color: #1e293b;
}

.diag-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12rpx;
}

.diag-btn {
  padding: 10rpx 24rpx;
  border-radius: 999rpx;
  background: #2563eb;
  color: #ffffff;
  font-size: 23rpx;
  font-weight: 600;
  flex-shrink: 0;
}

.diag-result {
  margin-top: 16rpx;
  padding: 16rpx;
  border-radius: 14rpx;
  background: #eafaf1;
  color: #15803d;
  font-size: 23rpx;
  line-height: 1.5;

  &.err {
    background: #fef2f2;
    color: #dc2626;
  }
}
</style>
