<template>
  <view
    v-if="complianceDialogState.visible"
    class="compliance-mask"
    @touchmove.stop.prevent
    @click="closeComplianceDialog"
  >
    <view
      class="compliance-card"
      :class="{ 'is-warning': complianceDialogState.isUnavailable }"
      @click.stop
    >
      <view class="card-hero">
        <view class="shield-halo">
          <view class="shield-badge">
            <view class="shield-shape">
              <text class="shield-mark">!</text>
            </view>
          </view>
        </view>

        <text class="card-title">{{ complianceDialogState.title }}</text>

        <view class="status-pill">
          <text v-if="complianceDialogState.isUnavailable">已暂停生成 · 请稍后重试</text>
          <text v-else-if="complianceDialogState.category">
            已阻断生成 · 风险类别：{{ complianceDialogState.category }}
          </text>
          <text v-else>已阻断生成 · 触发内容安全策略</text>
        </view>
      </view>

      <view class="card-body">
        <view class="detail-box">
          <text class="detail-text">{{ complianceDialogState.message }}</text>
        </view>

        <view v-if="!complianceDialogState.isUnavailable" class="safe-tip">
          <text class="tip-label">合规建议</text>
          <text class="tip-text">请使用真实、合法的业务用途描述（如“仅供实名认证使用 · 他用无效”）。</text>
        </view>
      </view>

      <view class="card-footer">
        <button class="confirm-btn" hover-class="confirm-btn--hover" @click="closeComplianceDialog">
          {{ complianceDialogState.isUnavailable ? '我知道了' : '返回修改文字' }}
        </button>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { onUnmounted } from 'vue';
import { closeComplianceDialog, complianceDialogState } from '@/utils/compliance';

onUnmounted(() => {
  closeComplianceDialog();
});
</script>

<style lang="scss" scoped>
.compliance-mask {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 999;
  background: rgba(15, 23, 42, 0.54);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 36rpx;
  animation: maskFadeIn 0.18s ease-out;
}

.compliance-card {
  width: 616rpx;
  max-width: 100%;
  background: #ffffff;
  border-radius: 34rpx;
  overflow: hidden;
  box-shadow: 0 24rpx 64rpx rgba(15, 23, 42, 0.24);
  animation: cardPopIn 0.22s cubic-bezier(0.22, 1, 0.36, 1);
}

.card-hero {
  background: linear-gradient(180deg, #fff1f2 0%, #fff8f8 58%, #ffffff 100%);
  padding: 40rpx 36rpx 20rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.compliance-card.is-warning .card-hero {
  background: linear-gradient(180deg, #fffbeb 0%, #fffdf5 58%, #ffffff 100%);
}

.shield-halo {
  width: 112rpx;
  height: 112rpx;
  border-radius: 50%;
  background: rgba(239, 68, 68, 0.12);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 20rpx;
}

.compliance-card.is-warning .shield-halo {
  background: rgba(245, 158, 11, 0.14);
}

.shield-badge {
  width: 80rpx;
  height: 80rpx;
  border-radius: 50%;
  background: linear-gradient(135deg, #f87171 0%, #dc2626 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 10rpx 22rpx rgba(220, 38, 38, 0.28);
}

.compliance-card.is-warning .shield-badge {
  background: linear-gradient(135deg, #fbbf24 0%, #d97706 100%);
  box-shadow: 0 10rpx 22rpx rgba(217, 119, 6, 0.28);
}

.shield-shape {
  width: 36rpx;
  height: 42rpx;
  border: 3rpx solid rgba(255, 255, 255, 0.92);
  border-radius: 8rpx 8rpx 20rpx 20rpx;
  display: flex;
  align-items: center;
  justify-content: center;
}

.shield-mark {
  color: #ffffff;
  font-size: 26rpx;
  font-weight: 800;
  line-height: 1;
}

.card-title {
  font-size: 34rpx;
  font-weight: 800;
  color: #132b54;
  letter-spacing: 0.5rpx;
  margin-bottom: 14rpx;
}

.status-pill {
  padding: 6rpx 20rpx;
  border-radius: 999rpx;
  background: #fee2e2;
  color: #b91c1c;
  font-size: 22rpx;
  font-weight: 600;
  line-height: 1.4;
}

.compliance-card.is-warning .status-pill {
  background: #fef3c7;
  color: #b45309;
}

.card-body {
  padding: 12rpx 32rpx 24rpx;
  display: flex;
  flex-direction: column;
  gap: 16rpx;
}

.detail-box {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 20rpx;
  padding: 22rpx 24rpx;
}

.detail-text {
  font-size: 26rpx;
  color: #334155;
  line-height: 1.65;
  text-align: left;
  display: block;
}

.safe-tip {
  display: flex;
  align-items: flex-start;
  gap: 12rpx;
  padding: 16rpx 18rpx;
  border-radius: 16rpx;
  background: #eff6ff;
  border: 1px solid #dbeafe;
}

.tip-label {
  flex-shrink: 0;
  padding: 2rpx 10rpx;
  border-radius: 8rpx;
  background: #2563eb;
  color: #ffffff;
  font-size: 19rpx;
  font-weight: 700;
  margin-top: 2rpx;
}

.tip-text {
  font-size: 22rpx;
  color: #1e40af;
  line-height: 1.5;
}

.card-footer {
  padding: 4rpx 32rpx 32rpx;
}

.confirm-btn {
  width: 100%;
  height: 86rpx;
  line-height: 86rpx;
  border-radius: 999rpx;
  background: linear-gradient(135deg, #2b6ef6 0%, #1d4ed8 100%);
  color: #ffffff;
  font-size: 29rpx;
  font-weight: 600;
  text-align: center;
  box-shadow: 0 10rpx 24rpx rgba(37, 99, 235, 0.28);

  &::after {
    border: none;
  }
}

.confirm-btn--hover {
  opacity: 0.9;
  transform: scale(0.99);
}

@keyframes maskFadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes cardPopIn {
  from {
    opacity: 0;
    transform: scale(0.92) translateY(14rpx);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}
</style>
