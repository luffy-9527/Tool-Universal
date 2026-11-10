export type CategoryId = 'all' | 'office' | 'pdf' | 'social' | 'format' | 'media';

export type BadgeTheme = 'pink' | 'blue' | 'green';

export type ExecutionMode = 'local' | 'cloud' | 'hybrid';

export type ToolId =
  // Office 文档 (8)
  | 'word-to-pdf'
  | 'extract-doc-images'
  | 'excel-to-pdf'
  | 'word-to-image'
  | 'excel-to-long-image'
  | 'ppt-to-pdf'
  | 'ppt-to-image'
  | 'invoice-scan-enhance'
  // PDF 专区 (6)
  | 'images-to-pdf'
  | 'pdf-to-word'
  | 'pdf-watermark'
  | 'pdf-split'
  | 'pdf-merge'
  | 'pdf-to-image'
  // 社交创作 (6)
  | 'id-photo-bg'
  | 'id-photo-layout'
  | 'grid-nine'
  | 'long-image-stitch'
  | 'image-watermark'
  | 'long-image-split'
  // 格式优化 (2)
  | 'image-format-convert'
  | 'image-compress'
  // 音视频专区 (4)
  | 'audio-convert'
  | 'video-extract-audio'
  | 'video-compress'
  | 'video-to-gif';

export interface CategoryMeta {
  id: Exclude<CategoryId, 'all'>;
  name: string;
  emoji: string;
  count: number;
  subtitle: string;
}

export interface ToolMeta {
  id: ToolId;
  category: Exclude<CategoryId, 'all'>;
  title: string;
  badge: string;
  badgeTheme: BadgeTheme;
  description: string;
  iconKey: string;
  iconBg: string;
  mode: ExecutionMode;
  acceptTypes: ('image' | 'video' | 'audio' | 'document' | 'pdf')[];
  extensions: string[];
  multiple: boolean;
  maxFiles: number;
  keywords: string[];
}

export const CATEGORIES: CategoryMeta[] = [
  {
    id: 'office',
    name: 'Office 文档',
    emoji: '📄',
    count: 8,
    subtitle: 'Word / Excel 高保真互转',
  },
  {
    id: 'pdf',
    name: 'PDF 专区',
    emoji: '📑',
    count: 6,
    subtitle: '转Word、合并拆分与高清导出',
  },
  {
    id: 'social',
    name: '社交创作',
    emoji: '🎨',
    count: 6,
    subtitle: '九宫格、长图拼接与防盗水印',
  },
  {
    id: 'format',
    name: '格式优化',
    emoji: '⚡',
    count: 2,
    subtitle: '纯离线格式转换与智能瘦身',
  },
  {
    id: 'media',
    name: '音视频专区',
    emoji: '🎬',
    count: 4,
    subtitle: '音频互转、视频转GIF与压缩',
  },
];

export const TOOLS: ToolMeta[] = [
  // ================= Office 文档 (8款) =================
  {
    id: 'word-to-pdf',
    category: 'office',
    title: 'Word 转 PDF',
    badge: '支持水印',
    badgeTheme: 'pink',
    description: '排版还原，支持防盗水印',
    iconKey: 'doc-pdf',
    iconBg: '#F3F6FC',
    mode: 'cloud',
    acceptTypes: ['document'],
    extensions: ['doc', 'docx', 'rtf', 'txt'],
    multiple: false,
    maxFiles: 1,
    keywords: ['word', 'doc', 'docx', 'pdf', '水印', '转换'],
  },
  {
    id: 'extract-doc-images',
    category: 'office',
    title: '提取文档原图',
    badge: '支持PDF',
    badgeTheme: 'pink',
    description: '文档与 PDF 原图无损提取',
    iconKey: 'extract-img',
    iconBg: '#FFF5EB',
    mode: 'cloud',
    acceptTypes: ['document', 'pdf'],
    extensions: ['pdf', 'docx', 'xlsx', 'pptx'],
    multiple: false,
    maxFiles: 1,
    keywords: ['提取', '原图', 'pdf', 'word', 'ppt', 'excel', '图片'],
  },
  {
    id: 'excel-to-pdf',
    category: 'office',
    title: 'Excel 转 PDF',
    badge: '表格PDF',
    badgeTheme: 'blue',
    description: '自适应列宽多页排版打印',
    iconKey: 'excel-chart',
    iconBg: '#EFF9F4',
    mode: 'cloud',
    acceptTypes: ['document'],
    extensions: ['xls', 'xlsx', 'csv'],
    multiple: false,
    maxFiles: 1,
    keywords: ['excel', 'xls', 'xlsx', '表格', 'pdf', '打印'],
  },
  {
    id: 'word-to-image',
    category: 'office',
    title: 'Word 转图片',
    badge: '长图',
    badgeTheme: 'blue',
    description: '单页高清或整份无缝长图',
    iconKey: 'doc-edit',
    iconBg: '#F3F6FC',
    mode: 'cloud',
    acceptTypes: ['document'],
    extensions: ['doc', 'docx'],
    multiple: false,
    maxFiles: 1,
    keywords: ['word', '图片', '长图', 'png', 'jpg'],
  },
  {
    id: 'excel-to-long-image',
    category: 'office',
    title: 'Excel 转长图',
    badge: '长图',
    badgeTheme: 'blue',
    description: '表格转无缝长图或逐页图',
    iconKey: 'excel-chart',
    iconBg: '#EFF9F4',
    mode: 'cloud',
    acceptTypes: ['document'],
    extensions: ['xls', 'xlsx', 'csv'],
    multiple: false,
    maxFiles: 1,
    keywords: ['excel', '长图', '表格', '图片'],
  },
  {
    id: 'ppt-to-pdf',
    category: 'office',
    title: 'PPT 转 PDF',
    badge: '免排版',
    badgeTheme: 'green',
    description: '横版高保真排版，支持水印',
    iconKey: 'ppt-chart',
    iconBg: '#FFF7EB',
    mode: 'cloud',
    acceptTypes: ['document'],
    extensions: ['ppt', 'pptx'],
    multiple: false,
    maxFiles: 1,
    keywords: ['ppt', 'pptx', 'pdf', '幻灯片', '水印'],
  },
  {
    id: 'ppt-to-image',
    category: 'office',
    title: 'PPT 转图片',
    badge: '超清逐页',
    badgeTheme: 'green',
    description: '幻灯片逐页超清或转长图',
    iconKey: 'picture-frame',
    iconBg: '#FFF5EB',
    mode: 'cloud',
    acceptTypes: ['document'],
    extensions: ['ppt', 'pptx'],
    multiple: false,
    maxFiles: 1,
    keywords: ['ppt', '图片', '长图', '幻灯片'],
  },
  {
    id: 'invoice-scan-enhance',
    category: 'office',
    title: '发票合同扫描增强',
    badge: '报销必备',
    badgeTheme: 'pink',
    description: '拍照去阴影灰底，高清增强',
    iconKey: 'scan-doc',
    iconBg: '#EFF9F4',
    mode: 'hybrid',
    acceptTypes: ['image'],
    extensions: ['jpg', 'jpeg', 'png', 'webp'],
    multiple: false,
    maxFiles: 1,
    keywords: ['发票', '合同', '扫描', '去阴影', '报销', '增强'],
  },

  // ================= PDF 专区 (6款) =================
  {
    id: 'images-to-pdf',
    category: 'pdf',
    title: '多图合成 PDF',
    badge: '自由排序',
    badgeTheme: 'green',
    description: '多图/单据自由排序导出',
    iconKey: 'pdf-compose',
    iconBg: '#F4F5FA',
    mode: 'hybrid',
    acceptTypes: ['image'],
    extensions: ['jpg', 'jpeg', 'png', 'webp'],
    multiple: true,
    maxFiles: 30,
    keywords: ['多图', '图片', '合成', 'pdf', '排序', '单据'],
  },
  {
    id: 'pdf-to-word',
    category: 'pdf',
    title: 'PDF 转 Word',
    badge: '可编辑',
    badgeTheme: 'green',
    description: '高保真还原排版与图文',
    iconKey: 'pdf-word',
    iconBg: '#EEF4FF',
    mode: 'cloud',
    acceptTypes: ['pdf'],
    extensions: ['pdf'],
    multiple: false,
    maxFiles: 1,
    keywords: ['pdf', 'word', 'docx', 'doc', '转换', '文字', '表格', '编辑'],
  },
  {
    id: 'pdf-watermark',
    category: 'pdf',
    title: 'PDF 加防盗水印',
    badge: '文档安全',
    badgeTheme: 'blue',
    description: '平铺/居中水印安全防盗',
    iconKey: 'shield',
    iconBg: '#EEF5FF',
    mode: 'cloud',
    acceptTypes: ['pdf'],
    extensions: ['pdf'],
    multiple: false,
    maxFiles: 1,
    keywords: ['pdf', '水印', '防盗', '平铺'],
  },
  {
    id: 'pdf-split',
    category: 'pdf',
    title: 'PDF 页面拆分',
    badge: '按页拆分',
    badgeTheme: 'blue',
    description: '按页勾选提取导出新文档',
    iconKey: 'scissors',
    iconBg: '#FFF1F3',
    mode: 'cloud',
    acceptTypes: ['pdf'],
    extensions: ['pdf'],
    multiple: false,
    maxFiles: 1,
    keywords: ['pdf', '拆分', '提取', '分页'],
  },
  {
    id: 'pdf-merge',
    category: 'pdf',
    title: 'PDF 多份合并',
    badge: '合并导出',
    badgeTheme: 'blue',
    description: '自由排序多份合并为一份',
    iconKey: 'pdf-compose',
    iconBg: '#F5F3FA',
    mode: 'cloud',
    acceptTypes: ['pdf'],
    extensions: ['pdf'],
    multiple: true,
    maxFiles: 15,
    keywords: ['pdf', '合并', '排序'],
  },
  {
    id: 'pdf-to-image',
    category: 'pdf',
    title: 'PDF 转图片',
    badge: '高保真',
    badgeTheme: 'blue',
    description: '逐页高清渲染为 JPG/PNG',
    iconKey: 'pdf-image',
    iconBg: '#FFF7EE',
    mode: 'cloud',
    acceptTypes: ['pdf'],
    extensions: ['pdf'],
    multiple: false,
    maxFiles: 1,
    keywords: ['pdf', '转图片', 'jpg', 'png', '高清'],
  },

  // ================= 社交创作 (6款) =================
  {
    id: 'id-photo-bg',
    category: 'social',
    title: '证件照一键换底色',
    badge: '一键换底',
    badgeTheme: 'pink',
    description: '红白蓝灰底秒换，发丝柔化',
    iconKey: 'portrait',
    iconBg: '#F4F1FA',
    mode: 'hybrid',
    acceptTypes: ['image'],
    extensions: ['jpg', 'jpeg', 'png', 'webp'],
    multiple: false,
    maxFiles: 1,
    keywords: ['证件照', '换底色', '红底', '蓝底', '白底', '抠图'],
  },
  {
    id: 'id-photo-layout',
    category: 'social',
    title: '证件照冲印排版',
    badge: '冲印排版',
    badgeTheme: 'pink',
    description: '1寸/2寸标准6寸相纸排版',
    iconKey: 'camera',
    iconBg: '#F5F6FA',
    mode: 'local',
    acceptTypes: ['image'],
    extensions: ['jpg', 'jpeg', 'png', 'webp'],
    multiple: false,
    maxFiles: 1,
    keywords: ['证件照', '排版', '冲印', '1寸', '2寸', '6寸'],
  },
  {
    id: 'grid-nine',
    category: 'social',
    title: '朋友圈九宫格',
    badge: '朋友圈',
    badgeTheme: 'pink',
    description: '一键等比裁切 3×3 九宫格',
    iconKey: 'puzzle',
    iconBg: '#F0F9EC',
    mode: 'local',
    acceptTypes: ['image'],
    extensions: ['jpg', 'jpeg', 'png', 'webp'],
    multiple: false,
    maxFiles: 1,
    keywords: ['九宫格', '朋友圈', '切图', '3x3'],
  },
  {
    id: 'long-image-stitch',
    category: 'social',
    title: '多图长图拼接',
    badge: '长图拼接',
    badgeTheme: 'blue',
    description: '多张截图或照片无缝拼接',
    iconKey: 'scroll',
    iconBg: '#FFF5EA',
    mode: 'local',
    acceptTypes: ['image'],
    extensions: ['jpg', 'jpeg', 'png', 'webp'],
    multiple: true,
    maxFiles: 20,
    keywords: ['长图', '拼接', '拼图', '多图'],
  },
  {
    id: 'image-watermark',
    category: 'social',
    title: '图片防盗水印',
    badge: '证件安全',
    badgeTheme: 'blue',
    description: '平铺/居中防盗文字水印',
    iconKey: 'shield',
    iconBg: '#EEF5FF',
    mode: 'local',
    acceptTypes: ['image'],
    extensions: ['jpg', 'jpeg', 'png', 'webp'],
    multiple: false,
    maxFiles: 1,
    keywords: ['图片', '水印', '防盗', '身份证'],
  },
  {
    id: 'long-image-split',
    category: 'social',
    title: '长图反向拆分',
    badge: '切图神器',
    badgeTheme: 'green',
    description: '等分裁切多图，适配轮播图',
    iconKey: 'scissors',
    iconBg: '#FFF1F3',
    mode: 'local',
    acceptTypes: ['image'],
    extensions: ['jpg', 'jpeg', 'png', 'webp'],
    multiple: false,
    maxFiles: 1,
    keywords: ['长图', '拆分', '切图', '小红书', '轮播'],
  },

  // ================= 格式优化 (2款) =================
  {
    id: 'image-format-convert',
    category: 'format',
    title: '图片格式转换',
    badge: '纯离线',
    badgeTheme: 'blue',
    description: 'PNG/JPG/WEBP 互转 0延迟',
    iconKey: 'picture-frame',
    iconBg: '#EEF8F2',
    mode: 'local',
    acceptTypes: ['image'],
    extensions: ['jpg', 'jpeg', 'png', 'webp'],
    multiple: true,
    maxFiles: 10,
    keywords: ['图片', '格式转换', 'png', 'jpg', 'webp', '离线'],
  },
  {
    id: 'image-compress',
    category: 'format',
    title: '图片智能压缩',
    badge: '省空间',
    badgeTheme: 'blue',
    description: '画质优先智能无损瘦身',
    iconKey: 'compress',
    iconBg: '#F2F6FA',
    mode: 'local',
    acceptTypes: ['image'],
    extensions: ['jpg', 'jpeg', 'png', 'webp'],
    multiple: true,
    maxFiles: 10,
    keywords: ['图片', '压缩', '瘦身', '体积'],
  },

  // ================= 音视频专区 (4款) =================
  {
    id: 'audio-convert',
    category: 'media',
    title: '音频格式互转',
    badge: '音频神器',
    badgeTheme: 'green',
    description: 'MP3/WAV/M4A 等格式互转',
    iconKey: 'music',
    iconBg: '#EFF9F4',
    mode: 'cloud',
    acceptTypes: ['audio'],
    extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'],
    multiple: false,
    maxFiles: 1,
    keywords: ['音频', 'mp3', 'wav', 'm4a', 'aac', '转换'],
  },
  {
    id: 'video-extract-audio',
    category: 'media',
    title: '视频提取音频',
    badge: '提取配乐',
    badgeTheme: 'pink',
    description: '一键提取视频配乐与人声',
    iconKey: 'clapper',
    iconBg: '#FFF6ED',
    mode: 'cloud',
    acceptTypes: ['video'],
    extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm'],
    multiple: false,
    maxFiles: 1,
    keywords: ['视频', '音频', '提取', '配乐', 'mp3'],
  },
  {
    id: 'video-compress',
    category: 'media',
    title: '视频转码与压缩',
    badge: '转码瘦身',
    badgeTheme: 'green',
    description: 'MOV 转 MP4，大视频瘦身',
    iconKey: 'camcorder',
    iconBg: '#F4F6FA',
    mode: 'hybrid',
    acceptTypes: ['video'],
    extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm'],
    multiple: false,
    maxFiles: 1,
    keywords: ['视频', '压缩', '转码', 'mov', 'mp4', '瘦身'],
  },
  {
    id: 'video-to-gif',
    category: 'media',
    title: '视频转 GIF 动图',
    badge: '表情包',
    badgeTheme: 'pink',
    description: '自选片段高画质导出表情包',
    iconKey: 'gif',
    iconBg: '#FFF1F5',
    mode: 'cloud',
    acceptTypes: ['video'],
    extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm'],
    multiple: false,
    maxFiles: 1,
    keywords: ['视频', 'gif', '动图', '表情包', '截取', '动效', '转换'],
  },
];

export const TOOL_MAP: Record<ToolId, ToolMeta> = TOOLS.reduce(
  (acc, tool) => {
    acc[tool.id] = tool;
    return acc;
  },
  {} as Record<ToolId, ToolMeta>
);

export function getToolById(id: string): ToolMeta | undefined {
  return TOOLS.find((t) => t.id === id);
}
