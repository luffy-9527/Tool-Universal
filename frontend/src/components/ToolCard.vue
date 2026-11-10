<template>
  <view class="tool-card" hover-class="tool-card--active" @click="$emit('select', tool)">
    <view class="card-top">
      <ToolIcon :icon-key="tool.iconKey" :bg-color="tool.iconBg" />
      <view class="badge" :class="`badge--${tool.badgeTheme}`">
        <text>{{ tool.badge }}</text>
      </view>
    </view>

    <view class="card-title">{{ tool.title }}</view>
    <view class="card-desc">{{ tool.description }}</view>
  </view>
</template>

<script setup lang="ts">
import type { ToolMeta } from '@tool-universal/shared';
import ToolIcon from './ToolIcon.vue';

defineOptions({
  options: {
    virtualHost: true,
  },
});

defineProps<{
  tool: ToolMeta;
}>();

defineEmits<{
  (e: 'select', tool: ToolMeta): void;
}>();
</script>

<style lang="scss">
/* #ifdef MP-WEIXIN */
:host {
  display: block;
  height: 100%;
  min-width: 0;
}
/* #endif */
</style>

<style lang="scss" scoped>
.tool-card {
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  background: #ffffff;
  border-radius: 26rpx;
  padding: 24rpx 22rpx;
  border: 1px solid rgba(226, 234, 248, 0.9);
  box-shadow: 0 6rpx 20rpx rgba(30, 64, 130, 0.045);
  display: flex;
  flex-direction: column;
  min-height: 222rpx;
  transition: transform 0.12s ease;
}

.tool-card--active {
  transform: scale(0.98);
  background: #fafcff;
}

.card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12rpx;
  margin-bottom: 20rpx;
}

.badge {
  padding: 6rpx 16rpx;
  border-radius: 999rpx;
  font-size: 21rpx;
  font-weight: 500;
  line-height: 1.25;
  border-width: 1px;
  border-style: solid;
  flex-shrink: 0;
  white-space: nowrap;
}

.badge--pink {
  background: #ffeff2;
  color: #e04e6b;
  border-color: #ffd8e0;
}

.badge--blue {
  background: #ecf3ff;
  color: #2b6ce6;
  border-color: #d4e4ff;
}

.badge--green {
  background: #eafaf1;
  color: #199a55;
  border-color: #cbefd9;
}

.card-title {
  font-size: 29rpx;
  font-weight: 700;
  color: #182235;
  margin-bottom: 8rpx;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.card-desc {
  font-size: 22rpx;
  color: #7c8b9f;
  line-height: 1.45;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  word-break: break-all;
}
</style>
