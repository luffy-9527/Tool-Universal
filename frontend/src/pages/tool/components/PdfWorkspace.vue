<template>
  <view class="ws-panel">
    <view class="ws-section-title">PDF 参数设置</view>

    <!-- 多图合成 PDF -->
    <template v-if="tool.id === 'images-to-pdf'">
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">页面尺寸</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: pageSize === 'A4' }" @click="pageSize = 'A4'">A4 标准居中排版</view>
          <view class="ws-chip" :class="{ active: pageSize === 'fit' }" @click="pageSize = 'fit'">按原图尺寸铺满</view>
        </view>
      </view>
      <view v-if="pageSize === 'A4'" class="ws-field">
        <view class="ws-label-row">
          <text class="ws-label">页面留白边距</text>
          <text class="ws-val">{{ margin }} pt</text>
        </view>
        <slider :value="margin" :min="0" :max="48" activeColor="#2563EB" @change="(e: any) => (margin = e.detail.value)" />
      </view>
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">合成方式</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: useLocalPdf }" @click="useLocalPdf = true">⚡ 本地离线极速合成</view>
          <view class="ws-chip" :class="{ active: !useLocalPdf }" @click="useLocalPdf = false">☁️ 云端合成</view>
        </view>
      </view>
    </template>

    <!-- PDF 转 Word -->
    <template v-else-if="tool.id === 'pdf-to-word'">
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">分页与排版模式（全程可编辑）</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: preservePageBreaks }" @click="preservePageBreaks = true">
            保持原页分页（推荐）
          </view>
          <view class="ws-chip" :class="{ active: !preservePageBreaks }" @click="preservePageBreaks = false">
            连续流式重排
          </view>
        </view>
      </view>

      <view class="ws-field ws-switch-row">
        <text class="ws-label">提取 PDF 内嵌图片与标题图标</text>
        <switch :checked="preserveImages" color="#2563EB" @change="(e: any) => (preserveImages = e.detail.value)" />
      </view>

      <view class="ws-hint">
        全要素可编辑 DOCX 转换：自动还原文字颜色、加粗字号、标签底色、背景卡片与左竖条、分隔线、悬挂缩进及框线/三线表格；{{
          preservePageBreaks
            ? '「保持原页分页」将精确匹配原 PDF 页距与行距并延续每页分页结构。'
            : '「连续流式重排」将打通跨页段落连续顺延排版，适合纯文稿二次编辑。'
        }}
      </view>
    </template>

    <!-- PDF 加防盗水印 -->
    <template v-else-if="tool.id === 'pdf-watermark'">
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">水印内容</text></view>
        <input v-model="watermarkText" class="ws-input" placeholder="如：仅供XX公司入职核验使用" />
      </view>
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">排版模式</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: watermarkMode === 'tile' }" @click="watermarkMode = 'tile'">平铺满屏防盗</view>
          <view class="ws-chip" :class="{ active: watermarkMode === 'center' }" @click="watermarkMode = 'center'">单页居中大字</view>
        </view>
      </view>
      <view class="ws-field">
        <view class="ws-label-row">
          <text class="ws-label">字体大小</text>
          <text class="ws-val">{{ watermarkFontSize }} px</text>
        </view>
        <slider :value="watermarkFontSize" :min="14" :max="44" activeColor="#2563EB" @change="(e: any) => (watermarkFontSize = e.detail.value)" />
      </view>
      <view class="ws-field">
        <view class="ws-label-row">
          <text class="ws-label">透明度</text>
          <text class="ws-val">{{ Math.round(opacity * 100) }}%</text>
        </view>
        <slider :value="Math.round(opacity * 100)" :min="10" :max="70" activeColor="#2563EB" @change="(e: any) => (opacity = e.detail.value / 100)" />
      </view>
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">旋转角度</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: watermarkAngle === -30 }" @click="watermarkAngle = -30">-30° 斜向</view>
          <view class="ws-chip" :class="{ active: watermarkAngle === 0 }" @click="watermarkAngle = 0">0° 水平</view>
          <view class="ws-chip" :class="{ active: watermarkAngle === 30 }" @click="watermarkAngle = 30">30° 反向</view>
        </view>
      </view>
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">水印颜色</text></view>
        <view class="ws-swatches">
          <view v-for="c in watermarkColors" :key="c.hex" class="ws-swatch" :class="{ active: watermarkColor === c.hex }" @click="watermarkColor = c.hex">
            <view class="dot" :style="{ backgroundColor: c.hex }"></view>
            <text>{{ c.name }}</text>
          </view>
        </view>
      </view>
    </template>

    <!-- PDF 页面拆分 -->
    <template v-else-if="tool.id === 'pdf-split'">
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">拆分方式</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: splitMode === 'extract-selected' }" @click="splitMode = 'extract-selected'">提取勾选页面</view>
          <view class="ws-chip" :class="{ active: splitMode === 'each-page' }" @click="splitMode = 'each-page'">逐页拆分为多份</view>
        </view>
      </view>

      <template v-if="splitMode === 'extract-selected'">
        <view class="ws-field">
          <view class="ws-label-row">
            <text class="ws-label">指定页码范围</text>
            <text v-if="pdfTotalPages > 0" class="ws-val">共 {{ pdfTotalPages }} 页</text>
          </view>
          <input v-model="pageRange" class="ws-input" placeholder="如：1,3-5（或下方直接点选页码）" @input="syncPagesFromRange" />
        </view>

        <view v-if="inspectingPdf" class="ws-hint">正在解析 PDF 页数...</view>
        <view v-else-if="pdfTotalPages > 0" class="ws-field">
          <view class="ws-label-row">
            <text class="ws-label">快捷点选页面</text>
            <text class="ws-val" @click="toggleAllPages">{{ selectedPages.length === pdfTotalPages ? '取消全选' : '全选' }}</text>
          </view>
          <view class="page-grid">
            <view
              v-for="p in Math.min(pdfTotalPages, 60)"
              :key="p"
              class="page-pill"
              :class="{ active: selectedPages.includes(p) }"
              @click="togglePage(p)"
            >
              {{ p }}
            </view>
          </view>
        </view>
      </template>
    </template>

    <!-- PDF 多份合并 -->
    <template v-else-if="tool.id === 'pdf-merge'">
      <view class="ws-hint">
        请在上方上传区添加 2 份及以上 PDF 文档，可使用列表右侧「↑ / ↓」按钮调整合并顺序。
      </view>
    </template>

    <!-- PDF 转图片 -->
    <template v-else-if="tool.id === 'pdf-to-image'">
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">输出图片格式</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: imageFormat === 'png' }" @click="imageFormat = 'png'">PNG 无损高清</view>
          <view class="ws-chip" :class="{ active: imageFormat === 'jpg' }" @click="imageFormat = 'jpg'">JPG 体积更小</view>
        </view>
      </view>
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">渲染 DPI 分辨率</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: dpi === 150 }" @click="dpi = 150">150 DPI（快速）</view>
          <view class="ws-chip" :class="{ active: dpi === 200 }" @click="dpi = 200">200 DPI（推荐）</view>
          <view class="ws-chip" :class="{ active: dpi === 300 }" @click="dpi = 300">300 DPI（印刷级）</view>
        </view>
      </view>
    </template>
  </view>

  <button class="tu-primary-btn" :disabled="files.length === 0 || processing" @click="startConvert">
    {{ processing ? '正在处理中...' : '开始处理 PDF' }}
  </button>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import type { OutputFileRef, ToolMeta, ToolParams } from '@tool-universal/shared';
import { runImagesToPdfLocal } from '@/utils/canvasEngine';
import { executeCloudToolTask, inspectPdfRemote, type LocalPickedFile } from '@/utils/request';

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

const pageSize = ref<'A4' | 'fit'>('A4');
const margin = ref(20);
const useLocalPdf = ref(true);

const watermarkText = ref('仅限办理业务使用 · 他用无效');
const watermarkMode = ref<'tile' | 'center'>('tile');
const watermarkFontSize = ref(22);
const watermarkAngle = ref(-30);
const opacity = ref(0.28);
const watermarkColor = ref('#666666');
const watermarkColors = [
  { name: '经典灰', hex: '#666666' },
  { name: '警示红', hex: '#DC2626' },
  { name: '商务蓝', hex: '#2563EB' },
];

const splitMode = ref<'extract-selected' | 'each-page'>('extract-selected');
const pageRange = ref('1');
const pdfTotalPages = ref(0);
const selectedPages = ref<number[]>([]);
const inspectingPdf = ref(false);

const imageFormat = ref<'png' | 'jpg'>('png');
const dpi = ref<150 | 200 | 300>(200);

const preservePageBreaks = ref(true);
const preserveImages = ref(true);

function formatCompactRanges(nums: number[]): string {
  if (nums.length === 0) return '';
  const sorted = [...nums].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) {
      prev = sorted[i];
    } else {
      parts.push(start === prev ? `${start}` : `${start}-${prev}`);
      start = sorted[i];
      prev = sorted[i];
    }
  }
  parts.push(start === prev ? `${start}` : `${start}-${prev}`);
  return parts.join(',');
}

function syncPagesFromRange() {
  const max = pdfTotalPages.value || 999;
  const set = new Set<number>();
  for (const seg of pageRange.value.split(/[,，\s]+/).filter(Boolean)) {
    const m = /^(\d+)-(\d+)$/.exec(seg.trim());
    if (m) {
      const s = Math.max(1, Number(m[1]));
      const e = Math.min(max, Number(m[2]));
      for (let i = s; i <= e; i++) set.add(i);
    } else if (/^\d+$/.test(seg.trim())) {
      const n = Number(seg.trim());
      if (n >= 1 && n <= max) set.add(n);
    }
  }
  selectedPages.value = Array.from(set).sort((a, b) => a - b);
}

watch(
  () => props.files,
  async (newFiles) => {
    if (props.tool.id !== 'pdf-split') return;
    pdfTotalPages.value = 0;
    selectedPages.value = [];
    if (newFiles.length === 0) return;
    inspectingPdf.value = true;
    try {
      const info = await inspectPdfRemote(newFiles[0]);
      pdfTotalPages.value = info.pageCount;
      selectedPages.value = info.pageCount > 0 ? [1] : [];
      pageRange.value = info.pageCount > 0 ? '1' : '';
    } catch {
      // Allow manual pageRange entry even if offline inspect fails
    } finally {
      inspectingPdf.value = false;
    }
  },
  { deep: false }
);

function togglePage(p: number) {
  if (selectedPages.value.includes(p)) {
    selectedPages.value = selectedPages.value.filter((x) => x !== p);
  } else {
    selectedPages.value = [...selectedPages.value, p].sort((a, b) => a - b);
  }
  pageRange.value = formatCompactRanges(selectedPages.value);
}

function toggleAllPages() {
  if (selectedPages.value.length === pdfTotalPages.value) {
    selectedPages.value = [];
  } else {
    selectedPages.value = Array.from({ length: pdfTotalPages.value }, (_, i) => i + 1);
  }
  pageRange.value = formatCompactRanges(selectedPages.value);
}

async function startConvert() {
  if (props.files.length === 0) return;
  if (props.tool.id === 'pdf-merge' && props.files.length < 2) {
    uni.showToast({ title: '请至少选择 2 份 PDF 合并', icon: 'none' });
    return;
  }

  emit('start');
  try {
    if (props.tool.id === 'images-to-pdf' && useLocalPdf.value) {
      emit('progress', 45, '正在本地合成 PDF 文档...');
      const outputs = await runImagesToPdfLocal(props.files, {
        pageSize: pageSize.value,
        margin: margin.value,
      });
      emit('done', outputs, 'local');
      return;
    }

    const params: ToolParams = {
      pageSize: pageSize.value,
      margin: margin.value,
      splitMode: splitMode.value,
      pages: pageRange.value.trim() ? undefined : selectedPages.value,
      pageRange: pageRange.value.trim(),
      preservePageBreaks: preservePageBreaks.value,
      preserveImages: preserveImages.value,
      imageFormat: imageFormat.value,
      dpi: dpi.value,
      watermark: {
        enabled: true,
        text: watermarkText.value.trim() || '内部文档',
        mode: watermarkMode.value,
        fontSize: watermarkFontSize.value,
        angle: watermarkAngle.value,
        opacity: opacity.value,
        color: watermarkColor.value,
      },
    };

    const task = await executeCloudToolTask(props.tool.id, props.files, params, (p, s) => {
      emit('progress', p, s);
    });
    emit('done', task.outputs, 'cloud');
  } catch (err: any) {
    emit('error', err?.message || 'PDF 处理失败');
  }
}
</script>

<style lang="scss" scoped>
@use './workspace.scss' as *;

.page-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 12rpx;
}

.page-pill {
  width: 68rpx;
  height: 58rpx;
  border-radius: 12rpx;
  background: #f1f5f9;
  color: #334155;
  font-size: 24rpx;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;

  &.active {
    background: #2563eb;
    color: #ffffff;
  }
}
</style>
