<template>
  <view class="home-page">
    <!-- Top sticky mini nav bar when scrolled (matches screenshot 2 & 3) -->
    <view
      class="sticky-nav"
      :class="{ visible: isScrolled }"
      :style="{ paddingTop: `${statusBarHeight}px` }"
    >
      <view class="sticky-nav-inner">
        <text class="sticky-title">万能格式转换工具</text>
      </view>
    </view>

    <!-- Hero Header with soft sky-blue gradient -->
    <view class="hero-header" :style="{ paddingTop: `${statusBarHeight + 24}px` }">
      <view class="brand-block">
        <text class="brand-title">万能格式转换工具</text>
        <text class="brand-sub">轻量 · 极速 · 文档互转</text>
      </view>

      <!-- Search Bar -->
      <view class="search-pill">
        <text class="search-icon">🔍</text>
        <input
          v-model="searchQuery"
          class="search-input"
          placeholder="搜索工具：如 Word、PDF、九宫格、压缩..."
          placeholder-style="color: #8E9CB2; font-size: 26rpx;"
          confirm-type="search"
        />
        <view v-if="searchQuery" class="search-clear" @click="searchQuery = ''">×</view>
      </view>
    </view>

    <!-- Category Tabs (sticky below nav when scrolled) -->
    <view class="tabs-sticky-wrap" :style="{ top: isScrolled ? `${statusBarHeight + 44}px` : '0px' }">
      <scroll-view scroll-x class="category-scroll" :show-scrollbar="false">
        <view class="category-tabs">
          <view
            class="cat-pill"
            :class="{ active: activeCategory === 'all' }"
            @click="activeCategory = 'all'"
          >
            <text class="cat-name">全部工具</text>
            <text class="cat-count">{{ TOOLS.length }}</text>
          </view>

          <view
            v-for="cat in CATEGORIES"
            :key="cat.id"
            class="cat-pill"
            :class="{ active: activeCategory === cat.id }"
            @click="activeCategory = cat.id"
          >
            <text class="cat-name">{{ cat.name }}</text>
            <text class="cat-count">{{ cat.count }}</text>
          </view>
        </view>
      </scroll-view>
    </view>

    <!-- Main Content -->
    <view class="content-body">
      <!-- Empty search state -->
      <view v-if="filteredSections.length === 0" class="empty-search">
        <text class="empty-emoji">🔎</text>
        <text class="empty-title">没有找到“{{ searchQuery }}”相关工具</text>
        <text class="empty-sub">试试搜索 Word、PDF、九宫格、压缩、MP3</text>
        <view class="tu-secondary-btn empty-reset" @click="resetFilter">查看全部 {{ TOOLS.length }} 款工具</view>
      </view>

      <!-- Sections + 2-Column Tool Grid -->
      <view v-for="section in filteredSections" :key="section.id" class="tool-section">
        <view class="section-header">
          <view class="section-left">
            <text class="section-emoji">{{ section.emoji }}</text>
            <text class="section-title">{{ section.name }}</text>
            <view class="section-count-pill">
              <text>{{ section.items.length }} 款</text>
            </view>
          </view>
          <text class="section-sub">{{ section.subtitle }}</text>
        </view>

        <view class="tool-grid">
          <ToolCard
            v-for="tool in section.items"
            :key="tool.id"
            :tool="tool"
            @select="openTool"
          />
        </view>
      </view>
    </view>

    <!-- Bottom Floating Action Dock -->
    <FloatingBar
      :record-count="conversionRecords.length"
      @records="goRecords"
      @guide="goGuide"
    />
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad, onPageScroll, onShareAppMessage } from '@dcloudio/uni-app';
import { CATEGORIES, TOOLS, type CategoryId, type ToolMeta } from '@tool-universal/shared';
import FloatingBar from '@/components/FloatingBar.vue';
import ToolCard from '@/components/ToolCard.vue';
import { conversionRecords } from '@/utils/records';

const statusBarHeight = ref(20);
const isScrolled = ref(false);
const searchQuery = ref('');
const activeCategory = ref<CategoryId>('all');

onLoad(() => {
  try {
    const sys = uni.getSystemInfoSync();
    statusBarHeight.value = sys.statusBarHeight || 20;
  } catch {
    statusBarHeight.value = 20;
  }
});

onPageScroll((e) => {
  isScrolled.value = e.scrollTop > 64;
});

onShareAppMessage(() => ({
  title: `万能格式转换工具 - ${TOOLS.length}款轻量极速文档音视频工具`,
  path: '/pages/index/index',
}));

const filteredSections = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();

  const targetCategories =
    activeCategory.value === 'all' || q.length > 0
      ? CATEGORIES
      : CATEGORIES.filter((c) => c.id === activeCategory.value);

  return targetCategories
    .map((cat) => {
      const items = TOOLS.filter((tool) => {
        if (tool.category !== cat.id) return false;
        if (!q) return true;
        return (
          tool.title.toLowerCase().includes(q) ||
          tool.description.toLowerCase().includes(q) ||
          tool.badge.toLowerCase().includes(q) ||
          tool.keywords.some((k) => k.toLowerCase().includes(q))
        );
      });
      return {
        ...cat,
        items,
      };
    })
    .filter((sec) => sec.items.length > 0);
});

function openTool(tool: ToolMeta) {
  uni.navigateTo({
    url: `/pages/tool/index?id=${tool.id}`,
  });
}

function goRecords() {
  uni.navigateTo({ url: '/pages/records/index' });
}

function goGuide() {
  uni.navigateTo({ url: '/pages/guide/index' });
}

function resetFilter() {
  searchQuery.value = '';
  activeCategory.value = 'all';
}
</script>

<style lang="scss" scoped>
.home-page {
  min-height: 100vh;
  background: #f4f7fc;
  padding-bottom: calc(150rpx + env(safe-area-inset-bottom));
}

.sticky-nav {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 80;
  background: rgba(255, 255, 255, 0.96);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid #eef2f8;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transform: translateY(-100%);
  transition: opacity 0.18s ease, transform 0.18s ease, visibility 0.18s ease;

  &.visible {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
    transform: translateY(0);
  }
}

.sticky-nav-inner {
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.sticky-title {
  font-size: 32rpx;
  font-weight: 700;
  color: #182235;
}

.hero-header {
  background: linear-gradient(180deg, #d5e8ff 0%, #e5f0ff 65%, #f4f7fc 100%);
  padding-left: 28rpx;
  padding-right: 28rpx;
  padding-bottom: 24rpx;
}

.brand-block {
  display: flex;
  flex-direction: column;
  margin-bottom: 24rpx;
}

.brand-title {
  font-size: 46rpx;
  font-weight: 800;
  color: #132b54;
  letter-spacing: 1rpx;
  line-height: 1.25;
}

.brand-sub {
  margin-top: 8rpx;
  font-size: 24rpx;
  color: #5e7292;
  letter-spacing: 2rpx;
}

.search-pill {
  height: 86rpx;
  background: #ffffff;
  border-radius: 999rpx;
  padding: 0 28rpx;
  display: flex;
  align-items: center;
  gap: 14rpx;
  box-shadow: 0 8rpx 24rpx rgba(28, 72, 145, 0.08);
}

.search-icon {
  font-size: 28rpx;
}

.search-input {
  flex: 1;
  font-size: 26rpx;
  color: #1e293b;
}

.search-clear {
  width: 40rpx;
  height: 40rpx;
  border-radius: 50%;
  background: #e2e8f0;
  color: #475569;
  font-size: 26rpx;
  display: flex;
  align-items: center;
  justify-content: center;
}

.tabs-sticky-wrap {
  position: sticky;
  z-index: 60;
  background: rgba(244, 247, 252, 0.94);
  backdrop-filter: blur(8px);
  padding: 12rpx 0 14rpx;
}

.category-scroll {
  width: 100%;
  white-space: nowrap;
}

.category-tabs {
  display: inline-flex;
  flex-wrap: nowrap;
  align-items: center;
  width: max-content;
  gap: 16rpx;
  padding: 0 28rpx;
}

.cat-pill {
  flex-shrink: 0;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 10rpx;
  padding: 14rpx 24rpx;
  border-radius: 999rpx;
  background: #ffffff;
  color: #4a5b78;
  font-size: 26rpx;
  font-weight: 600;
  box-shadow: 0 4rpx 14rpx rgba(30, 64, 130, 0.05);
  transition: all 0.15s ease;

  .cat-name,
  .cat-count {
    white-space: nowrap;
  }

  .cat-count {
    font-size: 22rpx;
    color: #8fa0b8;
    font-weight: 500;
  }

  &.active {
    background: linear-gradient(135deg, #2b6ef6 0%, #1d5ce5 100%);
    color: #ffffff;
    box-shadow: 0 8rpx 20rpx rgba(37, 99, 235, 0.28);

    .cat-count {
      color: rgba(255, 255, 255, 0.88);
    }
  }
}

.content-body {
  padding: 8rpx 24rpx 24rpx;
}

.tool-section {
  margin-bottom: 34rpx;

  &:last-child {
    margin-bottom: 0;
  }
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16rpx;
  min-height: 44rpx;
  margin-bottom: 18rpx;
  padding: 0 4rpx;
}

.section-left {
  display: flex;
  align-items: center;
  gap: 10rpx;
  flex-shrink: 0;
}

.section-emoji {
  font-size: 30rpx;
  line-height: 1;
}

.section-title {
  font-size: 30rpx;
  font-weight: 800;
  color: #132238;
  line-height: 1.2;
}

.section-count-pill {
  padding: 4rpx 14rpx;
  border-radius: 999rpx;
  background: #e6effe;
  color: #2563eb;
  font-size: 21rpx;
  font-weight: 600;
  line-height: 1.25;
}

.section-sub {
  flex: 1;
  min-width: 0;
  text-align: right;
  font-size: 22rpx;
  color: #7c8b9f;
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-auto-rows: 1fr;
  align-items: stretch;
  gap: 18rpx;
}

.empty-search {
  margin-top: 80rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 40rpx;
}

.empty-emoji {
  font-size: 64rpx;
  margin-bottom: 16rpx;
}

.empty-title {
  font-size: 30rpx;
  font-weight: 700;
  color: #1e293b;
  margin-bottom: 8rpx;
}

.empty-sub {
  font-size: 24rpx;
  color: #64748b;
  margin-bottom: 28rpx;
}

.empty-reset {
  display: inline-block;
}
</style>
