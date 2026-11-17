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
        <input
          v-model="watermarkText"
          maxlength="120"
          class="ws-input"
          :class="{ 'ws-input--danger': Boolean(pdfWmComplianceWarning) }"
          placeholder="如：仅供XX公司入职核验使用"
        />
        <view v-if="pdfWmComplianceWarning" class="ws-compliance-err">
          {{ pdfWmComplianceWarning }}
        </view>
        <view v-else class="ws-compliance-tip">
          🛡️ 已接入内容安全合规检测，严禁输入违法违规及敏感词汇
        </view>
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

      <view v-if="splitMode === 'extract-selected'" class="ws-field">
        <view class="ws-label-row">
          <text class="ws-label">指定页码范围</text>
          <text v-if="pdfTotalPages > 0" class="ws-val">共 {{ pdfTotalPages }} 页</text>
        </view>
        <input v-model="pageRange" class="ws-input" placeholder="如：1,3-5（或下方直接滑动预览点选）" @input="syncPagesFromRange" />
      </view>

      <view v-if="inspectingPdf" class="thumb-loading-box">
        <text class="thumb-loading-title">正在解析 PDF 页面并生成缩略图预览...</text>
        <text class="thumb-loading-sub">页数较多时约需 1～3 秒，请稍候</text>
      </view>
      <view v-else-if="inspectError" class="ws-hint thumb-error-hint">
        {{ inspectError }}（仍可在上方手动输入页码范围后提交）
      </view>
      <view v-else-if="pdfTotalPages > 0" class="ws-field">
        <view class="thumb-toolbar">
          <view class="thumb-toolbar-left">
            <text class="ws-label">{{ splitMode === 'extract-selected' ? '页面预览点选' : '全部页面预览' }}</text>
            <text v-if="splitMode === 'extract-selected'" class="thumb-count-badge">
              已选 {{ selectedPages.length }} / {{ pdfTotalPages }} 页
            </text>
            <text v-else class="thumb-count-badge">共 {{ pdfTotalPages }} 页</text>
          </view>
          <view v-if="splitMode === 'extract-selected'" class="thumb-actions">
            <text class="thumb-action-btn" @click="toggleAllPages">
              {{ selectedPages.length === pdfTotalPages ? '取消全选' : '全选' }}
            </text>
            <text class="thumb-action-sep">|</text>
            <text class="thumb-action-btn" @click="invertSelectedPages">反选</text>
            <text class="thumb-action-sep">|</text>
            <text class="thumb-action-btn danger" @click="clearSelectedPages">清空</text>
          </view>
        </view>

        <view class="thumb-tip">
          <template v-if="splitMode === 'extract-selected'">
            上下滑动浏览全部 {{ pdfTotalPages }} 页，点击选中/取消，长按放大查看
          </template>
          <template v-else>
            上下滑动预览全部 {{ pdfTotalPages }} 页，逐页拆分将为每页生成独立 PDF{{ pdfTotalPages > 30 ? '（页数较多，如仅需部分页面建议使用「提取勾选页面」）' : '' }}
          </template>
        </view>

        <view v-if="thumbnailsTruncated" class="thumb-truncated-tip">
          页数较多，前 {{ thumbnailRenderedCount }} 页展示图像缩略图，其余页面仍可滑动点击选择或输入页码范围
        </view>

        <scroll-view
          scroll-y
          show-scrollbar
          class="thumb-scroll"
          :class="{ 'thumb-scroll--compact': pdfTotalPages <= 8 }"
        >
          <view class="thumb-grid">
            <view
              v-for="item in displayPages"
              :key="item.pageNumber"
              class="thumb-card"
              :class="{
                selected: splitMode === 'extract-selected' && selectedPageSet.has(item.pageNumber),
                readonly: splitMode === 'each-page',
              }"
              @click="onThumbCardClick(item)"
              @longpress="openZoomPreview(item)"
            >
              <image
                v-if="item.thumbnail"
                :src="item.thumbnail"
                mode="aspectFit"
                class="thumb-img"
                lazy-load
              />
              <view v-else class="thumb-placeholder">
                <view class="thumb-ph-line long"></view>
                <view class="thumb-ph-line"></view>
                <view class="thumb-ph-line short"></view>
                <text class="thumb-ph-tag">P{{ item.pageNumber }}</text>
              </view>

              <view
                v-if="splitMode === 'extract-selected' && selectedPageSet.has(item.pageNumber)"
                class="thumb-check-badge"
              >
                ✓
              </view>

              <view
                class="thumb-page-num"
                :class="{ active: splitMode === 'extract-selected' && selectedPageSet.has(item.pageNumber) }"
              >
                {{ item.pageNumber }}
              </view>
            </view>
          </view>
        </scroll-view>
      </view>
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

  <!-- 页面缩略图放大预览弹层 -->
  <view v-if="zoomPreviewPage" class="thumb-modal-mask" @click="closeZoomPreview">
    <view class="thumb-modal-card" @click.stop>
      <view class="thumb-modal-head">
        <text class="thumb-modal-title">第 {{ zoomPreviewPage.pageNumber }} / {{ pdfTotalPages }} 页</text>
        <text class="thumb-modal-close" @click="closeZoomPreview">✕</text>
      </view>
      <view class="thumb-modal-body">
        <image
          v-if="zoomPreviewPage.thumbnail"
          :src="zoomPreviewPage.thumbnail"
          mode="aspectFit"
          class="thumb-modal-img"
        />
        <view v-else class="thumb-modal-empty">
          <text class="thumb-modal-empty-title">第 {{ zoomPreviewPage.pageNumber }} 页</text>
          <text class="thumb-modal-empty-sub">页数较多已省略此页图像缩略图，可照常勾选提取</text>
        </view>
      </view>
      <view class="thumb-modal-foot">
        <view
          class="thumb-modal-nav"
          :class="{ disabled: zoomPreviewPage.pageNumber <= 1 }"
          @click="stepZoomPreview(-1)"
        >
          上一页
        </view>
        <view
          v-if="splitMode === 'extract-selected'"
          class="thumb-modal-toggle"
          :class="{ selected: selectedPageSet.has(zoomPreviewPage.pageNumber) }"
          @click="togglePage(zoomPreviewPage.pageNumber)"
        >
          {{ selectedPageSet.has(zoomPreviewPage.pageNumber) ? '✓ 已选中' : '勾选此页' }}
        </view>
        <view
          class="thumb-modal-nav"
          :class="{ disabled: zoomPreviewPage.pageNumber >= pdfTotalPages }"
          @click="stepZoomPreview(1)"
        >
          下一页
        </view>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { OutputFileRef, PdfInspectPageMeta, ToolMeta, ToolParams } from '@tool-universal/shared';
import { runImagesToPdfLocal } from '@/utils/canvasEngine';
import {
  ensureCustomTextCompliant,
  getLocalTextComplianceWarning,
  isComplianceError,
  showComplianceBlockModal,
} from '@/utils/compliance';
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
const pdfWmComplianceWarning = computed(() => getLocalTextComplianceWarning(watermarkText.value));
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
const pdfPages = ref<PdfInspectPageMeta[]>([]);
const thumbnailsTruncated = ref(false);
const selectedPages = ref<number[]>([]);
const inspectingPdf = ref(false);
const inspectError = ref('');
const zoomPreviewPageNumber = ref<number | null>(null);
let inspectRequestSeq = 0;

const selectedPageSet = computed(() => new Set(selectedPages.value));

const displayPages = computed<PdfInspectPageMeta[]>(() => {
  if (pdfTotalPages.value <= 0) return [];
  if (pdfPages.value.length === pdfTotalPages.value) {
    return pdfPages.value;
  }
  const byPage = new Map<number, PdfInspectPageMeta>();
  for (const item of pdfPages.value) {
    byPage.set(item.pageNumber, item);
  }
  return Array.from({ length: pdfTotalPages.value }, (_, idx) => {
    const pageNumber = idx + 1;
    return byPage.get(pageNumber) || { pageNumber, width: 595, height: 842 };
  });
});

const thumbnailRenderedCount = computed(
  () => displayPages.value.filter((item) => Boolean(item.thumbnail)).length
);

const zoomPreviewPage = computed<PdfInspectPageMeta | null>(() => {
  if (zoomPreviewPageNumber.value === null) return null;
  return displayPages.value[zoomPreviewPageNumber.value - 1] || null;
});

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
  const max = pdfTotalPages.value || 9999;
  const set = new Set<number>();
  for (const seg of pageRange.value.split(/[,，\s]+/).filter(Boolean)) {
    const m = /^(\d+)-(\d+)$/.exec(seg.trim());
    if (m) {
      const rawStart = Number(m[1]);
      const rawEnd = Number(m[2]);
      const s = Math.max(1, Math.min(rawStart, rawEnd));
      const e = Math.min(max, Math.max(rawStart, rawEnd));
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
    const seq = ++inspectRequestSeq;
    pdfTotalPages.value = 0;
    pdfPages.value = [];
    thumbnailsTruncated.value = false;
    selectedPages.value = [];
    inspectError.value = '';
    zoomPreviewPageNumber.value = null;

    if (newFiles.length === 0) {
      inspectingPdf.value = false;
      return;
    }

    inspectingPdf.value = true;
    try {
      const info = await inspectPdfRemote(newFiles[0]);
      if (seq !== inspectRequestSeq) return;
      pdfTotalPages.value = info.pageCount;
      pdfPages.value = Array.isArray(info.pages) ? info.pages : [];
      thumbnailsTruncated.value = Boolean(info.thumbnailsTruncated);
      selectedPages.value = info.pageCount > 0 ? [1] : [];
      pageRange.value = info.pageCount > 0 ? '1' : '';
    } catch (err: any) {
      if (seq !== inspectRequestSeq) return;
      inspectError.value = err?.message || '页面缩略图解析失败';
    } finally {
      if (seq === inspectRequestSeq) {
        inspectingPdf.value = false;
      }
    }
  },
  { deep: false }
);

function togglePage(p: number) {
  if (selectedPageSet.value.has(p)) {
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

function invertSelectedPages() {
  if (pdfTotalPages.value <= 0) return;
  const current = selectedPageSet.value;
  const next: number[] = [];
  for (let i = 1; i <= pdfTotalPages.value; i++) {
    if (!current.has(i)) next.push(i);
  }
  selectedPages.value = next;
  pageRange.value = formatCompactRanges(next);
}

function clearSelectedPages() {
  selectedPages.value = [];
  pageRange.value = '';
}

function onThumbCardClick(item: PdfInspectPageMeta) {
  if (splitMode.value === 'extract-selected') {
    togglePage(item.pageNumber);
  } else {
    openZoomPreview(item);
  }
}

function openZoomPreview(item: PdfInspectPageMeta) {
  zoomPreviewPageNumber.value = item.pageNumber;
}

function closeZoomPreview() {
  zoomPreviewPageNumber.value = null;
}

function stepZoomPreview(delta: number) {
  if (zoomPreviewPageNumber.value === null) return;
  const next = zoomPreviewPageNumber.value + delta;
  if (next >= 1 && next <= pdfTotalPages.value) {
    zoomPreviewPageNumber.value = next;
  }
}

async function startConvert() {
  if (props.files.length === 0) return;
  if (props.tool.id === 'pdf-merge' && props.files.length < 2) {
    uni.showToast({ title: '请至少选择 2 份 PDF 合并', icon: 'none' });
    return;
  }
  if (
    props.tool.id === 'pdf-split' &&
    splitMode.value === 'extract-selected' &&
    selectedPages.value.length === 0 &&
    !pageRange.value.trim()
  ) {
    uni.showToast({ title: '请先勾选或输入要提取的页码', icon: 'none' });
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

    let watermarkParam: ToolParams['watermark'];
    if (props.tool.id === 'pdf-watermark') {
      const effectiveWmText = watermarkText.value.trim() || '内部文档';
      emit('progress', 18, '正在进行内容安全合规检测...');
      await ensureCustomTextCompliant(effectiveWmText, 'document');
      watermarkParam = {
        enabled: true,
        text: effectiveWmText,
        mode: watermarkMode.value,
        fontSize: watermarkFontSize.value,
        angle: watermarkAngle.value,
        opacity: opacity.value,
        color: watermarkColor.value,
      };
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
      watermark: watermarkParam,
    };

    const task = await executeCloudToolTask(props.tool.id, props.files, params, (p, s) => {
      emit('progress', p, s);
    });
    emit('done', task.outputs, 'cloud');
  } catch (err: any) {
    const msg = err?.message || 'PDF 处理失败';
    if (isComplianceError(err)) {
      showComplianceBlockModal(msg, err);
    }
    emit('error', msg);
  }
}
</script>

<style lang="scss" scoped>
@use './workspace.scss' as *;

.thumb-loading-box {
  background: #f8fafc;
  border: 1px dashed #cbd5e1;
  border-radius: 18rpx;
  padding: 28rpx 24rpx;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8rpx;
  margin-bottom: 12rpx;
}

.thumb-loading-title {
  font-size: 26rpx;
  font-weight: 600;
  color: #1e293b;
}

.thumb-loading-sub {
  font-size: 22rpx;
  color: #64748b;
}

.thumb-error-hint {
  color: #b45309;
  background: #fffbeb;
  border-color: #fde68a;
}

.thumb-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12rpx;
  margin-bottom: 10rpx;
}

.thumb-toolbar-left {
  display: flex;
  align-items: center;
  gap: 12rpx;
  flex-wrap: wrap;
}

.thumb-count-badge {
  font-size: 22rpx;
  font-weight: 600;
  color: #ef4444;
  background: #fef2f2;
  border: 1px solid #fecaca;
  padding: 4rpx 14rpx;
  border-radius: 999rpx;
}

.thumb-actions {
  display: flex;
  align-items: center;
  gap: 10rpx;
  flex-shrink: 0;
}

.thumb-action-btn {
  font-size: 24rpx;
  font-weight: 600;
  color: #2563eb;
  padding: 4rpx 6rpx;

  &.danger {
    color: #ef4444;
  }
}

.thumb-action-sep {
  font-size: 22rpx;
  color: #cbd5e1;
}

.thumb-tip {
  font-size: 22rpx;
  color: #64748b;
  line-height: 1.5;
  margin-bottom: 12rpx;
}

.thumb-truncated-tip {
  font-size: 22rpx;
  color: #b45309;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 12rpx;
  padding: 10rpx 14rpx;
  margin-bottom: 12rpx;
  line-height: 1.5;
}

.thumb-scroll {
  height: 660rpx;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 20rpx;
  box-sizing: border-box;
  padding: 16rpx;

  &--compact {
    height: auto;
    max-height: 460rpx;
  }
}

.thumb-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16rpx 14rpx;
  padding-bottom: 8rpx;
}

.thumb-card {
  position: relative;
  height: 206rpx;
  background: #ffffff;
  border-radius: 14rpx;
  border: 3rpx solid #e2e8f0;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2rpx 8rpx rgba(15, 23, 42, 0.05);
  box-sizing: border-box;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;

  &.selected {
    border-color: #ef4444;
    box-shadow: 0 4rpx 14rpx rgba(239, 68, 68, 0.18);
  }

  &.readonly {
    border-color: #cbd5e1;
  }
}

.thumb-img {
  width: 100%;
  height: 100%;
  background: #ffffff;
}

.thumb-placeholder {
  width: 100%;
  height: 100%;
  padding: 20rpx 14rpx 42rpx;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  gap: 10rpx;
  background: #ffffff;
}

.thumb-ph-line {
  height: 8rpx;
  width: 78%;
  border-radius: 6rpx;
  background: #e2e8f0;

  &.long {
    width: 92%;
    background: #cbd5e1;
  }

  &.short {
    width: 55%;
  }
}

.thumb-ph-tag {
  margin-top: auto;
  font-size: 20rpx;
  color: #94a3b8;
  text-align: center;
}

.thumb-check-badge {
  position: absolute;
  top: 6rpx;
  right: 6rpx;
  width: 30rpx;
  height: 30rpx;
  border-radius: 999rpx;
  background: #ef4444;
  color: #ffffff;
  font-size: 20rpx;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2rpx 6rpx rgba(239, 68, 68, 0.35);
}

.thumb-page-num {
  position: absolute;
  bottom: 8rpx;
  left: 50%;
  transform: translateX(-50%);
  min-width: 40rpx;
  padding: 2rpx 12rpx;
  border-radius: 999rpx;
  background: rgba(255, 255, 255, 0.9);
  color: #64748b;
  font-size: 26rpx;
  font-weight: 600;
  line-height: 1.25;
  text-align: center;

  &.active {
    color: #ef4444;
    font-weight: 700;
  }
}

.thumb-modal-mask {
  position: fixed;
  inset: 0;
  z-index: 999;
  background: rgba(15, 23, 42, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 36rpx;
  box-sizing: border-box;
}

.thumb-modal-card {
  width: 100%;
  max-width: 620rpx;
  background: #ffffff;
  border-radius: 24rpx;
  overflow: hidden;
  box-shadow: 0 20rpx 50rpx rgba(15, 23, 42, 0.3);
}

.thumb-modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 24rpx 28rpx;
  border-bottom: 1px solid #f1f5f9;
}

.thumb-modal-title {
  font-size: 28rpx;
  font-weight: 700;
  color: #0f172a;
}

.thumb-modal-close {
  font-size: 32rpx;
  color: #64748b;
  padding: 4rpx 12rpx;
}

.thumb-modal-body {
  background: #f8fafc;
  padding: 24rpx;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 520rpx;
}

.thumb-modal-img {
  width: 100%;
  height: 620rpx;
  background: #ffffff;
  border-radius: 12rpx;
  box-shadow: 0 6rpx 20rpx rgba(15, 23, 42, 0.08);
}

.thumb-modal-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12rpx;
  padding: 40rpx 20rpx;
  text-align: center;
}

.thumb-modal-empty-title {
  font-size: 32rpx;
  font-weight: 700;
  color: #334155;
}

.thumb-modal-empty-sub {
  font-size: 24rpx;
  color: #64748b;
  line-height: 1.6;
}

.thumb-modal-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16rpx;
  padding: 20rpx 24rpx 26rpx;
  border-top: 1px solid #f1f5f9;
}

.thumb-modal-nav {
  flex: 1;
  height: 68rpx;
  border-radius: 14rpx;
  background: #f1f5f9;
  color: #334155;
  font-size: 25rpx;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;

  &.disabled {
    opacity: 0.4;
  }
}

.thumb-modal-toggle {
  flex: 1.3;
  height: 68rpx;
  border-radius: 14rpx;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  color: #2563eb;
  font-size: 25rpx;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;

  &.selected {
    background: #ef4444;
    border-color: #ef4444;
    color: #ffffff;
  }
}
</style>
