<template>
  <view v-if="tool" class="tool-page">
    <!-- Top Tool Summary Banner -->
    <view class="tool-banner">
      <ToolIcon :icon-key="tool.iconKey" :bg-color="tool.iconBg" />
      <view class="banner-info">
        <view class="banner-title-row">
          <text class="banner-title">{{ tool.title }}</text>
          <view class="mode-pill" :class="`mode--${tool.mode}`">
            <text>{{ modeLabel }}</text>
          </view>
        </view>
        <text class="banner-desc">{{ tool.description }}</text>
      </view>
    </view>

    <!-- File Selector -->
    <FilePickerBox v-model:files="files" :tool="tool" />

    <!-- Category-Specific Interactive Workspace -->
    <OfficeWorkspace
      v-if="tool.category === 'office'"
      :tool="tool"
      :files="files"
      :processing="processing"
      @start="onStart"
      @progress="onProgress"
      @done="onDone"
      @error="onError"
    />

    <PdfWorkspace
      v-else-if="tool.category === 'pdf'"
      :tool="tool"
      :files="files"
      :processing="processing"
      @start="onStart"
      @progress="onProgress"
      @done="onDone"
      @error="onError"
    />

    <SocialWorkspace
      v-else-if="tool.category === 'social'"
      :tool="tool"
      :files="files"
      :processing="processing"
      @start="onStart"
      @progress="onProgress"
      @done="onDone"
      @error="onError"
    />

    <FormatWorkspace
      v-else-if="tool.category === 'format'"
      :tool="tool"
      :files="files"
      :processing="processing"
      @start="onStart"
      @progress="onProgress"
      @done="onDone"
      @error="onError"
    />

    <MediaWorkspace
      v-else-if="tool.category === 'media'"
      :tool="tool"
      :files="files"
      :processing="processing"
      @start="onStart"
      @progress="onProgress"
      @done="onDone"
      @error="onError"
    />

    <!-- Live Progress & Output Result Card -->
    <TaskProgress
      :processing="processing"
      :progress="progress"
      :stage-text="stageText"
      :outputs="outputs"
      :error-message="errorMessage"
      :original-total-size="originalTotalSize"
    />

    <!-- Branded Content Security Compliance Dialog -->
    <ComplianceDialog />
  </view>

  <view v-else class="not-found">
    <text>未找到该工具配置，请返回首页重试。</text>
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onLoad, onShareAppMessage } from '@dcloudio/uni-app';
import { getToolById, type OutputFileRef, type ToolMeta } from '@tool-universal/shared';
import ComplianceDialog from '@/components/ComplianceDialog.vue';
import FilePickerBox from '@/components/FilePickerBox.vue';
import TaskProgress from '@/components/TaskProgress.vue';
import ToolIcon from '@/components/ToolIcon.vue';
import { formatBytes } from '@/utils/fileBridge';
import { addConversionRecord } from '@/utils/records';
import type { LocalPickedFile } from '@/utils/request';
import FormatWorkspace from './components/FormatWorkspace.vue';
import MediaWorkspace from './components/MediaWorkspace.vue';
import OfficeWorkspace from './components/OfficeWorkspace.vue';
import PdfWorkspace from './components/PdfWorkspace.vue';
import SocialWorkspace from './components/SocialWorkspace.vue';

const tool = ref<ToolMeta | undefined>();
const files = ref<LocalPickedFile[]>([]);
const processing = ref(false);
const progress = ref(0);
const stageText = ref('');
const outputs = ref<OutputFileRef[]>([]);
const errorMessage = ref('');

onLoad((query) => {
  const id = typeof query?.id === 'string' ? query.id : '';
  const found = getToolById(id);
  tool.value = found;
  if (found) {
    uni.setNavigationBarTitle({ title: found.title });
  }
});

onShareAppMessage(() => ({
  title: tool.value ? `${tool.value.title} - 万能格式转换工具` : '万能格式转换工具',
  path: tool.value ? `/pages/tool/index?id=${tool.value.id}` : '/pages/index/index',
}));

const modeLabel = computed(() => {
  if (!tool.value) return '';
  if (tool.value.mode === 'local') return '⚡ 纯离线 0延迟';
  if (tool.value.mode === 'cloud') return '☁️ 云端高保真引擎';
  return '🔀 本地/云端双引擎';
});

const originalTotalSize = computed(() =>
  files.value.reduce((sum, f) => sum + (f.size || 0), 0)
);

function onStart() {
  processing.value = true;
  progress.value = 12;
  stageText.value = '正在准备处理...';
  outputs.value = [];
  errorMessage.value = '';
}

function onProgress(pct: number, text: string) {
  progress.value = pct;
  stageText.value = text;
}

function onDone(resultOutputs: OutputFileRef[], mode: 'local' | 'cloud') {
  processing.value = false;
  progress.value = 100;
  stageText.value = '处理完成';
  outputs.value = resultOutputs;

  if (tool.value && resultOutputs.length > 0) {
    const totalOutSize = resultOutputs.reduce((s, o) => s + o.size, 0);
    addConversionRecord({
      toolId: tool.value.id,
      toolTitle: tool.value.title,
      mode,
      inputNames: files.value.map((f) => f.name),
      outputCount: resultOutputs.length,
      outputSummary: `${resultOutputs.length} 份 · ${formatBytes(totalOutSize)}`,
      primaryFileName: resultOutputs[0].fileName,
      primaryUrl: resultOutputs[0].downloadUrl,
      primarySource: resultOutputs[0].source,
    });
  }
}

function onError(msg: string) {
  processing.value = false;
  progress.value = 0;
  errorMessage.value = msg;
}
</script>

<style lang="scss" scoped>
.tool-page {
  min-height: 100vh;
  padding: 24rpx 24rpx calc(60rpx + env(safe-area-inset-bottom));
  background: #f4f7fc;
}

.tool-banner {
  background: #ffffff;
  border-radius: 26rpx;
  padding: 24rpx;
  display: flex;
  align-items: center;
  gap: 20rpx;
  box-shadow: 0 6rpx 20rpx rgba(30, 64, 130, 0.045);
  margin-bottom: 24rpx;
}

.banner-info {
  flex: 1;
  min-width: 0;
}

.banner-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12rpx;
  margin-bottom: 6rpx;
}

.banner-title {
  font-size: 32rpx;
  font-weight: 800;
  color: #132b54;
}

.mode-pill {
  padding: 4rpx 14rpx;
  border-radius: 999rpx;
  font-size: 20rpx;
  font-weight: 600;
  flex-shrink: 0;

  &.mode--local {
    background: #eafaf1;
    color: #15803d;
  }
  &.mode--cloud {
    background: #ecf3ff;
    color: #2563eb;
  }
  &.mode--hybrid {
    background: #fff7ed;
    color: #c2410c;
  }
}

.banner-desc {
  font-size: 24rpx;
  color: #64748b;
}

.not-found {
  padding: 120rpx 40rpx;
  text-align: center;
  color: #64748b;
  font-size: 28rpx;
}
</style>
