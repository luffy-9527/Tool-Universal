<template>
  <view class="floating-dock-wrap">
    <view class="floating-dock">
      <view class="dock-item" hover-class="dock-item--hover" @click="$emit('records')">
        <text class="dock-icon">🕒</text>
        <text class="dock-text">转换记录 ({{ recordCount }})</text>
      </view>

      <view class="dock-divider"></view>

      <view class="dock-item" hover-class="dock-item--hover" @click="$emit('guide')">
        <text class="dock-icon">💡</text>
        <text class="dock-text">使用说明</text>
      </view>

      <view class="dock-divider"></view>

      <!-- #ifdef MP-WEIXIN -->
      <button class="dock-item dock-share-btn" open-type="share" hover-class="dock-item--hover">
        <text class="dock-icon">📤</text>
        <text class="dock-text">分享好友</text>
      </button>
      <!-- #endif -->

      <!-- #ifndef MP-WEIXIN -->
      <view class="dock-item" hover-class="dock-item--hover" @click="onH5Share">
        <text class="dock-icon">📤</text>
        <text class="dock-text">分享好友</text>
      </view>
      <!-- #endif -->
    </view>
  </view>
</template>

<script setup lang="ts">
defineProps<{
  recordCount: number;
}>();

defineEmits<{
  (e: 'records'): void;
  (e: 'guide'): void;
}>();

function onH5Share() {
  const url = typeof window !== 'undefined' ? window.location.href : '';
  uni.setClipboardData({
    data: `推荐一个超实用的万能格式转换工具（支持Word/PDF/证件照/九宫格/音视频）：${url}`,
    success: () => {
      uni.showToast({ title: '已复制分享链接', icon: 'success' });
    },
  });
}
</script>

<style lang="scss" scoped>
.floating-dock-wrap {
  position: fixed;
  left: 28rpx;
  right: 28rpx;
  bottom: calc(24rpx + env(safe-area-inset-bottom));
  z-index: 90;
  pointer-events: none;
}

.floating-dock {
  pointer-events: auto;
  height: 92rpx;
  background: rgba(255, 255, 255, 0.96);
  backdrop-filter: blur(12px);
  border-radius: 999rpx;
  border: 1px solid rgba(226, 234, 248, 0.95);
  box-shadow: 0 12rpx 34rpx rgba(22, 49, 97, 0.11);
  display: flex;
  align-items: center;
  padding: 0 12rpx;
}

.dock-item {
  flex: 1;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8rpx;
  font-size: 25rpx;
  font-weight: 500;
  color: #1e293b;
}

.dock-item--hover {
  opacity: 0.72;
}

.dock-share-btn {
  margin: 0;
  padding: 0;
  background: transparent;
  line-height: normal;
  border-radius: 0;

  &::after {
    border: none;
  }
}

.dock-icon {
  font-size: 28rpx;
}

.dock-text {
  font-size: 25rpx;
  font-weight: 600;
  color: #1f2937;
}

.dock-divider {
  width: 2rpx;
  height: 30rpx;
  background: #e2e8f0;
}
</style>
