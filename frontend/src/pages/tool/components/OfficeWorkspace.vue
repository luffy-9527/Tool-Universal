<template>
  <view class="ws-panel">
    <view class="ws-section-title">参数设置</view>

    <!-- Watermark option for Word/PPT -> PDF -->
    <template v-if="tool.id === 'word-to-pdf' || tool.id === 'ppt-to-pdf'">
      <view class="ws-field ws-switch-row">
        <text class="ws-label">开启防盗水印</text>
        <switch :checked="watermarkEnabled" color="#2563EB" @change="onWatermarkSwitch" />
      </view>
      <template v-if="watermarkEnabled">
        <view class="ws-field">
          <view class="ws-label-row"><text class="ws-label">水印文字</text></view>
          <input v-model="watermarkText" class="ws-input" placeholder="如：仅供内部审核使用" />
        </view>
        <view class="ws-field">
          <view class="ws-label-row"><text class="ws-label">水印样式</text></view>
          <view class="ws-chips">
            <view class="ws-chip" :class="{ active: watermarkMode === 'tile' }" @click="watermarkMode = 'tile'">平铺满屏</view>
            <view class="ws-chip" :class="{ active: watermarkMode === 'center' }" @click="watermarkMode = 'center'">居中大字</view>
          </view>
        </view>
      </template>
    </template>

    <!-- Excel -> PDF -->
    <template v-else-if="tool.id === 'excel-to-pdf'">
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">页面方向</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: landscape === 'auto' }" @click="landscape = 'auto'">智能适配</view>
          <view class="ws-chip" :class="{ active: landscape === true }" @click="landscape = true">横向宽表</view>
          <view class="ws-chip" :class="{ active: landscape === false }" @click="landscape = false">纵向 A4</view>
        </view>
      </view>
      <view class="ws-field ws-switch-row">
        <text class="ws-label">自适应列宽一页显示</text>
        <switch :checked="fitToPage" color="#2563EB" @change="(e: any) => (fitToPage = e.detail.value)" />
      </view>
      <view class="ws-hint">
        完整保留合并单元格、字体颜色、表格边框及单元格内嵌照片，自动按工作表比例智能排版。
      </view>
    </template>

    <!-- Word / Excel / PPT -> Image / Long Image -->
    <template v-else-if="tool.id === 'word-to-image' || tool.id === 'excel-to-long-image' || tool.id === 'ppt-to-image'">
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">导出形式</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: outputStyle === 'long-image' }" @click="outputStyle = 'long-image'">无缝整份长图</view>
          <view class="ws-chip" :class="{ active: outputStyle === 'pages' }" @click="outputStyle = 'pages'">逐页高清图片</view>
        </view>
      </view>
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">图片格式</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: imageFormat === 'png' }" @click="imageFormat = 'png'">PNG 超清</view>
          <view class="ws-chip" :class="{ active: imageFormat === 'jpg' }" @click="imageFormat = 'jpg'">JPG 轻量</view>
        </view>
      </view>
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">渲染清晰度 (DPI)</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: dpi === 150 }" @click="dpi = 150">150 DPI（标准）</view>
          <view class="ws-chip" :class="{ active: dpi === 200 }" @click="dpi = 200">200 DPI（超清）</view>
        </view>
      </view>
      <view v-if="tool.id === 'excel-to-long-image'" class="ws-hint">
        表格行数较多或单张长图高度受限时，可切换上方「逐页高清图片」按页完整导出。
      </view>
    </template>

    <!-- Extract Doc Images -->
    <template v-else-if="tool.id === 'extract-doc-images'">
      <view class="ws-hint">
        支持 PDF、Word (.docx)、Excel (.xlsx)、PPT (.pptx)。自动解析文档内部媒体包与矢量内嵌原图，逐张无损提取导出。
      </view>
    </template>

    <!-- Invoice Scan Enhance -->
    <template v-else-if="tool.id === 'invoice-scan-enhance'">
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">增强力度</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: enhanceStrength === 'strong' }" @click="enhanceStrength = 'strong'">强力去阴影（白底黑字）</view>
          <view class="ws-chip" :class="{ active: enhanceStrength === 'mild' }" @click="enhanceStrength = 'mild'">柔和去灰底（保留印章）</view>
        </view>
      </view>
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">处理引擎</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: useLocalScan }" @click="useLocalScan = true">⚡ 本地零延迟处理</view>
          <view class="ws-chip" :class="{ active: !useLocalScan }" @click="useLocalScan = false">☁️ 云端 Sharp 精修</view>
        </view>
      </view>
      <view class="ws-hint">
        「强力去阴影」适合纯文字黑白打印；「柔和去灰底」可提亮纸面并保留红章/彩字细节。
      </view>
    </template>
  </view>

  <button class="tu-primary-btn" :disabled="files.length === 0 || processing" @click="startConvert">
    {{ processing ? '正在处理中...' : '开始转换处理' }}
  </button>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import type { OutputFileRef, ToolMeta, ToolParams } from '@tool-universal/shared';
import { runScanEnhanceLocal } from '@/utils/canvasEngine';
import { executeCloudToolTask, type LocalPickedFile } from '@/utils/request';

const props = defineProps<{
  tool: ToolMeta;
  files: LocalPickedFile[];
  processing: boolean;
}>();

const emit = defineEmits<{
  (e: 'start'): void;
  (e: 'progress', progress: number, stageText: string): void;
  (e: 'done', outputs: OutputFileRef[], mode: 'local' | 'cloud'): void;
  (e: 'error', msg: string): void;
}>();

const watermarkEnabled = ref(false);
const watermarkText = ref('仅供内部参考 · 禁止外传');
const watermarkMode = ref<'tile' | 'center'>('tile');
const landscape = ref<boolean | 'auto'>('auto');
const fitToPage = ref(true);
const outputStyle = ref<'pages' | 'long-image'>('long-image');
const imageFormat = ref<'png' | 'jpg'>('png');
const dpi = ref<150 | 200>(150);
const enhanceStrength = ref<'mild' | 'strong'>('strong');
const useLocalScan = ref(true);

watch(
  () => props.tool.id,
  (id) => {
    outputStyle.value = id === 'ppt-to-image' ? 'pages' : 'long-image';
  },
  { immediate: true }
);

function onWatermarkSwitch(e: any) {
  watermarkEnabled.value = Boolean(e.detail?.value);
}

async function startConvert() {
  if (props.files.length === 0) return;
  emit('start');

  try {
    if (props.tool.id === 'invoice-scan-enhance' && useLocalScan.value) {
      emit('progress', 35, '正在本地去除阴影灰底...');
      const outputs = await runScanEnhanceLocal(props.files[0], enhanceStrength.value);
      emit('done', outputs, 'local');
      return;
    }

    const params: ToolParams = {
      outputStyle: outputStyle.value,
      imageFormat: imageFormat.value,
      dpi: dpi.value,
      landscape: landscape.value,
      fitToPage: fitToPage.value,
      enhanceStrength: enhanceStrength.value,
      watermark: watermarkEnabled.value
        ? {
            enabled: true,
            text: watermarkText.value.trim() || '仅供内部参考',
            mode: watermarkMode.value,
            opacity: 0.25,
          }
        : undefined,
    };

    const task = await executeCloudToolTask(props.tool.id, props.files, params, (p, s) => {
      emit('progress', p, s);
    });
    emit('done', task.outputs, 'cloud');
  } catch (err: any) {
    emit('error', err?.message || '处理失败');
  }
}
</script>

<style lang="scss" scoped>
@use './workspace.scss' as *;
</style>
