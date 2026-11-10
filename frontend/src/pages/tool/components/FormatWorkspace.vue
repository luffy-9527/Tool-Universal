<template>
  <view class="ws-panel">
    <view class="ws-section-title">格式优化设置</view>

    <template v-if="tool.id === 'image-format-convert'">
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">目标图片格式</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: targetFormat === 'png' }" @click="targetFormat = 'png'">PNG（支持透明）</view>
          <view class="ws-chip" :class="{ active: targetFormat === 'jpg' }" @click="targetFormat = 'jpg'">JPG（通用小体积）</view>
          <view class="ws-chip" :class="{ active: targetFormat === 'webp' }" @click="targetFormat = 'webp'">WEBP（高压缩）</view>
        </view>
      </view>
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">处理引擎</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: useLocalEngine }" @click="useLocalEngine = true">⚡ 本地 0 延迟</view>
          <view class="ws-chip" :class="{ active: !useLocalEngine }" @click="useLocalEngine = false">☁️ 云端 Sharp 引擎</view>
        </view>
      </view>
      <view class="ws-hint">
        默认采用本地 Canvas 0 延迟转换，若部分手机系统不支持本地 WEBP 编码将自动尝试云端 Sharp 转换。
      </view>
    </template>

    <template v-else-if="tool.id === 'image-compress'">
      <view class="ws-field">
        <view class="ws-label-row">
          <text class="ws-label">画质保留比例</text>
          <text class="ws-val">{{ quality }}%</text>
        </view>
        <slider :value="quality" :min="20" :max="95" activeColor="#2563EB" @change="(e: any) => (quality = e.detail.value)" />
      </view>
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">最大宽度限制</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: maxWidth === 0 }" @click="maxWidth = 0">保持原图尺寸</view>
          <view class="ws-chip" :class="{ active: maxWidth === 1920 }" @click="maxWidth = 1920">1920 px</view>
          <view class="ws-chip" :class="{ active: maxWidth === 1280 }" @click="maxWidth = 1280">1280 px</view>
          <view class="ws-chip" :class="{ active: maxWidth === 800 }" @click="maxWidth = 800">800 px（极小）</view>
        </view>
      </view>
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">压缩引擎</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: useLocalEngine }" @click="useLocalEngine = true">⚡ 本地离线压缩</view>
          <view class="ws-chip" :class="{ active: !useLocalEngine }" @click="useLocalEngine = false">☁️ 云端 MozJPEG 极限瘦身</view>
        </view>
      </view>
    </template>
  </view>

  <button class="tu-primary-btn" :disabled="files.length === 0 || processing" @click="startConvert">
    {{ processing ? '正在处理中...' : useLocalEngine ? '立即纯离线处理' : '开始云端精修压缩' }}
  </button>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import type { OutputFileRef, ToolMeta } from '@tool-universal/shared';
import { runImageCompressLocal, runImageFormatConvertLocal } from '@/utils/canvasEngine';
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

const targetFormat = ref<'png' | 'jpg' | 'webp'>('jpg');
const quality = ref(72);
const maxWidth = ref(1280);
const useLocalEngine = ref(true);

async function startConvert() {
  if (props.files.length === 0) return;
  emit('start');

  try {
    if (props.tool.id === 'image-format-convert') {
      if (useLocalEngine.value) {
        try {
          emit('progress', 55, `正在本地批量转换为 ${targetFormat.value.toUpperCase()}...`);
          const outputs = await runImageFormatConvertLocal(props.files, targetFormat.value);
          emit('done', outputs, 'local');
          return;
        } catch (localErr: any) {
          if (localErr?.message !== 'WEBP_UNSUPPORTED_LOCAL') throw localErr;
          emit('progress', 20, '当前机型不支持本地 WEBP，正切换至云端引擎...');
        }
      }

      const task = await executeCloudToolTask(
        'image-format-convert',
        props.files,
        { imageFormat: targetFormat.value },
        (p, s) => emit('progress', p, s)
      );
      emit('done', task.outputs, 'cloud');
      return;
    }

    if (useLocalEngine.value) {
      emit('progress', 55, '正在本地智能压缩瘦身...');
      const outputs = await runImageCompressLocal(props.files, {
        quality: quality.value,
        maxWidth: maxWidth.value > 0 ? maxWidth.value : undefined,
      });
      emit('done', outputs, 'local');
      return;
    }

    const task = await executeCloudToolTask(
      'image-compress',
      props.files,
      { quality: quality.value, maxWidth: maxWidth.value > 0 ? maxWidth.value : undefined },
      (p, s) => emit('progress', p, s)
    );
    emit('done', task.outputs, 'cloud');
  } catch (err: any) {
    emit('error', err?.message || '处理失败');
  }
}
</script>

<style lang="scss" scoped>
@use './workspace.scss' as *;
</style>
