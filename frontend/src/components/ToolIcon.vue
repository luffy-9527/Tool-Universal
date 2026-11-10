<template>
  <view class="icon-box" :style="{ backgroundColor: bgColor }">
    <!-- Office / Document icons -->
    <view v-if="iconKey === 'doc-pdf' || iconKey === 'doc-edit'" class="shape-doc">
      <view class="doc-lines">
        <view class="line"></view>
        <view class="line short"></view>
        <view class="line"></view>
      </view>
      <text v-if="iconKey === 'doc-edit'" class="mini-badge">✏️</text>
    </view>

    <view v-else-if="iconKey === 'excel-chart' || iconKey === 'ppt-chart'" class="shape-chart">
      <view class="bar b1"></view>
      <view class="bar b2"></view>
      <view class="bar b3"></view>
    </view>

    <view v-else-if="iconKey === 'extract-img' || iconKey === 'picture-frame'" class="shape-picture">
      <view class="pic-sun"></view>
      <view class="pic-mount m1"></view>
      <view class="pic-mount m2"></view>
    </view>

    <view v-else-if="iconKey === 'scan-doc'" class="shape-doc scan">
      <view class="doc-lines">
        <view class="line"></view>
        <view class="line"></view>
        <view class="line short"></view>
      </view>
      <view class="scan-laser"></view>
    </view>

    <view v-else-if="iconKey === 'pdf-compose' || iconKey === 'pdf-image' || iconKey === 'pdf-word'" class="shape-doc pdf">
      <view class="doc-lines">
        <view class="line"></view>
        <view class="line short"></view>
      </view>
      <view class="pdf-tag" :class="{ word: iconKey === 'pdf-word' }">
        {{ iconKey === 'pdf-image' ? 'IMG' : iconKey === 'pdf-word' ? 'DOC' : 'PDF' }}
      </view>
    </view>

    <view v-else-if="iconKey === 'gif'" class="shape-gif">
      <view class="gif-frame">
        <view class="gif-dot"></view>
        <view class="gif-bar"></view>
      </view>
      <view class="gif-tag">GIF</view>
    </view>

    <view v-else-if="iconKey === 'shield'" class="shape-shield">
      <view class="shield-inner"></view>
    </view>

    <text v-else-if="iconKey === 'scissors'" class="emoji-icon">✂️</text>
    <text v-else-if="iconKey === 'portrait'" class="emoji-icon portrait-tint">👤</text>
    <text v-else-if="iconKey === 'camera'" class="emoji-icon">📷</text>
    <text v-else-if="iconKey === 'puzzle'" class="emoji-icon">🧩</text>
    <text v-else-if="iconKey === 'scroll'" class="emoji-icon">📜</text>
    <text v-else-if="iconKey === 'compress'" class="emoji-icon">🗜️</text>
    <text v-else-if="iconKey === 'music'" class="emoji-icon music-tint">🎵</text>
    <text v-else-if="iconKey === 'clapper'" class="emoji-icon">🎬</text>
    <text v-else-if="iconKey === 'camcorder'" class="emoji-icon">📹</text>
    <text v-else class="emoji-icon">📄</text>
  </view>
</template>

<script setup lang="ts">
defineProps<{
  iconKey: string;
  bgColor: string;
}>();
</script>

<style lang="scss" scoped>
.icon-box {
  width: 72rpx;
  height: 72rpx;
  border-radius: 18rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  flex-shrink: 0;
}

.emoji-icon {
  font-size: 36rpx;
  line-height: 1;
}

.portrait-tint {
  filter: hue-rotate(20deg);
}

.music-tint {
  color: #4f46e5;
}

.shape-doc {
  width: 38rpx;
  height: 46rpx;
  background: #e2e8f0;
  border-radius: 6rpx;
  padding: 10rpx 6rpx;
  display: flex;
  flex-direction: column;
  justify-content: center;
  position: relative;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.8);

  .doc-lines {
    display: flex;
    flex-direction: column;
    gap: 5rpx;
  }

  .line {
    height: 4rpx;
    background: #94a3b8;
    border-radius: 2rpx;
    width: 100%;
  }

  .line.short {
    width: 68%;
  }

  .mini-badge {
    position: absolute;
    right: -8rpx;
    bottom: -6rpx;
    font-size: 20rpx;
  }

  &.scan .scan-laser {
    position: absolute;
    left: -4rpx;
    right: -4rpx;
    top: 50%;
    height: 4rpx;
    background: #22c55e;
    border-radius: 2rpx;
  }

  &.pdf {
    background: #e5e7eb;
    .pdf-tag {
      position: absolute;
      right: -8rpx;
      bottom: -6rpx;
      background: #ef4444;
      color: #ffffff;
      font-size: 14rpx;
      font-weight: 700;
      padding: 2rpx 6rpx;
      border-radius: 6rpx;
      line-height: 1.1;

      &.word {
        background: #2563eb;
      }
    }
  }
}

.shape-chart {
  width: 42rpx;
  height: 40rpx;
  background: #ffffff;
  border-radius: 8rpx;
  border: 2rpx solid #e2e8f0;
  display: flex;
  align-items: flex-end;
  justify-content: space-around;
  padding: 6rpx;

  .bar {
    width: 8rpx;
    border-radius: 3rpx 3rpx 0 0;
  }
  .b1 {
    height: 14rpx;
    background: #22c55e;
  }
  .b2 {
    height: 24rpx;
    background: #ef4444;
  }
  .b3 {
    height: 18rpx;
    background: #3b82f6;
  }
}

.shape-picture {
  width: 44rpx;
  height: 36rpx;
  background: #fde68a;
  border: 3rpx solid #f59e0b;
  border-radius: 8rpx;
  position: relative;
  overflow: hidden;

  .pic-sun {
    position: absolute;
    top: 5rpx;
    right: 6rpx;
    width: 9rpx;
    height: 9rpx;
    border-radius: 50%;
    background: #f97316;
  }

  .pic-mount {
    position: absolute;
    bottom: 0;
    width: 0;
    height: 0;
    border-style: solid;
  }

  .m1 {
    left: -2rpx;
    border-width: 0 16rpx 18rpx 16rpx;
    border-color: transparent transparent #22c55e transparent;
  }

  .m2 {
    right: -2rpx;
    border-width: 0 12rpx 14rpx 12rpx;
    border-color: transparent transparent #16a34a transparent;
  }
}

.shape-gif {
  width: 44rpx;
  height: 36rpx;
  background: #ffe4ec;
  border: 2rpx solid #fda4af;
  border-radius: 8rpx;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;

  .gif-frame {
    width: 30rpx;
    display: flex;
    flex-direction: column;
    gap: 4rpx;
    align-items: flex-start;
  }

  .gif-dot {
    width: 8rpx;
    height: 8rpx;
    border-radius: 50%;
    background: #fb7185;
  }

  .gif-bar {
    width: 24rpx;
    height: 4rpx;
    border-radius: 2rpx;
    background: #fda4af;
  }

  .gif-tag {
    position: absolute;
    right: -8rpx;
    bottom: -6rpx;
    background: #e11d48;
    color: #ffffff;
    font-size: 14rpx;
    font-weight: 700;
    padding: 2rpx 6rpx;
    border-radius: 6rpx;
    line-height: 1.1;
  }
}

.shape-shield {
  width: 34rpx;
  height: 40rpx;
  background: linear-gradient(135deg, #60a5fa 0%, #2563eb 100%);
  border-radius: 8rpx 8rpx 18rpx 18rpx;
  display: flex;
  align-items: center;
  justify-content: center;

  .shield-inner {
    width: 14rpx;
    height: 18rpx;
    border-radius: 4rpx 4rpx 10rpx 10rpx;
    background: rgba(255, 255, 255, 0.35);
  }
}
</style>
