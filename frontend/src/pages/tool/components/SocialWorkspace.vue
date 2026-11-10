<template>
  <view class="ws-panel">
    <view class="ws-section-title">创作参数设置</view>

    <!-- 1. 证件照一键换底色 -->
    <template v-if="tool.id === 'id-photo-bg'">
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">选择目标底色</text></view>
        <view class="ws-swatches">
          <view v-for="c in idColors" :key="c.hex" class="ws-swatch" :class="{ active: idBgColor === c.hex }" @click="idBgColor = c.hex">
            <view class="dot" :style="{ backgroundColor: c.hex }"></view>
            <text>{{ c.name }}</text>
          </view>
        </view>
      </view>
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">尺寸裁剪规格</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: idCropRatio === 'original' }" @click="idCropRatio = 'original'">保持原比例</view>
          <view class="ws-chip" :class="{ active: idCropRatio === '1inch' }" @click="idCropRatio = '1inch'">1 寸 (25×35mm)</view>
          <view class="ws-chip" :class="{ active: idCropRatio === '2inch' }" @click="idCropRatio = '2inch'">2 寸 (35×45mm)</view>
        </view>
      </view>
      <view class="ws-field">
        <view class="ws-label-row">
          <text class="ws-label">边缘抠图容差</text>
          <text class="ws-val">{{ tolerance }}</text>
        </view>
        <slider :value="tolerance" :min="15" :max="70" activeColor="#2563EB" @change="(e: any) => (tolerance = e.detail.value)" />
      </view>
      <view class="ws-field">
        <view class="ws-label-row">
          <text class="ws-label">发丝边缘柔化</text>
          <text class="ws-val">{{ feather }}</text>
        </view>
        <slider :value="feather" :min="1" :max="10" activeColor="#2563EB" @change="(e: any) => (feather = e.detail.value)" />
      </view>
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">抠图引擎</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: useLocalIdBg }" @click="useLocalIdBg = true">⚡ 本地极速换底</view>
          <view class="ws-chip" :class="{ active: !useLocalIdBg }" @click="useLocalIdBg = false">☁️ 云端精细抠图</view>
        </view>
      </view>
    </template>

    <!-- 2. 证件照冲印排版 -->
    <template v-else-if="tool.id === 'id-photo-layout'">
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">证件照规格（6寸标准相纸 300DPI）</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: idSpec === '1inch' }" @click="idSpec = '1inch'">1 寸 (25×35mm · 排8张)</view>
          <view class="ws-chip" :class="{ active: idSpec === '2inch' }" @click="idSpec = '2inch'">2 寸 (35×45mm · 排6张)</view>
        </view>
      </view>
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">相纸底色</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: paperBg === '#FFFFFF' }" @click="paperBg = '#FFFFFF'">纯白相纸</view>
          <view class="ws-chip" :class="{ active: paperBg === '#F1F5F9' }" @click="paperBg = '#F1F5F9'">浅灰底（方便裁白底照）</view>
        </view>
      </view>
      <view class="ws-field ws-switch-row">
        <text class="ws-label">绘制裁剪参考线</text>
        <switch :checked="showCutLines" color="#2563EB" @change="(e: any) => (showCutLines = e.detail.value)" />
      </view>
    </template>

    <!-- 3. 朋友圈九宫格 -->
    <template v-else-if="tool.id === 'grid-nine'">
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">宫格布局</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: gridLayout === '3x3' }" @click="gridLayout = '3x3'">3×3 九宫格 (9张)</view>
          <view class="ws-chip" :class="{ active: gridLayout === '2x2' }" @click="gridLayout = '2x2'">2×2 四宫格 (4张)</view>
          <view class="ws-chip" :class="{ active: gridLayout === '3x1' }" @click="gridLayout = '3x1'">3×1 横排三图 (3张)</view>
        </view>
      </view>
      <view class="ws-hint">
        自动按目标比例居中裁切并按顺序输出，纯本地 Canvas 0 延迟，生成后可一键全部保存至手机相册。
      </view>
    </template>

    <!-- 4. 多图长图拼接 -->
    <template v-else-if="tool.id === 'long-image-stitch'">
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">拼接方向</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: stitchDir === 'vertical' }" @click="stitchDir = 'vertical'">竖向长图拼接</view>
          <view class="ws-chip" :class="{ active: stitchDir === 'horizontal' }" @click="stitchDir = 'horizontal'">横向并排拼接</view>
        </view>
      </view>
      <view class="ws-field">
        <view class="ws-label-row">
          <text class="ws-label">图片间距</text>
          <text class="ws-val">{{ stitchGap }} px</text>
        </view>
        <slider :value="stitchGap" :min="0" :max="32" activeColor="#2563EB" @change="(e: any) => (stitchGap = e.detail.value)" />
      </view>
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">留白背景色</text></view>
        <view class="ws-swatches">
          <view v-for="c in stitchBgColors" :key="c.hex" class="ws-swatch" :class="{ active: stitchBg === c.hex }" @click="stitchBg = c.hex">
            <view class="dot" :style="{ backgroundColor: c.hex }"></view>
            <text>{{ c.name }}</text>
          </view>
        </view>
      </view>
    </template>

    <!-- 5. 图片防盗水印 -->
    <template v-else-if="tool.id === 'image-watermark'">
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">常用证件水印快捷填入</text></view>
        <view class="ws-chips">
          <view
            v-for="preset in watermarkPresets"
            :key="preset"
            class="ws-chip"
            :class="{ active: imgWmText === preset }"
            @click="imgWmText = preset"
          >
            {{ preset }}
          </view>
        </view>
      </view>
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">自定义水印文字</text></view>
        <input
          v-model="imgWmText"
          maxlength="120"
          class="ws-input"
          :class="{ 'ws-input--danger': Boolean(imgWmComplianceWarning) }"
          placeholder="输入防盗文字"
        />
        <view v-if="imgWmComplianceWarning" class="ws-compliance-err">
          {{ imgWmComplianceWarning }}
        </view>
        <view v-else class="ws-compliance-tip">
          🛡️ 已接入内容安全合规检测，严禁输入违法违规及敏感词汇
        </view>
      </view>
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">布局模式</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: imgWmMode === 'tile' }" @click="imgWmMode = 'tile'">全图斜向平铺</view>
          <view class="ws-chip" :class="{ active: imgWmMode === 'center' }" @click="imgWmMode = 'center'">居中防盗字样</view>
        </view>
      </view>
      <view class="ws-field">
        <view class="ws-label-row">
          <text class="ws-label">字体大小</text>
          <text class="ws-val">{{ imgWmFontSize }} px</text>
        </view>
        <slider :value="imgWmFontSize" :min="14" :max="46" activeColor="#2563EB" @change="(e: any) => (imgWmFontSize = e.detail.value)" />
      </view>
      <view class="ws-field">
        <view class="ws-label-row">
          <text class="ws-label">水印透明度</text>
          <text class="ws-val">{{ Math.round(imgWmOpacity * 100) }}%</text>
        </view>
        <slider :value="Math.round(imgWmOpacity * 100)" :min="10" :max="80" activeColor="#2563EB" @change="(e: any) => (imgWmOpacity = e.detail.value / 100)" />
      </view>
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">旋转角度</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: imgWmAngle === -30 }" @click="imgWmAngle = -30">-30° 斜向</view>
          <view class="ws-chip" :class="{ active: imgWmAngle === 0 }" @click="imgWmAngle = 0">0° 水平</view>
          <view class="ws-chip" :class="{ active: imgWmAngle === 30 }" @click="imgWmAngle = 30">30° 反向</view>
        </view>
      </view>
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">水印颜色</text></view>
        <view class="ws-swatches">
          <view v-for="c in wmColors" :key="c.hex" class="ws-swatch" :class="{ active: imgWmColor === c.hex }" @click="imgWmColor = c.hex">
            <view class="dot" :style="{ backgroundColor: c.hex }"></view>
            <text>{{ c.name }}</text>
          </view>
        </view>
      </view>
    </template>

    <!-- 6. 长图反向拆分 -->
    <template v-else-if="tool.id === 'long-image-split'">
      <view class="ws-field">
        <view class="ws-label-row"><text class="ws-label">切图模式</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: splitMode === 'ratio' }" @click="splitMode = 'ratio'">按社交轮播比例</view>
          <view class="ws-chip" :class="{ active: splitMode === 'count' }" @click="splitMode = 'count'">按固定份数等分</view>
        </view>
      </view>
      <view v-if="splitMode === 'ratio'" class="ws-field">
        <view class="ws-label-row"><text class="ws-label">目标比例</text></view>
        <view class="ws-chips">
          <view class="ws-chip" :class="{ active: splitRatio === '3:4' }" @click="splitRatio = '3:4'">3:4（小红书竖屏）</view>
          <view class="ws-chip" :class="{ active: splitRatio === '1:1' }" @click="splitRatio = '1:1'">1:1（朋友圈方图）</view>
          <view class="ws-chip" :class="{ active: splitRatio === '4:5' }" @click="splitRatio = '4:5'">4:5（公众号轮播）</view>
        </view>
      </view>
      <view v-else class="ws-field">
        <view class="ws-label-row">
          <text class="ws-label">等分切图份数</text>
          <text class="ws-val">{{ splitCount }} 张</text>
        </view>
        <slider :value="splitCount" :min="2" :max="9" activeColor="#2563EB" @change="(e: any) => (splitCount = e.detail.value)" />
      </view>
    </template>
  </view>

  <button class="tu-primary-btn" :disabled="files.length === 0 || processing" @click="startConvert">
    {{ processing ? '正在生成中...' : '立即生成处理' }}
  </button>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { OutputFileRef, ToolMeta } from '@tool-universal/shared';
import {
  runGridSplitLocal,
  runIdPhotoBgLocal,
  runIdPhotoLayoutLocal,
  runImageWatermarkLocal,
  runLongImageSplitLocal,
  runLongStitchLocal,
} from '@/utils/canvasEngine';
import {
  ensureCustomTextCompliant,
  getLocalTextComplianceWarning,
  isComplianceError,
  showComplianceBlockModal,
} from '@/utils/compliance';
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

const idColors = [
  { name: '标准蓝', hex: '#438EDB' },
  { name: '喜庆红', hex: '#D9001B' },
  { name: '纯净白', hex: '#FFFFFF' },
  { name: '高级灰', hex: '#8C929C' },
];
const idBgColor = ref('#438EDB');
const idCropRatio = ref<'original' | '1inch' | '2inch'>('original');
const tolerance = ref(38);
const feather = ref(4);
const useLocalIdBg = ref(true);

const idSpec = ref<'1inch' | '2inch'>('1inch');
const paperBg = ref('#FFFFFF');
const showCutLines = ref(true);

const gridLayout = ref<'3x3' | '2x2' | '3x1'>('3x3');

const stitchDir = ref<'vertical' | 'horizontal'>('vertical');
const stitchGap = ref(0);
const stitchBgColors = [
  { name: '纯白', hex: '#FFFFFF' },
  { name: '浅灰', hex: '#F1F5F9' },
  { name: '酷黑', hex: '#111827' },
];
const stitchBg = ref('#FFFFFF');

const watermarkPresets = ['仅供实名认证使用', '仅限办理租房签约', '仅供入职背调核验'];
const imgWmText = ref('仅供实名认证使用 · 他用无效');
const imgWmComplianceWarning = computed(() => getLocalTextComplianceWarning(imgWmText.value));
const imgWmMode = ref<'tile' | 'center'>('tile');
const imgWmFontSize = ref(24);
const imgWmOpacity = ref(0.32);
const imgWmAngle = ref(-30);
const wmColors = [
  { name: '防盗灰', hex: '#475569' },
  { name: '半透白', hex: '#FFFFFF' },
  { name: '警示红', hex: '#DC2626' },
  { name: '深蓝', hex: '#1D4ED8' },
];
const imgWmColor = ref('#475569');

const splitMode = ref<'ratio' | 'count'>('ratio');
const splitRatio = ref<'3:4' | '1:1' | '4:5'>('3:4');
const splitCount = ref(4);

async function startConvert() {
  if (props.files.length === 0) return;

  if (props.tool.id === 'long-image-stitch' && props.files.length < 2) {
    uni.showToast({ title: '请至少选择 2 张图片拼接', icon: 'none' });
    return;
  }

  emit('start');
  try {
    if (props.tool.id === 'id-photo-bg') {
      if (useLocalIdBg.value) {
        emit('progress', 45, '正在本地智能识别并更换底色...');
        const outputs = await runIdPhotoBgLocal(props.files[0], {
          bgColor: idBgColor.value,
          tolerance: tolerance.value,
          feather: feather.value,
          cropRatio: idCropRatio.value,
        });
        emit('done', outputs, 'local');
      } else {
        const task = await executeCloudToolTask(
          'id-photo-bg',
          props.files,
          { bgColor: idBgColor.value, tolerance: tolerance.value, feather: feather.value },
          (p, s) => emit('progress', p, s)
        );
        emit('done', task.outputs, 'cloud');
      }
      return;
    }

    if (props.tool.id === 'id-photo-layout') {
      emit('progress', 50, '正在排版 300DPI 标准 6 寸相纸...');
      const outputs = await runIdPhotoLayoutLocal(props.files[0], {
        spec: idSpec.value,
        showCutLines: showCutLines.value,
        paperBg: paperBg.value,
      });
      emit('done', outputs, 'local');
      return;
    }

    if (props.tool.id === 'grid-nine') {
      emit('progress', 50, '正在等比裁切宫格...');
      const map = { '3x3': [3, 3], '2x2': [2, 2], '3x1': [3, 1] } as const;
      const [cols, rows] = map[gridLayout.value];
      const outputs = await runGridSplitLocal(props.files[0], { cols, rows });
      emit('done', outputs, 'local');
      return;
    }

    if (props.tool.id === 'long-image-stitch') {
      emit('progress', 50, '正在无缝拼接多图...');
      const outputs = await runLongStitchLocal(props.files, {
        direction: stitchDir.value,
        gap: stitchGap.value,
        bgColor: stitchBg.value,
      });
      emit('done', outputs, 'local');
      return;
    }

    if (props.tool.id === 'image-watermark') {
      const effectiveText = imgWmText.value.trim() || '仅限办理业务使用 · 他用无效';
      emit('progress', 20, '正在进行内容安全合规检测...');
      await ensureCustomTextCompliant(effectiveText, 'image');
      emit('progress', 55, '正在绘制防盗文字水印...');
      const outputs = await runImageWatermarkLocal(props.files[0], {
        text: effectiveText,
        mode: imgWmMode.value,
        fontSize: imgWmFontSize.value,
        opacity: imgWmOpacity.value,
        color: imgWmColor.value,
        angle: imgWmAngle.value,
      });
      emit('done', outputs, 'local');
      return;
    }

    if (props.tool.id === 'long-image-split') {
      emit('progress', 50, '正在智能拆分长图...');
      const ratioMap = { '3:4': [3, 4], '1:1': [1, 1], '4:5': [4, 5] } as const;
      const [rw, rh] = ratioMap[splitRatio.value];
      const outputs = await runLongImageSplitLocal(props.files[0], {
        mode: splitMode.value,
        count: splitCount.value,
        ratioW: rw,
        ratioH: rh,
      });
      emit('done', outputs, 'local');
    }
  } catch (err: any) {
    const msg = err?.message || '图像生成失败';
    if (isComplianceError(err)) {
      showComplianceBlockModal(msg, err);
    }
    emit('error', msg);
  }
}
</script>

<style lang="scss" scoped>
@use './workspace.scss' as *;
</style>
