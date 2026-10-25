/**
 * hermes-background —— 个性化设置（背景 / 字色 / 光效 / 悬浮 / 消息气泡 / 开机动画）
 *
 * 安装位置：<HERMES_HOME>/desktop-plugins/hermes-background/plugin.js
 * 打开方式：
 *   1) 设置 → 插件 → 「个性化设置」（本插件自己的设置页）
 *   2) ⌘K / Ctrl+K → 「打开「个性化设置」」
 *
 * 为什么这么做：插件代码住在 $HERMES_HOME 下，不在 Hermes 源码树里，
 * 升级 / 重装 Hermes 都不会把它冲掉，也不需要改 apps/desktop。
 *
 * 实现要点：
 *  1) 往 <body> 里放一个 fixed 背景层（<video> / <img>，z-index:-1、
 *     pointer-events:none），并把 html/body 与壳体那两处满窗填充改透明，
 *     背景就从整个窗口（侧栏+聊天+面板）后面透出来；
 *  2) 视频走桌面端自带的 hermes-media:// 协议播放本地文件（支持 Range、
 *     系统硬解），图片走 file://；
 *  3) 字色／面板深浅靠覆盖 CSS 变量。主题引擎把这些变量写在 <html> 的
 *     内联样式上，内联样式压选择器，所以这里必须 !important；
 *  4) 设置存 ctx.storage（插件自己的命名空间）。
 */

import {
  APPEARANCE_AREAS,
  Button,
  Codicon,
  ColorSwatches,
  ListRow,
  PALETTE_AREA,
  SegmentedControl,
  TITLEBAR_AREAS,
  atom,
  haptic,
  host,
  pluginSettingsHref,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'hermes-personalize'
/* 旧 id：改名前叫 hermes-background，存储命名空间跟着 id 走，所以要迁移 */
const LEGACY_ID = 'hermes-background'
const STYLE_ID = 'hermes-bg-style'
const LAYER_ID = 'hermes-bg-layer'
const KEY = 'settings'

/* ── 最早时机的注入 ──────────────────────────────────────────────
   这段在模块被 import 时立刻执行：比 register、比插件主样式表都早。
   配了开机动画时，让应用自己的「CONNECTING」启动画面从一开始就不露面。
   这里还不能用插件存储 API，只能同步读 localStorage 里的设置
   （键与形状跟 contrib/plugin.ts 的 createPluginStorage 一致：JSON 文本）。 */
const BOOT_HIDE_ID = 'hermes-boot-hide'

try {
  const savedSettings = JSON.parse(window.localStorage.getItem(`hermes.plugin.${ID}.${KEY}`) || 'null')

  const wantsStartup =
    savedSettings &&
    savedSettings.startupMode &&
    savedSettings.startupMode !== 'off' &&
    (savedSettings.startupPath || (savedSettings.startupClips || []).length)

  if (wantsStartup && !document.getElementById(BOOT_HIDE_ID)) {
    const early = document.createElement('style')

    early.id = BOOT_HIDE_ID
    /* 侧栏被拖动的行也带 data-glass-opaque，必须同时要求 fixed + inset-0 才不误伤 */
    early.textContent = "[data-glass-opaque][class*='fixed'][class*='inset-0']{display:none !important}"
    document.head.appendChild(early)
  }
} catch {
  /* 读不到就算了：register 之后的主样式表还会再兜一次 */
}

/* 诊断用：记下插件被加载的时刻。自检里会跟「浏览器首帧」对比 ——
   如果插件比首帧还早就说明「藏启动画面」的规则本该来得及生效，
   那条规则没命中就是选择器的问题，而不是时序的问题。 */
try {
  window.__hermesBgPluginImportAt = performance.now()
} catch {
  /* 拿不到就算了，只是诊断 */
}

const DEFAULTS = {
  /** 'off' | 'video' | 'image' */
  mode: 'off',
  /** 本地文件绝对路径 */
  path: '',
  /** 模型 pill 右边的箭头（默认隐藏）：强度已挪到独立的推理强度弹窗 */
  hideModelPillArrow: true,
  /** 分隔条（窗格之间调宽度的那根）：默认「解锁位置」= 锁定时它仍能拖 */
  sashLockOn: false,

  /** 锁定布局（默认开）：不能拖动窗格 / 会话 / 机器人 / 侧栏列表，也不能缩放 */
  layoutLockOn: true,
  /** 遮罩浓度 0-80（越大界面越清晰、背景越淡） */
  scrim: 46,
  /** 字色；null = 跟随主题 */
  ink: null,
  /** 界面字体（'' = 跟随主题）：只改 --font-sans，不动 body（否则代码块的等宽字体会被吃掉） */
  fontFamily: '',
  /** 等宽字体（代码块 / 路径；'' = 跟随主题） */
  fontMono: '',
  /** 界面字体是否加粗一点点：'' 不加 | '500' | '600' */
  fontWeight: '',
  /** 'auto' | 'dark' | 'light' —— 面板深浅 */
  surface: 'auto',
  /** 导出配置包时是否连素材一起打包（默认开） */
  bundleWithMedia: true,
  /** 导入配置包时是否使用包里的素材（默认开）；关掉就只套设置，素材还用本机原路径 */
  bundleImportMedia: true,
  /** 背景图/视频本身的不透明度 0-100 */
  bgOpacity: 100,
  /** 开机动画：'off' | 'video' | 'image'（启动后播一次，不循环） */
  startupMode: 'off',
  /** 开机动画文件路径 */
  startupPath: '',
  /** 开机动画最长播放秒数 */
  startupMaxSeconds: 6,
  /** 出场过渡时长（毫秒） */
  startupFadeIn: 600,
  /** 收场过渡时长（毫秒） */
  startupFadeOut: 700,
  /** 出场效果：'fade' | 'zoom' | 'none' */
  startupEnter: 'fade',
  /** 收场效果：'fade' | 'shrink' | 'none' */
  startupExit: 'fade',
  /** 放大/缩小的幅度（百分比） */
  startupZoom: 12,
  /** 加载完成前是否允许跳过开机动画：'off' = 不允许（默认），'on' = 允许 */
  startupSkipEarly: 'off',
  /** 启动音效：'mute' | 'video' | 'custom' */
  startupAudio: 'mute',
  /** 自定义音效文件路径 */
  startupAudioPath: '',
  /** 启动音效音量 0-100 */
  startupVolume: 60,
  /** 画面填充：'contain' | 'cover' */
  startupFit: 'contain',
  /** 背景底色：'black' | 'theme' | 'transparent' */
  startupBackdrop: 'black',
  /** 背景候选列表（最多 MAX_CLIPS 条，{ path, kind }）*/
  clips: [],
  /** 顺序轮播走到第几条 */
  seqIndex: 0,
  /** 时长轮换：使用过程中按间隔自动换背景（关闭 = 只在每次启动换一条） */
  bgRotateOn: false,
  /** 时长轮换的间隔（秒） */
  bgRotateSeconds: 300,
  /** 背景音乐 */
  musicOn: false,
  /** 音乐曲目（不限数量，{ path, order, lyricsPath }） */
  musicTracks: [],
  /** 音乐音量 0-100 */
  musicVolume: 60,
  /** 播放方式：'sequence' 顺序循环 | 'single' 单曲循环 | 'random' 随机 */
  musicRepeat: 'sequence',
  /** 歌词：投射到主页面右上角的小卡片 */
  lyricsOn: false,
  lyricsWidth: 280,
  lyricsFontSize: 0.95,
  lyricsTilt: -6,
  lyricsOpacity: 88,
  lyricsFloatAmp: 5,
  lyricsFloatSpeed: 6,
  lyricsPlainSeconds: 6,
  /** 背景轮播方式：'sequence' | 'random' */
  rotation: 'sequence',
  /** 开机动画候选列表（最多 MAX_CLIPS 条）*/
  startupClips: [],
  /** 开机动画顺序轮播下标 */
  startupSeqIndex: 0,
  /** 开机动画轮播方式 */
  startupRotation: 'sequence',
  /** 输入框内发光开关 */
  glowOn: false,
  /** 发光颜色 */
  glowColor: '#4a84fe',
  /** 强度 0-100（透明度百分比） */
  glowStrength: 70,
  /** 光带厚度（px） */
  glowWidth: 1.5,
  /** 内发光柔光半径（px） */
  glowBlur: 18,
  /** 是否流动：'off' | 'on' */
  glowFlow: 'on',
  /** 流动一圈的秒数 */
  glowSpeed: 3.5,
  /** 运行程序条（输入框上方的状态栈）：是否跟随输入框 */
  stackFollow: true,
  /** 运行程序条透明度 0-100（0 = 应用原样）——不跟随时用它 */
  stackAlpha: 0,
  /** 运行程序条左右内缩（px）—— 让它两端落在输入框圆角以内 */
  stackInset: 18,
  /** 运行程序条磨砂 */
  stackFrostOn: false,
  stackBlur: 14,
  stackSaturate: 140,
  /** 输入框磨砂（毛玻璃） */
  frostOn: false,
  /** 磨砂模糊半径（px） */
  frostBlur: 14,
  /** 输入框自身填充的浓度 0-100（越低越透，磨砂越明显） */
  frostOpacity: 55,
  /** 磨砂饱和度 100-200（玻璃质感一般会加一点） */
  frostSaturate: 140,
  /** 左列会话行的悬浮效果开关 */
  sessOn: false,
  /** 普通会话抬升（px） */
  sessLift: 2,
  /** 正在工作的会话额外抬升（px） */
  sessWorkExtra: 4,
  /** 上下漂浮的幅度（px） */
  sessAmp: 2.5,
  /** 漂浮一圈的秒数 */
  sessSpeed: 6,
  /** 阴影 / 光晕强度 0-100 */
  sessShadow: 45,
  /** 工作会话的光晕颜色 */
  sessGlowColor: '#4a84fe',
  /** 会话行圆角半径（px） */
  sessRadius: 12,
  /** 会话列宽度（rem）—— 加宽会话栏（右侧空间多，阴影和标题都更舒展） */
  sessColWidth: 20,
  /** 会话列表容器左右内边距（px）—— 给阴影留空间，但不缩卡片 */
  sessColPad: 10,
  /** 会话栏右侧可拖宽（默认开）：拖那条细线直接改「会话列宽度」 */
  sessDragOn: true,
  /* 左侧会话列表：当前选中的那条要一眼看得出来 */
  sessHlOn: true,
  sessHlBar: true,
  sessHlHover: true,
  sessHlColor: '#4dd0ff',
  /* 设置页语言：'zh' | 'en' */
  lang: 'zh',
  /* 玻璃省性能：跳过液态玻璃的 SVG 滤镜（那个滤镜链有 19 个节点，每个气泡各渲染一遍，
     回复时每个字都在重绘它）。开着就退回普通 backdrop-filter 模糊，观感差一点但不卡。 */
  lgxPerfOn: false,
  /* 选择框（分段控件）：磨砂底 + 内发光 */
  segGlassOn: true,
  segGlowColor: '#4dd0ff',
  segGlowStrength: 45,
  /* 问询弹窗的「确认并继续」：同样磨砂 + 内发光 */
  askGlowOn: true,
  /** 会话行之间的视觉间隙（px） */
  sessGap: 4,
  /** 会话卡片左右各自内缩多少（px）——给左右的光晕 / 放大留出余量，不被侧栏边缘切 */
  sessInset: 6,
  /** 错开漂浮：每行相位不同，不再整齐同步（'on' | 'off'） */
  sessStagger: 'on',
  /** 整个会话列向下推多少（px）——给最上面的行留出漂浮的净空 */
  /** 鼠标触碰反馈：悬停时像水泡一样慢慢膨大 + 上飘 */
  sessTouchOn: true,
  /** 膨大幅度（百分比） */
  sessTouchGrow: 6,
  /** 上飘高度（px） */
  sessTouchRise: 6,
  /** 悬停时跟随鼠标上下的幅度（px）—— 0 = 只上飘不跟随 */
  sessTouchFollow: 8,
  /** 反馈时长（毫秒）—— 越大越「慢慢」 */
  sessTouchMs: 1100,
  /** 会话框内发光 */
  sessInOn: false,
  sessInColor: '#4a84fe',
  sessInStrength: 60,
  sessInBlur: 14,
  sessInWidth: 2,
  /** 工作会话的流光：'off' | 'rainbow'（彩色流光）| 'solid'（单色流光） */
  sessAuraMode: 'rainbow',
  /** 流光自定义颜色（最多 3 个；留空的位不参与，全空则用内置光谱） */
  sessAuraC1: '#ff4d6d',
  sessAuraC2: '#ffd24a',
  sessAuraC3: '#4dd0ff',
  /** 流光光带厚度（px） */
  sessAuraWidth: 2,
  /** 流光转一圈的秒数 */
  sessAuraSpeed: 3,
   /** 发送到位时的入场动画：'off' | 'rise' | 'pop' | 'slide' */
  bubbleEnter: 'rise',
  /** 入场动画时长（ms） */
  bubbleEnterMs: 420,
  /** 入场动画幅度（px） */
  bubbleEnterAmp: 16,
  /** 气泡悬浮 */
  bubbleFloat: false,
  bubbleLift: 3,
  bubbleAmp: 3,
  bubbleSpeed: 7,
  bubbleStagger: 'on',
  /** 气泡圆角（0 = 保持应用原样） */
  bubbleRadius: 0,
  /** 气泡阴影强度 0-100 */
  bubbleShadow: 40,
  /** 气泡内发光 */
  bubbleInOn: false,
  bubbleInColor: '#7ee7ff',
  bubbleInStrength: 55,
  bubbleInBlur: 14,
  bubbleInWidth: 2,
  /** 气泡外发光 */
  bubbleOutOn: false,
  bubbleOutColor: '#4a84fe',
  bubbleOutStrength: 55,
  bubbleOutBlur: 16,
  bubbleOutFlow: 'off',
  bubbleOutSpeed: 4,
  /** 气泡 iOS 液态玻璃 */
  glassOn: false,
  glassBlur: 18,
  glassTint: 16,
  glassSaturate: 1.7,
  glassRim: 65,
  glassRadius: 18,
  glassSheen: 'on',
  glassSheenSeconds: 8,
  /** 桌宠交互（移植自 dsh-pet：点击回应 / 拖拽甩抛 / 右键菜单） */
  petInteract: true,
  petHitMode: 'body',
  petDrag: true,
  petThrowPower: 1,
  petGravity: 1400,
  petRestitution: 0.78,
  petFriction: 2.5,
  petSquash: true,
  petMenu: true,
  /* 桌宠·自动交互钩子（都在「交互=可交互」时才生效；素材缺失会自动降级为不播） */
  petWorkSync: true,
  petStreak: true,
  petHover: true,
  petIdle: true,
  petIdleMin: 10,
  petLandingClip: true,
  petX: null,
  petY: null,
  /** 右上角挂绳（拽一下打开设置页） */
  ropeOn: true,
  /** 水平位置（距窗口左边 px）—— 避开左上角「机器人 / 终端」那排标签 */
  ropeLeft: 170,
  /** 粗细（px）—— 图是 1:10.6 的细长绳，8px 宽 ≈ 85px 长 */
  ropeWidth: 8,
  /** 屏幕外比例（%）：上端有多少垂在窗口上沿之外。默认 25% = 屏内露出约 3/4 根绳 */
  ropeOffscreen: 25,
  ropeSway: 3,
  /** 推理滑条：在输入框右下角的推理弹窗里用拖动滑条选等级（每级一色） */
  effortSliderOn: true,
  effortSliderHeight: 14,
  /** 计时秒数 → 彩色流光进度条 */
  timerBarOn: true,
  timerBarMax: 100,
  timerBarWidth: 5.2,
  timerBarHeight: 0.42,
  timerBarRadius: 999,
  /** 进度条的底槽（那层灰白轨道）：用户要求只留彩色进度、不显示整条 → 默认隐藏 */
  timerBarTrack: false,
  /** 思考方块：彩色流光 */
  flowOn: true,
  flowPreset: 'rainbow',
  flowSpeed: 1,
  flowGlow: 70,
  flowIntensity: 70,
  flowText: true,
  flowRadius: 3,
  flowScale: 1,
  /* ── 「运行状态条」（工具行「正在运行 …」/ 状态条行）也套同一套流光 ── */
  runFlowOn: true,
  /** 'num' 显示计时数字（彩色流光）/ 'bar' 换成流光进度条（默认，和思考方块一致） */
  runFlowClockStyle: 'bar',
  /** 'asym' 渐近（永不停在满格）/ 'linear' 线性（到满格秒数就满） */
  runFlowCurve: 'asym',
  /** 桌宠 */
  petOn: true,
  petPacks: [],
  petPack: '',
  petSize: 560,
  petCorner: 'bottom-right',
  petMarginX: 24,
  petMarginY: 12,
  petOpacity: 100,
  petMode: 'sequence',
  petGroup: 'all',
  /* ── 桌宠·DeepSeek 余额（头顶小牌子）──
     数据来源：官方余额接口 GET https://api.deepseek.com/user/balance
     Authorization: Bearer <API Key>（用户自己填，只存本机）。 */
  /* 点击音效（现场合成「捏一下」的吱声，不需要素材文件） */
  petClickSoundOn: true,
  petClickSoundVolume: 60,
  petClickSoundPitch: 100,
  /** 一声「吱」的时长（毫秒）：越大拖得越长 */
  petClickSoundMs: 160,
  /** 选中的音效预设名（用户自己挑；改音调/时长会变「自定义」） */
  petClickSoundPreset: '经典捏',
  /** 余额气泡是否常驻（默认关：只在「捏」的时候冒 1 秒） */
  petBalAlways: false,
  petBalOn: true,
  petBalMenuOn: true,
  petBalKey: '',
  petBalMinutes: 1,
  petBalActionsOn: true,
  petBalLow: 5,
  petBalHigh: 50,
  /** 'static' 静态毛玻璃 | 'liquid' 液态玻璃（iOS 26 那种折射材质） */
  /** 助手那一侧（Hermes 发给你的消息）的气泡：与用户侧完全分开的一套设置 */
  aBOn: true,
  aBRadius: 14,
  aBShadow: 35,
  aBFloat: false,
  aBLift: 3,
  aBAmp: 3,
  aBSpeed: 8,
  aBStagger: 'on',
  aBInOn: false,
  aBInColor: '#7ee7ff',
  aBInStrength: 45,
  aBInBlur: 12,
  aBInWidth: 2,
  aBOutOn: false,
  aBOutColor: '#4a84fe',
  aBOutStrength: 45,
  aBOutBlur: 16,
  aBOutFlow: 'off',
  aBOutSpeed: 4,
  aBGlassOn: false,
  aBGlassBlur: 18,
  aBGlassTint: 16,
  aBGlassSaturate: 1.7,
  aBGlassRim: 65,
  aBGlassRadius: 18,
  aBGlassSheen: 'on',
  aBGlassSheenSeconds: 8,
  /** 输入框 / 会话行的液态玻璃（同一套配方，各配一份） */
  /** 输入框液态玻璃（Liquid Glass React 移植） */
  lgxOn: true,
  lgxSessOn: false,
  lgxBubbleOn: false,
  /** 我发的气泡水平位置：'left' | 'center' | 'right'（默认居中） */
  myBubbleAlign: 'center',
  /** 靠左/靠右时是否贴到聊天区最边（默认开）：关掉就用「最大宽度」那个百分比 + 44rem 上限 */
  bubbleEdgeOn: true,
  /** 用户消息是否吸顶（应用原本是吸顶：钉在顶部、盖住下面滚过的内容）。
      默认关掉 —— 关掉后气泡跟着内容一起滚走，不会压住 Hermes 的消息。 */
  userPinOn: false,
  /** 气泡最大宽度（%，默认与应用自己的说明文字一致） */
  myBubbleWidth: 86,
  /** Hermes 发的气泡水平位置：'left' | 'center' | 'right'（默认居中） */
  aBubbleAlign: 'center',
  aBubbleWidth: 86,
  lgxSessRadius: 10,
  lgxBubbleRadius: 18,
  /** 推理弹窗的液态玻璃（和气泡同一套） */
  /** 模型名 / 推理强度弹窗的玻璃：'follow' 跟随输入框 / 'on' / 'off' */
  lgxPopOn: 'follow',
  /** 鼠标右键菜单的玻璃：同上 */
  lgxMenuOn: 'follow',
  lgxMenuRadius: 12,
  /* 是否把应用自己的模型 pill 视觉收起（合成 pill 已显示同样信息）。
     默认 false：卡死排查期间必须先保证有一条不经过弹窗的切模型路径。 */
  hideAppModelPill: false,
  /* 在**应用自己的模型 pill**（输入框右下角左边那个）上显示「模型名 · 推理强度」。
     用户要求：不再把模型名塞进推理弹窗，反过来把强度加进模型名里。 */
  modelPillLabelOn: false,
  /* 把推理强度搬进**应用的模型列表弹窗**（用户要求：只用这一个弹窗）。 */
  menuEffortOn: false,
  /* 收起应用自己的**推理 pill**（右下角那个只剩箭头的）。
     强度已搬进模型列表弹窗，这个 pill 就多余了。 */
  hideReasonPill: false,
  /* 把滑条的流光效果同步到 pill 的**文字**上（模型名 + 推理强度）。 */
  pillFlowOn: true,
  /* 消息气泡里的「选中文字」高亮：默认跟随气泡色调（半透明），不再是黑底/土黄方块。 */
  bubbleSelectTint: true,
  /* 去掉「我发的消息」气泡的黑底：把填充变量与背景都清成透明（文字/边框保留）。 */
  userBubbleClear: true,
  /* 模型弹窗 + 推理弹窗的玻璃/圆角**跟随输入框**（用户要求「和输入框同步」）。 */
  glassFollowPop: true,
  /* 侧栏最上面那一组功能行（新建会话 / 技能与工具 / 消息平台 / 产物 / 定时任务）收起。
     走应用自己的 sidebarNav.prefs 机制（贡献 hide 列表），不是硬藏 DOM。 */
  navCollapseOn: false,
  /** 欢迎页（默认开）：启动时先显示问候页，点会话才进去 */
  welcomeOn: true,
  /* 首页背景：'follow' 跟随主背景 | 'own' 自己一张 | 'off' 不铺 */
  homeBgMode: 'follow',
  /** 自己那张的类型：'image' | 'video'（选文件时按扩展名自动定） */
  homeBgKind: 'image',
  /** 自己那张的路径 */
  homeBgPath: '',
  /** 填充：'cover' 铺满 | 'contain' 适应 */
  homeBgFit: 'cover',
  /* 首页（欢迎页）外观 */
  homeGlassOn: true,
  homeBlur: 16,
  homeRadius: 14,
  homeSyncBg: false,
  homeOpacity: 58,
  /* 问询弹窗（澄清问题那个卡片）外观 */
  askGlassOn: false,
  askBlur: 14,
  askBg: '',
  askText: '',
  askRadius: 0,
  welcomeText: '你好，我们今天要干什么？',
  welcomeCount: 8,
  /** 背景音乐静音（默认不静音）：标题栏那个音乐符号点一下就能切 */
  musicMutedOn: false,
  /** 藏起窗格标签条上的会话标签（只留每格的 ✕ 与条尾的 ＋） */
  hidePaneTabs: false,
  /** 打开设置弹窗时直接进入「个性化设置」这一页（默认**关**：
      用户要的是整弹窗归「设置弹窗」那套外观管，不是被强行拽到插件页；想要可以自己开）。 */
  navAutoJumpOn: false,
  /** 打开设置弹窗时自动展开本插件所在的那一组（默认开）。
      用户报：每次打开设置都没有「个性化」，必须手动切到「插件」那一组才出现
      —— 那组的组体是应用自己折叠的 div.hidden（display:none），
      展开状态只在 React 内部（localStorage 没有可改的键）→ 只能由插件扳开。 */
  navAutoOpenOn: true,
  /* 鼠标个性化：自定义光标（12 组）+ 大小。 */
  cursorOn: false,
  cursorStyle: 'classic',
  cursorSize: 24,
  pillFlowSeconds: 2.4,
  lgxPopRadius: 16,
  /** 推理弹窗的静态玻璃（iOS 那套，和气泡功能相同；别和液态同时开） */
  popGlassOn: false,
  popGlassBlur: 18,
  popGlassTint: 16,
  popGlassSaturate: 1.7,
  popGlassRim: 65,
  popGlassRadius: 16,
  popGlassSheen: 'on',
  popGlassSheenSeconds: 8,
  lgxMode: 'standard',
  lgxScale: 110,
  lgxAberration: 4,
  lgxBlur: 6,
  lgxSaturate: 180,
  /* 每个地方的玻璃配方各一份（用户要求不再共用）。默认值与原共用配方一致。
     上面那五个老键就是「输入框」那一套。 */
  /* 设置面板自己的玻璃配方（与其它地方一样各一份） */
  lgxSettingsOn: true,
  lgxSettingsRadius: 12,
  /** 面板磨砂颜色；空 = 跟随主题 */
  lgxSettingsTint: '',
  /** 左列（导航栏）要不要一起上磨砂 */
  lgxSettingsRailOn: true,
  /** 左列磨砂颜色；空 = 跟随面板那个 */
  lgxSettingsRailTint: '',
  lgxSettingsMode: 'standard',
  lgxSettingsScale: 110,
  lgxSettingsAberration: 4,
  lgxSettingsBlur: 6,
  lgxSettingsSaturate: 180,
  lgxSessMode: 'standard', lgxSessScale: 110, lgxSessAberration: 4, lgxSessBlur: 6, lgxSessSaturate: 180,
  lgxBubbleMode: 'standard', lgxBubbleScale: 110, lgxBubbleAberration: 4, lgxBubbleBlur: 6, lgxBubbleSaturate: 180,
  lgxABubbleMode: 'standard', lgxABubbleScale: 110, lgxABubbleAberration: 4, lgxABubbleBlur: 6, lgxABubbleSaturate: 180,
  lgxPopMode: 'standard', lgxPopScale: 110, lgxPopAberration: 4, lgxPopBlur: 6, lgxPopSaturate: 180,
  lgxMenuMode: 'standard', lgxMenuScale: 110, lgxMenuAberration: 4, lgxMenuBlur: 6, lgxMenuSaturate: 180,
  lgxRadius: 22,
  lgxElastic: 0.15,
  /** 跟随鼠标的「缓缓」程度（毫秒，越大越慢） */
  lgxFollowMs: 900,
  sessGlassOn: false,
  sessGlassBlur: 18,
  sessGlassTint: 16,
  sessGlassSaturate: 1.7,
  sessGlassRim: 65,
  sessGlassRadius: 18,
  sessGlassSheen: 'on',
  sessGlassSheenSeconds: 8,
  sessOutColor: '#4a84fe',
  sessOutStrength: 55,
  sessOutBlur: 16,
  sessOutFlow: 'on',
  sessOutSpeed: 4
}

const $settings = atom({ ...DEFAULTS })

/* ── 配置存档：把整套设置存成带序号的快照，一键读回 ─────────────── */
const PRESET_KEY = 'presets'
const MAX_PRESETS = 20
const $presets = atom([])

/** 改 id 后的一次性迁移。
    插件的存储就是 localStorage 的 `hermes.plugin.<id>.<key>` 键
    （见 apps/desktop/src/contrib/plugin.ts → createPluginStorage），
    所以旧命名空间（hermes-background）里的「设置 + 配置存档」可以直接抄到新命名空间，
    用户的背景、字色、光效、悬浮、气泡、开机动画和 20 份存档都不会丢。 */
const MIGRATED_FLAG = `hermes.plugin.${ID}.migrated-from-${LEGACY_ID}`

function migrateLegacyStorage() {
  try {
    const store = window.localStorage

    if (store.getItem(MIGRATED_FLAG)) return false
    /* 新命名空间已经有数据（用户已经用新 id 存过）就不动 */
    if (store.getItem(`hermes.plugin.${ID}.${KEY}`)) return false

    let moved = 0

    for (const key of [KEY, PRESET_KEY]) {
      const old = store.getItem(`hermes.plugin.${LEGACY_ID}.${key}`)

      if (old) {
        store.setItem(`hermes.plugin.${ID}.${key}`, old)
        moved += 1
      }
    }

    store.setItem(MIGRATED_FLAG, '1')

    return moved > 0
  } catch {
    /* 拿不到 localStorage 就算了，最多是回默认 */
    return false
  }
}

let ctxRef = null

/* ── 预设字色（前 4 个配深色面，后 4 个配浅色面）────────────────── */
const INK_SWATCHES = ['#e6edf3', '#ffffff', '#d3c6aa', '#ffd8b0', '#1f2328', '#000000', '#243b53', '#4a2f1d']

/* 发光色：都是能在深色底上「发光」的亮色 */
const GLOW_SWATCHES = ['#4a84fe', '#7ee7ff', '#00ff41', '#ffbf00', '#f85149', '#cba6f7', '#ff7ac6', '#ffffff']

/* ── 两套面板色：取自内置 Nous 的暗色 / 浅色配色 ─────────────────── */
const DARK_SURFACE = {
  '--theme-secondary': '#1d2e4f',
  '--theme-accent-soft': '#17243a',
  '--theme-midground': '#4a84fe',
  '--theme-background-seed': '#0d1117',
  '--theme-sidebar-seed': '#010409',
  '--theme-card-seed': '#010409',
  '--theme-elevated-seed': '#161b22',
  '--theme-bubble-seed': '#07162c',
  '--theme-neutral-chrome': '#0d0d0e',
  '--theme-neutral-sidebar': '#0a0a0b',
  '--theme-neutral-card': '#161618',
  '--theme-mix-chrome': '74%',
  '--theme-mix-card': '38%',
  '--theme-mix-elevated': '46%',
  '--theme-mix-bubble': '46%',
  '--dt-border': '#30363d',
  '--dt-input': '#0d1117',
  '--dt-ring': '#4a84fe',
  '--dt-muted': '#1a1e24',
  '--dt-primary-foreground': '#161616',
  '--dt-secondary-foreground': '#e6edf3',
  '--dt-accent-foreground': '#e6edf3',
  '--dt-midground-foreground': '#161616',
  '--dt-composer-ring': '#4a84fe',
  '--dt-destructive': '#f85149',
  '--dt-destructive-foreground': '#ffffff',
  '--dt-sidebar-border': '#30363d',
  '--dt-user-bubble-border': '#30363d',
  '--ui-inline-code-background': 'color-mix(in srgb, #ffffff 7%, transparent)',
  '--ui-inline-code-foreground': 'color-mix(in srgb, #ffffff 88%, transparent)',
  '--ui-selection-background': 'color-mix(in srgb, #ffd24a 38%, transparent)'
}

const LIGHT_SURFACE = {
  '--theme-secondary': '#deeaff',
  '--theme-accent-soft': '#e3edff',
  '--theme-midground': '#0053fd',
  '--theme-background-seed': '#f8faff',
  '--theme-sidebar-seed': '#f3f7ff',
  '--theme-card-seed': '#ffffff',
  '--theme-elevated-seed': '#ffffff',
  '--theme-bubble-seed': '#dae7fd',
  '--theme-neutral-chrome': '#f3f3f3',
  '--theme-neutral-sidebar': '#f3f3f3',
  '--theme-neutral-card': '#fcfcfc',
  '--theme-mix-chrome': '92%',
  '--theme-mix-card': '22%',
  '--theme-mix-elevated': '28%',
  '--theme-mix-bubble': '0%',
  '--dt-border': '#d0d7de',
  '--dt-input': '#ffffff',
  '--dt-ring': '#0053fd',
  '--dt-muted': '#f6f6f6',
  '--dt-primary-foreground': '#ffffff',
  '--dt-secondary-foreground': '#1f2328',
  '--dt-accent-foreground': '#1f2328',
  '--dt-midground-foreground': '#ffffff',
  '--dt-composer-ring': '#0053fd',
  '--dt-destructive': '#cf222e',
  '--dt-destructive-foreground': '#ffffff',
  '--dt-sidebar-border': '#d0d7de',
  '--dt-user-bubble-border': '#d0d7de',
  '--ui-inline-code-background': 'color-mix(in srgb, #141414 5%, transparent)',
  '--ui-inline-code-foreground': 'color-mix(in srgb, #141414 88%, transparent)',
  '--ui-selection-background': 'color-mix(in srgb, #ffd24a 55%, transparent)'
}

/* ── 小工具 ─────────────────────────────────────────────────────── */
const VIDEO_RE = /\.(mp4|webm|mov|mkv|avi|m4v)$/i

const luminance = hex => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''))

  if (!m) return 0

  const n = parseInt(m[1], 16)

  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255
}

/* 配置包里带的素材：导入时存进 IndexedDB，这里按原路径换成 blob URL。
   ⚠️ 插件里**所有**用素材的地方（背景 / 开机动画 / 动画音效 / 光标…）都经过
   mediaUrl / fileUrl 这两个函数，所以只要在这里兜一层，
   整插件就自动支持「导入别人打的包」——不需要逐个功能去改。 */
let bundleUrls = {}

const bundleAssetUrl = path => bunchUrlOf(path)

function bunchUrlOf (path) {
  if (!path) return ''

  return bundleUrls[String(path)] || ''
}

const mediaUrl = path => bundleAssetUrl(path) || `hermes-media://stream/${encodeURIComponent(String(path).replace(/^file:\/\//i, ''))}`

const fileUrl = path => {
  const bundled = bundleAssetUrl(path)

  if (bundled) return bundled

  const norm = String(path).replace(/^file:\/\//i, '').replace(/\\/g, '/')

  return 'file://' + encodeURI(norm.startsWith('/') ? norm : '/' + norm).replace(/#/g, '%23').replace(/\?/g, '%3F')
}

const sourceUrl = s => (s.mode === 'video' ? mediaUrl(s.path) : fileUrl(s.path))

/** 背景层不透明度：0 = 完全透明，1 = 原样 */
const layerOpacity = s => {
  const value = Number(s.bgOpacity)

  return (Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 100) / 100
}

const fileNameOf = path => (path ? String(path).split(/[\\/]/).pop() : '')

/** hex → rgba()，用于发光这类需要透明度的场合 */
function alphaColor(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''))

  if (!m) return `rgba(74, 132, 254, ${alpha})`

  const n = parseInt(m[1], 16)

  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/** 输入框（[data-slot='composer-surface']，就是打字那个框）的内发光与流光 */
function glowCss(s) {
  const color = s.glowColor || '#4a84fe'
  const strength = Math.max(0, Math.min(100, Number(s.glowStrength) || 0)) / 100
  const blur = Math.max(0, Math.min(80, Number(s.glowBlur) || 0))
  const width = Math.max(0.5, Math.min(8, Number(s.glowWidth) || 1.5))
  const speed = Math.max(0.5, Math.min(20, Number(s.glowSpeed) || 3.5))
  const flow = s.glowFlow !== 'off'

  /* ⚠️ 内发光不能用「带模糊的 inset 阴影」：模糊阴影在直角边各是一条，
     但在**弯道**处两条边的阴影会叠在一起 → 弯道明显比直边粗（用户报
     「弯道有很明显的粗细不一」）。改用 **spread 环**（blur 固定 0）：
     每一层都是等宽的环，弯道和直边完全一致；柔光靠三层递减浓度叠出来。 */
  /* 四层同心描边：外圈浓度不能太低，否则「调了像没调」（原来只有 0.09~0.13，
     而输入框底色透明 + 背后有模糊，低对比根本看不出来）。 */
  const ring1 = width
  const ring2 = Math.max(ring1 + 1, ring1 + blur * 0.3)
  const ring3 = Math.max(ring2 + 1, ring1 + blur * 0.65)
  const ring4 = Math.max(ring3 + 1, ring1 + blur * 1)

  let css = `
/* 输入框内发光：底色是窗口自己的，这里只加「贴边柔光」+ 更亮的描边。
   三层同心描边（等宽），弯道不会比直边粗。 */
[data-slot='composer-surface'] {
  position: relative;
  border-color: ${alphaColor(color, Math.min(1, strength + 0.15))} !important;
  box-shadow:
    inset 0 0 0 ${ring1.toFixed(2)}px ${alphaColor(color, strength)},
    inset 0 0 0 ${ring2.toFixed(2)}px ${alphaColor(color, strength * 0.55)},
    inset 0 0 0 ${ring3.toFixed(2)}px ${alphaColor(color, strength * 0.32)},
    inset 0 0 0 ${ring4.toFixed(2)}px ${alphaColor(color, strength * 0.16)} !important;
}
`

  if (!flow || width <= 0) {
    return css
  }

  css += `
/* 流光：一条光带沿边框转圈。@property 让自定义属性可动画，掩膜把渐变裁成边框环。 */
@property --hermes-glow-angle { syntax: '<angle>'; inherits: false; initial-value: 0deg; }
[data-slot='composer-surface']::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 6;
  border-radius: inherit;
  padding: ${width}px;
  pointer-events: none;
  background: conic-gradient(
    from var(--hermes-glow-angle),
    transparent 0deg,
    ${alphaColor(color, strength)} 70deg,
    transparent 150deg,
    transparent 180deg,
    ${alphaColor(color, strength)} 250deg,
    transparent 330deg
  );
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
  animation: hermes-glow-spin ${speed}s linear infinite;
}
@keyframes hermes-glow-spin { to { --hermes-glow-angle: 360deg; } }
`

  return css
}

/** 运行程序条（输入框上方的状态栈）自己的透明度 / 磨砂。
    默认「跟随输入框」，那时这里什么都不生成，外观由上面那套统一管。 */
/* 进程条左右内缩：输入框圆角是 16px（rounded-2xl），卡片原来只有 mx-2=8px，
   两端就落在圆角的弧线上。内缩 ≥ 圆角才能让它完整落在弧线以内。
   这一条和「是否跟随输入框」无关，始终生效。 */
/* 会话列宽度：加宽侧栏，给「阴影留白」腾出空间（不然行会显得变窄）。
   应用的宽度变量 --sidebar-width 写在 sidebar-wrapper 的内联样式上，
   内联样式压选择器 —— 所以这里必须 !important。 */
function sessColCss(s) {
  const raw = Number(s.sessColWidth)
  const pad = Math.max(0, Math.min(80, Number(s.sessColPad) || 0))
  const out = []

  if (Number.isFinite(raw) && raw > 0) {
    const rem = Math.max(10, Math.min(34, raw))

    out.push(`/* 会话列宽度：加宽侧栏（右侧空间多，卡片和阴影都更舒展） */
[data-slot='sidebar-wrapper'] {
  --sidebar-width: ${rem.toFixed(2)}rem !important;
}`)
  }

  if (pad > 0) {
    /* 阴影留白画在**滚动容器**上：行往中间收，阴影的模糊就有了横向余量。
       放在行自己身上会同时缩窄卡片、还会削掉圆角（padding 参与背景裁切）。 */
    out.push(`/* 会话列表容器左右内边距：给阴影留空间，但不缩卡片圆角 */
[data-slot='sidebar-wrapper'] [class*='scrollbar-fade'] {
  padding-inline: ${pad}px !important;
}`)
  }

  return out.length ? `\n${out.join('\n\n')}\n` : ''
}

function stackInsetCss(s) {
  const inset = Math.max(0, Math.min(80, Number(s.stackInset) || 0))

  if (!inset) return ''

  return `
/* 运行程序条：左右内缩到输入框圆角以内 */
[data-slot='composer-status-stack'] > * {
  margin-left: ${inset}px !important;
  margin-right: ${inset}px !important;
}
`
}

function stackCss(s) {
  if (s.stackFollow !== false) return ''

  const alpha = 100 - Math.max(0, Math.min(100, Number(s.stackAlpha) || 0))
  const frost = !!s.stackFrostOn
  const blur = Math.max(0, Math.min(40, Number(s.stackBlur) || 0))
  const sat = Math.max(100, Math.min(200, Number(s.stackSaturate) || 100))
  const lines = [
    `  --composer-fill: color-mix(in srgb, var(--dt-input) ${alpha}%, transparent) !important;`
  ]

  if (frost) {
    lines.push(`  -webkit-backdrop-filter: blur(${blur}px) saturate(${sat}%) !important;`)
    lines.push(`  backdrop-filter: blur(${blur}px) saturate(${sat}%) !important;`)
  }

  return `
/* 运行程序条（状态栈）：与输入框分开单独设置 */
[data-slot='composer-status-stack'] {
${lines.join('\n')}
}
`
}

/** 已发送的消息气泡（聊天记录里你自己那些）。
    钩子：气泡本体是 .composer-human-message，它的填充变量是 --dt-user-bubble；
    外框是 [data-slot='aui_user-message-root']。错开漂浮用 [data-slot='aui_message-group']
    的 nth-child（一个回合一个 group）。 */
const BUBBLE = "[data-slot='aui_user-message-root'] .composer-human-message"
/* 助手这一侧（我发给你的消息）的气泡目标 = 正文容器。
   里面还混着思维链（[data-slot='aui_thinking-disclosure']）和工具卡，
   所以气泡是「整条消息一个」：思维链默认是收起的一行，会跟着落在气泡里。 */
const A_BUBBLE = "[data-slot='aui_assistant-message-content']"
/* 输入框（打字那个框）；原先处处写成字面量，现在收成一个常量 */
const COMPOSER = "[data-slot='composer-surface']"

/* ── 歌词 ──────────────────────────────────────────────────────────
   两个来源：① 每条曲子可以自己指定一个 .lrc / .txt（最稳）；
   ② 没指定就从音频文件里抠——读文件头（走 hermes-media:// 的 Range），
   把带 [mm:ss] 时间轴的行留下（ID3 的 USLT 里常见的就是这种文本）。
   卡片是纯 DOM（和背景层、开机动画一样），不改 React 树。 */
const LYRICS_ID = 'hermes-lyrics-card'

let lyricsLines = []
let lyricsIndex = -1
let lyricsPlainTimer = 0
let lyricsLoadedFor = ''

/** 解析 LRC：支持一行多个时间戳；没有时间轴的按普通文本行处理 */
function parseLyrics(text) {
  const stamp = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
  const lines = []

  for (const raw of String(text || '').split(/\r?\n/)) {
    stamp.lastIndex = 0

    const times = []
    let match

    while ((match = stamp.exec(raw))) {
      const frac = match[3] || ''
      const scale = frac.length === 3 ? 1000 : frac.length === 2 ? 100 : 10

      times.push(Number(match[1]) * 60 + Number(match[2]) + (frac ? Number(frac) / scale : 0))
    }

    const content = raw.replace(stamp, '').trim()

    if (!content) continue
    if (times.length) for (const time of times) lines.push({ t: time, text: content })
    else lines.push({ t: null, text: content })
  }

  lines.sort((a, b) => (a.t == null ? Infinity : a.t) - (b.t == null ? Infinity : b.t))

  return lines
}

function fetchText(url) {
  return fetch(url).then(res => (res.ok ? res.text() : '')).catch(() => '')
}

/** 从音频文件里抠歌词：只认带 [mm:ss] 的行，够稳且能吃掉 ID3 里那堆二进制 */
function readEmbeddedLyrics(path) {
  return fetch(mediaUrl(path), { headers: { Range: 'bytes=0-262143' } })
    .then(res => (res.ok ? res.arrayBuffer() : null))
    .then(buf => {
      if (!buf) return ''

      const text = new TextDecoder('utf-8', { fatal: false }).decode(buf).replace(/\u0000/g, '')

      return text.split(/\r?\n/).filter(line => /\[\d{1,2}:\d{1,2}/.test(line)).join('\n')
    })
    .catch(() => '')
}

function lyricsCard() {
  let card = document.getElementById(LYRICS_ID)

  if (!card) {
    card = document.createElement('div')
    card.id = LYRICS_ID
    card.setAttribute('aria-hidden', 'true')

    const beam = document.createElement('div')

    beam.className = 'hs-lyrics-beam'

    const now = document.createElement('div')

    now.className = 'hs-lyrics-now'

    const next = document.createElement('div')

    next.className = 'hs-lyrics-next'

    card.appendChild(beam)
    card.appendChild(now)
    card.appendChild(next)
    document.body.appendChild(card)
  }

  return card
}

function renderLyricsCard(s) {
  /* 只有真的解析出歌词才投射卡片（还没念出来的空空一张卡片很丑） */
  const on = !!s.lyricsOn && lyricsLines.length > 0
  let card = document.getElementById(LYRICS_ID)

  if (!on) {
    if (card) card.remove()

    return
  }

  card = lyricsCard()

  const index = Math.max(0, Math.min(lyricsLines.length - 1, lyricsIndex))
  const current = lyricsLines[index]
  const nextLine = lyricsLines[index + 1]

  card.querySelector('.hs-lyrics-now').textContent = current ? current.text : ''
  card.querySelector('.hs-lyrics-next').textContent = nextLine ? nextLine.text : ''
  card.classList.toggle('hs-lyrics-synced', Boolean(current && current.t != null))
}

/** 按播放进度定位到当前那句（有时间轴才做） */
function syncLyricsToTime(seconds) {
  if (!lyricsLines.length) return
  if (lyricsLines[0].t == null) return

  let index = 0

  for (let i = 0; i < lyricsLines.length; i += 1) {
    if (lyricsLines[i].t != null && lyricsLines[i].t <= seconds + 0.35) index = i
    else break
  }

  if (index !== lyricsIndex) {
    lyricsIndex = index
    renderLyricsCard($settings.get())
  }
}

/** 没有时间轴时，按固定秒数往下翻 */
function startPlainLyricsTimer(s) {
  clearInterval(lyricsPlainTimer)
  lyricsPlainTimer = 0

  if (!s.lyricsOn || !lyricsLines.length || lyricsLines[0].t != null) return

  const seconds = Math.max(3, Math.min(20, Number(s.lyricsPlainSeconds) || 6))

  lyricsPlainTimer = setInterval(() => {
    lyricsIndex = (lyricsIndex + 1) % lyricsLines.length
    renderLyricsCard($settings.get())
  }, seconds * 1000)
}

/** 换曲 / 设置变动时，重新装载歌词 */
function loadLyrics(s, force) {
  const list = musicList(s)
  const track = list.length ? list[musicIndex % list.length] : null
  const key = track ? `${track.path}|${track.lyricsPath || ''}` : ''

  if (!s.lyricsOn) {
    lyricsLines = []
    lyricsIndex = -1
    lyricsLoadedFor = ''
    clearInterval(lyricsPlainTimer)
    lyricsPlainTimer = 0
    renderLyricsCard(s)

    return
  }

  if (!track) {
    lyricsLines = []
    lyricsIndex = -1
    lyricsLoadedFor = ''
    renderLyricsCard(s)

    return
  }

  if (!force && key === lyricsLoadedFor) return

  lyricsLoadedFor = key
  lyricsIndex = 0

  const adopt = text => {
    lyricsLines = parseLyrics(text)
    lyricsIndex = 0
    renderLyricsCard($settings.get())
    startPlainLyricsTimer($settings.get())
  }

  if (track.lyricsPath) {
    fetchText(mediaUrl(track.lyricsPath)).then(text =>
      adopt(text || '')
    )

    return
  }

  readEmbeddedLyrics(track.path).then(adopt)
}

function setMusicOrder(index, order) {
  const list = ($settings.get().musicTracks || []).map((track, i) =>
    i === index ? { ...track, order: Math.max(1, Math.min(99, Number(order) || 1)) } : track
  )

  update({ musicTracks: list })
}

function removeMusic(index) {
  update({ musicTracks: ($settings.get().musicTracks || []).filter((_, i) => i !== index) })
}

const AUDIO_RE = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|wma|aiff?|mp4|webm)$/i

/** 收下一批文件（可选文件夹），去重后追加；文件夹按文件名排序，序号接着往下排 */
function adoptMusicFiles(files, options) {
  const list = [...($settings.get().musicTracks || [])]
  const seen = new Set(list.map(track => track.path))
  const incoming = []
  let skipped = 0

  for (const file of files) {
    const name = file && file.name ? String(file.name) : ''

    if (name && !AUDIO_RE.test(name)) {
      skipped += 1
      continue
    }

    const path = file ? window.hermesDesktop?.getPathForFile?.(file) || '' : ''

    if (!path || seen.has(path)) {
      skipped += 1
      continue
    }

    seen.add(path)
    incoming.push({ name, path })
  }

  if (options && options.sortByName) {
    incoming.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }))
  }

  for (const item of incoming) {
    list.push({ order: list.length + 1, path: item.path })
  }

  update({ musicTracks: list })

  if (skipped) {
    host.notify({
      kind: 'warn',
      message: `有 ${skipped} 个文件没加进来（不是音频、拿不到路径，或已经在列表里了）。`
    })
  }
}

function addMusicFolder() {
  const input = document.createElement('input')

  input.type = 'file'
  input.multiple = true
  input.setAttribute('webkitdirectory', '')
  input.setAttribute('directory', '')
  input.onchange = () => adoptMusicFiles(Array.from(input.files || []), { sortByName: true })
  input.click()
}

function pickMusicLyrics(index) {
  const input = document.createElement('input')

  input.type = 'file'
  input.accept = '.lrc,.txt,text/plain'
  input.onchange = () => {
    const file = input.files && input.files[0]
    const path = file ? window.hermesDesktop?.getPathForFile?.(file) : ''

    if (!path) {
      host.notify({ kind: 'warn', message: '拿不到这个文件的路径，换个文件再试。' })

      return
    }

    update({
      musicTracks: ($settings.get().musicTracks || []).map((track, i) =>
        i === index ? { ...track, lyricsPath: path } : track
      )
    })
    loadLyrics($settings.get(), true)
  }

  input.click()
}

function clearMusicLyrics(index) {
  update({
    musicTracks: ($settings.get().musicTracks || []).map((track, i) =>
      i === index ? { ...track, lyricsPath: '' } : track
    )
  })
  loadLyrics($settings.get(), true)
}

function addMusicFiles() {
  const input = document.createElement('input')

  input.type = 'file'
  input.accept = 'audio/*'
  input.multiple = true
  input.onchange = () => adoptMusicFiles(Array.from(input.files || []))
  input.click()
}

/** 曲目列表：序号可改，删掉当前那首会自动换 */
function musicRows(s) {
  const tracks = s.musicTracks || []

  if (!tracks.length) {
    return jsx('div', {
      className: 'mt-2 text-xs text-(--ui-text-tertiary)',
      children: '还没有曲目（可以多选文件，或「导入文件夹…」整个文件夹收进来）'
    })
  }

  const playing = $music.get().track

  return jsxs('div', {
    className: 'mt-2 flex flex-col gap-1',
    children: orderedClips(tracks).map(({ clip, index }) => {
      const name = fileNameOf(clip.path)

      return jsxs(
        'div',
        {
          className: 'flex items-center gap-2 text-xs',
          children: [
            jsx('span', { className: 'shrink-0 text-(--ui-text-tertiary)', children: '序号' }),
            jsx('input', {
              className:
                'w-11 shrink-0 rounded border border-(--ui-stroke-secondary) bg-transparent px-1 py-0.5 text-center',
              defaultValue: Number(clip.order) || index + 1,
              max: 99,
              min: 1,
              onChange: event => setMusicOrder(index, event.target.value),
              type: 'number'
            }),
            jsx('span', {
              className: 'min-w-0 flex-1 truncate text-(--ui-text-tertiary)',
              children: `${name}${name === playing ? '   ← 正在播' : ''}${
                clip.lyricsPath ? `   · 歌词 ${fileNameOf(clip.lyricsPath)}` : ''
              }`
            }),
            jsx(Button, {
              onClick: () => pickMusicLyrics(index),
              variant: 'textStrong',
              children: clip.lyricsPath ? '换歌词' : '歌词…'
            }),
            clip.lyricsPath
              ? jsx(Button, {
                  onClick: () => clearMusicLyrics(index),
                  variant: 'textStrong',
                  children: '清歌词'
                })
              : null,
            jsx(Button, {
              onClick: () => removeMusic(index),
              variant: 'textStrong',
              children: '删除'
            })
          ]
        },
        `${clip.path}-${index}`
      )
    })
  })
}

function bubbleCss(s) {
  const rules = []
  const alphaOf = value => Math.max(0, Math.min(100, Number(value) || 0)) / 100
  const isOn = value => value === true || value === 'on'
  /* 0 也是有效值（模糊 0px、圆角 0px 都得照做），所以不能拿 || 兜默认 */
  const numOr = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback)

  /* ── 发出去的入场动画（类由 JS 只加在新气泡上，见 watchBubbles） ── */
  const enterMode =
    s.bubbleEnter === 'rise' || s.bubbleEnter === 'pop' || s.bubbleEnter === 'slide' || s.bubbleEnter === 'fly' ? s.bubbleEnter : 'off'
  const enterMs = Math.max(120, Math.min(1500, Number(s.bubbleEnterMs) || 420))
  const enterAmp = Math.max(2, Math.min(60, Number(s.bubbleEnterAmp) || 16))

  if (enterMode !== 'off') {
    const frames =
      enterMode === 'pop'
        ? `@keyframes hs-msg-in-pop {
  from { opacity: 0; scale: 0.94; }
  to { opacity: 1; scale: 1; }
}`
        : enterMode === 'fly'
          ? `/* 从输入框飞入：位移与缩放起点由 JS 量出来写成 --hs-fdx/--hs-fdy，
               所以它总是从「你刚打字的那个输入框」的位置飞过来 —— 丝滑的关键。 */
@keyframes hs-msg-in-fly {
  from { opacity: 0; translate: var(--hs-fdx, 0px) var(--hs-fdy, 0px); scale: 0.7; }
  55% { opacity: 1; }
  to { opacity: 1; translate: 0 0; scale: 1; }
}`
          : enterMode === 'slide'
          ? `@keyframes hs-msg-in-slide {
  from { opacity: 0; translate: ${enterAmp}px 0; }
  to { opacity: 1; translate: 0 0; }
}`
          : `@keyframes hs-msg-in-rise {
  from { opacity: 0; translate: 0 ${enterAmp}px; }
  to { opacity: 1; translate: 0 0; }
}`

    /* 动画加在「外框」上而不是气泡本体：气泡本体可能已经挂着悬浮动画，会互相顶掉 */
    /* 「从输入框飞入」是长距离运动：时长给足、缓动用更柔的 ease-out，才有丝滑感 */
    const enterDur = enterMode === 'fly' ? Math.max(560, enterMs) : enterMs
    const enterCurve = enterMode === 'fly' ? 'cubic-bezier(0.16, 1, 0.3, 1)' : 'cubic-bezier(0.22, 1, 0.36, 1)'

    rules.push(`[data-slot='aui_user-message-root'].hs-msg-enter {
  animation: hs-msg-in-${enterMode} ${enterDur}ms ${enterCurve} both;
}

${frames}`)
  }

  /* ── 发送按钮内缩（用户报「多行时发送按钮被挡住」）────────────────────
     输入框是 overflow-hidden + rounded-[inherit]，玻璃的圆角设得大（如 60px）时，
     右下角那圈圆弧会把角上的发送按钮切掉。几何上要让按钮完全落在圆角内，
     它到底边的距离至少得 ≥ r×(1−1/√2) ≈ 0.293r —— 按这个给按钮留内缩。
     圆角不大（≤24px）时不动它，免得改变原本的布局。 */
  const composerRadius = lgxClamp(lgxNum(s.lgxRadius, 22), 0, 60)

  if (s.lgxOn === true && composerRadius > 24) {
    const inset = Math.ceil(0.293 * composerRadius)

    rules.push(`[data-slot='composer-surface'] button[type='submit'] {
  margin-right: ${inset}px !important;
  margin-bottom: ${Math.max(2, Math.round(inset * 0.5))}px !important;
}`)
  }

  const lift = Math.max(0, Math.min(12, Number(s.bubbleLift) || 0))
  const amp = Math.max(0, Math.min(10, Number(s.bubbleAmp) || 0))
  const speed = Math.max(2, Math.min(14, Number(s.bubbleSpeed) || 7))

  /* ── 悬浮 ── */
  if (s.bubbleFloat) {
    rules.push(`${BUBBLE} {
  translate: 0 -${lift}px;
  animation: hs-msg-bob ${speed}s ease-in-out infinite;
  transition: scale .18s ease;
}

${BUBBLE}:hover {
  scale: 1.015;
}

@keyframes hs-msg-bob {
  0%, 100% { translate: 0 -${lift}px; }
  50% { translate: 0 -${(lift + amp).toFixed(2)}px; }
}`)

    if (s.bubbleStagger !== 'off') {
      rules.push(`/* 错开：按回合（message-group）错开相位，气泡不会整齐一起动 */
[data-slot='aui_message-group']:nth-child(4n + 1) ${BUBBLE} { animation-duration: ${speed.toFixed(2)}s; animation-delay: 0s; }
[data-slot='aui_message-group']:nth-child(4n + 2) ${BUBBLE} { animation-duration: ${(speed * 1.13).toFixed(2)}s; animation-delay: -1.7s; }
[data-slot='aui_message-group']:nth-child(4n + 3) ${BUBBLE} { animation-duration: ${(speed * 1.27).toFixed(2)}s; animation-delay: -3.1s; }
[data-slot='aui_message-group']:nth-child(4n + 4) ${BUBBLE} { animation-duration: ${(speed * 1.41).toFixed(2)}s; animation-delay: -4.6s; }`)
    }
  }

  /* ── 圆角 ── */
  /* 玻璃（lgx 那套）开着就用它的圆角，否则用气泡自己的圆角 */
  const lgxBubbleR = lgxRadiusOf(s, 'bubble')
  const radius = lgxBubbleR !== null
    ? lgxBubbleR
    : Math.max(0, Math.min(28, Number(s.bubbleRadius) || 0))

  if (radius > 0) {
    rules.push(`${BUBBLE} { border-radius: ${radius}px !important; }`)
  }

  /* ── 阴影 / 内发光 / 外发光 ── */
  const strength = alphaOf(s.bubbleShadow)
  const softA = (0.08 + strength * 0.4).toFixed(2)
  const inOn = isOn(s.bubbleInOn)
  const outOn = isOn(s.bubbleOutOn)
  const inColor = s.bubbleInColor || '#7ee7ff'
  const outColor = s.bubbleOutColor || '#4a84fe'
  const inA = alphaOf(s.bubbleInStrength)
  const outA = alphaOf(s.bubbleOutStrength)
  const inBlur = Math.max(0, Math.min(40, Number(s.bubbleInBlur) || 0))
  const inWidth = Math.max(0.5, Math.min(8, Number(s.bubbleInWidth) || 2))
  const outBlur = Math.max(0, Math.min(48, Number(s.bubbleOutBlur) || 0))
  const parts = []

  /* 投影只在悬浮时加：默认（不悬浮）就一点都不碰气泡的原有外观 */
  if (s.bubbleFloat && strength > 0) {
    parts.push(`0 ${Math.round(1 + lift * 0.5)}px ${Math.round(4 + lift * 2)}px rgba(0, 0, 0, ${softA})`)
  }

  if (outOn) parts.push(`0 0 ${outBlur}px ${alphaColor(outColor, outA)}`)

  if (inOn) {
    parts.push(
      `inset 0 0 ${inBlur}px 0 ${alphaColor(inColor, inA * 0.55)}`,
      `inset 0 0 ${inWidth}px 0 ${alphaColor(inColor, Math.min(1, inA * 0.9))}`
    )
  }

  if (parts.length) {
    rules.push(`${BUBBLE} { box-shadow: ${parts.join(', ')} !important; }`)
  }

  /* ── 外发光流动 ── */
  if (outOn && s.bubbleOutFlow === 'on') {
    const flowSpeed = Math.max(1, Math.min(20, Number(s.bubbleOutSpeed) || 4))

    rules.push(`@property --hs-msg-angle { syntax: '<angle>'; inherits: false; initial-value: 0deg; }

${BUBBLE}::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 2;
  border-radius: inherit;
  padding: ${Math.max(1, Math.round((radius || 10) * 0.18))}px;
  pointer-events: none;
  background: conic-gradient(
    from var(--hs-msg-angle),
    transparent 0deg,
    ${alphaColor(outColor, outA)} 70deg,
    transparent 150deg,
    transparent 180deg,
    ${alphaColor(outColor, outA)} 250deg,
    transparent 330deg
  );
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
  animation: hs-msg-spin ${flowSpeed}s linear infinite;
}

@keyframes hs-msg-spin { to { --hs-msg-angle: 360deg; } }`)
  }

  return rules.length ? '\n' + rules.join('\n\n') + '\n' : ''
}

/** 输入框磨砂（毛玻璃）。
    要点：backdrop-filter 模糊的是元素「背后」的东西 —— 必须让输入框自己的
    填充先半透明，磨砂才透得出来。应用画输入框填充用的是 --composer-fill
    这个变量（贴在输入框上的 / 命令、@ 引用弹层也共用它），所以改它一处，
    输入框和它的附属弹层就一起保持一致。 */

/** 左列会话行的悬浮效果。
    两个必须绕开的坑：
      1) 会话列表是虚拟滚动，行位置由**内联 transform: translateY()** 决定 —— 位移只能用
         独立的 `translate` / `scale` 属性（与 transform 叠加），绝不能写 transform，否则整列行会被踩掉；
      2) 行的背景（选中那条带）画在行根节点上，间隙靠「加 padding-block + background-clip: content-box」
         做出来 —— 行的高度变高会被虚拟滚动重新测量，不会错位。
    工作状态由会话行自带的 data-working="true" 标记；虚拟项包装带 data-index，用它按尾号错开相位。 */
const SIDE = "[data-slot='sidebar-wrapper']"
const ROW = 'div.row-hover:has(.hover-marquee)'

/* 用户没自定义颜色时的彩色流光光谱 */
const AURA_SPECTRUM = ['#ff3b6b', '#ffb020', '#ffe94a', '#43e97b', '#38bdf8', '#a855f7']

/* 开关统一判定：老设置里存过字符串 'on'/'off'，!!'off' 是 true，必须显式判断 */
const isOn = value => value === true || value === 'on'

function sessionCss(s) {
  const float = isOn(s.sessOn)
  const inOn = isOn(s.sessInOn)
  const outOn = isOn(s.sessOutOn)
  /* 只要开了任意一项，会话行就得有「卡片」样式（圆角 + 行间隙）：
     光晕是贴着卡片外沿画的，没有卡片就没有可贴的边。
     上下漂浮则只有开「会话悬浮」才有。 */
  const card = float || inOn || outOn
  const lift = float ? Math.max(0, Math.min(12, Number(s.sessLift) || 0)) : 0
  const workExtra = Math.max(0, Math.min(12, Number(s.sessWorkExtra) || 0))
  const amp = Math.max(0, Math.min(10, Number(s.sessAmp) || 0))
  const speed = Math.max(1, Math.min(14, Number(s.sessSpeed) || 6))
  const strength = Math.max(0, Math.min(100, Number(s.sessShadow) || 0)) / 100
  const color = s.sessGlowColor || '#4a84fe'
  /* 开了液态玻璃时用玻璃的圆角 —— 阴影（::before）和行本身的圆角必须同源，
     否则拐角处会露出一块方角 */
  /* 圆角只有一个来源：设置页的「圆角」滑块。开着液态玻璃时玻璃也跟它走
     （阴影 ::before 和行本身的圆角必须同源，否则拐角处露出一块方角）。
     ⚠️ 以前开玻璃时会改用「玻璃圆角」那个滑块，用户调的「圆角」被静默顶掉 ——
     「圆角设置失效」就是这个原因，现已合并成一个。 */
  const radius = card ? Math.max(0, Math.min(32, Number(s.sessRadius) || 0)) : 0
  /* 开了触碰反馈时行间隙至少 12px —— 气泡要膨大、要跟随鼠标上下，
     间隙不够就会压到上下相邻行（用户明确要求不要重叠）。 */
  /* 行间隙完全由用户那个滑块决定（0 就是 0）。
     ⚠️ 以前开了「鼠标触碰反馈」会强制至少 12px（防重叠），滑块设 0 实际仍有 24px 空隙，
     用户报「间隙设置为 0 依旧很大」。改法：去掉地板，「不重叠」交给净空夹取 ——
     间隙越小，能浮动的幅度就自动越小，永远不会压到相邻行。 */
  const gap = card ? Math.max(0, Math.min(12, Number(s.sessGap) || 0)) : 0
  /* 左右内缩：光晕 / 悬停放大会往左右溢出，缩进来才不会被侧栏边缘切掉。
     给阴影腾空间靠的是「容器内边距」（见 sessColCss），**不是**加大这里 ——
     这里加大会让卡片变窄、圆角也会被削（用户报「会话太小」「半圆被裁」）。 */
  const inset = card ? Math.max(0, Math.min(20, Number(s.sessInset) || 0)) : 0
  const stagger = float && s.sessStagger !== 'off'
  /* 顶部净空：行是往上浮的，最上面那行会被滚动区顶边切掉 / 被上面的元素盖住。
     以前这是用户手调的「列表下移」滑块，现在按最大漂浮幅度自动算（用户要求删掉那个设置）。
     = 基线上浮 + 工作会话额外幅度 + 振幅 ×1.5（关键帧最高点）+ 触碰反馈的上飘/跟随/放大。 */
  const touchAmp = isOn(s.sessTouchOn)
    ? Math.max(0, Math.min(24, Number(s.sessTouchRise) || 0))
      + Math.max(0, Math.min(24, Number(s.sessTouchFollow) || 0))
      + Math.max(0, Math.min(30, Number(s.sessTouchGrow) || 0))
    : 0
  const push = float ? Math.max(0, Math.min(48, Math.ceil(lift + workExtra + amp * 1.5 + touchAmp))) : 0

  /* ── 工作会话的流光 ──
     彩色流光 = 整圈颜色首尾相接转起来；单色流光 = 只用第一个颜色。
     颜色由用户自定义（最多 3 个），全留空就退回内置光谱（真彩色）。 */
  const auraMode = s.sessAuraMode === 'solid' ? 'solid' : s.sessAuraMode === 'off' ? 'off' : 'rainbow'
  const auraOn = auraMode !== 'off'
  const auraPicked = [s.sessAuraC1, s.sessAuraC2, s.sessAuraC3].map(v => String(v || '').trim()).filter(Boolean)
  const auraColors = auraMode === 'solid'
    ? [auraPicked[0] || color]
    : auraPicked.length
      ? auraPicked
      : AURA_SPECTRUM
  const auraRing = auraColors.concat([auraColors[0]]).join(', ')
  const auraWidth = Math.max(0.5, Math.min(8, Number(s.sessAuraWidth) || 2))
  const auraSpeed = Math.max(1, Math.min(20, Number(s.sessAuraSpeed) || 3))

  const workBase = lift + workExtra
  const workAmp = amp * 1.5
  const workSpeed = Math.max(1, Number((speed * 0.62).toFixed(2)))

  /* 抬升的投影：模糊半径跟着「抬升」走，不跟着行高走，否则光晕会比行还大 */
  const softA = (0.1 + strength * 0.35).toFixed(2)
  const strongA = (Number(softA) + 0.12).toFixed(2)
  const haloA = (0.12 + strength * 0.4).toFixed(2)
  const darkShadow = `0 ${Math.round(1 + lift * 0.5)}px ${Math.round(4 + lift * 1.5)}px rgba(0, 0, 0, ${softA})`
  const hoverDark = `0 ${Math.round(2 + lift * 0.6)}px ${Math.round(8 + lift * 2)}px rgba(0, 0, 0, ${strongA})`
  const workDark = `0 ${Math.round(2 + workExtra * 0.7)}px ${Math.round(6 + workExtra * 2)}px rgba(0, 0, 0, ${softA})`
  const hoverWorkDark = `0 ${Math.round(3 + workExtra * 0.8)}px ${Math.round(10 + workExtra * 2)}px rgba(0, 0, 0, ${strongA})`
  const workHalo = `0 0 ${Math.round(6 + workExtra * 1.5)}px ${alphaColor(auraOn ? auraColors[0] : color, haloA)}`

  /* 内发光：一层贴在卡片内侧的柔光 + 一条更紧的边缘光带（和输入框同一套做法） */
  const inColor = s.sessInColor || '#4a84fe'
  const inA = Math.max(0, Math.min(100, Number(s.sessInStrength) || 0)) / 100
  const inBlur = Math.max(0, Math.min(40, Number(s.sessInBlur) || 0))
  const inWidth = Math.max(0.5, Math.min(8, Number(s.sessInWidth) || 2))
  const innerShadow = inOn
    ? `inset 0 0 ${inBlur}px 0 ${alphaColor(inColor, inA * 0.55)}, inset 0 0 ${inWidth}px 0 ${alphaColor(inColor, Math.min(1, inA * 0.9))}`
    : ''

  /* 外发光：贴着卡片外沿的一圈光 */
  const outColor = s.sessOutColor || '#4a84fe'
  const outA = Math.max(0, Math.min(100, Number(s.sessOutStrength) || 0)) / 100
  const outBlur = Math.max(0, Math.min(48, Number(s.sessOutBlur) || 0))
  const outerShadow = outOn ? `0 0 ${outBlur}px ${alphaColor(outColor, outA)}` : ''

  const stack = parts => {
    const kept = parts.filter(Boolean)

    return kept.length ? kept.join(', ') : 'none'
  }

  const baseShadow = stack([darkShadow, outerShadow, innerShadow])
  const hoverShadow = stack([hoverDark, outerShadow, innerShadow])
  const workShadow = stack([workDark, workHalo, outerShadow, innerShadow])
  const hoverWorkShadow = stack([hoverWorkDark, workHalo, outerShadow, innerShadow])

  const outFlow = outOn && isOn(s.sessOutFlow)
  const outSpeed = Math.max(1, Math.min(20, Number(s.sessOutSpeed) || 4))

  const cardRule =
    radius > 0 || gap > 0 || inset > 0 || card
      ? `${SIDE} ${ROW} {
  ${radius > 0 ? `border-radius: ${radius}px !important;` : ''}
  ${card ? `padding-block: ${gap}px !important;` : ''}
  /* 横向内缩用 **margin** 而不是 padding：背景被 background-clip: content-box 裁到内容框，
     而 CSS 规定内层盒子的圆角要减去 padding —— padding 一大，圆角就被削成 0，
     左右两端变直角（用户报「左右的半圆被裁了」）。margin 不参与背景裁切，圆角完整。 */
  ${inset > 0 ? `margin-inline: ${inset}px !important;` : ''}
  ${gap > 0 || inset > 0 ? `background-clip: content-box !important;` : ''}
}

${SIDE} ${ROW} > * {
  ${radius > 0 ? `border-radius: ${radius}px !important;` : ''}
}
`
      : ''

  /* 错开：按虚拟项 data-index 的尾号给不同时长与相位（负相位 = 一开始就错开） */
  const buckets = stagger
    ? Array.from({ length: 10 }, (_, digit) => {
        const normalDuration = (speed * (1 + digit * 0.055)).toFixed(2)
        const workDuration = (workSpeed * (1 + digit * 0.055)).toFixed(2)
        const delay = (-(digit * 0.68)).toFixed(2)

        return `${SIDE} div[data-index$='${digit}'] ${ROW} { animation-duration: ${normalDuration}s; animation-delay: ${delay}s; }
${SIDE} div[data-index$='${digit}'] ${ROW}[data-working='true'] { animation-duration: ${workDuration}s; }`
      }).join('\n')
    : ''

  let css = ''

  if (cardRule) {
    css += `
/* 卡片样式：圆角 + 行间隙（间隙靠 padding-block + background-clip，
   行高变化会被虚拟滚动重新测量，不会错位） */
${cardRule}
`
  }

  if (push > 0) {
    css += `
/* 整体下推：行是往上浮的，最上面那行会被滚动区顶边切掉；
   把装行的容器整体往下推一点，给它留出漂浮的净空。
   用 translate（独立属性）而不是 transform / margin，绝不动虚拟滚动的定位。 */
${SIDE} div:has(> div[data-index]) {
  translate: 0 ${push}px;
}
`
  }

  if (float) {
    css += `
/* 普通会话：轻轻抬起 + 缓慢上下漂 */
${SIDE} ${ROW} {
  translate: 0 -${lift}px;
  animation: hs-bob-normal ${speed}s ease-in-out infinite;
  transition: scale .18s ease;
}

/* 正在工作：抬得更高、幅度更大、节奏更快，外加一圈状态光晕 */
${SIDE} ${ROW}[data-working='true'] {
  translate: 0 -${workBase}px;
  animation-name: hs-bob-work;
  animation-duration: ${workSpeed}s;
}

/* 悬停时再放大一点点，给即时反馈 */
${SIDE} ${ROW}:hover {
  scale: 1.02;
}

@keyframes hs-bob-normal {
  0%, 100% { translate: 0 -${lift}px; }
  50% { translate: 0 -${(lift + amp).toFixed(2)}px; }
}

@keyframes hs-bob-work {
  0%, 100% { translate: 0 -${workBase}px; }
  50% { translate: 0 -${(workBase + workAmp).toFixed(2)}px; }
}

/* 错开漂浮：行与行不再同步 */
${buckets}
`
  }

  const touchOn = isOn(s.sessTouchOn)
  const touchGrow = Math.max(0, Math.min(20, Number(s.sessTouchGrow) || 0))
  const touchRise = Math.max(0, Math.min(20, Number(s.sessTouchRise) || 0))
  const touchMs = Math.max(80, Math.min(3000, Number(s.sessTouchMs) || 620))

  if (touchOn) {
    /* 膨大与上飘/跟随全部由 JS 用慢速插值驱动（见 syncLgxElastic / hsFollowFrame）——
       这里只留「浮到最上层」和阴影过渡。为什么不用 CSS :hover 直接改 translate：
       行的 translate 被漂浮动画占着，动画压过普通声明，悬停会瞬间落位（用户报「瞬间放大」
       「跟鼠标不跟」）。JS 用行内 !important 才压得住动画，且插值天然就是缓缓滑过去。 */
    css += `
/* 鼠标触碰反馈：JS 缓缓驱动膨大与跟随；这里只管图层与阴影 */
${SIDE} ${ROW} {
  transition: box-shadow .28s ease;
}

${SIDE} ${ROW}:hover {
  z-index: 3;
}
`
  }

  if (card) {
    css += `
/* 阴影 / 光晕统一画在 ::before 上，并缩进到卡片自己的范围：
   行带 padding-block（就是行间隙），背景又被 background-clip 裁到内容框，
   卡片比行盒子小一圈 —— 影子若贴着行盒子画，就会和卡片边缘空出一道间隙。
   这里用同样的 inset + 圆角复刻卡片，边缘严丝合缝。
   z-index:-1 让它落在「行自己的背景之上、文字之下」：内发光不会糊住文字。 */
${SIDE} ${ROW}::before {
  content: '';
  position: absolute;
  /* 行已经用 margin 横向缩进来了，所以伪元素横向不再缩；纵向仍留 gap（卡片被
     background-clip 裁掉的那一圈）。圆角同样减去 gap —— 和卡片的有效圆角一致，
     阴影才严丝合缝。 */
  inset: ${gap}px 0;
  border-radius: ${Math.max(0, radius - gap)}px;
  pointer-events: none;
  z-index: -1;
  transition: box-shadow .18s ease;
  box-shadow: ${baseShadow};
}

${SIDE} ${ROW}:hover::before {
  box-shadow: ${hoverShadow};
}
`
    if (float) {
      css += `
${SIDE} ${ROW}[data-working='true']::before {
  box-shadow: ${workShadow};
}

/* 工作会话单独一条：不然上面的悬停规则会把状态光晕整个盖掉 */
${SIDE} ${ROW}[data-working='true']:hover::before {
  box-shadow: ${hoverWorkShadow};
}
`
    }
  }

  /* 流动光环：外发光流动 与 工作会话流光 共用同一条 ::after
     （伪元素只有两个，所以按状态在同一元素上切换背景；工作态的规则
     多带一个属性选择器，优先级更高，会盖住空闲态那条）。 */
  if (outFlow || auraOn) {
    css += `
/* 流光原理：conic 渐变 + 双 mask 裁成边框环 + @property 角度动画
   （和输入框流光同一套做法） */
@property --hs-row-angle { syntax: '<angle>'; inherits: false; initial-value: 0deg; }
`

    if (outFlow) {
      css += `${SIDE} ${ROW}::after {
  content: '';
  position: absolute;
  /* 行已经用 margin-inline 缩进来了，这里横向不再缩 —— 必须和 ::before（卡片/阴影）
     完全同一套几何，否则流光环和卡片对不上（用户报「完全对不上」）。 */
  inset: ${gap}px 0;
  z-index: 2;
  border-radius: ${Math.max(0, radius - gap)}px;
  padding: ${Math.max(1, Math.round(outBlur * 0.16))}px;
  pointer-events: none;
  background: conic-gradient(
    from var(--hs-row-angle),
    transparent 0deg,
    ${alphaColor(outColor, outA)} 70deg,
    transparent 150deg,
    transparent 180deg,
    ${alphaColor(outColor, outA)} 250deg,
    transparent 330deg
  );
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
  animation: hs-row-spin ${outSpeed}s linear infinite;
}

`
    }

    if (auraOn) {
      css += `/* 工作会话：流光（整圈颜色首尾相接，转起来就是流动的彩带） */
${SIDE} ${ROW}[data-working='true']::after {
  content: '';
  position: absolute;
  inset: ${gap}px 0;
  z-index: 2;
  border-radius: ${Math.max(0, radius - gap)}px;
  padding: ${auraWidth}px;
  pointer-events: none;
  background: conic-gradient(from var(--hs-row-angle), ${auraRing});
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
  animation: hs-row-spin ${auraSpeed}s linear infinite;
}

/* 应用自带的「运行中」蓝弧会和流光重叠，开流光时让它退场 */
${SIDE} ${ROW}[data-working='true'] .arc-row {
  display: none !important;
}

`
    }

    css += `@keyframes hs-row-spin { to { --hs-row-angle: 360deg; } }
`
  }

  return css
}

/** 面板深浅：auto 时按字色亮度决定（浅字配深面） */
function resolveSurface(s) {
  if (s.surface === 'dark' || s.surface === 'light') {
    return s.surface
  }

  if (s.ink) {
    return luminance(s.ink) > 0.55 ? 'dark' : 'light'
  }

  return 'dark'
}

/* 每种面板配一套「读得清」的字色。文字色不是独立变量：样式表里
   --ui-base = var(--theme-foreground)，所有 --ui-text-* 都由它派生，
   所以只要面板变浅而字色还留着浅色，就成了白底白字（设置弹窗直接全白）。 */
const SAFE_TEXT = { dark: '#e6edf3', light: '#1f2328' }

/** 最终生效的字色：没设跟随面板默认；设了但和面板撞色（浅面配浅字），退回默认 */
function resolveInk(s, surface) {
  const fallback = SAFE_TEXT[surface] || SAFE_TEXT.dark
  const ink = String(s.ink || '').trim()

  if (!ink) {
    return { adjusted: false, color: fallback }
  }

  const value = luminance(ink)
  /* 浅面要深字（亮度低），深面要浅字（亮度高） */
  const clash = surface === 'light' ? value > 0.6 : value < 0.35

  return { adjusted: clash, color: clash ? fallback : ink }
}

/* ── CSS 生成 ───────────────────────────────────────────────────── */
function wantsPalette(s) {
  /* 有背景、或用户自己指定了字色/面板深浅 —— 这三件事任一件都要改颜色 */
  return (s.mode !== 'off' && !!s.path) || !!s.ink || s.surface !== 'auto'
}

function hasBackground(s) {
  return s.mode !== 'off' && !!s.path
}

/* 液态玻璃的设置行：气泡 / 输入框 / 会话三个目标共用同一套（只差前缀和文案）。
   prefix: glass=气泡、sessGlass=会话行（输入框已改用 Liquid Glass React 移植）*/
function glassRows(prefix, label, note, s, update) {
  const on = s[prefix + 'On'] === true || s[prefix + 'On'] === 'on'
  const slider = (suffix, min, max, step, text, description, title) =>
    jsx(ListRow, {
      action: jsxs('div', {
        className: 'flex w-full items-center gap-3',
        children: [
          jsx('input', {
            className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
            max,
            min,
            onChange: event => update({ [prefix + suffix]: Number(event.target.value) }),
            step,
            type: 'range',
            value: s[prefix + suffix]
          }),
          jsx('span', {
            className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
            children: text
          })
        ]
      }),
      description,
      title
    })

  const rows = [
    slider('Blur', 0, 40, 1, `${s[prefix + 'Blur']} px`, '玻璃的模糊程度：越大背后越糊；0 = 不模糊（只剩半透明）。静态玻璃用；选液态时改用固定的薄雾。', '玻璃模糊'),
    slider('Tint', 0, 100, 1, `${s[prefix + 'Tint']} %`, '玻璃底色（白色成分）：越大越亮、越像磨砂白瓷；越小越透亮。', '玻璃底色'),
    slider('Saturate', 1, 3, 0.1, `${Number(s[prefix + 'Saturate']).toFixed(1)}×`, '透过玻璃看到的背景颜色浓度。', '背景饱和度'),
    slider('Rim', 0, 100, 1, `${s[prefix + 'Rim']} %`, '边缘亮口 + 底部厚度的强弱；越高越有实体感。', '边缘高光'),
    slider('Radius', 0, 32, 1, `${s[prefix + 'Radius']} px`, '玻璃的圆角；0 = 保留原样（不覆盖已有的圆角设置）。', '玻璃圆角'),
    jsx(ListRow, {
      action: jsx(SegmentedControl, {
        onChange: id => update({ [prefix + 'Sheen']: id }),
        options: [
          { id: 'off', label: '关闭' },
          { id: 'on', label: '开启' }
        ],
        value: s[prefix + 'Sheen'] === 'on' ? 'on' : 'off'
      }),
      description: '一道很淡的高光在玻璃表面扫过 —— 「液态」的那点意思。',
      title: '液态扫光'
    }),
    slider('SheenSeconds', 3, 24, 1, `${s[prefix + 'SheenSeconds']} s`, '扫光走一趟要几秒；数字越大越慢、越不打扰。', '扫光周期')
  ]

  /* 每行标题带上**目标名**（气泡 / 助手气泡 / 会话 / 推理弹窗 / 模型弹窗），
     否则用户看不出这组设置属于哪个目标（用户报「这些都是哪的」）。
     只改标题、不动任何设置行。 */
  if (!label) return rows

  return rows.map(el => {
    const title = el && el.props ? el.props.title : null

    if (!title || title.startsWith(`${label} · `)) return el

    return Object.assign({}, el, { props: Object.assign({}, el.props, { title: `${label} · ${title}` }) })
  })
}

/**
 * 通用版 iOS 液态玻璃：同一套配方服务多个目标（气泡那处自己一套，因为它要把
 * 边缘光并进已有的 box-shadow 里；这两个目标没有这个包袱）。
 *
 * 坑记：输入框和会话行的伪元素都被占了（输入框 ::after 是光效环；会话行
 * ::before 是阴影、::after 是流光），所以扫光只能用 background-image 画；
 * 会话行开着浮动时元素本身已经有 animation，扫光不能再抢 animation 属性，
 * 那就退成静止的一道高光（sheenStatic）。
 */
/** 把「输入框那套玻璃」的值镜像到指定 key 上 —— 弹窗与输入框同步。
    圆角跟输入框的**有效圆角**走：开了液态玻璃就用它的圆角，否则用静态玻璃的圆角。 */
function glassMirror(s, key) {
  const map = {
    Blur: 'glassBlur',
    Rim: 'glassRim',
    Saturate: 'glassSaturate',
    Sheen: 'glassSheen',
    SheenSeconds: 'glassSheenSeconds',
    Tint: 'glassTint'
  }
  const out = Object.assign({}, s)

  out[key + 'On'] = s.glassOn === true
  out[key + 'Radius'] = s.lgxOn === true ? s.lgxRadius : s.glassRadius

  for (const suffix of Object.keys(map)) out[key + suffix] = s[map[suffix]]

  return out
}

function glassFor(s, key, selector, opts) {
  const o = opts || {}
  const isOn = value => value === true || value === 'on'
  const numOr = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback)
  const pct = value => Math.max(0, Math.min(100, Number(value) || 0)) / 100

  if (!isOn(s[key + 'On'])) return ''

  const blur = Math.max(0, Math.min(60, numOr(s[key + 'Blur'], 18)))
  const tint = pct(s[key + 'Tint'])
  const sat = Math.max(1, Math.min(3, numOr(s[key + 'Saturate'], 1.7)))
  const rim = pct(s[key + 'Rim'])
  const radius = Math.max(0, Math.min(32, numOr(s[key + 'Radius'], 18)))
  const sheen = isOn(s[key + 'Sheen'])
  const sheenSeconds = Math.max(3, Math.min(24, numOr(s[key + 'SheenSeconds'], 8)))
  const fill = `rgba(255, 255, 255, ${(tint * 0.36).toFixed(3)})`
  const border = `rgba(255, 255, 255, ${Math.min(0.5, 0.04 + 0.22 * rim).toFixed(3)})`
  const textShadow = typeof o.textShadowAlpha === 'number' ? o.textShadowAlpha : 0.2
  const decls = []

  if (o.fillVar) decls.push(`${o.fillVar}: ${fill} !important;`)

  decls.push(`background-color: ${fill} !important;`)

  if (radius > 0) decls.push(`border-radius: ${radius}px !important;`)

  if (o.border !== false) decls.push(`border-color: ${border} !important;`)

  decls.push(
    `-webkit-backdrop-filter: blur(${blur}px) saturate(${sat}) brightness(1.06) !important;`,
    `backdrop-filter: blur(${blur}px) saturate(${sat}) brightness(1.06) !important;`
  )

  if (textShadow > 0) decls.push(`text-shadow: 0 1px 1px rgba(0, 0, 0, ${textShadow}) !important;`)

  decls.push(`box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, ${(0.55 * rim).toFixed(3)}),
    inset 0 -2px 6px rgba(0, 0, 0, 0.1),
    inset 0 0 0 1px rgba(255, 255, 255, ${(0.12 * rim).toFixed(3)}),
    0 8px 22px rgba(0, 0, 0, 0.22) !important;`)

  let css = `
/* 液态玻璃（${o.label || key}）：半透明 + 背景折射 + 上亮口 / 下厚度 / 外圈细高光 / 柔和投影 */
${selector} {
  position: relative;
  ${decls.join('\n  ')}
}
`

  if (sheen) {
    const sheenA = Math.min(0.34, 0.06 + 0.2 * rim).toFixed(3)

    css += `
/* 扫光用 background-image（这两个目标的伪元素都已被占用，不能抢） */
${selector} {
  background-image: linear-gradient(112deg, rgba(255, 255, 255, 0) 32%, rgba(255, 255, 255, ${sheenA}) 46%, rgba(255, 255, 255, 0) 60%) !important;
  background-size: 260% 100% !important;
  background-repeat: no-repeat !important;${
    o.sheenStatic ? '\n  background-position: 38% 0 !important;' : ''
  }
}

@keyframes hs-glass-sheen-${key} {
  0% { background-position: 130% 0; }
  55%, 100% { background-position: -60% 0; }
}
`

    if (!o.sheenStatic) {
      css += `
${selector} {
  animation: hs-glass-sheen-${key} ${sheenSeconds}s ease-in-out infinite !important;
}
`
    }
  }

  return css
}

/**
 * 助手那一侧的气泡（Hermes 发给你的消息）—— 与用户侧完全分开的一套设置（aB* 前缀）。
 *
 * 为什么单独一份：用户要「两边分开设置」（用户侧自己一套、助手侧自己一套），
 * 发送动画、--dt-user-bubble 填充），这里只做助手侧，互不影响。
 *
 * 只挑「真装着内容」的正文容器（:has(*)）：只有工具调用、没有文字的消息，正文是空壳，
 * 套上边框和内边距会渲染成一条横线（用户报过「这一条横是什么」）。
 */
const A_MSG = "[data-slot='aui_assistant-message-content']:has(*)"

function assistantBubbleCss(s) {
  if (s.aBOn === false) return ''

  const isOn = value => value === true || value === 'on'
  const numOr = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback)
  const pct = value => Math.max(0, Math.min(100, Number(value) || 0)) / 100
  const lgxAssistR = lgxRadiusOf(s, 'aBubble')
  const radius = lgxAssistR !== null ? lgxAssistR : Math.max(0, Math.min(32, numOr(s.aBRadius, 14)))
  const lift = Math.max(0, Math.min(12, numOr(s.aBLift, 3)))
  const amp = Math.max(0, Math.min(10, numOr(s.aBAmp, 3)))
  const speed = Math.max(2, Math.min(14, numOr(s.aBSpeed, 8)))
  const strength = pct(s.aBShadow)
  const surface = resolveSurface(s)
  const neutral = surface === 'dark' ? 'rgba(255, 255, 255, 0.07)' : 'rgba(0, 0, 0, 0.045)'
  const inOn = isOn(s.aBInOn)
  const outOn = isOn(s.aBOutOn)
  const inColor = s.aBInColor || '#7ee7ff'
  const outColor = s.aBOutColor || '#4a84fe'
  const inA = pct(s.aBInStrength)
  const outA = pct(s.aBOutStrength)
  const inBlur = Math.max(0, Math.min(40, numOr(s.aBInBlur, 12)))
  const inWidth = Math.max(0.5, Math.min(8, numOr(s.aBInWidth, 2)))
  const outBlur = Math.max(0, Math.min(48, numOr(s.aBOutBlur, 16)))
  const rules = []

  /* 空壳中和：万一 :has(*) 也没兜住（例如只挂了个状态徽标），至少别留一条横线 */
  rules.push(`/* 空正文壳（只有工具调用那种）：不画气泡，免得成一条横线 */
[data-slot='aui_assistant-message-content']:not(:has(*)) {
  width: auto !important;
  padding: 0 !important;
  border: 0 !important;
  background-color: transparent !important;
  box-shadow: none !important;
}`)

  /* 气泡本体：靠左、按内容宽、留白；宽度放宽，代码块 / 表格 / 工具卡不被挤窄 */
  rules.push(`/* 助手消息气泡（靠左、按内容宽、留白） */
${A_MSG} {
  position: relative;
  width: fit-content !important;
  max-width: min(100%, 52rem) !important;
  margin-right: auto !important;
  padding: 0.6rem 0.9rem !important;
  border-radius: ${radius}px !important;
  /* ⚠️ 这个元素自带 overflow-hidden（应用的 className 里就有）。圆角 + overflow 会把**裁切范围
     变成圆角矩形** —— 像「已运行代码」这种贴着上边缘的细行，上边会被切掉一条
     （用户报「开完模糊最上边被遮住了」；圆角取值来自 lgxRadiusOf(s,'bubble')，
     开了气泡玻璃才有值，所以现象是「一开模糊就出现」）。
     画了圆角就必须放开裁切；里面的代码块 / 表格各自有 overflow-x-auto，不会漏出去。 */
  overflow: visible !important;
  background-color: ${neutral} !important;
  border: 1px solid rgba(255, 255, 255, ${surface === 'dark' ? '0.07' : '0.5'}) !important;
}`)

  /* 外层根容器自带 overflow-y: hidden（应用用来收横向溢出），而「漂浮」会把气泡往上移
     （lift + amp，默认 3 + 3 = 6px）→ **上边缘被父级裁掉**，用户报「最上边被遮住了 / 显示不全」。
     诊断实测：内容元素比它的父级高出 6px、父级 overflow-y 为 hidden —— 父级才是真正的裁切者
     （之前只放开内容元素自己的裁切，父级还在裁，所以现象没变）。 */
  rules.push(`/* 助手气泡：外层不要裁，否则漂浮上移的那几个像素会被切掉 */
[data-slot='aui_assistant-message-root'] {
  overflow: visible !important;
}`)

  /* 悬浮（按回合错开相位） */
  if (s.aBFloat) {
    rules.push(`${A_MSG} {
  translate: 0 -${lift}px;
  animation: hs-abob ${speed}s ease-in-out infinite;
  transition: scale .18s ease;
}

${A_MSG}:hover {
  scale: 1.015;
}

@keyframes hs-abob {
  0%, 100% { translate: 0 -${lift}px; }
  50% { translate: 0 -${(lift + amp).toFixed(2)}px; }
}`)

    if (s.aBStagger !== 'off') {
      rules.push(`/* 错开：按回合错开相位 */
[data-slot='aui_message-group']:nth-child(4n + 1) ${A_MSG} { animation-duration: ${speed.toFixed(2)}s; animation-delay: 0s; }
[data-slot='aui_message-group']:nth-child(4n + 2) ${A_MSG} { animation-duration: ${(speed * 1.13).toFixed(2)}s; animation-delay: -1.7s; }
[data-slot='aui_message-group']:nth-child(4n + 3) ${A_MSG} { animation-duration: ${(speed * 1.27).toFixed(2)}s; animation-delay: -3.1s; }
[data-slot='aui_message-group']:nth-child(4n + 4) ${A_MSG} { animation-duration: ${(speed * 1.41).toFixed(2)}s; animation-delay: -4.6s; }`)
    }
  }

  /* 阴影 / 内发光 / 外发光并成一条 box-shadow */
  const parts = []

  if (s.aBFloat && strength > 0) {
    parts.push(`0 ${Math.round(1 + lift * 0.5)}px ${Math.round(4 + lift * 2)}px rgba(0, 0, 0, ${(0.08 + strength * 0.4).toFixed(2)})`)
  }

  if (outOn) parts.push(`0 0 ${outBlur}px ${alphaColor(outColor, outA)}`)

  if (inOn) {
    parts.push(
      `inset 0 0 ${inBlur}px 0 ${alphaColor(inColor, inA * 0.55)}`,
      `inset 0 0 ${inWidth}px 0 ${alphaColor(inColor, Math.min(1, inA * 0.9))}`
    )
  }

  if (parts.length) {
    rules.push(`${A_MSG} { box-shadow: ${parts.join(', ')} !important; }`)
  }

  /* 外发光流动 */
  if (outOn && s.aBOutFlow === 'on') {
    const flowSpeed = Math.max(1, Math.min(20, numOr(s.aBOutSpeed, 4)))

    rules.push(`@property --hs-amsg-angle { syntax: '<angle>'; inherits: false; initial-value: 0deg; }

${A_MSG}::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 2;
  border-radius: inherit;
  padding: ${Math.max(1, Math.round((radius || 10) * 0.18))}px;
  pointer-events: none;
  background: conic-gradient(
    from var(--hs-amsg-angle),
    transparent 0deg,
    ${alphaColor(outColor, outA)} 70deg,
    transparent 150deg,
    transparent 180deg,
    ${alphaColor(outColor, outA)} 250deg,
    transparent 330deg
  );
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
  animation: hs-amsg-spin ${flowSpeed}s linear infinite;
}

@keyframes hs-amsg-spin { to { --hs-amsg-angle: 360deg; } }`)
  }

  return '\n' + rules.join('\n\n') + '\n'
}

/* ── iOS 液态玻璃的折射基础设施 ──────────────────────────────────────
   iOS 26 的 Liquid Glass 是「反射 + 折射 + 动态变形」的复合材质，
   不是单纯的毛玻璃。网页端能做到真折射的路子只有一条（Chromium 支持、
   Safari/Firefox 不支持，所以要 @supports 兜底）：
     backdrop-filter: url(#svg滤镜)  →  feImage 位移贴图 + feDisplacementMap
   参考 Apple WWDC25 与多篇网页实现（kube.io / webtricks.dev）。

   两个关键点：
   ① 位移贴图必须是「边缘渐变、中间中性」，折射才像透镜；
      用 feTurbulence 随机噪声会变成水波纹（那也是液态，但不是玻璃）。
      贴图用 canvas 现画：算出圆角矩形每点到边缘的距离，边缘处的 RGB
      偏离中性值 128 越多，位移越大 —— 红通道横向、绿通道纵向。
   ② 动态变形：给 feDisplacementMap 的 scale 挂一条 SMIL animate，
      折射强度轻微呼吸；鼠标悬停时换成「加强版滤镜」，像被按压。

   每个目标（气泡 / 输入框 / 会话 / 助手气泡）一张贴图 + 一个滤镜，
   强度各用各的设置；都不用时整个 <svg> 撤掉，不留开销。
   ─────────────────────────────────────────────────────────────────── */
/* ── 桌宠 ────────────────────────────────────────────────────────────
   素材是透明 VP9-Alpha 的 webm（实测 Chromium 里 alpha 正常：把它渲染在
   纯色背景上截图，83% 的像素是背景透出来的）。ffmpeg 读不出这种 alpha，
   所以别用 ffmpeg 转码。

   设计取舍：
   · 整个宠物层 pointer-events: none —— 宠物框（640×360）比角色本身大得多，
     让它吃鼠标会把下面的界面点不到。所以 v1 先做「活着」，不做拖拽点击。
   · 视频按 frame 原尺寸等比缩放（petSize = 视频宽度），角色大约占画面
     中间偏下一小块，脚底线就是视频底边 —— 放在窗口底部就是「站在地上」。
   · 宠物包从用户选的文件夹里自动分组：选中的目录下每个子目录 = 一个包，
     包里的 webm 就是它的动画池（和 dsh-pet 的 pet pack 一个思路）。
   ─────────────────────────────────────────────────────────────────── */
/* ── 插件自带的桌宠：大肥鱼（dsh-pet 素材包）────────────────────────
   素材本身放在本机那个目录里（51.8MB / 106 段 webm），插件把**清单内嵌**进来 ——
   插件没有列目录的能力（只有 getPathForFile），所以只能内嵌清单 + 启动时探测目录在不在。
   探测通了就当成一个内置包：用户不用再导入，装好就能用。 */
const BUILTIN_PET_ID = 'dsh-pet'
/* 路径两种写法都准备：正斜杠（Chromium 认）+ 反斜杠（用 fromCharCode 拼，避免转义踩坑） */
const BUILTIN_PET_DIR_FWD = '' /* 默认留空：别人机器上没有这个目录。用户在设置里选一次即可；缺了就是没有内置桌宠，不会报错 */
const BUILTIN_PET_DIR_ALT = ['D:', 'AI', 'Hermes agent', '主题插件', 'dsh-pet', 'webm'].join(String.fromCharCode(92))
let BUILTIN_PET_DIR = BUILTIN_PET_DIR_FWD
const petPathNorm = p => String(p || '').split(String.fromCharCode(92)).join('/').toLowerCase()

const BUILTIN_PET_CLIPS = ["三球抛接", "下五子棋", "东张西望", "中秋赏月吃月饼", "优雅女仆舞", "余额-分文不剩", "余额-数金皱眉", "余额-袋空如洗", "余额-金袋叮当", "余额-钱袋如常", "余额-钱袋满溢", "偷吃零食被抓住", "写代码", "写福字", "凭空生花", "动物环绕", "原地专心玩魔方", "原地小憩沉眠", "原地左转奔跑", "原地敲击桌面互动", "原地漂浮踏步", "原地跳跃抓碎头顶物品", "原地蹲下玩玩具汽车", "原地重力下蹲压缩", "变鸽子", "可爱宅舞", "吃Token", "吃冰淇淋融化", "吃午餐", "吃大闸蟹", "吃年糕", "吃早餐", "吃晚餐", "吃汤圆", "吃白饭", "吃粽子", "吃糖葫芦", "吃腊八粥", "吃西瓜", "吃重阳糕", "吃长寿面", "吃青团", "吃饺子", "吹气球", "吹笛子", "哈欠连天", "堆雪人", "大口吃零食", "女仆屈膝礼仪", "小幅度原地360度旋转展示", "小提琴演奏", "工作状态-原地踱步张望", "工作状态-垂头叹气冒汗", "工作状态-忙碌点按", "工作状态-思考冒泡", "工作状态-清点归档", "工作状态-雀跃庆祝", "待机呼吸休闲", "悠闲哼歌", "扑克魔术", "打瞌睡被惊醒", "抽陀螺", "拆礼物", "插茱萸赏菊", "摇扇纳凉", "撸猫", "收红包", "放孔明灯", "放河灯", "放烟花", "放风筝", "整体换装试色", "是啊，吃什么", "晨间刷牙", "涮火锅", "深度思考碎碎念", "点击回应-傲娇生气", "点击回应-元气挥手", "点击回应-害羞惊讶", "点击回应-开心跃动", "点击回应-挠痒咯咯笑", "照镜子", "玩水枪", "玩游戏气急败坏", "用鲸鱼尾巴拍打地面", "碎碎念-发呆碎碎念", "碎碎念-对屏碎碎念", "碎碎念-擦桌碎碎念", "穿针乞巧", "舞狮头", "荡秋千", "萌化小幽灵", "蓝鲸现世", "蝴蝶蜜蜂环绕头顶开花", "螃蟹走路", "被吓一跳", "被落叶淹没", "被鼠标拖拽悬空反馈", "装点圣诞树", "讨糖南瓜灯", "超大伸懒腰", "踢毽子", "轻快摇摆舞", "轻快记录", "骑木马", "鲸鱼吐泡泡特效"]
let builtinPetOk = null

async function builtinPetProbe() {
  if (builtinPetOk !== null) return builtinPetOk

  for (const dir of [BUILTIN_PET_DIR_FWD, BUILTIN_PET_DIR_ALT]) {
    try {
      const res = await fetch(mediaUrl(`${dir}/${BUILTIN_PET_CLIPS[0]}.webm`), { headers: { Range: 'bytes=0-1' } })

      if (res && (res.ok || res.status === 206)) {
        BUILTIN_PET_DIR = dir
        builtinPetOk = true

        break
      }
    } catch {
      /* 换下一种写法再试 */
    }
  }

  if (builtinPetOk !== true) builtinPetOk = false

  if (builtinPetOk) {
    const cur = $settings.get()
    const packs = cur.petPacks || []
    const same = packs.find(p => p && petPathNorm(p.dir) === petPathNorm(BUILTIN_PET_DIR))

    if (same) {
      /* 用户之前导入过同一个目录：标成内置、补上清单就行，不重复加一个包 */
      if (same.clips && same.clips.length) return builtinPetOk

      update({ petPacks: packs.map(p => (p === same ? { ...p, clips: BUILTIN_PET_CLIPS, builtin: true } : p)) })

      return builtinPetOk
    }

    update({ petPack: cur.petPack || BUILTIN_PET_ID, petPacks: [...packs, { id: BUILTIN_PET_ID, dir: BUILTIN_PET_DIR, clips: BUILTIN_PET_CLIPS, builtin: true }] })
  }

  return builtinPetOk
}

const PET_LAYER_ID = 'hermes-pet-layer'
const PET_VIDEO_ID = 'hermes-pet-video'
const petState = { clip: '', pack: '', lastAt: 0, paused: false, facing: 1, clipBeforeDrag: '' }

/* ── 桌宠·DeepSeek 余额 ──────────────────────────────────────────────
   官方接口 GET https://api.deepseek.com/user/balance + Authorization: Bearer <Key>，
   返回 { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }。
   实测：该接口允许浏览器直连（会把你的来源回在 access-control-allow-origin 里）。
   ⚠️ Key 只存本机插件存储：导出配置包时清空、导入时保留本机的，也不写日志。 */
const PET_BAL_PLATE_ID = 'hermes-pet-balance'
const $petBal = atom({ status: 'idle', text: '', total: NaN, level: '', at: 0 })
let petBalTimer = null
let petBalTimerMin = 0
let petBalLevel = ''
let petBalLevelAt = 0
let petBalShowUntil = 0
let petBalHideTimer = null

function petBalPlate() {
  return typeof document === 'undefined' ? null : document.getElementById(PET_BAL_PLATE_ID)
}

/** 取人民币那条（没有就第一条）；返回 { text, total } */
function petBalPick(json) {
  const list = json && Array.isArray(json.balance_infos) ? json.balance_infos : []
  const pick = list.find(x => String(x.currency || '').toUpperCase() === 'CNY') || list[0]

  if (!pick) return { text: json && json.is_available === false ? '不可用' : '', total: NaN }

  const cur = String(pick.currency || '').toUpperCase()
  const sym = cur === 'CNY' ? '¥' : cur === 'USD' ? '$' : `${cur} `
  const total = Number(pick.total_balance)

  return { text: `${sym}${Number.isFinite(total) ? total.toFixed(2) : String(pick.total_balance || '')}`, total }
}

async function petBalFetch(s, manual) {
  const key = String((s || $settings.get()).petBalKey || '').trim()

  if (!key) {
    $petBal.set({ status: 'nokey', text: '', total: NaN, level: '', at: Date.now() })

    if (manual) host.notify({ kind: 'error', message: '还没填 DeepSeek API Key（设置 → 桌宠 → 余额）。' })

    return
  }

  try {
    const res = await fetch('https://api.deepseek.com/user/balance', {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${key}` }
    })

    if (res.status === 401 || res.status === 403) {
      $petBal.set({ status: 'bad', text: 'Key 无效', total: NaN, level: '', at: Date.now() })

      if (manual) host.notify({ kind: 'error', message: 'DeepSeek 说这个 Key 无效。' })

      return
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const json = await res.json()
    const { text, total } = petBalPick(json)
    const low = Number((s || $settings.get()).petBalLow) || 0
    const high = Number((s || $settings.get()).petBalHigh) || 0
    const level = !Number.isFinite(total) ? '' : total < low ? 'low' : total >= high ? 'high' : 'mid'

    $petBal.set({ status: 'ok', text, total, level, at: Date.now() })

    if (manual) host.notify({ kind: 'info', message: `DeepSeek 余额 ${text}` })
  } catch (err) {
    $petBal.set({ status: 'err', text: '查不到', total: NaN, level: '', at: Date.now() })

    if (manual) host.notify({ kind: 'error', message: `查询失败：${String((err && err.message) || err)}` })
  }
}

/** 气泡里那句「话」（像桌宠在跟你说话） */
function petBalSpeech(s, v) {
  const hasKey = !!String(s.petBalKey || '').trim()

  if (!hasKey) return ''
  if (v.status === 'nokey') return '还没给我钥匙呢'
  if (v.status === 'bad') return '这把钥匙不对'
  if (v.status === 'err') return '我查不到余额…'
  if (!v.text) return '等一下，我数数…'
  if (v.level === 'low') return `快没钱啦 ${v.text}`
  if (v.level === 'high') return `还有 ${v.text}，够花`

  return `我这儿还有 ${v.text}`
}

/** 余额档位变了就播对应动作（偏低「袋空如洗」/ 充足「钱袋满溢」） */
function petBalApplyLevel(s, v) {
  try {
    if (s.petOn !== true || s.petBalOn === false) return

    if (s.petBalActionsOn === false) return

    if (v.status !== 'ok' || !v.level) return

    if (v.level === petBalLevel) return

    petBalLevel = v.level

    if (Date.now() - petBalLevelAt < 3000) return

    petBalLevelAt = Date.now()

    const want = v.level === 'low' ? '袋空如洗' : v.level === 'high' ? '钱袋满溢' : ''

    if (!want) return

    const pack = petPackOf(s)
    const clips = pack ? pack.clips : []
    const hit = clips.find(c => c.indexOf('余额-') === 0 && c.indexOf(want) >= 0) || clips.find(c => c.indexOf(want) >= 0)

    if (hit) playPetClip(s, hit)
  } catch {
    /* 播不了就算了，显示不受影响 */
  }
}

/** 冒一下气泡（默认 1 秒）——「捏」一下就走这条路 */
function petBalBubbleShow(s, ms) {
  petBalShowUntil = Date.now() + Math.max(400, Number(ms) || 1000)
  syncPetBalance(s)

  if (petBalHideTimer) clearTimeout(petBalHideTimer)

  petBalHideTimer = setTimeout(() => {
    petBalHideTimer = null
    syncPetBalance($settings.get())
  }, Math.max(400, Number(ms) || 1000) + 60)
}

/** 气泡 + 定时刷新（挂进 syncPet，随桌宠开/关一起起落） */
function syncPetBalance(s) {
  if (typeof document === 'undefined') return

  const layer = petLayer()
  const hasKey = !!String(s.petBalKey || '').trim()
  const on = s.petOn === true && s.petBalOn !== false && hasKey && !!layer
  let plate = petBalPlate()

  if (!on) {
    if (petBalTimer) {
      clearInterval(petBalTimer)
      petBalTimer = 0
      petBalTimerMin = 0
    }

    if (plate) plate.remove()

    return
  }

  if (!plate) {
    plate = document.createElement('div')
    plate.id = PET_BAL_PLATE_ID
    /* 桌宠的「说话气泡」：比牌子大、圆角大、带一个朝下的小尾巴 */
    plate.style.cssText = [
      'position:absolute',
      'left:50%',
      'bottom:100%',
      'transform:translate(-50%,-12px) scale(.9)',
      'transform-origin:50% 100%',
      'white-space:nowrap',
      'padding:8px 13px',
      'border-radius:16px',
      'font-size:14px',
      'line-height:1.5',
      'font-weight:600',
      'font-variant-numeric:tabular-nums',
      'letter-spacing:.01em',
      'color:var(--ui-text, #eef1f6)',
      'background:color-mix(in srgb, var(--ui-panel, #161a20) 84%, transparent)',
      'border:1px solid color-mix(in srgb, var(--ui-border, #ffffff) 30%, transparent)',
      'box-shadow:0 8px 22px rgba(0,0,0,.42)',
      'backdrop-filter:blur(8px)',
      'opacity:0',
      'transition:opacity .16s ease, transform .16s ease',
      'pointer-events:none'
    ].join(';')

    const tail = document.createElement('div')

    tail.setAttribute('data-pet-bal-tail', '1')
    tail.style.cssText = [
      'position:absolute',
      'left:50%',
      'top:100%',
      'width:12px',
      'height:12px',
      'margin-left:-6px',
      'margin-top:-7px',
      'transform:rotate(45deg)',
      'background:inherit',
      'border-right:1px solid color-mix(in srgb, var(--ui-border, #ffffff) 30%, transparent)',
      'border-bottom:1px solid color-mix(in srgb, var(--ui-border, #ffffff) 30%, transparent)',
      'border-bottom-right-radius:3px'
    ].join(';')
    plate.appendChild(tail)
    layer.appendChild(plate)
  }

  const v = $petBal.get()
  const speech = petBalSpeech(s, v)

  /* 文字单独一个 span：尾巴是 plate 的子元素，别被 textContent 冲掉 */
  let span = plate.querySelector('[data-pet-bal-text]')

  if (!span) {
    span = document.createElement('span')
    span.setAttribute('data-pet-bal-text', '1')
    plate.appendChild(span)
  }

  span.textContent = speech
  plate.style.color = v.status === 'ok' && v.level === 'low' ? '#ff9a9a' : v.status === 'ok' && v.level === 'high' ? '#93e8a3' : v.status === 'ok' ? 'var(--ui-text, #eef1f6)' : '#ffc178'

  /* 显示条件：常驻 或 刚捏过（默认 1 秒） */
  const visible = s.petBalAlways === true || Date.now() < petBalShowUntil

  plate.style.opacity = visible ? '1' : '0'
  plate.style.transform = visible ? 'translate(-50%,-12px) scale(1)' : 'translate(-50%,-8px) scale(.9)'

  const minutes = Math.max(1, Number(s.petBalMinutes) || 1)

  if (!petBalTimer || petBalTimerMin !== minutes) {
    if (petBalTimer) clearInterval(petBalTimer)

    petBalTimerMin = minutes
    petBalTimer = setInterval(() => void petBalFetch($settings.get()), minutes * 60000)
  }

  if (!v.at) void petBalFetch(s)
}

function petLayer() {
  return typeof document === 'undefined' ? null : document.getElementById(PET_LAYER_ID)
}

function petPackOf(s) {
  return (s.petPacks || []).find(pack => pack.id === s.petPack) || (s.petPacks || [])[0] || null
}

function petClipsOf(s) {
  const pack = petPackOf(s)

  if (!pack) return []

  const group = s.petGroup || 'all'

  if (group === 'all') return pack.clips

  const table = { life: '生活', react: '互动', balance: '余额', work: '工作' }
  const key = table[group]

  if (!key) return pack.clips

  /* 分组按名字粗分：没有权威分类表（npm 包里没带 config.jsonc），先按关键词 */
  const hit = pack.clips.filter(clip => {
    if (group === 'balance') return clip.startsWith('余额-')
    if (group === 'react') return clip.startsWith('被') || clip.includes('拖拽')
    if (group === 'work') return clip.startsWith('工作-') || clip.startsWith('状态-')
    return /吃|喝|玩|睡|懒腰|刷牙|跳舞|伸/.test(clip)
  })

  return hit.length ? hit : pack.clips
}

function playPetClip(s, clip) {
  const video = document.getElementById(PET_VIDEO_ID)
  const pack = petPackOf(s)

  if (!video || !pack || !clip) return

  petState.clip = clip
  petState.pack = pack.id
  petState.packDir = pack.dir
  petState.lastAt = Date.now()
  video.style.opacity = '0'

  const url = mediaUrl(`${pack.dir}/${clip}.webm`)

  if (video.getAttribute('src') !== url) video.setAttribute('src', url)

  const played = video.play?.()

  if (played && typeof played.catch === 'function') played.catch(() => {})

  setTimeout(() => {
    video.style.opacity = String(Math.max(0.05, Math.min(1, (Number(s.petOpacity) || 100) / 100)))
  }, 60)
}

function petNextClip(s, forward) {
  const clips = petClipsOf(s)

  if (!clips.length) return ''

  if (s.petMode === 'random') {
    const others = clips.filter(c => c !== petState.clip)

    return others.length ? others[Math.floor(Math.random() * others.length)] : clips[0]
  }

  const i = clips.indexOf(petState.clip)

  return clips[forward === false ? (i <= 0 ? clips.length - 1 : i - 1) : (i + 1) % clips.length]
}

const PET_CORNERS = {
  'bottom-right': { right: '0', bottom: '0' },
  'bottom-left': { left: '0', bottom: '0' },
  'top-right': { right: '0', top: '0' },
  'top-left': { left: '0', top: '0' }
}

function syncPet(s) {
  if (typeof document === 'undefined') return

  /* 只在主窗口里出现（宠物浮层/快捷输入窗没有 contrib shell） */
  if (!document.querySelector('[data-contrib-shell]')) return

  /* 余额小牌子（开关/间隔都由它自己管） */
  syncPetBalance(s)

  const on = s.petOn === true
  const pack = petPackOf(s)
  const clips = pack ? pack.clips : []
  let layer = petLayer()

  if (!on || !clips.length) {
    if (petHookTimer) {
      clearInterval(petHookTimer)
      petHookTimer = 0
    }

    if (layer) {
      const video = document.getElementById(PET_VIDEO_ID)

      try {
        video?.pause?.()
      } catch {
        /* 无所谓 */
      }

      layer.remove()
    }

    petState.clip = ''

    return
  }

  if (!layer) {
    layer = document.createElement('div')
    layer.id = PET_LAYER_ID
    layer.style.cssText = [
      'position:fixed',
      'z-index:2147483000',
      'pointer-events:none',
      'will-change:transform'
    ].join(';')

    const video = document.createElement('video')

    video.id = PET_VIDEO_ID
    video.muted = true
    video.autoplay = false
    video.playsInline = true
    video.style.cssText = ['display:block', 'background:transparent', 'transition:opacity .28s ease', 'filter:drop-shadow(0 6px 14px rgba(0,0,0,.35))'].join(';')
    video.addEventListener('ended', () => {
      /* 拖拽中不推进（拖拽姿势要停住）；暂停时也不推进 */
      if (petDrag.on || petState.paused) return

      const now = $settings.get()

      /* 工作联动：AI 还在干活就接着播工作动画，别落回普通轮播 */
      const st = petHookState()

      if (st.busy && petHookActive(now) && now.petWorkSync !== false) {
        const work = petWorkClip(now)

        if (work) {
          playPetClip(now, work)

          return
        }
      }

      playPetClip(now, petNextClip(now, true))
    })
    video.addEventListener('error', () => {
      /* 某一段素材坏了不该卡死整条链：跳下一支 */
      const now = $settings.get()

      setTimeout(() => playPetClip(now, petNextClip(now, true)), 200)
    })
    layer.appendChild(video)
    document.body.appendChild(layer)
  }

  const video = document.getElementById(PET_VIDEO_ID)
  const size = Math.max(120, Math.min(900, Number(s.petSize) || 560))
  const corner = PET_CORNERS[s.petCorner] || PET_CORNERS['bottom-right']
  const mx = Math.max(0, Math.min(400, Number(s.petMarginX) || 24))
  const my = Math.max(0, Math.min(400, Number(s.petMarginY) || 12))

  const freeX = Number.isFinite(Number(s.petX)) && s.petX !== null && s.petX !== ''
  const freeY = Number.isFinite(Number(s.petY)) && s.petY !== null && s.petY !== ''

  if (freeX && freeY) {
    /* 拖过 / 甩过 → 停在落点（右键菜单「回到初始位置」清掉它） */
    const bounds = petThrowBounds(s)

    petApplyPos(s, petClamp(Number(s.petX), bounds.minX, bounds.maxX), petClamp(Number(s.petY), bounds.minY, bounds.maxY))
  } else {
    layer.style.left = corner.left !== undefined ? `${mx}px` : 'auto'
    layer.style.right = corner.right !== undefined ? `${mx}px` : 'auto'
    layer.style.top = corner.top !== undefined ? `${my}px` : 'auto'
    layer.style.bottom = corner.bottom !== undefined ? `${my}px` : 'auto'
    petDrag.targetX = layer.getBoundingClientRect().left
    petDrag.targetY = layer.getBoundingClientRect().top
  }

  video.style.width = `${size}px`
  video.style.height = 'auto'
  video.style.opacity = String(Math.max(0.05, Math.min(1, (Number(s.petOpacity) || 100) / 100)))
  video.style.scale = `${petState.facing} 1`

  /* 换包 / 首次 → 起播；同一包内保持当前这一段。
     ⚠️ 必须同时比**目录**：包 id 是「webm 目录的父目录名」，同名 id 的两个包
     （或重新导入同名文件夹）会让 `petState.pack === pack.id` 成立 → 不重载 →
     画面上留着旧包的动画（用户报「更换宠物包有时会显示之前的宠物」）。
     目录是唯一的，比它才可靠。 */
  if (!petState.clip || petState.pack !== pack.id || petState.packDir !== pack.dir || !clips.includes(petState.clip)) {
    playPetClip(s, clips[0])
  }

  /* 命中区跟着走（只有它吃鼠标，其余位置点击穿透） */
  syncPetHit(s)

  /* 自动交互钩子的心跳（工作联动 / 闲置检测）——只在需要时跑，宠物关掉就停 */
  const wantHook = s.petInteract === true && (s.petWorkSync !== false || s.petIdle !== false)

  if (wantHook && !petHookTimer) {
    petHookTimer = setInterval(() => {
      try {
        const now = $settings.get()

        petSyncWork(now)
        petSyncIdle(now)
      } catch {
        /* 钩子出错绝不能连累外观（apply 那条铁律） */
      }
    }, 2500)
  } else if (!wantHook && petHookTimer) {
    clearInterval(petHookTimer)
    petHookTimer = 0
  }
}

/* 宠物包文件夹：跟音乐导入同一套（webkitdirectory + getPathForFile）——
   选中目录下每个子目录 = 一个包，包里的 webm 就是它的动画池。 */
function adoptPetFolder(files) {
  const byPack = new Map()
  let skipped = 0

  for (const file of files) {
    const name = file && file.name ? String(file.name) : ''

    if (!/\.webm$/i.test(name)) continue

    const path = window.hermesDesktop?.getPathForFile?.(file) || ''

    if (!path) {
      skipped += 1
      continue
    }

    const dir = path.replace(/[\\/][^\\/]*$/, '')
    const packId = dir.replace(/[\\/][^\\/]*$/, '').split(/[\\/]/).pop() || 'pet'
    const key = `${packId}|${dir}`

    if (!byPack.has(key)) byPack.set(key, { id: packId, dir, clips: [] })

    byPack.get(key).clips.push(name.replace(/\.webm$/i, ''))
  }

  const packs = [...byPack.values()].map(pack => ({
    ...pack,
    clips: pack.clips.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true }))
  }))

  /* 包 id 去重：id 取的是「webm 目录的父目录名」，不同位置的同名文件夹会撞车，
     撞车时 `petPackOf` 永远只认第一个 → 表现为「换了包还是旧宠物」。这里加序号后缀。 */
  const idCount = new Map()

  for (const pack of packs) {
    const n = (idCount.get(pack.id) || 0) + 1

    idCount.set(pack.id, n)

    if (n > 1) pack.id = `${pack.id}-${n}`
  }

  if (!packs.length) {
    host.notify({ kind: 'warn', message: '这个文件夹里没找到 .webm 动画。选到「宠物包」那一层（里面有 webm 子目录）再试。' })

    return
  }

  /* 选中谁：优先「这次新出现的包」（按目录比对），否则保留原来的选择，最后才退到第一个。
     原来写死 packs[0]（= 目录遍历里最先遇到的那个），重新导入整个父文件夹时会
     正好选回旧包 → 看起来像「换了包没反应」。 */
  const prev = $settings.get()
  const prevDirs = new Set((prev.petPacks || []).map(p => p.dir))
  const fresh = packs.find(p => !prevDirs.has(p.dir))
  const keep = packs.find(p => p.id === prev.petPack)
  const chosen = fresh || keep || packs[0]

  update({ petPacks: packs, petPack: chosen.id })
  host.notify({
    kind: 'info',
    message: `找到 ${packs.length} 个宠物包：${packs.map(p => `${p.id}（${p.clips.length} 段）`).join('、')}`
  })

  if (skipped) host.notify({ kind: 'warn', message: `有 ${skipped} 个文件拿不到路径，已跳过。` })
}

function pickPetFolder() {
  const input = document.createElement('input')

  input.type = 'file'
  input.multiple = true
  input.setAttribute('webkitdirectory', '')
  input.setAttribute('directory', '')
  input.onchange = () => adoptPetFolder(Array.from(input.files || []))
  input.click()
}

/* 桌宠设置行（模块级函数，跟 glassRows 同一个套路） */
/* 捏的声音：预设表（音调 % / 时长 ms）—— 用户自己挑一个 */
const SQUEAK_PRESETS = [
  ['经典捏', 100, 160],
  ['更尖', 160, 160],
  ['超尖', 200, 160],
  ['长捏', 100, 320],
  ['尖长', 180, 420],
  ['超尖长', 220, 520]
]

/* 桌宠·点击音效的设置行 */
function petSoundRows(s, update) {
  return [
    swRow(s, update, 'petClickSoundOn', '点击音效', '点桌宠时有一声「捏一下」的吱声。', '关', '开'),
    rangeRow(s, update, 'petClickSoundVolume', 0, 100, 5, `${s.petClickSoundVolume}%`, '吱声的音量。', '音量'),
    rangeRow(s, update, 'petClickSoundPitch', 60, 220, 5, `${s.petClickSoundPitch}%`, '吱声的音调，越大越尖。', '音调'),
    rangeRow(s, update, 'petClickSoundMs', 80, 600, 20, `${s.petClickSoundMs} ms`, '一声吱有多长，越长越像捏着不放。', '时长'),
    jsx(ListRow, {
      action: jsx('select', {
        className: 'h-8 rounded-md border border-(--ui-stroke-secondary) bg-transparent px-2 text-xs',
        onChange: event => {
          const hit = SQUEAK_PRESETS.find(x => x[0] === event.target.value)

          haptic('tap')

          if (!hit) {
            update({ petClickSoundPreset: '自定义' })

            return
          }

          update({ petClickSoundPreset: hit[0], petClickSoundPitch: hit[1], petClickSoundMs: hit[2] })
          /* 套用后立刻试听（等设置写进去再响） */
          setTimeout(() => petSqueak($settings.get()), 80)
        },
        value: SQUEAK_PRESETS.some(x => x[0] === s.petClickSoundPreset) ? s.petClickSoundPreset : '自定义',
        children: [
          ...SQUEAK_PRESETS.map(x => jsx('option', { value: x[0], children: x[0] }, x[0])),
          jsx('option', { value: '自定义', children: '自定义' }, '自定义')
        ]
      }),
      description: '挑一个捏的声音；选完会响一声给你听。',
      title: '音效'
    }),
    jsx(ListRow, {
      action: jsx(Button, { onClick: () => petSqueak($settings.get()), variant: 'default', children: '试听一下' }),
      description: '按现在的音量和音调响一声。',
      title: '试听'
    })
  ]
}

/* 桌宠·余额（DeepSeek）的设置行 */
function petBalanceRows(s, update) {
  const keyRow = jsx(ListRow, {
    action: jsxs('div', {
      className: 'flex w-full items-center gap-2',
      children: [
        jsx('input', {
          className: 'h-8 w-full min-w-0 rounded-md border border-(--ui-stroke-secondary) bg-transparent px-2 text-xs',
          onChange: event => update({ petBalKey: String(event.target.value || '').trim() }),
          placeholder: 'sk-…',
          spellCheck: false,
          type: 'password',
          value: s.petBalKey || ''
        }),
        jsx(Button, { onClick: () => void petBalFetch($settings.get(), true), variant: 'default', children: '立即查询' })
      ]
    }),
    description: '在 platform.deepseek.com 申请；只存本机，不会写进配置包。',
    title: 'API Key'
  })

  return [
    swRow(s, update, 'petBalOn', '余额气泡', '捏桌宠时在头顶冒一句余额。', '关', '开'),
    swRow(s, update, 'petBalAlways', '常驻显示', '一直挂着气泡，而不是只在捏的时候冒一下。', '只冒一下', '常驻'),
    keyRow,
    jsx(ListRow, {
      action: jsx(SegmentedControl, {
        onChange: id => update({ petBalMinutes: Number(id) }),
        options: [
          { id: '1', label: '1 分钟' },
          { id: '5', label: '5 分钟' },
          { id: '15', label: '15 分钟' },
          { id: '60', label: '1 小时' }
        ],
        value: String(s.petBalMinutes || 1)
      }),
      description: '多久问一次余额。',
      title: '刷新间隔'
    }),
    swRow(s, update, 'petBalActionsOn', '按余额播动作', '余额偏低播「袋空如洗」，充足播「钱袋满溢」。', '关', '开'),
    rangeRow(s, update, 'petBalLow', 0, 100, 1, `${s.petBalLow} 元`, '低于这个数算「偏低」。', '偏低阈值'),
    rangeRow(s, update, 'petBalHigh', 0, 1000, 10, `${s.petBalHigh} 元`, '高于这个数算「充足」。', '充足阈值')
  ]
}

function petRows(s) {
  const packs = s.petPacks || []
  const sizeRow = (key, min, max, text, description, title) =>
    jsx(ListRow, {
      action: jsxs('div', {
        className: 'flex w-full items-center gap-3',
        children: [
          jsx('input', {
            className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
            max,
            min,
            onChange: event => update({ [key]: Number(event.target.value) }),
            step: 1,
            type: 'range',
            value: s[key]
          }),
          jsx('span', {
            className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
            children: text
          })
        ]
      }),
      description,
      title
    })
  const rows = [
    jsx(ListRow, {
      action: jsx(SegmentedControl, {
        onChange: id => update({ petOn: id === 'on' }),
        options: [
          { id: 'off', label: '关闭' },
          { id: 'on', label: '开启' }
        ],
        value: s.petOn === true ? 'on' : 'off'
      }),
      description: '在窗口里养一只透明动画桌宠。',
      title: '桌宠'
    }),

    jsx(ListRow, {
      action: jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx('button', {
            className:
              'rounded-md border border-(--ui-border) px-2 py-1 text-xs text-(--ui-text-secondary) transition-colors hover:bg-(--ui-control-hover-background)',
            onClick: () => pickPetFolder(),
            type: 'button',
            children: '选择宠物包文件夹…'
          }),
          jsx('span', {
            className: 'text-xs text-(--ui-text-tertiary)',
            children: packs.length ? `已识别 ${packs.length} 个包` : '还没选'
          })
        ]
      }),
      description: '装宠物包的文件夹。',
      title: '宠物包文件夹'
    })
  ]

  if (packs.length) {
    rows.push(
      jsx(ListRow, {
        action: jsx(SegmentedControl, {
          onChange: id => update({ petPack: id }),
          options: packs.slice(0, 4).map(pack => ({ id: pack.id, label: pack.id })),
          value: petPackOf(s)?.id || packs[0].id
        }),
        description: `当前包里有 ${(petPackOf(s)?.clips || []).length} 段动画；以后多做几套包（比如小赫）就都放这个文件夹里。`,
        title: '宠物包'
      })
    )
  }

  rows.push(
    sizeRow('petSize', 160, 900, `${s.petSize} px`, '宠物画面的宽度。', '大小'),
    jsx(ListRow, {
      action: jsx(SegmentedControl, {
        onChange: id => update({ petCorner: id }),
        options: [
          { id: 'bottom-right', label: '右下' },
          { id: 'bottom-left', label: '左下' },
          { id: 'top-right', label: '右上' },
          { id: 'top-left', label: '左上' }
        ],
        value: s.petCorner || 'bottom-right'
      }),
      description: '宠物待在窗口的哪个角。',
      title: '位置'
    }),
    sizeRow('petMarginX', 0, 400, `${s.petMarginX} px`, '离左右边的距离。', '水平边距'),
    sizeRow('petMarginY', 0, 400, `${s.petMarginY} px`, '离上下的距离。', '垂直边距'),
    sizeRow('petOpacity', 20, 100, `${s.petOpacity} %`, '宠物的不透明度。', '不透明度'),
    jsx(ListRow, {
      action: jsx(SegmentedControl, {
        onChange: id => update({ petMode: id }),
        options: [
          { id: 'sequence', label: '顺序' },
          { id: 'random', label: '随机' }
        ],
        value: s.petMode === 'random' ? 'random' : 'sequence'
      }),
      description: '下一段动画怎么挑。',
      title: '播放方式'
    }),
    jsx(ListRow, {
      action: jsx(SegmentedControl, {
        onChange: id => update({ petGroup: id }),
        options: [
          { id: 'all', label: '全部' },
          { id: 'life', label: '生活' },
          { id: 'react', label: '互动' },
          { id: 'balance', label: '余额' }
        ],
        value: s.petGroup || 'all'
      }),
      description: '只播某一类动画。',
      title: '动画分组'
    }),
    jsx(ListRow, {
      action: jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx('button', {
            className:
              'rounded-md border border-(--ui-border) px-2 py-1 text-xs text-(--ui-text-secondary) transition-colors hover:bg-(--ui-control-hover-background)',
            onClick: () => {
              const now = $settings.get()

              if (!now.petOn) {
                host.notify({ kind: 'warn', message: '先把上面「桌宠」打开。' })

                return
              }

              playPetClip(now, petNextClip(now, true))
            },
            type: 'button',
            children: '下一支'
          }),
          jsx('button', {
            className:
              'rounded-md border border-(--ui-border) px-2 py-1 text-xs text-(--ui-text-secondary) transition-colors hover:bg-(--ui-control-hover-background)',
            onClick: () => {
              const now = $settings.get()

              playPetClip(now, petNextClip(now, false))
            },
            type: 'button',
            children: '上一支'
          }),
          jsx('span', {
            className: 'text-xs text-(--ui-text-tertiary)',
            children: petState.clip ? `正在播：${petState.clip}` : '未播放'
          })
        ]
      }),
      description: '手动切一段看看。',
      title: '手动切换'
    })
  )

  return rows
}

/* ── 桌宠交互（移植自 dsh-pet 原版）─────────────────────────────────
   为什么 v1 不能交互：整层 pointer-events:none —— 宠物框 640×360 比角色
   大得多，让它吃鼠标会把下面的界面点不到。原版的做法是「只有身体命中区可
   交互，其余透明像素点击穿透」（桌面模式靠 Electron setIgnoreMouseEvents）。
   纯 DOM 里的等价做法：命中区单独一个 div 吃鼠标（pointer-events:auto），
   其余位置一律穿透。

   命中区 HIT_BOX 是**素材原生坐标**里的矩形（原版 constants.ts）：
   {x0:200, y0:50, x1:440, y1:335}，按显示尺寸等比缩放。

   物理曲线逐条移植自原版 shared/physics.ts：
   弹簧跟手 K=200 / C=30（过阻尼，不抖不飘）、松手初速估算（200ms 轨迹窗、
   150ms 估速窗、峰值加权 0.5、软上限 3600px/s、死区 500px/s）、
   抛掷重力 1400 / 碰壁恢复 0.78 / 地面摩擦 2.5、Q 弹 220ms easeOutBack。
   ─────────────────────────────────────────────────────────────── */
const PET_HIT = { x0: 200, y0: 50, x1: 440, y1: 335 }
const PET_HIT_ID = 'hermes-pet-hit'
const PET_MENU_ID = 'hermes-pet-menu'

/* 原版常量（不要随手改，改了就换手感） */
const PET_K = 200
const PET_C = 30
const PET_TRAIL_KEEP_MS = 200
const PET_RELEASE_WINDOW_MS = 150
const PET_RELEASE_STALE_MS = 150
const PET_MIN_SPAN_MS = 20
const PET_DEAD_ZONE = 500
const PET_MAX_THROW = 3600
const PET_PEAK_WEIGHT = 0.5
const PET_SEG_MIN_DT_MS = 8
const PET_ACCEL_REF = 8000
const PET_ACCEL_GAIN_MAX = 0.6
const PET_REST_VY = 40
const PET_REST_VX = 15
const PET_MAX_STEP_DT = 0.05
const PET_SQ_MS = 220
const PET_SQ_SOFT = 300
const PET_SQ_HARD = 1500

const petDrag = { on: false, moved: false, trail: [], targetX: 0, targetY: 0, vx: 0, vy: 0, raf: 0, last: 0, flying: false, back: '' }

/* 自动交互钩子的心跳计时器（0 = 没在跑） */
let petHookTimer = 0
/* 「AI 正在干活」的判据：会话线程里的活动指示器（优先），其次侧栏会话行的 data-working */
const PET_BUSY_SEL = "[data-slot='aui_turn-activity'], [data-slot='aui_response-loading']"

const petNum = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
const petClamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)

/* 命中区（显示坐标，相对宠物框左上角） */
function petHitRect(video) {
  const scale = video && video.videoWidth ? video.getBoundingClientRect().width / video.videoWidth : 1

  return {
    left: PET_HIT.x0 * scale,
    top: PET_HIT.y0 * scale,
    width: (PET_HIT.x1 - PET_HIT.x0) * scale,
    height: (PET_HIT.y1 - PET_HIT.y0) * scale
  }
}

/* 命中区 div：跟着视频走，只有它吃鼠标 */
function syncPetHit(s) {
  const layer = petLayer()
  const video = document.getElementById(PET_VIDEO_ID)

  if (!layer || !video || s.petOn !== true) {
    const old = document.getElementById(PET_HIT_ID)

    if (old) old.remove()

    return
  }

  let hit = document.getElementById(PET_HIT_ID)

  if (!hit) {
    hit = document.createElement('div')
    hit.id = PET_HIT_ID
    hit.style.cssText = 'position:absolute;z-index:2;cursor:grab;touch-action:none;pointer-events:auto'
    /* 关键：应用在 window 捕获阶段监听 contextmenu 并 stopPropagation —— 冒泡阶段的
       监听器根本收不到（右键菜单一直不弹就是这个原因）。带上这个属性，应用的处理器
       会「提前返回」，不再拦截；我们自己的 contextmenu 才能正常触发。
       （属性名取自应用源码 components/ui/context-menu.tsx 的 HERMES_CONTEXT_MENU_TRIGGER_ATTR） */
    hit.setAttribute('data-hermes-context-menu-trigger', '')
    layer.appendChild(hit)
  }

  /* 监听器按「当前模块」重绑：插件重载不会清掉自己建的 DOM，只在创建时绑一次的话，
     元素上留着的是上一版模块的闭包（「拖它没反应」就是这么来的）。 */
  const bind = (type, fn) => {
    hit.__hsPet = hit.__hsPet || {}

    if (hit.__hsPet[type] === fn) return

    if (hit.__hsPet[type]) hit.removeEventListener(type, hit.__hsPet[type])

    hit.addEventListener(type, fn)
    hit.__hsPet[type] = fn
  }

  bind('pointerdown', event => petPointerDown(event, $settings.get()))
  bind('contextmenu', event => {
    event.preventDefault()
    petContextMenu(event, $settings.get())
  })
  bind('pointerenter', () => petHoverEnter($settings.get()))
  bind('pointerleave', () => petHoverLeave())

  const rect = petHitRect(video)
  const mode = s.petHitMode || 'body'
  let box = rect

  if (mode === 'handle') {
    /* 小把手：脚下一小块（怕挡界面时用） */
    const side = Math.max(48, rect.width * 0.32)

    box = { left: rect.left + (rect.width - side) / 2, top: rect.top + rect.height - side, width: side, height: side }
  } else if (mode === 'box') {
    const full = video.getBoundingClientRect()

    box = { left: 0, top: 0, width: full.width, height: full.height }
  }

  hit.style.left = `${box.left}px`
  hit.style.top = `${box.top}px`
  hit.style.width = `${box.width}px`
  hit.style.height = `${box.height}px`
  hit.style.display = s.petInteract === true ? 'block' : 'none'
}

/* ── Q 弹挤压（原版 squashScale：下压段 ease-in、回弹段 easeOutBack） ── */
function petSquashScale(u, squash) {
  if (u < 0.45) {
    const p = u / 0.45

    return 1 - (1 - squash) * p * p
  }

  const p = (u - 0.45) / 0.55
  const c1 = 1.70158
  const c3 = c1 + 1
  const f = 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2)

  return Math.min(1.12, squash + (1 - squash) * Math.max(f, 0))
}

function petLandingSquash(impactSpeed) {
  const t = petClamp((Math.abs(impactSpeed) - PET_SQ_SOFT) / (PET_SQ_HARD - PET_SQ_SOFT), 0, 1)

  return Math.min(0.8, 1 - t * (1 - 0.55))
}

function petSquash(squash, flip) {
  const video = document.getElementById(PET_VIDEO_ID)

  if (!video) return

  /* 令牌：新的一次 Q 弹作废旧循环。否则旧的循环会继续把 scale 往回写，
     或者被打断在「压扁」那一帧 —— 表现就是宠物一直扁着（用户报「会缩小」）。 */
  petDrag.squashToken = (petDrag.squashToken || 0) + 1

  const token = petDrag.squashToken
  const t0 = performance.now()
  const step = () => {
    if (token !== petDrag.squashToken) return

    const u = (performance.now() - t0) / PET_SQ_MS

    if (u >= 1) {
      video.style.scale = `${petState.facing || 1} 1`

      return
    }

    video.style.scale = `${petState.facing || 1} ${petSquashScale(u, squash).toFixed(4)}`
    requestAnimationFrame(step)
  }

  requestAnimationFrame(step)
}

/* 立刻取消 Q 弹、恢复原尺寸 */
function petResetScale() {
  petDrag.squashToken = (petDrag.squashToken || 0) + 1

  const video = document.getElementById(PET_VIDEO_ID)

  if (video) video.style.scale = `${petState.facing || 1} 1`
}

/* ── 拖拽轨迹 → 松手初速（原版 estimateReleaseVelocity） ── */
function petEstimateVelocity(trail, now, power) {
  if (!trail.length) return null

  const last = trail[trail.length - 1]

  if (now - last.t > PET_RELEASE_STALE_MS) return null

  const win = trail.filter(sample => now - sample.t <= PET_RELEASE_WINDOW_MS)

  if (win.length < 2) return null

  const t0 = win[0].t
  const x0 = win[0].x
  const y0 = win[0].y
  const span = win[win.length - 1].t - t0

  if (span < PET_MIN_SPAN_MS) return null

  const baseVx = ((win[win.length - 1].x - x0) / span) * 1000
  const baseVy = ((win[win.length - 1].y - y0) / span) * 1000
  const baseSpeed = Math.hypot(baseVx, baseVy)

  if (baseSpeed < 1e-6) return null

  /* 分段速度（过密采样向前合并，dt 下限 8ms：高回报率鼠标的 1ms dt 会把抖动放大成假峰值） */
  const segs = []
  let px = x0
  let py = y0
  let pt = t0

  for (const sample of win.slice(1)) {
    const dt = sample.t - pt

    if (dt >= PET_SEG_MIN_DT_MS) {
      segs.push({ speed: (Math.hypot(sample.x - px, sample.y - py) / dt) * 1000, tEnd: sample.t })
      px = sample.x
      py = sample.y
      pt = sample.t
    }
  }

  const peakSpeed = segs.length ? Math.max(...segs.map(v => v.speed)) : baseSpeed
  let accel = 0

  if (segs.length >= 2) {
    const lastSeg = segs[segs.length - 1]
    const firstSeg = segs[0]

    accel = (lastSeg.speed - firstSeg.speed) / Math.max((lastSeg.tEnd - firstSeg.tEnd) / 1000, PET_MIN_SPAN_MS / 1000)
  }

  /* 端点均值 + 窗口峰值加权；末段仍在加速则按 ACCEL_REF 比例增益（最多 +60%） */
  const before = ((1 - PET_PEAK_WEIGHT) * baseSpeed + PET_PEAK_WEIGHT * peakSpeed) *
    (1 + Math.min(Math.max(accel, 0) / PET_ACCEL_REF, 1) * PET_ACCEL_GAIN_MAX)
  const speed = PET_MAX_THROW * (1 - Math.exp(-before / PET_MAX_THROW)) * power

  /* 死区判在**软钳速之后**（相对力度一起缩放） */
  if (speed < PET_DEAD_ZONE) return null

  return { vx: (baseVx / baseSpeed) * speed, vy: (baseVy / baseSpeed) * speed }
}

/* ── 抛掷步进（原版 throwStep：重力 + 碰壁恢复 + 地面摩擦 + 静止判定） ── */
function petThrowBounds(s) {
  const size = petNum(s.petSize, 560)
  const h = (size * 9) / 16
  const side = 20

  return { minX: -side, minY: 0, maxX: window.innerWidth - size + side, maxY: window.innerHeight - h }
}

function petThrowStep(state, dtRaw, bounds, s) {
  const dt = Math.min(Math.max(dtRaw, 0), PET_MAX_STEP_DT)
  const gravity = petNum(s.petGravity, 1400)
  const rest = petClamp(petNum(s.petRestitution, 0.78), 0, 1)
  const friction = Math.max(0, petNum(s.petFriction, 2.5))

  let { x, y, vx, vy } = state
  let impact = 0

  vy += gravity * dt
  x += vx * dt
  y += vy * dt

  let bounced = false

  if (x < bounds.minX) {
    x = bounds.minX
    vx = Math.abs(vx) * rest
    bounced = true
  } else if (x > bounds.maxX) {
    x = bounds.maxX
    vx = -Math.abs(vx) * rest
    bounced = true
  }

  if (y < bounds.minY) {
    if (s.petCeiling !== false) {
      y = bounds.minY
      vy = Math.abs(vy) * rest
      bounced = true
    }
  } else if (y >= bounds.maxY) {
    y = bounds.maxY
    impact = Math.abs(vy)
    vx *= Math.max(0, 1 - friction * dt)

    if (Math.abs(vy) < PET_REST_VY) vy = 0
    else vy = -Math.abs(vy) * rest

    bounced = true
  }

  const speed = Math.hypot(vx, vy)
  const atRest =
    (y >= bounds.maxY - 1 && Math.abs(vy) < 1 && Math.abs(vx) < PET_REST_VX) ||
    (bounced && speed < PET_REST_VY && Math.abs(vy) < 1)

  return { x, y, vx, vy, impact, atRest }
}

/* 甩出去之后的飞行循环 */
function petFly(s, dt) {
  const bounds = petThrowBounds(s)
  const next = petThrowStep({ x: petDrag.posX, y: petDrag.posY, vx: petDrag.vx, vy: petDrag.vy }, dt, bounds, s)

  petDrag.vx = next.vx
  petDrag.vy = next.vy

  if (next.impact > 0) {
    const flip = petDrag.vx < 0 ? -1 : 1

    petSquash(petLandingSquash(next.impact), flip)
    petState.facing = flip

    /* 落地专用素材：撞得够重时播一段「落地-*」（2 秒节流，免得连跳刷屏） */
    if (s.petLandingClip !== false && petHookActive(s) && next.impact >= PET_SQ_SOFT) {
      const st = petHookState()

      if (performance.now() - st.lastLand > 2000) {
        const clip = petPickClip(s, /落地/)

        if (clip) {
          st.lastLand = performance.now()
          playPetClip(s, clip)
        }
      }
    }
  }

  petApplyPos(s, next.x, next.y)

  if (next.atRest) {
    petDrag.vx = 0
    petDrag.vy = 0
    playPetClip(s, petNextClip(s, true))
    /* 记住落点（右键「回到初始位置」清掉） */
    update({ petX: Math.round(next.x), petY: Math.round(next.y) })

    return false
  }

  return true
}

/* 位置落到层上；顺手记进设置（下次打开还在原地） */
/* 把当前位置写到层上。
   ⚠ 千万别在这里写 petDrag.targetX/Y —— 那是**弹簧的追赶目标**（由指针位置决定）。
   原来就是这里把目标覆盖成了当前位置，弹簧没有目标可追 → 宠物拖到一半就不动了
   （用户报「拖到右边会卡住」）。位置和目标必须是两套状态。 */
function petApplyPos(s, x, y) {
  const layer = petLayer()

  if (!layer) return

  layer.style.left = `${Math.round(x)}px`
  layer.style.top = `${Math.round(y)}px`
  layer.style.right = 'auto'
  layer.style.bottom = 'auto'
  petDrag.posX = x
  petDrag.posY = y
}

/* 弹簧单轴速度步进（原版 springStep；power = 总力度，K/C 同乘） */
function petSpringStep(v, x, target, dt, power) {
  return v + ((target - x) * PET_K - v * PET_C) * power * dt
}

/* ── 指针交互 ── */
function petPointerDown(event, s) {
  if (s.petInteract !== true || s.petDrag === false) return
  if (event.button !== 0) return

  const layer = petLayer()

  if (!layer) return

  event.preventDefault()
  event.stopPropagation()

  const rect = layer.getBoundingClientRect()

  const box = layer.getBoundingClientRect()

  petDrag.grabX = event.clientX - box.left
  petDrag.grabY = event.clientY - box.top
  petDrag.on = true
  petDrag.moved = false
  petDrag.flying = false
  petDrag.trail = []
  petDrag.targetX = rect.left
  petDrag.targetY = rect.top
  petDrag.vx = 0
  petDrag.vy = 0
  petDrag.posX = rect.left
  petDrag.posY = rect.top
  petDrag.targetX = rect.left
  petDrag.targetY = rect.top
  petDrag.sx = rect.left
  petDrag.sy = rect.top
  petDrag.svx = 0
  petDrag.svy = 0
  petDrag.last = performance.now()
  petDrag.flyToken = (petDrag.flyToken || 0) + 1
  petResetScale()
  petState.clipBeforeDrag = petState.clip

  /* 拖拽姿势推迟到「真的移动了」再播：单击不该闪一下「被抓起悬空」 */
  petDrag.dragClip = petPickClip(s, /拖拽|悬空/)

  try {
    event.target.setPointerCapture(event.pointerId)
  } catch {
    /* 捕获不到也不影响：move/up 挂在 window 上 */
  }

  rebindGlobal(window, 'pet', 'pointermove', petPointerMove, true)
  rebindGlobal(window, 'pet', 'pointerup', petPointerUp, true)
  rebindGlobal(window, 'pet', 'pointercancel', petPointerUp, true)
}

function petPointerMove(event) {
  const s = $settings.get()

  if (!petDrag.on) return

  if (!petDrag.moved) {
    petDrag.moved = true

    if (petDrag.dragClip) playPetClip(s, petDrag.dragClip)
  }

  petDrag.trail.push({ t: performance.now(), x: event.clientX, y: event.clientY })

  const keep = performance.now() - PET_TRAIL_KEEP_MS

  while (petDrag.trail.length && petDrag.trail[0].t < keep) petDrag.trail.shift()

  /* 目标 = 指针位置减去抓取点（以命中区中心为锚，手感最稳） */
  const video = document.getElementById(PET_VIDEO_ID)

  if (!video) return

  const box = video.getBoundingClientRect()

  /* 目标夹在窗口内：不然拖到右/下边缘会跑出可视区（看着像「缩小/消失」） */
  const size = petNum(s.petSize, 560)
  const boxH = (size * 9) / 16
  const slack = 24

  petDrag.targetX = petClamp(event.clientX - petDrag.grabX, -slack, Math.max(-slack, window.innerWidth - size + slack))
  petDrag.targetY = petClamp(event.clientY - petDrag.grabY, 0, Math.max(0, window.innerHeight - boxH + slack))
  void box

    /* 过阻尼弹簧跟手（原版 springStep，带速度状态）：v += ((target-x)*K - v*C)*power*dt，随后 x += v*dt */
  if (!petDrag.raf) {
    petDrag.last = performance.now()
    const spring = () => {
      const now = performance.now()
      const dt = Math.min(PET_MAX_STEP_DT, Math.max(0, (now - petDrag.last) / 1000))

      petDrag.last = now

      const power = petNum(s.petThrowPower, 1)

      petDrag.svx = petSpringStep(petDrag.svx, petDrag.sx, petDrag.targetX, dt, power)
      petDrag.svy = petSpringStep(petDrag.svy, petDrag.sy, petDrag.targetY, dt, power)
      petDrag.sx += petDrag.svx * dt
      petDrag.sy += petDrag.svy * dt

      const before = petDrag.sx

      petApplyPos(s, petDrag.sx, petDrag.sy)
      petFlip(petDrag.sx - before)

      petDrag.raf = petDrag.on ? requestAnimationFrame(spring) : 0
    }

    petDrag.raf = requestAnimationFrame(spring)
  }
}

function petPointerUp(event) {
  if (!petDrag.on) return

  const s = $settings.get()

  petDrag.on = false
  petDrag.raf = 0
  window.removeEventListener('pointermove', petPointerMove, true)
  window.removeEventListener('pointerup', petPointerUp, true)
  window.removeEventListener('pointercancel', petPointerUp, true)

  if (!petDrag.moved) {
    /* 单击：随机点击回应 + Q 弹（原版行为）。没换过动画，不必恢复。 */
    petTouch()

    /* 连点三下 → 挑「被点烦了」的回应；挑不到素材就退回普通点击回应 */
    petSqueak(s)

    /* 每捏一次：顺手刷一次余额，并在头顶冒 1 秒气泡（用户要求） */
    if (s.petBalOn !== false && String(s.petBalKey || '').trim()) {
      void petBalFetch(s)
      petBalBubbleShow(s, 1000)
    }

    if (!petClickStreak(s)) petClickReaction(s)

    return
  }

  /* 拖过 → 恢复拖之前的动画，再决定抛不抛 */
  if (petState.clipBeforeDrag) playPetClip(s, petState.clipBeforeDrag)

  const vel = petEstimateVelocity(petDrag.trail, performance.now(), petNum(s.petThrowPower, 1))

  if (vel) {
    petDrag.vx = vel.vx
    petDrag.vy = vel.vy
    petDrag.flying = true

    const myToken = (petDrag.flyToken = (petDrag.flyToken || 0) + 1)
    const fly = () => {
      if (myToken !== petDrag.flyToken) return

      const now = performance.now()
      const dt = Math.min(PET_MAX_STEP_DT, Math.max(0.001, (now - petDrag.last) / 1000))

      petDrag.last = now

      const alive = petFly(s, dt)

      if (alive) requestAnimationFrame(fly)
      else {
        petDrag.vx = 0
        petDrag.vy = 0
        petDrag.flying = false
      }
    }

    petDrag.last = performance.now()
    requestAnimationFrame(fly)
  }
}

/* 朝向：往左移动时镜像 */
function petFlip(dx) {
  const video = document.getElementById(PET_VIDEO_ID)

  if (!video || Math.abs(dx) < 0.4) return

  petState.facing = dx < 0 ? -1 : 1
  video.style.scale = `${petState.facing} 1`
}

/* 从包里挑一个匹配的动画（正则），挑不到就返回 '' */
function petPickClip(s, re) {
  const pack = petPackOf(s)
  const clips = (pack && pack.clips) || []
  const hit = clips.filter(name => re.test(name))

  if (!hit.length) return ''

  return hit[Math.floor(Math.random() * hit.length)]
}

/* ── 自动交互钩子（工作联动 / 连击 / 悬停 / 闲置 / 落地）─────────────
   全部由「交互」总开关管；素材挑不到就静默不播（做成通用钩子，换任何宠物包都能用）。
   状态挂在 petState.hooks 上（懒建，避免动 petState 的初始形状）。 */
function petHookState() {
  if (!petState.hooks) {
    petState.hooks = { busy: false, lastLand: 0, streak: [], hoverTimer: 0, lastIdle: 0, touched: Date.now() }
  }

  return petState.hooks
}

function petHookActive(s) {
  return s && s.petOn === true && s.petInteract === true
}

/* 判据要「真实可见性」：应用不少组件常驻 DOM（靠 sr-only 藏起来），
   只看 querySelector 命中会把隐藏的也算成在干活。 */
function petVisible(el) {
  if (!el) return false

  const r = el.getBoundingClientRect()

  if (r.width < 4 || r.height < 4) return false

  const st = getComputedStyle(el)

  return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity || 1) >= 0.05
}

function petBusy() {
  if (typeof document === 'undefined') return false

  for (const el of document.querySelectorAll(PET_BUSY_SEL)) if (petVisible(el)) return true

  for (const row of document.querySelectorAll("[data-working='true']")) if (petVisible(row)) return true

  return false
}

function petWorkClip(s) {
  return petPickClip(s, /工作|状态-|码字|写/)
}

/* 工作联动：忙 → 播工作动画（播完还忙就再挑一段）；忙完 → 回到正常轮播 */
function petSyncWork(s) {
  const st = petHookState()

  if (!petHookActive(s) || s.petWorkSync === false) {
    st.busy = false

    return
  }

  const busy = petBusy()

  if (busy === st.busy) return

  st.busy = busy

  if (busy) {
    const clip = petWorkClip(s)

    if (clip) playPetClip(s, clip)
  } else {
    playPetClip(s, petNextClip(s, true))
  }
}

/* 闲置：多久没有任何交互 → 播一段「睡着/打盹」的动画 */
function petSyncIdle(s) {
  const st = petHookState()

  if (!petHookActive(s) || s.petIdle === false) return

  const mins = petNum(s.petIdleMin, 10)

  if (!(mins > 0)) return

  if (Date.now() - st.touched < mins * 60000) return

  if (Date.now() - st.lastIdle < 60000) return

  const clip = petPickClip(s, /睡|打盹|哈欠|沉眠/)

  if (clip) {
    st.lastIdle = Date.now()
    playPetClip(s, clip)
  }
}

function petTouch() {
  petHookState().touched = Date.now()
}

/* 连击：1.2 秒内点到第三下 → 挑「被点烦了」的回应 */
function petClickStreak(s) {
  const st = petHookState()
  const now = Date.now()

  st.streak = st.streak.filter(t => now - t < 1200)
  st.streak.push(now)

  if (s.petStreak === false || st.streak.length < 3) return false

  st.streak = []

  const clip = petPickClip(s, /生气|傲娇|抓狂|头晕|烦/)

  if (!clip) return false

  playPetClip(s, clip)

  if (s.petSquash !== false) petSquash(0.4, petState.facing || 1)

  return true
}

/* 悬停：鼠标停在身上 1.2 秒 → 抬头 / 被摸头 */
function petHoverEnter(s) {
  const st = petHookState()

  petTouch()
  clearTimeout(st.hoverTimer)

  if (!petHookActive(s) || s.petHover === false) return

  st.hoverTimer = setTimeout(() => {
    const now = $settings.get()

    if (!petHookActive(now)) return

    const clip = petPickClip(now, /摸头|抬头|惊|看/)

    if (clip) playPetClip(now, clip)
  }, 1200)
}

function petHoverLeave() {
  const st = petHookState()

  clearTimeout(st.hoverTimer)
  petTouch()
}

/* ── 桌宠·点击音效（现场合成，不需要任何素材）─────────────────────────
   玩具鸭那种「吱」= 很短的一声：音调先快速窜上去、再滑下来 + 迅速衰减。
   用 WebAudio 现做（AudioContext 等到第一次点击才建 —— 有用户手势才不会被自动播放策略拦）。
   ⚠️ 素材包 dsh-pet 里没有任何音频（106 段全是 webm，原项目仓库里也没有），
   所以这里合成，而不是去播文件。 */
let petSqueakCtx = null

function petSqueak(s) {
  try {
    if (!s || s.petClickSoundOn === false) return

    const vol = Math.max(0, Math.min(100, Number(s.petClickSoundVolume))) / 100

    if (vol <= 0) return

    const AC = window.AudioContext || window.webkitAudioContext

    if (!AC) return

    if (!petSqueakCtx) petSqueakCtx = new AC()

    const ctx = petSqueakCtx

    if (ctx.state === 'suspended') void ctx.resume()

    const t0 = ctx.currentTime
    const pitch = Math.max(0.5, Math.min(2.4, (Number(s.petClickSoundPitch) || 100) / 100))
    /* 时长：下限 80ms、上限 700ms（越长越像「捏着不放」） */
    const dur = Math.max(0.08, Math.min(0.7, (Number(s.petClickSoundMs) || 160) / 1000))
    const lp = ctx.createBiquadFilter()

    lp.type = 'lowpass'
    lp.frequency.value = 4200
    lp.Q.value = 0.6

    const gain = ctx.createGain()

    gain.gain.setValueAtTime(0, t0)
    gain.gain.linearRampToValueAtTime(0.5 * vol, t0 + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0008, t0 + dur)
    lp.connect(gain)
    gain.connect(ctx.destination)

    /* 主音：700 → 1900（约 28ms 窜上去）→ 480（像捏扁了再松手） */
    const osc = ctx.createOscillator()
    const f = osc.frequency

    osc.type = 'triangle'
    f.setValueAtTime(700 * pitch, t0)
    f.exponentialRampToValueAtTime(1900 * pitch, t0 + 0.028)
    f.exponentialRampToValueAtTime(480 * pitch, t0 + dur)
    osc.connect(lp)
    osc.start(t0)
    osc.stop(t0 + dur + 0.02)

    /* 第二层：高一点、短一点，加一点橡胶味 */
    const osc2 = ctx.createOscillator()
    const f2 = osc2.frequency

    osc2.type = 'sine'
    f2.setValueAtTime(1150 * pitch, t0)
    f2.exponentialRampToValueAtTime(2600 * pitch, t0 + 0.02)
    f2.exponentialRampToValueAtTime(900 * pitch, t0 + dur * 0.7)

    const g2 = ctx.createGain()

    g2.gain.setValueAtTime(0, t0)
    g2.gain.linearRampToValueAtTime(0.18 * vol, t0 + 0.01)
    g2.gain.exponentialRampToValueAtTime(0.0006, t0 + dur * 0.8)
    osc2.connect(g2)
    g2.connect(lp)
    osc2.start(t0)
    osc2.stop(t0 + dur)
  } catch {
    /* 出不了声也不能影响点击反应 */
  }
}

function petClickReaction(s) {
  const clip = petPickClip(s, /点击回应/)

  if (clip) playPetClip(s, clip)

  if (s.petSquash !== false) petSquash(0.55, petState.facing || 1)
}

/* ── 右键菜单（回到初始位置 / 播放动作 / 暂停 / 隐藏） ── */
function petContextMenu(event, s) {
  if (s.petInteract !== true || s.petMenu === false) return

  event.preventDefault()
  event.stopPropagation()

  const old = document.getElementById(PET_MENU_ID)

  if (old) old.remove()

  const menu = document.createElement('div')

  menu.id = PET_MENU_ID
  menu.style.cssText = [
    'position:fixed',
    `left:${event.clientX}px`,
    `top:${event.clientY}px`,
    'z-index:2147483000',
    'min-width:9.5rem',
    'max-height:60vh',
    'overflow:auto',
    'padding:0.3rem',
    'border-radius:0.6rem',
    'border:1px solid var(--ui-border, rgba(255,255,255,.18))',
    'background:var(--ui-panel, rgba(24,26,32,.96))',
    'color:var(--ui-text, #e8e8ec)',
    'font-size:0.75rem',
    'box-shadow:0 10px 30px rgba(0,0,0,.35)',
    'backdrop-filter:blur(8px)'
  ].join(';')

  const item = (label, run) => {
    const el = document.createElement('div')

    el.textContent = label
    el.style.cssText = 'padding:0.34rem 0.55rem;border-radius:0.4rem;cursor:pointer;white-space:nowrap'
    el.addEventListener('pointerenter', () => {
      el.style.background = 'var(--ui-accent, rgba(120,160,255,.25))'
    })
    el.addEventListener('pointerleave', () => {
      el.style.background = 'transparent'
    })
    el.addEventListener('click', () => {
      menu.remove()
      run()
    })
    menu.appendChild(el)
  }

  const head = (label) => {
    const el = document.createElement('div')

    el.textContent = label
    el.style.cssText = 'padding:0.34rem 0.55rem 0.18rem;opacity:.55;font-size:0.68rem'
    menu.appendChild(el)
  }

  const pack = petPackOf(s)
  const clips = (pack && pack.clips) || []

  item('↺ 回到初始位置', () => petResetPosition(s))

  if (clips.length) {
    head(`播放动作（共 ${clips.length} 段）`)
    /* ⚠️ 原来只列前 60 段 → 排序靠后的动作（例如「余额-」那 6 段排第 88~93）
       在菜单里根本不存在，用户以为功能坏了（报「大肥鲨余额功能不能用」）。
       现在全列出来，并按组分小标题，长菜单本来就能滚（max-height:60vh + overflow:auto）。 */
    const groups = [
      ['互动', c => c.startsWith('被') || c.includes('拖拽')],
      ['工作', c => c.startsWith('工作-') || c.startsWith('状态-')],
      ['余额', c => c.startsWith('余额-')],
      ['生活', c => /吃|喝|玩|睡|懒腰|刷牙|跳舞|伸/.test(c)]
    ]
    const used = new Set()

    for (const [label, test] of groups) {
      const hit = clips.filter(c => !used.has(c) && test(c))

      if (!hit.length) continue

      head(label)

      for (const name of hit) {
        used.add(name)
        item(`　${name}`, () => playPetClip(s, name))
      }
    }

    const rest = clips.filter(c => !used.has(c))

    if (rest.length) {
      head('其它')

      for (const name of rest) item(`　${name}`, () => playPetClip(s, name))
    }
  }

  item(petState.paused ? '▶ 继续随机动画' : '⏸ 暂停随机动画', () => {
    petState.paused = !petState.paused
    const v = document.getElementById(PET_VIDEO_ID)

    try {
      if (petState.paused) v?.pause?.()
      else v?.play?.()
    } catch {
      /* 无所谓 */
    }
  })
  item('🎲 换一个动画', () => playPetClip(s, petNextClip(s, true)))
  item('👻 隐藏桌宠', () => update({ petOn: false }))

  document.body.appendChild(menu)

  const close = e => {
    if (!menu.contains(e.target)) {
      menu.remove()
      document.removeEventListener('pointerdown', close, true)
    }
  }

  setTimeout(() => document.addEventListener('pointerdown', close, true), 0)
}

function petResetPosition(s) {
  update({ petX: null, petY: null })
}

/* 桌宠交互的设置行（移植自 dsh-pet 原版） */
function petInteractRows(s) {
  const rng = (key, min, max, step, text, description, title) =>
    jsx(ListRow, {
      action: jsxs('div', {
        className: 'flex w-full items-center gap-3',
        children: [
          jsx('input', {
            className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
            max,
            min,
            onChange: event => update({ [key]: Number(event.target.value) }),
            step,
            type: 'range',
            value: s[key]
          }),
          jsx('span', {
            className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
            children: text
          })
        ]
      }),
      description,
      title
    })

  return [
    jsx(ListRow, {
      action: jsx(SegmentedControl, {
        onChange: id => update({ petInteract: id === 'on' }),
        options: [
          { id: 'off', label: '不响应' },
          { id: 'on', label: '可交互' }
        ],
        value: s.petInteract === true ? 'on' : 'off'
      }),
      description: '让宠物能点、能拖、能右键。',
      title: '交互'
    }),

    jsx(ListRow, {
      action: jsx(SegmentedControl, {
        onChange: id => update({ petHitMode: id }),
        options: [
          { id: 'body', label: '身体' },
          { id: 'handle', label: '小把手' },
          { id: 'box', label: '整框' }
        ],
        value: s.petHitMode || 'body'
      }),
      description: '宠物吃鼠标的范围。',
      title: '交互范围'
    }),

    jsx(ListRow, {
      action: jsx(SegmentedControl, {
        onChange: id => update({ petDrag: id === 'on' }),
        options: [
          { id: 'off', label: '只能点' },
          { id: 'on', label: '可拖拽' }
        ],
        value: s.petDrag === false ? 'off' : 'on'
      }),
      description: '能不能拖着走。',
      title: '拖拽'
    }),

    jsx(ListRow, {
      action: jsx(SegmentedControl, {
        onChange: id => update({ petSquash: id === 'on' }),
        options: [
          { id: 'off', label: '不弹' },
          { id: 'on', label: 'Q 弹' }
        ],
        value: s.petSquash === false ? 'off' : 'on'
      }),
      description: '点击时有 Q 弹效果。',
      title: '点击 Q 弹'
    }),

    jsx(ListRow, {
      action: jsx(SegmentedControl, {
        onChange: id => update({ petMenu: id === 'on' }),
        options: [
          { id: 'off', label: '关闭' },
          { id: 'on', label: '开启' }
        ],
        value: s.petMenu === false ? 'off' : 'on'
      }),
      description: '右键宠物弹出操作菜单。',
      title: '右键菜单'
    }),

    jsx(ListRow, {
      action: jsx(SegmentedControl, {
        onChange: id => update({ petWorkSync: id === 'on' }),
        options: [
          { id: 'off', label: '关闭' },
          { id: 'on', label: '开启' }
        ],
        value: s.petWorkSync === false ? 'off' : 'on'
      }),
      description:
        '我回复时自动切工作动画。',
      title: '工作联动'
    }),

    jsx(ListRow, {
      action: jsx(SegmentedControl, {
        onChange: id => update({ petStreak: id === 'on' }),
        options: [
          { id: 'off', label: '关闭' },
          { id: 'on', label: '开启' }
        ],
        value: s.petStreak === false ? 'off' : 'on'
      }),
      description: '连点三下触发被点烦的回应。',
      title: '连击回应'
    }),

    jsx(ListRow, {
      action: jsx(SegmentedControl, {
        onChange: id => update({ petHover: id === 'on' }),
        options: [
          { id: 'off', label: '关闭' },
          { id: 'on', label: '开启' }
        ],
        value: s.petHover === false ? 'off' : 'on'
      }),
      description: '鼠标停住时播摸头回应。',
      title: '悬停反应'
    }),

    jsx(ListRow, {
      action: jsx(SegmentedControl, {
        onChange: id => update({ petIdle: id === 'on' }),
        options: [
          { id: 'off', label: '关闭' },
          { id: 'on', label: '开启' }
        ],
        value: s.petIdle === false ? 'off' : 'on'
      }),
      description: '没人动它就播打盹动画。',
      title: '闲置打盹'
    }),

    rng('petIdleMin', 1, 60, 1, `${s.petIdleMin} 分钟`, '闲置多久开始打盹。', '闲置时长'),

    jsx(ListRow, {
      action: jsx(SegmentedControl, {
        onChange: id => update({ petLandingClip: id === 'on' }),
        options: [
          { id: 'off', label: '关闭' },
          { id: 'on', label: '开启' }
        ],
        value: s.petLandingClip === false ? 'off' : 'on'
      }),
      description: '落地时播专用落地素材。',
      title: '落地专用素材'
    }),


    rng('petThrowPower', 0.2, 2, 0.1, `${Number(s.petThrowPower).toFixed(1)}×`, '甩出去的力度。', '甩抛力度'),
    rng('petGravity', 0, 3000, 50, `${s.petGravity}`, '下落的重力。', '重力'),
    rng('petRestitution', 0, 1, 0.01, `${Number(s.petRestitution).toFixed(2)}`, '碰边缘反弹的弹性。', '弹性'),
    rng('petFriction', 0, 8, 0.1, `${Number(s.petFriction).toFixed(1)}`, '落地后的水平摩擦。', '地面摩擦')
  ]
}

/* ── 思考方块：彩色流光（直接改造原生那个 12px 方块，不用浮层）──────
   原生方块 = `.dither`：12px 棋盘格，样式是
   `repeating-conic-gradient(currentColor 0% 25%, transparent 0% 50%) 0 0 / 0.125rem 0.125rem`
   —— 注意是 **background-image**（只清 background-color 没用），而且简写留下了
   `background-size: 0.125rem`（不重置的话，我们的渐变会被缩成 2px 平铺成噪点）。

   `.dither` 全应用 5 处，其中 3 处是「解码光标」不能动 → 选择器只命中思考那两个槽位。

   动画一律**长写属性 + !important**：应用有一条全局
   `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important } }`，
   简写压不过它（系统一关动画效果，流光就停住）。
   ─────────────────────────────────────────────────────────────── */
const THINK_SQ = "[data-slot='aui_turn-activity'] .dither, [data-slot='aui_response-loading'] .dither"

/* 预设：首尾同色，循环才不跳 */
const FLOW_PRESETS = {
  rainbow: { label: '彩虹', stops: ['#ff2d55', '#ffd60a', '#ffffff', '#00e676', '#00c2ff', '#b06ab3', '#ff2d55'], glow: '#ff7ac6' },
  aurora: { label: '极光', stops: ['#00ffd0', '#ffffff', '#00bbf9', '#7b2ff7', '#00ffd0'], glow: '#4cc9f0' },
  sunset: { label: '日落', stops: ['#ffb703', '#ffffff', '#ff2d55', '#7b2ff7', '#ffb703'], glow: '#ff6b81' },
  neon: { label: '霓虹', stops: ['#ff006e', '#ffffff', '#00e5ff', '#ff006e'], glow: '#f72585' },
  ocean: { label: '青蓝', stops: ['#2d7bff', '#ffffff', '#00e5ff', '#00e676', '#2d7bff'], glow: '#4a84fe' },
  candy: { label: '糖果', stops: ['#ff7ac6', '#ffffff', '#ffd166', '#8ce99a', '#ff7ac6'], glow: '#ff7ac6' }
}

/* 文字也流光：方块后面那个「5s」计时 / 「Running」这类状态字。
   做法是渐变文字：background-image 渐变 + background-clip: text + 字色透明，
   再把同一个 hs-flow-move 动画挂上去。`:not(.dither)` 是防止把方块自己也套进来。 */
const THINK_SQ_TEXT = "[data-slot='aui_turn-activity'] :not(.dither), [data-slot='aui_response-loading'] :not(.dither)"

function flowCss(s) {
  const wantSquare = s.flowOn === true
  const wantText = wantSquare && s.flowText === true
  /* 「运行状态条」（工具行「正在运行 …」/状态条行）也套同一套文字流光 —— 用户点名要求。
     开关独立（runFlowOn），因为那是另一个地方；配色/强度/速度仍共用思考方块那套。 */
  const wantRunText = s.runFlowOn === true && s.flowText === true

  if (!wantSquare && !wantRunText) return ''

  const preset = FLOW_PRESETS[s.flowPreset] || FLOW_PRESETS.rainbow
  const numOr = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback)
  const speed = Math.max(0.2, Math.min(4, numOr(s.flowSpeed, 1)))
  const glow = Math.max(0, Math.min(100, numOr(s.flowGlow, 70)))
  const radius = Math.max(0, Math.min(10, numOr(s.flowRadius, 3)))
  const scale = Math.max(0.6, Math.min(2, numOr(s.flowScale, 1)))
  const power = Math.max(0, Math.min(100, numOr(s.flowIntensity, 60))) / 100
  const seconds = (3.2 / speed).toFixed(2)
  const textSeconds = (4.4 / speed).toFixed(2)
  const stops = preset.stops.join(', ')

  /* ── 斜向流动（用户要求：色带要斜的，不要竖着横滑）──────────────────────────
     做法：用 repeating-linear-gradient（自平铺 → 永远不会有拼接缝），
     位移动画沿**色带法线**走（115° 的轴向单位向量 ≈ (0.906, 0.423)），
     一个循环正好位移「一个周期」，因此首尾严丝合缝、无缝也无跳。
     周期 P 取 36px（约方块宽度的 3 倍，肉眼看得出 3~4 条斜带在流）。 */
  /* 周期与位移必须成「整数格子向量」：方向 15:7 与 115° 只差 0.007°（肉眼无差），
     位移取 (−30, −14)、周期取它的长度 33.1px —— 这样循环首尾**像素级重合**，
     不会在循环点跳一下（取 36×0.906 那种小数会因栅格化相位不齐而跳）。 */
  const diagPeriod = 33.1
  const diagStops = (() => {
    const arr = preset.stops.slice()

    if (arr.length > 2 && String(arr[0]).toLowerCase() === String(arr[arr.length - 1]).toLowerCase()) arr.pop()

    const step = diagPeriod / arr.length

    return arr.map((c, i) => `${c} ${(i * step).toFixed(1)}px`).join(', ') + `, ${arr[0]} ${diagPeriod}px`
  })()

  /* 发光：强度滑块 + 发光滑块一起决定，双圈光晕（近圈实、外圈散） */
  const glowSpread = 2 + glow * 0.09 + power * 3
  const glowShadow = glow > 0
    ? `0 0 ${glowSpread.toFixed(1)}px ${(-0.5 + glow * 0.012).toFixed(2)}px ${preset.glow}, 0 0 ${(
      glow * 0.3 + power * 8
    ).toFixed(1)}px ${(-1 + power * 2).toFixed(2)}px ${preset.glow}`
    : 'none'

  /* 强度：饱和度 / 对比 / 亮度一起抬，再叠加呼吸脉动（两条动画挂同一元素） */
  const saturate = (1 + power * 1.1).toFixed(2)
  const contrast = (1 + power * 0.35).toFixed(2)
  const bright = (1 + power * 0.22).toFixed(2)
  const pulseFrom = (1 + power * 0.25).toFixed(2)
  const pulseTo = (1 + power * 0.95).toFixed(2)
  const pulseSeconds = (1.5 / speed).toFixed(2)
  const usePulse = power > 0.02
  const pulseName = usePulse ? ', hs-flow-pulse' : ''

  /* 文字：渐变要**铺满整个词**（background-size: 100%），否则短词只截到 1~2 个色相，
     看起来还是灰白的（用户报「文字不够彩色」就是这个）。流动改用**色相循环**
     （hue-rotate 0→360），整词始终是一条完整彩虹，色相还在走。 */
  const textRule = sel => `
${sel} {
  background-image: linear-gradient(115deg, ${stops}) !important;
  background-size: 100% 100% !important;
  background-repeat: no-repeat !important;
  background-position: 50% 50% !important;
  -webkit-background-clip: text !important;
  background-clip: text !important;
  -webkit-text-fill-color: transparent !important;
  color: transparent !important;
  animation-name: hs-flow-hue !important;
  animation-duration: ${textSeconds}s !important;
  animation-timing-function: linear !important;
  animation-iteration-count: infinite !important;
  animation-direction: normal !important;
}
`

  const textBlock =
    (wantText || wantRunText
      ? `
@keyframes hs-flow-hue {
  0% { filter: hue-rotate(0deg) saturate(${saturate}); }
  100% { filter: hue-rotate(360deg) saturate(${saturate}); }
}
`
      : '') +
    (wantText ? textRule(THINK_SQ_TEXT) : '') +
    (wantRunText ? textRule(RUN_TEXT_SEL) : '') +
    (wantRunText
      ? `
/* 行首那个转圈字形：渐变挂在「字帧带」上（原因见 runFlowGlyphEl 注释）。
   选择器比通用文字规则多一个类 → 更具体，必然胜出，不依赖书写顺序。
   背景按 1em 逐帧纵向平铺：滚到任何一帧，那个字形都在一整条渐变里。 */
/* 插件自己插的转圈图像（应用没画的那种行）。结构与配色跟原版一致：
   1em 高的裁剪盒 + 一列单字符帧，用 transform 逐帧滚动；颜色是同一套斜向循环渐变 + 色相流动。 */
.hs-spinner-cell {
  display: inline-flex !important;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 1.15em;
  height: 1.15em;
  margin-right: 0.4em;
  vertical-align: middle;
}

.hs-spinner {
  display: block;
  height: 1em;
  overflow: hidden;
}

.hs-spinner__frame {
  display: block;
  height: 1em;
  line-height: 1em;
  text-align: center;
}

.hs-spinner__strip {
  display: block;
  background-image: repeating-linear-gradient(115deg, ${diagStops}) !important;
  background-size: 100% 100% !important;
  background-repeat: no-repeat !important;
  -webkit-background-clip: text !important;
  background-clip: text !important;
  -webkit-text-fill-color: transparent !important;
  color: transparent !important;
  /* 帧滚动（transform，走合成器）+ 色相流动：两条各管一个属性，不互相覆盖 */
  animation-name: hs-spinner-advance, hs-flow-huesq !important;
  animation-duration: ${(HS_SPIN_FRAMES.length * 0.085).toFixed(2)}s, ${textSeconds}s !important;
  animation-timing-function: steps(${HS_SPIN_FRAMES.length}), linear !important;
  animation-iteration-count: infinite, infinite !important;
  animation-direction: normal, normal !important;
}

@keyframes hs-spinner-advance {
  from { transform: translateY(0); }
  to { transform: translateY(-${HS_SPIN_FRAMES.length}em); }
}

[data-hs-run-text].glyph-spinner__strip {
  /* 和方块同一套斜向循环渐变；同样不平铺（整条字帧带画满一遍）。 */
  background-image: repeating-linear-gradient(115deg, ${diagStops}) !important;
  background-size: 100% 100% !important;
  background-repeat: no-repeat !important;
  -webkit-background-clip: text !important;
  background-clip: text !important;
  -webkit-text-fill-color: transparent !important;
  color: transparent !important;
  animation-name: hs-flow-hue !important;
  animation-duration: ${textSeconds}s !important;
  animation-timing-function: linear !important;
  animation-iteration-count: infinite !important;
  animation-direction: normal !important;
}
`
      : '')

  const squareBlock = wantSquare
    ? `
${THINK_SQ} {
  /* 清掉原生棋盘格：它是 background-image，且简写留下了 0.125rem 的 background-size */
  background-color: transparent !important;
  /* ⚠️ 必须 90deg（水平）：这块是「300% + repeat」平铺的，斜向渐变（115deg）在平铺边界上
     颜色对不上，用户看到的就是「转动时有很明显的颜色分割线」。水平渐变纵向均匀、
     横向首尾同色 → 平铺无缝。 */
  /* 斜向循环渐变（斜面色带）。⚠️ 关键：**不要平铺**。
     斜向渐变的内部周期是「沿斜轴」，而 repeat 是按矩形平铺 → 边界永远对不上 = 用户看到的拼接缝/分割线
     （这是数学上的必然，调参数救不了）。用 100% 100% + no-repeat：整块只画一条、铺满元素、
     完全不参与平铺 → 不可能有缝、也不可能透底。流动交给色相循环（天然首尾无缝）。 */
  background-image: repeating-linear-gradient(115deg, ${diagStops}) !important;
  background-size: 100% 100% !important;
  background-repeat: no-repeat !important;
  background-origin: border-box !important;
  background-clip: border-box !important;
  /* ⚠️ 绝对不能写 !important：CSS 里 !important 声明会**压过 @keyframes 动画**（和「动画压普通声明」相反）。
     原来自带 !important → hs-flow-move 那条驱动 background-position 的流动动画从来没生效过，
     用户看到的就是「方块是一个固定的彩色、不流动」。 */
  background-position: 0% 50%;
  border-radius: ${radius}px;
  box-shadow: ${glowShadow};
  filter: saturate(${saturate}) contrast(${contrast}) brightness(${bright});
  --hs-sq-scale: ${scale};
  scale: var(--hs-sq-scale);
  /* ⚠️ 必须用 hs-flow-huesq（把色相 + 饱和度/对比/亮度写在同一条 keyframes 里）：
     之前用 hs-flow-hue + hs-flow-pulse 两条，它们**都动 filter** → 后者整体覆盖前者，
     结果色相旋转根本没生效、方块只在微微呼吸（用户问「流动着没」时实测就是这个）。
     脉动改到 scale 上，两条动画各管一个属性，不再互相覆盖。 */
  animation-name: hs-flow-huesq${pulseName} !important;
  animation-duration: ${seconds}s${usePulse ? `, ${pulseSeconds}s` : ''} !important;
  animation-timing-function: linear, ease-in-out !important;
  animation-iteration-count: infinite, infinite !important;
  animation-direction: normal, alternate !important;
}

@keyframes hs-flow-move {
  0% { background-position: 0% 50%; }
  100% { background-position: 300% 50%; }
}

/* 方块的配色流动：色相 + 饱和度/对比/亮度写在**同一条** keyframes 里（避免两条动画抢 filter） */
@keyframes hs-flow-huesq {
  0% { filter: hue-rotate(0deg) saturate(${saturate}) contrast(${contrast}) brightness(${bright}); }
  100% { filter: hue-rotate(360deg) saturate(${saturate}) contrast(${contrast}) brightness(${bright}); }
}

/* 呼吸脉动：改到 scale 上（缩放走合成器，也不与色相抢 filter）。
   用 calc 乘上用户自己设的「方块大小倍率」，不会把那个设置覆盖掉。 */
@keyframes hs-flow-pulse {
  0% { scale: calc(var(--hs-sq-scale, 1) * ${pulseFrom}); }
  100% { scale: calc(var(--hs-sq-scale, 1) * ${pulseTo}); }
}
`
    : ''

  return `${squareBlock}${textBlock}`
}

/* 思考方块的设置行 */
function flowRows(s) {
  const rng = (key, min, max, step, text, description, title) =>
    jsx(ListRow, {
      action: jsxs('div', {
        className: 'flex w-full items-center gap-3',
        children: [
          jsx('input', {
            className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
            max,
            min,
            onChange: event => update({ [key]: Number(event.target.value) }),
            step,
            type: 'range',
            value: s[key]
          }),
          jsx('span', {
            className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
            children: text
          })
        ]
      }),
      description,
      title
    })

  const cur = FLOW_PRESETS[s.flowPreset] || FLOW_PRESETS.rainbow

  return [
    jsx(ListRow, {
      action: jsx(SegmentedControl, {
        onChange: id => update({ flowOn: id === 'on' }),
        options: [
          { id: 'off', label: '原生蓝色方块' },
          { id: 'on', label: '彩色流光' }
        ],
        value: s.flowOn === true ? 'on' : 'off'
      }),
      description: '思考方块换成彩色流光。',
      title: '思考方块'
    }),

    jsx(ListRow, {
      action: jsxs('div', {
        className: 'flex items-center gap-3',
        children: [
          jsx('div', {
            className: 'flex gap-1.5',
            children: Object.entries(FLOW_PRESETS).map(([id, item]) =>
              jsx('button', {
                className: `h-6 w-9 rounded-md border ${s.flowPreset === id ? 'border-(--ui-accent)' : 'border-(--ui-border)'}`,
                onClick: () => update({ flowPreset: id }),
                style: { backgroundImage: `linear-gradient(115deg, ${item.stops.join(', ')})` },
                title: item.label,
                type: 'button'
              })
            )
          }),
          jsx('span', {
            className: 'text-xs text-(--ui-text-tertiary)',
            children: cur.label
          })
        ]
      }),
      description: '流光的配色。',
      title: '配色'
    }),

    jsx(ListRow, {
      action: jsx(SegmentedControl, {
        onChange: id => update({ flowText: id === 'on' }),
        options: [
          { id: 'off', label: '不流光' },
          { id: 'on', label: '也流光' }
        ],
        value: s.flowText === true ? 'on' : 'off'
      }),
      description: '方块后面的文字也流光。',
      title: '文字也流光'
    }),

    rng('flowIntensity', 0, 100, 5, `${s.flowIntensity}`, '流光的强度。', '强度'),
    rng('flowSpeed', 0.2, 4, 0.1, `${Number(s.flowSpeed).toFixed(1)}×`, '流动的速度。', '速度'),

    jsx(ListRow, {
      action: jsx(SegmentedControl, {
        onChange: id => update({ timerBarOn: id === 'on' }),
        options: [
          { id: 'off', label: '显示秒数' },
          { id: 'on', label: '进度条' }
        ],
        value: s.timerBarOn === true ? 'on' : 'off'
      }),
      description: '秒数换成流光进度条。',
      title: '计时 → 进度条'
    }),

    rng('timerBarMax', 5, 600, 5, `${s.timerBarMax} 秒`, '进度条满格需要的秒数。', '满格秒数'),
    rng('timerBarWidth', 1.5, 14, 0.1, `${Number(s.timerBarWidth).toFixed(1)} rem`, '进度条的长度。', '长度'),
    rng('timerBarHeight', 0.16, 1.2, 0.02, `${Number(s.timerBarHeight).toFixed(2)} rem`, '进度条的粗细。', '粗细'),
    rng('timerBarRadius', 0, 999, 1, s.timerBarRadius >= 999 ? '全圆角' : `${s.timerBarRadius} px`, '进度条的圆角。', '进度条圆角'),

    jsx(ListRow, {
      action: jsx(SegmentedControl, {
        onChange: id => update({ timerBarTrack: id === 'on' }),
        options: [
          { id: 'off', label: '只显示进度' },
          { id: 'on', label: '显示底槽' }
        ],
        value: s.timerBarTrack === true ? 'on' : 'off'
      }),
      description: '显示进度条的底槽。',
      title: '进度条底槽'
    }),
    rng('flowGlow', 0, 100, 5, `${s.flowGlow}`, '外发光的强度。', '发光'),
    rng('flowRadius', 0, 10, 1, `${s.flowRadius} px`, '方块的圆角。', '方块圆角'),
    rng('flowScale', 0.6, 2, 0.05, `${Number(s.flowScale).toFixed(2)}×`, '方块大小的倍率。', '大小')
  ]
}

/* 「运行状态条」那一节的设置行：只有开关与曲线是本地方独有的，
   配色 / 强度 / 速度 / 发光 / 进度条粗细与圆角都跟思考方块共用（用户要求「参考思考方块的设置」）。 */
function runFlowRows(s) {
  return [
    jsx(ListRow, {
      action: jsx(SegmentedControl, {
        onChange: id => update({ runFlowOn: id === 'on' }),
        options: [
          { id: 'off', label: '不套用' },
          { id: 'on', label: '也流光' }
        ],
        value: s.runFlowOn === true ? 'on' : 'off'
      }),
      description: '运行中的行也套上流光。',
      title: '运行状态条也流光'
    }),

    jsx(ListRow, {
      action: jsx(SegmentedControl, {
        onChange: id => update({ runFlowClockStyle: id === 'bar' ? 'bar' : 'num' }),
        options: [
          { id: 'num', label: '数字' },
          { id: 'bar', label: '进度条' }
        ],
        value: s.runFlowClockStyle === 'num' ? 'num' : 'bar'
      }),
      description: '计时用进度条还是数字。',
      title: '计时显示'
    }),

    jsx(ListRow, {
      action: jsx(SegmentedControl, {
        onChange: id => update({ runFlowCurve: id === 'linear' ? 'linear' : 'asym' }),
        options: [
          { id: 'asym', label: '渐近（不会停住）' },
          { id: 'linear', label: '线性（到点就满）' }
        ],
        value: s.runFlowCurve === 'linear' ? 'linear' : 'asym'
      }),
      description: '进度条怎么涨。',
      title: '计时曲线'
    })
  ]
}

/* ── 输入框液态玻璃（Liquid Glass React 移植）──────────────────────
   原库：rdev/liquid-glass-react（MIT，6.3k star）。这里是把它**纯 DOM/CSS 化**的移植，
   不带 React 依赖 —— 核心就是它那张 SVG 滤镜 + 三张预调位移贴图。

   它的设计精髓（比"整体模糊"高级的地方）：
   · feDisplacementMap 用**贴图的 R/B 通道**当位移方向（不是 feTurbulence 那种水波纹）；
   · **只在边缘折射、中间保持清晰** —— 位移结果先用边缘遮罩(EDGE_MASK)取出来，
     中间部分用原图(CENTER_ORIGINAL)反向遮罩补回去，最后 over 合成。
     所以输入框里的文字**不会**被扭曲（这是能用在输入框上的前提）；
   · **色散**：同一张贴图跑三遍、位移量各差一点，拆 R/G/B 三通道后 screen 混合
     —— 边缘那圈红蓝错位就是它；
   · 玻璃本体是**一个伪元素**：`::before` 带 backdrop-filter（模糊+饱和）再套 SVG 滤镜。
     挂在 `::before` 上是有讲究的：它在输入框背景之上、内容层(z-1)之下，
     所以折射的是背景，文字照样清晰。

   限制：`filter: url()` 只有 Chromium 系支持（Safari/Firefox 看不到折射）——
   Electron 就是 Chromium，没问题。
   ─────────────────────────────────────────────────────────────── */
const LGX_SVG_ID = 'hermes-lgx-filters'
const LGX_TARGET = "[data-slot='composer-surface']"
/* 设置面板：运行时由 markSettingsSurface() 打标记 */
const LGX_SETTINGS_SURFACE = "[data-hs-settings-surface='1']"
/* 设置弹窗左列（导航栏）：应用给它的是 data-tour='overlay-nav'（所有叠加页的左侧导航共用一个名字）。 */
const LGX_SETTINGS_RAIL = "[data-hs-settings-surface='1'] [data-tour='overlay-nav']"

/* 磨砂色板：都是低饱和的深色，配上模糊就是「磨砂玻璃」；点一下换一个，也能自定义或跟随主题。 */
const LGX_TINT_SWATCHES = [
  '#1b2330', '#101722', '#1d1a2b', '#12222b',
  '#231a1a', '#16241d', '#2a2233', '#0f1a1f'
]
/* 会话行：和悬浮/光晕用的是同一个伪元素 ::before（那里是阴影）——
   玻璃只写 backdrop-filter/filter，不碰 box-shadow，两套规则互不干扰。 */
const LGX_SESS = ":is([data-slot='sidebar-wrapper'] div.row-hover:has(.hover-marquee))"
/* 气泡：我发的 + Hermes 发的，同一套玻璃 */
/* 用 :is() 包起来：直接拼 "A, B::before" 的话 ::before 只会加在 B 上（老坑） */
/* 我发的气泡 / Hermes 发的气泡：分开两套，各自有开关与圆角（按地方归类）。
   LGX_BUBBLE 只留给诊断计数用。 */
const LGX_MY_BUBBLE = '.composer-human-message'
/* 玻璃用它：比「去掉气泡黑底」里的 [data-slot='aui_user-message-root'] .composer-human-message::before
   更具体（多一层元素），否则那条 backdrop-filter: none !important 会把玻璃的模糊顶掉
   —— 用户报「我发的气泡玻璃里模糊没生效」，实测就是这个（色散走 filter 属性，没被顶掉）。 */
const LGX_MY_BUBBLE_GLASS =
  "[data-slot='aui_user-message-root'] .composer-human-message.standalone-glass, " +
  "[data-slot='aui_user-message-root'] button.composer-human-message"
const LGX_AB_BUBBLE = "[data-slot='aui_assistant-message-content']"
const LGX_BUBBLE = `:is(${LGX_MY_BUBBLE}, ${LGX_AB_BUBBLE})`
/* 推理弹窗（我们自己标记的那个 dropdown 内容）—— 与气泡同一套玻璃 */
const LGX_POP = "[data-slot='dropdown-menu-content'][data-hs-effort='1']"
/* 模型名弹窗（应用自己的模型列表）—— 由插件在挂载推理滑条时打上 data-hs-menu */
const LGX_MENU_POP = "[data-slot='dropdown-menu-content'][data-hs-menu='1']"
/* 推理强度弹窗 + 模型名弹窗：用户要求两个都跟输入框同步 */
const LGX_POP_ALL = `${LGX_POP}, ${LGX_MENU_POP}`
/* 鼠标右键菜单（应用的 context-menu-content） */
const LGX_CTX = "[data-slot='context-menu-content']"
/* 推理弹窗（含档位单选组）与模型弹窗（含菜单项、不含单选组）—— 用应用自己的结构特征，
   不依赖我打的标记（标记会被重渲染冲掉）。 */
const POP_REASON_SEL = "[data-slot='dropdown-menu-content']:has([data-slot='dropdown-menu-radio-group'])"
const POP_MODEL_SEL = "[data-slot='dropdown-menu-content']:has([role='menuitem']):not(:has([data-slot='dropdown-menu-radio-group']))" 


/** 某个地方的玻璃配方（已钳到合法区间）。 */
function lgxRecipe(s, place) {
  const p = LGX_PLACES[place] || ''
  const pick = (name, fallback) => lgxNum(s[p ? p + name : 'lgx' + name], lgxNum(s['lgx' + name], fallback))

  /* 简化后的配方：只有「模糊 / 饱和度 / 底色浓度」。
     折射模式、折射强度、色散全部去掉 —— 它们靠 SVG 滤镜实现，而那个滤镜机制已整段删除
     （黑线、闪烁、边界模糊、弹窗玻璃消失，全是它带来的）。 */
  return {
    blur: lgxClamp(pick('Blur', 6), 0, 40),
    saturate: lgxClamp(pick('Saturate', 180), 100, 400),
    tint: lgxClamp(pick('Tint', place === 'comp' ? 12 : 26), 0, 90)
  }
}

function lgxRadiusOf(s, target) {
  if (target === 'comp') return s.lgxOn === true ? Math.max(0, Math.min(60, lgxNum(s.lgxRadius, 22))) : null
  /* 会话玻璃的圆角 = 「会话圆角」滑块（不再单设滑块，否则两个互相顶） */
  if (target === 'sess') return s.lgxSessOn === true ? Math.max(0, Math.min(32, lgxNum(s.sessRadius, 14))) : null
  if (target === 'bubble') return s.lgxBubbleOn === true ? Math.max(0, Math.min(40, lgxNum(s.lgxBubbleRadius, 18))) : null
  /* 助手气泡：**它有自己的开关**，不能借用 'bubble' 那一支 ——
     借用会导致「只开助手气泡玻璃」时这里返回 null、元素圆角回退到 aBRadius（14px），
     而玻璃伪元素用 lgxABubbleRadius（18px）→ 同一个角两条弧，用户报「四个角有重影」。 */
  if (target === 'aBubble') {
    const on = s.lgxABubbleOn === true || (s.lgxABubbleOn === undefined && s.lgxBubbleOn === true)

    return on ? Math.max(0, Math.min(40, lgxNum(s.lgxABubbleRadius, lgxNum(s.lgxBubbleRadius, 18)))) : null
  }
  if (target === 'pop') return s.lgxPopOn === true ? Math.max(0, Math.min(40, lgxNum(s.lgxPopRadius, 16))) : null

  return null
}
/* 数值兜底 + 「地方」表（删滤镜机制时被误删，补回来） */
const lgxNum = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback)
const LGX_PLACES = {
  comp: '',
  settings: 'lgxSettings',
  sess: 'lgxSess',
  bubble: 'lgxBubble',
  aBubble: 'lgxABubble',
  pop: 'lgxPop',
  menu: 'lgxMenu'
}

const lgxClamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)
/* 滤镜 id 带地方名：每个地方一套配方 → 每个地方一张滤镜（否则改一处会牵动所有玻璃）。 */


/* 原库那条滤镜链，逐节点照搬 */

/* 隐藏 <svg> 里放滤镜；只建当前模式那一张（三张一起放也行，但没必要） */

/* 正在流式输出（回复中）：这期间应用的 DOM 每帧都在变，插件要少做重活。 */
function hsStreaming() {
  if (typeof document === 'undefined') return false

  return Boolean(
    document.querySelector("[data-slot='aui_response-loading'], [data-slot='status-row'], [data-running='true']")
  )
}

/* ── 输入框：把内部铺了不透明底色的层让开 ─────────────────────────────
   应用里 composer-surface 自己**没有底色**（class 里没有背景），里面那层也没有 ——
   真正铺底的是更里面的一层。它在玻璃之上，所以玻璃只在上下留白露出来：
   一半模糊、一半清晰，中间出现一条缝（用户：「中间没有模糊是透明的，只有一点暗」）。
   与其猜是哪一层，不如运行时找：扫输入框内部，凡是**面积占一半以上**又铺了不透明
   底色的层都标记出来让开（按钮、图标这类小元素不动）。 */
const COMP_CLEAR_ATTR = 'data-hs-comp-clear'

function syncComposerClear() {
  if (typeof document === 'undefined') return

  const surf = document.querySelector("[data-slot='composer-surface']")

  if (!surf) return

  const box = surf.getBoundingClientRect()
  const area = Math.max(1, box.width * box.height)
  const keep = new Set()
  const seen = []

  /* 扫三层；**带渐变的层也让开**（上一版特意跳过渐变层，结果缝还在 —— 很可能它就是渐变画的） */
  const walk = (el, depth) => {
    if (!el || depth > 3) return

    let st = null

    try {
      st = getComputedStyle(el)
    } catch {
      return
    }

    const bg = String(st.backgroundColor || '')
    const hasImg = st.backgroundImage && st.backgroundImage !== 'none'
    const opaque = bg && bg !== 'transparent' && !/rgba\(0, 0, 0, 0\)/.test(bg)

    if (opaque || hasImg) {
      const r = el.getBoundingClientRect()
      const frac = (r.width * r.height) / area

      seen.push(`${el.tagName.toLowerCase()}${el.dataset && el.dataset.slot ? '[' + el.dataset.slot + ']' : ''} ${opaque ? bg : '渐变'} 占比${Math.round(frac * 100)}%${frac >= 0.5 ? ' →让开' : ' (小，不动)'}`)

      if (frac >= 0.5) keep.add(el)
    }

    for (const kid of el.children) walk(kid, depth + 1)
  }

  for (const child of surf.children) walk(child, 1)

  window.__hsCompLayers = seen

  for (const old of document.querySelectorAll(`[${COMP_CLEAR_ATTR}]`)) {
    if (!keep.has(old)) old.removeAttribute(COMP_CLEAR_ATTR)
  }

  for (const el of keep) if (!el.hasAttribute(COMP_CLEAR_ATTR)) el.setAttribute(COMP_CLEAR_ATTR, '1')
}

function lgxCss(s) {
  const popOn = lgxPopOnOf(s)
  const menuOn = lgxMenuOnOf(s)
  const settingsOn = s.lgxSettingsOn === true

  if (s.lgxOn !== true && s.lgxSessOn !== true && s.lgxBubbleOn !== true && !settingsOn && !popOn && !menuOn) return ''

  const targets = [
    /* ⚠️ comp / pop / menu 这三处走 plain（纯磨砂，不用 SVG 滤镜）。
       原因：这三处的玻璃层一旦引用滤镜出问题（贴图 href 失败、滤镜缺失），浏览器会把
       整层渲染成黑色 —— 用户连报「输入框黑线 + 模型名/推理强度弹窗 + 右键菜单玻璃消失」。
       重做成纯磨砂：模糊 + 半透明底 + 描边，结构简单到不可能渲染成黑。 */
    { place: 'comp', recipe: lgxRecipe(s, 'comp'), on: s.lgxOn === true, sel: LGX_TARGET, radius: lgxClamp(lgxNum(s.lgxRadius, 22), 0, 60), inset: '0', rim: true, lift: false, plain: true, noFill: true },
    /* 会话行：inset 跟悬浮阴影保持一致（4px 0），否则两套规则抢 inset 会把阴影形状改掉 */
    /* inset 必须和「会话悬浮」画卡片时用的一致（gap/inset），否则玻璃和卡片边缘对不齐 */
    /* 设置那个面板（「设置 → 插件 → 个性化设置」打开的那张大卡片）。
       选择器是插件运行时打上去的：应用的设置卡片自带 data-glass-raised（它自己的「抬起玻璃卡片」语义标记），
       从本插件设置页往上 closest('[data-glass-raised]') 就是它 —— 比按 Tailwind 类名猜稳得多。
       ⚠️ 这条不用 lift：面板子元素里有绝对定位的拖拽条，给所有子元素写 position: relative 会把它压坏。 */
    { place: 'settings', recipe: lgxRecipe(s, 'settings'), on: s.lgxSettingsOn === true, sel: LGX_SETTINGS_SURFACE, radius: lgxClamp(lgxNum(s.lgxSettingsRadius, 12), 0, 40), inset: '0', rim: true, lift: false, plain: true },
    { place: 'sess', recipe: lgxRecipe(s, 'sess'), on: s.lgxSessOn === true, sel: LGX_SESS, radius: lgxClamp(lgxNum(s.sessRadius, 14), 0, 32),
      radiusShift: lgxClamp(lgxNum(s.sessGap, 0), 0, 12),
      inset: `${lgxClamp(lgxNum(s.sessGap, 0), 0, 12).toFixed(0)}px 0`,
      rim: false, lift: true },
    { place: 'bubble', recipe: lgxRecipe(s, 'bubble'), on: s.lgxBubbleOn === true, sel: LGX_MY_BUBBLE_GLASS, radius: lgxClamp(lgxNum(s.lgxBubbleRadius, 18), 0, 40), inset: '0', rim: true, lift: true },
    /* 助手气泡：自己一套开关与圆角（未设置时跟随「我发的」那套，老用户行为不变） */
    /* 助手气泡：内容容器**自带 overflow-hidden**（应用 className 里就有），所以两条都不能做：
       ① 不给元素本身写 border-radius —— overflow + 圆角会把裁切范围变成圆角矩形，
          用户报「开完模糊最上边被遮住了」；
       ② 不做 lift（会给里面**所有**子元素写 position: relative; z-index: 1，工具卡片那类结构会被打乱）。
       伪元素 z-index:-1 + 父级 isolation 已经保证内容在玻璃之上，lift 本来就多余。 */
    { place: 'aBubble', recipe: lgxRecipe(s, 'aBubble'), on: (s.lgxABubbleOn === true || (s.lgxABubbleOn === undefined && s.lgxBubbleOn === true)), sel: LGX_AB_BUBBLE, radius: lgxClamp(lgxNum(s.lgxABubbleRadius, lgxNum(s.lgxBubbleRadius, 18)), 0, 40), inset: '0', rim: true, lift: false },
    /* 模型名 / 推理强度弹窗：和气泡同一套（折射 + 色散），圆角单独一个键。
       ⚠️ keepPosition：这两个是 Radix 浮层，位置靠**内联 style** 定（fixed + left/top），
       配方里的 `position: relative !important` 会把它压掉、弹窗跑位 —— 浮层必须例外。 */
    { place: 'pop', recipe: lgxRecipe(s, 'pop'), on: popOn, sel: LGX_POP_ALL, radius: lgxClamp(lgxNum(s.lgxPopRadius, 16), 0, 40), inset: '0', rim: true, lift: true, keepPosition: true, plain: true },
    /* 鼠标右键菜单（应用自己就是 rounded-lg + backdrop-blur-md） */
    { place: 'menu', recipe: lgxRecipe(s, 'menu'), on: menuOn, sel: LGX_CTX, radius: lgxClamp(lgxNum(s.lgxMenuRadius, 12), 0, 40), inset: '0', rim: true, lift: true, keepPosition: true, plain: true }
  ].filter(item => item.on)

  /* 浮层底色必须变半透明，否则 backdrop-filter 折射的是「自己的不透明底」，
     看起来跟没开一样（和气泡玻璃同一个道理）。 */
  /* 磨砂 = 模糊 + 一层半透明底色。用户明确要求「模糊 0 应该是完全透明的」，
     所以底色浓度**跟着模糊走**：0 → 0%（全透明），40 → 60%（最实）。
     以前固定 62% —— 不管模糊调到多少底色都那么实，看起来就是「模糊没效果」。 */
  const settingsRec = lgxRecipe(s, 'settings')
  const frost = (pct, tintColor) => {
    const ratio = Math.max(0, Math.min(40, settingsRec.blur)) / 40
    const a = Math.round(pct * ratio)

    return `color-mix(in srgb, ${tintColor} ${a}%, transparent)`
  }
  const panelTint = s.lgxSettingsTint || 'var(--ui-bg-chrome, #1b2330)'
  const railTint = s.lgxSettingsRailTint || s.lgxSettingsTint || 'var(--ui-sidebar-bg, #141a24)'
  const railOn = settingsOn && s.lgxSettingsRailOn !== false
  const tint = [
    settingsOn
      ? `${LGX_SETTINGS_SURFACE} {
  background-color: ${frost(62, panelTint)} !important;
}
`
      : '',
    /* 左列（导航栏）：以前是应用自己的一整块不透明底 —— 用户说「现在是一列黑色」。
       它是个 overflow-y-auto 的 aside，**不能**用「::before + inset:0」那套（伪元素会跟着内容滚走），
       所以直接给元素本体上 backdrop-filter。底色同样跟模糊联动。 */
    railOn
      ? `${LGX_SETTINGS_RAIL} {
  background-color: ${frost(78, railTint)} !important;
  backdrop-filter: blur(${settingsRec.blur.toFixed(1)}px) saturate(${settingsRec.saturate.toFixed(0)}%) !important;
  -webkit-backdrop-filter: blur(${settingsRec.blur.toFixed(1)}px) saturate(${settingsRec.saturate.toFixed(0)}%) !important;
}
`
      : '',
    popOn
      ? `${LGX_POP_ALL} {
  background-color: color-mix(in srgb, var(--ui-bg-chrome, #1b2330) 55%, transparent) !important;
  border-color: rgba(255, 255, 255, 0.14) !important;
}
`
      : '',
    menuOn
      ? `${LGX_CTX} {
  background-color: color-mix(in srgb, var(--ui-bg-elevated, #1b2330) 55%, transparent) !important;
  border-color: rgba(255, 255, 255, 0.14) !important;
}
`
      : ''
  ].join('')

  /* ⚠️ 逗号选择器 + 后缀会出错：`A, B::before` 里 ::before 只作用于 B，
     `A, B > *` 更糟 —— A 自己也被套上那条规则（曾把推理强度弹窗的 z-index
     从应用的 z-50 压成 1，弹窗被盖在后面，用户报「打不开」）。
     统一包成 :is(...) 变成单个复合选择器，所有后缀就都正确了。 */
  const selOf = item => (item.sel.includes(',') ? `:is(${item.sel})` : item.sel)

  /* ⚠️ 输入框那层玻璃铺满整个框，但应用自己的输入区底色是**不透明**的、压在玻璃之上 ——
     于是玻璃只在上下留白处露出来：一半模糊一半不模糊，中间出现一条缝
     （用户描述得很准：「玻璃模糊了，但中间没有模糊是透明的，只有一点暗，所以感觉是黑线」）。
     正解：把应用那层底色让开（透明），让玻璃在整个输入框上均匀起作用。 */
  const compClearRule = targets.some(item => item.noFill)
    ? `
/* 输入框内部铺了不透明底色的层（运行时标记）：让开，玻璃才能整框均匀生效 */
[${COMP_CLEAR_ATTR}='1'] {
  background-color: transparent !important;
}
`
    : ''

  const compClear = targets.some(item => item.noFill)
    ? `
/* 输入框：让开应用自己的不透明底，玻璃才能整框均匀生效（否则中间不模糊、上下模糊，出现一条缝） */
${LGX_TARGET} {
  background-color: transparent !important;
}
`
    : ''

  return compClearRule + compClear + tint + targets
    .map(item => `${item.lift ? `
${selOf(item)} > * {
  position: relative;
  z-index: 1;
}
` : ''}` + `
/* 配方（实测四组对照后选定的最强一组）：
   目标 isolation:isolate（建层叠上下文，同时是 backdrop root）+ 伪元素 z-index:-1
   → 玻璃夹在「自身背景之上、内容之下」；内容再抬到 z-1 保证不被盖。
   输入框**不要**动 z-index：应用自己就是 relative z-4 isolate、内容 z-1，
   正是这套配方，动它反而会盖掉应用的层级。 */
${selOf(item)} {
  ${item.keepPosition ? '/* 浮层：位置由应用的内联 style 定，绝不能改成 relative */' : 'position: relative;'}
  isolation: isolate;
  /* 圆角也写到元素本身：应用的边框、以及画在元素上的阴影都跟着元素圆角走，
     只改伪元素的话它们还是老圆角 —— 拐角会露出一条直角的残留线。 */
  /* 这里用**完整**圆角：背景被 background-clip 裁到内容框时，CSS 会自动减去纵向
     padding（= radiusShift），减完正好等于伪元素显式减过的值 —— 两边才严丝合缝。 */
  border-radius: ${item.radius.toFixed(0)}px !important;
}

/* 玻璃本体：背景之上、内容之下 —— 折射的是背景，文字保持清晰 */
${selOf(item)}::before {
  content: '';
  position: absolute;
  z-index: -1;
  inset: ${item.inset};
  border-radius: ${Math.max(0, item.radius - (item.radiusShift || 0)).toFixed(0)}px;
  backdrop-filter: blur(${item.recipe.blur.toFixed(1)}px) saturate(${item.recipe.saturate.toFixed(0)}%) !important;
  -webkit-backdrop-filter: blur(${item.recipe.blur.toFixed(1)}px) saturate(${item.recipe.saturate.toFixed(0)}%) !important;  /* 磨砂底：浓度来自各地方自己的「底色浓度」设置（输入框默认更淡） */
  background-color: color-mix(in srgb, var(--ui-bg-chrome, #1b2330) ${item.recipe.tint}%, transparent) !important;
  /* 不再引用任何 SVG 滤镜（滤镜机制已整段删除：它是黑线/闪烁的根源） */
  pointer-events: none;${item.lift ? `
  /* 内容抬到玻璃之上（气泡/会话行的内容本身没有 z-index） */` : ''}${item.rim ? `
  box-shadow: inset 0 0 0 0.5px rgba(255, 255, 255, 0.5), inset 0 1px 3px rgba(255, 255, 255, 0.25), 0 1px 4px rgba(0, 0, 0, 0.35);` : ''}
}
`)
    .join('')
}

/* ── 可重装的全局监听 ────────────────────────────────────────────────
   ⚠️ 绝不能用「window.__hsXxx = true」这类旗子防重复安装：插件**每次更新**
   都会被应用重新 import，新模块看到旗子就跳过安装 —— 真正在跑的仍是
   **旧模块**的那组监听，而它们闭包里的 `effortState.hitHandlers` 表在新模块里
   是空的，于是所有命中（含推理滑条的拖动）全部失效 ——
   用户报「推理强度的滑动条滑不动」就是这个。
   正确做法：把上一次装的那组摘掉、换上本模块的（key = 名字 + 事件 + 阶段）。 */
function rebindGlobal(target, name, type, handler, capture) {
  if (!target || typeof target.addEventListener !== 'function') return

  target.__hsBound = target.__hsBound || {}

  const key = `${name}:${type}${capture === true ? ':capture' : typeof capture === 'object' && capture ? ':opt' : ''}`
  const prev = target.__hsBound[key]

  if (prev && typeof prev.handler === 'function') {
    try {
      target.removeEventListener(prev.type, prev.handler, prev.capture)
    } catch {
      /* 摘不掉就留着：重复监听不会致命，只是多跑一次 */
    }
  }

  target.__hsBound[key] = { type, handler, capture }

  try {
    target.addEventListener(type, handler, capture)
  } catch {
    /* 个别环境不支持 capture 选项 */
  }
}

/* 模块初始化：清掉自己上次留下的「已建」标记。
   ⚠️ 插件每次更新都会被应用重新 import —— DOM 里的滑条/推理弹窗组件仍是
   **上一个模块**建的，新模块的状态表（items / order / hitHandlers）却是空的。
   若不清标记，新模块第一次同步会看到 `data-hs-build` 已匹配而**直接跳过重建**，
   于是 DOM 归旧模块、路由与状态归新模块 —— 两边永远对不上，拖滑条毫无反应
   （用户报「推理强度的滑动条滑不动」）。清掉标记 → 本模块第一次同步重建一遍，
   元素、处理器、状态三者自然对齐。
   （`data-hs-build` 只打在插件自己建的元素上，清它不会碰到应用的东西。） */
try {
  if (typeof document !== 'undefined') {
    for (const stale of document.querySelectorAll('[data-hs-build]')) stale.removeAttribute('data-hs-build')
  }
} catch {
  /* 环境没有 document：不用管，后面各段同步自己有守卫 */
}

/* 弹性跟手：鼠标在输入框附近时，玻璃整体朝鼠标方向轻微位移（原库 elasticity） */
let lgxPointerBound = false

/* ── 跟随鼠标：慢速插值（绝不用每帧直接赋值的写法）──────────────────
   用户要求：「跟随鼠标不要瞬间跟随，要特别缓慢的跟随」「和永里的气泡缓缓升起一样」。
   直接赋值 = 瞬间跟手 = 看起来在抖（上一版就是这么被投诉的）；这里改成每帧朝
   目标追一小步（时间常数由设置给），所以是缓缓滑过去，松手也缓缓滑回来。 */
const hsFollow = {
  raf: 0,
  last: 0,
  bound: false,
  items: new Map() /* el → { tx, ty, ts, x, y, s, has } */
}

function hsFollowOf(el) {
  let it = hsFollow.items.get(el)

  if (!it) {
    it = { tx: 0, ty: 0, ts: 1, x: 0, y: 0, s: 1, has: false }

    /* 起手值取元素当前的 translate（漂浮动画正在动的那个值）——
       否则第一次插值会从 0 开始，把行硬拽回原位（≤ 漂浮幅度的一次落位）。 */
    try {
      const cur = getComputedStyle(el).translate
      const parts = String(cur || '').match(/-?[\d.]+/g)

      if (parts && parts.length >= 2) it.y = parseFloat(parts[1]) || 0
      else if (parts && parts.length === 1) it.y = parseFloat(parts[0]) || 0
    } catch {
      /* 取不到就从 0 开始 */
    }

    it.x = 0
    hsFollow.items.set(el, it)
  }

  return it
}

function hsFollowFrame(ts) {
  /* dt 必须是正的小步：负数（时间戳回退 / 标签页切回）会让插值**反向发散**，
     表现为元素瞬间飞到天上（探针实测过）。 */
  const dt = Math.max(1, Math.min(64, ts - (hsFollow.last || ts)))
  const s = $settings.get()
  const tau = Math.max(80, Math.min(4000, Number(s.lgxFollowMs) || 900)) / 2.2
  const k = 1 - Math.exp(-dt / tau)
  let alive = false

  for (const [el, it] of hsFollow.items) {
    it.x += (it.tx - it.x) * k
    it.y += (it.ty - it.y) * k
    it.s += (it.ts - it.s) * k

    const settled = Math.abs(it.x) < 0.05 && Math.abs(it.y) < 0.05 && Math.abs(it.s - 1) < 0.0015

    if (settled && it.tx === 0 && it.ty === 0 && it.ts === 1) {
      if (it.has) {
        el.style.removeProperty('translate')
        el.style.removeProperty('scale')
        it.has = false
      }

      hsFollow.items.delete(el)
      continue
    }

    alive = true
    /* ⚠️ 必须带 !important：动画（漂浮关键帧）会压过普通行内声明 ——
       行内 !important 才压得住动画，这也是「悬停上飘」唯一能让 float 让位的办法。 */
    el.style.setProperty('translate', `${it.x.toFixed(2)}px ${it.y.toFixed(2)}px`, 'important')
    el.style.setProperty('scale', it.s.toFixed(4), 'important')
    it.has = true
  }

  hsFollow.last = ts
  hsFollow.raf = alive ? requestAnimationFrame(hsFollowFrame) : 0
}

function hsFollowWake() {
  if (!hsFollow.raf) hsFollow.last = 0
  if (!hsFollow.raf) hsFollow.raf = requestAnimationFrame(hsFollowFrame)
}

/** 悬停行的目标：跟鼠标上下、同时按行间隙夹住（绝不与上下相邻行重叠）。 */
function hsTouchTarget(s, el, pointerY) {
  const rect = el.getBoundingClientRect()
  const h = rect.height || el.offsetHeight || 44
  /* 净空完全根据用户设的行间隙算（0 就是 0 → 不放大也不移动，绝不压到相邻行）。
     间隙设小 = 能浮动的幅度自动变小；想要更明显的浮动就把间隙调大。 */
  const gap = Math.max(0, Math.min(12, Number(s.sessGap) || 0))
  const room = gap / 2
  const growRaw = Math.max(0, Math.min(30, Number(s.sessTouchGrow) || 0)) / 100
  const followRaw = Math.max(0, Math.min(24, Number(s.sessTouchFollow) || 0))
  const rise = Math.max(0, Math.min(24, Number(s.sessTouchRise) || 0))

  /* 放大先让位：放大占掉的空间不能超过净空 */
  const grow = Math.min(growRaw, Math.max(0, (room * 2) / h))
  const halfGrow = (h * grow) / 2
  /* 剩下多少可以上下移动（基础抬升 + 跟随位移都算在里面） */
  const slide = Math.max(0, room - halfGrow)
  const ny = (pointerY - (rect.top + rect.height / 2)) / Math.max(1, rect.height / 2)
  const dy = Math.max(-followRaw, Math.min(followRaw, ny * followRaw))

  /* ⚠️ 上飘与跟随必须**一起**夹进净空：只夹 rise 不夹 dy 的话，跟随幅度一大
     就压到上下相邻行了（探针实测 dy=-24 而净空只有 6px —— 用户明确要求不要重叠）。 */
  const net = Math.max(-slide, Math.min(slide, dy - Math.min(rise, slide)))

  /* room = 每侧可用净空（行间隙的一半）；slide = 扣掉放大后还能滑多少 */
  return { scale: 1 + grow, offset: net, room, slide, half: halfGrow }
}

function syncLgxElastic(s) {
  if (typeof document === 'undefined' || hsFollow.bound) return

  hsFollow.bound = true

  rebindGlobal(document, 'hs-follow', 'pointermove', event => {
    const now = $settings.get()
    const target = document.querySelector(LGX_TARGET)

    /* 输入框：跟鼠标（只输入框，不跟会话行 —— 行由下面的触碰反馈管） */
    if (now.lgxOn === true && target) {
      const rect = target.getBoundingClientRect()
      const strength = lgxClamp(lgxNum(now.lgxElastic, 0.15), 0, 1)
      const it = hsFollowOf(target)
      const far = event.clientX < rect.left - 160 || event.clientX > rect.right + 160 ||
                  event.clientY < rect.top - 160 || event.clientY > rect.bottom + 160

      if (far || !rect.width) {
        it.tx = 0
        it.ty = 0
      } else {
        it.tx = lgxClamp((event.clientX - (rect.left + rect.width / 2)) * strength * 0.1, -14, 14)
        it.ty = lgxClamp((event.clientY - (rect.top + rect.height / 2)) * strength * 0.1, -10, 10)
      }

      hsFollowWake()
    }

    /* 会话行：水泡式触碰反馈（缓缓膨大 + 跟随鼠标上下，边界内夹住） */
    if (isOn(now.sessTouchOn)) {
      const row = event.target && event.target.closest
        ? event.target.closest("[data-slot='sidebar-wrapper'] div.row-hover")
        : null

      for (const el of hsFollow.items.keys()) {
        if (el !== target && el !== row) {
          const it = hsFollowOf(el)
          it.tx = 0; it.ty = 0; it.ts = 1
        }
      }

      if (row) {
        const want = hsTouchTarget(now, row, event.clientY)
        const it = hsFollowOf(row)
        const base = row.getAttribute('data-working') === 'true' ? -6 : -2

        it.ts = want.scale
        it.ty = base + want.offset
      }

      hsFollowWake()
    }
  }, { passive: true })

  /* 鼠标离开侧栏：所有行缓缓归位 */
  rebindGlobal(document, 'hs-follow-leave', 'pointerleave', () => {
    for (const el of hsFollow.items.keys()) {
      const it = hsFollowOf(el)
      it.tx = 0; it.ty = 0; it.ts = 1
    }

    hsFollowWake()
  }, { passive: true })
}

/** 通用滑块行（模块级）—— 多个分节都要用，别在各函数里重复定义。 */
function rangeRow(s, update, key, min, max, step, text, description, title) {
  return jsx(ListRow, {
    action: jsxs('div', {
      className: 'flex w-full items-center gap-3',
      children: [
        jsx('input', {
          className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
          max, min,
          onChange: event => update({ [key]: Number(event.target.value) }),
          step, type: 'range', value: s[key]
        }),
        jsx('span', {
          className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
          children: text
        })
      ]
    }),
    description,
    title
  })
}

/** 某个地方的「玻璃开关」行 —— 按地方归类：这个开关就放在那个地方的板块里。 */
function lgxOnRow(s, update, key, note) {
  return jsx(ListRow, {
    action: jsx(SegmentedControl, {
      /* ⚠️ 护栏：分段控件挂载时可能拿当前值回调一次 onChange —— 对**默认开**的开关，
           那一下会把 true 写成 false（「一打开设置页，锁定布局自己关了、功能像不存在」，
           用户报了两轮）。回调值与当前值相同 → 忽略、不写盘；用户真点击必然不同，照旧生效。 */
      onChange: id => {
        const cur = s[key] === true ? 'on' : 'off'

        if (id === cur) return

        update({ [key]: id === 'on' })
      },
      options: [
        { id: 'off', label: '关闭' },
        { id: 'on', label: '磨砂' }
      ],
      value: s[key] === true ? 'on' : 'off'
    }),
    description: note,
    title: '磨砂'
  })
}

/* 玻璃的三态行（跟随输入框 / 一直开 / 关闭）—— 浮层专用。
   模块级：多个分节都要用，别在各函数里重复定义。 */
function lgxTriRow(s, update, key, title, description) {
  return jsx(ListRow, {
    action: jsx(SegmentedControl, {
      onChange: id => update({ [key]: id }),
      options: [
        { id: 'follow', label: '跟随输入框' },
        { id: 'on', label: '一直开' },
        { id: 'off', label: '关闭' }
      ],
      value: lgxTri(s[key])
    }),
    description,
    title
  })
}

/** 三选一（靠左 / 居中 / 靠右）—— 气泡水平位置用。 */
function bubbleAlignRow(s, update, key, title, description) {
  return jsx(ListRow, {
    action: jsx(SegmentedControl, {
      onChange: id => update({ [key]: id }),
      options: [
        { id: 'left', label: '靠左' },
        { id: 'center', label: '居中' },
        { id: 'right', label: '靠右' }
      ],
      value: bubbleAlign(s[key])
    }),
    description,
    title
  })
}

/** 三态：'follow'（跟随输入框）/ 'on'（一直开）/ 'off'。老存档是布尔值，
    由迁移统一改写成 'follow'。 */
function lgxTri(value) {
  /* 老存档是布尔：true = 一直开、false = 关闭（忠实映射，不猜）。
     其余（未设置 / 'follow'）→ 跟随输入框。 */
  if (value === true) return 'on'
  if (value === false) return 'off'

  return value === 'on' ? 'on' : value === 'off' ? 'off' : 'follow'
}

/** 模型名 / 推理强度弹窗要不要玻璃：跟随输入框时看 lgxOn。 */
/** 某个地方开没开玻璃（助手气泡默认跟随「我发的气泡」那套，老用户行为不变）。 */
function lgxPlaceOn(s, place) {
  if (place === 'comp') return s.lgxOn === true
  if (place === 'settings') return s.lgxSettingsOn === true
  if (place === 'sess') return s.lgxSessOn === true
  if (place === 'bubble') return s.lgxBubbleOn === true
  if (place === 'aBubble') return s.lgxABubbleOn === true || (s.lgxABubbleOn === undefined && s.lgxBubbleOn === true)
  if (place === 'pop') return lgxPopOnOf(s) === true
  if (place === 'menu') return lgxMenuOnOf(s) === true

  return false
}

function lgxPopOnOf(s) {
  const v = lgxTri(s.lgxPopOn)

  return v === 'on' ? true : v === 'off' ? false : s.lgxOn === true
}

/** 右键菜单要不要玻璃：同样默认跟随输入框。 */
function lgxMenuOnOf(s) {
  const v = lgxTri(s.lgxMenuOn)

  return v === 'on' ? true : v === 'off' ? false : s.lgxOn === true
}

/** 玻璃的**共用配方**：所有地方的玻璃都用这一套参数（折射方式 / 强度 / 色散 / 模糊 / 饱和度）。 */
/** 某个地方的玻璃配方设置行（折射模式 / 折射强度 / 色散 / 模糊 / 饱和度）——
    每个地方一份，互不影响。place 见 LGX_PLACES。 */
function lgxRecipeRows(s, update, place, label) {
  const p = LGX_PLACES[place] || ''
  const key = name => (p ? p + name : 'lgx' + name)
  const rec = lgxRecipe(s, place)

  /* 每处一份的磨砂配方：模糊 / 饱和度 / 底色浓度。没有折射、没有色散、没有 SVG 滤镜。 */
  return [
    rangeRow(s, update, key('Blur'), 0, 40, 1, `${rec.blur} px`, `${label}磨砂的模糊程度。`, '模糊'),
    rangeRow(s, update, key('Tint'), 0, 90, 2, `${rec.tint}%`, `${label}磨砂底色的浓度。`, '底色浓度'),
    rangeRow(s, update, key('Saturate'), 100, 400, 10, `${rec.saturate}%`, `${label}磨砂的鲜艳度。`, '饱和度')
  ]
}

/** @deprecated 旧「共用配方」的内容（已改成每个地方一份，保留函数只为兼容）。 */
function lgxSharedRows(s, update) {
  const rng = (key, min, max, step, text, description, title) =>
    rangeRow(s, update, key, min, max, step, text, description, title)

  return [
    jsx(ListRow, {
      action: jsx(SegmentedControl, {
        onChange: id => update({ lgxMode: id }),
        options: [
          { id: 'standard', label: '标准' },
          { id: 'polar', label: '环形' },
          { id: 'prominent', label: '醒目' }
        ],
        value: s.lgxMode || 'standard'
      }),
      description: '折射的弯曲方式：标准 = 常规透镜；环形 = 偏中心的环形弯曲；醒目 = 弯曲更夸张。',
      title: '折射模式'
    }),

    rng('lgxScale', 0, 200, 5, `${s.lgxScale}`, '折射位移强度。越大边缘扭曲越明显。', '折射强度'),
    rng('lgxAberration', 0, 10, 0.5, `${Number(s.lgxAberration).toFixed(1)}`, '边缘红蓝错位的量。', '色散'),
    rng('lgxBlur', 0, 40, 1, `${s.lgxBlur} px`, '透过玻璃看东西的模糊程度。', '模糊'),
    rng('lgxSaturate', 100, 400, 10, `${s.lgxSaturate}%`, '透过玻璃的鲜艳度。', '饱和度')
  ]
}

/* ── 计时秒数 → 彩色流光进度条 ──────────────────────────────────────
   那一行原本是「方块 + 秒数」（7s / 1:20，由 ActivityTimerText 渲染成
   一个 inline-flex 的 span，里面每个字符再包一层 span）。

   做法：
   · 用**文字内容**认它（^\d+s$ 或 ^\d+:\d+$），不靠 Tailwind 类名（带方括号，转义脆）；
   · 认出后打上 .hs-timer-bar 标记 → CSS 里隐藏文字、换成进度条；
   · 进度 = 已用秒数 / 上限（默认 100 秒），写进 CSS 变量 --hs-timer-pct 驱动宽度；
   · 宽度是**固定的**（默认 5.2rem），所以到 100% 也绝不会超出那一行的边界；
   · React 每秒会重建这些 span → 标记会丢，所以挂 MutationObserver **即时**补回来
     （observer 回调在绘制前跑，不会闪一下数字），另有 1s 轮询兜底。
   ─────────────────────────────────────────────────────────────── */
const TIMER_ROW = "[data-slot='aui_turn-activity'], [data-slot='aui_response-loading']"
/* 「运行状态条」这一类行：工具行 / 脚手架行（含思考折叠行）/ 状态栈行。
   用户要求把思考方块那套流光也套到这些行上（「正在运行 xxx」+ 后面的 1:11）。 */
const RUN_ROW_SEL = "[data-slot='tool-block'], [data-conversation-scaffold], [data-slot='status-row']"
/* 那一行里要上流光的标签文字（由 JS 打到元素上） */
const RUN_TEXT_SEL = '[data-hs-run-text]'
/* 完成后的时间戳（14:03 这种，形状和计时一模一样）—— 不排除的话，
   已跑完的行会被当成「还在跑」，挂上一条假进度条、文字也被上色。 */
const RUN_SKIP_SEL = "[data-slot='timeline-timestamp']"
let timerBarTimer = 0
let timerBarObserver = null

/* "7s" → 7；"1:20" → 80 */
function parseElapsed(text) {
  const mmss = /^(\d+):([0-5]\d)$/.exec(text)

  if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2])

  const sec = /^(\d+)s$/.exec(text)

  return sec ? Number(sec[1]) : null
}

/* 是不是「正在跑」的那串计时：文字像秒数，而且形状是 ActivityTimerText
   （StableText：整串一个 inline-flex，每个字符再包一个 1ch 宽的 span）。
   完成后的时间戳是单个 span、没有这种逐字符子节点 —— 形状这一条把两者分开。 */
function isLiveTimer(el) {
  if (!el) return false
  if (parseElapsed((el.textContent || '').trim()) === null) return false
  if (el.closest(RUN_SKIP_SEL)) return false

  const cls = String(el.className || '')

  /* 注意：应用用 cn()（tailwind-merge）拼类名，同类的 text-[0.56rem] 会被
     后传进来的 text-[0.625rem] 删掉 —— 真机上就是后者。所以这里按前缀匹配，
     并且真正靠得住的判据是下面那个「形状」（StableText 的逐字符 1ch 子 span）。 */
  if (cls.indexOf('text-[0.5') >= 0) return true

  const kids = Array.from(el.children || [])

  if (kids.length < 2) return false

  return kids.every(kid => String(kid.className || '').indexOf('w-[1ch]') >= 0)
}

/* 进度百分比：线性 = 到「满格秒数」就满（思考方块那边保持原样）；
   渐近 = 1 - exp(-已用/满格秒数)，到点约 63%、之后一直涨但**永不停在满格**
   （工具行常常跑很久，停在满格会被读成「坏了」）。 */
function timerBarPct(sec, s, wide) {
  const max = Math.max(5, Math.min(3600, Number(s.timerBarMax) || 100))
  const linear = !wide || s.runFlowCurve === 'linear'

  if (linear) return `${Math.min(100, (sec / max) * 100).toFixed(1)}%`

  return `${Math.min(99.9, (1 - Math.exp(-sec / max)) * 100).toFixed(1)}%`
}

/* 那一行里负责「正在运行 …」的文字：应用给实时标签挂了 .shimmer；
   认不到就退回「行内第一个含文字、且不含计时本身的元素」。

   ⚠️ 光标 .shimmer 不够：应用把这一行拆成「前缀文本节点 + span.shimmer 正文 + 后缀文本节点」
   （例如「正在编」+「写脚本」+「 from hermes_tools import …」），前后两段是它的**兄弟**，
   只标内层那段，用户看到的就是「中间彩色、两头还是灰的」（实测截图就是这样）。
   所以这里要往上提到「只包着这串标签文字」的最外层：条件是这个父节点**只有 el 一个元素子节点**
   （多出别的元素就说明那层混着别的东西，停手），并且它里面没有图标 / 按钮 / 计时。 */
function runFlowLabelEl(row, clock) {
  let el = null
  const shrink = row.querySelector('.shimmer')

  if (shrink && !shrink.contains(clock)) el = shrink

  if (!el) {
    const walk = node => {
      if (el || node === clock || node.contains(clock)) return

      const nodes = Array.from(node.childNodes || [])

      if (nodes.some(n => n.nodeType === 3 && String(n.textContent || '').trim())) {
        el = node
        return
      }

      for (const kid of Array.from(node.children || [])) walk(kid)
    }

    walk(row)
  }

  if (!el) return null

  while (
    el.parentElement &&
    el.parentElement !== row &&
    el.parentElement.children.length === 1 &&
    el.parentElement.children[0] === el &&
    !el.parentElement.contains(clock) &&
    !el.parentElement.querySelector(
      "svg, [class*='codicon'], button, [data-slot='timeline-timestamp'], .hs-timer-bar"
    )
  ) {
    el = el.parentElement
  }

  return el
}

/* 行首那个小方块 / 转圈：工具行用的是 GlyphSpinner（一帧一个字形字符的字库字形，
   能直接上渐变）。里面是 svg 的（真图标）不能上 —— 我的规则会把字色设成透明，
   svg 用 currentColor 画就会整个消失。dither 方块交给思考方块那套，不在这里重复处理。 */
/* 有些运行行的行首**没有**应用自带的转圈字形（实测「正在编写脚本 …」那行就是：行首 32px 里一个笔画都没有）。
   用户要求那里要有和原版一样的转圈图像 —— 由插件自己插一个，结构照抄应用：
   一列单字符帧 + transform 逐帧滚动；颜色走同一套斜向循环渐变 + 色相流动。 */
const HS_SPIN_FRAMES = ['⠂', '⠌', '⡑', '⢕', '⢝', '⣫', '⣟', '⡿', '⣿', '⣷', '⣯', '⣟', '⡿', '⢿', '⣻', '⣽', '⣾']

function runFlowEnsureSpinner(row, s) {
  if (s.runFlowOn !== true) return null
  if (row.querySelector('.glyph-spinner') || row.querySelector('.hs-spinner')) return row.querySelector('.hs-spinner')

  const btn = row.querySelector('button')

  if (!btn) return null

  try {
    const cell = document.createElement('span')

    cell.className = 'hs-spinner-cell'
    const sp = document.createElement('span')

    sp.className = 'hs-spinner'
    const strip = document.createElement('span')

    strip.className = 'hs-spinner__strip'

    for (const ch of HS_SPIN_FRAMES) {
      const f = document.createElement('span')

      f.className = 'hs-spinner__frame'
      f.textContent = ch
      strip.appendChild(f)
    }

    sp.appendChild(strip)
    cell.appendChild(sp)
    btn.insertBefore(cell, btn.firstChild)

    return sp
  } catch {
    return null
  }
}

function runFlowGlyphEl(row) {
  const glyph = row.querySelector('.glyph-spinner')

  if (!glyph || glyph.querySelector('svg')) return null

  /* ⚠️ 标记必须打在「字帧带」（.glyph-spinner__strip）上，不能打在外层那个 1em 高的盒子上：
     字形靠 transform 滚动整条字帧带来换帧，当前帧常常已经滚到盒子之外 —— 背景挂在盒子上时，
     background-clip:text 在那一帧的位置没有背景 → 字形直接看不见（用户报「正在编写脚本前面
     缺少那个运行方块」就是这个）。挂在字帧带上、渐变按 1em 逐帧平铺，滚到哪一帧都落在彩虹里。 */
  return glyph.querySelector('.glyph-spinner__strip') || glyph
}

/* 给一行里的计时打标记。wide = 「运行状态条」那一类行（要跳过时间戳、还要给标签上流光）。 */
function stampTimerRow(row, s, wide) {
  let clock = null

  if (wide) {
    /* 候选先按类名收窄（工具行的正文里有成百上千个 span，逐个读 textContent 太贵） */
    const cands = row.querySelectorAll("span[class*='text-[0.5'], span[class*='inline-flex']")

    for (const el of cands) {
      if (!isLiveTimer(el)) continue

      clock = el
      break
    }
  } else {
    for (const el of row.querySelectorAll('span')) {
      if (parseElapsed((el.textContent || '').trim()) === null) continue

      clock = el
      break
    }
  }

  if (!clock) return

  /* 这一类行默认**只显示计时数字**（用户要求：只显示进度、不要进度条）。
     所以 .hs-timer-bar 只在明确选了「进度条」时才加；不选时要把上一次可能留下的
     类与变量清掉（来回切换才不会残留「文字被隐藏」的状态）。 */
  /* 默认（键缺失 / 老存档）按「和思考方块一样」走进度条，只有明确选了数字才不换 */
  const asBar = !wide || s.runFlowClockStyle !== 'num'

  if (asBar) {
    if (!clock.classList.contains('hs-timer-bar')) clock.classList.add('hs-timer-bar')

    /* ⚠️ 应用的计时文字是 StableText「逐字符滚动」动画：数字滚动途中会短暂显示出别的数
       （甚至显示 0）。进度如果直接等于「当前文字」，就会跟着数字的滚动来回回缩 ——
       这正是用户说的「每秒跳动」。所以进度做成**单调不回退**：记住这一行到过的最大值，
       只有明显回落（说明换了新一轮运行）才重置。 */
    const raw = parseFloat(timerBarPct(parseElapsed((clock.textContent || '').trim()) || 0, s, wide)) || 0
    const had = Number(row.dataset.hsRunPct)
    const isNewRun = !Number.isFinite(had) || raw < had - 30
    const pctNum = isNewRun ? raw : Math.max(had, raw)

    row.dataset.hsRunPct = String(pctNum)

    const pct = `${pctNum.toFixed(2)}%`

    clock.style.setProperty('--hs-timer-pct', pct)
    /* 关键：进度值同时写到行上。应用每秒都会把计时元素整个重建一次，
       写在元素上的变量会随重建丢掉 → 表现成「进度每秒跳回去一下」。
       行本身不会被重建，而自定义属性会向下继承，所以写在行上就是个持久值。 */
    if (!row.hasAttribute('data-hs-run-row')) row.setAttribute('data-hs-run-row', '1')

    row.style.setProperty('--hs-timer-pct', pct)

    /* 精确标记：只给「唯一子元素就是计时」的父节点打标记（结构上不可能误伤别的元素）。
       父节点比计时元素稳定 —— 应用每秒替换的是里面那个逐字符节点，样式因此当帧就在。 */
    const wrap = clock.parentElement

    if (wrap && wrap.children && wrap.children.length === 1 && !wrap.hasAttribute('data-hs-clock-wrap')) wrap.setAttribute('data-hs-clock-wrap', '1')

    if (!clock.hasAttribute('data-hs-clock')) clock.setAttribute('data-hs-clock', '1')
  } else {
    if (clock.classList.contains('hs-timer-bar')) clock.classList.remove('hs-timer-bar')

    clock.style.removeProperty('--hs-timer-pct')
    row.removeAttribute('data-hs-run-row')
    row.style.removeProperty('--hs-timer-pct')
  }

  if (!wide || s.flowText !== true) return

  /* 这一行要上流光的三处：① 标签整段（含前缀/后缀）② 内层 .shimmer 自己
     （它自带一层流光底纹，得用我们的盖掉）③ 行首的转圈字形 + 计时数字本身。 */
  const label = runFlowLabelEl(row, clock)
  const shrink = row.querySelector('.shimmer')
  const own = runFlowEnsureSpinner(row, s)
  const glyph = runFlowGlyphEl(row) || own

  const targets = [label, shrink && !shrink.contains(clock) ? shrink : null, glyph, clock]

  for (const el of targets) {
    if (el && !el.hasAttribute('data-hs-run-text')) el.setAttribute('data-hs-run-text', '1')
  }
}

function tickTimerBar(s) {
  if (typeof document === 'undefined') return

  const wantThink = s.timerBarOn === true
  const wantRun = s.runFlowOn === true

  if (!wantThink && !wantRun) return

  if (wantThink) for (const row of document.querySelectorAll(TIMER_ROW)) stampTimerRow(row, s, false)

  /* ⚠️ 这一遍必须**便宜**：它挂在「整文档 characterData」的观察器上，聊天区每来一个 token
     都会触发一次。早先的写法是「先把所有工具行/脚手架行查出来、再逐行找计时」——
     用户那边有 500~700 行、每行几百个 span，实测就是「会话卡顿掉帧」的来源。
     改成**从计时元素本身出发**：应用那颗计时一定带 tabular-nums（SCAFFOLD_META_CLASS），
     候选通常个位数，逐个过一遍形状判据即可。
     另外：同一行只能按一条路径处理 ——「思考中/加载中」那两行同时也落在 RUN_ROW_SEL 里，
     再按「工具行」那套跑一遍会用另一种模式改同一个元素（设成数字时会把刚加的进度条摘掉，
     表现成「进度和数字来回跳」），所以这里显式跳过它们。 */
  if (wantRun) {
    for (const clock of document.querySelectorAll("span[class*='tabular-nums'], span[class*='text-[0.5']")) {
      if (!isLiveTimer(clock)) continue

      const row = clock.closest(RUN_ROW_SEL)

      if (!row || row.matches(TIMER_ROW)) continue

      stampTimerRow(row, s, true)
    }
  }

  /* 跑完的行：行还在、计时已经没了 → 把流光标记摘掉，
     否则那串字会一直是彩色的（用户会觉得「跑完了还在闪」）。
     注意不能拿 .hs-timer-bar 当「还活着」的判据 —— 这一类行默认不加那个类。 */
  for (const el of document.querySelectorAll(RUN_TEXT_SEL)) {
    const row = el.closest(RUN_ROW_SEL)
    let live = false

    if (row) {
      for (const cand of row.querySelectorAll("span[class*='text-[0.5'], span[class*='inline-flex']")) {
        if (isLiveTimer(cand)) {
          live = true
          break
        }
      }
    }

    if (!live) el.removeAttribute('data-hs-run-text')
  }

  /* 行上的进度值也要跟手清掉：计时结束的行若残留旧百分比，这一行被复用时进度条会从旧值开始。 */
  for (const row of document.querySelectorAll('[data-hs-run-row]')) {
    let live = false

    for (const cand of row.querySelectorAll("span[class*='tabular-nums'], span[class*='text-[0.5']")) {
      if (isLiveTimer(cand)) {
        live = true
        break
      }
    }

    if (live) {
      if (row.hasAttribute('data-hs-run-idle')) row.removeAttribute('data-hs-run-idle')
    } else {
      /* 宽限：应用换节点/换文字时可能出现「这一拍找不到活计时」，立刻摘标记会让进度条裸奔几十帧。
         连续 3 拍都没有才真摘（1 秒一次心跳，3 拍约 3 秒）。 */
      const miss = (Number(row.getAttribute('data-hs-run-idle')) || 0) + 1

      if (miss >= 3) {
        row.removeAttribute('data-hs-run-row')
        row.removeAttribute('data-hs-run-idle')
        row.style.removeProperty('--hs-timer-pct')
        delete row.dataset.hsRunPct

        for (const el of row.querySelectorAll('[data-hs-clock-wrap], [data-hs-clock]')) {
          el.removeAttribute('data-hs-clock-wrap')
          el.removeAttribute('data-hs-clock')
        }
      } else row.setAttribute('data-hs-run-idle', String(miss))
    }
  }
}

/* ── 欢迎页 ────────────────────────────────────────────────────────
   用户要求：启动时不要直接进会话，而是给一页问候「你好，我们今天要干什么？」，
   点会话才进入（外加一个「＋ 新对话」按钮）。提示语可在设置里改。
   判定「只在 Hermes 启动那一次」：没有端口/启动钥匙可用（window.hermes 是空的），
   所以用 sessionStorage（本窗口处理过就不再弹 → 页面刷新 / 插件热重载 / Ctrl+R 都不会重复弹）
   + localStorage 时间戳（30 分钟内再开新窗口也不弹）来近似「一次启动」。
   ⚠️ 会话行是虚拟列表，应用刚起来时可能还没渲染出来 → 轮询等它出现，最多等 12 秒。 */
const WELCOME_ID = 'hermes-welcome-layer'
const WELCOME_KEY = 'hermes.plugin.hermes-background.welcome'
const WELCOME_REASK_MS = 3 * 60 * 1000
let welcomeTimer = 0

function welcomeStore(op, value) {
  try {
    if (op === 'get') return { seen: sessionStorage.getItem(WELCOME_KEY), at: Number(localStorage.getItem(WELCOME_KEY) || 0) }
    if (op === 'seen') sessionStorage.setItem(WELCOME_KEY, '1')
    if (op === 'at') localStorage.setItem(WELCOME_KEY, String(value || Date.now()))
  } catch {}

  return null
}

/* 侧栏会话行 → 欢迎页要用的 { id, 标题 } 列表（按侧栏顺序 = 最近优先）。
   ⚠️ 会话 id 不在 DOM 属性里，也不在 props 里 —— 它在**行外层容器的 React key** 上，
   形如 `default::20261014_224206_1cefb7`（实测）。拿到 id 就能用改路由的方式进会话：
   `location.hash = '#/' + id`（实测真能切，且不用模拟点击 —— 应用不认非真实点击）。 */
function welcomeSessionId(holder) {
  try {
    const k = Object.keys(holder).find(key => key.indexOf('__reactFiber$') === 0)

    if (!k) return ''

    const m = /::(\d{8}_\d{6}_[0-9a-z]+)$/i.exec(String((holder[k] || {}).key || ''))

    return m ? m[1] : ''
  } catch {
    return ''
  }
}

function welcomeSessions(max) {
  const out = []

  let holders = []

  try {
    holders = Array.from(document.querySelectorAll("[data-slot='sidebar-wrapper'] div[data-index]"))
  } catch {}

  for (const holder of holders) {
    const id = welcomeSessionId(holder)

    if (!id) continue

    const titleEl = holder.querySelector('.hover-marquee') || holder.querySelector('[class*=truncate]')
    const title = titleEl ? String(titleEl.textContent || '').trim() : ''

    if (title) out.push({ id: id, title: title })

    if (out.length >= max) break
  }

  return out
}

function hideWelcome() {
  const el = document.getElementById(WELCOME_ID)

  if (el) el.remove()

  try {
    document.removeEventListener('keydown', welcomeEscHandler, true)
  } catch {}
}

function welcomeEscHandler(event) {
  if (event.key !== 'Escape') return

  try {
    event.stopPropagation()
    event.preventDefault()
  } catch {}

  hideWelcome()
}

/* 点「新建会话」：应用那个按钮是个菜单触发器（data-slot=context-menu-trigger），
   所以要两步：先点开菜单，再点菜单里的「新建会话」那一项。 */
function welcomeNewChat() {
  /* 开新对话：直接路由到 `#/`（实测 = 新草稿；Ctrl+N 也走这里，但不必模拟按键） */
  hideWelcome()

  try {
    location.hash = '#/'
  } catch {}
}

function showWelcome(s) {
  if (typeof document === 'undefined') return true
  if (document.getElementById(WELCOME_ID)) return true

  const max = Math.max(3, Math.min(12, Number(s.welcomeCount) || 8))
  const list = welcomeSessions(max)

  if (!list.length) return false

  const layer = document.createElement('div')

  /* 外观按设置走：玻璃（磨砂）、圆角、同步背景（不铺自己的底色 = 完全透出应用背景）、背景透明度 */
  const homeBlur = Math.max(0, Math.min(40, Number(s.homeBlur) || 0))
  const homeRadius = Math.max(0, Math.min(40, Number(s.homeRadius) || 0))
  const homeSync = s.homeSyncBg === true
  const homeAlpha = homeSync ? 0 : Math.max(0, Math.min(100, Number(s.homeOpacity) || 0)) / 100
  const homeGlass = s.homeGlassOn !== false && homeBlur > 0
  const homeDim = homeAlpha > 0 ? `color-mix(in srgb, var(--ui-bg-chrome, #0e1216) ${Math.round(homeAlpha * 100)}%, transparent)` : 'transparent'

  /* 首页背景：自己一张时，媒体铺在图层里（z-index 负值 → 在图层底色之上、正文之下） */
  const homeOwn = s.homeBgMode === 'own' && String(s.homeBgPath || '').trim()
  const homeBgDim = homeAlpha > 0 ? `color-mix(in srgb, var(--ui-bg-chrome, #0e1216) ${Math.round(homeAlpha * 100)}%, transparent)` : 'transparent'

  layer.id = WELCOME_ID
  layer.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:2147482600',
    'display:flex',
    'flex-direction:column',
    'align-items:center',
    'justify-content:center',
    'gap:1.15rem',
    'padding:3rem 1.5rem',
    'overflow:auto',
    `background:${homeOwn ? 'transparent' : homeDim}`,
    homeGlass ? `backdrop-filter:blur(${homeBlur}px) saturate(1.08)` : 'backdrop-filter:none',
    homeGlass ? `-webkit-backdrop-filter:blur(${homeBlur}px) saturate(1.08)` : '-webkit-backdrop-filter:none'
  ].join(';')
  try {
    if (homeOwn) {
      const path = String(s.homeBgPath || '')
    const kind = /(video)$/i.test(String(s.homeBgKind || '')) ? 'video' : 'image'
    const el = kind === 'video' ? document.createElement('video') : document.createElement('img')

    if (kind === 'video') {
      el.muted = true
      el.loop = true
      el.autoplay = true
      el.playsInline = true
      el.setAttribute('muted', '')
      el.setAttribute('playsinline', '')
    }

    el.setAttribute('aria-hidden', 'true')
    el.src = kind === 'video' ? mediaUrl(path) : fileUrl(path)
    el.style.cssText = `position:absolute;inset:0;width:100%;height:100%;object-fit:${s.homeBgFit === 'contain' ? 'contain' : 'cover'};z-index:-2;pointer-events:none`
    layer.appendChild(el)

    if (kind === 'video') {
      const played = el.play?.()

      if (played && typeof played.catch === 'function') played.catch(() => {})
    }

      if (homeBgDim !== 'transparent') {
        const dim = document.createElement('div')

        dim.setAttribute('aria-hidden', 'true')
        dim.style.cssText = `position:absolute;inset:0;background:${homeBgDim};z-index:-1;pointer-events:none`
        layer.appendChild(dim)
      }
    }
  } catch {
    /* 首页自己那张背景出问题也不能让整页不显示 */
  }

  const title = document.createElement('div')

  title.textContent = String(s.welcomeText || '').trim() || '你好，我们今天要干什么？'
  title.style.cssText = 'max-width:44rem;text-align:center;font-size:clamp(1.5rem,3.2vw,2.5rem);font-weight:600;letter-spacing:0.02em;color:var(--ui-text, #eef1f6);text-shadow:0 2px 18px rgba(0,0,0,.35)'
  layer.appendChild(title)
  const hint = document.createElement('div')

  hint.textContent = '点下面的会话接着聊，或者开一段新的'
  hint.style.cssText = 'font-size:0.8rem;color:var(--ui-text-tertiary, rgba(238,241,246,.6));margin-bottom:0.3rem'
  layer.appendChild(hint)
  const box = document.createElement('div')

  const boxBg = homeSync ? 26 : Math.min(70, Math.round(55 + homeAlpha * 20))
  const boxBlur = homeGlass ? `;backdrop-filter:blur(${Math.max(0, homeBlur - 4)}px);-webkit-backdrop-filter:blur(${Math.max(0, homeBlur - 4)}px)` : ''

  box.style.cssText = `width:min(34rem,100%);max-height:46vh;overflow:auto;display:flex;flex-direction:column;gap:0.4rem;padding:0.5rem;border-radius:${homeRadius}px;border:1px solid color-mix(in srgb, var(--ui-border, #ffffff) 22%, transparent);background:color-mix(in srgb, var(--ui-panel, #161a20) ${boxBg}%, transparent)${boxBlur}`
  for (const item of list) {
    const btn = document.createElement('button')

    btn.type = 'button'
    btn.textContent = item.title
    btn.setAttribute('title', item.title)
    btn.style.cssText = `text-align:left;padding:0.55rem 0.75rem;border-radius:${Math.max(4, homeRadius - 6)}px;border:0;background:transparent;color:var(--ui-text, #eef1f6);font-size:0.82rem;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis`
    btn.addEventListener('pointerenter', () => {
      btn.style.background = 'color-mix(in srgb, var(--ui-accent, #4c7dff) 30%, transparent)'
    })
    btn.addEventListener('pointerleave', () => {
      btn.style.background = 'transparent'
    })
    btn.addEventListener('click', () => {
      /* 进这条会话：直接改应用的路由（`#/<会话 id>`）—— 实测有效；
         模拟点击不行（应用不认非真实点击）。 */
      hideWelcome()

      try {
        location.hash = '#/' + item.id
      } catch {}
    })
    box.appendChild(btn)
  }

  layer.appendChild(box)
  const bar = document.createElement('div')

  bar.style.cssText = 'display:flex;gap:0.6rem;align-items:center;margin-top:0.2rem'
  const mk = (label, primary, onClick) => {
    const b = document.createElement('button')

    b.type = 'button'
    b.textContent = label
    b.style.cssText = primary
      ? 'padding:0.5rem 1rem;border-radius:0.7rem;border:1px solid color-mix(in srgb, var(--ui-accent, #4c7dff) 60%, transparent);background:color-mix(in srgb, var(--ui-accent, #4c7dff) 34%, transparent);color:var(--ui-text, #eef1f6);font-size:0.82rem;cursor:pointer'
      : 'padding:0.5rem 0.9rem;border-radius:0.7rem;border:1px solid color-mix(in srgb, var(--ui-border, #ffffff) 20%, transparent);background:transparent;color:var(--ui-text-tertiary, rgba(238,241,246,.7));font-size:0.8rem;cursor:pointer'
    b.addEventListener('click', onClick)

    return b
  }

  bar.appendChild(mk('＋ 新对话', true, () => welcomeNewChat()))
  bar.appendChild(mk('先关掉', false, () => hideWelcome()))
  layer.appendChild(bar)
  document.body.appendChild(layer)

  try {
    document.addEventListener('keydown', welcomeEscHandler, true)
  } catch {}

  return true
}

function syncWelcome(s) {
  if (typeof document === 'undefined') return

  const on = !s || s.welcomeOn !== false

  if (!on) {
    hideWelcome()

    /* 关掉时把「这次启动已经显示过」的标记清掉 —— 于是「关掉再打开」就等于
       「下次进本窗口重新显示一次」，方便想立刻重看的人（否则 30 分钟判定会拦住他）。 */
    try {
      sessionStorage.removeItem(WELCOME_KEY)
      localStorage.removeItem(WELCOME_KEY)
    } catch {}

    if (welcomeTimer) {
      clearInterval(welcomeTimer)
      welcomeTimer = 0
    }

    return
  }

  if (document.getElementById(WELCOME_ID)) return

  const st = welcomeStore('get') || {}

  if (st.seen) return

  if (st.at && Date.now() - st.at < WELCOME_REASK_MS) {
    welcomeStore('seen')

    return
  }

  /* 会话行可能还没渲染出来 → 轮询等（最多 12 秒），等到了就弹 */
  let tries = 0

  const attempt = () => {
    tries += 1

    if (showWelcome($settings.get())) {
      welcomeStore('seen')
      welcomeStore('at', Date.now())

      if (welcomeTimer) {
        clearInterval(welcomeTimer)
        welcomeTimer = 0
      }

      return
    }

    if (tries > 60 && welcomeTimer) {
      clearInterval(welcomeTimer)
      welcomeTimer = 0
    }
  }

  attempt()

  if (!document.getElementById(WELCOME_ID) && !welcomeTimer && typeof setInterval === 'function') {
    welcomeTimer = setInterval(attempt, 200)
    welcomeTimer.unref?.()
  }
}

/* 设置行 */
function welcomeRows(s, update) {
  return [
    swRow(s, update, 'welcomeOn', '开关首页', '启动时先显示这一页。', '关', '开'),
    jsx(ListRow, {
      action: jsx(Button, {
        onClick: () => {
          haptic('tap')
          /* 清掉「本次已显示过」的标记，然后立刻调出来 */
          try {
            sessionStorage.removeItem(WELCOME_KEY)
            localStorage.removeItem(WELCOME_KEY)
          } catch {}

          hideWelcome()

          if (!showWelcome($settings.get())) {
            host.notify({ kind: 'warn', message: '现在没有可列的会话，首页没东西可显示。' })
          }
        },
        variant: 'default',
        children: '马上看一眼'
      }),
      description: '不等下次启动，现在就把首页调出来。',
      title: '立刻显示'
    }),
    jsx(ListRow, {
      action: jsx('input', {
        className: 'w-full',
        defaultValue: String(s.welcomeText || ''),
        onChange: event => update({ welcomeText: String(event.target.value || '') }),
        style: {
          background: 'color-mix(in srgb, var(--ui-panel, #161a20) 70%, transparent)',
          border: '1px solid color-mix(in srgb, var(--ui-border, #fff) 20%, transparent)',
          borderRadius: '0.5rem',
          color: 'var(--ui-text, #eef1f6)',
          fontSize: '0.8rem',
          padding: '0.35rem 0.5rem',
          width: '100%'
        },
        type: 'text'
      }),
      description: '中间那句问候。',
      title: '欢迎语'
    }),
    jsx(ListRow, {
      action: jsx(SegmentedControl, {
        onChange: id => update({ homeBgMode: id }),
        options: [
          { id: 'follow', label: '跟随主背景' },
          { id: 'own', label: '自己一张' },
          { id: 'off', label: '不铺' }
        ],
        value: s.homeBgMode === 'own' ? 'own' : s.homeBgMode === 'off' ? 'off' : 'follow'
      }),
      description: '首页后面铺什么。跟随主背景 = 和「背景设置」里那张一样。',
      title: '首页背景'
    }),
    s.homeBgMode === 'own'
      ? jsx(ListRow, {
          action: jsxs('div', {
            className: 'flex flex-wrap items-center gap-2',
            children: [
              jsx(Button, { onClick: () => pickHomeFile(), children: '选择文件…' }),
              s.homeBgPath ? jsx(Button, { onClick: () => update({ homeBgPath: '' }), variant: 'textStrong', children: '清空' }) : null
            ]
          }),
          description: s.homeBgPath ? `当前：${fileNameOf(s.homeBgPath)}` : '还没选文件。',
          title: '背景文件'
        })
      : null,
    s.homeBgMode === 'own'
      ? jsx(ListRow, {
          action: jsx(SegmentedControl, {
            onChange: id => update({ homeBgFit: id }),
            options: [
              { id: 'cover', label: '铺满' },
              { id: 'contain', label: '适应' }
            ],
            value: s.homeBgFit === 'contain' ? 'contain' : 'cover'
          }),
          description: '画面铺满还是完整放下。',
          title: '填充'
        })
      : null,
    rangeRow(s, update, 'welcomeCount', 3, 12, 1, `${s.welcomeCount} 条`, '列出最近几个会话。', '会话条数'),
    swRow(s, update, 'homeGlassOn', '玻璃', '给首页加磨砂。', '关', '开'),
    rangeRow(s, update, 'homeBlur', 0, 40, 1, `${s.homeBlur} px`, '磨砂的模糊程度。', '磨砂强度'),
    rangeRow(s, update, 'homeRadius', 0, 40, 1, `${s.homeRadius} px`, '首页里那块列表的圆角。', '圆角'),
    swRow(s, update, 'homeSyncBg', '同步背景', '首页不铺自己的底色，直接透出你的背景。', '不铺', '铺'),
    rangeRow(s, update, 'homeOpacity', 0, 100, 5, `${s.homeOpacity}%`, '首页底色的浓淡。', '背景透明度')
  ]
}

/* 问询弹窗（澄清问题卡片）的设置行 */
function askRows(s, update) {
  const colorPick = (key, title, description) =>
    jsx(ListRow, {
      action: jsxs('div', {
        className: 'flex items-center gap-3',
        children: [
          jsx('input', {
            onChange: event => update({ [key]: String(event.target.value || '') }),
            type: 'color',
            value: s[key] || '#12161c'
          }),
          jsx(Button, {
            onClick: () => update({ [key]: '' }),
            size: 'xs',
            variant: 'text',
            children: '跟随主题'
          })
        ]
      }),
      description,
      title
    })

  return [
    swRow(s, update, 'askGlassOn', '磨砂', '给这个卡片加磨砂。', '关', '开'),
    swRow(s, update, 'askGlowOn', '确定按钮发光', '右下角那个按钮做成磨砂底 + 内发光。', '原样', '发光'),
    rangeRow(s, update, 'askBlur', 0, 40, 1, `${s.askBlur} px`, '磨砂的模糊程度。', '磨砂强度'),
    colorPick('askBg', '底板颜色', '卡片的底色。'),
    colorPick('askText', '字体颜色', '卡片里的文字颜色。'),
    rangeRow(s, update, 'askRadius', 0, 40, 1, `${s.askRadius} px`, '卡片与确认按钮的圆角。', '圆角')
  ]
}

/* ── 会话行漂浮的相位修正 ───────────────────────────────────────────
   症状：会话卡片「过一段时间就刷新一下位置」。
   真因：漂浮是 CSS 动画，相位靠写死的负延迟错开；应用每重建一次会话行
   （相对时间更新之类的重渲染就会重建），动画进度就从 0 重启 → 卡片跳回曲线起点。
   修法：相位改成**由墙上时钟算** —— 内联 `animation-delay: -((now+偏移) % 周期)`，
   数学上相位恒等于 `now % 周期`，与元素何时创建无关 → 重建也不会跳。
   ⚠️ 性能红线（踩过一次：整个渲染进程卡死、日志刷 webContents became unresponsive）：
     ① **绝不用 `:has()` 查询** 挂在会话区热路径上（会话区每秒都在变）；
     ② 观察器回调必须**每帧最多一次**，不能每个 mutation 都跑一遍扫描；
     ③ 扫描用最便宜的选择器（`[data-index]` + 子元素遍历），别用 `SIDE … ${ROW}`。 */
let sessBobRaf = 0
let sessBobObserver = null

function sessRowsCheap() {
  const rows = []

  let holders = []

  try {
    holders = document.querySelectorAll("div[data-index]")
  } catch {
    return rows
  }

  for (const holder of holders) {
    /* 便宜的取行：宿主子元素递归找 .row-hover（不用 :has()） */
    let row = holder.querySelector('div.row-hover')

    if (!row) row = holder.querySelector('.hover-marquee')?.closest('div')

    if (row) rows.push(row)
  }

  return rows
}

function stampSessFloat(s) {
  if (typeof document === 'undefined') return

  const rows = sessRowsCheap()

  if (!isOn(s.sessOn)) {
    for (const el of rows) if (el.dataset.hsBob) {
      el.style.removeProperty('animation-delay')
      delete el.dataset.hsBob
    }

    return
  }

  const speed = Math.max(1, Math.min(14, Number(s.sessSpeed) || 6))
  const workSpeed = Math.max(1, Number((speed * 0.62).toFixed(2)))
  const stagger = s.sessStagger !== 'off'
  const nowS = Date.now() / 1000

  for (const el of rows) {
    const sig = el.getAttribute('data-working') === 'true' ? 'w' : 'n'

    if (el.dataset.hsBob === sig) continue

    const holder = el.closest("div[data-index]")
    const digit = Number(String((holder && holder.getAttribute('data-index')) || '0').slice(-1)) || 0
    const dur = (sig === 'w' ? workSpeed : speed) * (stagger ? 1 + digit * 0.055 : 1)
    const off = stagger ? digit * 0.68 : 0
    const phase = ((nowS + off) % dur).toFixed(3)

    el.style.setProperty('animation-delay', `-${phase}s`, 'important')
    el.dataset.hsBob = sig
  }
}

/* 重建事件 → 合并到下一帧再处理（每帧最多一次），避免 mutation 风暴拖死主线程 */
function scheduleSessFloat() {
  if (sessBobRaf) return

  sessBobRaf = requestAnimationFrame(() => {
    sessBobRaf = 0

    try {
      stampSessFloat($settings.get())
    } catch {}
  })
}

function watchSessFloat() {
  if (typeof document === 'undefined' || sessBobObserver || typeof MutationObserver !== 'function') return

  const side = document.querySelector("[data-slot='sidebar-wrapper']")

  if (!side) return

  sessBobObserver = new MutationObserver(scheduleSessFloat)
  /* 只看结构增删 —— 不看属性，避免自己写的动画延迟反过来触发自己 */
  sessBobObserver.observe(side, { childList: true, subtree: true })
}

/* ── 锁定布局（默认开）───────────────────────────────────────────────
   应用里有三种拖动：① 窗格 / 浮动窗格 / 区划编辑器 = 自定义指针拖拽
   ② 侧栏会话与项目重排 = dnd-kit（指针）③ 机器人行 / 文件树 / 看板 = HTML5 拖放。
   ①② 的把手都是**独立元素**且带 Tailwind 的 cursor-* 类（sidebar/chrome.tsx 的 group/handle、
   floating-panes 的头部、master-detail 的 cursor-col-resize 隔条…）→ 按 cursor 类锁把手即可，
   点会话行、点标签、点按钮都不受影响。③ 由 JS 在**捕获期**拦 dragstart。
   ⚠️ 把手内部若有按钮（例如浮动窗格头部的关闭键），要给它们把 pointer-events 放回来。 */
/* ── 锁定布局（默认开）：不能拖动窗格 / 会话 / 机器人 / 侧栏列表 ─────────────
   应用里的拖动分三类，锁法不同：
   ① 独立「把手」（分栏隔条、列宽把手、小圆点…）：computed cursor 是 grab/move/*-resize
      → 按下时实时判定，然后把 pointermove 吃掉（阈值达不到 = 不成立拖动）。
   ② 窗格标签条 / 标签（`data-zone-tabstrip`、`role="tab"`）：⚠️ 它们的光标是**内联样式**
      `style={{cursor:'grab'}}`，纯按类名找把手会漏（用户报「左上角三个按钮还能拖」）。
      ⚠️ 而且它们**不能**吃 pointer-events：标签同时也是「点一下切换标签」的点击目标，
      而切换是从**同一个 pointerdown 处理器**回调的（startPaneDrag → onTap）。
      → 所以这里也走「吃掉 pointermove」这条软拦：松手仍判为点击 → 切换照常，拖动不成立。
   ③ HTML5 拖放（机器人行 / 文件树 / 看板）：捕获期拦 dragstart。系统往里拖文件不触发
      dragstart，所以插件自己的拖放功能不受影响。
   ⚠️ 判定必须**实时**（closest + computed cursor），不要往元素上打标记：会话区/标签条
      每秒都在重渲染，标记会被冲掉（踩过这个坑）。 */
const LOCK_HANDLE_SEL = "[class*='cursor-grab'], [class*='cursor-grabbing'], [class*='cursor-move'], [class*='cursor-col-resize'], [class*='cursor-row-resize'], [class*='cursor-ew-resize'], [class*='cursor-ns-resize']"
const LOCK_CURSORS = /^(grab|grabbing|move|col-resize|row-resize|ew-resize|ns-resize|nesw-resize|nwse-resize|all-scroll)$/
const LOCK_HARD_SEL = "[data-zone-tabstrip], [role='tab'], [data-hs-locked]"
/* 分隔条（窗格之间调宽度的那根，`role="separator"`，如 x≈355 那根）**单独一项设置**：
   「解锁位置」= 锁定时它仍能拖（默认）；「锁定位置」= 跟其它把手一样锁住。
   用户原话：锁定时这根不要锁 → 建议做成单独设置（只有这两个选项）。 */
const LOCK_EXEMPT_SEL = "[role='separator']"
const sashExempt = s => !s || s.sashLockOn !== true
let lockTimer = 0
let lockBlockerBound = false
let lockPressOnSurface = false

function layoutLockOn(s) {
  return !s || s.layoutLockOn !== false
}

/* ③ HTML5 拖放 */
function lockDragBlocker(e) {
  if (!layoutLockOn($settings.get())) return

  try {
    e.preventDefault()
    e.stopPropagation()
  } catch {}
}

/* ①② 按下时实时判定：这次按在「被锁的拖动表面」上吗 */
function lockPointerDown(e) {
  if (!layoutLockOn($settings.get())) return

  lockPressOnSurface = false

  try {
    /* ⚠️ 只用**结构性**判定，绝不看 computed cursor：cursor 是**继承属性** ——
       只要某个容器写了 `cursor: grab`，整棵子树的 computed cursor 都是 grab，
       那样正文、输入框会被一起判成「拖动表面」→ pointermove 被全局吃掉
       （踩过：正文/输入框都 True，等于把正常交互全废了）。
       把手那一路不靠这里：它们由 CSS `[data-hs-locked] { pointer-events: none }` 硬拦。 */
    if (e.target.closest && e.target.closest(LOCK_HARD_SEL)) lockPressOnSurface = true
  } catch {}
}

/* 拖动被卡死在这里：应用靠 pointermove 的位移判断「算拖动还是算点击」，
   位移永远到不了阈值 → 松手仍是「点一下」。 */
function lockPointerMove(e) {
  if (!lockPressOnSurface) return
  if (!layoutLockOn($settings.get())) return

  try {
    e.stopImmediatePropagation()
  } catch {}
}

function lockPointerEnd() {
  lockPressOnSurface = false
}

/* 把手额外硬拦：CSS pointer-events: none（周期打标记，被重渲染冲掉也不影响 ①② 的软拦）*/
function stampLayoutLock(s) {
  if (typeof document === 'undefined') return

  const on = layoutLockOn(s)

  if (on) {
    let list = []

    try {
      list = Array.from(document.querySelectorAll(LOCK_HANDLE_SEL))
    } catch {
      list = []
    }

    for (const el of list) {
      /* 分隔条在「解锁位置」时不但不锁，还要把上一版可能已打上的标记摘掉 */
      if (sashExempt(s) && el.closest && el.closest(LOCK_EXEMPT_SEL)) {
        if (el.hasAttribute('data-hs-locked')) el.removeAttribute('data-hs-locked')

        continue
      }

      if (el.hasAttribute('data-hs-locked')) continue

      let cur = ''

      try {
        cur = getComputedStyle(el).cursor || ''
      } catch {}

      if (LOCK_CURSORS.test(cur)) el.setAttribute('data-hs-locked', '1')
    }

    /* 「解锁位置」时把页面上所有分隔条的锁标记清掉（哪怕它已不在候选列表里） */
    if (sashExempt(s)) {
      try {
        for (const el of Array.from(document.querySelectorAll(`${LOCK_EXEMPT_SEL}[data-hs-locked]`))) el.removeAttribute('data-hs-locked')
      } catch {}
    }

    try {
      for (const el of Array.from(document.querySelectorAll("[draggable='true']"))) {
        if (!el.hasAttribute('data-hs-was-draggable')) el.setAttribute('data-hs-was-draggable', '1')

        el.setAttribute('draggable', 'false')
      }
    } catch {}

    if (!lockBlockerBound && typeof window !== 'undefined') {
      window.addEventListener('dragstart', lockDragBlocker, true)
      window.addEventListener('pointerdown', lockPointerDown, true)
      window.addEventListener('pointermove', lockPointerMove, true)
      window.addEventListener('pointerup', lockPointerEnd, true)
      window.addEventListener('pointercancel', lockPointerEnd, true)
      lockBlockerBound = true
    }
  } else {
    try {
      for (const el of Array.from(document.querySelectorAll('[data-hs-locked]'))) el.removeAttribute('data-hs-locked')

      for (const el of Array.from(document.querySelectorAll('[data-hs-was-draggable]'))) {
        el.removeAttribute('data-hs-was-draggable')
        el.setAttribute('draggable', 'true')
      }
    } catch {}

    if (lockBlockerBound && typeof window !== 'undefined') {
      window.removeEventListener('dragstart', lockDragBlocker, true)
      window.removeEventListener('pointerdown', lockPointerDown, true)
      window.removeEventListener('pointermove', lockPointerMove, true)
      window.removeEventListener('pointerup', lockPointerEnd, true)
      window.removeEventListener('pointercancel', lockPointerEnd, true)
      lockBlockerBound = false
    }
  }
}

function syncLayoutLock(s) {
  if (typeof document === 'undefined') return

  stampLayoutLock(s)

  /* pill 上色（模型名 / 推理强度流光）的**周期性补打**，与「锁定布局」无关，无条件起。
     原因：切对话窗口时 React 会重建那个 pill，我打的 data-hs-effort-rank 与 .hs-pill-text
     会被冲掉 —— 而 observer 只看 childList，冲掉后没有 DOM 增删就不再回调，颜色永远回不来
     （用户报「切窗口后模型名还是默认黑」）。400ms 足够快，每拍只是两次 querySelector。 */
  if (!pillRankTimer && typeof setInterval === 'function') {
    const stampBoth = () => {
      try {
        effortTagPillRank()
        stampModelArrow(effortModelPill())
        stampMenuArrows()

        if (typeof requestAnimationFrame === 'function') scheduleSessFloat()
      } catch {}
    }

    pillRankTimer = setInterval(stampBoth, 400)
    pillRankTimer.unref?.()

    /* 新开窗口 / 切回本窗口 / 点一下输入框 → 立刻补打一次，不等那 400ms */
    if (typeof window !== 'undefined' && !window.__hsPillKick) {
      window.__hsPillKick = 1
      window.addEventListener('focus', stampBoth)
      document.addEventListener('visibilitychange', stampBoth)
      document.addEventListener('pointerdown', stampBoth, true)
    }
  }

  if (layoutLockOn(s)) {
    if (!lockTimer) {
      lockTimer = setInterval(() => {
        stampLayoutLock($settings.get())
        /* 兜底：设置弹窗开着时保证那一组是展开的（结构观察器漏了也不会缺） */
        openPluginNavGroup($settings.get())
      }, 1000)
      lockTimer.unref?.()
    }
  } else if (lockTimer) {
    clearInterval(lockTimer)
    lockTimer = 0
  }
}

/* 模型 pill 右边那个箭头（应用原生的 chevron svg）：
   纯 CSS 选择器（`> svg`）一旦应用改了嵌套层级就失效（用户报「箭头又回来了」），
   所以由 JS 按「class 含 chevron / path 是那个 V 形」去找并打标记，标记掉了会被周期补打回来。 */
function stampModelArrow(pill) {
  if (!pill) return

  let svgs = []

  try {
    svgs = Array.from(pill.querySelectorAll('svg'))
  } catch {
    return
  }

  for (const sv of svgs) {
    if (sv.hasAttribute('data-hs-arrow')) continue

    const cls = String(sv.getAttribute('class') || '')
    const path = String(sv.innerHTML || '')

    if (/chevron/i.test(cls) || /[Mm]6\s+9\s*l6\s+6\s*l6\s*-6/.test(path)) sv.setAttribute('data-hs-arrow', '1')
  }
}

/* ── 问询弹窗（澄清问题卡片：已回答 x/x + 选项 + 确认并继续）────────────
   应用里的挂钩点（读源码拿的，不猜）：
     · 面板：[data-slot='clarify-inline']（core/shell.tsx 的 ClarifyShell）
     · 右下角确认按钮：面板内 button[type='submit']（core/confirm-bar.tsx）
     · 选项行：面板内带 aria-keyshortcuts 的 button（core/choice-row.tsx 的 ChoiceButton）
   用户要求：确认按钮与这种选择框都能改成磨砂、可改底板颜色/字体颜色、加圆角。 */
function askCss(s) {
  const wantRadius = Math.max(0, Math.min(40, Number(s.askRadius) || 0))
  const wantBlur = Math.max(0, Math.min(40, Number(s.askBlur) || 0))

  if (!(s.askGlassOn === true || s.askGlowOn !== false || !!s.askBg || !!s.askText || wantRadius > 0)) return ''

  const line = []
  const sub = []
  const opt = []

  if (s.askBg) line.push(`background-color:${s.askBg} !important`)
  if (s.askGlassOn) line.push(`backdrop-filter:blur(${wantBlur}px) saturate(1.08) !important`, `-webkit-backdrop-filter:blur(${wantBlur}px) saturate(1.08) !important`)
  if (wantRadius > 0) line.push(`border-radius:${wantRadius}px !important`)
  if (s.askText) line.push(`color:${s.askText} !important`)
  if (s.askBg) sub.push(`background-color:color-mix(in srgb, ${s.askBg} 80%, var(--ui-accent, #4c7dff)) !important`)
  if (wantRadius > 0) sub.push(`border-radius:${Math.max(4, Math.round(wantRadius * 0.7))}px !important`)
  if (s.askText) sub.push(`color:${s.askText} !important`)
  if (s.askGlassOn) sub.push(`backdrop-filter:blur(${Math.round(wantBlur * 0.6)}px) !important`, `-webkit-backdrop-filter:blur(${Math.round(wantBlur * 0.6)}px) !important`)

  /* 确定按钮：磨砂底 + 内发光（和「选择框」同一套观感，颜色跟着发光色） */
  if (s.askGlowOn !== false) {
    const glow = String(s.segGlowColor || '#4dd0ff')
    const k = Math.max(0, Math.min(100, Number(s.segGlowStrength) || 45))

    sub.push(
      `background-color: color-mix(in srgb, var(--ui-panel, #161a20) 58%, transparent) !important`,
      `backdrop-filter: blur(10px) saturate(1.12) !important`,
      `-webkit-backdrop-filter: blur(10px) saturate(1.12) !important`,
      `border: 1px solid color-mix(in srgb, ${glow} 45%, transparent) !important`,
      `box-shadow: inset 0 0 14px color-mix(in srgb, ${glow} ${k}%, transparent), 0 0 12px color-mix(in srgb, ${glow} ${Math.round(Math.min(30, k * 0.45))}%, transparent) !important`
    )
  }
  if (wantRadius > 0) opt.push(`border-radius:${Math.max(4, Math.round(wantRadius * 0.6))}px !important`)
  if (s.askText) opt.push(`color:${s.askText} !important`)

  return `
/* 问询弹窗面板 */
[data-slot='clarify-inline'] {
  ${line.join(';')}${line.length ? ';' : ''}
}

/* 右下角「确认并继续」 */
[data-slot='clarify-inline'] button[type='submit'] {
  ${sub.join(';')}${sub.length ? ';' : ''}
}

/* 选项行 */
[data-slot='clarify-inline'] button[aria-keyshortcuts] {
  ${opt.join(';')}${opt.length ? ';' : ''}
}
`
}

function modelArrowCss(s) {
  if (s.hideModelPillArrow === false) return ''

  return `
/* 模型 pill 右边的箭头：应用原生的 chevron-down svg（插件只把模型名写进它内部的 span）。
   它原来是打开模型/强度弹窗的入口，强度已挪到独立的推理强度弹窗 → 藏掉箭头，
   pill 本身照旧可点、模型名照旧显示。 */
[data-hs-arrow='1'],
[data-tour='model-pill'] > svg,
[data-tour='model-pill'] svg[class*='chevron'] {
  display: none !important;
}
`
}

function layoutLockCss(s) {
  if (layoutLockOn(s) === false) return ''

  return `
/* 锁定的拖动把手：不显示抓取光标、不吃指针（把手内部的可点元素要放回来） */
[data-hs-locked="1"] {
  cursor: default !important;
  pointer-events: none !important;
}

[data-hs-locked="1"] :is(button, a, input, textarea, select, [role='button'], [data-slot='tooltip-trigger']) {
  pointer-events: auto !important;
}
`
}

function syncTimerBar(s) {
  if (typeof document === 'undefined') return

  if (s.timerBarOn !== true && s.runFlowOn !== true) {
    if (timerBarTimer) {
      clearInterval(timerBarTimer)
      timerBarTimer = 0
    }

    if (timerBarObserver) {
      timerBarObserver.disconnect()
      timerBarObserver = null
    }

    for (const el of document.querySelectorAll('.hs-timer-bar')) el.classList.remove('hs-timer-bar')
    for (const el of document.querySelectorAll(RUN_TEXT_SEL)) el.removeAttribute('data-hs-run-text')

    return
  }

  tickTimerBar(s)

  if (!timerBarTimer) {
    timerBarTimer = setInterval(() => tickTimerBar($settings.get()), 1000)
    /* node 里（冒烟测试）不挂住进程；浏览器里 unref 不存在，可选链直接跳过 */
    timerBarTimer.unref?.()
  }

  if (!timerBarObserver && typeof MutationObserver === 'function') {
    /* ⚠️ 聊天区流式输出时每一小段文字都是 characterData 变动 → 这个回调每秒能触发几十次。
       **但不能做时间合并**：实测应用每秒都会把计时元素整个重建一次（新的节点没有我们的类，
       字号 8.96px 会露出 1~2 帧 = 用户说的「跳数字」）。观察器回调发生在绘制之前，
       只要这一遍足够便宜（现在只查 tabular-nums 那几颗计时，微秒级），
       就能在同一帧里把类补上，既不闪数字、也没有掉帧。 */
    timerBarObserver = new MutationObserver(() => {
      try {
        tickTimerBar($settings.get())
      } catch {
        /* 回调里的异常绝不能外泄 */
      }
    })
    timerBarObserver.observe(document.body, { childList: true, subtree: true, characterData: true })
  }
}

function timerBarCss(s) {
  /* 思考方块那边（timerBarOn）和新的「运行状态条」（runFlowOn）共用这段 CSS：
     任一边开着都要输出 —— 否则开着 runFlowOn 时 .hs-timer-bar 会把计时文字隐藏掉，
     却没有任何进度条（计时直接不见了）。 */
  if (s.timerBarOn !== true && s.runFlowOn !== true) return ''

  const preset = FLOW_PRESETS[s.flowPreset] || FLOW_PRESETS.rainbow
  const numOr = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback)
  const width = Math.max(1.5, Math.min(14, numOr(s.timerBarWidth, 5.2)))
  const height = Math.max(0.16, Math.min(1.2, numOr(s.timerBarHeight, 0.42)))
  const radius = Math.max(0, Math.min(999, numOr(s.timerBarRadius, 999)))
  const speed = Math.max(0.2, Math.min(4, numOr(s.flowSpeed, 1)))
  const power = Math.max(0, Math.min(100, numOr(s.flowIntensity, 70))) / 100
  const seconds = (3.2 / speed).toFixed(2)
  const stops = preset.stops.join(', ')
  /* 底槽（灰白轨道）。用户要求「只显示进度、不用显示整个进度条」→ 默认透明，
     关掉时整条只剩最左边那段彩色填充。 */
  const track = s.timerBarTrack === true ? `rgba(255, 255, 255, ${(0.10 + power * 0.10).toFixed(3)})` : 'transparent'

  /* 形状选择器：StableText 的特征 = 每个字符包一层 1ch 宽的 span，用纯 CSS 认它。
     作用域只认**应用自己的语义属性**（data-slot），绝不用自己加的类或属性：
     实测应用每秒都会替换/重写那个计时元素（211 帧里类丢了 9 次），而我给自己行打的标记
     又会被清理逻辑来回摘 —— 两者叠加就会出现「几十帧完全没样式」= 用户说的残余闪动。
     思考行（timerBarOn）与工具行（runFlowOn）分成两组，各自跟自己的开关；
     工具行那组显式排除思考两行 —— 否则单开 runFlowOn 时思考行会被上样式却没有进度值，僵在 0%。
     写法坑：::before 必须写成「选择器::before, 选择器::before」，不能写成「A, B::before」。 */
  const thinkRows = "[data-slot='aui_turn-activity'], [data-slot='aui_response-loading']"
  const runRows = "[data-slot='tool-block'], [data-conversation-scaffold]:not([data-slot='aui_turn-activity']):not([data-slot='aui_response-loading']), [data-slot='status-row']"
  /* ⚠️ 形状判据必须**收紧到只可能命中真计时**：
     「有直接子节点是 1ch 字符 span」这种写法会命中**整行容器**（行的直接子节点里也有 StableText），
     于是整行被套上进度条样式（定宽 + 字号归零 + overflow hidden）—— 行首冒出 83px 的渐变长方形、
     行内文字与箭头被挤位。改成「**直接子节点全部都是 1ch 字符 span**」：
     真计时的子节点就是逐字符格子，而行容器必有别的子节点。再显式排除行首转圈方块。 */
  /* ⚠️ 彻底废弃「用 CSS 形状去认应用元素」这条路：它的作用域再收窄，只要落在一个「标记过的行」里，
     就还会命中行内其它逐字符渲染的文字（气泡里的思考文字、行首标签…）→ 那些元素上冒出 ::before
     （用户看到的就是行首一条小杠、气泡左上角的进度残影）。错误率太高，不再使用。
     改为：**JS 精确找到计时后，给「计时自己的父节点」和计时自身打标记**（父节点只装着计时这一个元素时
     才标记），CSS 只认这两个标记 —— 结构上不可能误伤别的元素。父节点通常比计时元素更稳定，
     应用每秒替换里面那个逐字符节点时，父节点上的标记还在，样式当帧就在，也就不会再露数字。 */
  const shape = '[data-hs-clock-wrap] > *, [data-hs-clock]'
  /* ⚠️ 逗号选择器组 + 后缀的经典坑（这个坑已经造成两次用户可见的回归）：
     `${shape}::before` 只会把 ::before 加到**最后一段**，前几段于是把 ::before 的声明
     （绝对定位 + 渐变背景）套到**元素本身**上 —— 表现成「方块上多一条小杠」「气泡左上角出现进度残影」。
     所以 ::before 那份选择器必须**每一段自己带后缀**，单独生成。 */
  const shapeBefore = '[data-hs-clock-wrap] > *::before, [data-hs-clock]::before'

  return `
/* 秒数 → 彩色流光进度条。宽度固定，所以满进度也不会越界。
   第一份选择器是 JS 补的类（保留作兜底），第二份是上面那条纯 CSS 形状选择器 ——
   元素被重建也当帧就有样式，不必等 JS 把类补回来。 */
.hs-timer-bar,
${shape} {
  position: relative;
  display: inline-block !important;
  flex: 0 0 auto;
  width: ${width.toFixed(2)}rem !important;
  height: ${height.toFixed(2)}rem;
  border-radius: ${radius}px;
  background: ${track};
  overflow: hidden;
  vertical-align: middle;
  /* 文字留着（无障碍/复制得到），但看不见 —— 用字号归零，逐字 span 的 1ch 宽度也跟着归零 */
  font-size: 0 !important;
  line-height: 0 !important;
  letter-spacing: 0 !important;
  text-indent: 0 !important;
}

.hs-timer-bar::before,
${shapeBefore} {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: var(--hs-timer-pct, 0%);
  border-radius: inherit;
  background-image: linear-gradient(115deg, ${stops});
  /* 关键：渐变必须**铺满当前填充宽度**。原来用 300% 宽 + no-repeat，
     动画把渐变一路滑出元素 → 整条彩色"漏光"变空，3.2 秒后又滑回来，
     就成了用户看到的「满→0→满」反复。改用色相旋转做流动感（和流光文字同一招）。 */
  background-size: 100% 100%;
  background-repeat: no-repeat;
  /* 外发光按用户要求去掉（进度条只留一条干净的彩色填充，不要光晕）。 */
  /* ⚠️ 绝对不要给宽度加过渡：应用每秒都会换掉这个计时元素，新元素的 ::before 在浏览器眼里
     「初始宽度 = 0」，于是过渡会**每秒从 0 补到当前值** —— 用户看到的就是「进度每秒跳一下」。
     去掉过渡后，新元素直接以正确宽度渲染（每秒只前进约 0.8px，看不出台阶），
     流动感交给色相旋转那条动画。 */
  transition: none;
  animation-name: hs-bar-hue !important;
  animation-duration: ${(7 / speed).toFixed(2)}s !important;
  animation-timing-function: linear !important;
  animation-iteration-count: infinite !important;
  animation-direction: normal !important;
}

/* 进度条的流动感：色相原地转一圈（渐变不移动，所以永远不会漏光变空） */
@keyframes hs-bar-hue {
  0% { filter: hue-rotate(0deg) saturate(${(1 + power * 0.6).toFixed(2)}); }
  100% { filter: hue-rotate(360deg) saturate(${(1 + power * 0.6).toFixed(2)}); }
}
`
}

/* ── 侧栏底部功能行：收起 / 展开 ──────────────────────────────────────
   应用留了正规入口：往 `sidebarNav.prefs` 区贡献 `{ hide: [行 id] }`，
   由应用在渲染时合并（见 apps/desktop/src/store/sidebar-nav.ts）。
   两个好处：① 不是硬藏 DOM，行根本不参与渲染；② 这份贡献跟着插件走 ——
   插件被禁用 / 重载时贡献被回收，行自己就回来了。

   行 id（应用自己的）：new-session / capabilities / messaging / artifacts / cron。
   ⚠️ `capabilities`（技能与工具）应用规定**永不隐藏**（它是插件入口，
   藏了用户就没路关插件），所以那一行只能用 CSS 收起来。 */
const SIDEBAR_NAV_PREFS_AREA = 'sidebarNav.prefs'
const SIDEBAR_NAV_HIDE = ['new-session', 'messaging', 'artifacts', 'cron']

let sidebarNavDispose = null
let sidebarNavRegistered = false

function syncSidebarNav(s) {
  const on = s.navCollapseOn === true

  if (sidebarNavDispose) {
    try {
      sidebarNavDispose()
    } catch {
      /* 回收失败就算了，下一次注册会覆盖 */
    }

    sidebarNavDispose = null
  }

  if (!on) {
    sidebarNavRegistered = false

    return
  }

  try {
    const dispose = ctxRef?.register?.({
      area: SIDEBAR_NAV_PREFS_AREA,
      data: { hide: [...SIDEBAR_NAV_HIDE] },
      id: 'sidebar-nav-collapse'
    })

    sidebarNavDispose = typeof dispose === 'function' ? dispose : null
    sidebarNavRegistered = true
  } catch {
    /* 应用不接受这个区（或旧版本没有这个机制）→ 退回纯 CSS 收起。
       宁可多收一行，也不要用户开了开关却什么都没发生。 */
    sidebarNavRegistered = false
  }
}

/* ── 侧栏那一组功能行旁边的折叠箭头 ──────────────────────────────────
   用户要求：在左上角会话区**单独加一个箭头**，点它把这 5 行收起来，再点展开。
   做法：把按钮插进那一组的容器里（`<ul>` 前面），点击只改 `navCollapseOn` ——
   和设置页那个开关走同一条路，所以两边永远同步。 */
const NAV_TOGGLE_ID = 'hermes-nav-toggle'
const NAV_CHEVRON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6.4 L8 10.4 L12 6.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'

/** 那一组功能行的 `<ul>`（应用自己的标记：行内 span 带 `sidebar-nav-` 前缀）。 */
function navGroupList() {
  const item = typeof document === 'undefined' ? null : document.querySelector("[data-tour^='sidebar-nav-']")

  return item ? item.closest('ul') : null
}

function navToggleClick(event) {
  event.preventDefault()
  event.stopPropagation()

  const s = $settings.get()

  update({ navCollapseOn: s.navCollapseOn !== true })
}

function syncNavToggle(s) {
  if (typeof document === 'undefined') return
  /* 只在主窗口出现（宠物浮层/快捷输入窗没有 contrib shell） */
  if (!document.querySelector('[data-contrib-shell]')) return

  const ul = navGroupList()

  if (!ul || !ul.parentElement) return

  let el = document.getElementById(NAV_TOGGLE_ID)

  if (!el) {
    el = document.createElement('div')
    el.id = NAV_TOGGLE_ID
    el.setAttribute('role', 'button')
    el.setAttribute('tabindex', '0')
  }

  /* ⚠️ React 重渲染可能把按钮挪走或删掉 —— 每次同步都确认位置与监听，
     不能「创建时设一次」（插件重载后旧闭包失效，点了没反应）。 */
  if (el.parentElement !== ul.parentElement || el.nextElementSibling !== ul) {
    ul.parentElement.insertBefore(el, ul)
  }

  if (el.__hsNavToggle !== navToggleClick) {
    if (el.__hsNavToggle) el.removeEventListener('click', el.__hsNavToggle)

    el.__hsNavToggle = navToggleClick
    el.addEventListener('click', navToggleClick)
  }

  const collapsed = s.navCollapseOn === true

  el.classList.toggle('is-collapsed', collapsed)
  el.setAttribute('aria-expanded', collapsed ? 'false' : 'true')
  el.setAttribute('title', collapsed ? '展开这几个功能' : '收起这几个功能')
  el.setAttribute('aria-label', collapsed ? '展开这几个功能' : '收起这几个功能')

  if (el.dataset.hsChevron !== '1') {
    el.innerHTML = NAV_CHEVRON
    el.dataset.hsChevron = '1'
  }
}

/* 侧栏任何一次重渲染（收起 / 展开 / 换路由 / 主题重绘）都会把我们插进去的
   按钮冲掉 —— 而 apply 只在设置变化时跑，所以冲掉之后就**再也不回来**了
   （用户报：「会话那一栏最右侧的收起总开关收起后，会话的收起开关就消失了」）。
   这里挂一个观察器，只要按钮不在位就补回去。 */
let navToggleObserver = null

function watchNavToggle() {
  if (navToggleObserver || typeof MutationObserver !== 'function' || typeof document === 'undefined') return

  let timer = 0

  const check = () => {
    timer = 0

    try {
      const ul = navGroupList()

      if (!ul) return

      const el = document.getElementById(NAV_TOGGLE_ID)

      /* 已经在位就什么都不做 —— 否则「同步本身改动 DOM」会让观察器自己激自己 */
      if (el && el.parentElement === ul.parentElement && el.nextElementSibling === ul) return

      syncNavToggle($settings.get())
    } catch {
      /* 补检里的异常绝不能外泄 */
    }
  }

  /* ⚠️ 用「防抖 + 必定补检一次」而不是「节流丢弃」：这个应用 DOM 变动极频繁
     （每条消息都在动），节流会把「侧栏重渲染」那次直接丢掉 —— 而它往往就是
     最后一条变动，丢掉后箭头就永远不回来了。防抖保证窗口结束后一定补检。 */
  navToggleObserver = new MutationObserver(() => {
    if (timer) return

    timer = setTimeout(check, 60)
  })

  navToggleObserver.observe(document.body, { childList: true, subtree: true })
}

/* 应用自己不让藏的情况：这一格里只有 1 个「主区磁贴」（会话/页面/预览）时，
   strip-visibility.ts 的 stranded() 会**压过**用户的选择强制显示标签条 ——
   理由是标签条是那一格唯一带 ✕（关闭）和 ＋（新建）把手的地方，藏了就成死区。
   所以这里只藏「标签」本身，把手一个不动。 */
function paneTabsCss(s) {
  if (s.hidePaneTabs !== true) return ''

  return `
/* 藏起标签条上的会话标签（[data-zone-tabstrip] 是应用自己的钩子，只在横向标签条上） */

/* ① 标签文字 */
[data-zone-tabstrip] [data-slot='pane-tab'] > .pane-tab-content {
  display: none !important;
}

/* ② 每个标签收成「只有一个 ✕」的窄块，✕ 才有落脚处 */
[data-zone-tabstrip] [data-slot='pane-tab'] {
  width: var(--pane-tab-close-width, 1.5rem) !important;
  min-width: 0 !important;
  max-width: none !important;
}

/* ③ ✕ 常显 —— 它平时只在鼠标悬停时露出来，标签藏了以后根本 hover 不到 */
[data-zone-tabstrip] [data-slot='pane-tab'] > span:has(> button[aria-label]) {
  opacity: 1 !important;
  pointer-events: auto !important;
}

/* ④「有未保存改动」的小圆点跟着藏：没有文字了它没意义，还会压住 ✕ */
[data-zone-tabstrip] [data-slot='pane-tab'] > span[aria-hidden] {
  display: none !important;
}
`
}

/* 模型列表里每一行悬停都会弹出一个子菜单（应用的「思考 / 推理强度 / 快速」）。
   用户要求：模型名不需要再进一步展开 —— 整块去掉。
   ⚠️ 子菜单内容被 Radix 传送到 <body>，不在模型弹窗里，CSS 没法按弹窗作用域选它；
   但可以用 :has() 锁住「模型列表弹窗正开着」这个条件 —— 只认带 data-state='open' 的，
   所以其它菜单的子菜单完全不受影响（同一时刻只有一个菜单链是打开的）。
   ⚠️ 这段**不能**挂在任何功能开关后面：挂在 effortSliderCss 那种带守卫的函数里，
   一旦那个功能关着（默认就是关的）整段就不会输出 —— 那是本轮踩过的坑。 */
/* CSS 产物自检：括号不平衡会让**从出错点往后的所有规则**被解析器丢掉 ——
   表现是「文字上明明有这条规则、cssRules 里却查不到、样式不生效」。
   血例：吸顶那段模板结尾多了一个 `}`，导致它后面整段（含「模型列表行尾 > 」那条）全部失效。
   所以每次组装完都数一遍，不平衡就在控制台报出来（不抛错，避免影响渲染）。 */
function checkCssBraces(css) {
  if (typeof css !== 'string') return true

  let open = 0
  let close = 0
  let inComment = false

  for (let i = 0; i < css.length; i += 1) {
    const two = css.slice(i, i + 2)

    if (!inComment && two === '/*') {
      inComment = true
      i += 1
      continue
    }

    if (inComment && two === '*/') {
      inComment = false
      i += 1
      continue
    }

    if (inComment) continue

    if (css[i] === '{') open += 1
    else if (css[i] === '}') close += 1
  }

  if (open !== close) {
    try {
      console.warn('[hermes-bg] CSS 括号不平衡：{ =', open, '} =', close, '（从失衡点往后的规则会被浏览器丢弃）')
    } catch {}

    return false
  }

  return true
}

function modelSubmenuCss() {
  return `
/* 模型列表：行尾那个「>」提示去掉（不然看起来像还能展开）——旧写法挂在
   dropdown-menu-sub-trigger 上，子菜单去掉后那层就没了、选择器全部落空，现在认 JS 打的标记。 */
[data-hs-menu-arrow='1'],
[data-slot='dropdown-menu-content'][data-hs-menu='1'] [data-slot='dropdown-menu-sub-trigger'] [class*='chevron-right'] {
  display: none !important;
}

/* 悬停弹出的子菜单整个藏掉 —— 只限模型列表弹窗开着的时候 */
body:has([data-slot='dropdown-menu-content'][data-hs-menu='1'][data-state='open']) [data-slot='dropdown-menu-sub-content'] {
  display: none !important;
}
`
}

/* 气泡居中：两边各一个开关，默认都开。
   应用给气泡的是 w-full + max-w-full（满宽），满宽时「居中」根本看不出效果 ——
   所以同时按「最大宽度」收窄（默认 86% / 44rem，与应用自己的说明文字同宽），再水平居中。
   ⚠️ 用户气泡是**列向 flex** 的子项，列容器里 auto margin 不管横向居中（那是主轴方向），
   必须用 align-self: center 才管用 —— 且别去改容器的 align-items（容器里还有悬停动作行，
   改了对齐会把那一行也带偏）。 */
/** 气泡水平位置：只认三种，别的（含老存档里的布尔值）一律当居中。 */
const bubbleAlign = v => (v === 'left' || v === 'right' ? v : 'center')

function bubbleAlignCss(s) {
  const clampW = v => Math.max(40, Math.min(100, Number(v) || 86))

  /* 三态各自的对齐写法：
     - 列向 flex 的子项（我发的气泡就是）靠 align-self；
     - 块级 / 行内上下文靠 auto margin；两个都写，哪边生效都行。
     ⚠️ 不要去改容器的 align-items —— 那个容器里还有悬停才出现的「复制 · 编辑」行。 */
  /* 图片块的位移方向：只写 margin-inline（主轴），不写 align-self ——
     那块图片的父级是横向 flex 行，align-self 管的是纵轴，写了会把它顶高。 */
  const imgPlace = a =>
    a === 'left' ? 'margin-inline: 0 auto !important;'
      : a === 'right' ? 'margin-inline: auto 0 !important;'
      : 'margin-inline: auto !important;'

  const place = a =>
    a === 'left' ? 'align-self: flex-start !important;\n  margin-inline: 0 auto !important;'
    : a === 'right' ? 'align-self: flex-end !important;\n  margin-inline: auto 0 !important;'
    : 'align-self: center !important;\n  margin-inline: auto !important;'

  /* ⚠️ 原来一律 `min(<百分比>%, 44rem)` —— 44rem(≈704px) 这个上限会把靠左/靠右的气泡
     卡在半路，右边空一大片（用户报「靠左时右边还很多空」）。贴边开关打开时，
     非居中的气泡直接铺到 100%（百分比那个滑条只再管居中）。 */
  const edgeOn = s.bubbleEdgeOn !== false
  const rule = (selectors, align, width) => {
    const a = bubbleAlign(align)
    const maxw = edgeOn && a !== 'center' ? '100%' : `min(${clampW(width)}%, 44rem)`

    return `${selectors} {\n  max-width: ${maxw} !important;\n  ${place(a)}\n}`
  }

  const rules = [
    rule(`[data-slot='aui_user-message-root'] .composer-human-message,
[data-slot='aui_user-message-root'] .composer-human-message-container`, s.myBubbleAlign, s.myBubbleWidth),
    rule(`[data-slot='aui_assistant-message-content']`, s.aBubbleAlign, s.aBubbleWidth),
    /* 我发的气泡下面的图片 / 附件：和气泡同位置、同最大宽度（否则气泡居中了、图片还贴在左边） */
    rule(`[data-hs-attachments='1']`, s.myBubbleAlign, s.myBubbleWidth),
    /* 图片本身在附件容器里再居中一次：容器被拉宽时图片不会孤零零贴在左边 */
    `[data-hs-attachments='1'] img, [data-hs-attachments='1'] video {
  margin-inline: auto;
}`,
    /* 用户消息里发出去的图片块：位置**跟着「我发的气泡」走**（靠左 / 居中 / 靠右）。
       ⚠️ 不要给宽度上限 —— 那会把图片缩小（实测图宽 1197px）；
       ⚠️ 也不要写 align-self —— 这块的父级是横向 flex 行，align-self 管纵轴。
       （上一版这里写死了居中，用户把气泡改成靠左后图片还在中间，就是这个原因。） */
    `[data-hs-imgblock='1'] {
  ${imgPlace(s.myBubbleAlign)}
}`
  ]

  return `/* 气泡水平位置（靠左 / 居中 / 靠右，我发的与 Hermes 发的各自可调）*/
${rules.join('\n\n')}
${s.userPinOn === true ? `/* 吸顶开着：应用靠 [data-sticky-prompt-clip] 给「气泡下方的滚动内容」加
   clip-path: inset(钉住高度 0 0) —— 实测 inset(74.67px 0 0)，把 Hermes 那条回复的**顶部整块裁掉**。
   用户看到的就是「一条透明的底板压住他消息最上面，滚动时顶部显示不全」。
   ⚠️ 被裁掉的是**我们的回复**，不是用户自己的气泡；用户明确要求气泡保持玻璃原样、内容不要被切。
   所以这里只做一件事：解除那条裁剪（内容改为从半透明气泡下面滑过去）。 */
[data-sticky-prompt-clip] {
  clip-path: none !important;
}` : `/* 吸顶关掉：应用把用户那一行做成 sticky（滚到顶部钉住、盖住下面滚过的内容），
   这一项把它还原成普通流 —— 气泡跟着内容一起滚走，不会有任何东西压住下面的消息。 */
[data-slot='aui_user-message-root'] {
  position: static !important;
}`}
`
}

/* 输入框圆角：只跟「圆角」滑块走，和玻璃开关完全无关。
   ⚠️ 以前这个圆角只写在玻璃那套 CSS 里，玻璃一关圆角就没了 —— 用户报「输入框圆角设置失效」。
   独立成一条：任何情况下都输出（默认 16px 与应用原本一致，等于不改）。 */
function composerRadiusCss(s) {
  const r = Math.max(0, Math.min(60, Number(s.lgxRadius) || 0))

  if (r <= 0) return ''

  return `/* 输入框圆角（独立于玻璃开关）*/
[data-slot='composer-surface'] {
  border-radius: ${r}px !important;
}
`
}

/* 消息里的图片 / 附件 **不在气泡里面**，是气泡的兄弟节点（应用把 attachments 和气泡并列渲染），
   所以「气泡位置」那条规则管不到它 —— 用户报「消息框发送的图片没有居中」就是这个原因。
   这里给附件容器打标记，CSS 再按同一套位置/宽度对齐它。
   怎么认：用户消息的**直接子元素**里，跳过气泡外框那个（它带 group/user-message 类），
   余下「含图片 / 视频 / 附件」的那个就是 —— 不认类名，所以应用改版也不会失效。 */
/**
 * 用户气泡是否正被吸顶钉住。
 * 判据：它的**可滚动祖先**滚过之后，气泡自己的视口 top 已经贴到那个祖先的顶部。
 * 应用给用户气泡的是 sticky + z-40，钉住时它会盖在下面滚过去的内容上。
 */
function userPinScroller(el) {
  let sc = el.parentElement

  while (sc && sc !== document.body) {
    const cs = getComputedStyle(sc)

    if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && sc.scrollHeight > sc.clientHeight + 4) return sc
    sc = sc.parentElement
  }

  return null
}

function syncUserPin() {
  if (typeof document === 'undefined') return

  const s = $settings.get()
  /* 只有「去掉我发的消息气泡的黑底」开了才需要垫 —— 没开时应用自己的底还在 */
  const need = s.userBubbleClear === true

  for (const el of document.querySelectorAll("[data-slot='aui_user-message-root']")) {
    let pinned = false

    if (need) {
      const sc = userPinScroller(el)

      if (sc) {
        const r = el.getBoundingClientRect()
        const top = sc.getBoundingClientRect().top

        pinned = sc.scrollTop > 2 && r.top - top <= 1.5
      }
    }

    if (pinned) el.setAttribute('data-hs-pinned', '1')
    else el.removeAttribute('data-hs-pinned')
  }
}

/* 滚动 / 改尺寸时更新（passive + rAF 合并：滚动事件很密，别每次跑选择器） */
let userPinRaf = 0
function scheduleUserPin() {
  if (userPinRaf) return
  userPinRaf = requestAnimationFrame(() => {
    userPinRaf = 0
    safeSync('吸顶垫底', syncUserPin)
  })
}

function syncBubbleAttachments() {
  if (typeof document === 'undefined') return

  const marked = new Set()

  /* 用户发出去的图片 / 视频挂在这一支上（实测结构）：
       div.flex.flex-wrap（满宽） > span[data-slot='aui_directive-text']（内容宽）
         > span[data-slot='aui_embedded-images'] > span[data-slot='aui_directive-image'] > img
     ⚠️ 它**不在** [data-slot='aui_user-message-root'] 里面（那个节点只是气泡外层的 sticky 壳，
     唯一子元素是动作行）—— 之前按「消息根的直接子元素」扫，一个都匹配不到，所以没生效。 */
  for (const el of document.querySelectorAll("[data-slot='aui_directive-text']")) {
    if (!el.querySelector || !el.querySelector('img, video')) continue

    el.setAttribute('data-hs-imgblock', '1')
    marked.add(el)
  }

  /* 旧路径（附件和气泡并排的那种）保留，匹配不到就自然跳过 */
  for (const root of document.querySelectorAll("[data-slot='aui_user-message-root']")) {
    for (const child of root.children || []) {
      if (!child || child.nodeType !== 1) continue
      if (String(child.className || '').includes('group/user-message')) continue
      if (typeof child.querySelector !== 'function') continue

      const hasMedia = Boolean(child.querySelector('img, video, canvas, picture'))
      const isAttachmentSlot = /attachment/i.test(String(child.getAttribute('data-slot') || ''))

      if (!hasMedia && !isAttachmentSlot) continue

      child.setAttribute('data-hs-attachments', '1')
      marked.add(child)
    }
  }

  /* 清残留 */
  for (const el of document.querySelectorAll('[data-hs-attachments="1"], [data-hs-imgblock="1"]')) {
    if (!marked.has(el)) {
      el.removeAttribute('data-hs-attachments')
      el.removeAttribute('data-hs-imgblock')
    }
  }
}

/** 一行「磨砂颜色」：色板 + 自定义 + 跟随主题（和「文字颜色」那行同一套写法）。 */
function lgxTintRow(s, update, key, title, description) {
  return jsx(ListRow, {
    action: jsxs('div', {
      className: 'flex items-start gap-4',
      children: [
        jsx(ColorSwatches, {
          clearLabel: '跟随主题',
          onChange: color => update({ [key]: color }),
          swatches: LGX_TINT_SWATCHES,
          value: s[key] || null
        }),
        jsxs('label', {
          className: 'flex items-center gap-2 text-xs text-(--ui-text-tertiary)',
          children: [
            jsx('input', {
              onChange: event => update({ [key]: event.target.value }),
              type: 'color',
              value: s[key] || '#1b2330'
            }),
            '自定义'
          ]
        })
      ]
    }),
    description,
    title
  })
}

/** 折叠箭头的样式（插在侧栏那一组功能行上方，右对齐）。 */
function navToggleCss() {
  return `
/* 侧栏功能行的折叠箭头 */
#${NAV_TOGGLE_ID} {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  height: 16px;
  margin: 0 4px 2px;
  border-radius: 6px;
  color: var(--ui-text-tertiary, #9aa4b2);
  cursor: pointer;
  opacity: 0.5;
  transition: opacity 0.15s, background-color 0.15s;
}

#${NAV_TOGGLE_ID}:hover {
  opacity: 1;
  background-color: color-mix(in srgb, currentColor 14%, transparent);
}

#${NAV_TOGGLE_ID} svg {
  width: 14px;
  height: 14px;
  transition: rotate 0.18s;
}

/* 收起后箭头转向右边（↓ → →） */
#${NAV_TOGGLE_ID}.is-collapsed svg {
  rotate: -90deg;
}
`
}

/** 收起侧栏那一组功能行。
    - 走应用机制成功时，只收 `capabilities`（技能与工具）那一行 —— 应用规定它不能隐藏；
    - 应用机制不可用（旧版本 / 注册被拒）时，CSS 把 5 行全收起来当兜底。 */
function sidebarNavCss(s) {
  if (s.navCollapseOn !== true) return ''

  const collapse = sel => `[data-tour='sessions-sidebar'] li:has(> * [data-tour='sidebar-nav-${sel}'])`

  /* 兜底：应用机制没生效时把这几行也一起收掉（只在注册失败时输出） */
  const fallback = sidebarNavRegistered
    ? ''
    : SIDEBAR_NAV_HIDE.map(id => `${collapse(id)},`).join('\n') + '\n'

  return `
/* 收起侧栏底部功能行（只收外观、不挡点击，需要时照样点得到） */
${fallback}${collapse('capabilities')} {
  max-height: 0 !important;
  min-height: 0 !important;
  overflow: hidden !important;
  opacity: 0 !important;
  padding-block: 0 !important;
  margin-block: 0 !important;
}
`
}

/* ── 角落挂绳（下拉一下打开设置页 / 左键拖住左右换位置）───────────────
   图片是用火山（豆包 seedream）生成的二次元中国结挂绳：白底用 ffmpeg colorkey
   抠成透明 PNG，再裁到内容包围盒并缩到 120px 宽 —— 不裁的话那大片透明区域
   会把右上角的按钮全挡住（img 的透明部分照样吃鼠标）。

   交互（用户要求）：
   · 左键按住左右拖 → 换位置，松手记住；
   · **往下拽超过阈值 → 才**打开本插件的设置页；
   · 单击**不**触发（用户明确要求：必须拉一下，不能点一下就进去）。
   往下拽的过程绳子会跟手下移一段（拉到阈值前松手会弹回），算给用户的反馈。
   ─────────────────────────────────────────────────────────────── */
const ROPE_ID = 'hermes-corner-rope'
const ROPE_SRC = 'data:image/png;base64,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' /* 内联的绳子图（原 assets/rope3-ui.png）：插件不再依赖任何本机文件 */
const ropeDrag = { on: false, moved: false, movedX: false, sx: 0, sy: 0, startLeft: 0, pulled: 0 }
/* 下拉多少像素才算「拉一下」；以及拖动过程中绳子跟手下移的系数与上限。
   跟手位移**必须以「屏外还藏着多少」为上限** —— 否则一拉就把整根拽出来，
   用户一眼就能看出绳子有多长（用户明确要求：拉动时必须留一点在外面）。 */
const ROPE_PULL_TRIGGER = 40
const ROPE_PULL_FOLLOW = 0.38
const ROPE_PULL_MAX = 46
/* 拉动过程中，屏外**至少**要保留的隐藏量（取「固定下限」与「原隐藏量的 35%」较大者） */
const ROPE_MIN_HIDDEN_PX = 8
const ROPE_MIN_HIDDEN_RATIO = 0.35

/** 这根绳子当前藏在屏外多少像素（= 元素高度 × 屏幕外比例）。 */
function ropeHiddenPx(el, s) {
  const height = Number(el?.offsetHeight) || 0
  const pct = Math.max(0, Math.min(60, Number(s?.ropeOffscreen) || 0))

  return (height * pct) / 100
}

function ropeEl() {
  return typeof document === 'undefined' ? null : document.getElementById(ROPE_ID)
}

function ropeOpenSettings() {
  try {
    host.navigate(pluginSettingsHref(ID))
  } catch {
    /* 打不开就算了，别把 apply 带崩 */
  }
}

function ropeCss(s) {
  if (s.ropeOn !== true) return ''

  const sway = Math.max(0, Math.min(20, Number(s.ropeSway) || 0))

  return `
/* 挂绳：从上边缘垂下来，轻轻摆动（二次元那味儿）。动画用长写属性 + !important，
   否则会被应用那条全局 prefers-reduced-motion 规则压成 0.01ms 停住。 */
#${ROPE_ID} {
  position: fixed;
  /* 顶住窗口左上角：top:0 + 向上平移「屏幕外比例」——用 translate 的百分比
     （相对元素自身高度），所以绳子越长露在屏幕外的那截也按比例变长。 */
  top: 0;
  left: ${Math.max(0, Number(s.ropeLeft) || 0)}px;
  translate: 0 -${Math.max(0, Math.min(60, Number(s.ropeOffscreen) || 0))}%;
  z-index: 2147482700;
  transform-origin: 50% 0;
  cursor: grab;
  touch-action: none;
  user-select: none;
  -webkit-user-drag: none;
  filter: drop-shadow(0 4px 7px rgba(0, 0, 0, 0.38));
  animation-name: hs-rope-sway !important;
  animation-duration: 4.6s !important;
  animation-timing-function: ease-in-out !important;
  animation-iteration-count: infinite !important;
  animation-direction: normal !important;
}

#${ROPE_ID}:active {
  cursor: grabbing;
}

/* 下拉过程中：稍微放大一点 + 阴影加重，配合跟手位移给「正在拉」的手感 */
#${ROPE_ID}.hs-rope-pulling {
  filter: drop-shadow(0 10px 14px rgba(0, 0, 0, 0.5));
}

@keyframes hs-rope-sway {
  0%, 100% { rotate: -${sway}deg; }
  50% { rotate: ${sway}deg; }
}
`
}

/** 挂绳自检：把元素是否存在、矩形、可点性回传（排查「拉绳没反应」用）。 */
function ropeReport() {
  try {
    if (typeof fetch !== 'function') return

    const el = ropeEl()
    const rect = el?.getBoundingClientRect?.()
    const cs = el ? getComputedStyle(el) : null

    fetch('http://127.0.0.1:8791/open', {
      body: JSON.stringify({
        rope: el ? 'yes' : 'none',
        rect: rect ? `${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}` : '-',
        pe: cs?.pointerEvents || '-',
        z: cs?.zIndex || '-',
        bound: el?.__hsRopeDown === ropeDown,
        t: Date.now(),
        v: EFFORT_BUILD
      }),
      headers: { 'Content-Type': 'text/plain' },
      method: 'POST'
    }).catch(() => {})
  } catch {
    /* 排障通道 */
  }
}

function ropeApplyPos(s, left) {
  const el = ropeEl()

  if (!el) return

  el.style.left = `${Math.round(left)}px`
}

function syncRope(s) {
  if (typeof document === 'undefined') return
  /* 只在主窗口出现（宠物浮层/快捷输入窗没有 contrib shell） */
  if (!document.querySelector('[data-contrib-shell]')) return

  const on = s.ropeOn === true
  let el = ropeEl()

  if (!on) {
    if (el) el.remove()

    ropeDrag.on = false

    return
  }

  if (!el) {
    el = document.createElement('img')
    el.id = ROPE_ID
    el.draggable = false
    el.alt = ''
    document.body.appendChild(el)
  }

  /* ⚠️ 每次同步都重新绑定：挂绳元素在插件重载时**不会被清掉**（一直留在 DOM 里），
     若只在创建时绑一次，它就一直调用**旧版本模块**里的闭包（旧 ctx 已失效）
     → 用户报「拉绳不起作用了」。 */
  if (el.__hsRopeDown !== ropeDown) {
    if (el.__hsRopeDown) el.removeEventListener('pointerdown', el.__hsRopeDown)

    el.__hsRopeDown = ropeDown
    el.addEventListener('pointerdown', ropeDown)
  }

  /* src 必须每次同步都校正，不能只在创建时设一次：插件重新加载时元素**还留在
     DOM 里**（插件不会清掉自己建的元素），于是永远走「已存在」这条路 ——
     换了素材图也不会更新，用户看到的就是「为什么没有更换」。 */
  if (el.getAttribute('src') !== ROPE_SRC) el.setAttribute('src', ROPE_SRC)

  const width = Math.max(6, Math.min(120, Number(s.ropeWidth) || 12))
  const maxLeft = Math.max(0, window.innerWidth - width - 8)
  const left = Math.max(0, Math.min(maxLeft, Number(s.ropeLeft) || 0))

  el.style.width = `${width}px`
  el.style.height = 'auto'
  /* 垂直方向**锁死**：上端始终有一部分在窗口之外（用户明确要求「不能一拖就出来」）。
     写成行内，任何拖拽/重算都不会把它弄丢。 */
  el.style.translate = `0 -${Math.max(10, Math.min(90, Number(s.ropeOffscreen) || 75))}%`
  ropeApplyPos(s, left)
  ropeReport()
}

function ropeDown(event) {
  if (event.button !== 0) return

  const s = $settings.get()
  const el = ropeEl()

  if (!el || s.ropeOn !== true) return

  event.preventDefault()
  event.stopPropagation()

  const width = Math.max(6, Math.min(120, Number(s.ropeWidth) || 12))

  ropeDrag.on = true
  ropeDrag.moved = false
  ropeDrag.movedX = false
  ropeDrag.pulled = 0
  ropeDrag.sx = event.clientX
  ropeDrag.sy = event.clientY
  ropeDrag.startLeft = Math.max(0, Math.min(Math.max(0, window.innerWidth - width - 8), Number(s.ropeLeft) || 0))

  try {
    el.setPointerCapture(event.pointerId)
  } catch {
    /* 捕获不到也不影响：move/up 挂在 window 上 */
  }

  rebindGlobal(window, 'rope', 'pointermove', ropeMove, true)
  rebindGlobal(window, 'rope', 'pointerup', ropeUp, true)
  rebindGlobal(window, 'rope', 'pointercancel', ropeUp, true)
}

function ropeMove(event) {
  if (!ropeDrag.on) return

  const s = $settings.get()
  const width = Math.max(6, Math.min(120, Number(s.ropeWidth) || 12))
  const dx = event.clientX - ropeDrag.sx
  const dy = event.clientY - ropeDrag.sy

  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) ropeDrag.moved = true

  /* 只有**横向**真的动过才值得保存位置 —— 竖直下拉/抖一下不该写存储 */
  if (Math.abs(dx) > 3) ropeDrag.movedX = true

  ropeDrag.pulled = Math.max(ropeDrag.pulled, dy)

  /* 只横向移动：往右拖 = 往右挪（left 变大）。
     垂直方向**不真的换位置**（绳子始终有一部分在屏幕外），只按下拉距离
     跟手下移一小段当反馈 —— 松手会归位（见 ropeUp）。 */
  const maxLeft = Math.max(0, window.innerWidth - width - 8)
  const left = Math.max(0, Math.min(maxLeft, ropeDrag.startLeft + dx))
  const el = ropeEl()

  ropeApplyPos(s, left)

  if (el) {
    /* 上限 = 屏外隐藏量 − 至少要留的隐藏量。这样无论拉多狠，
       屏外始终留着一截，看不出绳子到底多长。 */
    const hidden = ropeHiddenPx(el, s)
    const keep = Math.max(ROPE_MIN_HIDDEN_PX, hidden * ROPE_MIN_HIDDEN_RATIO)
    const maxFollow = Math.max(0, hidden - keep)
    const follow = Math.max(0, Math.min(ROPE_PULL_MAX, ropeDrag.pulled * ROPE_PULL_FOLLOW, maxFollow))

    el.style.top = `${follow.toFixed(1)}px`
    /* 提示按**拉动距离**给，不按位移 —— 屏外藏得少时位移可能是 0，
       但用户确实在拉，必须让他看到反馈。 */
    el.classList.toggle('hs-rope-pulling', ropeDrag.pulled > 2)
  }
}

function ropeUp() {
  if (!ropeDrag.on) return

  const s = $settings.get()

  ropeDrag.on = false
  window.removeEventListener('pointermove', ropeMove, true)
  window.removeEventListener('pointerup', ropeUp, true)
  window.removeEventListener('pointercancel', ropeUp, true)

  const el = ropeEl()

  /* 先把跟手位移归位（无论走哪条分支） */
  if (el) {
    el.style.top = '0px'
    el.classList.remove('hs-rope-pulling')
  }

  /* 只有**往下拽够长**才算「拉一下」→ 打开设置页。
     单击、以及只左右拖都不触发（用户明确要求：不能点一下就进插件）。 */
  if (ropeDrag.pulled >= ROPE_PULL_TRIGGER) {
    ropeOpenSettings()

    return
  }

  if (el && ropeDrag.movedX) update({ ropeLeft: Math.round(parseFloat(el.style.left) || 0) })
}

/* 挂绳的设置行 */
function ropeRows(s) {
  const rng = (key, min, max, step, text, description, title) =>
    jsx(ListRow, {
      action: jsxs('div', {
        className: 'flex w-full items-center gap-3',
        children: [
          jsx('input', {
            className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
            max, min,
            onChange: event => update({ [key]: Number(event.target.value) }),
            step, type: 'range', value: s[key]
          }),
          jsx('span', {
            className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
            children: text
          })
        ]
      }),
      description,
      title
    })

  return [
    jsx(ListRow, {
      action: jsx(SegmentedControl, {
        onChange: id => update({ ropeOn: id === 'on' }),
        options: [
          { id: 'off', label: '不显示' },
          { id: 'on', label: '显示' }
        ],
        value: s.ropeOn === true ? 'on' : 'off'
      }),
      description: '左上角一根绳：下拉开设置，拖动换位。',
      title: '挂绳快捷开关'
    }),

    rng('ropeLeft', 0, 1200, 4, `${s.ropeLeft} px`, '绳子离窗口左边的距离。', '水平位置'),
    rng('ropeWidth', 6, 120, 2, `${s.ropeWidth} px`, '绳子的粗细。', '粗细'),
    rng('ropeOffscreen', 10, 90, 5, `${s.ropeOffscreen} %`, '上端垂在窗口外的比例。', '屏幕外比例'),
    rng('ropeSway', 0, 20, 1, `${s.ropeSway}°`, '左右摆动的幅度。', '摆动幅度')
  ]
}

/* ── 推理滑条：弹窗里「模型 + 推理强度」一行、滑条拖动改等级、下方三个模型动作 ──
   应用原本的推理等级是一串 Radix 单选行：
     [data-slot='dropdown-menu-content'] > [data-slot='dropdown-menu-radio-group']
       > [role='menuitemradio']   ← 文案「最小/低/中/高/极高/最高/超高」
   这些行带 onSelect={e => e.preventDefault()} —— **选完弹窗不会关**，滑条可连续拖。

   做法：弹窗出现时把原生单选组藏起来（留在 DOM 里，改设置还得点它），原位插入
   自己的 UI；拖动/点击 → 按下标去点对应原生单选行 → 应用自己写会话设置。
   等级数量与顺序**全部现读 DOM**，不写死。

   滑条视觉：每级一个「左暗右亮」渐变 + 一层**无缝平铺**的银河闪点/流光，
   动画只平移 background-position 一个平铺宽度 → 循环无缝、永远不会「漏光变空」。
   ─────────────────────────────────────────────────────────────────── */
const EFFORT_POPUP = "[data-slot='dropdown-menu-content']"
/* 应用的「思考」行同时出现在**两处**：输入框那个推理强度弹窗，以及
   **模型列表里每一行悬停弹出的子菜单**（`model-catalog-menu.tsx` 的 per-row submenu，
   容器是 `dropdown-menu-sub-content`；两边渲染的是同一个 ModelOptionsContent）。
   用户要求：模型列表里那一块整块去掉，只保留推理强度弹窗里的。 */
const EFFORT_POPUP_OR_SUB = "[data-slot='dropdown-menu-content'], [data-slot='dropdown-menu-sub-content']"
const EFFORT_GROUP = "[data-slot='dropdown-menu-radio-group']"
const EFFORT_ITEM = "[role='menuitemradio']"
const EFFORT_WRAP_ID = 'hermes-effort-slider'
const MENU_WRAP_ID = 'hermes-effort-inmenu'
/** 版本标记：显示在弹窗诊断行里，截图即可确认应用到底加载到哪一版 */
const EFFORT_BUILD = 'v548'

/* 一次性迁移：旧的「输入框磨砂」(frostOn) 已废弃（它的深色填充就是输入框黑线的来源），
   已存的 true 会继续生成旧样式，第一次跑到这里时关掉。 */
try {
  const migKey = 'hs.frostOnRetire1'

  if (typeof localStorage !== 'undefined' && !localStorage.getItem(migKey)) {
    localStorage.setItem(migKey, '1')

    const cur = $settings.get()

    if (cur.frostOn === true) $settings.set({ ...cur, frostOn: false })
  }
} catch {
  /* 迁移失败不影响使用 */
}

/* 一次性迁移：几个圆角滑条的上限收窄了（原来上限远大于「圆头」所需的半径，
   拉一半就满，用户报「幅度有问题」）。把已存下来的超限值收进新范围，
   免得滑条显示 24 而实际样式还是 60。 */
try {
  const migKey = 'hs.radiusMaxFix1'

  if (typeof localStorage !== 'undefined' && !localStorage.getItem(migKey)) {
    localStorage.setItem(migKey, '1')

    const caps = { lgxRadius: 24, lgxBubbleRadius: 28, lgxABubbleRadius: 28, lgxPopRadius: 28, lgxMenuRadius: 24 }
    const cur = $settings.get()
    const next = { ...cur }
    let changed = false

    for (const [key, cap] of Object.entries(caps)) {
      if (Number(next[key]) > cap) {
        next[key] = cap
        changed = true
      }
    }

    if (changed) $settings.set(next)
  }
} catch {
  /* 迁移失败不影响使用 */
}



/** 每级：左暗右亮两色 + 发光色（按文案匹配，中英都认；顺序 = 强度递增）。 */
const EFFORT_COLORS = [
  { bright: '#67e8f9', dark: '#0e7490', glow: 'rgba(34, 211, 238, 0.55)', keys: ['最小', 'minimal', 'min'] },
  { bright: '#6ee7b7', dark: '#047857', glow: 'rgba(52, 211, 153, 0.55)', keys: ['低', 'low'] },
  { bright: '#d9f99d', dark: '#3f6212', glow: 'rgba(163, 230, 53, 0.55)', keys: ['中', 'medium', 'med'] },
  { bright: '#fde68a', dark: '#b45309', glow: 'rgba(251, 191, 36, 0.55)', keys: ['高', 'high'] },
  { bright: '#fdba74', dark: '#c2410c', glow: 'rgba(251, 146, 60, 0.55)', keys: ['极高', 'xhigh'] },
  { bright: '#e9d5ff', dark: '#6b21a8', glow: 'rgba(168, 85, 247, 0.62)', keys: ['最高', 'max'] },
  { bright: '#fda4af', dark: '#9f1239', glow: 'rgba(244, 63, 94, 0.55)', keys: ['超高', 'ultra'] }
]

/** 模型菜单里的三个动作（弹窗里压成一小列，点了就替用户去点应用的真菜单项）。 */
const EFFORT_ACTIONS = [
  { icon: '⟳', kind: 'refresh', labels: ['刷新模型', 'Refresh models'] },
  { icon: '＋', kind: 'add', labels: ['添加自定义模型', 'Add custom model'] },
  { icon: '⚙', kind: 'edit', labels: ['编辑模型', 'Edit models'] }
]

/** 强度排名（弱 → 强）。**不依赖 DOM 顺序** —— 应用换排序、换模型、少给几档都不影响。 */
const EFFORT_RANK = [
  ['最小', 'minimal', 'min'],
  ['低', 'low'],
  ['中', 'medium', 'med'],
  ['高', 'high'],
  ['极高', 'xhigh'],
  ['最高', 'max'],
  ['超高', 'ultra']
]

const effortDiag = { found: false, levels: [], picked: '', lastAction: '', order: '', pill: '', models: '', hidActions: '' }
/** 模型 pill 是靠哪条策略认到的：data-tour / aria-label / position / none */
let effortModelSource = 'none'
const effortState = { drag: false, index: 0, count: 0, items: [], order: [], open: false, appLevel: '', lastWritten: '', models: [], menuLevels: [], hitHandlers: {} }

/** 文案 → 强度序号；认不出返回 -1。 */
function effortRankOf(label) {
  const text = String(label || '').trim().toLowerCase()

  for (let i = 0; i < EFFORT_RANK.length; i++) {
    for (const key of EFFORT_RANK[i]) {
      if (text.startsWith(key.toLowerCase())) return i
    }
  }

  return -1
}

function effortColorFor(label, index) {
  const text = String(label || '').trim().toLowerCase()

  for (const entry of EFFORT_COLORS) {
    for (const key of entry.keys) {
      if (text.startsWith(key.toLowerCase())) return entry
    }
  }

  return EFFORT_COLORS[Math.min(EFFORT_COLORS.length - 1, Math.max(0, index))]
}

function effortPopup() {
  if (typeof document === 'undefined') return null

  for (const node of document.querySelectorAll(EFFORT_POPUP)) {
    if (node.querySelector(EFFORT_GROUP)) return node
  }

  return null
}

const EFFORT_THINK_LABELS = ['思考', 'thinking']

/** 我自己合成出来的「模型名 · 等级」文案（别把它当成模型名抓进列表）。 */
const EFFORT_MY_LABEL = /[·・]\s*(最小|低|中|高|极高|最高|超高|min|minimal|lo|low|mid|medium|med|high|hi|very high|max|maximal|ultra)\s*$/i

/** 找应用原生的「思考」开关行（那一行是 dropdown-menu-item + 内嵌 role=switch）。 */
function effortThinkingRow(root) {
  if (typeof document === 'undefined') return null

  const scope = root || document
  const rows = scope.querySelectorAll("[data-slot='dropdown-menu-item'], [role='menuitem']")

  for (const row of rows) {
    if (!row.querySelector("[role='switch']")) continue

    const text = (row.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()

    for (const label of EFFORT_THINK_LABELS) {
      if (text.startsWith(label)) return row
    }
  }

  return null
}

/** 找应用原生的思考开关（Radix Switch = button[role=switch]，点它就能切）。 */
function effortThinkingSwitch(root) {
  return effortThinkingRow(root)?.querySelector("[role='switch']") || null
}

function effortThinkingOn(root) {
  const sw = effortThinkingSwitch(root)

  return sw ? sw.getAttribute('aria-checked') === 'true' : true
}

/** 把应用原生的「思考」开关行和「推理强度」单选组藏起来（我们的弹窗里用闪电+滑条代替）。 */
/** 推理弹窗底部那三行（刷新模型 / 添加自定义模型 / 编辑模型）—— 模型列表里已经有同样的功能，
    用户要求删掉这三列（避免重复）。 */
const EFFORT_ACTION_LABELS = [
  '刷新模型', 'Refresh models', 'Refresh model',
  '添加自定义模型', 'Add custom model', 'Add a custom model', 'Add custom models',
  '编辑模型', 'Edit models', 'Edit model'
]

/** 只隐藏「推理弹窗」里的那三行；模型列表弹窗里的不动（那里是它们该在的地方）。
    实测要点：这三行不一定是 role=menuitem，文案里还可能带图标/说明 ——
    所以选择器放宽 + 只按「文案以标签开头」匹配，并且**不要**加长度上限。 */
function effortHideActionRows(popup) {
  if (!popup) return 0

  let hidden = 0

  const candidates = popup.querySelectorAll(
    "[role='menuitem'], [role='menuitemradio'], [data-slot='dropdown-menu-item'], button, a, [tabindex]"
  )

  for (const row of candidates) {
    if (row.closest(`#${EFFORT_WRAP_ID}`)) continue
    if (row.querySelector("[data-slot='dropdown-menu-radio-group']")) continue

    /* 只取最内层：外层容器（整块菜单）的文案也会以标签开头，别把整块藏了 */
    if (row.querySelector("[role='menuitem'], [role='menuitemradio'], [data-slot='dropdown-menu-item'], button, a")) continue

    const text = (row.textContent || '').replace(/\s+/g, ' ').trim()

    if (!text) continue
    if (!EFFORT_ACTION_LABELS.some(label => text.startsWith(label))) continue

    row.style.setProperty('display', 'none', 'important')
    row.setAttribute('data-hs-effort-hidden', '1')
    hidden += 1
  }

  if (hidden) effortDiag.hidActions = String(hidden)

  return hidden
}

function effortHideNative(root) {
  if (typeof document === 'undefined') return

  const scope = root || document

  for (const row of scope.querySelectorAll("[data-slot='dropdown-menu-radio-group']")) {
    if (row.closest(`#${EFFORT_WRAP_ID}`)) continue
    row.style.setProperty('display', 'none', 'important')
  }

  for (const popup of scope.querySelectorAll(EFFORT_POPUP_OR_SUB)) {
    if (popup.querySelector(`#${EFFORT_WRAP_ID}`)) continue

    const row = effortThinkingRow(popup)

    if (row) row.style.setProperty('display', 'none', 'important')
    effortHideActionRows(popup)
  }
}

function effortItems(group) {
  return [...group.querySelectorAll(EFFORT_ITEM)]
}

/** 程序化点击菜单项：Radix 的选中走 pointerup/click 之一，整套都发一遍最稳。 */
function effortPick(item) {
  try {
    const opts = { bubbles: true, button: 0, cancelable: true, view: window }

    item.dispatchEvent(new PointerEvent('pointerdown', opts))
    item.dispatchEvent(new PointerEvent('pointerup', opts))
    item.dispatchEvent(new MouseEvent('mouseup', opts))
    item.dispatchEvent(new MouseEvent('click', opts))

    return true
  } catch {
    try {
      item.click()

      return true
    } catch {
      return false
    }
  }
}

function effortSliderCss(s) {
  if (s.effortSliderOn !== true && s.modelPillLabelOn !== true && s.menuEffortOn !== true && s.pillFlowOn !== true && s.bubbleSelectTint !== true && s.userBubbleClear !== true) return ''

  const h = Math.max(6, Math.min(28, Number(s.effortSliderHeight) || 14))
  const knob = Math.round(h * 1.5)

  return `
/* ── 推理滑条（弹窗内）────────────────────────────────────────── */
#${EFFORT_WRAP_ID} {
  padding: 4px 10px 8px;
}

/* 开了液态玻璃 → 弹窗底色变半透明，否则 backdrop-filter 折射的是「自己的不透明底」，
   看起来跟没开一样（和气泡玻璃同一个道理）。 */
/* 弹窗底色改由 lgxCss 统一输出（那里才拿得到「跟随输入框」的结果） */

#${EFFORT_WRAP_ID} .hs-effort-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 2px 4px;
  font-size: 12px;
  color: var(--ui-text-secondary, rgba(255, 255, 255, 0.75));
  cursor: pointer;
}

#${EFFORT_WRAP_ID} .hs-effort-head:hover {
  color: var(--ui-text-primary, #fff);
}

#${EFFORT_WRAP_ID} .hs-effort-label {
  flex: 0 0 auto;
  font-weight: 500;
}

#${EFFORT_WRAP_ID} .hs-effort-model {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-left: 4px;
}

/* 当前等级：小胶囊，底色跟着等级走 */
#${EFFORT_WRAP_ID} .hs-effort-chip {
  flex: 0 0 auto;
  margin-left: auto;
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  color: #0b1020;
  transition: background 0.2s ease, box-shadow 0.2s ease;
}

#${EFFORT_WRAP_ID} .hs-effort-go {
  flex: 0 0 auto;
  opacity: 0.55;
  font-size: 12px;
  line-height: 1;
}

#${EFFORT_WRAP_ID} .hs-effort-dot {
  flex: 0 0 auto;
  opacity: 0.45;
}

#${EFFORT_WRAP_ID} .hs-effort-drawer,
#${EFFORT_WRAP_ID} .hs-effort-models,
#${EFFORT_WRAP_ID} .hs-effort-head,
#${EFFORT_WRAP_ID} .hs-effort-act,
#${EFFORT_WRAP_ID} .hs-effort-bolt,
#${EFFORT_WRAP_ID} .hs-effort-track,
#${EFFORT_WRAP_ID} .hs-effort-level {
  pointer-events: auto !important;
  position: relative;
  z-index: 3;
}

${s.menuEffortOn === true ? `#${MENU_WRAP_ID} {
  padding: 6px 8px 8px;
  border-top: 1px solid var(--border, rgba(255,255,255,0.12));
  margin-top: 4px;
}

#${MENU_WRAP_ID} .hs-effort-inmenu-title {
  font-size: 10px;
  opacity: 0.6;
  margin: 0 0 4px 2px;
}

#${MENU_WRAP_ID} .hs-effort-inmenu-track {
  margin: 2px 0 6px;
}

#${MENU_WRAP_ID} .hs-effort-inmenu-levels {
  display: flex;
  justify-content: space-between;
  gap: 4px;
  font-size: 10px;
  opacity: 0.75;
}

#${MENU_WRAP_ID} .hs-effort-inmenu-level.is-on {
  opacity: 1;
  font-weight: 700;
}

#${MENU_WRAP_ID} .hs-effort-inmenu-chip {
  font: inherit;
  font-size: 11px;
  line-height: 1;
  padding: 5px 8px;
  border-radius: 999px;
  border: 1px solid var(--border, rgba(255,255,255,0.18));
  background: color-mix(in srgb, var(--accent, #4c7dff) 14%, transparent);
  color: inherit;
  cursor: pointer;
}

#${MENU_WRAP_ID} .hs-effort-inmenu-chip:hover {
  background: color-mix(in srgb, var(--accent, #4c7dff) 28%, transparent);
}

#${MENU_WRAP_ID} .hs-effort-inmenu-chip.is-on {
  background: color-mix(in srgb, var(--accent, #4c7dff) 55%, transparent);
  border-color: var(--accent, #4c7dff);
  font-weight: 600;
}` : ''}

#${EFFORT_WRAP_ID} .hs-effort-models {
  max-height: 12rem;
  overflow-y: auto;
  margin: 2px 0 4px;
}

#${EFFORT_WRAP_ID} .hs-effort-modelname {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

#${EFFORT_WRAP_ID} .hs-effort-hint {
  opacity: 0.6;
  cursor: default;
  font-size: 10px;
}

#${EFFORT_WRAP_ID} .hs-effort-drawer {
  display: none;
  padding: 2px 0 4px;
}

/* 应用自己的模型 pill：视觉收起（合成 pill 已经显示同样的信息）。
   ⚠️ 选择器必须用**应用自己的属性**（data-tour / aria-label）—— 我自打的 data-hs-modelpill
   会被 React 重渲染冲掉 → pill 又冒出来（用户看到「两个模型」）。
   程序化打开菜单时临时加 .hs-pill-open 恢复真实尺寸（Radix 要量触发器矩形）。 */
${s.userBubbleClear === true ? `/* 去掉「我发的消息」气泡的黑底。三层一起清，缺一层都还会看见底色：
   ① 应用自己的开关变量 --user-bubble-keep（0% = 只留描边，它是在 html 上**行内**写的，
      所以必须 !important 才压得住）；
   ② 气泡的填充变量 --dt-user-bubble（深色主题下取到的是深色）；
   ③ 元素本身 + 它的伪元素（气泡带 standalone-glass，玻璃底可能是伪元素画的）。 */
html,
:root {
  --user-bubble-keep: 0% !important;
}

[data-slot='aui_user-message-root'] {
  --dt-user-bubble: transparent !important;
}

[data-slot='aui_user-message-root'] .composer-human-message,
[data-slot='aui_user-message-root'] .composer-human-message-container {
  background: transparent !important;
  background-color: transparent !important;
  background-image: none !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}

[data-slot='aui_user-message-root'] .composer-human-message::before,
[data-slot='aui_user-message-root'] .composer-human-message::after {
  background: transparent !important;
  background-image: none !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}` : ''}

${s.bubbleSelectTint === true ? `/* 气泡里双击选中文字时的高亮：用气泡同源的半透明色调，
   不再是应用默认那种「长方形黑底 / 土黄块」（用户报与圆角玻璃底不符）。
   注意：::selection 按 CSS 规范只支持颜色类属性，圆角无法设置，
   所以这里用「柔和的半透明同色调」来和玻璃底协调。 */
/* 应用自己有一条全局规则：*::selection 的底色取自 CSS 变量 --ui-selection-background，
   而该变量在主题里被设成 #ffd24a（黄色）→ 在深色玻璃上就显出你说的「土黄/发暗方块」。
   与其和那条规则硬碰，不如直接改这个变量 —— 这是应用留出来的正规入口。
   ⚠️ 注释里不要写反引号：模板字符串会被提前结束（踩过两次）。 */
:root,
html,
body,
[data-slot='aui_user-message-root'],
[data-slot='aui_assistant-message-content'] {
  --ui-selection-background: color-mix(in srgb, var(--accent, #4c7dff) 34%, transparent) !important;
}

[data-slot='aui_user-message-root'] .composer-human-message ::selection,
[data-slot='aui_assistant-message-content'] ::selection {
  background: color-mix(in srgb, var(--accent, #4c7dff) 34%, transparent) !important;
  color: inherit !important;
  text-shadow: none !important;
}

[data-slot='aui_user-message-root'] .composer-human-message::selection,
[data-slot='aui_assistant-message-content']::selection {
  background: color-mix(in srgb, var(--accent, #4c7dff) 34%, transparent) !important;
  color: inherit !important;
}` : ''}

${s.pillFlowOn === true ? `/* pill 文字流光：和滑条同一套配色与流动方式（64px 无缝平铺，只平移一个平铺宽度）。
   只作用在 span 上 —— svg 箭头用 currentColor，跟着透明就看不见了。 */
/* 只认我自己打上的档位标记，不依赖应用内部 span 的嵌套层级。
   ⚠️ 注释里绝不能出现反引号：模板字符串会被提前结束（本次事故：
   注释里写了带反引号的选择器片段 → 模板在这里断掉 → 后面的标识符变成真代码 → ReferenceError）。 */
[data-hs-effort-rank] .hs-pill-text svg {
  color: var(--ui-text-tertiary, #9aa4b2) !important;
}

[data-hs-effort-rank] .hs-pill-text {
  background-image: linear-gradient(90deg, #7dd3fc, #a78bfa, #f0abfc, #fda4af, #7dd3fc);
  background-size: 64px 100%;
  background-repeat: repeat;
  -webkit-background-clip: text !important;
  background-clip: text !important;
  -webkit-text-fill-color: transparent !important;
  color: transparent !important;
  animation: hs-pill-flow ${Number.isFinite(Number(s.pillFlowSeconds)) ? Number(s.pillFlowSeconds) : 2.4}s linear infinite;
}

@keyframes hs-pill-flow {
  from { background-position: 0 0; }
  to { background-position: -64px 0; }
}

/* 按当前档位换配色（与滑条同一张 EFFORT_COLORS 表）：
   dark → bright → dark，首尾同色才能无缝循环。 */
${EFFORT_COLORS.map((entry, i) => `[data-hs-effort-rank='${i}'] .hs-pill-text {
  background-image: linear-gradient(90deg, ${entry.dark}, ${entry.bright}, ${entry.dark}) !important;
}

/* 兜底：标记落在 pill 自身（文字是裸文本节点、没有可标记的子元素）。
   这里**不能用 background-clip: text** —— 那会把 pill 自己的底色一起裁掉（外观就变了）。
   所以只上实色（同档位的亮色），保住 pill 原来的底与边框。 */
[data-hs-effort-rank='${i}'].hs-pill-text {
  color: ${entry.bright} !important;
}`).join('\n')}` : ''}

${s.hideReasonPill === true ? `[data-testid='reasoning-pill']:not(.hs-pill-open) {
  opacity: 0 !important;
  width: 0 !important;
  min-width: 0 !important;
  max-width: 0 !important;
  padding: 0 !important;
  margin: 0 !important;
  overflow: hidden !important;
  pointer-events: none !important;
}` : ''}

${s.hideAppModelPill === true ? `[data-tour='model-pill']:not(.hs-pill-open) {
  opacity: 0 !important;
  width: 0 !important;
  min-width: 0 !important;
  max-width: 0 !important;
  padding: 0 !important;
  margin: 0 !important;
  overflow: hidden !important;
  pointer-events: none !important;
}` : ''}

#${EFFORT_WRAP_ID} .hs-effort-hit {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 4px 0 2px;
  touch-action: none;
}

/* 闪电 = 思考开关：开=橙色渐变+发光，关=灰暗（点它直接切应用的思考开关） */
#${EFFORT_WRAP_ID} .hs-effort-bolt {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: ${h + 14}px;
  height: ${h + 14}px;
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.10);
  background: rgba(255, 255, 255, 0.05);
  color: rgba(255, 255, 255, 0.35);
  font-size: ${Math.round(h * 0.85)}px;
  line-height: 1;
  cursor: pointer;
  transition: background 0.2s ease, color 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;
}

#${EFFORT_WRAP_ID} .hs-effort-bolt:hover {
  border-color: rgba(255, 255, 255, 0.22);
}

#${EFFORT_WRAP_ID} .hs-effort-bolt.is-on {
  border-color: rgba(255, 168, 64, 0.55);
  background: linear-gradient(145deg, rgba(255, 176, 60, 0.28), rgba(255, 96, 32, 0.22));
  color: #ffb02e;
  box-shadow: 0 0 12px rgba(255, 140, 40, 0.45), inset 0 0 8px rgba(255, 170, 60, 0.25);
  text-shadow: 0 0 8px rgba(255, 150, 40, 0.8);
}

#${EFFORT_WRAP_ID} .hs-effort-track {
  position: relative;
  flex: 1 1 auto;
  height: ${h}px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.09);
  overflow: hidden;
  transition: box-shadow 0.2s ease;
}

/* 填充：左暗右亮渐变（颜色随等级变） */
#${EFFORT_WRAP_ID} .hs-effort-fill {
  position: absolute;
  inset: 0 auto 0 0;
  width: 0%;
  border-radius: inherit;
  overflow: hidden;
  transition: width 0.18s ease;
}

/* 银河层：无缝平铺的闪点 + 一道柔光，只平移 background-position 一个平铺宽度
   —— 循环无缝，绝不会像 300% 平移那样把整条彩色滑出元素（那会变成「满→空」锯齿）。 */
#${EFFORT_WRAP_ID} .hs-effort-fill::after {
  content: '';
  position: absolute;
  inset: 0;
  background-image:
    radial-gradient(circle at 12% 38%, rgba(255, 255, 255, 0.95) 0 1px, transparent 1.8px),
    radial-gradient(circle at 42% 68%, rgba(255, 255, 255, 0.75) 0 0.9px, transparent 1.6px),
    radial-gradient(circle at 72% 30%, rgba(255, 255, 255, 0.9) 0 1.1px, transparent 1.9px),
    radial-gradient(circle at 90% 62%, rgba(255, 255, 255, 0.6) 0 0.8px, transparent 1.5px),
    linear-gradient(100deg, rgba(255, 255, 255, 0) 0%, rgba(255, 255, 255, 0.5) 50%, rgba(255, 255, 255, 0) 100%);
  background-size: 64px 100%, 64px 100%, 64px 100%, 64px 100%, 64px 100%;
  background-repeat: repeat, repeat, repeat, repeat, repeat;
  animation-name: hs-effort-galaxy !important;
  animation-duration: ${Math.max(0.8, 4.5 / Math.max(0.3, Math.min(3, Number(s.flowSpeed) || 1))).toFixed(2)}s !important;
  animation-timing-function: linear !important;
  animation-iteration-count: infinite !important;
  animation-direction: normal !important;
  opacity: 0.95;
  pointer-events: none;
}

#${EFFORT_WRAP_ID} .hs-effort-knob {
  position: absolute;
  top: 50%;
  left: 0%;
  width: ${knob}px;
  height: ${knob}px;
  border-radius: 50%;
  background: #fff;
  translate: -50% -50%;
  box-shadow: 0 0 10px rgba(255, 255, 255, 0.5), 0 1px 4px rgba(0, 0, 0, 0.45);
  transition: left 0.18s ease;
  pointer-events: none;
}

/* ── 三个模型动作：压成一小列（缩略：小字号、紧凑行高）─────────── */

#${EFFORT_WRAP_ID} .hs-effort-act {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 6px;
  border-radius: 6px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--ui-text-tertiary, rgba(255, 255, 255, 0.6));
  cursor: pointer;
  user-select: none;
}

#${EFFORT_WRAP_ID} .hs-effort-act:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--ui-text-primary, #fff);
}

#${EFFORT_WRAP_ID} .hs-effort-act-icon {
  flex: 0 0 auto;
  width: 12px;
  text-align: center;
  opacity: 0.85;
}

@keyframes hs-effort-galaxy {
  0% { background-position: 0 0, 0 0, 0 0, 0 0, 0 0; }
  100% { background-position: -64px 0, -64px 0, -64px 0, -64px 0, -64px 0; }
}
`
}

function effortMount(s) {
  const mountStart = typeof performance !== 'undefined' && performance.now ? performance.now() : 0
  const popup = effortPopup()

  if (!popup) return

  /* ⚠️ 这里以前写成 `if (!popup || popup.querySelector('#wrap')) return`，
     但 React 的弹窗内容一直留着（不重建）→ 第二次之后**永远 early return**，
     新代码（命中路由 / 自检 / 各种修复）从未执行过 —— 这就是「改了没反应」的真因。
     所以：基础设施无条件安装，wrap 只按版本决定是否重建。 */
  effortInstallCoverProbe()
  effortInstallHitRouter()
  effortInstallDragRouter()

  const existing = popup.querySelector(`#${EFFORT_WRAP_ID}`)

  if (existing && existing.getAttribute('data-hs-build') === EFFORT_BUILD) return
  if (effortState.building) return                 /* 防重入：绝不允许递归重建 */

  /* 旧版本留下的 wrap：里面元素没有 data-hs-hit、监听器也是旧的 → 清空重建。
     只清内容、不删 wrap 本身，避免 React 卸载时 removeChild 报错。
     ⚠️ 版本戳必须在清空后**立刻**打上：如果后面抛错，下一次挂载要能直接 early return，
     否则「清空 → 抛错 → observer → 再清空」会变成死循环（表现为整个 Hermes 卡死）。 */
  if (existing) {
    existing.setAttribute('data-hs-build', EFFORT_BUILD)
    existing.textContent = ''
  }

  effortState.building = true

  const group = popup.querySelector(EFFORT_GROUP)
  const items = effortItems(group)

  if (!items.length) return

  effortState.items = items
  effortState.count = items.length

  const labels = items.map(item => (item.textContent || '').replace(/\s+/g, ' ').trim())
  const ranks = labels.map(effortRankOf)
  /* 全部认得出 → 按强度重排；有一个认不出 → 退回 DOM 原顺序（不猜） */
  const ranked = ranks.every(rank => rank >= 0)
  const order = items.map((_, i) => i).sort((a, b) => (ranked ? ranks[a] - ranks[b] : a - b))

  effortState.order = order

  const checkedAt = items.findIndex(item => item.getAttribute('aria-checked') === 'true')
  const picked = Math.max(0, order.indexOf(checkedAt))

  effortState.index = picked
  effortDiag.found = true
  effortDiag.levels = labels
  effortDiag.order = ranked ? '按强度识别' : '退回 DOM 顺序'
  effortDiag.picked = labels[checkedAt >= 0 ? checkedAt : order[0]] || ''

  /* 打标记：玻璃（液态/静态）都靠它认这个弹窗 */
  popup.setAttribute('data-hs-effort', '1')
  group.style.setProperty('display', 'none', 'important')
  /* 本弹窗里的「思考」开关**保留**（用户只要求从「模型选择」菜单里去掉它）。
     effortHideNative 跑在挂载之前，那时本弹窗还没有滑条、会被误判成“别的菜单”
     而把思考行一起藏掉 —— 所以这里显式放回来。 */
  effortThinkingRow(popup)?.style.removeProperty('display')

  /* 挂载时先抓一次应用模型列表（就是用户说的「左边的模型列表」），
     否则抽屉里只有提示、列不出模型（observer 里的那次要等下一次 DOM 变动）。 */
  effortCacheMenuItems()
  effortInstallCoverProbe()
  /* 自检：不依赖用户点击 —— 往一个无副作用的隐藏元素发合成 pointerdown，
     看 window 捕获路由是否真的被调用，把结果回传（agent 可直接确认路由生效）。
     每版只报一次，避免刷屏。 */
  if (effortState.selfTested !== EFFORT_BUILD) {
    effortState.selfTested = EFFORT_BUILD

    setTimeout(() => {
      try {
        const probeEl = popup.querySelector('#hermes-effort-selftest') || (() => {
          const el = document.createElement('div')

          el.id = 'hermes-effort-selftest'
          el.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden'
          effortHit(el, 'selftest', () => {
            effortState.selfTestOk = true
          })
          wrap.appendChild(el)

          return el
        })()

        effortState.selfTestOk = false
        probeEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, cancelable: true, isPrimary: true, pointerType: 'mouse' }))

        const ok = effortState.selfTestOk === true

        effortReportTap(`selftest router=${ok ? 'ok' : 'MISS'} wrapInPopup=${!!popup.querySelector('#' + EFFORT_WRAP_ID)} handlers=${Object.keys(effortState.hitHandlers || {}).join(',')}`)
      } catch (error) {
        effortReportTap('selftest error=' + (error?.message || '?'))
      }
    }, 600)
  }

  effortState.building = false

  /* 耗时上报：卡死类问题只能靠这个定位（若这里出现几百毫秒以上就要继续查）。 */
  try {
    const ms = mountStart && performance.now ? Math.round(performance.now() - mountStart) : -1

    effortReportTap(`mount ms=${ms} wrapInPopup=${!!popup.querySelector('#' + EFFORT_WRAP_ID)}`)
  } catch {
    /* 排障通道 */
  }

  const modelPill = effortModelPill()

  /* 应用的模型 pill 与弹窗里的「模型」行是同一个入口，重复 → 把它视觉收起来
     （只藏外观：opacity/尺寸，**保留可点**，程序化打开菜单还要用它）。 */
  for (const node of document.querySelectorAll("[data-hs-modelpill='1']")) node.removeAttribute('data-hs-modelpill')
  const pillCount = typeof document === 'undefined' ? 0 : document.querySelectorAll("[data-testid='reasoning-pill']").length

  effortDiag.pill = modelPill
    ? `推理 pill ${pillCount} 个（用可见的那个）｜认到模型 pill：文字=「${(modelPill.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24)}」`
    : `推理 pill ${pillCount} 个｜没认到模型 pill`

  const wrap = existing || document.createElement('div')

  wrap.id = EFFORT_WRAP_ID
  wrap.setAttribute('data-hs-build', EFFORT_BUILD)

  /* 一行：模型 <名字> + 当前等级胶囊（用户要求「模型名称和强度放在一起」） */
  const head = document.createElement('div')

  head.className = 'hs-effort-head'

  /* 合成一行：模型名 · 当前强度（用户要求「模型名称和模型强度合成一个缩小列」），
     最右边是「未展开」的箭头 —— 点它展开，里面就是模型选择。 */
  const modelName = document.createElement('span')

  modelName.className = 'hs-effort-model'
  modelName.textContent = effortModelName(modelPill)

  const dot = document.createElement('span')

  dot.className = 'hs-effort-dot'
  dot.textContent = '·'

  const chip = document.createElement('span')

  chip.className = 'hs-effort-chip'

  const go = document.createElement('span')

  go.className = 'hs-effort-go'
  go.textContent = '›'
  head.append(modelName, dot, chip, go)

  /* 展开区：模型选择（点它开应用自己的模型菜单） */
  const drawer = document.createElement('div')

  drawer.className = 'hs-effort-drawer'

  const pickRow = document.createElement('div')

  pickRow.className = 'hs-effort-act hs-effort-pick'

  const pickIcon = document.createElement('span')

  pickIcon.className = 'hs-effort-act-icon'
  pickIcon.textContent = '◇'

  const pickText = document.createElement('span')

  pickText.textContent = '打开模型列表…'
  pickRow.append(pickIcon, pickText)
  effortHit(pickRow, 'pick', () => {
    effortDiag.lastAction = 'open-model-menu'
    effortOpenModelMenu(modelPill)
  })
  drawer.appendChild(pickRow)

  /* 应用模型列表的镜像：抓到的条目直接列在弹窗里，点哪条就去点应用里同名的那条 */
  const modelList = document.createElement('div')

  modelList.className = 'hs-effort-models'
  drawer.appendChild(modelList)

  const paintModels = () => {
    const models = effortState.models

    modelList.textContent = ''

    if (!models.length) {
      const hint = document.createElement('div')

      hint.className = 'hs-effort-act hs-effort-hint'
      hint.textContent = '（打开一次应用的模型列表后，这里会列出模型）'
      modelList.appendChild(hint)

      return
    }

    for (const name of models) {
      const row = document.createElement('div')

      row.className = 'hs-effort-act'

      const icon = document.createElement('span')

      icon.className = 'hs-effort-act-icon'
      icon.textContent = '·'

      const text = document.createElement('span')

      text.className = 'hs-effort-modelname'
      text.textContent = name
      row.append(icon, text)
      /* 这里以前是「按名字去点应用菜单里同名项」—— 实测会点错（用户点「OpenCode Go」
         结果模型变成了 LongCat，且切不回来）。改成只**打开应用自己的模型菜单**，
         选哪个模型由用户和应用自己决定。 */
      effortHit(row, 'model', () => {
        effortDiag.lastAction = 'open-menu-from-list'
        effortOpenModelMenu(modelPill)
      }, name)
      modelList.appendChild(row)
    }
  }

  paintModels()

  const paintHead = () => {
    head.classList.toggle('is-open', effortState.open)
    go.textContent = effortState.open ? '⌄' : '›'
    head.title = effortState.open ? '收起' : '展开模型选择'
    drawer.style.display = effortState.open ? 'block' : 'none'
  }

  effortHit(head, 'head', () => {
    effortDiag.lastAction = effortState.open ? 'drawer-open' : 'drawer-close'
    effortState.open = !effortState.open
    paintHead()
  })

  const hit = document.createElement('div')

  hit.className = 'hs-effort-hit'

  const bolt = document.createElement('div')

  bolt.className = 'hs-effort-bolt'
  bolt.textContent = '⚡'
  bolt.setAttribute('role', 'button')
  bolt.title = '推理强度拉满'
  effortHit(bolt, 'bolt', () => {
    /* 闪电 = 一键拉满推理强度 */
    effortDiag.lastAction = 'max-effort'
    apply(effortState.count - 1, true)
  })

  const track = document.createElement('div')

  track.className = 'hs-effort-track'

  const fill = document.createElement('div')

  fill.className = 'hs-effort-fill'

  const knob = document.createElement('div')

  knob.className = 'hs-effort-knob'
  track.append(fill, knob)
  hit.append(bolt, track)

  const itemAt = index => {
    const pos = effortState.order[Math.max(0, Math.min(effortState.count - 1, index))]

    return pos === undefined ? null : effortState.items[pos]
  }

  const labelAt = index => (itemAt(index)?.textContent || '').replace(/\s+/g, ' ').trim()

  const paintBolt = () => {
    /* 已经是最高档 → 闪电点亮（它是一次性动作按钮，亮 = 当前已拉满） */
    const maxed = effortState.index >= effortState.count - 1

    bolt.classList.toggle('is-on', maxed)
    bolt.setAttribute('aria-pressed', maxed ? 'true' : 'false')
    bolt.title = maxed ? '已是最高推理强度' : '推理强度拉满'
  }

  const paint = () => {
    paintHead()
    paintBolt()
      paintModels()
    const count = Math.max(1, effortState.count)
    const index = Math.max(0, Math.min(count - 1, effortState.index))
    const ratio = count === 1 ? 1 : index / (count - 1)
    const label = labelAt(index)
    const entry = effortColorFor(label, index)

    fill.style.width = `${(ratio * 100).toFixed(1)}%`
    /* 左暗右亮渐变（不是纯色） */
    fill.style.background = `linear-gradient(90deg, ${entry.dark} 0%, ${entry.bright} 100%)`
    knob.style.left = `${(ratio * 100).toFixed(1)}%`
    chip.textContent = label || ''
    chip.style.background = `linear-gradient(90deg, ${entry.dark}, ${entry.bright})`
    chip.style.boxShadow = `0 0 10px ${entry.glow}`
    track.style.boxShadow = `0 0 12px ${entry.glow}`
  }

  const apply = (index, commit) => {
    effortState.index = Math.max(0, Math.min(effortState.count - 1, index))
    paint()

    if (commit) {
      const item = itemAt(effortState.index)

      effortDiag.picked = labelAt(effortState.index) || ''
      effortDiag.lastAction = 'pick-' + effortDiag.picked
      if (item) effortPick(item)
    }
  }

  const indexFromEvent = event => {
    const rect = track.getBoundingClientRect()

    if (!rect.width) return effortState.index

    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    const count = Math.max(1, effortState.count)

    return Math.round(ratio * (count - 1))
  }

  /* apply / indexFromEvent 是这里的局部闭包；拖动路由在顶层，看不见它们
     （曾因此抛 ReferenceError: apply is not defined → 滑条拖不动），登记到 state。 */
  effortState.apply = apply
  effortState.indexFromEvent = indexFromEvent

  /* 拖动起点也必须走 window 捕获路由 —— 应用在捕获阶段就吞掉了内层监听，
     所以这里挂的 pointerdown 永远收不到（这正是「滑条拖不动」的原因）。 */
  effortHit(hit, 'track', (key, el, event) => {
    effortDiag.lastAction = 'slider-start'

    try {
      /* commit 必须传 false：传 true 等于"按下即松手"，会把拖动状态清掉
         （曾导致「拖到最右还是最低档」）。 */
      effortState.apply?.(indexFromEvent(event), false)
    } catch {
      /* 同上 */
    }

    effortState.drag = true

    try {
      hit.setPointerCapture?.(event.pointerId)
    } catch {
      /* 捕获不到也能靠 window 上的监听继续 */
    }
  })

  hit.addEventListener('pointermove', event => {
    if (!effortState.drag) return

    event.preventDefault()
    apply(indexFromEvent(event), true)
  })

  const endDrag = () => {
    effortState.drag = false
  }

  hit.addEventListener('pointerup', endDrag)
  hit.addEventListener('pointercancel', endDrag)

  wrap.append(head, drawer, hit)

  const sep = document.createElement('div')

  sep.className = 'hs-effort-sep'
  group.parentElement?.insertBefore(sep, group)
  group.parentElement?.insertBefore(wrap, group)
  paint()
}

/** 点「模型」行/动作行时用：同排另一个下拉触发器就是模型 pill。 */
/** 诊断回传：把「真实 DOM 结构」POST 到本地监听（127.0.0.1:8791）。
    用 text/plain 避开 CORS 预检；失败静默（这是排障用的，不能影响功能）。 */
/** 决定性探针：在 window 捕获阶段监听。如果点在弹窗范围内、但 event.target 不是我的元素，
    说明有东西盖在上面（z-index / overlay / pointer-events）—— 把盖住的那个报回来。 */
function effortInstallCoverProbe() {
  let sent = 0

  window.addEventListener('pointerdown', event => {
    try {
      if (sent >= 10) return                                     /* 只报前 10 次，别刷屏 */

      const target = event.target
      const inWrap = !!target?.closest?.(`#${EFFORT_WRAP_ID}`)
      const wraps = document.querySelectorAll(`#${EFFORT_WRAP_ID}`).length
      const marked = document.querySelectorAll(LGX_POP).length
      const popups = document.querySelectorAll("[data-slot='dropdown-menu-content']").length

      /* 只关心和我有关的点击：落在我 wrap 里、或落在弹窗矩形内 */
      const popupEl = document.querySelector(LGX_POP)
      const rect = popupEl?.getBoundingClientRect()
      const inRect = !!(rect?.width && rect?.height && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom)

      if (!inWrap && !inRect) return

      sent += 1

      const stack = typeof document.elementsFromPoint === 'function'
        ? document.elementsFromPoint(event.clientX, event.clientY).slice(0, 5).map(el => el.tagName.toLowerCase() + '.' + String(el.className || '').slice(0, 26) + '#' + String(el.id || ''))
        : []

      effortReportTap(`pd inWrap=${inWrap ? 1 : 0} inRect=${inRect ? 1 : 0} wraps=${wraps} marked=${marked} popups=${popups}` +
        ` | target=${(target?.tagName || '?').toLowerCase()}.${String(target?.className || '').slice(0, 34)}` +
        ` | text=${String(target?.textContent || '').trim().slice(0, 20)}` +
        ` | stack=${stack.join(' > ')}`)
    } catch {
      /* 排障通道 */
    }
  }, true)
}

/** 命中路由。
    实测：应用（Radix 弹窗容器）在**捕获阶段**就 stopPropagation，所以挂在弹窗内元素上的
    pointerdown/click **永远收不到**；但 window 捕获阶段能收到（探针已证明）。
    因此所有交互都从这里按落点路由，元素上只留 data-hs-hit 标记。 */
/** 拖动：从 window 捕获接 move/up（内层监听同样被吞）。 */
function effortInstallDragRouter() {
  const toIndex = event => {
    try {
      if (typeof effortState.indexFromEvent === 'function') return effortState.indexFromEvent(event)
    } catch {
      /* 退回到按容器宽度换算 */
    }

    const wrap = document.getElementById(EFFORT_WRAP_ID)
    const track = wrap?.querySelector('.hs-effort-track')

    if (!track) return 0

    const rect = track.getBoundingClientRect()

    if (!rect.width) return 0

    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))

    return Math.round(ratio * Math.max(1, effortState.count - 1))
  }

  const commit = (event, isEnd) => {
    try {
      const index = toIndex(event)

      effortState.apply?.(index, isEnd)
    } catch {
      /* 任何异常都不往上冒（绝不能影响应用） */
    }
  }

  const move = event => {
    if (!effortState.drag) return

    event.preventDefault?.()
    event.stopPropagation()
    commit(event, false)
  }
  const up = event => {
    if (!effortState.drag) return

    effortState.drag = false
    effortDiag.lastAction = 'slider-release'
    effortReportTap('slider-release')
    commit(event, true)
  }

  rebindGlobal(window, 'effort-drag', 'pointermove', move, true)
  rebindGlobal(window, 'effort-drag', 'pointerup', up, true)
  rebindGlobal(window, 'effort-drag', 'click', up, true)
}

function effortInstallHitRouter() {
  const route = event => {
    try {
      const target = event.target

      if (!target) return

      const hit = target.closest?.('[data-hs-hit]')

      if (!hit) return

      /* 我的容器有两个：弹窗内的滑条 wrap，以及模型列表弹窗里注入的「推理强度」wrap。
         只认其中一个会让另一个里的点击全部失效（自查抓到的真问题）。 */
      if (!hit.closest(`#${EFFORT_WRAP_ID}, #${MENU_WRAP_ID}`)) return

      const kind = hit.getAttribute('data-hs-hit')
      const key = hit.getAttribute('data-hs-key') || ''

      event.preventDefault?.()
      event.stopPropagation()

      const handler = effortState.hitHandlers?.[kind]

      if (typeof handler === 'function') {
        effortReportTap('route:' + kind + (key ? ':' + key : ''))
        handler(key, hit, event)
      }
    } catch {
      /* 路由失败不影响应用 */
    }
  }

  rebindGlobal(window, 'effort-hit', 'pointerdown', event => {
    if (event.button !== 0 && event.button !== undefined) return

    route(event)
  }, true)
  rebindGlobal(window, 'effort-hit', 'click', route, true)
}

/** 登记一个可点元素：打标记 + 记处理器（真正触发走 window 捕获路由）。 */
function effortHit(el, kind, handler, key) {
  el.setAttribute('data-hs-hit', kind)

  if (key) el.setAttribute('data-hs-key', key)
  if (!effortState.hitHandlers) effortState.hitHandlers = {}
  effortState.hitHandlers[kind] = handler
  el.style.cursor = 'pointer'

  return el
}

function effortMenuCount() {
  if (typeof document === 'undefined') return 0

  return document.querySelectorAll("[role='menu'], [role='dialog'], [data-slot='dropdown-menu-content']").length
}

/** 打开尝试的结果回传：点了之后菜单到底有没有出现、按钮是不是 disabled。 */
/** 造一个「可点行」：真 `<button>`（浏览器一定发 click）+ 同时监听 pointerdown
    （实测 popup 里只有 pointerdown 能到处理器，click 会被上层吞掉）。 */
function effortClickable(className, onActivate, tapName) {
  const row = document.createElement('button')

  row.type = 'button'
  row.className = className

  let done = false
  const fire = event => {
    if (done) return

    done = true
    setTimeout(() => {
      done = false
    }, 120)
    event.preventDefault?.()
    event.stopPropagation()
    effortReportTap(tapName)
    onActivate()
  }

  row.addEventListener('pointerdown', event => {
    if (event.button !== 0) return

    fire(event)
  })
  row.addEventListener('click', fire)

  return row
}

/** 轻量上报：只记「哪一行被点了」，用来区分「点击没到处理器」和「到了但没打开」。 */
function effortReportTap(what) {
  try {
    if (typeof fetch !== 'function') return

    fetch('http://127.0.0.1:8791/open', {
      body: JSON.stringify({ tap: what, t: Date.now(), v: EFFORT_BUILD }),
      headers: { 'Content-Type': 'text/plain' },
      method: 'POST'
    }).catch(() => {})
  } catch {
    /* 排障通道 */
  }
}

function effortReportOpen(el) {
  try {
    if (typeof fetch !== 'function') return

    const before = effortMenuCount()
    const info = {
      aria: el?.getAttribute?.('aria-label') || '',
      childButtons: el ? el.querySelectorAll('button').length : 0,
      cls: String(el?.className || '').slice(0, 50),
      disabled: el?.disabled === true,
      ariaDisabled: el?.getAttribute?.('aria-disabled') || '',
      tag: el?.tagName ? el.tagName.toLowerCase() : '?',
      tour: el?.getAttribute?.('data-tour') || '',
      t: Date.now(),
      v: EFFORT_BUILD
    }

    setTimeout(() => {
      try {
        const after = effortMenuCount()

        info.menuBefore = before
        info.menuAfter = after
        info.opened = after > before
        fetch('http://127.0.0.1:8791/open', {
          body: JSON.stringify(info),
          headers: { 'Content-Type': 'text/plain' },
          method: 'POST'
        }).catch(() => {})
      } catch {
        /* 排障通道 */
      }
    }, 400)
  } catch {
    /* 排障通道 */
  }
}

function effortReportDiag(s) {
  try {
    if (typeof fetch !== 'function' || s.effortDiagOff === true) return

    const pill = effortReasoningPill()
    const prev = effortPrevElement(pill)
    const chain = []
    let node = pill

    for (let i = 0; i < 6 && node; i++) {
      chain.push(`${node.tagName ? node.tagName.toLowerCase() : '?'}.${String(node.className || '').slice(0, 40)}#${node.children ? node.children.length : 0}`)
      node = node.parentElement
    }

    const sibs = pill?.parentElement
      ? [...pill.parentElement.children].map(child =>
          `${child.tagName ? child.tagName.toLowerCase() : '?'}.${String(child.className || '').slice(0, 28)}「${(child.textContent || '').trim().slice(0, 18)}」`
        )
      : []

    const payload = {
      chain,
      prev: prev
        ? {
            aria: prev.getAttribute?.('aria-label') || '',
            cls: String(prev.className || '').slice(0, 40),
            slot: prev.getAttribute?.('data-slot') || '',
            tag: prev.tagName ? prev.tagName.toLowerCase() : '?',
            text: (prev.textContent || '').trim().slice(0, 40),
            tour: prev.getAttribute?.('data-tour') || ''
          }
        : null,
      pillCount: typeof document === 'undefined' ? 0 : document.querySelectorAll("[data-testid='reasoning-pill']").length,
      sibs,
      source: effortModelSource,
      v: EFFORT_BUILD,
      resolvedName: effortModelName(effortModelPill()),
      pillText: (effortReasoningPill()?.textContent || '').trim().slice(0, 40),
      appLevel: effortState.appLevel,
      tours: typeof document === 'undefined' ? [] : [...document.querySelectorAll('[data-tour]')].map(el => el.getAttribute('data-tour')),
      t: Date.now()
    }

    fetch('http://127.0.0.1:8791/diag', {
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'text/plain' },
      method: 'POST'
    }).catch(() => {})
  } catch {
    /* 排障通道，出错不能影响功能 */
  }
}

/** 文档顺序上**紧挨在 node 前面**的那个元素（跨父层回溯）。
    用途：源码 `controls.tsx` 里模型 pill 与推理 pill 是紧邻的两个兄弟
    （`<ModelPill/><ReasoningPill/>`），所以模型 pill = 推理 pill 前一个元素 ——
    这个判据**不看标签、不看属性**，比按 data-tour / aria-label / 触发器位置都稳。 */

/* ── 设置弹窗左列：把本插件所在的那一组自动展开 ─────────────────────
   应用结构（实测）：左列 [data-tour='overlay-nav']，每一组 =
     <button class="flex h-7 w-full …">组名</button>            ← 组头（点了才展开）
     <div class="ml-3.5 flex-col gap-0.5 pl-1.5 hidden">…</div> ← 组体，折叠时带 Tailwind 的 hidden
   展开状态只在 React 状态里 → 插件改不了它，但 hidden 就是 display:none，
   用 CSS 覆盖即可。这里只负责「打标记」，样式在 navAutoOpenCss 里。 */
const NAV_ENTRY_TEXT = '个性化设置'
/* 应用里「插件」这一组的分组 id（子节点容器 id = `<navId>-plugins`，折叠开关带
   data-tour=`nav-toggle-plugins`）。读源码 app/overlays/overlay-split-layout.tsx 得到：
     const expanded = disclosures[group.id] ?? group.active
     <div hidden={!expanded} id={childrenId}>…</div>
     <Button data-tour={`nav-toggle-${group.id}`} aria-expanded={expanded}
             onClick={() => setDisclosures(p => ({ ...p, [group.id]: !expanded }))} />
   → 组默认折叠（只有它自己那一页被选中时才展开）；按钮里动的是 React 状态。
   ⚠️ 所以**不能硬改 DOM**：React 一重绘就把 hidden 加回来（血例：只改 DOM 时采样那 8 秒
   是展开的，用户真用时又缩回去）。正解 = 去**按那个开关**，让状态自己变成 true。 */
const NAV_GROUP_ID = 'plugins'
let navTimer = null
let sessDragTimer = null
/* 上一次按折叠开关的时刻：点完要等 React 提交，不然下一拍又点一下会把它关回去 */
let navLastClickAt = 0
let navWasOpen = false
let navHeadNudged = false
let navBoxEl = null
const navLog = []

function navNote(kind, extra) {
  try {
    navLog.push(Object.assign({ t: Math.round(performance.now()), k: kind }, extra || {}))

    if (navLog.length > 60) navLog.shift()

    window.__hsNavLog = navLog
  } catch {
    /* 诊断不能影响功能 */
  }
}

/* 落盘的探针（一个 localStorage 键，几十字节）：排障时可以从本机的
   Local Storage 数据文件里直接读到「插件自己的版本 + 那组到底开没开 + 入口可不可见」，
   不需要用户截图。功能本身不依赖它。 */
function navProbe(extra) {
  try {
    const rail = document.querySelector("[data-tour='overlay-nav']")
    const tg = rail ? rail.querySelector("[data-tour='nav-toggle-plugins']") : null
    const entry = rail ? Array.from(rail.querySelectorAll('span')).find(el => (el.textContent || '').trim() === NAV_ENTRY_TEXT && el.children.length === 0) : null

    localStorage.setItem(
      'hermes.navProbe',
      JSON.stringify(Object.assign({ v: EFFORT_BUILD, at: Date.now(), rail: !!rail, tg: tg ? tg.getAttribute('aria-expanded') : null, vis: entry ? entry.offsetParent !== null : null, disp: navBoxEl && navBoxEl.isConnected ? getComputedStyle(navBoxEl).display : null }, extra || {}))
    )
  } catch {
    /* 落盘失败不影响功能 */
  }
}

function releaseNavForce() {
  if (!document.querySelector('[data-hs-nav-open]')) return

  for (const el of document.querySelectorAll('[data-hs-nav-open=\\"1\\"]')) {
    el.removeAttribute('data-hs-nav-open')
    el.style.removeProperty('display')
  }

  for (const el of document.querySelectorAll('[data-hs-nav-open-head=\\"1\\"]')) el.removeAttribute('data-hs-nav-open-head')
}

function navFindBox(rail) {
  const entry = Array.from(rail.querySelectorAll('span')).find(el => (el.textContent || '').trim() === NAV_ENTRY_TEXT && el.children.length === 0)

  if (!entry) return null

  return entry.closest('[hidden]') || entry.closest("div[class*='pl-1.5']") || (entry.parentElement && entry.parentElement.parentElement) || null
}

/* 兜底：万一那个开关找不到（应用改名/改结构），仍然把组体撑开 —— 只是这种撑法会被重绘弹回，
   所以只在找不到开关时用，并且每次 tick 都会补。 */
function navForceBox(box) {
  box.removeAttribute('hidden')
  box.style.setProperty('display', 'flex', 'important')
}

/* 用户自己点过组头（含那个折叠开关）= 有自己的想法 → 本次弹窗周期内不再自动展开 */
function navWatchNudge() {
  if (navWatchNudge.on) return

  navWatchNudge.on = true
  document.addEventListener(
    'pointerdown',
    event => {
      try {
        if (!navBoxEl) return

        const head = navBoxEl.previousElementSibling

        if (head && head.contains(event.target)) {
          navHeadNudged = true
          navNote('user-touched-head')
        }
      } catch {}
    },
    true
  )
}

/* 用户要的是「打开设置弹窗就直接是『个性化设置』这一页」，不用再点。
   应用按路由参数记当前页（插件页 = `?plugin=<插件id>`，见 contrib/settings-pages.ts 的说明），
   所以直接导航过去就行 —— 而且跳过去之后那一组会因为「它自己那一页是当前页」被应用自己展开
   （overlay-split-layout.tsx: expanded = disclosures[group.id] ?? group.active），
   这比插件去动 DOM 干净得多（动 DOM 会被重绘弹回）。 */
let navAutoJumped = false

function navAutoJump(s) {
  try {
    const rail = document.querySelector("[data-tour='overlay-nav']")

    if (!rail) {
      navAutoJumped = false

      return
    }

    /* 只在「设置」这种带插件设置页的叠加层里跳，别在别的叠加层里乱跳 */
    if (!rail.querySelector("[data-tour='nav-toggle-plugins']")) return

    if (s.navAutoJumpOn === false) return

    if (navAutoJumped) return

    navAutoJumped = true

    if (String(location.search || '').indexOf(`plugin=${ID}`) >= 0) {
      navNote('already-on-page')

      return
    }

    host.navigate(pluginSettingsHref(ID))
    navNote('auto-jump')
  } catch {
    /* 跳不过去就算了，用户还能自己点 */
  }
}

function openPluginNavGroup(s) {
  try {
    const rail = document.querySelector("[data-tour='overlay-nav']")

    if (!rail) {
      if (navWasOpen) {
        navWasOpen = false
        navHeadNudged = false
        navBoxEl = null
        navLastClickAt = 0
        navNote('rail-closed')
        releaseNavForce()
      }

      return
    }

    if (!navWasOpen) {
      navWasOpen = true
      navHeadNudged = false
      navBoxEl = null
      navNote('rail-open')
      setTimeout(() => navProbe({ stage: 'opened-1.6s' }), 1600)
    }

    if (s.navAutoOpenOn === false) {
      releaseNavForce()

      return
    }

    if (navHeadNudged) return

    navWatchNudge()
    navAutoJump(s)
    /* 设置弹窗一开就打标记：整弹窗的玻璃/圆角/磨砂不必等用户进过插件页 */
    markSettingsSurface()

    if (!navBoxEl || !navBoxEl.isConnected) navBoxEl = navFindBox(rail)

    const box = navBoxEl

    if (!box) return

    /* ① 首选：按应用自己的折叠开关（真状态，重绘不弹回） */
    const toggle = rail.querySelector(`[data-tour='nav-toggle-${NAV_GROUP_ID}']`) || (box.id ? rail.querySelector(`[aria-controls='${box.id}']`) : null)

    if (toggle && toggle.getAttribute('aria-expanded') === 'false' && performance.now() - navLastClickAt > 2500) {
      navLastClickAt = performance.now()
      toggle.click()
      navNote('toggle-click')
      navProbe({ stage: 'clicked' })
      setTimeout(() => navProbe({ stage: 'after-1.3s' }), 1300)
      /* 点完立刻补一遍兜底，避免应用还没提交状态那一两帧里看着还是缩着 */
      navForceBox(box)

      return
    }

    /* ② 状态已经是展开的：什么都不用做（除非样式被压着） */
    const isHidden = box.hasAttribute('hidden') || getComputedStyle(box).display === 'none'

    if (!isHidden) {
      if (box.style.getPropertyValue('display') !== 'flex') box.style.setProperty('display', 'flex', 'important')

      return
    }

    /* ③ 兜底：开关没找到 / 状态没生效时硬撑 */
    navNote('reforce')
    navForceBox(box)
  } catch {
    /* 认不到就不动，绝不影响别的功能 */
  }
}

function navAutoOpenCss(s) {
  if (s.navAutoOpenOn === false) return ''

  return `
/* 设置弹窗左列：本插件那一组（应用默认折叠）由插件扳开。
   ⚠️ 折叠的实际手段是元素上的 HTML 属性 hidden（不是 class）——
   只靠这条 CSS 会被它压住，所以 openPluginNavGroup() 里同时摘属性 + 写内联 !important；
   这条留在样式表里只是兜底。 */
[data-hs-nav-open='1'],
[data-hs-nav-open='1'][hidden] {
  display: flex !important;
}

/* 组头箭头跟着转成「已展开」，否则图标还指向右边、看着像没打开 */
[data-hs-nav-open-head='1'] svg {
  transform: rotate(90deg);
}
`
}

/* ── 字体 ───────────────────────────────────────────────────────────
   只改应用的字体变量（--font-sans / --font-mono），**不动 body 的 font-family** ——
   动 body 会把代码块、路径的等宽字体一起吃掉（实测会变成全界面一个字体）。
   预设表里的字体都是「你机器上装了 / 应用自带」的，避免选了没装的名字（浏览器会静默回退）。 */
/* 字体预设：按**本机实际装了的**字体生成（从注册表 HKLM\...\Fonts 读出来的家族名），
   所以不会出现「选了没反应」。想用列表里没有的，用下面的「自定义字体名」直接填。 */
const FONT_PRESETS = [
  ["", "跟随主题"],
  ["Microsoft JhengHei", "微软正黑"],
  ["Microsoft Sans Serif", "微软无衬线"],
  ["Microsoft YaHei", "微软雅黑"],
  ["MingLiU-ExtB", "细明体"],
  ["SimSun", "宋体"],
  ["DengXian", "等线"],
  ["FangSong", "仿宋"],
  ["KaiTi", "楷体"],
  ["SimHei", "黑体"],
  ["Noto Sans SC", "思源黑体"],
  ["Noto Serif SC", "思源宋体"],
  ["SimSun-ExtG", "宋体扩展"],
  ["FZ LanheiJian", "方正兰亭黑"],
  ["Segoe UI", "Segoe UI"],
  ["Segoe UI Variable", "Segoe UI Variable"],
  ["Arial", "Arial"],
  ["Calibri", "Calibri"],
  ["Cambria", "Cambria"],
  ["Candara", "Candara"],
  ["Corbel", "Corbel"],
  ["Constantia", "Constantia"],
  ["Georgia", "Georgia"],
  ["Tahoma", "Tahoma"],
  ["Verdana", "Verdana"],
  ["Trebuchet MS", "Trebuchet MS"],
  ["Times New Roman", "Times New Roman"],
  ["Palatino Linotype", "Palatino Linotype"],
  ["Franklin Gothic", "Franklin Gothic"],
  ["Malgun Gothic", "Malgun Gothic"],
  ["Comic Sans MS", "Comic Sans MS"],
  ["Segoe Print", "Segoe Print"],
  ["Segoe Script", "Segoe Script"],
  ["Ink Free", "Ink Free"],
  ["Sitka Text", "Sitka Text"],
  ["Cascadia Mono", "Cascadia Mono"],
  ["Cascadia Code", "Cascadia Code"],
  ["Consolas", "Consolas"],
  ["Lucida Console", "Lucida Console"],
  ["Courier New", "Courier New"],
  ["MS Gothic", "MS Gothic"]
]

const MONO_PRESETS = [
  ["", "跟随主题"],
  ["JetBrains Mono", "JetBrains Mono"],
  ["Cascadia Mono", "Cascadia Mono"],
  ["Cascadia Code", "Cascadia Code"],
  ["Consolas", "Consolas"],
  ["Lucida Console", "Lucida Console"],
  ["Courier New", "Courier New"],
  ["MS Gothic", "MS Gothic"],
  ["ui-monospace", "ui-monospace"]
]

/* 字体名进 CSS 前先洗一遍：只留字母/数字/空格/连字符/下划线/中文，再包一层引号 */
const cleanFont = v => String(v || '').replace(/[^A-Za-z0-9 \-\u4e00-\u9fff_]/g, '').trim()

function fontCss(s) {
  const fam = cleanFont(s.fontFamily)
  const mono = cleanFont(s.fontMono)
  const weight = String(s.fontWeight || '').trim()
  const out = []

  if (fam) {
    out.push(`/* 界面字体：只改 --font-sans */
html {
  --font-sans: "${fam}", system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif !important;
}`)
  }

  if (mono) {
    out.push(`/* 等宽字体（代码块 / 路径 / 日志） */
html {
  --font-mono: "${mono}", ui-monospace, 'Cascadia Mono', Consolas, monospace !important;
}`)
  }

  if (weight === '500' || weight === '600') {
    out.push(`/* 界面文字稍微加粗一点 */
html body {
  font-weight: ${weight} !important;
}`)
  }

  return out.length ? `\n${out.join('\n\n')}\n` : ''
}

/* ── 左侧会话列表：选中行高亮 ─────────────────────────────────────────
   应用给「当前选中的会话行」加的是 `bg-(--ui-row-active-background)` 这个类
   （apps/desktop/src/app/chat/sidebar/session-row.tsx：`isSelected && 'bg-(--ui-row-active-background)'`）。
   类名里的 Tailwind 任意值不会被改写，所以按**类名字符串**找它最稳
   （React 重绘后标记会掉，1.2 秒的周期检查补回来）。 */
function syncSessHighlight(s) {
  if (typeof document === 'undefined') return

  const on = s.sessHlOn !== false
  const color = String(s.sessHlColor || '#4dd0ff')
  /* 收窄到侧栏里找：原来的全文档子串属性选择器要扫所有元素，回复时每 400ms 一次太重 */
  const row = on
    ? document.querySelector("[data-slot='sidebar-wrapper'] [class*='ui-row-active-background']") ||
      document.querySelector('[class*="ui-row-active-background"]')
    : null

  for (const old of document.querySelectorAll('[data-hs-sel]')) {
    if (old !== row || !on) {
      old.removeAttribute('data-hs-sel')
      old.style.removeProperty('--hs-sel-color')
    }
  }

  if (!row) return

  row.setAttribute('data-hs-sel', '1')

  if (row.style.getPropertyValue('--hs-sel-color') !== color) row.style.setProperty('--hs-sel-color', color)
}

function sessHlCss(s) {
  if (s.sessHlOn === false) return ''

  const color = String(s.sessHlColor || '#4dd0ff')
  const sheen = s.sessHlBar !== false
  const hover = s.sessHlHover !== false

  /* ⚠️ 不要再画「外框」：选中行标记所在的那个元素和会话行**视觉上的盒子不是同一个**
     （留白不同、右侧还会超出外框）—— 用户：「还是形状打架」「不要做外边框」。
     只改**背景**：背景不会和任何形状打架，也不需要知道行有多大。
     反光 = 一条斜向的亮带（高光）+ 一层很淡的底色。 */
  return `
/* 当前选中的会话：只上背景，不动形状（不加边框 / 不改圆角 / 不加外发光） */
[data-hs-sel='1'] {
  background-color: color-mix(in srgb, ${color} 10%, transparent) !important;
${sheen ? `  background-image: linear-gradient(115deg, color-mix(in srgb, ${color} 30%, transparent) 0%, color-mix(in srgb, ${color} 12%, transparent) 24%, color-mix(in srgb, #ffffff 12%, transparent) 41%, color-mix(in srgb, ${color} 8%, transparent) 58%, color-mix(in srgb, ${color} 18%, transparent) 100%) !important;\n` : ''}}

[data-hs-sel='1'] .hover-marquee,
[data-hs-sel='1'] [class*="font-medium"] {
  color: var(--ui-text-primary, #eef1f6) !important;
}
${hover ? `
/* 鼠标划过的会话：只加一层淡色，不动形状 */
[data-slot='sidebar-wrapper'] [data-index]:hover {
  background-color: color-mix(in srgb, ${color} 7%, transparent) !important;
}
` : ''}
`
}

/* ── 按需补标记（节流） ───────────────────────────────────────────────
   ⚠️ 只靠 1.2 秒的定时器不够：应用（尤其会话在流式输出 / 滚动 / 跟随）会持续重绘，
   把运行时打的标记冲掉，中间那段就是「失效」（用户：「设置一关闭，效果就失效了」——
   设置弹窗开着时会话被冻住、标记没被冲，所以看着才有效）。
   这里在 DOM 变动 / 滚动时按需补一次，节流 250ms；定时器仍作为兜底。
   注意：观察者只做**很轻**的查询，绝不能在里面做重活（曾因观察者里跑 :has() 卡死渲染进程）。 */
let hsRemarkTimer = 0
let hsRemarkPending = false

function hsRemarkSoon() {
  if (typeof window === 'undefined' || hsRemarkPending) return

  hsRemarkPending = true

  hsRemarkTimer = window.setTimeout(() => {
    hsRemarkPending = false

    /* 页面不可见（最小化 / 切走）时什么都不用补 */
    if (typeof document !== 'undefined' && document.hidden) return

    const cur = $settings.get()

    try {
      syncSeg(cur)
    } catch {
      /* 单点失败不影响其它 */
    }

    try {
      syncSessHighlight(cur)
    } catch {
      /* 单点失败不影响其它 */
    }

    try {
      syncSessDrag(cur)
    } catch {
      /* 单点失败不影响其它 */
    }
  }, 400)
}

function hsRemarkHook() {
  if (typeof window === 'undefined' || window.__hsRemarkHooked) return

  window.__hsRemarkHooked = true

  try {
    /* 只盯类名 / 内联样式 / 跟随状态的变化 —— 这三样正是应用重绘时会动的东西 */
    const mo = new MutationObserver(() => hsRemarkSoon())

    mo.observe(document.documentElement, {
      attributeFilter: ['class', 'style', 'data-following', 'hidden'],
      attributes: true,
      childList: true,
      subtree: true
    })
    window.__hsRemarkObserver = mo
  } catch {
    /* 观察者建不起来就退回定时器 */
  }

  try {
    /* 滚动是 capture 阶段，才能收到内层滚动容器的滚动 */
    document.addEventListener('scroll', () => hsRemarkSoon(), { capture: true, passive: true })
    document.addEventListener('visibilitychange', () => hsRemarkSoon())
  } catch {
    /* 无所谓 */
  }
}

function syncSeg(s) {
  if (typeof document === 'undefined') return

  const on = s.segGlassOn !== false
  const boxes = new Set()

  for (const btn of document.querySelectorAll('button[aria-pressed]')) {
    const parent = btn.parentElement

    if (parent && parent.querySelectorAll('button[aria-pressed]').length >= 2) boxes.add(parent)
  }

  for (const el of document.querySelectorAll('[data-hs-seg]')) {
    if (!boxes.has(el)) el.removeAttribute('data-hs-seg')
  }

  if (!on) return

  for (const el of boxes) if (!el.hasAttribute('data-hs-seg')) el.setAttribute('data-hs-seg', '1')
}

function segCss(s) {
  if (s.segGlassOn === false) return ''

  const glow = String(s.segGlowColor || '#4dd0ff')
  const k = Math.max(0, Math.min(100, Number(s.segGlowStrength) || 0))

  return `
/* 选择框（分段控件）：整条磨砂 */
[data-hs-seg='1'] {
  background: color-mix(in srgb, var(--ui-panel, #161a20) 42%, transparent) !important;
  backdrop-filter: blur(6px) saturate(1.05) !important;
  -webkit-backdrop-filter: blur(6px) saturate(1.05) !important;
}

/* 选中的那一格：磨砂底 + 内发光 */
[data-hs-seg='1'] button[aria-pressed='true'] {
  background: color-mix(in srgb, var(--ui-panel, #161a20) 62%, transparent) !important;
  backdrop-filter: blur(10px) saturate(1.12) !important;
  -webkit-backdrop-filter: blur(10px) saturate(1.12) !important;
  border: 1px solid color-mix(in srgb, ${glow} 45%, transparent) !important;
  border-radius: 8px !important;
  box-shadow: inset 0 0 12px color-mix(in srgb, ${glow} ${k}%, transparent), 0 0 10px color-mix(in srgb, ${glow} ${Math.round(Math.min(30, k * 0.45))}%, transparent) !important;
  color: var(--ui-text, #eef1f6) !important;
}

[data-hs-seg='1'] button[aria-pressed='false'] {
  background: transparent !important;
}
`
}

/* ── 会话栏右侧「拖宽」细线 ──────────────────────────────────────────
   ⚠️ 这段曾经被误删（v502 删旧「窗口圆点」代码时连它一起删了）→ 变成
   「被调用但没定义」，interval 每 1.2 秒抛一次 ReferenceError、细线从来没被创建。
   教训：删代码前先 grep 一遍要删的区间里还有什么；改完用设置审计探针跑一遍
   （它会把这类 ReferenceError 直接打出来）。 */
const SESS_DRAG_ID = 'hs-sess-drag'

function syncSessDrag(s) {
  if (typeof document === 'undefined') return

  const wrapper = document.querySelector("[data-slot='sidebar-wrapper']")
  const on = s.sessDragOn !== false && !!wrapper
  let el = document.getElementById(SESS_DRAG_ID)

  if (!on) {
    if (el) el.remove()

    return
  }

  if (!el) {
    el = document.createElement('div')
    el.id = SESS_DRAG_ID
    el.title = '拖动调整会话栏宽度'
    el.style.cssText = 'position:fixed;top:0;height:100vh;width:6px;cursor:col-resize;background:transparent;z-index:2147482000;transition:background .15s ease'
    el.addEventListener('pointerenter', () => {
      el.style.background = 'color-mix(in srgb, var(--ui-accent, #4c7dff) 55%, transparent)'
    })
    el.addEventListener('pointerleave', () => {
      if (!el.dataset.dragging) el.style.background = 'transparent'
    })
    el.addEventListener('pointerdown', event => {
      event.preventDefault()
      el.dataset.dragging = '1'
      el.style.background = 'color-mix(in srgb, var(--ui-accent, #4c7dff) 70%, transparent)'

      const startX = event.clientX
      const s0 = $settings.get()
      const startRem = Math.max(10, Math.min(34, Number(s0.sessColWidth) || 20))
      const pxPerRem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
      const move = ev => {
        const rem = Math.max(10, Math.min(34, startRem + (ev.clientX - startX) / pxPerRem))

        update({ sessColWidth: Math.round(rem * 100) / 100 })
        syncSessDrag($settings.get())
      }
      const up = () => {
        delete el.dataset.dragging
        el.style.background = 'transparent'
        window.removeEventListener('pointermove', move, true)
        window.removeEventListener('pointerup', up, true)
      }

      window.addEventListener('pointermove', move, true)
      window.addEventListener('pointerup', up, true)
    })
    document.body.appendChild(el)
  }

  const r = wrapper.getBoundingClientRect()
  const left = Math.round(r.right + 1)

  if (el.dataset.left !== String(left)) {
    el.dataset.left = String(left)
    el.style.left = `${left}px`
  }
}

function markSettingsSurface() {
  try {
    const anchor = document.querySelector('[data-hs-settings-page]')
    let panel = anchor ? anchor.closest('[data-glass-raised]') : null

    /* 用户要的是「点开设置后**整个弹窗**都归『设置弹窗』那套设定管」。
       原来只认插件自己那一页上的标记 → 没进过插件页就完全不管（开着设置也是原样）。
       这里加一个**稳定锚点**：左列里带插件折叠开关的那个叠加层就是「设置」。
       （cron / 定时任务 / 智能体等叠加层共用 [data-glass-raised]，靠这个开关把它们区分开。） */
    if (!panel) {
      const rail = document.querySelector("[data-tour='overlay-nav']")

      if (rail && rail.querySelector("[data-tour='nav-toggle-plugins']")) panel = rail.closest('[data-glass-raised]')
    }

    if (panel) panel.setAttribute('data-hs-settings-surface', '1')

    /* 清掉残留：设置页关掉后旧面板会留在 DOM 上 */
    for (const el of document.querySelectorAll('[data-hs-settings-surface=\"1\"]')) {
      if (el !== panel) el.removeAttribute('data-hs-settings-surface')
    }
  } catch {
    /* 认不到就不上玻璃，不影响别的功能 */
  }
}

function effortPrevElement(node) {
  let cur = node
  let climbed = false

  while (cur) {
    const prev = cur.previousElementSibling

    if (prev) {
      /* 直接兄弟就返回它本身 —— **不能下钻**：模型 pill 里第一个子节点是 SVG 的
         <path>，下钻会把「前一个元素」认成图标（实测就是这样：prev.tag === 'path'）。 */
      if (!climbed) return prev

      /* 只有向上跨过一层（前一个是某层的最后一个子节点）时，才需要下钻到最深子节点 */
      let last = prev

      while (last.lastElementChild) last = last.lastElementChild

      return last
    }

    cur = cur.parentElement
    climbed = true
  }

  return null
}

/** 「真实可见」判定 —— 应用里同一个组件常有多份（会话磁贴各一套），
    只看 querySelector 会命中隐藏的那份。判据同插件别处：尺寸 + display/visibility/opacity。 */
function effortReallyVisible(node) {
  if (!node || typeof node.getBoundingClientRect !== 'function') return false

  const rect = node.getBoundingClientRect()

  if (rect.width < 4 || rect.height < 4) return false

  const style = typeof getComputedStyle === 'function' ? getComputedStyle(node) : null

  if (style) {
    if (style.display === 'none') return false
    if (style.visibility === 'hidden') return false
    if (Number(style.opacity) < 0.05) return false
  }

  return true
}

/** 真正在屏幕上的那个推理 pill（磁贴里隐藏的那份不算）。 */
function effortReasoningPill() {
  if (typeof document === 'undefined') return null

  const pills = [...document.querySelectorAll("[data-testid='reasoning-pill']")]

  return pills.find(effortReallyVisible) || pills[0] || null
}

function effortModelPill() {
  if (typeof document === 'undefined') return null

  /* ① 最稳的一条：主会话的模型 pill 带 data-tour="model-pill"
     （源码 `useTourMarker('model-pill')` → 只在 **primary 视图**给值，
      会话磁贴/浮层拿不到 —— 顺带解决“隐藏磁贴先被命中”的问题，
      而这一直是我认错控件的主因）。构建产物里已确认存在这个属性值。 */
  /* ① 应用自己的钩子最稳（实测 tours 里有 "model-pill"） */
  const byTour = document.querySelector("[data-tour='model-pill']")

  if (byTour) {
    effortModelSource = 'data-tour'

    return byTour
  }

  /* ② 退一步：文档顺序上紧挨在推理 pill 前面的元素（跨层时才下钻） */
  const prev = effortPrevElement(effortReasoningPill())

  if (prev && !prev.closest(`#${EFFORT_WRAP_ID}`)) {
    effortModelSource = 'prev-element'

    return prev
  }

  /* ② 次选：应用的模型 pill 带一个**格式固定**的 aria-label
     （源码 `modelTitle: (provider, model) => `模型 · ${provider}: ${model}``，
     挂在 pill 的 aria-label 上）。按这个格式找，完全不依赖它在 DOM 里的位置 ——
     位置推断已经错过两次（认到过附件「＋」、也认到过会话标题按钮）。 */
  /* 分支1（没有实时模型菜单）的 pill 是普通 Button，aria-label 是「打开模型选择器」/
     「Open model picker」（构建产物里确认过这两个字符串），**没有**「模型 · …」格式。
     两种都认。 */
  const PICKER_LABELS = ['打开模型选择器', 'Open model picker', '切换模型', 'Switch model']
  const byLabel = [...document.querySelectorAll('[aria-label], [title]')].filter(node => {
    const label = (node.getAttribute('aria-label') || node.getAttribute('title') || '').trim()

    return /^(模型|Model)\s*[·:：]/.test(label) || PICKER_LABELS.some(text => label.startsWith(text))
  })

  /* 自查补的坑：磁贴各有一套，隐藏磁贴里的模型 pill 也会命中这个格式 ——
     所以同样要优先「真正可见」的那个（和推理 pill 用的是同一个判据）。 */
  if (byLabel.length) {
    effortModelSource = 'aria-label'

    return byLabel.find(effortReallyVisible) || byLabel[0]
  }

  const reasoning = effortReasoningPill()

  /* 首选：跟推理 pill **同一排**（兄弟节点）的那个触发器 —— 这两个 pill 在
     composer 里是并排的，比“全局第一个有文字的下拉触发器”可靠得多
     （composer 里还有别的触发器，按全局取会标错控件、模型 pill 反而没收起来）。 */
  if (reasoning) {
    /* 推理 pill 外面包着 <Tip>（tooltip 包装层），它的**直接父节点只有它自己** ——
       所以先向上走到「真正的那一排」（有多个元素子节点的那层）。 */
    let row = reasoning.parentElement

    while (row && row.children.length < 2) row = row.parentElement

    if (row) {
      /* 注意：**不能要求「有文字」** —— 紧凑模式的模型 pill 只渲染一个箭头
         （源码 `label = compact ? <ChevronDown/> : …`），文字是空的；
         一旦按“有文字”过滤就会跳过它、退到下一个候选（会话标题按钮），
         弹窗里「模型」行就显示成会话标题（用户报过）。 */
      const triggers = [...row.querySelectorAll("[data-slot='dropdown-menu-trigger']")].filter(node => node !== reasoning)

      /* 取文档顺序里**紧挨在推理 pill 之前**的那个触发器 = 模型 pill。
         （不能取“这一排第一个触发器” —— 同排还有附件「＋」这类按钮，
         实测会把标记打到「＋」上，模型 pill 反而没被收起来。） */
      const before = triggers.filter(node => reasoning.compareDocumentPosition(node) & 2 /* DOCUMENT_POSITION_PRECEDING */)

      if (before.length) {
        effortModelSource = 'position'

        return before[before.length - 1]
      }

      if (triggers.length) {
        effortModelSource = 'position-first'

        return triggers[0]
      }
    }
  }

  /* 兜底：全局找，但排除我们自己的节点与推理 pill */
  for (const trigger of document.querySelectorAll("[data-slot='dropdown-menu-trigger']")) {
    if (trigger.getAttribute('data-testid') === 'reasoning-pill') continue
    if (trigger.closest(`#${EFFORT_WRAP_ID}`)) continue
    if (trigger.textContent?.trim()) {
      effortModelSource = 'global-fallback'

      return trigger
    }
  }

  effortModelSource = 'none'

  return null
}

/** 从打开着的菜单里把条目文案抓下来缓存（就是用户说的「左边的模型列表」）。
    应用不让我们搬 React 节点，所以镜像一份文案，点它时再去点应用里同名的那一项。 */
function effortCacheMenuItems() {
  if (typeof document === 'undefined') return

  const found = []

  for (const node of document.querySelectorAll("[role='menuitem'], [role='menuitemradio'], [data-slot='dropdown-menu-item']")) {
    if (node.closest(`#${EFFORT_WRAP_ID}`)) continue

    /* 带 aria-haspopup='menu' 的是**触发器**，不是模型项：
       - composer 上的模型/推理 pill（Radix 把菜单里的触发器渲染成 role=menuitem）
         → 里面是我改过的「模型名 · 等级」文案，抓进来就会出现「名称对不上」
       - 模型菜单里的**提供方家族**（点开是子菜单）
       实测抓到过 `OpenCode Go` 和 `DeepSeek V4.1FlashHigh`，都是这一类。 */
    if (node.getAttribute('aria-haspopup') === 'menu') continue

    const text = (node.textContent || '').replace(/\s+/g, ' ').trim()

    if (!text || text.length > 60) continue
    if (effortRankOf(text) >= 0) continue            /* 等级行不算模型 */
    if (EFFORT_MY_LABEL.test(text)) continue          /* 我自己合成的「模型 · 等级」*/
    if (['刷新模型', 'Refresh models', '添加自定义模型', 'Add custom model', '编辑模型', 'Edit models'].some(label => text.startsWith(label))) continue
    if (text.startsWith('思考') || text.startsWith('Thinking') || text.startsWith('快速') || text.startsWith('Fast')) continue

    if (!found.includes(text)) found.push(text)
  }

  if (found.length) {
    effortState.models = found.slice(0, 40)
  } else if (effortState.models.length) {
    /* 本次没扫到（弹窗自己那套被过滤光了）→ 保留上次真正从模型菜单抓到的列表，
       否则列表会被自己的弹窗覆盖成空/错。 */
  }

  effortDiag.models = effortState.models.join(' / ').slice(0, 200)
}

/** 打开应用自己的模型菜单（pill 可能被我们视觉隐藏，所以整套事件都发）。 */
function effortOpenModelMenu(pill) {
  const el = pill || effortModelPill()

  if (!el) return

  /* 关键：我们把模型 pill 视觉收起来了（width:0）—— 而 Radix 打开菜单时要**量触发器的矩形**
     来定位浮层，0 宽会把菜单定到看不见的地方（用户报「点了打不开」）。
     所以派发前先恢复真实尺寸，量完（下一帧）再收起。 */
  const wasHidden = true    /* CSS 是按应用属性收起的，所以这里总是先临时放开 */

  effortReportOpen(el)
  el.classList.add('hs-pill-open')

  try {
    el.focus?.({ preventScroll: true })
  } catch {
    /* 聚焦失败不影响后面的事件 */
  }

  try {
    /* pointerType/isPrimary 要写全：Radix 的触发器会校验指针事件是不是"主指针"，
       只发裸 pointerdown 有时会被忽略（用户报「点了打不开」）。 */
    const opts = { bubbles: true, button: 0, cancelable: true, isPrimary: true, pointerType: 'mouse', view: window }

    el.dispatchEvent(new PointerEvent('pointerdown', opts))
    el.dispatchEvent(new PointerEvent('pointerup', opts))
    el.dispatchEvent(new MouseEvent('mouseup', opts))
    el.dispatchEvent(new MouseEvent('click', opts))

    /* 只留一次 Enter 兜底：连发 3 个键会在触发器上把菜单反复开关（可疑卡死源）。 */
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' }))
  } catch {
    try {
      el.click()
    } catch {
      /* 都不行就算了，诊断行会显示认到了谁 */
    }
  } finally {
    if (wasHidden) {
      const hide = () => el.classList.remove('hs-pill-open')

      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(hide))
      else setTimeout(hide, 32)
    }
  }
}

/** 右下角那一个 pill 直接显示「模型名 · 强度」——两个入口合成一个（用户要求）。 */
function effortPaintPillLabel(model, level) {
  if (typeof document === 'undefined') return

  const pill = effortReasoningPill()

  if (!pill) return

  const span = pill.querySelector('span')

  /* pending 时应用渲染的是转圈图标，没有 span —— 那就别动它 */
  if (!span) return

  const want = model && level ? `${model} · ${level}` : level || model || ''

  /* 只在内容真的不同时写，避免和 MutationObserver 互相触发 */
  if (span.textContent !== want) span.textContent = want
}

function effortModelName(pill) {
  if (!pill) return '当前模型'

  const text = (pill.textContent || '').replace(/\s+/g, ' ').trim()

  if (text) return text

  /* 紧凑模式：pill 里只有箭头，名字在 aria-label/title 上，
     格式是「模型 · <提供方>: <模型名>」→ 去掉前缀、取最后一个冒号之后。 */
  const label = (pill.getAttribute('aria-label') || pill.getAttribute('title') || '').replace(/\s+/g, ' ').trim()

  if (!label) return '当前模型'

  const afterDot = label.includes('·') ? label.slice(label.indexOf('·') + 1).trim() : label
  /* 冒号有半角也有**全角**（构建产物里两种都在：`模型 · ${e}: ${t}` / `模型 · ${e}：${t}`） */
  const at = Math.max(afterDot.lastIndexOf(':'), afterDot.lastIndexOf('：'))
  const afterColon = at >= 0 ? afterDot.slice(at + 1).trim() : afterDot

  return afterColon || afterDot || '当前模型'
}

/** 在打开的菜单里找文案匹配的项（应用菜单项文案带省略号/后缀，用前缀匹配）。 */
function effortFindMenuItem(labels) {
  if (typeof document === 'undefined') return null

  for (const node of document.querySelectorAll("[role='menuitem'], [data-slot='dropdown-menu-item']")) {
    const text = (node.textContent || '').replace(/\s+/g, ' ').trim()

    for (const label of labels) {
      if (text.startsWith(label)) return node
    }
  }

  return null
}

/** 在打开的菜单里找同名项并点它（带重试，菜单渲染需要几十毫秒）。 */
function effortClickMenuItem(labels, tries = 0) {
  const item = effortFindMenuItem(labels)

  if (item) {
    effortPick(item)

    return
  }

  if (tries < 20) setTimeout(() => effortClickMenuItem(labels, tries + 1), 60)
}

/** 三个动作的执行：关本弹窗 → 点模型 pill → 等菜单 → 点同名项。 */
function effortRunModelAction(action) {
  effortDiag.lastAction = 'action-' + action.kind

  try {
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }))
  } catch {
    /* 关不掉也不影响下一步 */
  }

  const openMenu = () => {
    effortOpenModelMenu(effortModelPill())
  }

  const waitItem = (tries = 0) => {
    const item = effortFindMenuItem(action.labels)

    if (item) {
      effortPick(item)

      return
    }

    if (tries < 20) setTimeout(() => waitItem(tries + 1), 60)
  }

  setTimeout(() => {
    openMenu()
    setTimeout(() => waitItem(), 80)
  }, 90)
}

/** 右下角 pill 的「收起模型 pill + 合成文案」—— **必须独立于弹窗执行**。
    之前这段写在 effortMount 里，而 mount 只在弹窗打开时触发，
    所以用户平时看右下角（弹窗没开）时它从来没跑过（用户报「没改动呀」）。 */
/* ─────────────── 模型列表弹窗里的推理强度（一个弹窗搞定） ─────────────── */

/** 应用**模型列表**弹窗：当前打开、且不含推理单选组的那个菜单内容。 */
function effortModelMenu() {
  if (typeof document === 'undefined') return null

  for (const node of document.querySelectorAll("[data-slot='dropdown-menu-content'][data-state='open']")) {
    if (!node.querySelector(EFFORT_GROUP)) return node
  }

  for (const node of document.querySelectorAll("[data-slot='dropdown-menu-content']")) {
    if (!node.querySelector(EFFORT_GROUP) && node.querySelector("[role='menuitem']")) return node
  }

  return null
}

/** 默认档位表：应用推理弹窗没打开过时用它（顺序与档位一一对应，驱动按序号匹配）。 */
const EFFORT_DEFAULT_LEVELS = ['最小', '低', '中', '高', '极高', '最高', '超高']

/** 等级文案表：优先用当前打开着的推理弹窗，其次用缓存，最后用默认表。 */
function effortMenuLevels() {
  const popup = effortPopup()

  if (popup) {
    const labels = effortItems(popup.querySelector(EFFORT_GROUP))
      .map(item => (item.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)

    if (labels.length) effortState.menuLevels = labels
  }

  return effortState.menuLevels?.length ? effortState.menuLevels : EFFORT_DEFAULT_LEVELS
}

/** 把「当前档位序号」写到两个 pill 上 —— 供 CSS 按档位配色，
    这样模型名和推理强度的流光颜色会跟着当前档位走（高=黄、最高=紫…）。 */
function effortTagPillRank() {
  if (typeof document === 'undefined') return

  const rank = Math.max(0, effortRankOf(effortCurrentLevel()))
  const want = String(rank)

  for (const el of [effortModelPill(), effortReasoningPill()]) {
    if (!el) continue
    if (el.getAttribute('data-hs-effort-rank') !== want) el.setAttribute('data-hs-effort-rank', want)
    effortEnsureTextSpan(el)
  }
}

/* 保证 pill 里有一个**可着色的文字节点**，并打上我自己的类 `.hs-pill-text`。
   ⚠️ 不要依赖标签名（曾写 `span:not(:has(svg)):not(:has(span))`）：
   实测模型 pill 的文字可能落在 `<div>` 里、或与箭头 svg **在同一个 span 里** ——
   两种形状下标签选择器一条都不命中（用户报「模型名称无颜色」）。
   做法：① 先找「自身有文字、且不含 svg」的最深元素直接标记（不动 DOM 结构，最稳）；
        ② 找不到（文字与 svg 混在同一元素）才把文字节点单独包一层 span。 */
function effortEnsureTextSpan(pill) {
  if (typeof document === 'undefined' || !pill) return null

  const marked = pill.querySelector('.hs-pill-text')

  if (marked && (marked.textContent || '').trim()) return marked

  /* ⚠️ 这里**绝不能搬动 DOM 结构**（曾经把文字节点搬进新建的 span）。
     推理/模型 pill 是 React 管的：把它的文字节点挪走会让 React 的虚拟树与真实 DOM
     对不上 → 重渲染 → 我的 observer 又搬一次 → **死循环**，表现是「点推理强度整个
     Hermes 卡死、只能重启」（用户报过）。所以只做「给现成元素加一个类」，
     加类不会改变树结构、也不会让 React 重渲染。 */
  const els = [...pill.querySelectorAll('*')].filter(
    node => !node.classList.contains('hs-pill-text') && (node.textContent || '').trim()
  )

  /* 取最深的一个（尽量只圈住文字那一层） */
  const target = els.length ? els[els.length - 1] : (pill.textContent || '').trim() ? pill : null

  if (!target) return null

  target.classList.add('hs-pill-text')

  return target
}

/** 当前等级：推理 pill 的原生文案就是一个等级（被我写过合成串时取尾巴那段）。 */
function effortCurrentLevel() {
  const span = effortReasoningPill()?.querySelector('span')
  const raw = (span?.textContent || '').replace(/\s+/g, ' ').trim()
  const match = raw.match(/[·・]\s*(最小|低|中|高|极高|最高|超高|min|minimal|lo|low|mid|medium|med|high|hi|very high|max|maximal|ultra)\s*$/i)

  return (match ? match[1] : raw).trim()
}

/** 合成事件打开任意触发器（已验证：合成事件能到，虽然应用会吞掉内层监听）。 */
function effortOpenTrigger(el) {
  if (!el) return

  /* 触发器被我视觉收起时（width:0）必须先放开：Radix 要量它的矩形来定位浮层。
     量完下一帧再收回，不闪。 */
  const wasHidden = true

  el.classList.add('hs-pill-open')

  try {
    el.focus?.({ preventScroll: true })
  } catch {
    /* 忽略 */
  }

  try {
    const opts = { bubbles: true, button: 0, cancelable: true, isPrimary: true, pointerType: 'mouse', view: window }

    el.dispatchEvent(new PointerEvent('pointerdown', opts))
    el.dispatchEvent(new PointerEvent('pointerup', opts))
    el.dispatchEvent(new MouseEvent('mouseup', opts))
    el.dispatchEvent(new MouseEvent('click', opts))
  } catch {
    try {
      el.click()
    } catch {
      /* 都不行就算了 */
    }
  } finally {
    if (wasHidden) {
      const hide = () => el.classList.remove('hs-pill-open')

      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(hide))
      else setTimeout(hide, 32)
    }
  }
}

/** 关掉当前打开的菜单，让应用自己收拾状态。 */
function effortCloseMenus() {
  try {
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }))
  } catch {
    /* 忽略 */
  }
}

/** 让应用自己切到某一档：短暂打开推理弹窗 → 点同名等级项 → 关掉。
    期间把那个弹窗设成不可见，避免闪一下（用户要求只用一个弹窗）。 */
function effortDriveLevel(label) {
  const open = effortPopup()

  /* 按**档位序号**匹配，不按字面文案比：弹窗里可能是「超高」，而 pill 上是「Med/High」。
     先按序号找，找不到再退回按文案找。 */
  const wantRank = effortRankOf(label)

  const clickIt = node => {
    const items = [...node.querySelectorAll(EFFORT_ITEM)]
    const byText = items.find(item => (item.textContent || '').replace(/\s+/g, ' ').trim() === label)
    const target = byText || (wantRank >= 0 ? items.find(item => effortRankOf((item.textContent || '').trim()) === wantRank) : null)

    if (!target) return false

    effortPick(target)

    return true
  }

  if (open) {
    open.style.visibility = 'hidden'
    clickIt(open)
    effortCloseMenus()

    return Promise.resolve(true)
  }

  const pill = effortReasoningPill()

  if (!pill) return Promise.resolve(false)

  effortOpenTrigger(pill)

  return new Promise(resolve => {
    let tries = 0

    const tick = () => {
      const node = effortPopup()

      if (node) {
        node.style.visibility = 'hidden'

        if (clickIt(node)) {
          effortCloseMenus()
          resolve(true)

          return
        }
      }

      tries += 1

      if (tries < 25) setTimeout(tick, 60)
      else {
        effortCloseMenus()
        resolve(false)
      }
    }

    setTimeout(tick, 60)
  })
}

/** 在模型列表弹窗里注入「推理强度」行（同一个弹窗里选模型 + 选强度）。 */
/* 给「模型列表弹窗」等下拉弹窗打标记（玻璃靠它认）。
   ⚠️ 必须**独立**于推理滑条：滑条只在 `menuEffortOn` 打开时才挂，而那个开关默认是关的 ——
   把标记写在挂滑条那一步里，默认状态下标记从不写、玻璃永远不生效（用户报「模型列表弹窗
   没有同步玻璃」，根因就是这个）。应用那个弹窗没有任何可认的钩子，所以只能按「打开着的、
   带菜单项、且不是推理强度弹窗」来认。 */
function effortMarkModelMenus() {
  if (typeof document === 'undefined') return

  for (const node of document.querySelectorAll("[data-slot='dropdown-menu-content']")) {
    /* 推理强度弹窗自己有 data-hs-effort 标记，走另一套规则 */
    if (node.querySelector(EFFORT_GROUP)) continue
    if (!node.querySelector("[role='menuitem'], [role='menuitemradio'], [data-slot='dropdown-menu-item']")) continue
    if (node.getAttribute('data-hs-menu') !== '1') node.setAttribute('data-hs-menu', '1')
  }
}

/* 模型列表弹窗行尾那个「>」：应用的旧结构（dropdown-menu-sub-trigger 包 chevron）在
   「去掉子菜单」之后就不存在了 —— 中间层没了，靠层级的选择器全部落空，箭头就留在那儿
   （用户报「模型右边的箭头没有隐藏，还在」）。改成 JS 在**已被标记的模型菜单**里按 class
   找 chevron-right → 打 data-hs-menu-arrow，CSS 认标记（和 pill 箭头同一套打法）。 */
function stampMenuArrows() {
  if (typeof document === 'undefined') return

  let menus = []

  try {
    menus = Array.from(document.querySelectorAll("[data-hs-menu='1']"))
  } catch {
    return
  }

  for (const menu of menus) {
    let chevs = []

    try {
      chevs = Array.from(menu.querySelectorAll("[class*='chevron-right']"))
    } catch {
      continue
    }

    for (const el of chevs) {
      if (!el.hasAttribute('data-hs-menu-arrow')) el.setAttribute('data-hs-menu-arrow', '1')
    }
  }
}

function effortMountMenuEffort(s) {
  if (typeof document === 'undefined') return

  const menu = effortModelMenu()

  if (!menu) return

  /* 打标记：玻璃（模型名弹窗那一套）靠它认这个弹窗 —— 应用的模型列表弹窗
     本身没有任何可认的钩子，只有插件挂进来的推理滑条能定位它。 */
  menu.setAttribute('data-hs-menu', '1')

  const levels = effortMenuLevels()

  if (!levels.length) return

  const curRank = effortRankOf(effortCurrentLevel())
  const existing = menu.querySelector(`#${MENU_WRAP_ID}`)

  if (existing && existing.getAttribute('data-hs-build') === EFFORT_BUILD) {
    for (const chip of existing.querySelectorAll('[data-hs-key]')) {
      chip.classList.toggle('is-on', effortRankOf(chip.getAttribute('data-hs-key')) === curRank)
    }

    return
  }

  if (existing) existing.remove()

  const wrap = document.createElement('div')

  wrap.id = MENU_WRAP_ID
  wrap.setAttribute('data-hs-build', EFFORT_BUILD)
  wrap.className = 'hs-effort-inmenu'

  const title = document.createElement('div')

  title.className = 'hs-effort-inmenu-title'
  title.textContent = '推理强度'
  wrap.appendChild(title)

  /* 流光滑条：和之前那版视觉一致（左暗右亮渐变 + 银河闪动），复用 .hs-effort-* 样式。 */
  const track = document.createElement('div')

  track.className = 'hs-effort-track hs-effort-inmenu-track'

  const fill = document.createElement('div')

  fill.className = 'hs-effort-fill'

  const knob = document.createElement('div')

  knob.className = 'hs-effort-knob'
  track.append(fill, knob)
  wrap.appendChild(track)

  const count = levels.length
  const rankOf = label => {
    const rank = effortRankOf(label)

    return rank >= 0 ? rank : 0
  }

  const paint = rank => {
    const ratio = count > 1 ? rank / (count - 1) : 0

    wrap.style.setProperty('--hs-effort-p', String(ratio))
    knob.setAttribute('data-hs-rank', String(rank))
    fill.style.width = `${ratio * 100}%`
    knob.style.left = `${ratio * 100}%`

    for (const node of wrap.querySelectorAll('.hs-effort-inmenu-level')) {
      node.classList.toggle('is-on', Number(node.getAttribute('data-hs-rank')) === rank)
    }
  }

  /* 当前档位文字（让用户知道现在选的是哪一档）*/
  const levelRow = document.createElement('div')

  levelRow.className = 'hs-effort-inmenu-levels'

  for (let i = 0; i < count; i++) {
    const node = document.createElement('span')

    node.className = 'hs-effort-inmenu-level'
    node.setAttribute('data-hs-rank', String(i))
    node.textContent = levels[i]
    node.style.cursor = 'pointer'
    effortHit(node, 'menulevel', () => {
      paint(i)
      effortDiag.lastAction = 'menu-effort:' + levels[i]
      effortDriveLevel(levels[i]).then(ok => effortReportTap(`menu-effort ${levels[i]} → ${ok ? 'ok' : 'fail'}`))
    }, String(i))
    levelRow.appendChild(node)
  }

  wrap.appendChild(levelRow)

  const rankFromEvent = event => {
    const rect = track.getBoundingClientRect()

    if (!rect.width || count < 2) return 0

    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))

    return Math.round(ratio * (count - 1))
  }

  effortHit(track, 'menutrack', (key, el, event) => {
    const rank = rankFromEvent(event)

    paint(rank)
    effortDiag.lastAction = 'menu-effort:' + levels[rank]
    effortDriveLevel(levels[rank]).then(ok => effortReportTap(`menu-effort ${levels[rank]} → ${ok ? 'ok' : 'fail'}`))
  })

  paint(Math.max(0, rankOf(effortCurrentLevel())))

  menu.appendChild(wrap)
}

/** 恢复原版：把我写进 pill 的「模型名 · 强度」尾巴剥掉（等级词表要含 Med/High 等短写）。 */
function effortRestorePillLabels() {
  if (typeof document === 'undefined') return

  /* ⚠️ 必须贪心 `.*`：懒匹配会把「DeepSeek V4.1 · Flash · High」截成「DeepSeek V4.1」，
     把应用原本的名字也削掉（用户报「字被隐藏了」）。贪心才能只剥**最后一段**等级。 */
  const LEVEL = /^(.*)\s*·\s*(最小|低|中|高|极高|最高|超高|min|minimal|lo|low|mid|medium|med|high|hi|very high|max|maximal|ultra)$/i
  const strip = el => {
    const span = el?.querySelector('span')

    if (!span) return

    const text = (span.textContent || '').replace(/\s+/g, ' ').trim()
    const match = text.match(LEVEL)

    /* 只剥「尾巴确实是等级词」的 —— 应用原生文案（如 DeepSeek V4.1 · Flash）不受影响 */
    if (match && match[1] && match[1].trim()) span.textContent = match[1].trim()
  }

  strip(effortModelPill())
  strip(effortReasoningPill())

  /* 顺手清掉我加过的类 */
  for (const node of document.querySelectorAll('.hs-pill-open')) node.classList.remove('hs-pill-open')
}

function effortSyncPills(s) {
  if (typeof document === 'undefined') return

  /* 用户要的方向：把**推理强度**加进**模型 pill**（右下角左边那个），
     而不是把模型名塞进推理弹窗。所以：
       · 推理 pill 保持应用原生文案（只用来读当前等级）
       · 模型 pill 显示「模型名 · 强度」 */
  const labelOn = s.modelPillLabelOn === true

  if (!labelOn) {
    /* 恢复原版：这个功能关掉后必须**主动还原**已写过的文案，否则会残留「模型 · 强度」。 */
    effortRestorePillLabels()

    return
  }

  const reasonPill = effortReasoningPill()
  const rSpan = reasonPill?.querySelector('span')

  if (!rSpan) return

  const raw = (rSpan.textContent || '').trim()

  /* 「是不是我写的」用**是否等于上次写入的值**判断，不能靠内容特征（否则会自我中毒）。 */
  if (raw && raw !== effortState.lastWritten) {
    const tail = raw.includes(' · ') ? raw.slice(raw.lastIndexOf(' · ') + 3).trim() : ''

    effortState.appLevel = raw.length <= 6 ? raw : tail && tail.length <= 6 ? tail : raw
  }

  const modelPill = effortModelPill()

  /* 推理 pill 若被我写过合成串，还原成应用原生的等级 */
  if (reasonPill && effortState.appLevel && rSpan.textContent !== effortState.appLevel && raw.length > 6 && raw.includes(' · ')) {
    rSpan.textContent = effortState.appLevel
  }

  /* 历史遗留标记清掉（改由 CSS 按应用属性控制） */
  for (const node of document.querySelectorAll("[data-hs-modelpill='1']")) node.removeAttribute('data-hs-modelpill')

  const pillCount = document.querySelectorAll("[data-testid='reasoning-pill']").length

  effortDiag.pill = modelPill
    ? `推理 pill ${pillCount} 个｜认到模型 pill：aria-label=「${(modelPill.getAttribute('aria-label') || modelPill.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)}」→ 名字「${effortModelName(modelPill)}」`
    : `推理 pill ${pillCount} 个｜没认到模型 pill`

  /* 目标：模型 pill 上显示「模型名 · 强度」。优先写它内部的 span（别动 chevron）。
     ⚠️ 模型名必须取「去掉我加的 · 等级尾巴」的那个值 —— 否则第二次同步会把
     上一次的合成串当模型名，拼成「模型 · Med · High」（自查抓到的真问题）。 */
  const mSpan = modelPill?.querySelector('span')
  const rawName = (mSpan?.textContent || modelPill?.getAttribute?.('aria-label') || modelPill?.textContent || '')
    .replace(/\s+/g, ' ')
    .trim()
  const tailMatch = rawName.match(/^(.*)\s*·\s*(最小|低|中|高|极高|最高|超高|min|minimal|lo|low|mid|medium|med|high|hi|very high|max|maximal|ultra)$/i)
  const cleanName = (tailMatch ? tailMatch[1] : rawName).trim()
  const want = modelPill && effortState.appLevel ? `${cleanName} · ${effortState.appLevel}` : ''

  effortDiag.modelPillLabel = want || '（没认到模型 pill 的 span）'

  if (mSpan && want && mSpan.textContent !== want) {
    mSpan.textContent = want
    effortState.lastWritten = want
  }
}

function syncEffortSlider(s) {
  effortInstallCoverProbe()
  if (typeof document === 'undefined') return

  /* ⚠️ 基础设施必须在这里无条件安装：以前只在「推理弹窗挂载」里装，
     而**模型列表弹窗打开时推理弹窗并不存在** → 挂载直接 early return → 路由从未安装
     → 注入到模型列表里的「推理强度」点了没反应。 */
  effortInstallHitRouter()
  effortInstallDragRouter()
  effortTagPillRank()

  /* 模型列表弹窗里的推理强度（独立于旧的滑条开关） */
  if (s.menuEffortOn === true) effortMountMenuEffort(s)
  else for (const node of document.querySelectorAll(`#${MENU_WRAP_ID}`)) node.remove()

  const on = s.effortSliderOn === true

  if (!on) {
    effortState.building = false
    for (const node of document.querySelectorAll(`#${EFFORT_WRAP_ID}`)) node.remove()
    for (const node of document.querySelectorAll(`.hs-effort-sep`)) node.remove()
    /* 必须把原生单选组放回来 —— 否则关掉这个功能后，弹窗里一个等级都没有 */
    for (const node of document.querySelectorAll(EFFORT_GROUP)) node.style.removeProperty('display')
    for (const node of document.querySelectorAll("[data-hs-modelpill='1']")) node.removeAttribute('data-hs-modelpill')
    for (const node of document.querySelectorAll('.hs-pill-open')) node.classList.remove('hs-pill-open')
    /* pill 文案恢复成应用原本的「纯等级」（不然关掉后还挂着我合成的名字） */
    effortPaintPillLabel('', effortState.appLevel || effortDiag.picked || '')
    effortRestorePillLabels()
    effortState.appLevel = ''
    /* 还原被藏起来的三行动作（刷新/添加自定义/编辑模型） */
    for (const node of document.querySelectorAll("[data-hs-effort-hidden='1']")) {
      node.style.removeProperty('display')
      node.removeAttribute('data-hs-effort-hidden')
    }

    /* 还原被藏起来的原生「思考」开关行 */
    for (const node of document.querySelectorAll("[data-slot='dropdown-menu-item'], [role='menuitem']")) {
      if (node.querySelector("[role='switch']")) node.style.removeProperty('display')
    }

    return
  }

  effortHideNative()
  effortMarkModelMenus()
  /* 档位标记（两个 pill 的文字配色靠它）必须在**初始同步**就写一次 ——
     原先只在 MutationObserver 回调里调，启动后要等一次 DOM 变动才上色（用户报「模型名无颜色」）。 */
  effortTagPillRank()
  stampModelArrow(effortModelPill())
  stampMenuArrows()
  safeSync('欢迎页', () => syncWelcome(s))
  safeSync('会话漂浮相位', () => stampSessFloat(s))
  safeSync('会话漂浮相位（观察器）', () => watchSessFloat())
  effortSyncPills(s)
  effortMount(s)
  effortReportDiag(s)

  if (!effortState.observer && typeof MutationObserver === 'function') {
    effortState.observer = new MutationObserver(() => {
      /* 节流：同一帧内只跑一次。任何「同步过程本身会改动 DOM」的意外都不会变成死循环
         （曾因为搬动 React 管的文字节点触发 observer 自激 → 整个 Hermes 卡死）。 */
      const now = Date.now()

      if (now - (effortState.lastSync || 0) < 16) return

      effortState.lastSync = now

      /* 整体 try/catch：observer 回调里任何异常都不能让「清空 → 抛错 → 再清空」变成死循环。 */
      try {
        const cur = $settings.get()

        effortHideNative()
        effortMarkModelMenus()
        effortTagPillRank()
        effortSyncPills(cur)
        effortCacheMenuItems()
        effortMount(cur)
        openPluginNavGroup(cur)

        if (cur.menuEffortOn === true) effortMountMenuEffort(cur)
        else for (const node of document.querySelectorAll(`#${MENU_WRAP_ID}`)) node.remove()
      } catch (error) {
        effortDiag.observerError = error?.message || '?'
      }
    })
    effortState.observer.observe(document.body, { childList: true, subtree: true })
  }
}

/** 设置页里的诊断行：弹窗打开过一次之后，这里会显示真实读到的等级。 */
function effortDiagText() {
  if (!effortDiag.found) {
    return '还没读到推理弹窗。打开输入框右下角的推理等级弹窗一次，这里就会填上真实读到的等级文案。'
  }

  return `读到 ${effortDiag.levels.length} 个等级（DOM 顺序）：${effortDiag.levels.join(' / ')}｜排序：${effortDiag.order}｜当前：${effortDiag.picked}｜${effortDiag.pill}｜模型 pill：${effortDiag.modelPillLabel || '无'}｜策略：${effortModelSource}｜最后动作：${effortDiag.lastAction || '无'}｜隐藏三行：${effortDiag.hidActions || '0'}`
}

/* ───────────────────────── 鼠标个性化（12 组光标） ─────────────────────────
   全部用 SVG 代码绘制、以 data URL 内联：透明底、任意缩放都清晰、体积几 KB。
   光标必须**双色**（浅色填充 + 深色描边）才能在浅色/深色背景上都看得见。
   hotspot 是「热点」像素坐标（箭头尖端 / 十字中心）。 */

const CURSOR_STYLES = [
  {
    id: 'classic',
    name: '经典箭头',
    hot: [2, 2],
    body: '<path d="M3 2 L3 21 L8.2 16.2 L11.4 22.6 L14.2 21.2 L11 15 L17.6 15 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/>'
  },
  {
    id: 'neon',
    name: '霓虹箭头',
    hot: [2, 2],
    body: '<path d="M3 2 L3 21 L8.2 16.2 L11.4 22.6 L14.2 21.2 L11 15 L17.6 15 Z" fill="#0b1020" stroke="#5eead4" stroke-width="1.5" stroke-linejoin="round"/><path d="M3.8 4 L3.8 18.4 L7.4 15.1 L10.6 21.4 L12 20.7 L8.9 14.4 L14.6 14.4 Z" fill="#22d3ee" opacity="0.9"/>'
  },
  {
    id: 'gold',
    name: '黑金箭头',
    hot: [2, 2],
    body: '<path d="M3 2 L3 21 L8.2 16.2 L11.4 22.6 L14.2 21.2 L11 15 L17.6 15 Z" fill="#2f2f33" stroke="#f5c451" stroke-width="2.3" stroke-linejoin="round"/><path d="M4.6 4.8 L4.6 17.2 L7.6 14.4 L10.6 20.4 L11.8 19.8 L8.9 13.9 L13.8 13.9 Z" fill="#f5c451" opacity="0.95"/>'
  },
  {
    id: 'pixel',
    name: '像素箭头',
    hot: [1, 1],
    body: '<path d="M2 2 h4 v4 h4 v4 h4 v4 h-4 v4 h-4 v-4 h-4 z" fill="#fff" stroke="#111" stroke-width="1" stroke-linejoin="miter"/>'
  },
  {
    id: 'dot',
    name: '玻璃圆点',
    hot: [8, 8],
    body: '<circle cx="8" cy="8" r="6.6" fill="#ffffff" fill-opacity="0.72" stroke="#111" stroke-width="2"/><circle cx="5.8" cy="5.6" r="1.9" fill="#fff" fill-opacity="0.95"/>'
  },
  {
    id: 'ring',
    name: '光环',
    hot: [8, 8],
    body: '<circle cx="8" cy="8" r="6.4" fill="none" stroke="#111" stroke-width="3.2"/><circle cx="8" cy="8" r="6.4" fill="none" stroke="#7dd3fc" stroke-width="1.9"/><circle cx="8" cy="8" r="1.5" fill="#111"/>'
  },
  {
    id: 'cross',
    name: '十字准星',
    hot: [8, 8],
    body: '<path d="M8 1 v5 M8 10 v5 M1 8 h5 M10 8 h5" stroke="#111" stroke-width="2.6" stroke-linecap="round"/><path d="M8 1 v5 M8 10 v5 M1 8 h5 M10 8 h5" stroke="#f8fafc" stroke-width="1.2" stroke-linecap="round"/>'
  },
  {
    id: 'paw',
    name: '猫爪',
    hot: [4, 4],
    body: '<g stroke="#111" stroke-width="1.2" stroke-linejoin="round"><ellipse cx="5.4" cy="10.4" rx="4.4" ry="3.6" fill="#ffd9e8"/><circle cx="2.6" cy="5.6" r="1.7" fill="#ffd9e8"/><circle cx="6.6" cy="3.8" r="1.8" fill="#ffd9e8"/><circle cx="10.8" cy="5.4" r="1.7" fill="#ffd9e8"/></g>'
  },
  {
    id: 'star',
    name: '星星',
    hot: [8, 8],
    body: '<path d="M8 1.2 L10 6 L15.2 6.6 L11.4 10 L12.4 15 L8 12.4 L3.6 15 L4.6 10 L0.8 6.6 L6 6 Z" fill="#fde68a" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/>'
  },
  {
    id: 'flame',
    name: '火焰',
    hot: [8, 14],
    body: '<path d="M8 1 C11 5 13.6 7 13.6 10.6 C13.6 13.7 11.2 15.6 8 15.6 C4.8 15.6 2.4 13.7 2.4 10.6 C2.4 8.2 4 6.4 5.4 4.6 C5.2 7 6.2 8 7 8.4 C7.6 5.6 7.8 3 8 1 Z" fill="#fb923c" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/><path d="M8 8.4 C9.4 9.6 10.2 10.6 10.2 11.9 C10.2 13.4 9.3 14.3 8 14.3 C6.7 14.3 5.8 13.4 5.8 11.9 C5.8 10.7 6.6 9.6 8 8.4 Z" fill="#fde68a"/>'
  },
  {
    id: 'feather',
    name: '羽毛',
    hot: [2, 15],
    body: '<path d="M2.4 15.4 C4 8 8.6 3.2 15 1.6 C15.4 8.4 11.2 13.4 4.6 15.2 Z" fill="#e9d5ff" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/><path d="M2.6 15.2 L13.4 3.6" stroke="#111" stroke-width="1.1" stroke-linecap="round"/>'
  },
  {
    id: 'liquid',
    name: '玻璃球',
    hot: [4, 3],
    body: '<path d="M3.4 2.2 C6 2.2 6.4 4 8.6 4.4 C11.6 5 14.4 6.4 14.4 9.6 C14.4 13.4 10.4 15.4 6.6 15 C3.2 14.6 1.4 11.8 1.6 8.6 C1.8 5.4 2 2.2 3.4 2.2 Z" fill="#ffffff" fill-opacity="0.62" stroke="#111" stroke-width="1.9"/><path d="M4.6 4.4 C6.4 4.2 7.6 5.2 8 6.4" stroke="#ffffff" stroke-width="1.7" stroke-linecap="round" fill="none" opacity="0.98"/>'
  }
]

/** 每个风格的主题色 —— 非箭头形态（文本/十字/缩放/抓取/禁用/帮助/等待）用它画，
    这样一眼能看出是同一套光标，而不是随便拼一个通用图形。 */
const CURSOR_TONES = {
  classic: '#e5e7eb', neon: '#22d3ee', gold: '#f5c451', pixel: '#e5e7eb',
  dot: '#e5e7eb', ring: '#7dd3fc', cross: '#e5e7eb', paw: '#ffd9e8',
  star: '#fde68a', flame: '#fb923c', feather: '#e9d5ff', liquid: '#e5e7eb',
  'png-carrot': '#f97316', 'png-celery': '#4ade80', 'png-chili': '#ef4444',
  'png-banana': '#facc15', 'png-icecream': '#f9a8d4', 'png-cactus': '#22c55e',
  'png-pencil': '#fbbf24', 'png-mushroom': '#dc2626'
}

/** 每种形态的几何：画布边长（视觉单位）与热点。默认形态用各风格自己的 hot。 */
const CURSOR_STATES = {
  default: { box: 24, hot: null },
  pointer: { box: 18, hot: [5, 3] },
  text: { box: 24, hot: [12, 12] },
  crosshair: { box: 24, hot: [12, 12] },
  resize: { box: 24, hot: [12, 12] },
  grab: { box: 18, hot: [8, 4] },
  notAllowed: { box: 24, hot: [12, 12] },
  help: { box: 24, hot: [12, 12] },
  wait: { box: 24, hot: [12, 12] }
}

/* 字形一律「深色描边 + 主题色内芯」两层 —— 单色在浅底/深底必有一边看不见。 */
const CURSOR_GLYPHS = {
  /* 文本输入：I 型 */
  text: tone =>
    `<path d="M7.6 3.6 h8.8 M12 3.6 v16.8 M7.6 20.4 h8.8" stroke="#111" stroke-width="3.6" stroke-linecap="round" fill="none"/>` +
    `<path d="M7.6 3.6 h8.8 M12 3.6 v16.8 M7.6 20.4 h8.8" stroke="${tone}" stroke-width="1.7" stroke-linecap="round" fill="none"/>`,
  /* 精确选择：十字 */
  crosshair: tone =>
    `<path d="M12 1.6 v6.4 M12 16 v6.4 M1.6 12 h6.4 M16 12 h6.4" stroke="#111" stroke-width="3.4" stroke-linecap="round"/>` +
    `<path d="M12 1.6 v6.4 M12 16 v6.4 M1.6 12 h6.4 M16 12 h6.4" stroke="${tone}" stroke-width="1.6" stroke-linecap="round"/>` +
    `<circle cx="12" cy="12" r="2.2" fill="#111"/><circle cx="12" cy="12" r="1.1" fill="${tone}"/>`,
  /* 缩放：对角双箭头 */
  resize: tone =>
    `<path d="M4.6 4.6 L19.4 19.4" stroke="#111" stroke-width="3.6" stroke-linecap="round"/>` +
    `<path d="M4.6 4.6 L19.4 19.4" stroke="${tone}" stroke-width="1.7" stroke-linecap="round"/>` +
    `<path d="M4 4 h6.4 M4 4 v6.4 M20 20 h-6.4 M20 20 v-6.4" stroke="#111" stroke-width="3.2" stroke-linecap="round" fill="none"/>` +
    `<path d="M4 4 h6.4 M4 4 v6.4 M20 20 h-6.4 M20 20 v-6.4" stroke="${tone}" stroke-width="1.5" stroke-linecap="round" fill="none"/>`,
  /* 抓取：张开的手 */
  grab: tone =>
    `<path d="M5 4.6 C5 3.6 6.4 3.6 6.4 4.6 V9 h1.2 V3.2 c0-1 1.4-1 1.4 0 V9 h1.2 V4.2 c0-1 1.4-1 1.4 0 V9 h1.2 V5.6 c0-1 1.4-1 1.4 0 v5.2 c0 3.2-1.8 5.4-4.6 5.4 C9 16.2 7.6 15 6.4 13 L4.2 10 C3.4 8.8 4.6 7.8 5.6 8.6 Z" fill="${tone}" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/>`,
  /* 禁用：圆 + 斜杠 */
  notAllowed: tone =>
    `<circle cx="12" cy="12" r="8.8" fill="#ffffff" fill-opacity="0.5" stroke="#ffffff" stroke-width="4" stroke-opacity="0.85"/>` +
    `<circle cx="12" cy="12" r="8.8" fill="none" stroke="#111" stroke-width="2.4"/>` +
    `<path d="M5.8 5.8 L18.2 18.2" stroke="#111" stroke-width="4.4" stroke-linecap="round"/>` +
    `<path d="M5.8 5.8 L18.2 18.2" stroke="${tone}" stroke-width="2.3" stroke-linecap="round"/>`,
  /* 帮助：圆 + 问号 */
  help: tone =>
    `<circle cx="12" cy="12" r="8.8" fill="#ffffff" fill-opacity="0.5" stroke="#ffffff" stroke-width="3.8" stroke-opacity="0.85"/>` +
    `<circle cx="12" cy="12" r="8.8" fill="none" stroke="#111" stroke-width="2.2"/>` +
    `<path d="M9.1 9.3 a2.95 2.95 0 1 1 3.7 2.85 c-.62.2-.85.72-.85 1.35 v.55" stroke="${tone}" stroke-width="2.3" fill="none" stroke-linecap="round"/>` +
    `<circle cx="12" cy="17.3" r="1.35" fill="${tone}"/>`,
  /* 等待：缺口圆环 */
  wait: tone =>
    `<circle cx="12" cy="12" r="8" fill="none" stroke="#ffffff" stroke-width="5" stroke-opacity="0.85"/>` +
    `<circle cx="12" cy="12" r="8" fill="none" stroke="#111" stroke-width="3.4"/>` +
    `<path d="M12 4 a8 8 0 0 1 8 8" fill="none" stroke="${tone}" stroke-width="2.3" stroke-linecap="round"/>`
}

/** 手形（可点元素）—— 用该风格的主题色，和箭头形成呼应。 */
const cursorHand = tone =>
  `<path d="M5 4.6 C5 3.6 6.4 3.6 6.4 4.6 V9 h1.2 V3.2 c0-1 1.4-1 1.4 0 V9 h1.2 V4.2 c0-1 1.4-1 1.4 0 V9 h1.2 V5.6 c0-1 1.4-1 1.4 0 v5.2 c0 3.2-1.8 5.4-4.6 5.4 C9 16.2 7.6 15 6.4 13 L4.2 10 C3.4 8.8 4.6 7.8 5.6 8.6 Z" fill="${tone}" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/>`

/** 取某个风格在某种形态下的几何与图形。 */
function cursorGeom(style, state) {
  const st = CURSOR_STATES[state] || CURSOR_STATES.default
  const tone = CURSOR_TONES[style.id] || '#e5e7eb'

  if (state === 'default') return { box: 24, hot: style.hot || [2, 2], body: style.body }
  if (state === 'pointer') return { box: st.box, hot: st.hot, body: cursorHand(tone) }

  const glyph = CURSOR_GLYPHS[state]

  return glyph ? { box: st.box, hot: st.hot, body: glyph(tone) } : null
}

/* ── 生图光标（火山 doubao-seedream 生成 → PIL 四角泛洪抠白底 → 48px → base64 内联）──
   用 PNG data URL 而不是 hermes-media://：光标必须能被 CSS 立即解析，内联最稳。 */
const PNG_CURSORS = [
  {
    id: 'png-carrot',
    name: '胡萝卜',
    /* 图片是方形画布、物体居中且尖端朝左上，热点取左上角 */
    hot: [2, 2],
    png: 'data:image/png;base64,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'
  },
  {
    id: 'png-celery',
    name: '芹菜',
    /* 图片是方形画布、物体居中且尖端朝左上，热点取左上角 */
    hot: [2, 2],
    png: 'data:image/png;base64,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'
  },
  {
    id: 'png-chili',
    name: '辣椒',
    /* 图片是方形画布、物体居中且尖端朝左上，热点取左上角 */
    hot: [2, 2],
    png: 'data:image/png;base64,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'
  },
  {
    id: 'png-banana',
    name: '香蕉',
    /* 图片是方形画布、物体居中且尖端朝左上，热点取左上角 */
    hot: [2, 2],
    png: 'data:image/png;base64,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'
  },
  {
    id: 'png-icecream',
    name: '冰淇淋',
    /* 图片是方形画布、物体居中且尖端朝左上，热点取左上角 */
    hot: [2, 2],
    png: 'data:image/png;base64,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'
  },
  {
    id: 'png-cactus',
    name: '仙人掌',
    /* 图片是方形画布、物体居中且尖端朝左上，热点取左上角 */
    hot: [2, 2],
    png: 'data:image/png;base64,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'
  },
  {
    id: 'png-pencil',
    name: '铅笔',
    /* 图片是方形画布、物体居中且尖端朝左上，热点取左上角 */
    hot: [2, 2],
    png: 'data:image/png;base64,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'
  },
  {
    id: 'png-mushroom',
    name: '蘑菇',
    /* 图片是方形画布、物体居中且尖端朝左上，热点取左上角 */
    hot: [2, 2],
    png: 'data:image/png;base64,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'
  },
]

/* 全部可选光标 = 代码绘制的 12 组 + 生图的 8 组 */
const ALL_CURSOR_STYLES = CURSOR_STYLES.concat(PNG_CURSORS)

const CURSOR_POINTER_BODY = '<path d="M5 4.6 C5 3.6 6.4 3.6 6.4 4.6 V9 h1.2 V3.2 c0-1 1.4-1 1.4 0 V9 h1.2 V4.2 c0-1 1.4-1 1.4 0 V9 h1.2 V5.6 c0-1 1.4-1 1.4 0 v5.2 c0 3.2-1.8 5.4-4.6 5.4 C9 16.2 7.6 15 6.4 13 L4.2 10 C3.4 8.8 4.6 7.8 5.6 8.6 Z" fill="#fff" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/>'

/** 生成一个光标的 SVG data URL。size 为像素边长（内部按 24 视觉单位缩放）。 */
/* 位图（生图）光标的按尺寸重绘缓存：key = 风格@尺寸 */
const PNG_SIZE_CACHE = new Map()

/* ⚠️ 位图光标原来直接 `return style.png`（48px 原图），**尺寸参数根本没进 URL** ——
   所以「光标大小」滑块对生图光标完全无效（用户报「放大缩小的是插件窗口，不是鼠标」）。
   这里用 canvas 按目标尺寸重画一遍并缓存；重画是异步的，画好后再 apply 一次。 */
function pngSizedUrl(style, size, onReady) {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null

  const key = `${style.id}@${size}`

  if (PNG_SIZE_CACHE.has(key)) return PNG_SIZE_CACHE.get(key)

  if (PNG_SIZE_CACHE.get(`${key}!pending`)) return null

  PNG_SIZE_CACHE.set(`${key}!pending`, true)

  const img = new Image()

  img.onload = () => {
    let url = null

    try {
      const cv = document.createElement('canvas')

      cv.width = size
      cv.height = size

      const ctx2d = cv.getContext('2d')

      if (ctx2d) {
        ctx2d.imageSmoothingEnabled = true
        ctx2d.imageSmoothingQuality = 'high'
        ctx2d.drawImage(img, 0, 0, size, size)
        url = cv.toDataURL('image/png')
      }
    } catch {
      url = null
    }

    PNG_SIZE_CACHE.delete(`${key}!pending`)
    PNG_SIZE_CACHE.set(key, url)

    if (onReady) onReady()
  }

  img.onerror = () => {
    PNG_SIZE_CACHE.delete(`${key}!pending`)
    PNG_SIZE_CACHE.set(key, null)

    if (onReady) onReady()
  }

  img.src = style.png

  return null
}

function cursorDataUrl(style, size, state) {
  const st = state || 'default'

  /* 生图光标：箭头与手形都用它自己的形象（位图）；其余形态用主题色字形。
     位图要按滑块尺寸重绘，否则「光标大小」对它无效。 */
  if (style.png && (st === 'default' || st === 'pointer')) {
    const scaled = pngSizedUrl(style, size, () => safeSync('光标尺寸就绪', () => apply($settings.get())))

    return scaled || style.png
  }

  const geom = cursorGeom(style, st)

  if (!geom) return style.png || ''

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${geom.box} ${geom.box}">${geom.body}</svg>`

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** 某个形态的 CSS 值（含热点换算）。 */
function cursorValue(style, size, state) {
  const geom = cursorGeom(style, state)
  const url = cursorDataUrl(style, size, state)

  if (!url) return null

  const hot = (state === 'default' ? (style.hot || [2, 2]) : (geom?.hot || [12, 12]))
  const box = state === 'default' && style.png ? 48 : (geom?.box || 24)
  const hx = Math.round((hot[0] / box) * size)
  const hy = Math.round((hot[1] / box) * size)

  return `url("${url}") ${hx} ${hy}`
}

/** 鼠标个性化：整套光标（每种形态各一份）。
    ⚠️ 不写 `*` 通配 —— 只给 html/body 写默认光标（其余继承），
   否则文本/缩放等功能光标会被顶掉；下面按形态显式覆盖各自的目标。 */
function cursorCss(s) {
  if (s.cursorOn !== true) return ''

  const style = ALL_CURSOR_STYLES.find(item => item.id === s.cursorStyle) || CURSOR_STYLES[0]
  const size = Math.max(16, Math.min(48, Number(s.cursorSize) || 24))
  const val = state => cursorValue(style, size, state)
  const rules = []

  const push = (states, selectors, fallback) => {
    const values = states.map(st => val(st)).filter(Boolean)

    if (!values.length) return

    rules.push(`${selectors.join(',\n')} {\n  cursor: ${values.map(v => `${v}, ${fallback}`).join(', ')}\n}`)
  }

  /* 默认光标：写在 html/body 上一次，全窗口继承 */
  push(['default'], ['html', 'body'], 'auto')

  /* 可点元素 → 手形 */
  push(
    ['pointer'],
    [
      "a", "button", "[role='button']", "summary", "label[for]", "select",
      ".cursor-pointer", "[data-slot='composer-submit']", "[data-tour='model-pill']",
      "[data-testid='reasoning-pill']", "[data-slot='dropdown-menu-trigger']",
      "[role='menuitem']", "[role='menuitemradio']", "[role='tab']"
    ],
    'pointer'
  )

  /* 文本输入 → I 型 */
  push(['text'], ["input", "textarea", "[contenteditable='true']", "[contenteditable='']"], 'text')

  /* 精确选择 → 十字（图片 / 明确标了 crosshair 的地方） */
  push(
    ['crosshair'],
    ["img", "[class*='cursor-crosshair']", "[class*='cursor-zoom']"],
    'crosshair'
  )

  /* 拖拽 → 抓取 */
  push(
    ['grab'],
    ["[draggable='true']", "[class*='cursor-grab']", "[class*='cursor-move']", "[class*='cursor-grabbing']"],
    'grab'
  )

  /* 缩放 → 对角箭头（应用分栏用这些 Tailwind 类） */
  push(
    ['resize'],
    [
      "[class*='cursor-col-resize']", "[class*='cursor-row-resize']",
      "[class*='cursor-ew-resize']", "[class*='cursor-ns-resize']",
      "[class*='cursor-nwse-resize']", "[class*='cursor-nesw-resize']"
    ],
    'nwse-resize'
  )

  /* 不可用 → 禁用 */
  push(['notAllowed'], ["[disabled]", "[aria-disabled='true']", "[class*='cursor-not-allowed']"], 'not-allowed')

  /* 等待 → 缺口圆环 */
  push(['wait'], ["[aria-busy='true']", "[class*='cursor-wait']", "[class*='cursor-progress']"], 'wait')

  /* 帮助 → 问号（只给明确标了 help 的元素，避免 [title] 一刀切） */
  push(['help'], ["abbr[title]", "[class*='cursor-help']"], 'help')

  return `/* 鼠标个性化：整套光标（箭头 / 手形 / 文本 / 十字 / 缩放 / 抓取 / 禁用 / 等待 / 帮助）\n   —— 每种形态都用同一个风格的主题色，不再是只有一个箭头。 */\n${rules.join('\n\n')}\n`
}

/** 设置页的鼠标样式选择器（12 组，带实时预览）。 */
function cursorRows(s, update) {
  const size = Math.max(16, Math.min(48, Number(s.cursorSize) || 24))
  const preview = id => {
    const style = ALL_CURSOR_STYLES.find(item => item.id === id) || CURSOR_STYLES[0]

    return cursorDataUrl(style, size, 'default')
  }

  return [
    jsx(ListRow, {
      action: jsx(SegmentedControl, {
        onChange: id => update({ cursorOn: id === 'on' }),
        options: [
          { id: 'off', label: '用系统光标' },
          { id: 'on', label: '用自定义' }
        ],
        value: s.cursorOn === true ? 'on' : 'off'
      }),
      description: '整套自定义光标。',
      title: '鼠标个性化'
    }),
    jsx(ListRow, {
      action: jsxs('div', {
        className: 'flex w-full items-center gap-3',
        children: [
          jsx('input', {
            className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
            max: 48,
            min: 16,
            onChange: event => update({ cursorSize: Number(event.target.value) }),
            step: 1,
            type: 'range',
            value: size
          }),
          jsx('span', {
            className: 'w-12 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
            children: `${size} px`
          })
        ]
      }),
      description: '光标的大小。',
      title: '光标大小'
    }),
    jsxs('div', {
      className: 'grid grid-cols-3 gap-2 pt-1 sm:grid-cols-4',
      children: ALL_CURSOR_STYLES.map(style =>
        jsxs(
          'button',
          {
            className:
              'flex flex-col items-center gap-1.5 rounded-lg border p-2 text-[11px] transition-colors ' +
              (s.cursorStyle === style.id
                ? 'border-(--ui-accent) bg-(--ui-accent)/10 text-(--ui-text-primary)'
                : 'border-(--ui-border) text-(--ui-text-tertiary) hover:border-(--ui-accent)'),
            onClick: () => update({ cursorStyle: style.id }),
            type: 'button',
            children: [
              jsx('img', { alt: '', height: size, src: preview(style.id), width: size }),
              jsx('span', { children: style.name })
            ]
          },
          style.id
        )
      )
    })
  ]
}

function buildCss(s) {
  /* 配了开机动画时，把应用自己的启动画面（CONNECTING 那屏）藏掉 ——
     开机动画遮罩会全程盖住窗口，中间不该闪出应用的加载界面。
     它没有 data-slot，只能用特征组合定位：fixed + inset-0 + data-glass-opaque。
     侧栏正在拖动的行也带 data-glass-opaque，但不是 fixed/inset-0，不会误伤。 */
  const hideBootScreen =
    s.startupMode !== 'off' && s.startupPath
      ? `
[data-glass-opaque][class*='fixed'][class*='inset-0'] {
  display: none !important;
}
`
      : ''

  const extra =
    hideBootScreen +
    (s.glowOn ? glowCss(s) : '') +
    stackCss(s) +
    bubbleCss(s) +
    lyricsCss(s) +
    (s.sessOn || s.sessInOn || s.sessOutOn || isOn(s.sessTouchOn) ? sessionCss(s) : '') +
    /* 液态玻璃放最后：气泡那套在 bubbleCss 里；输入框 / 会话行这两套在这里，
       顺序放末尾是为了让它定义的外观压过前面「会话悬浮 / 光晕」的圆角与阴影 */
    lgxCss(s) +
    stackInsetCss(s) +
    timerBarCss(s) +
    sessColCss(s) +
    ropeCss(s) +
    effortSliderCss(s) +
    /* 助手那一侧：气泡外观。玻璃统一走上面的 lgxCss（静态玻璃那套已删除）。 */
    assistantBubbleCss(s) +
    cursorCss(s) +
    composerRadiusCss(s) +
    bubbleAlignCss(s) +
    paneTabsCss(s) +
    modelSubmenuCss() +
    sidebarNavCss(s) +
    navToggleCss() +
    flowCss(s) +
    /* 锁定布局（默认开）*/
    layoutLockCss(s) +
    /* 模型 pill 右边的箭头（默认隐藏）*/
    modelArrowCss(s) +
    /* 问询弹窗（澄清问题卡片） */
    askCss(s) +
    /* 设置弹窗左列：自动展开「个性化设置」那一组 */
    navAutoOpenCss(s) +
    /* 字体（界面字体 / 等宽字体 / 字重） */
    fontCss(s) +
    /* 选择框：磨砂 + 内发光 */
    segCss(s) +
    /* 左侧会话列表：选中行高亮 */
    sessHlCss(s)

  if (!wantsPalette(s)) {
    /* 只开了光效 / 会话悬浮时，样式表里就只有那几段 */
    return extra
  }

  const surface = resolveSurface(s)
  const vars = surface === 'dark' ? DARK_SURFACE : LIGHT_SURFACE
  const ink = resolveInk(s, surface)
  const lines = Object.entries(vars).map(([k, v]) => `${k}: ${v} !important;`)

  /* 字色跟着面板走（也顺手清掉上次留下的旧值，避免残留浅字压在白面上） */
  lines.push(`--theme-foreground: ${ink.color} !important;`)

  /* 三重 :root 是为了在「同优先级 !important」的比拼里赢过皮肤等其他注入源：
     同优先级时按文档顺序取后者，而本样式表被 MutationObserver 钉在 head 最后。 */
  let out = `:root:root:root { color-scheme: ${surface} !important; ${lines.join(' ')} }
`

  if (!hasBackground(s)) {
    /* 没有背景图：只换颜色，不动窗口的透明与底色 */
    return out + extra
  }

  const scrim = Math.max(0, Math.min(90, Number(s.scrim) || 0)) / 100
  const scrimRgb = surface === 'dark' ? '4, 9, 14' : '255, 255, 255'

  out += `html { background-color: transparent !important; }
:root {
  --ui-chat-surface-background: transparent;
  --ui-sidebar-surface-background: transparent;
  --ui-editor-surface-background: transparent;
  --ui-terminal-surface-background: var(--ui-bg-chrome);
}
[data-contrib-shell], [data-slot='sidebar-wrapper'] { background-color: transparent !important; }
/* 输入框上方的运行程序条画的是共用的 --composer-fill，一起透明掉背景才连成一片；
   但它一旦「不跟随输入框」，就交给它自己那套设置，这里不再插手。 */
${s.stackFollow === false ? '' : `[data-slot='composer-status-stack'] { --composer-fill: transparent !important; }`}
#${LAYER_ID} { position: fixed; inset: 0; z-index: -1; overflow: hidden; pointer-events: none; opacity: ${layerOpacity(s)}; }
#${LAYER_ID} > video, #${LAYER_ID} > img { display: block; width: 100%; height: 100%; object-fit: cover; }
body { background-color: ${surface === 'dark' ? '#0a1013' : '#f8faff'} !important; }
`

  /* 遮罩必须画在「媒体层内部」——也就是视频/图片之上、界面之下。
     放在 body 上是不生效的：html 一旦被设成透明，body 的背景就会被
     「传播到画布」（CSS 的背景传播规则），等于跑到 z-index:-1 的媒体层下面，
     被视频整个盖住 —— 滑块拖了当然没反应。 */
  if (scrim > 0) {
    out += `#${LAYER_ID}::after {
  content: '';
  position: absolute;
  inset: 0;
  background: rgba(${scrimRgb}, ${scrim});
}
`
  }

  return out + extra
}

/* ── 关键变量直接内联写到 <html> 上（带 !important）───────────────────
   主题引擎也会把变量写成 <html> 的内联样式，但它是普通优先级；内联
   !important 稳压它，这样就不必跟任何样式表比「谁在后面」。 */
const ROOT_VARS = [...Object.keys(DARK_SURFACE), 'color-scheme', '--theme-foreground']

let htmlBgSaved = null

function paintRoot(s) {
  const el = document.documentElement
  const body = document.body

  if (!el || !body) return

  if (htmlBgSaved === null) {
    htmlBgSaved = {
      priority: el.style.getPropertyPriority('background-color'),
      value: el.style.getPropertyValue('background-color')
    }
  }

  if (!wantsPalette(s)) {
    for (const key of ROOT_VARS) {
      el.style.removeProperty(key)
    }

    el.style.setProperty('background-color', htmlBgSaved.value, htmlBgSaved.priority)
    el.style.removeProperty('color-scheme')
    body.style.removeProperty('background-color')
    body.style.removeProperty('background-image')

    return
  }

  const surface = resolveSurface(s)
  const vars = { ...(surface === 'dark' ? DARK_SURFACE : LIGHT_SURFACE) }

  vars['--theme-foreground'] = resolveInk(s, surface).color

  for (const [key, value] of Object.entries(vars)) {
    el.style.setProperty(key, value, 'important')
  }

  el.style.setProperty('color-scheme', surface, 'important')

  if (!hasBackground(s)) {
    /* 只换字色/面板时，把窗口底色还给原样式 */
    el.style.setProperty('background-color', htmlBgSaved.value, htmlBgSaved.priority)
    body.style.removeProperty('background-color')
    body.style.removeProperty('background-image')

    return
  }

  el.style.setProperty('background-color', 'transparent', 'important')

  body.style.setProperty('background-color', surface === 'dark' ? '#0a1013' : '#f8faff', 'important')
  /* 遮罩不写在 body 上（会被背景传播规则丢到媒体层下面），改由样式表
     画在媒体层的 ::after 上 */
  body.style.removeProperty('background-image')
}

/* ── DOM 层 ─────────────────────────────────────────────────────── */
function ensureStyle() {
  if (typeof document === 'undefined') return null

  let styleEl = document.getElementById(STYLE_ID)

  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = STYLE_ID
    document.head.appendChild(styleEl)

    /* 主题重绘时会再往 head 里插自己的样式表；把我们这张永远保持最后一个，
       否则同优先级的变量覆盖会被它按文档顺序挤掉。 */
    const observer = new MutationObserver(() => {
      if (document.head.lastElementChild !== styleEl) {
        document.head.appendChild(styleEl)
      }
    })

    observer.observe(document.head, { childList: true })
  }

  return styleEl
}

/* ── 背景音乐 ──────────────────────────────────────────────────────
   用一条隐藏的 <audio> 播 hermes-media://（和背景视频同一套本地流协议，支持 Range）。
   浏览器的自动播放策略可能拦掉「无人操作就出声」，所以 play() 被拒时会挂一次性
   交互监听，等用户第一次点击 / 按键再起播；图标始终反映真实播放状态（playing/pause 事件）。 */
const $music = atom({ playing: false, track: '', muted: false })

let musicEl = null
let musicIndex = 0
let musicArmed = false

function musicList(s) {
  return orderedClips((s || $settings.get()).musicTracks || []).map(entry => entry.clip)
}

function ensureMusicEl() {
  if (musicEl && document.body.contains(musicEl)) return musicEl

  musicEl = document.createElement('audio')
  musicEl.setAttribute('aria-hidden', 'true')
  musicEl.style.display = 'none'
  musicEl.addEventListener('playing', () => $music.set({ playing: true, track: musicEl.dataset.track || '' }))
  musicEl.addEventListener('pause', () => $music.set({ playing: false, track: musicEl.dataset.track || '' }))
  musicEl.addEventListener('ended', () => {
    if (!musicEl.loop) nextMusic()
  })
  musicEl.addEventListener('timeupdate', () => syncLyricsToTime(musicEl.currentTime || 0))

  document.body.appendChild(musicEl)

  return musicEl
}

function armMusicGesture() {
  if (musicArmed) return

  musicArmed = true

  const kick = () => {
    document.removeEventListener('pointerdown', kick)
    document.removeEventListener('keydown', kick)
    musicArmed = false
    playMusic()
  }

  document.addEventListener('pointerdown', kick)
  document.addEventListener('keydown', kick)
}

/** 起播当前那首（不换曲） */
function playMusic() {
  const s = $settings.get()
  const list = musicList(s)

  if (!s.musicOn || !list.length) return stopMusic()

  const el = ensureMusicEl()
  const track = list[musicIndex % list.length]

  musicIndex = musicIndex % list.length
  el.volume = Math.max(0, Math.min(100, Number(s.musicVolume) || 0)) / 100
  el.loop = s.musicRepeat === 'single'
  /* 静音状态跟着设置走（换曲 / 重播都不能把它弄丢） */
  el.muted = ($settings.get().musicMutedOn === true)

  const url = mediaUrl(track.path)

  if (el.dataset.src !== url) {
    el.dataset.src = url
    el.src = url
  }

  el.dataset.track = fileNameOf(track.path)

  /* 换曲了：重新装载这个词曲的歌词 */
  if (lyricsLoadedFor !== `${track.path}|${track.lyricsPath || ''}`) loadLyrics(s, true)

  const played = el.play?.()

  if (played && typeof played.catch === 'function') {
    played.catch(() => armMusicGesture())
  }
}

/** 换下一首（顺序 / 随机） */
function nextMusic() {
  const s = $settings.get()
  const list = musicList(s)

  if (!list.length) return

  musicIndex = s.musicRepeat === 'random' ? Math.floor(Math.random() * list.length) : (musicIndex + 1) % list.length
  playMusic()
}

function stopMusic() {
  if (musicEl) {
    try {
      musicEl.pause()
      musicEl.removeAttribute('src')
      delete musicEl.dataset.src
    } catch {
      /* 忽略 */
    }
  }

  $music.set({ playing: false, track: '' })
}

function toggleMusic() {
  const s = $settings.get()

  if (!s.musicOn || !musicList(s).length) return

  const el = ensureMusicEl()

  if (el.paused) playMusic()
  else stopMusic()
}

/* 静音切换：左键点标题栏那个音乐符号就走这里。
   只**静音**（audio.muted），不停播、不换曲 —— 用户明确要求「点击是静音与不静音」；
   原来没有曲目时点它会跳设置页（用户不要），去设置改到了右键。 */
function toggleMusicMute() {
  const s = $settings.get()
  const muted = s.musicMutedOn !== true

  update({ musicMutedOn: muted })

  const el = ensureMusicEl()

  el.muted = muted
  $music.set({ ...$music.get(), muted: muted })
}

/** 设置变动 / 启动时同步音乐状态 */
function syncMusic(s) {
  const list = musicList(s)

  if (!s.musicOn || !list.length) {
    if (musicEl && !musicEl.paused) stopMusic()
    else $music.set({ playing: false, track: '' })

    return
  }

  if (musicIndex >= list.length) musicIndex = 0

  const el = ensureMusicEl()
  const track = list[musicIndex % list.length]
  const url = mediaUrl(track.path)

  el.volume = Math.max(0, Math.min(100, Number(s.musicVolume) || 0)) / 100
  el.loop = s.musicRepeat === 'single'
  /* 静音状态跟着设置走（换曲 / 重播都不能把它弄丢） */
  el.muted = ($settings.get().musicMutedOn === true)

  /* 当前加载的那首已经不在列表里（被删掉 / 换过列表）→ 从第一首重新起播 */
  if (el.dataset.src && !list.some(track => mediaUrl(track.path) === el.dataset.src)) {
    musicIndex = 0
    playMusic()

    return
  }

  /* 还没起播过（插件刚加载 / 之前停掉过）就把当前那首起播 */
  if (!el.dataset.src) playMusic()
}

/** 歌词卡片：全部样式走样式表（设置一变就重新生成），JS 只换文字 */
function lyricsCss(s) {
  if (!s.lyricsOn) return ''

  const width = Math.max(150, Math.min(460, Number(s.lyricsWidth) || 280))
  const font = Math.max(0.7, Math.min(1.4, Number(s.lyricsFontSize) || 0.95))
  const tilt = Math.max(-16, Math.min(16, Number(s.lyricsTilt) || 0))
  const opacity = Math.max(15, Math.min(100, Number(s.lyricsOpacity) || 88)) / 100
  const amp = Math.max(0, Math.min(16, Number(s.lyricsFloatAmp) || 0))
  const speed = Math.max(3, Math.min(16, Number(s.lyricsFloatSpeed) || 6))
  /* 漂浮：用独立的 translate 属性，和 transform 的倾斜叠加（不会互相覆盖） */
  const floatRule =
    amp > 0
      ? `translate: 0 0;
  animation: hs-lyrics-float ${speed}s ease-in-out infinite;`
      : ''
  const floatFrames =
    amp > 0
      ? `@keyframes hs-lyrics-float {
  0%, 100% { translate: 0 0; }
  50% { translate: 0 ${(-amp).toFixed(2)}px; }
}`
      : ''

  return `
/* 歌词卡片：投射在右上一小块。倾斜用 transform，漂浮用独立的 translate 属性
   （两者是叠加关系），所以漂浮不会把倾斜角度抹掉。 */
#${LYRICS_ID} {
  position: fixed;
  top: 46px;
  right: 18px;
  z-index: 60;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  align-items: flex-end;
  width: ${width}px;
  max-width: 46vw;
  padding: 0.45rem 0.7rem;
  border: 1px solid color-mix(in srgb, var(--ui-base, #fff) 14%, transparent);
  border-radius: 10px;
  background:
    linear-gradient(140deg,
      color-mix(in srgb, var(--ui-base, #fff) 10%, transparent),
      color-mix(in srgb, var(--ui-base, #fff) 4%, transparent));
  box-shadow:
    0 10px 30px rgba(0, 0, 0, 0.32),
    0 0 22px color-mix(in srgb, var(--dt-accent, #4a84fe) 32%, transparent);
  -webkit-backdrop-filter: blur(7px);
  backdrop-filter: blur(7px);
  pointer-events: none;
  user-select: none;
  opacity: ${opacity};
  transform: rotate(${tilt}deg) perspective(600px) rotateY(${(tilt / 6).toFixed(1)}deg);
  ${floatRule}
}

#${LYRICS_ID} .hs-lyrics-now {
  width: 100%;
  text-align: right;
  font-size: ${font}rem;
  font-weight: 600;
  line-height: 1.35;
  color: var(--ui-text-primary, #e6edf3);
  text-shadow: 0 1px 10px rgba(0, 0, 0, 0.5);
}

#${LYRICS_ID} .hs-lyrics-next {
  width: 100%;
  text-align: right;
  font-size: ${(font * 0.82).toFixed(2)}rem;
  line-height: 1.3;
  color: var(--ui-text-tertiary, rgba(230, 237, 243, 0.55));
}

/* 投射的光束：从卡片上沿往标题栏那侧散开 */
#${LYRICS_ID} .hs-lyrics-beam {
  position: absolute;
  left: 12%;
  right: 12%;
  bottom: 100%;
  height: 34px;
  background: linear-gradient(to top,
    color-mix(in srgb, var(--dt-accent, #4a84fe) 24%, transparent),
    transparent);
  filter: blur(6px);
  pointer-events: none;
}

${floatFrames}
`
}

/* ── 发送入场动画 ──────────────────────────────────────────────────
   只给「新出现在 DOM 里」的气泡加类，已有气泡和整屏重渲染都不播：
   不这么做得靠 CSS 选择器的话，注入样式表 / 刷新 / 切会话会把整段记录一起播一遍。 */
let bubbleObserver = null
let bubbleSeen = null
let bubbleEnterMode = 'off'

function watchBubbles(s) {
  if (typeof document === 'undefined') return

  bubbleEnterMode =
    s.bubbleEnter === 'rise' || s.bubbleEnter === 'pop' || s.bubbleEnter === 'slide' || s.bubbleEnter === 'fly'
      ? s.bubbleEnter
      : 'off'

  if (!bubbleSeen) bubbleSeen = new WeakSet()

  /* 首次（以及每次设置变动）：把当前已经存在的气泡全部登记为「已见」——
     它们不是刚发出去的，绝不能播动画，否则刷新 / 改设置会让整段记录重播一遍。 */
  for (const node of document.querySelectorAll("[data-slot='aui_user-message-root']")) {
    if (node) bubbleSeen.add(node)
  }

  if (bubbleObserver) return

  /* 只有观察器报上来的「新进 DOM 的气泡」才会走到这里 */
  const consume = nodes => {
    const fresh = []

    for (const node of nodes) {
      if (!node || bubbleSeen.has(node)) continue

      bubbleSeen.add(node)
      fresh.push(node)
    }

    if (bubbleEnterMode === 'off' || !fresh.length) return

    /* ⚠️ 只动画**最新那一条**（屏幕上最靠下的那个）。
       以前是「一次涌入超过 2 条就整批不播」—— 但聊天区是虚拟滚动，发一条消息常会连带重建
       好几行，新消息被当成「整批重渲染」静默跳过，用户报「发送动画没有生效」。
       现在：挑最新的一条播，其余不动（既不重播整段历史，也不漏掉刚发出去的那条）。 */
    let target = fresh[0]

    for (const node of fresh) {
      if (!target || node.getBoundingClientRect().top > target.getBoundingClientRect().top) target = node
    }

    if (bubbleEnterMode === 'fly') {
      try {
        const composer = document.querySelector("[data-slot='composer-surface']")
        const box = target.getBoundingClientRect()
        const cb = composer ? composer.getBoundingClientRect() : null

        if (cb && box.height) {
          target.style.setProperty('--hs-fdx', Math.round(cb.left + cb.width / 2 - (box.left + box.width / 2)) + 'px')
          target.style.setProperty('--hs-fdy', Math.round(cb.top + cb.height / 2 - (box.top + box.height / 2)) + 'px')
        }
      } catch {
        /* 量不到就退回普通上浮 */
      }
    }

    target.classList.add('hs-msg-enter')

    const done = () => {
      target.classList.remove('hs-msg-enter')
      target.style.removeProperty('--hs-fdx')
      target.style.removeProperty('--hs-fdy')
    }

    target.addEventListener('animationend', done, { once: true })
    setTimeout(done, 2600)
  }

  bubbleObserver = new MutationObserver(records => {
    /* 新消息进来时顺手给附件打标记（apply 只在加载/改设置时跑） */
    safeSync('附件对齐', syncBubbleAttachments)

    const fresh = []

    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!node || node.nodeType !== 1) continue
        if (node.matches && node.matches("[data-slot='aui_user-message-root']")) fresh.push(node)
        else if (node.querySelectorAll) fresh.push(...node.querySelectorAll("[data-slot='aui_user-message-root']"))
      }
    }

    if (fresh.length) consume(fresh)
  })

  bubbleObserver.observe(document.body, { childList: true, subtree: true })
}

/* 单项功能出错绝不能连累整个外观：曾因删代码删过头，桌宠那步抛
   ReferenceError，apply 中途中断 —— 后面的「背景整层」压根没建出来，
   用户看到的就是「背景不见了」。所以每段同步各自 try/catch，错误收集起来
   在自检里显示，而不是让它把后面全带崩。 */
const applyErrors = []

function safeSync(label, fn) {
  try {
    fn()
  } catch (err) {
    const msg = `${label}: ${err && err.message ? err.message : String(err)}`

    if (!applyErrors.includes(msg)) applyErrors.push(msg)
  }
}

function apply(s) {
  /* 锁定布局（默认开）：绑 dragstart 拦截 + 起 1 秒扫描把手 */
  try {
    syncLayoutLock(s)
  } catch {}

  const styleEl = ensureStyle()

  if (!styleEl) return

  /* ⚠️ 侧栏功能行的贡献要先注册 —— buildCss 里的兜底 CSS 依赖注册结果，
     顺序反了的话第一次开开关会用上一次的状态（多收一行、下一帧才纠正）。 */
  safeSync('侧栏功能行', () => syncSidebarNav(s))
  safeSync('侧栏折叠箭头', () => syncNavToggle(s))
  safeSync('侧栏折叠箭头（观察器）', () => watchNavToggle())
  styleEl.textContent = buildCss(s)
  safeSync('基础配色', () => paintRoot(s))
  /* 液态玻璃的折射滤镜（贴在隐藏 <svg> 上）；不用液态时会把整张 svg 撤掉 */
  safeSync('输入框磨砂弹性', () => syncLgxElastic(s))
  safeSync('计时进度条', () => syncTimerBar(s))
  safeSync('角落挂绳', () => syncRope(s))
  safeSync('推理滑条', () => syncEffortSlider(s))
  /* 桌宠层：开关 / 包 / 大小位置变了都从这里对齐 */
  safeSync('桌宠', () => syncPet(s))
  /* ⚠️ 这两个必须在 apply 里（常驻），不能挂在「设置弹窗打开」那段 ——
     挂那里的话设置弹窗没开时根本不会执行（血例：拖宽细线从来没被创建过）。 */
  
    safeSync('会话行高亮', () => syncSessHighlight(s))
    safeSync('输入框铺底层让开', () => syncComposerClear())
    safeSync('会话栏拖宽', () => syncSessDrag(s))

  safeSync('背景轮换', () => syncRotateTimer(s))
  safeSync('消息气泡', () => watchBubbles(s))
  safeSync('背景音乐', () => syncMusic(s))
  safeSync('歌词', () => loadLyrics(s))

  const kind = s.mode === 'off' || !s.path ? '' : s.mode
  const src = kind ? sourceUrl(s) : ''
  let layer = document.getElementById(LAYER_ID)

  if (!kind) {
    /* 整层移除：body 里留一个没用上的 div，会成为 flex 子项扰到排版 */
    if (layer) {
      layer.remove()
    }

    return
  }

  if (!layer) {
    layer = document.createElement('div')
    layer.id = LAYER_ID
    document.body.appendChild(layer)
  }

  /* ⚠️ 背景没变时**不能直接 return**：附件对齐等同步原先写在早退之后 ——
     于是「背景不变时那些开关毫无反应」。这里只跳过「重建背景元素」那一段，
     后面的同步照旧执行（safeSync / rebindGlobal 都是可重复调用的）。 */
  const bgSame = layer.dataset.kind === kind && layer.dataset.src === src

  if (!bgSame) {
    const el = kind === 'video' ? document.createElement('video') : document.createElement('img')

    if (kind === 'video') {
      el.muted = true
      el.loop = true
      el.autoplay = true
      el.playsInline = true
      el.setAttribute('muted', '')
      el.setAttribute('playsinline', '')
    }

    el.setAttribute('aria-hidden', 'true')
    el.src = src
    layer.replaceChildren(el)
    layer.dataset.kind = kind
    layer.dataset.src = src

    if (kind === 'video') {
      const played = el.play?.()

      if (played && typeof played.catch === 'function') {
        played.catch(() => {})
      }
    }
  }

  /* 给设置面板打标记（找不到就跳过） */
  markSettingsSurface()

  /* 附件（消息里的图片）对齐：应用把附件和气泡并列渲染，得单独标记 */
  safeSync('附件对齐', syncBubbleAttachments)

}

/* ── 配置包：设置 + 素材打包成一个 zip ────────────────────────────
   导出的包结构：
     settings.json   { magic, version, at, settings, presets, assets{路径→包内键} }
     media/<键>      背景视频/图片、开机动画、动画音效…
   为什么自己写 zip：插件只有 ctx.storage（没有文件 API），不想引外部库；
   只存不压（store）—— 解包只需切片，不需要解压器。
   ⚠️ CRC32 必须算对，否则 Windows 自带解压会判「包损坏」（实测过）。
   ⚠️ 读本地素材走 file:// 而不是 hermes-media://：后者被 CORS 拦（实测）。 */

const BUNDLE_MAGIC = 'hermes-personalize-bundle'
const BUNDLE_FOLDER = 'hermes-个性化设置'
const ASSET_DB = 'hermes-personalize-assets'
const ASSET_STORE = 'assets'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)

  for (let i = 0; i < 256; i += 1) {
    let c = i

    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }

  return table
})()

function crcStep (bytes, seed) {
  let c = seed >>> 0

  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return c
}

/* 分块算：152MB 的视频也不会一次性读进内存 */
async function crcOfBlob (blob) {
  let c = 0xffffffff
  const step = 32 * 1024 * 1024

  for (let off = 0; off < blob.size; off += step) {
    c = crcStep(new Uint8Array(await blob.slice(off, Math.min(off + step, blob.size)).arrayBuffer()), c)
  }

  return (c ^ 0xffffffff) >>> 0
}

async function zipBuild (entries) {
  const enc = new TextEncoder()
  const parts = []
  const central = []
  let offset = 0

  for (const entry of entries) {
    const name = enc.encode(entry.name)
    const crc = await crcOfBlob(entry.blob)
    const size = entry.blob.size
    const lh = new DataView(new ArrayBuffer(30))

    lh.setUint32(0, 0x04034b50, true)
    lh.setUint16(4, 20, true)
    lh.setUint16(8, 0, true)          /* 0 = 不压缩 */
    lh.setUint16(12, 0x21, true)      /* 1980-01-01 */
    lh.setUint32(14, crc, true)
    lh.setUint32(18, size, true)
    lh.setUint32(22, size, true)
    lh.setUint16(26, name.length, true)
    parts.push(new Uint8Array(lh.buffer), name, entry.blob)

    const cd = new DataView(new ArrayBuffer(46))

    cd.setUint32(0, 0x02014b50, true)
    cd.setUint16(4, 20, true)
    cd.setUint16(6, 20, true)
    cd.setUint16(12, 0x21, true)
    cd.setUint32(16, crc, true)
    cd.setUint32(20, size, true)
    cd.setUint32(24, size, true)
    cd.setUint16(28, name.length, true)
    cd.setUint32(42, offset, true)
    central.push(new Uint8Array(cd.buffer), name)
    offset += 30 + name.length + size
  }

  const cdSize = central.reduce((n, p) => n + (p.length !== undefined ? p.length : p.byteLength), 0)
  const eocd = new DataView(new ArrayBuffer(22))

  eocd.setUint32(0, 0x06054b50, true)
  eocd.setUint16(8, entries.length, true)
  eocd.setUint16(10, entries.length, true)
  eocd.setUint32(12, cdSize, true)
  eocd.setUint32(16, offset, true)
  return new Blob([...parts, ...central, new Uint8Array(eocd.buffer)], { type: 'application/zip' })
}

function zipRead (buffer) {
  const u8 = new Uint8Array(buffer)
  const dv = new DataView(buffer)
  let eocd = -1

  for (let i = buffer.byteLength - 22; i >= 0 && i > buffer.byteLength - 70000; i -= 1) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }

  if (eocd < 0) throw new Error('不是有效的 zip 包')

  const count = dv.getUint16(eocd + 10, true)
  const decoder = new TextDecoder()
  const out = []
  let p = dv.getUint32(eocd + 16, true)

  for (let i = 0; i < count; i += 1) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('包的中央目录损坏')

    const method = dv.getUint16(p + 10, true)
    const size = dv.getUint32(p + 24, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const cmtLen = dv.getUint16(p + 32, true)
    const lho = dv.getUint32(p + 42, true)
    const name = decoder.decode(u8.subarray(p + 46, p + 46 + nameLen))

    if (method !== 0) throw new Error(`包里的 ${name} 是压缩的，本插件只认识未压缩包`)

    const dataAt = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true)

    out.push({ blob: new Blob([u8.subarray(dataAt, dataAt + size)]), name })
    p += 46 + nameLen + extraLen + cmtLen
  }

  return out
}

/* ── 包内素材的本地库（IndexedDB：能装下几百 MB 的视频）───────── */
function assetDb () {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('本环境不支持 IndexedDB'))

    const req = indexedDB.open(ASSET_DB, 1)

    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(ASSET_STORE)) req.result.createObjectStore(ASSET_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function assetPut (key, blob) {
  const db = await assetDb()

  await new Promise((resolve, reject) => {
    const tx = db.transaction(ASSET_STORE, 'readwrite')

    tx.objectStore(ASSET_STORE).put(blob, key)
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

async function assetGet (key) {
  const db = await assetDb()
  const value = await new Promise((resolve, reject) => {
    const tx = db.transaction(ASSET_STORE, 'readonly')
    const req = tx.objectStore(ASSET_STORE).get(key)

    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

  db.close()
  return value
}

/* 把设置里记录的「原路径 → 包内键」全部换成 blob URL */
async function hydrateBundleUrls () {
  const map = $settings.get().bundleAssets || {}
  const next = {}

  for (const [path, key] of Object.entries(map)) {
    try {
      const blob = await assetGet(key)

      if (blob) next[path] = URL.createObjectURL(blob)
    } catch {
      /* 取不到就退回原路径 */
    }
  }

  bundleUrls = next
}

/** 当前**正在用**的素材：背景 + 当前那条启动动画（含它的音效）+ 当前正在播的背景音乐。
    ⚠️ 用户明确要求：只打包正在用的，不要把列表里的历史素材（几十条、上 GB）都塞进包。 */
function inUseAssets (s) {
  const out = []

  if ((s.mode === 'video' || s.mode === 'image') && s.path) out.push(s.path)

  const clip = currentStartupClip(s)

  if (s.startupMode !== 'off' && clip) {
    if (clip.path) out.push(clip.path)
    if (clip.audioPath) out.push(clip.audioPath)
  }

  if (s.musicOn !== false) {
    const tracks = s.musicTracks || []

    if (tracks.length) {
      const track = tracks[musicIndex % tracks.length]

      if (track && track.path) out.push(track.path)
    }
  }

  return [...new Set(out)]
}

const assetKeyFor = path => {
  const base = String(path).replace(/\\/g, '/').split('/').pop() || 'asset'
  let hash = 0

  for (let i = 0; i < path.length; i += 1) hash = (hash * 31 + path.charCodeAt(i)) >>> 0
  return `${hash.toString(36)}-${base}`.replace(/[^\w.\-]/g, '_').slice(0, 120)
}

function pickBundleFile () {
  const input = document.createElement('input')

  input.type = 'file'
  input.accept = '.zip,application/zip'
  input.style.display = 'none'
  input.onchange = () => {
    const file = input.files && input.files[0]

    input.remove()
    if (!file) return
    importBundle(file, $settings.get().bundleImportMedia !== false)
      .then(info => host.notify({ kind: 'info', message: `已导入配置包：设置已生效，还原了 ${info.restored} 个素材。想回退可以到「配置存档」里读回导入前那一份。` }))
      .catch(err => host.notify({ kind: 'error', message: `导入失败：${String((err && err.message) || err)}` }))
  }
  document.body.appendChild(input)
  input.click()
}

function downloadBlob (blob, name) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')

  a.href = url
  a.download = name
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  setTimeout(() => { try { a.remove(); URL.revokeObjectURL(url) } catch { /* 忽略 */ } }, 4000)
}

async function exportBundle () {
  const s = $settings.get()
  const withMedia = s.bundleWithMedia !== false
  const paths = withMedia ? inUseAssets(s) : []
  const root = BUNDLE_FOLDER
  const entries = []
  const map = {}
  const failed = []
  const used = new Set()

  for (const path of paths) {
    try {
      const res = await fetch(fileUrl(path))

      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const blob = await res.blob()
      /* 包内用**原文件名**（用户看得懂），重名就加序号 */
      let name = fileNameOf(path) || 'asset'

      if (used.has(name)) {
        const dot = name.lastIndexOf('.')
        const stem = dot > 0 ? name.slice(0, dot) : name
        const ext = dot > 0 ? name.slice(dot) : ''

        name = `${stem}-${used.size}${ext}`
      }

      used.add(name)
      entries.push({ blob, name: `${root}/素材/${name}` })
      map[path] = name
    } catch {
      failed.push(path)
    }
  }

  const payload = {
    assets: map,
    at: Date.now(),
    magic: BUNDLE_MAGIC,
    presets: $presets.get(),
    /* ⚠️ API Key 不进包：导出清空（导入时也保留本机那把） */
    settings: { ...s, petBalKey: '', bundleAssets: map },
    version: 1
  }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
  /* 包内结构（用户要求：配置与素材分开、装在一个文件夹里）：
       hermes-个性化设置/config.json
       hermes-个性化设置/素材/<素材原文件名> */
  const zip = await zipBuild([
    { blob: new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), name: `${root}/config.json` },
    ...entries
  ])

  downloadBlob(zip, `hermes-个性化设置-${stamp}.zip`)
  return { failed, media: entries.length, total: paths.length }
}

async function importBundle (file, useMedia) {
  const entries = zipRead(await file.arrayBuffer())
  const base = name => name.split('/').pop()
  /* 兼容两种结构：新的「文件夹/config.json + 文件夹/素材/*」和老的单层结构 */
  const settingsEntry = entries.find(e => base(e.name) === 'config.json') || entries.find(e => base(e.name) === 'settings.json')

  if (!settingsEntry) throw new Error('这个包里没有 config.json，不是配置包')

  const wantMedia = useMedia !== false

  const payload = JSON.parse(await settingsEntry.blob.text())

  if (!payload || payload.magic !== BUNDLE_MAGIC) throw new Error('这不是「个性化设置」的配置包')

  const media = {}

  for (const e of entries) if (/^(media\/|.*\/素材\/)/.test(e.name)) media[base(e.name)] = e.blob

  /* 用户可选择「不用包里的素材」：那就只套设置，素材继续用本机原来的路径 */
  const map = wantMedia ? (payload.assets || {}) : {}
  let restored = 0

  if (wantMedia) for (const [path, key] of Object.entries(map)) {
    if (media[key]) { await assetPut(key, media[key]); restored += 1 }
  }

  /* 导入前把当前设置存成一份存档：导错了也能一键读回（满了就不存，仍然导入） */
  const list = $presets.get()

  if (list.length < MAX_PRESETS) {
    $presets.set([...list, { at: Date.now(), seq: 0, settings: $settings.get() }])
    persistPresets()
  }

  /* 导入时保留本机那把 Key（包里的 Key 一律不采用） */
  const next = normalizeSettings({ ...payload.settings, petBalKey: $settings.get().petBalKey || '', bundleAssets: map })

  /* 先落设置（hydrate 要读它），再把包内素材换成 blob URL，最后 update() 统一生效 + 持久化 */
  $settings.set(next)
  await hydrateBundleUrls()
  update(next)
  return { restored, skipped: Object.keys(media).length - restored, total: Object.keys(media).length }
}

/** 存档摘要：一眼认出这是哪套配置 */
function presetSummary(settings) {
  const s = normalizeSettings(settings)
  const parts = []

  parts.push(s.mode === 'off' || !s.path ? '无背景' : `背景 ${fileNameOf(s.path)}`)

  if (s.startupMode !== 'off' && s.startupPath) parts.push(`动画 ${fileNameOf(s.startupPath)}`)
  if (s.sessOn) parts.push('会话悬浮')
  if (s.sessInOn || s.sessOutOn) parts.push('会话光晕')
  if (s.glowOn) parts.push('输入框光效')
  if (s.frostOn) parts.push('输入框磨砂')
  if (s.ink) parts.push(`字色 ${s.ink}`)

  return parts.join(' · ')
}

function timeText(at) {
  const d = new Date(Number(at) || 0)
  const pad = n => String(n).padStart(2, '0')

  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function persistPresets() {
  try {
    const written = ctxRef?.storage?.set?.(PRESET_KEY, $presets.get())

    if (written && typeof written.catch === 'function') {
      written.catch(() => {})
    }
  } catch {
    /* 存不下就算了，功能本身还能用 */
  }
}

function savePreset() {
  haptic('tap')

  const list = $presets.get()

  /* 满了就明确拒绝 + 弹窗提醒，绝不悄悄把旧存档丢掉 */
  if (list.length >= MAX_PRESETS) {
    host.notify({
      kind: 'warn',
      message: `存档已经满了（${MAX_PRESETS} 份）。先删掉一份再保存 —— 这里不会自动删掉旧存档。`
    })

    return
  }

  const seq = list.reduce((max, item) => Math.max(max, Number(item && item.seq) || 0), 0) + 1
  const snapshot = JSON.parse(JSON.stringify($settings.get()))

  $presets.set([...list, { at: Date.now(), seq, settings: snapshot }])
  persistPresets()
  host.notify({
    kind: 'info',
    message: `已存为 ${seq} 号配置（${list.length + 1}/${MAX_PRESETS}）。`
  })
}

function readPreset(seq) {
  const item = $presets.get().find(entry => Number(entry.seq) === Number(seq))

  if (!item) return

  haptic('tap')
  /* 整份读回来：update → apply 会把样式、背景层、定时器全部重算一遍 */
  /* 旧存档没有新加的键：先铺一层默认值，再用存档覆盖
     （否则新功能的滑块 value 是 undefined，控件会显示异常） */
  update({ ...DEFAULTS, ...item.settings })
  host.notify({ kind: 'info', message: `已读取 ${seq} 号配置。` })
}

function overwritePreset(seq) {
  const list = $presets.get()
  const item = list.find(entry => Number(entry.seq) === Number(seq))

  if (!item) return

  haptic('tap')

  const next = list.map(entry =>
    Number(entry.seq) === Number(seq)
      ? { ...entry, at: Date.now(), settings: JSON.parse(JSON.stringify($settings.get())) }
      : entry
  )

  $presets.set(next)
  persistPresets()
  host.notify({ kind: 'info', message: `${seq} 号配置已覆盖为当前设置。` })
}

function removePreset(seq) {
  haptic('tap')
  $presets.set($presets.get().filter(entry => Number(entry.seq) !== Number(seq)))
  persistPresets()
}

function update(patch) {
  const next = { ...$settings.get(), ...patch }

  $settings.set(next)
  apply(next)

  try {
    const written = ctxRef?.storage?.set?.(KEY, next)

    if (written && typeof written.catch === 'function') {
      written.catch(() => {})
    }
  } catch {
    /* 存不下就算了，功能本身还能用 */
  }
}

/* ── 界面（设置 → 插件 → 个性化设置）────────────────────────────── */
/* ── 开机动画：启动后播一次，播完淡出；不循环 ───────────────────── */
const STARTUP_ID = 'hermes-bg-startup'
const STARTUP_FLAG = 'hermes-bg-startup-played'

function finishStartup(overlay) {
  if (!overlay || overlay.dataset.done === '1') return

  overlay.dataset.done = '1'

  clearInterval(overlay.__readyTimer)
  clearTimeout(overlay.__holdTimer)

  /* 撤掉跳过用的监听（挂在 window 上，不撤会一直留着） */
  for (const [type, handler, capture] of overlay.__skips || []) {
    window.removeEventListener(type, handler, capture)
  }

  overlay.__skips = []

  for (const timer of overlay.__timers || []) clearTimeout(timer)

  const fadeOut = Number(overlay.__fadeOut) || 0
  const exit = overlay.__exit === 'shrink' ? 'shrink' : 'fade'
  const audioSource = overlay.__audioSource

  const stopAudio = () => {
    if (!audioSource) return

    try {
      audioSource.pause()
    } catch {
      /* 元素已被移除等情况，忽略 */
    }
  }

  /* 时长设 0 就等于「立刻消失」，不再需要单独的选项 */
  if (fadeOut <= 0) {
    stopAudio()
    overlay.remove()

    return
  }

  if (!document.getElementById(ANIM_ID)) {
    startupKeyframes(overlay.__zoom)
  }

  const name = exit === 'shrink' ? 'hermes-bg-shrink-out' : 'hermes-bg-fade-out'
  let removed = false
  const done = () => {
    if (removed) return

    removed = true
    clearInterval(overlay.__audioTimer)
    stopAudio()
    overlay.remove()
  }

  overlay.style.animation = `${name} ${fadeOut}ms ease both`
  overlay.addEventListener('animationend', event => {
    if (event.animationName === name) done()
  })
  setTimeout(done, fadeOut + 150)

  /* 声音跟着收场一起降下来，否则会「画面淡出了，声音还在响」 */
  if (audioSource) {
    const startVolume = Number(audioSource.volume) || 0
    const steps = Math.max(1, Math.round(fadeOut / 40))
    let step = 0

    overlay.__audioTimer = setInterval(() => {
      step += 1

      try {
        audioSource.volume = Math.max(0, startVolume * (1 - step / steps))
      } catch {
        /* 忽略 */
      }

      if (step >= steps) {
        clearInterval(overlay.__audioTimer)
        stopAudio()
      }
    }, 40)
  }
}

const ANIM_ID = 'hermes-bg-anim'

let lastStartupPlan = null

/** 出场 / 收场的关键帧，常驻一张样式表（跟背景开不开无关）。
    缩放幅度按设置现算，所以每次播放都会重写一次。 */
function startupKeyframes(zoomPercent) {
  let el = document.getElementById(ANIM_ID)

  if (!el) {
    el = document.createElement('style')
    el.id = ANIM_ID
    document.head.appendChild(el)
  }

  const zoom = Math.max(1, Math.min(60, Number(zoomPercent) || 12)) / 100

  el.textContent = `
/* 开机动画：加载完成前不给跳过，光标和提示条如实反映状态 */
#${STARTUP_ID}:not([data-ready='1']) { cursor: default; }
#${STARTUP_ID}[data-ready='1'] { cursor: pointer; }
/* 加载中点了鼠标 / 按了 Esc：整层极短地暗一下当作反馈（不写字） */
 #${STARTUP_ID}[data-nope='1'] { animation: hs-startup-nope 0.22s ease; }
 @keyframes hs-startup-nope {
   45% { opacity: 0.8; }
 }
@keyframes hermes-bg-fade-in{from{opacity:0}to{opacity:1}}
@keyframes hermes-bg-zoom-in{from{opacity:0;transform:scale(${(1 + zoom).toFixed(3)})}to{opacity:1;transform:scale(1)}}
@keyframes hermes-bg-fade-out{from{opacity:1}to{opacity:0}}
@keyframes hermes-bg-shrink-out{from{opacity:1;transform:scale(1)}to{opacity:0;transform:scale(${(1 + zoom).toFixed(3)})}}`

  return el
}

/* Hermes 什么时候算「加载进去了」：应用没给现成的就绪标记，
   但它自己有个很准的信号 —— 网关没打开时，输入框是禁用的
   （composer 的 aria-disabled="true" + contenteditable="false"，
   提示语正是「正在启动 Hermes…」）。所以：
     ① 应用外壳（data-contrib-shell）已渲染；
     ② 输入框存在，且不再是禁用态 → 网关已经通了 = 加载完成。
   万一输入框一直没有（或一直没有启用），用 12 秒宽限兜底放行，
   免得把用户锁在动画里。判定为真之前，点鼠标 / 按 Esc 都不跳过。 */
const READY_GRACE_MS = 12000
/* 网关通了之后，再给「界面真的画出来」这点时间：
   不然动画会在骨架屏/空界面那一瞬间收场，看着就像「先闪了一下 Hermes 的原界面」。 */
const PAINT_GRACE_MS = 2500
let startupBootAt = 0
let gatewayOpenAt = 0

function appReadyForSkip() {
  try {
    if (!document.querySelector('[data-contrib-shell]')) return false

    if (!startupBootAt) startupBootAt = Date.now()

    const input = document.querySelector("[data-slot='composer-rich-input']")

    /* 输入框还没渲染出来 / 还是禁用态（网关没通，提示语是「正在启动 Hermes…」） */
    if (!input) return Date.now() - startupBootAt >= READY_GRACE_MS

    const blocked =
      input.getAttribute('aria-disabled') === 'true' || input.getAttribute('contenteditable') === 'false'

    if (blocked) {
      gatewayOpenAt = 0

      return Date.now() - startupBootAt >= READY_GRACE_MS
    }

    /* 网关已通：再看会话列表是不是已经出条目（= 左侧内容真画出来了） */
    if (!gatewayOpenAt) gatewayOpenAt = Date.now()

    if (document.querySelector("[data-slot='sidebar-wrapper'] div[data-index]")) return true

    /* 没有会话可显示、或列表还没出条目：宽限一下，别一直挡着 */
    return Date.now() - gatewayOpenAt >= PAINT_GRACE_MS
  } catch {
    /* 判定不了就放行，别把用户困在动画里 */
    return true
  }
}

function playStartup(settings, options) {
  const s = settings || $settings.get()
  const force = Boolean(options && options.force)

  if (s.startupMode === 'off' || !s.startupPath) return
  /* 只在主窗口放：宠物浮层 / 快捷输入那种小窗没有应用外壳 */
  if (!document.querySelector('[data-contrib-shell]')) return
  if (document.getElementById(STARTUP_ID)) return

  if (!force) {
    try {
      if (sessionStorage.getItem(STARTUP_FLAG)) return

      sessionStorage.setItem(STARTUP_FLAG, '1')
    } catch {
      /* sessionStorage 不可用就每次启动都放 */
    }
  }

  const overlay = document.createElement('div')

  const backdrop =
    s.startupBackdrop === 'transparent'
      ? 'transparent'
      : s.startupBackdrop === 'theme'
        ? 'var(--dt-background, #0d1117)'
        : '#05080b'
  const enter = s.startupEnter === 'zoom' ? 'zoom' : 'fade'
  const fadeIn = Math.max(0, Math.min(3000, Number(s.startupFadeIn) || 0))

  overlay.id = STARTUP_ID
  overlay.setAttribute(
    'style',
    `position:fixed;inset:0;z-index:2147483647;background:${backdrop};display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:${enter === 'none' || fadeIn <= 0 ? 1 : 0}`
  )

  overlay.__exit = s.startupExit === 'shrink' ? 'shrink' : 'fade'
  overlay.__fadeOut = Math.max(0, Math.min(3000, Number(s.startupFadeOut) || 0))
  overlay.__zoom = Math.max(1, Math.min(60, Number(s.startupZoom) || 12))

  startupKeyframes(overlay.__zoom)

  /* 时长设 0 就等于「直接出现」，不再需要单独的选项 */
  const instantEnter = fadeIn <= 0

  if (!instantEnter) {
    /* 关键帧写法：新插入的元素只要带上 animation 就一定跑过渡，
       不用「先画一帧再改属性」那套时序，也就不会整段被跳过。 */
    overlay.style.animation = `${enter === 'zoom' ? 'hermes-bg-zoom-in' : 'hermes-bg-fade-in'} ${fadeIn}ms ease both`
  }

  const isVideo = s.startupMode === 'video'
  /* 音效按「当前这条动画」自己那套取（没单独设过就回落到全局默认） */
  const clipAudioFor = clipAudio(s, currentStartupClip(s))
  const audioMode = clipAudioFor.mode
  const volume = clipAudioFor.volume / 100
  const media = document.createElement(isVideo ? 'video' : 'img')

  media.setAttribute('aria-hidden', 'true')
  media.setAttribute('style', `width:100%;height:100%;object-fit:${s.startupFit === 'cover' ? 'cover' : 'contain'}`)
  media.src = isVideo ? mediaUrl(s.startupPath) : fileUrl(s.startupPath)

  if (isVideo) {
    const useOwnAudio = audioMode === 'video'

    media.muted = !useOwnAudio
    media.autoplay = true
    media.loop = false
    media.playsInline = true
    media.volume = useOwnAudio ? volume : 1
    media.setAttribute('playsinline', '')

    if (useOwnAudio) {
      /* 视频原声：把视频本身当音源，收场时一起降音 */
      overlay.__audioSource = media
    } else {
      media.setAttribute('muted', '')
    }
  }

  const seconds = Math.max(1, Math.min(60, Number(s.startupMaxSeconds) || 6))

  const allowEarlySkip = s.startupSkipEarly === 'on'
  let ready = allowEarlySkip
  let holding = false

  /* 动画时长比 Hermes 加载时长短时：播完不淡出，停在最后一帧等加载完成。
     兜底：最多等 HOLD_CAP_MS，避免就绪判定出意外把人一直困在动画里。 */
  const HOLD_CAP_MS = 30000

  const holdLastFrame = () => {
    if (holding) return

    holding = true
    overlay.dataset.held = '1'

    try {
      if (isVideo) {
        media.pause()

        /* 显式停到最后一帧：某些情况下 ended 会变黑，取帧回来更稳 */
        if (Number.isFinite(media.duration) && media.duration > 0) {
          media.currentTime = Math.max(0, media.duration - 0.05)
        }
      }
    } catch {
      /* 帧取不到就算了，画面本身就是停住的 */
    }

    paintReady()
    overlay.__holdTimer = setTimeout(() => finishStartup(overlay), HOLD_CAP_MS)
  }

  const finishOrHold = () => {
    if (ready || allowEarlySkip) return finishStartup(overlay)

    holdLastFrame()
  }

  overlay.__timers = [setTimeout(() => finishOrHold(), seconds * 1000)]

  const paintReady = () => {
    if (!allowEarlySkip) ready = appReadyForSkip()

    overlay.dataset.ready = ready ? '1' : '0'

    /* 之前停在最后一帧等加载 → 现在可以正常收场 */
    if (ready && holding) finishStartup(overlay)
  }

  const skip = () => {
    if (!ready) {
      /* 还没加载完不让跳过：整层极短地暗一下，让用户知道「点了，但还不能进」 */
      delete overlay.dataset.nope
      void overlay.offsetWidth
      overlay.dataset.nope = '1'

      return
    }

    finishStartup(overlay)
  }

  const onKey = event => {
    if (event.key === 'Escape') skip()
  }
  const onPointer = () => skip()

  /* 点击跳过挂在 window 的捕获阶段，而不是只挂在这一层上：
     启动还没走完时，应用自己的启动画面（或别的盖得更上面的元素）会吃掉点击，
     只挂在自己身上就会出现「点了没反应」。捕获阶段 + window 层 = 点哪儿都算。 */
  overlay.__skips = [
    ['pointerdown', onPointer, true],
    ['mousedown', onPointer, true],
    ['keydown', onKey, true]
  ]

  for (const [type, handler, capture] of overlay.__skips) {
    window.addEventListener(type, handler, capture)
  }

  paintReady()
  overlay.__readyTimer = setInterval(paintReady, 200)

  overlay.addEventListener('click', skip)
  media.addEventListener('error', skip)

  /* 动画自己播完（视频自然结束，没开循环）：
     加载完成 → 不用点，直接自动进入；
     还没完成 → 停在最后一帧等，等就绪判定翻真后由 paintReady 自动收场。
     图片没有 ended，靠「最长播放时长」那条定时器走同样的分支。 */
  if (isVideo) {
    media.addEventListener(
      'ended',
      () => {
        if (ready) finishStartup(overlay)
        else holdLastFrame()
      },
      { once: true }
    )
  }

  if (isVideo) {
    const played = media.play?.()

    if (played && typeof played.catch === 'function') {
      played.catch(() => {})
    }
  }

  overlay.appendChild(media)

  if (audioMode === 'custom' && clipAudioFor.path) {
    const audio = document.createElement('audio')

    audio.setAttribute('aria-hidden', 'true')
    audio.src = mediaUrl(clipAudioFor.path)
    audio.volume = volume

    const played = audio.play?.()

    if (played && typeof played.catch === 'function') {
      played.catch(() => {})
    }

    overlay.__audioSource = audio
    overlay.appendChild(audio)
  }

  document.body.appendChild(overlay)

  lastStartupPlan = {
    enter,
    exit: overlay.__exit,
    fadeIn: instantEnter ? 0 : fadeIn,
    fadeOut: overlay.__fadeOut,
    zoomPercent: overlay.__zoom,
    maxSeconds: seconds,
    audio: audioMode,
    audioPath: audioMode === 'custom' ? clipAudioFor.path : '',
    volume: Math.round(volume * 100),
    mode: s.startupMode
  }
}

function previewStartup() {
  haptic('tap')
  playStartup($settings.get(), { force: true })
}

const MAX_CLIPS = 10

/** 背景 / 开机动画共用同一套字段，靠 target 区分 */
const clipKeys = target =>
  target === 'startup'
    ? {
        clips: 'startupClips',
        index: 'startupSeqIndex',
        mode: 'startupMode',
        path: 'startupPath',
        rotation: 'startupRotation'
      }
    : { clips: 'clips', index: 'seqIndex', mode: 'mode', path: 'path', rotation: 'rotation' }

const kindOf = (file, path) =>
  (file && typeof file.type === 'string' && file.type.startsWith('video')) || VIDEO_RE.test(path)
    ? 'video'
    : 'image'

const pathOfFile = file => window.hermesDesktop?.getPathForFile?.(file) || ''

function appendClips(target, added) {
  const s = $settings.get()
  const k = clipKeys(target)
  const next = [...(s[k.clips] || [])]
  let over = false

  for (const clip of added) {
    if (next.length >= MAX_CLIPS) {
      over = true
      break
    }

    if (!next.some(item => item.path === clip.path)) next.push(clip)
  }

  if (over) {
    host.notify({ kind: 'warn', message: `最多 ${MAX_CLIPS} 条，多出来的没加进去。` })
  }

  const last = next[next.length - 1]

  if (!last) return

  update({ [k.clips]: next, [k.mode]: last.kind, [k.path]: last.path })
}

function addClips(target) {
  haptic('tap')

  const input = document.createElement('input')

  input.type = 'file'
  input.accept = 'video/*,image/*'
  input.multiple = true
  input.onchange = () => {
    const added = []

    for (const file of Array.from(input.files || [])) {
      const path = pathOfFile(file)

      if (path) added.push({ kind: kindOf(file, path), path })
    }

    if (!added.length) {
      host.notify({ kind: 'warn', message: '拿不到文件的路径，换个方式再试。' })

      return
    }

    appendClips(target, added)
  }

  input.click()
}

function addDroppedFiles(files, target) {
  const added = []

  for (const file of Array.from(files || [])) {
    const path = pathOfFile(file)

    if (path) added.push({ kind: kindOf(file, path), path })
  }

  if (added.length) appendClips(target, added)
}

function removeClip(target, index) {
  const s = $settings.get()
  const k = clipKeys(target)
  const next = [...(s[k.clips] || [])]

  next.splice(index, 1)

  const keep = next.find(clip => clip.path === s[k.path]) || next[0]

  update({
    [k.clips]: next,
    [k.mode]: keep ? keep.kind : 'off',
    [k.path]: keep ? keep.path : ''
  })
}

function clearClips(target) {
  haptic('tap')

  const k = clipKeys(target)

  update({ [k.clips]: [], [k.mode]: 'off', [k.path]: '' })
}

/** 剪片按「序号」排序。序号由用户编辑（每条剪片自带 order），没设过的按它在
    列表里的位置兜底 —— 所以老设置不需要迁移。 */
function orderedClips(clips) {
  return (clips || [])
    .map((clip, index) => ({ clip, index }))
    .sort((a, b) => {
      const oa = Number(a.clip && a.clip.order)
      const ob = Number(b.clip && b.clip.order)
      const va = Number.isFinite(oa) && oa > 0 ? oa : a.index + 1
      const vb = Number.isFinite(ob) && ob > 0 ? ob : b.index + 1

      return va - vb || a.index - b.index
    })
}

/** 改某条剪片的序号（index 是它在设置数组里的真实下标，不是显示顺序） */
function setClipOrder(target, index, order) {
  const k = clipKeys(target)
  const list = ($settings.get()[k.clips] || []).map((clip, i) =>
    i === index ? { ...clip, order: Math.max(1, Math.min(99, Number(order) || 1)) } : clip
  )

  update({ [k.clips]: list })
}

/** 轮播：顺序往下走 / 随机挑一条。首次（还没有当前项）停在第一条。
    背景处于「关闭」时不动它，免得启动时把用户关掉的背景又打开。 */
function rotateClip(target) {
  const s = $settings.get()
  const k = clipKeys(target)
  const clips = s[k.clips] || []

  if (!clips.length || s[k.mode] === 'off') return false

  /* 按序号排序后再挑：用户改了序号就按序号走 */
  const ordered = orderedClips(clips)
  const pool = ordered.filter(entry => entry.clip.kind === s[k.mode])
  const list = (pool.length ? pool : ordered).map(entry => entry.clip)
  let index = Number(s[k.index]) || 0

  if (s[k.rotation] === 'random') {
    index = Math.floor(Math.random() * list.length)
  } else if (s[k.path]) {
    index = (index + 1) % list.length
  }

  const clip = list[index % list.length]

  update({ [k.index]: index % list.length, [k.mode]: clip.kind, [k.path]: clip.path })

  return true
}

/* 时长轮换的定时器。关闭时不留任何定时器 —— 那样背景就只在每次启动
   Hermes 时按「顺序 / 随机」换一条（启动时那一次在 init 里做），
   用着的时候不会自己换，免得看视频看一半画面被切走。 */
let rotateTimer = 0

function syncRotateTimer(s) {
  if (rotateTimer) {
    clearInterval(rotateTimer)
    rotateTimer = 0
  }

  if (!s.bgRotateOn) return
  /* 只有一条候选就不用定时了（换了还是它） */
  if ((s.clips || []).filter(clip => clip && clip.path).length < 2) return

  const seconds = Math.max(10, Math.min(3600, Number(s.bgRotateSeconds) || 300))

  rotateTimer = setInterval(() => rotateClip('bg'), seconds * 1000)
}

/** 读设置：兼容旧的单文件写法（path / startupPath）并夹紧到 MAX_CLIPS 条 */
function normalizeSettings(value) {
  /* 原始存档（迁移必须看它，不能看 merged：merged 里新键已被 DEFAULTS 填上，
     用 undefined 判断「用户有没有设过」永远不成立）。 */
  const raw = value && typeof value === 'object' ? value : {}
  const merged = { ...DEFAULTS, ...raw }

  const asClips = (list, fallbackPath, fallbackMode) => {
    const clips = Array.isArray(list)
      ? list.filter(clip => clip && typeof clip.path === 'string' && clip.path)
      : []

    if (!clips.length && fallbackPath) {
      return [{ kind: fallbackMode === 'image' ? 'image' : 'video', path: fallbackPath }]
    }

    return clips.slice(0, MAX_CLIPS)
  }

  /* ── 计时显示模式的一次性迁移 ────────────────────────────────────
     'num'（显示数字）只是 v369 那一版的短暂默认，用户并没有主动选过；而它一旦被落盘，
     「思考中」那两行就会被「工具行」那条路径按数字处理、和「思考方块」那条路径来回抢
     → 表现成「进度和数字来回跳动」。这里按「没主动选过」的特征一次性扳回进度条
     （DEFAULTS 现在是 bar，所以 merged 是 num 只可能是存档里写着的）。
     想要数字的话，设置里的「计时显示」一键就能切。 */
  if (merged.runFlowNumFix1 !== true) {
    if (merged.runFlowClockStyle === 'num') merged.runFlowClockStyle = 'bar'

    merged.runFlowNumFix1 = true
  }

  /* 进度条底槽：用户明确要求「只显示进度、不要整条进度条」，而老存档里可能是开着的
     （所以会看到「一整条灰白轨道」）。一次性关掉；设置里的「进度条底槽」开关留着，想开随时能开。 */
  /* ── 「锁定布局」的一次性迁移 ─────────────────────────────────
     这个开关是**默认开**的（用户明确要求「增加一个按钮默认开启」），但老存档里
     `layoutLockOn` 可能已经被写成了 false（插件的老毛病：只要改过任何一项设置，
     整份设置对象就落盘，新键在下一版加进来时带上的是「按 UI 读出的 off」），
     于是锁定逻辑第一行 `layoutLockOn(s)` 就返回 false → 整个功能像不存在一样
     （用户报「锁定布局功能无效，三个按钮还能拖」）。
     这里一次性扳成开；之后再点「解锁」会正常记住用户的选择。 */
  if (merged.layoutLockOnFix2 !== true) {
    merged.layoutLockOn = true
    merged.layoutLockOnFix2 = true
  }

  if (merged.timerBarNoTrack1 !== true) {
    merged.timerBarTrack = false
    merged.timerBarNoTrack1 = true
  }

  /* ── 挂绳观感的一次性迁移 ─────────────────────────────────────
     v131 之前「粗细」默认 64px、「屏幕外比例」默认 18%：用户只要改过任何一项设置，
     整份设置对象就会落盘，**改 DEFAULTS 对老存档完全无效**（用户报「换了图/改了默认
     还是又大又长」就是这么来的）。所以按「用户没主动调过」的特征把老值换成新观感：
     细绳 + 只露一小截。用户自己调过的中间值（如 20px）不动。 */
  if (merged.ropeV2 !== true) {
    const w = Number(merged.ropeWidth)

    /* 只要不是「已经很细」就归到新默认（用户要求至少缩小一半） */
    if (!Number.isFinite(w) || w <= 0 || w >= 10) merged.ropeWidth = DEFAULTS.ropeWidth

    const off = Number(merged.ropeOffscreen)

    /* 低于 50% 都当成「没调过」（旧默认 18%）→ 换成只露一小截 */
    if (!Number.isFinite(off) || off < 50) merged.ropeOffscreen = DEFAULTS.ropeOffscreen

    merged.ropeV2 = true
  }

  /* ── 第二版迁移：75% 太短（用户要「屏内长度 ×3」）→ 25% ──────────────
     同上：75% 已经被 v2 迁移写进存档了，改 DEFAULTS 不会生效。 */
  if (merged.ropeV3 !== true) {
    const off = Number(merged.ropeOffscreen)

    if (!Number.isFinite(off) || off > 60) merged.ropeOffscreen = DEFAULTS.ropeOffscreen

    merged.ropeV3 = true
  }

  /* ── 第四版迁移：关掉推理弹窗上的液态玻璃 ──────────────────────────
     现象：一点开这个弹窗，整个 Hermes 卡死（只能重开）。
     嫌疑：该弹窗上同时挂 backdrop-filter 与 SVG 位移贴图（液态玻璃），
     在一个大尺寸浮层上是已知的 GPU 杀手。先默认关掉，需要时可在设置里单独打开。 */
  if (merged.popGlassFix1 !== true) {
    merged.hideAppModelPill = false
    merged.popGlassFix1 = true
  }

  /* ── 第五版迁移：右下角的模型列表与推理强度恢复 Hermes 原版 ─────────────
     关掉推理弹窗滑条 + 关掉模型 pill 上的「模型名 · 强度」，并把我写过的文案还原。
     想再用的话，设置页里可以单独打开。 */
  if (merged.restoreNativePills !== true) {
    merged.effortSliderOn = false
    merged.modelPillLabelOn = false
    merged.hideAppModelPill = false
    merged.restoreNativePills = true
  }

  /* ── 第六版迁移：回到「推理弹窗里的渐变流光滑条」那一版 ───────────────────
     用户明确要求：推理强度用之前那个渐变流光滑条弹窗（不要模型列表里的文字档位）。
     注意：弹窗上的液态玻璃保持关闭（那是之前卡死的嫌疑）。 */
  if (merged.sliderPopupBack !== true) {
    merged.effortSliderOn = true
    merged.menuEffortOn = false
    merged.hideReasonPill = false
    merged.modelPillLabelOn = false
    merged.sliderPopupBack = true
  }

  /* ── 第七版迁移：删掉「静态玻璃」，只留玻璃（原液态玻璃）────────────────
     用户要求：去掉纯模糊那种静态玻璃，只保留折射那套，并把名字统一成「玻璃」。
     老存档里可能开着静态玻璃（会话行 / 助手气泡 / 推理弹窗 / 模型弹窗），
     这里一次性关掉，避免样式表和设置页对不上。 */
  if (merged.staticGlassGone1 !== true) {
    merged.sessGlassOn = false
    merged.aBGlassOn = false
    merged.popGlassOn = false
    merged.menuGlassOn = false
    merged.glassFollowPop = false
    merged.staticGlassGone1 = true
  }

  /* ── 第八版迁移：助手气泡的玻璃拆成独立开关 ────────────────────────
     原来「气泡」一个开关同时管我发的和 Hermes 发的。现在按地方分开，
     老用户的行为保持不变：把原开关的值复制给助手那套。 */
  if (merged.lgxABubbleSplit1 !== true) {
    merged.lgxABubbleOn = merged.lgxBubbleOn === true
    merged.lgxABubbleRadius = merged.lgxBubbleRadius
    merged.lgxABubbleSplit1 = true
  }

  /* ── 第九版迁移：气泡的静态玻璃也删掉（上一轮漏了它）─────────────
     用户要求只保留玻璃（折射那套）。上一轮删了会话行 / 助手气泡 / 弹窗的静态玻璃，
     唯独漏了「我发的气泡」—— 它的 8 行设置还挂在设置页顶层（没归类、排在最后），
     CSS 也还在生效。这里把开关关掉；设置行与样式都已删除。 */
  if (merged.staticGlassGone2 !== true) {
    merged.glassOn = false
    merged.staticGlassGone2 = true
  }

  /* ── 第十二版迁移：模型列表弹窗里不再放「思考 / 推理强度」──────────────
     用户要求：模型列表（含每行悬停弹出的子菜单）里那一块整块去掉 ——
     应用的「思考」行和插件加的「推理强度」面板都不要，只保留输入框那个
     推理强度弹窗里的。想再用「放进模型列表」那个开关的话，设置页里可以打开。 */
  if (merged.modelListClean1 !== true) {
    merged.menuEffortOn = false
    merged.modelListClean1 = true
  }

  /* ── 第十一版迁移：弹窗与右键菜单的玻璃改成「跟随输入框」─────────────
     用户要求：模型名弹窗、推理强度弹窗、鼠标右键菜单都跟输入框用同一套玻璃。
     老存档里 lgxPopOn 是布尔 false（当年怀疑它导致卡死而默认关掉的）；
     卡死的真因后来查明并修好了 —— 是推理强度那套代码搬动 React 管的节点，
     观察器一遇 DOM 变动就自激成死循环，打开弹窗正好会触发。所以这里跟回来。 */
  if (!merged.lgxPerPlace1) {
    /* 玻璃配方从「一份共用」改成「每个地方一份」：把老的五个共用值复制到其它地方。
       ⚠️ 必须读 raw —— 合并后的对象里新键已被 DEFAULTS 填上，判断不出用户设过没有。
       「输入框」那一套就是老键本身，不用动。 */
    for (const [prefix] of [['lgxSess'], ['lgxBubble'], ['lgxABubble'], ['lgxPop'], ['lgxMenu']]) {
      for (const name of ['Mode', 'Scale', 'Aberration', 'Blur', 'Saturate']) {
        if (raw[prefix + name] === undefined) merged[prefix + name] = raw['lgx' + name] !== undefined ? raw['lgx' + name] : merged['lgx' + name]
      }
    }

    merged.lgxPerPlace1 = true
  }

  if (!merged.unifyRadius1) {
    /* 「会话玻璃圆角」并入「会话圆角」（用户从没设过会话圆角时才搬过来，一次为准）；
       「列表下移」设置已删，改成按最大漂浮幅度自动算顶部净空。 */
    if (raw.sessRadius === undefined && raw.lgxSessRadius !== undefined) merged.sessRadius = merged.lgxSessRadius

    delete merged.lgxSessRadius
    delete merged.sessPush
    merged.unifyRadius1 = true
  }

  if (merged.popGlassFollow1 !== true) {
    merged.lgxPopOn = 'follow'
    merged.popGlassFollow1 = true

  /* 气泡居中（v280 新增）：老存档里没有这两个键时补上「开」——
     写进存档而不是只靠 DEFAULTS，是为了让设置页开关的显示和实际生效一致。
     ⚠️ 新键一旦写进存档，以后改 DEFAULTS 就管不到它了，所以这里必须是「补默认」
     而不是「强制开」：显式关过的用户不会被顶回去。 */
  if (!merged.bubbleAlign1) {
    /* 早先只有「气泡居中」这一个布尔开关：关掉 = 回到靠左那一侧（应用原本的位置）。
       现在换成三态，把老存档翻译过来，一次为准。
       ⚠️ 必须读**原始输入**（raw）而不是 merged —— merged 是「DEFAULTS + 存档」的合并，
       新键已经被 DEFAULTS 填成 'center' 了，用 merged.myBubbleAlign === undefined 判断
       永远不成立，迁移等于没写（实测踩到过）。 */
    if (raw.myBubbleAlign === undefined) merged.myBubbleAlign = raw.centerMyBubble === false ? 'left' : 'center'
    if (raw.aBubbleAlign === undefined) merged.aBubbleAlign = raw.centerABubble === false ? 'left' : 'center'

    delete merged.centerMyBubble
    delete merged.centerABubble
    merged.bubbleAlign1 = true
  }

  /* 去掉「微信样式」（用户要求）：老存档里选了 it 的改回默认。
     ⚠️ 读 raw 不读 merged —— 同 bubbleAlign1 那条的坑。 */
  if (!merged.wechatStyleGone1) {
    if (raw.bubbleStyle === 'wechat' && merged.bubbleStyle === 'wechat') merged.bubbleStyle = 'default'
    delete merged.bubbleStyle
    merged.wechatStyleGone1 = true
  }
  }

  /* ── 第十版迁移：删掉「去掉顶部会话标签栏」这个功能 ──────────────────
     应用自己就有「切换标签」（view.toggleTabStrip，⌘K / 右键标签栏 / 快捷键），
     插件再做一个是重复的。这里把老存档里那个键清掉，标签栏交回应用管。 */
  if (merged.dropPageTabsFeature1 !== true) {
    delete merged.hidePageTabs
    merged.dropPageTabsFeature1 = true
  }

  /* ── 第三版迁移：默认位置右移，避开左上角「终端」标签 ──────────────── */
  if (merged.ropeV4 !== true) {
    const left = Number(merged.ropeLeft)

    if (!Number.isFinite(left) || left < 150) merged.ropeLeft = DEFAULTS.ropeLeft

    merged.ropeV4 = true
  }

  /* 音乐不限数量（整张专辑 / 整个文件夹都行），只过滤掉没有路径的脏数据 */
  merged.musicTracks = Array.isArray(merged.musicTracks)
    ? merged.musicTracks.filter(track => track && typeof track.path === 'string' && track.path)
    : []
  merged.clips = asClips(merged.clips, merged.path, merged.mode)
  merged.startupClips = asClips(merged.startupClips, merged.startupPath, merged.startupMode)
  merged.rotation = merged.rotation === 'random' ? 'random' : 'sequence'
  merged.startupRotation = merged.startupRotation === 'random' ? 'random' : 'sequence'

  return merged
}

function clipList(clips, current, target) {
  if (!clips.length) {
    return jsx('div', {
      className: 'mt-2 text-xs text-(--ui-text-tertiary)',
      children: `还没有文件（最多 ${MAX_CLIPS} 条）`
    })
  }

  return jsxs('div', {
    className: 'mt-2 flex flex-col gap-1',
    children: orderedClips(clips).map(({ clip, index }) =>
      jsxs(
        'div',
        {
          className: 'flex items-center gap-2 text-xs',
          children: [
            jsx('span', { className: 'shrink-0 text-(--ui-text-tertiary)', children: '序号' }),
            jsx('input', {
              className:
                'w-11 shrink-0 rounded border border-(--ui-stroke-secondary) bg-transparent px-1 py-0.5 text-center',
              defaultValue: Number(clip.order) || index + 1,
              max: 99,
              min: 1,
              onChange: event => setClipOrder(target, index, event.target.value),
              type: 'number'
            }),
            jsx('span', {
              className: 'min-w-0 flex-1 truncate text-(--ui-text-tertiary)',
              children: `${fileNameOf(clip.path)}${clip.kind === 'image' ? '（图片）' : ''}${clip.path === current ? '   ← 当前' : ''}`
            }),
            jsx(Button, {
              onClick: () => removeClip(target, index),
              variant: 'textStrong',
              children: '删除'
            })
          ]
        },
        `${clip.path}-${index}`
      )
    )
  })
}

const ROTATE_FLAG = 'hermes-bg-rotated-v1'

/** 启动时按轮播方式给背景、开机动画各换一条。两重保险，避免「用着用着背景自己变了」：
      1) 只在主窗口做（宠物浮层 / 快捷输入那种小窗没有应用外壳）；
      2) 每个窗口会话只做一次：sessionStorage 打标，页面刷新（插件被重新加载、
         按了 Ctrl+R、打开设置页触发 reconcile）都不会再换，只有真正重开 Hermes
         （新会话、sessionStorage 是空的）才会换。
    注：背景视频本身是 loop 的，不存在「播完就换」。 */
function rotateOncePerLaunch() {
  if (!document.querySelector('[data-contrib-shell]')) return false

  try {
    if (sessionStorage.getItem(ROTATE_FLAG)) return false

    sessionStorage.setItem(ROTATE_FLAG, '1')
  } catch {
    /* sessionStorage 不可用：退化成每次加载都换一次 */
  }

  rotateClip('bg')
  rotateClip('startup')

  return true
}

/** 每条启动动画各自的音效。
    取值顺序：这条动画自己设过的 → 全局默认（老设置里只有一份音效，
    这样老用户升级后行为不变）；都没设过就静音。 */
function clipAudio(s, clip) {
  const own = clip && (clip.sound === 'video' || clip.sound === 'custom' || clip.sound === 'mute')
  const mode = own
    ? clip.sound
    : s.startupAudio === 'video'
      ? 'video'
      : s.startupAudio === 'custom'
        ? 'custom'
        : 'mute'
  const ownPath = own && clip.sound === 'custom' ? String(clip.audioPath || '') : ''
  const path = mode === 'custom' ? ownPath || String(s.startupAudioPath || '') : ''
  const raw = own ? clip.volume : s.startupVolume
  const volume = Math.max(0, Math.min(100, Number(raw == null ? s.startupVolume : raw) || 0))

  return { mode, path, volume }
}

/** 当前会播的那条启动动画 */
function currentStartupClip(s) {
  const list = (s.startupClips || []).filter(clip => clip && clip.path)

  return list.find(clip => clip.path === s.startupPath) || list[0] || null
}

/** 改某一条启动动画的音效字段（sound / audioPath / volume） */
function setClipAudio(index, patch) {
  const list = ($settings.get().startupClips || []).map((clip, i) =>
    i === index ? { ...clip, ...patch } : clip
  )

  update({ startupClips: list })
}

function pickClipAudio(index) {
  const input = document.createElement('input')

  input.type = 'file'
  input.accept = 'audio/*'
  input.onchange = () => {
    const file = input.files && input.files[0]
    const path = file ? window.hermesDesktop?.getPathForFile?.(file) : ''

    if (!path) {
      host.notify({ kind: 'warn', message: '拿不到这个文件的路径，换个文件再试。' })

      return
    }

    setClipAudio(index, { sound: 'custom', audioPath: path })
  }

  input.click()
}

/** 启动动画列表：每条下面带自己的音效设置 */
function startupClipRows(s) {
  const clips = s.startupClips || []

  if (!clips.length) {
    return jsx('div', {
      className: 'mt-2 text-xs text-(--ui-text-tertiary)',
      children: `还没有文件（最多 ${MAX_CLIPS} 条）`
    })
  }

  return jsxs('div', {
    className: 'mt-2 flex flex-col gap-2',
    children: orderedClips(clips).map(({ clip, index }) => {
      const audio = clipAudio(s, clip)
      const isImage = clip.kind === 'image'
      const options = isImage
        ? [
            { id: 'custom', label: '自定义音效' },
            { id: 'mute', label: '静音' }
          ]
        : [
            { id: 'video', label: '视频原声' },
            { id: 'custom', label: '自定义音效' },
            { id: 'mute', label: '静音' }
          ]
      const currentMode = isImage && audio.mode === 'video' ? 'mute' : audio.mode

      return jsxs(
        'div',
        {
          className: 'rounded-md border border-(--ui-stroke-secondary) p-2',
          children: [
            jsxs('div', {
              className: 'flex items-center gap-2 text-xs',
              children: [
                jsx('span', { className: 'shrink-0 text-(--ui-text-tertiary)', children: '序号' }),
                jsx('input', {
                  className:
                    'w-11 shrink-0 rounded border border-(--ui-stroke-secondary) bg-transparent px-1 py-0.5 text-center',
                  defaultValue: Number(clip.order) || index + 1,
                  max: 99,
                  min: 1,
                  onChange: event => setClipOrder('startup', index, event.target.value),
                  type: 'number'
                }),
                jsx('span', {
                  className: 'min-w-0 flex-1 truncate text-(--ui-text-tertiary)',
                  children: `${fileNameOf(clip.path)}${isImage ? '（图片）' : ''}${clip.path === s.startupPath ? '   ← 当前' : ''}`
                }),
                jsx(Button, {
                  onClick: () => removeClip('startup', index),
                  variant: 'textStrong',
                  children: '删除'
                })
              ]
            }),
            jsxs('div', {
              className: 'mt-2 flex flex-wrap items-center gap-2 text-xs',
              children: [
                jsx('span', { className: 'shrink-0 text-(--ui-text-tertiary)', children: '音效' }),
                jsx(SegmentedControl, {
                  onChange: id => setClipAudio(index, { sound: id }),
                  options,
                  value: currentMode
                })
              ]
            }),
            currentMode === 'custom'
              ? jsxs('div', {
                  className: 'mt-2 flex flex-wrap items-center gap-2 text-xs',
                  children: [
                    jsx(Button, {
                      onClick: () => pickClipAudio(index),
                      variant: 'default',
                      children: '选择音效…'
                    }),
                    jsx('span', {
                      className: 'min-w-0 flex-1 truncate text-(--ui-text-tertiary)',
                      children: audio.path ? fileNameOf(audio.path) : '⚠️ 还没选音效文件'
                    }),
                    audio.path
                      ? jsx(Button, {
                          onClick: () => setClipAudio(index, { audioPath: '' }),
                          variant: 'textStrong',
                          children: '清除'
                        })
                      : null
                  ]
                })
              : null,
            jsxs('div', {
              className: 'mt-2 flex items-center gap-2 text-xs',
              children: [
                jsx('span', { className: 'shrink-0 text-(--ui-text-tertiary)', children: '音量' }),
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 100,
                  min: 0,
                  onChange: event => setClipAudio(index, { volume: Number(event.target.value) }),
                  step: 5,
                  type: 'range',
                  value: audio.volume
                }),
                jsx('span', {
                  className: 'w-10 shrink-0 text-right text-(--ui-text-tertiary)',
                  children: `${audio.volume}%`
                })
              ]
            })
          ]
        },
        `${clip.path}-${index}`
      )
    })
  })
}

function adoptStartupFile(file) {
  addDroppedFiles([file], 'startup')
}

/* 首页自己那张背景：选文件（和主背景一样，用 getPathForFile 拿绝对路径） */
function pickHomeFile() {
  const input = document.createElement('input')

  input.type = 'file'
  input.accept = 'video/*,image/*'
  input.onchange = () => {
    const file = input.files && input.files[0]

    if (!file) return

    const path = window.hermesDesktop?.getPathForFile?.(file) || ''

    if (!path) {
      host.notify({ kind: 'warn', message: '拿不到这个文件的路径，换个文件再试。' })

      return
    }

    const kind = /\.(mp4|webm|mov|mkv|m4v|avi|ogv)$/i.test(path) ? 'video' : 'image'

    update({ homeBgKind: kind, homeBgMode: 'own', homeBgPath: path })
  }

  input.click()
}

function pickStartupFile() {
  const input = document.createElement('input')

  input.type = 'file'
  input.accept = 'video/*,image/*'
  input.onchange = () => {
    const file = input.files && input.files[0]

    if (file) adoptStartupFile(file)
  }

  input.click()
}

function adoptStartupAudio(file) {
  const path = window.hermesDesktop?.getPathForFile?.(file) || ''

  if (!path) {
    host.notify({ kind: 'warn', message: '拿不到这个文件的路径，换个文件再试。' })

    return
  }

  update({ startupAudio: 'custom', startupAudioPath: path })
}

function pickStartupAudio() {
  const input = document.createElement('input')

  input.type = 'file'
  input.accept = 'audio/*'
  input.onchange = () => {
    const file = input.files && input.files[0]

    if (file) adoptStartupAudio(file)
  }

  input.click()
}

function adoptFile(file) {
  addDroppedFiles([file], 'bg')
}

function pickBackgroundFile(expected) {
  const input = document.createElement('input')

  input.type = 'file'
  input.accept = expected === 'image' ? 'image/*' : expected === 'video' ? 'video/*' : 'video/*,image/*'
  input.onchange = () => {
    const file = input.files && input.files[0]

    if (file) {
      adoptFile(file)
    }
  }

  input.click()
}

/* ── 自检：把「为什么不生效」直接打印出来 ───────────────────────── */
const $report = atom('')

const alphaOf = color => {
  const m = /rgba?\(([^)]+)\)/.exec(String(color))

  if (!m) return 0

  const parts = m[1].split(',').map(part => parseFloat(part))

  return parts.length === 4 ? parts[3] : 1
}

function runSelfCheck() {
  const lines = []

  try {
    lines.push(`个性化设置 自检  ${new Date().toLocaleTimeString()}  [${EFFORT_BUILD}]`)
    /* 设置弹窗左列「插件」那一组的状态（报「打开设置没有个性化」时要的就是这几行） */
    try {
      const rail = document.querySelector("[data-tour='overlay-nav']")

      if (!rail) {
        lines.push('设置弹窗：没打开（打开设置再看这一行）')
      } else {
        const tg = rail.querySelector("[data-tour='nav-toggle-plugins']")
        const entry = Array.from(rail.querySelectorAll('span')).find(el => (el.textContent || '').trim() === '个性化设置' && el.children.length === 0)

        lines.push(`插件组折叠开关：${tg ? (tg.getAttribute('aria-expanded') === 'true' ? '已展开' : '折叠着') : '没找到'}`)
        lines.push(`「个性化设置」入口：${entry ? (entry.offsetParent !== null ? '可见' : '隐藏') : '没找到'}`)
        lines.push(`自动展开记录：${(window.__hsNavLog || []).slice(-5).map(x => x.k).join(' → ') || '无'}`)
      }
    } catch {
      lines.push('导航诊断读不到')
    }

    /* 会话栏拖宽细线：在不在、在哪（用户报「只有原来的滚动条」时看这行） */
    try {
      const dragEl = document.getElementById(SESS_DRAG_ID)
      const wrap = document.querySelector("[data-slot='sidebar-wrapper']")

      lines.push(`会话栏拖宽：细线=${dragEl ? '在' : '不在'} · 位置=${dragEl ? dragEl.style.left : '-'} · 侧栏右缘=${wrap ? Math.round(wrap.getBoundingClientRect().right) + 'px' : '没找到侧栏'} · 开关=${$settings.get().sessDragOn === false ? '关' : '开'}`)
    } catch {
      lines.push('会话栏拖宽诊断读不到')
    }

    /* 输入框内部各层：报「缝隙还在」时看这一行 */
    try {
      const layers = window.__hsCompLayers || []

      lines.push(`输入框内层（共 ${layers.length} 个有底的层）：`)
      lines.push(layers.length ? '  ' + layers.join('\n  ') : '  没有找到有底的层')
    } catch {
      lines.push('输入框内层读不到')
    }

    /* 首页状态：为什么没弹（「本次已显示过」的闸门最容易让人以为坏了） */
    try {
      const wst = welcomeStore('get') || {}
      const s0 = $settings.get()

      lines.push(`首页：开关=${s0.welcomeOn === false ? '关' : '开'} · 图层=${document.getElementById(WELCOME_ID) ? '在' : '不在'} · 已显示过=${wst.seen ? '是' : '否'} · 距上次=${wst.at ? Math.round((Date.now() - wst.at) / 1000) + 's' : '无'} · 可列会话=${welcomeSessions(Math.max(3, Math.min(12, Number(s0.welcomeCount) || 8))).length}`)
    } catch {
      lines.push('首页诊断读不到')
    }

    lines.push(`1) getPathForFile: ${typeof window.hermesDesktop?.getPathForFile === 'function' ? '有' : '没有'}`)
    lines.push(`2) 设置: ${JSON.stringify($settings.get())}`)

    const styleEl = document.getElementById(STYLE_ID)
    const headIndex = styleEl ? [...document.head.children].indexOf(styleEl) + 1 : 0

    lines.push(
      `3) 样式表: ${styleEl ? `在，${styleEl.textContent.length} 字符，head 第 ${headIndex}/${document.head.children.length} 个` : '不在'}`
    )

    const layer = document.getElementById(LAYER_ID)
    const layerStyle = layer ? getComputedStyle(layer) : null

    lines.push(
      `4) 背景层: ${layer ? `在 pos=${layerStyle.position} z=${layerStyle.zIndex} 尺寸=${Math.round(layer.getBoundingClientRect().width)}×${Math.round(layer.getBoundingClientRect().height)}` : '不在'}`
    )

    const media = layer && layer.firstElementChild

    if (media) {
      lines.push(
        `   媒体: ${media.tagName} readyState=${media.readyState ?? '-'} 尺寸=${media.videoWidth || media.naturalWidth || 0}×${media.videoHeight || media.naturalHeight || 0} err=${media.error ? media.error.message || media.error.code : '无'}`
      )
      lines.push(`   src: ${String(media.src).slice(0, 140)}`)
    }

    /* 启动画面选择器自测：造两个同类元素试试能不能命中（不碰真界面）
       ① 应用那屏的类：fixed + inset-0 + data-glass-opaque → 必须命中
       ② 侧栏被拖动的行也带 data-glass-opaque，但不是 fixed/inset-0 → 必须不命中 */
    let hidesBootScreen = false
    let sparesDraggedRow = false

    try {
      const likeBoot = document.createElement('div')

      likeBoot.setAttribute('data-glass-opaque', '')
      likeBoot.className = 'fixed inset-0 z-(--z-connecting) grid place-items-center'
      hidesBootScreen = likeBoot.matches("[data-glass-opaque][class*='fixed'][class*='inset-0']")

      const likeRow = document.createElement('div')

      likeRow.setAttribute('data-glass-opaque', '')
      likeRow.className = 'grid h-8 items-center gap-2'
      sparesDraggedRow = !likeRow.matches("[data-glass-opaque][class*='fixed'][class*='inset-0']")
    } catch {
      /* 自测失败就不下结论 */
    }

    const paints = typeof performance.getEntriesByType === 'function' ? performance.getEntriesByType('paint') : []
    const firstPaint = paints.length ? Math.round(paints[0].startTime) : null
    const importAt = typeof window.__hermesBgPluginImportAt === 'number' ? Math.round(window.__hermesBgPluginImportAt) : null

    /* 思考方块：直接读那两个槽位里方块的**计算样式** —— 一眼看出 CSS 有没有落到它身上 */
    const flowNodes = document.querySelectorAll(THINK_SQ)
    const flowBg = flowNodes.length ? getComputedStyle(flowNodes[0]).backgroundImage : '-'
    const flowAnim = flowNodes.length ? getComputedStyle(flowNodes[0]).animationDuration : '-'

    lines.push(
      `15) 计时进度条: 开关=${s.timerBarOn === true ? '进度条' : '秒数'} | 满格=${s.timerBarMax} 秒 | 命中=${document.querySelectorAll('.hs-timer-bar').length} 个 | 当前宽度=${
        document.querySelector('.hs-timer-bar') ? document.querySelector('.hs-timer-bar').style.getPropertyValue('--hs-timer-pct') || '(未设置)' : '-'
      }`
    )
    lines.push(
      `0) 运行错误: ${applyErrors.length ? applyErrors.join(' / ') : '无'}`
    )
    lines.push(
      `14) 液态玻璃: 输入框=${s.lgxOn === true ? '开' : '关'} 会话行=${s.lgxSessOn === true ? '开' : '关'} 气泡=${s.lgxBubbleOn === true ? '开' : '关'} | 模式=${s.lgxMode || 'standard'} | 滤镜svg=${
        '已移除'
      } | 命中=${document.querySelectorAll(LGX_TARGET).length}/${document.querySelectorAll(LGX_SESS).length}/${
        document.querySelectorAll(LGX_BUBBLE).length
      } 个 | 计算滤镜=${document.querySelector(LGX_TARGET) ? getComputedStyle(document.querySelector(LGX_TARGET), '::before').filter : '-'}`
    )
    lines.push(
      `13) 思考方块: 开关=${s.flowOn === true ? '彩色流光' : '原生'} | 命中方块=${flowNodes.length} 个 | 计算背景=${String(
        flowBg
      ).slice(0, 46)} | 动画时长=${flowAnim} | 样式表=${document.getElementById('hermes-bg-style') ? '在' : '不在'}`
    )
    lines.push(
      `12) 桌宠: 开关=${s.petOn === true ? '开' : '关'} | 包=${petPackOf(s)?.id || '无'} | 动画=${
        (petPackOf(s)?.clips || []).length
      } 段 | 层=${petLayer() ? '在' : '不在'} | 正在播=${petState.clip || '无'} | 钩子=${
        [
          ['工作联动', s.petWorkSync !== false],
          ['连击', s.petStreak !== false],
          ['悬停', s.petHover !== false],
          ['闲置', s.petIdle !== false],
          ['落地', s.petLandingClip !== false]
        ]
          .filter(pair => pair[1])
          .map(pair => pair[0])
          .join('/') || '全关'
      } | 心跳=${petHookTimer ? '在' : '不在'} | AI 忙=${petHookState().busy ? '是' : '否'}`
    )
    lines.push(
      `9) 启动画面规则: 能命中应用那屏=${hidesBootScreen ? '是' : '否'} | 不误伤侧栏拖动行=${sparesDraggedRow ? '是' : '否'}`
    )
    lines.push(
      `10) 加载时序: 浏览器首帧=${firstPaint === null ? '未知' : `${firstPaint}ms`} | 插件加载=${importAt === null ? '未知' : `${importAt}ms`} | ${
        firstPaint !== null && importAt !== null
          ? importAt <= firstPaint
            ? '插件比首帧早（规则本该来得及生效 → 若仍看到启动画面，是别的原因）'
            : `插件比首帧晚 ${importAt - firstPaint}ms（这一段时间看不清，另外浮层在晚了 ${importAt - firstPaint}ms 才铺上）`
          : '无法比较'
      }`
    )

    const bootInput = document.querySelector("[data-slot='composer-rich-input']")

    lines.push(
      `11) 就绪判定: 可跳过=${appReadyForSkip() ? '是' : '否'} | 外壳=${document.querySelector('[data-contrib-shell]') ? '在' : '不在'} | 输入框=${
        bootInput
          ? bootInput.getAttribute('aria-disabled') === 'true' || bootInput.getAttribute('contenteditable') === 'false'
            ? '仍禁用（还在加载）'
            : '已可用（加载完成）'
          : '还没有'
      }`
    )

    const musicBtn = document.querySelector('[data-hs-music=\'1\']')
    const musicState = $settings.get()

    lines.push(
      `8) 音乐符号: ${musicBtn ? '在标题栏上' : '不在'} | 音乐开关=${musicState.musicOn ? '开' : '关'} | 曲目=${(musicState.musicTracks || []).length} 首 | 正在播=${$music.get().playing ? '是' : '否'}`
    )

    const scrimAfter = layer ? getComputedStyle(layer, '::after') : null

    lines.push(
      `   遮罩层(媒体层 ::after): ${
        scrimAfter && scrimAfter.content !== 'none'
          ? `在 bg=${scrimAfter.backgroundColor}`
          : '不在（遮罩浓度为 0，或样式表没生效）'
      }`
    )

    const rootCss = getComputedStyle(document.documentElement)
    const bodyCss = getComputedStyle(document.body)

    lines.push(
      `5) --theme-foreground = ${rootCss.getPropertyValue('--theme-foreground').trim()} | --ui-text-primary = ${rootCss.getPropertyValue('--ui-text-primary').trim()}`
    )
    lines.push(`6) body 背景 = ${bodyCss.backgroundColor} / ${bodyCss.backgroundImage.slice(0, 70)}`)
    lines.push(`7) 视口 ${innerWidth}×${innerHeight}；盖住视口且不透明的元素：`)

    const offenders = []

    for (const el of document.body.querySelectorAll('*')) {
      const rect = el.getBoundingClientRect()

      if (rect.width * rect.height < innerWidth * innerHeight * 0.8) continue

      const cs = getComputedStyle(el)
      const alpha = alphaOf(cs.backgroundColor)
      const hasImage = cs.backgroundImage !== 'none'

      if (alpha < 0.05 && !hasImage) continue

      const cls =
        typeof el.className === 'string' && el.className
          ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
          : ''

      offenders.push(
        `   - ${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls} | bg=${cs.backgroundColor}${hasImage ? ' +图' : ''} | pos=${cs.position} z=${cs.zIndex} | ${Math.round(rect.width)}×${Math.round(rect.height)}`
      )

      if (offenders.length >= 8) break
    }

    lines.push(...(offenders.length ? offenders : ['   （没有，说明背景层不是被挡住的）']))

    /* 9) 开场动画的实际参数（点过「预览播放」后这项最有参考价值） */
    lines.push(
      `9) 开机动画: ${lastStartupPlan ? JSON.stringify(lastStartupPlan) : '本次启动还没播过'}`
    )

    const live = document.getElementById(STARTUP_ID)

    if (live) {
      const liveStyle = getComputedStyle(live)

      lines.push(
        `   正在播: opacity=${liveStyle.opacity} animation=${liveStyle.animationName} ${liveStyle.animationDuration} transform=${liveStyle.transform}`
      )
    }

    /* 8) 本地媒体通道到底能不能取到这个文件（取得到才谈得上显示） */
    const probePath = $settings.get().path

    if (probePath) {
      const url = sourceUrl($settings.get())

      lines.push(`8) 媒体通道: ${url.slice(0, 100)}`)

      fetch(url, { method: 'HEAD' })
        .then(response => lines.push(`   → HTTP ${response.status} ${response.statusText}`))
        .catch(error => lines.push(`   → 取不到：${error && error.message}`))
        .finally(() => $report.set(lines.join('\n')))
    }
  } catch (error) {
    lines.push(`自检抛错: ${error && error.message}`)
  }

  $report.set(lines.join('\n'))
  haptic('tap')
}

function SelfCheck() {
  const report = useValue($report)
  /* 默认收起：平时不占地方，出问题再展开 */
  const [open, setOpen] = useState(false)

  useEffect(() => {
    runSelfCheck()
  }, [])

  return jsx(ListRow, {
    action: jsxs('div', {
      className: 'flex flex-wrap items-center gap-2',
      children: [
        jsx(Button, {
          onClick: () => setOpen(value => !value),
          children: jsxs('span', {
            className: 'inline-flex items-center gap-1',
            children: [
              jsx(Codicon, { name: open ? 'chevron-down' : 'chevron-right', size: '0.75rem' }),
              open ? '收起结果' : '展开结果'
            ]
          })
        }),
        jsx(Button, { onClick: runSelfCheck, children: '重新自检' }),
        jsx(Button, {
          onClick: () => {
            try {
              ctxRef?.os?.writeClipboard?.($report.get())
              host.notify({ kind: 'info', message: '自检结果已复制，直接粘贴给 Hermes。' })
            } catch {
              host.notify({ kind: 'warn', message: '复制失败，手动截图也行。' })
            }
          },
          variant: 'textStrong',
          children: '复制结果'
        })
      ]
    }),
    below: open
      ? jsx('pre', {
          className:
            'mt-2 max-h-64 overflow-auto rounded-md border border-(--ui-stroke-secondary) p-2 text-[0.68rem] leading-snug text-(--ui-text-tertiary) whitespace-pre-wrap',
          children: report || '检查中…'
        })
      : null,
    description: open ? '点「收起结果」可以折起来。' : '出问题时展开结果复制给我。',
    title: '自检'
  })
}

/** 通用开关行（模块级）—— 供各分节使用。
    注意：不要在各分节里另写局部同名函数，跨节复用会踩作用域坑（曾导致设置页 ReferenceError）。 */
function swRow(s, update, key, title, description, offLabel, onLabel) {
  return jsx(ListRow, {
    action: jsx(SegmentedControl, {
      /* ⚠️ 护栏：分段控件挂载时可能拿当前值回调一次 onChange —— 对**默认开**的开关，
           那一下会把 true 写成 false（「一打开设置页，锁定布局自己关了、功能像不存在」，
           用户报了两轮）。回调值与当前值相同 → 忽略、不写盘；用户真点击必然不同，照旧生效。 */
      onChange: id => {
        const cur = s[key] === true ? 'on' : 'off'

        if (id === cur) return

        update({ [key]: id === 'on' })
      },
      options: [
        { id: 'off', label: offLabel || '关' },
        { id: 'on', label: onLabel || '开' }
      ],
      value: s[key] === true ? 'on' : 'off'
    }),
    description,
    title
  })
}

/** 可折叠板块：标题行永远可见，内容默认收起 */
function Section({ children, depth = 0, first, hint, icon, title }) {
  const [open, setOpen] = useState(false)

  /* depth：0 = 顶层大类（现在的样子）；≥1 = 二级/更深。
     二级必须**往里缩**、并且带一条竖线 —— 否则和大类齐头，用户打开也分不清那些行属于哪个大类
     （用户原话：「二级分类不要和一大类齐头，往右靠一点，每层要有层次」）。
     ⚠️ 缩进 / 竖线 / 字号一律用**内联 style**：插件源码不在应用的 Tailwind 扫描范围里，
     随便加 Tailwind 类有生成不出来的风险，内联样式一定生效。 */
  const nest = Math.max(0, depth || 0)
  const indent = nest * 18

  const wrapStyle = nest > 0
    ? {
        borderLeft: `${Math.max(2, 4 - nest)}px solid var(--ui-stroke-secondary)`,
        marginTop: nest === 1 ? '0.5rem' : '0.375rem',
        marginLeft: `${Math.max(0, indent - 14)}px`,
        paddingLeft: `${indent - (indent - 14) - 2}px`
      }
    : null

  return jsxs('div', {
    /* 标记：插件的设置页在哪里渲染，祖先链里就有它。
       用途：运行时定位「设置面板」（closest('[data-glass-raised]')）。 */
    'data-hs-settings-page': '1',
    'data-hs-depth': String(nest),
    className: nest > 0 ? '' : first ? 'pt-2' : 'mt-8 border-t-2 border-(--ui-stroke-secondary) pt-4',
    style: wrapStyle || undefined,
    children: [
      jsx('button', {
        className:
          'flex w-full items-center gap-2 pb-1 text-left transition-colors hover:text-foreground',
        onClick: () => {
          haptic('tap')
          setOpen(value => !value)
        },
        type: 'button',
        children: [
          jsx(Codicon, { name: open ? 'chevron-down' : 'chevron-right', size: nest > 0 ? '0.7rem' : '0.875rem' }),
          jsx(Codicon, { name: icon, size: nest > 0 ? '0.75rem' : '0.875rem' }),
          jsx('div', {
            className: nest > 0 ? 'flex-1' : 'flex-1 text-sm font-semibold',
            style: nest > 0 ? { fontSize: '0.8125rem', fontWeight: 500 } : undefined,
            children: title
          }),
          jsx('span', {
            className: 'text-[0.68rem] text-(--ui-text-tertiary)',
            style: nest > 0 ? { fontSize: '0.62rem' } : undefined,
            children: open ? '收起' : '展开'
          })
        ]
      }),
      hint
        ? jsx('div', {
            className: 'pb-1 text-xs text-(--ui-text-tertiary)',
            style: nest > 0 ? { fontSize: '0.68rem', lineHeight: 1.45 } : undefined,
            children: hint
          })
        : null,
      open
        ? jsx('div', { className: 'flex flex-col gap-1', style: { paddingTop: '0.125rem' }, children })
        : null
    ]
  })
}

/** 标题栏上的音乐符号（设置齿轮那一片）：播放时转圈，点一下播放 / 暂停。
    没开音乐、或一首曲子都没有时不占位置。 */
function MusicButton() {
  const music = useValue($music)
  const s = useValue($settings)

  /* 只要开着「音乐播放」就显示符号（哪怕还没导入曲目 —— 那时它半透明，
     点一下直接跳去设置页，别让用户以为是坏了） */
  if (!s.musicOn) return null

  const hasTracks = (s.musicTracks || []).length > 0
  const muted = s.musicMutedOn === true
  const playing = hasTracks && music.playing
  /* 用户要求：点这个符号是「静音 / 取消静音」，**不是**打开个性化设置。
     去设置挪到右键（顺带解决「没曲目时怎么导入」的入口）。 */
  const label = muted ? '取消静音' : `静音${hasTracks ? '' : '（还没有导入音乐，右键去设置）'}`

  return jsx('button', {
    'aria-label': label,
    className: `grid size-6 shrink-0 place-items-center rounded text-muted-foreground/85 transition-colors hover:bg-(--ui-control-hover-background) hover:text-foreground${
      hasTracks ? '' : ' opacity-55'
    }`,
    'data-hs-music': '1',
    onClick: () => {
      haptic('tap')
      toggleMusicMute()
    },
    onContextMenu: event => {
      /* 右键 = 去音乐设置（保留导入入口，又不干扰左键的静音切换） */
      event.preventDefault()
      haptic('tap')

      try {
        host.navigate(pluginSettingsHref(ID))
      } catch {}
    },
    title: label,
    type: 'button',
    children: jsx(Codicon, {
      name: muted ? 'mute' : 'music',
      /* 播放且没静音时才转（Codicon 自带 spinning，不自己写 keyframes） */
      size: '0.875rem',
      spinning: playing && !muted
    })
  })
}

/** 设置页归类：按分组排序 + 给标题加「组名 · 」前缀。
    只重排/改标题，**不动任何设置行本身**；出任何问题就原样返回（不会把设置页弄坏）。 */
/* ── 设置页中英文切换 ────────────────────────────────────────────────
   做法：不在 275 个设置行里逐条写双语，而是在**最后一步**遍历整棵页面树，
   把 title / description / hint / label / note 以及纯字符串 children 过一遍字典。
   这样 462 条文案只维护一张表，加新设置也只需要补一行译文。 */
const I18N_EN = {
  "1 分钟": "1 minute",
  "1 小时": "1 hour",
  "15 分钟": "15 minutes",
  "5 分钟": "5 minutes",
  "Hermes 发的气泡": "Bubbles from Hermes",
  "Hermes 回复的气泡。": "Bubbles for Hermes replies.",
  "Hermes个性化插件QQ交流群：1047829560": "Hermes customization plugin QQ group: 1047829560",
  "Q 弹": "Bouncy",
  "一直开": "Always on",
  "一道很淡的高光在玻璃表面扫过 —— 「液态」的那点意思。": "A faint highlight sweeping across the glass — that \"liquid\" feel.",
  "一首放完之后怎么走。": "What happens when a track ends.",
  "上一支": "Previous",
  "上下漂浮的幅度。": "Float amplitude.",
  "上浮或侧滑的距离。": "Distance of the float or slide.",
  "上浮淡入": "Float in",
  "下一支": "Next",
  "下一段动画怎么挑。": "How the next animation is picked.",
  "下一首": "Next track",
  "不允许": "Not allowed",
  "不响应": "Ignore",
  "不套用": "Don't apply",
  "不弹": "No pop",
  "不显示": "Hidden",
  "不流光": "No sweep",
  "不用重启，立刻按现在的设置播一遍。": "No restart needed — replay with your current settings right now.",
  "不等下次启动，现在就把首页调出来。": "Bring up the home screen now instead of waiting for the next launch.",
  "不要": "No",
  "不透明度": "Opacity",
  "不铺": "Original size",
  "不限数量，可多选或导入文件夹。": "No limit — pick several or import a folder.",
  "不静音": "Not muted",
  "个性化设置": "Customization",
  "中间那句问候。": "The greeting in the middle.",
  "主题色": "Theme color",
  "也流光": "Sweep too",
  "互动": "Interaction",
  "交互": "Interactive",
  "交互范围": "Interaction area",
  "从输入框飞入": "Fly in from the input box",
  "代码块、路径、日志用的字体。": "Font for code blocks, paths and logs.",
  "会话列宽度": "Session column width",
  "会话列表左右的内边距。": "Left and right padding of the session list.",
  "会话卡片的内外发光。": "Inner and outer glow on session cards.",
  "会话卡片的圆角。": "Corner radius of session cards.",
  "会话卡片的浮起与漂浮。": "Lift and float of session cards.",
  "会话悬浮": "Session hover",
  "会话行高亮": "Session row highlight",
  "会话设置": "Session settings",
  "位置": "Position",
  "余额": "Balance",
  "使用中隔多久换一条。": "How often to switch while in use.",
  "侧滑淡入": "Slide in",
  "保存、导入导出整套配置。": "Save and import/export whole configs.",
  "保存当前配置": "Save current config",
  "保存当前配置…": "Save current config…",
  "倾斜角度": "Tilt angle",
  "允许": "Allowed",
  "允许在加载完成前跳过动画。": "Allow skipping the animation before loading finishes.",
  "光带厚度": "Band thickness",
  "光带沿卡片边框转圈。": "A light band circling the card border.",
  "光带沿气泡边框转圈。": "A light band circling the bubble border.",
  "光往外扩散的半径。": "Radius the glow spreads outward.",
  "光效 · 磨砂": "Effects · Frosted",
  "光晕": "Glow",
  "光晕颜色": "Glow color",
  "光标大小": "Cursor size",
  "光标的大小。": "Cursor size.",
  "光沿边框转圈或固定不动。": "Glow circles the border or stays put.",
  "入场动画的时长。": "Duration of the entrance animation.",
  "全部": "All",
  "关闭": "Off",
  "内发光": "Inner glow",
  "内发光半径": "Inner glow radius",
  "内发光厚度": "Inner glow thickness",
  "内发光强度": "Inner glow intensity",
  "内发光的强度。": "Inner glow intensity.",
  "内发光的颜色。": "Inner glow color.",
  "内发光颜色": "Inner glow color",
  "出场效果": "Exit effect",
  "出场的效果方式。": "Exit effect style.",
  "出问题时给我看的结果。": "What I see when something goes wrong.",
  "列表左右内边距": "List side padding",
  "刚发出的那一条的入场动画。": "Entrance animation for the message you just sent.",
  "删除": "Delete",
  "刷新间隔": "Refresh interval",
  "加载完成前可跳过": "Skippable before loading",
  "动画分组": "Animation group",
  "动画幅度": "Animation amplitude",
  "动画文件": "Animation file",
  "动画时长": "Animation duration",
  "动画最多播多久。": "How long an animation can run at most.",
  "单曲循环": "Repeat one",
  "单独设置": "Custom",
  "单色流光": "Single-color sweep",
  "卡片倾斜角度，负数为左倒。": "Card tilt angle; negative tilts left.",
  "卡片内侧的一圈柔光。": "A soft ring of light inside the card.",
  "卡片外侧的一圈光。": "A ring of light outside the card.",
  "卡片宽度": "Card width",
  "卡片左右内缩，给光晕留余量。": "Inset the card sides to leave room for the glow.",
  "卡片投影的强度。": "Card shadow intensity.",
  "卡片的通透程度。": "How transparent the card is.",
  "原生蓝色方块": "Native blue square",
  "双击启动桌宠.bat 让它住到窗口外。": "Double-click 启动桌宠.bat to let it live outside the window.",
  "反光": "Sheen",
  "发光强弱。": "Glow strength.",
  "发光流动": "Flowing glow",
  "发光颜色": "Glow color",
  "发送动画": "Send animation",
  "只播某一类动画。": "Play just one kind of animation.",
  "只显示进度": "Progress only",
  "只能点": "Click only",
  "可交互": "Interactive",
  "可拖拽": "Draggable",
  "右上": "Top right",
  "右下": "Bottom right",
  "右键宠物弹出操作菜单。": "Right-click the pet for an action menu.",
  "右键菜单": "Context menu",
  "右键菜单的玻璃。": "Glass for the context menu.",
  "同步": "Sync",
  "启动时先看到这一页；外观也在这里调。": "Opens this page on launch; appearance is tuned here too.",
  "启动时换一条：顺序或随机。": "Switch on launch: sequential or random.",
  "图片": "Image",
  "圆角": "Corner radius",
  "在 platform.deepseek.com 申请；只存本机，不会写进配置包。": "Get one at platform.deepseek.com; stored on this machine only, never written into the config package.",
  "在窗口里养一只透明动画桌宠。": "Keep a transparent animated pet in the window.",
  "填充": "Fill",
  "复制结果": "Copy result",
  "外发光": "Outer glow",
  "外发光半径": "Outer glow radius",
  "外发光强度": "Outer glow intensity",
  "外发光流动": "Flowing outer glow",
  "外发光的强度。": "Outer glow intensity.",
  "外发光的颜色。": "Outer glow color.",
  "外发光颜色": "Outer glow color",
  "多久问一次余额。": "How often to check the balance.",
  "字号": "Font size",
  "字重": "Font weight",
  "实际读到的等级": "Level actually read",
  "宠物包": "Pet pack",
  "宠物包文件夹": "Pet pack folder",
  "宠物吃鼠标的范围。": "Range in which the pet catches the mouse.",
  "宠物待在窗口的哪个角。": "Which corner of the window the pet sits in.",
  "导入一个 .zip 配置包。": "Import a .zip config package.",
  "导入文件夹…": "Import folder…",
  "导入配置包": "Import config package",
  "导入配置包…": "Import config package…",
  "导出配置包": "Export config package",
  "导出配置包…": "Export config package…",
  "小把手": "Handle",
  "居中": "Center",
  "工作中卡片的光晕颜色。": "Glow color for cards that are working.",
  "工作中的卡片转一圈光带。": "A light band circles cards that are working.",
  "工作中的卡片额外抬高多少。": "Extra lift for cards that are working.",
  "工作会话流光": "Working session sweep",
  "工作会话额外抬升": "Extra lift for working sessions",
  "工作联动": "Sync with working state",
  "左上": "Top left",
  "左上角一根绳：下拉开设置，拖动换位。": "A cord at the top left: pull down for settings, drag to move.",
  "左下": "Bottom left",
  "左侧会话栏的宽度。": "Width of the session sidebar.",
  "左右内缩": "Horizontal inset",
  "左右各内缩多少。": "How far to inset each side.",
  "已发气泡轻轻浮起并上下漂。": "Sent bubbles lift slightly and drift up and down.",
  "序号": "Index",
  "开启": "On",
  "开启气泡": "Enable bubbles",
  "开机动画": "Startup animation",
  "开着就在使用中按间隔自动更换。": "When on, rotates automatically at the set interval while in use.",
  "弹出": "Pop out",
  "弹窗与菜单": "Dialogs & menus",
  "强度": "Intensity",
  "当前选中的那条会话要一眼看得出来。": "The active conversation should stand out at a glance.",
  "彩色流光": "Colorful shimmer",
  "彩虹": "Rainbow",
  "循环静音播放。": "Loop silently.",
  "思考方块": "Thinking block",
  "思考方块换成彩色流光。": "Replace the thinking block with a colorful shimmer.",
  "思考方块的彩色流光。": "The colorful shimmer of the thinking block.",
  "恢复默认": "Reset to default",
  "悬停也高亮": "Highlight on hover too",
  "悬停反应": "Hover response",
  "悬浮": "Hover",
  "悬浮时气泡的投影强度。": "Shadow strength of bubbles while hovering.",
  "想用列表里没有的字体，直接填字体名。": "Want a font that isn't in the list? Just type its name.",
  "我发出的消息气泡。": "My outgoing message bubbles.",
  "我发的气泡": "My bubbles",
  "我回复时自动切工作动画。": "Switch to the working animation automatically when I reply.",
  "手动切一段看看。": "Switch manually to preview a segment.",
  "手动切换": "Manual switch",
  "打开「个性化设置」": "Open Personalization settings",
  "打开文件夹": "Open folder",
  "把现在的全部设置存成一份新存档。": "Save all current settings as a new preset.",
  "把设置和正在用的素材存成 .zip。": "Save settings and the media in use as a .zip.",
  "折射模式": "Refraction mode",
  "折射的弯曲方式：标准 = 常规透镜；环形 = 偏中心的环形弯曲；醒目 = 弯曲更夸张。": "How the refraction bends: Standard = regular lens; Ring = off-center ring bend; Bold = exaggerated bend.",
  "抬升": "Lift",
  "拖拽": "Drag",
  "拖滑条选推理等级，松手生效。": "Drag the slider to pick the reasoning level; release to apply.",
  "挂绳快捷开关": "Lanyard quick toggle",
  "按字色亮度自动配面板深浅。": "Auto-match panel lightness to text brightness.",
  "按现在的音量和音调响一声。": "Play one sound at the current volume and pitch.",
  "挑一个捏的声音；选完会响一声给你听。": "Pick a synthesized voice; you'll hear a sample once selected.",
  "换一条": "Another one",
  "推理滑条": "Reasoning slider",
  "播放 / 暂停": "Play / Pause",
  "播放控制": "Playback controls",
  "播放方式": "Playback mode",
  "收场效果": "Exit effect",
  "收场的效果方式。": "The exit effect style.",
  "收场的过渡时长。": "Transition duration for the exit.",
  "放大淡入": "Zoom in + fade in",
  "数字": "Numerals",
  "整个界面的字体。": "Font for the entire interface.",
  "整套自定义光标。": "A full set of custom cursors.",
  "整框": "Whole frame",
  "整窗背景、字色、输入框、运行程序条、会话、消息气泡、开机动画……按板块分好。改完立即生效并记住。": "Window background, text color, input box, running-process bar, sessions, message bubbles, startup animation… grouped by section. Changes apply instantly and are remembered.",
  "整窗背景、字色与遮罩。": "Window background, text color, and overlay.",
  "文字也流光": "Text shimmers too",
  "文字颜色": "Text color",
  "方块后面的文字也流光。": "Text behind the block shimmers too.",
  "无时间轴切换": "Switch without timeline",
  "日落": "Sunset",
  "时长轮换": "Timed rotation",
  "显示": "Show",
  "显示底槽": "Show track",
  "显示秒数": "Show seconds",
  "显示进度条的底槽。": "Show the progress bar track.",
  "普通会话抬升": "Normal session lift",
  "最多 10 条，启动时轮播；可拖文件到这行。": "Up to 10; rotates on startup. Drag files onto this row.",
  "最长播放时长": "Max playback length",
  "有歌词时在右上角投一张歌词卡。": "Show a lyrics card in the top-right corner when lyrics are available.",
  "极光": "Aurora",
  "柔光半径": "Glow radius",
  "柔光往里渗的半径。": "How far the glow seeps inward.",
  "柔光扩散的范围。": "The spread of the glow.",
  "标准": "Standard",
  "标签栏": "Tab bar",
  "标题栏出现音乐符号，点它静音/取消静音。": "A music icon appears in the title bar; click it to mute/unmute.",
  "桌宠": "Desktop pet",
  "桌宠交互": "Desktop pet interaction",
  "模型弹窗": "Model dialog",
  "欢迎语": "Welcome message",
  "歌词卡片的宽度。": "Width of the lyrics card.",
  "歌词字号。": "Lyrics font size.",
  "歌词投射": "Lyrics projection",
  "正常": "Normal",
  "每次启动播一次的动画。": "Animation played once at each startup.",
  "气泡内侧的一圈柔光。": "A ring of soft glow inside the bubble.",
  "气泡圆角。": "Bubble corner radius.",
  "气泡外侧的一圈光。": "A ring of light outside the bubble.",
  "气泡抬升的高度。": "How high bubbles lift.",
  "气泡的圆角。": "Corner radius of the bubble.",
  "气泡的阴影强度。": "Shadow strength of the bubble.",
  "气泡缓慢上下漂。": "Bubbles drift slowly up and down.",
  "没人动它就播打盹动画。": "Plays a dozing animation when left untouched.",
  "没时间轴时隔几秒翻一句。": "With no timeline, advances a line every few seconds.",
  "流光光带的厚度。": "Thickness of the shimmer band.",
  "流光的配色。": "Shimmer color scheme.",
  "流光速度": "Shimmer speed",
  "流光颜色 1": "Shimmer color 1",
  "流光颜色 2": "Shimmer color 2",
  "流光颜色 3": "Shimmer color 3",
  "流光颜色一。": "Shimmer color one.",
  "流光颜色二，留空不用。": "Shimmer color two; leave empty to skip.",
  "流动": "Flow",
  "流动光带的粗细。": "Thickness of the flowing band.",
  "流动速度": "Flow speed",
  "浅色面": "Light side",
  "消息气泡": "Message bubbles",
  "液态扫光": "Liquid sweep",
  "淡入": "Fade in",
  "淡入时长": "Fade-in duration",
  "淡出": "Fade out",
  "淡出时长": "Fade-out duration",
  "深色面": "Dark side",
  "添加文件…": "Add file…",
  "添加音乐…": "Add music…",
  "清掉全部设置，回到原样。": "Clear all settings and return to defaults.",
  "清掉本插件的全部设置。": "Clear all settings for this plugin.",
  "清歌词": "Clear lyrics",
  "清空": "Clear all",
  "清除": "Clear",
  "渐近（不会停住）": "Ease out (never stops)",
  "滑条粗细": "Slider thickness",
  "滑条轨道的粗细。": "Thickness of the slider track.",
  "漂一个来回的时间。": "Time for one full drift cycle.",
  "漂浮周期": "Float period",
  "漂浮幅度": "Float amplitude",
  "漂浮节奏": "Float rhythm",
  "点、拖、甩、右键的操作。": "Click, drag, fling, and right-click behavior.",
  "点击 Q 弹": "Bouncy click",
  "点击时有 Q 弹效果。": "Bouncy effect when clicked.",
  "独立开关，随时可关。": "Separate toggle; turn it off anytime.",
  "环形": "Ring",
  "生活": "Life",
  "用原版": "Use original",
  "用滑条": "Use slider",
  "用系统光标": "Use system cursor",
  "用自定义": "Use custom",
  "画面以外的底色。": "Background color outside the frame.",
  "画面出现的过渡时长。": "Transition duration for the frame to appear.",
  "画面填充": "Frame fit",
  "画面适应还是铺满屏幕。": "Fit the frame or fill the screen.",
  "画面铺满还是完整放下。": "Fill the screen or keep the whole frame.",
  "界面字体": "UI font",
  "界面文字的整体粗细。": "Overall weight of UI text.",
  "略粗": "Slightly bold",
  "相邻卡片之间的空隙。": "Gap between adjacent cards.",
  "磨砂": "Frosted",
  "磨砂效果": "Frosted effect",
  "磨砂模糊": "Frost blur",
  "磨砂的模糊程度。": "Amount of frosted blur.",
  "磨砂饱和度": "Frost saturation",
  "秒数换成流光进度条。": "Replace the seconds with a shimmer progress bar.",
  "空闲卡片的气泡抬升的高度。": "Bubble lift height for idle cards.",
  "窗口与布局": "Window & layout",
  "窗口里的动画桌宠。": "Animated desktop pet inside the window.",
  "窗格标签条的显示方式。": "How pane tab bars are displayed.",
  "立刻显示": "Show immediately",
  "立即查询": "Search now",
  "等宽字体": "Monospace font",
  "糖果": "Candy",
  "线性（到点就满）": "Linear (fills right on time)",
  "给运行程序条加毛玻璃（模糊它背后的背景）。": "Frosted glass on the running-task bar (blurs the background behind it).",
  "缩小淡出": "Shrink and fade out",
  "缩放出入的幅度。": "How far it scales in and out.",
  "缩放幅度": "Scale amount",
  "背后颜色的饱和度，玻璃质感一般 130–160%。": "Saturation of the color behind it — 130–160% usually looks right for glass.",
  "背景": "Background",
  "背景底色": "Background base color",
  "背景文件": "Background file",
  "背景本身的不透明度。": "Opacity of the background image itself.",
  "背景类型": "Background type",
  "背景设置": "Background settings",
  "背景透明度": "Background opacity",
  "背景音乐": "Background music",
  "背景音乐与歌词投射。": "Background music and lyric projection.",
  "背景音乐的音量。": "Volume of the background music.",
  "能不能拖着走。": "Whether it can be dragged around.",
  "脱离窗口使用": "Detach from window",
  "自动": "Auto",
  "自定义": "Custom",
  "自定义字体名": "Custom font name",
  "自定义音效": "Custom sound",
  "自定义鼠标光标。": "Custom mouse cursor.",
  "自定义（在下面填）": "Custom (fill in below)",
  "自己一张": "Its own image",
  "自检": "Self-check",
  "落地专用素材": "Landing-only asset",
  "落地时播专用落地素材。": "Play a dedicated landing asset on landing.",
  "行间隙": "Line spacing",
  "被拦掉声音时点这里起播。": "Click here to start playing if the sound was blocked.",
  "装宠物包的文件夹。": "Folder where pet packs are installed.",
  "要": "Yes",
  "覆盖为当前": "Overwrite with current",
  "视频": "Video",
  "视频原声": "Video audio",
  "角落挂绳": "Corner tassel",
  "角落那根挂绳。": "That tassel in the corner.",
  "计时 → 进度条": "Timer → progress bar",
  "计时显示": "Timer display",
  "计时曲线": "Timer curve",
  "计时用进度条还是数字。": "Whether the timer shows as a progress bar or a number.",
  "让会话卡片轻轻浮起来。": "Gently lift the session cards.",
  "让宠物能点、能拖、能右键。": "Let the pet be clicked, dragged, and right-clicked.",
  "让我发的消息也用气泡。": "Use bubbles for my own messages too.",
  "设置弹窗": "Settings dialog",
  "设置面板的磨砂。": "Frosting on the settings panel.",
  "试听": "Play sample",
  "试听一下": "Play a sample",
  "读到的推理等级，可复制给我。": "The reasoning level it read out — copy it for me.",
  "读取": "Read",
  "越大背景越淡、界面越清晰。": "The higher it is, the fainter the background and the clearer the UI.",
  "跟随主背景": "Follow main background",
  "跟随主题": "Follow theme",
  "跟随输入框": "Follow input box",
  "跟随输入框或单独设置。": "Follow the input box or set it separately.",
  "身体": "Body",
  "转一圈的秒数，越小越快。": "Seconds per revolution — lower is faster.",
  "轮换间隔": "Rotation interval",
  "轮播方式": "Slideshow mode",
  "较粗": "Thicker",
  "输入框上方那条状态卡片。": "The status card above the input box.",
  "输入框光效": "Input box glow",
  "输入框发光颜色。": "Glow color of the input box.",
  "输入框右下角的模型与推理弹窗。": "The model and reasoning popup at the bottom-right of the input box.",
  "输入框的发光与毛玻璃。": "Glow and frosted glass on the input box.",
  "输入框设置": "Input box settings",
  "边缘光带的厚度。": "Thickness of the edge light band.",
  "运行中的行也套上流光。": "Add the shimmer to running rows too.",
  "运行中那一行的流光与计时。": "Shimmer and timer on the running row.",
  "运行状态条": "Running status bar",
  "运行状态条也流光": "Shimmer on the status bar too",
  "运行程序条": "Running-task bar",
  "运行程序条透明度": "Running-task bar opacity",
  "还原": "Revert",
  "还原设置": "Revert settings",
  "还原默认": "Restore defaults",
  "还没有存档。调好一套满意效果后按上面的按钮存一份。": "No saved presets yet. Once you've tuned something you like, hit the button above to save it.",
  "还没有曲目（可以多选文件，或「导入文件夹…」整个文件夹收进来）": "No tracks yet (you can select multiple files, or use \"Import folder…\" to pull in a whole folder)",
  "这一条的填充通透程度：0% = 应用原样（不透明），越大背景越透出来。": "Transparency of this bar's fill: 0% = app as-is (opaque); the higher, the more background shows through.",
  "进度条": "Progress bar",
  "进度条底槽": "Progress bar track",
  "进度条怎么涨。": "How the progress bar fills.",
  "连击回应": "Repeated-click reaction",
  "连点三下触发被点烦的回应。": "Click three times in a row to trigger an annoyed reaction.",
  "适应": "Fit",
  "选中会话高亮": "Highlight selected session",
  "选中的那条加底色、描边和发光，跟旁边的区分开。": "Give the selected one a background, outline, and glow to set it apart from the rest.",
  "选中那条加一道斜向反光。": "Add a diagonal sheen to the selected one.",
  "选择宠物包文件夹…": "Choose pet pack folder…",
  "选择文件…": "Choose file…",
  "选择框内发光的颜色。": "Color of the glow inside the selection box.",
  "选择音效…": "Choose sound…",
  "透明": "Transparent",
  "遮罩浓度": "Overlay strength",
  "配置存档": "Saved presets",
  "配色": "Color scheme",
  "醒目": "Bold",
  "重新自检": "Run self-check again",
  "铺满": "Fill",
  "锁住窗格与会话的位置。": "Lock the positions of panes and sessions.",
  "锁定布局": "Lock layout",
  "错开": "Stagger",
  "错开各漂各的。": "Stagger — each drifts on its own.",
  "错开各漂各的，或整列同步。": "Stagger, each drifting on its own, or sync the whole column.",
  "错开各漂各的，或整屏同步。": "Stagger, each drifting on its own, or sync the whole screen.",
  "问你要答案的那个卡片。": "The card that asks you for an answer.",
  "问询弹窗": "Prompt dialog",
  "闲置打盹": "Idle nap",
  "阴影 / 光晕强度": "Shadow / glow strength",
  "阴影强度": "Shadow strength",
  "随机": "Random",
  "霓虹": "Neon",
  "青蓝": "Cyan",
  "静态": "Static",
  "静音": "Mute",
  "静音播放。": "Play muted.",
  "靠右": "Right",
  "靠左": "Left",
  "面板深浅": "Panel shade",
  "音乐播放": "Music player",
  "音乐文件": "Music files",
  "音乐继续放，只是没声音。": "Keeps playing, just without sound.",
  "音效": "Sound effects",
  "音量": "Volume",
  "顺序": "In order",
  "顺序循环": "Loop in order",
  "预览": "Preview",
  "预览一次": "Preview once",
  "预览播放": "Preview playback",
  "首页后面铺什么。跟随主背景 = 和「背景设置」里那张一样。": "What sits behind the home page. Follow main background = same image as in \"Background settings\".",
  "首页背景": "Home background",
  "首页设置": "Home settings",
  "马上看一眼": "Take a look now",
  "高亮用的颜色。": "Color used for highlighting.",
  "高亮颜色": "Highlight color",
  "黑": "Black",
  "鼠标个性化": "Mouse personalization",
  "鼠标停住时播摸头回应。": "Play a head-pat reaction when the mouse rests on it.",
  "鼠标划过的会话也给一点提示。": "Give sessions a subtle hint on hover too.",
  "鼠标设置": "Mouse settings"
}

function translatePageNode(node, dict) {
  if (!node || typeof node !== 'object') return node

  const props = node.props

  if (!props) return Array.isArray(node) ? node.map(n => translatePageNode(n, dict)) : node

  const nextProps = Object.assign({}, props)
  let dirty = false

  for (const key of ['title', 'description', 'hint', 'label', 'note']) {
    const v = props[key]

    if (typeof v === 'string' && dict[v]) {
      nextProps[key] = dict[v]
      dirty = true
    }
  }

  if (typeof props.children === 'string' && dict[props.children]) {
    nextProps.children = dict[props.children]
    dirty = true
  } else if (Array.isArray(props.children)) {
    const kids = props.children.map(k => (k && typeof k === 'object' ? translatePageNode(k, dict) : (typeof k === 'string' && dict[k] ? dict[k] : k)))

    if (kids.some((k, i) => k !== props.children[i])) {
      nextProps.children = kids
      dirty = true
    }
  }

  return dirty ? Object.assign({}, node, { props: nextProps }) : node
}

/* 语言开关那一行（钉在页面最上面） */
function langRow(s, update) {
  return jsx(ListRow, {
    action: jsx(SegmentedControl, {
      onChange: id => update({ lang: id }),
      options: [
        { id: 'zh', label: '中文' },
        { id: 'en', label: 'English' }
      ],
      value: s.lang === 'en' ? 'en' : 'zh'
    }),
    description: '设置页的语言。/ Language of this settings page.',
    title: '语言 / Language'
  })
}

function sortSettingsSections(page) {
  try {
    /* 按「地方」归类（用户要求）：同一个地方的设置收进一个大节，里面再细分。
       大节 = Section（可折叠），子节 = 原来的 Section（也可折叠）。
       只有 2 个以上子节的地方才套大节 —— 单节再套一层纯粹是多点一下。 */
    const GROUPS = [
      { title: '背景', icon: 'file-media', items: ['背景设置', '首页设置', '背景音乐'] },
      { title: '输入框设置', icon: 'edit', items: ['光效 · 磨砂', '运行程序条', '模型弹窗'] },
      { title: '会话设置', icon: 'comment-discussion', items: ['会话悬浮', '会话行高亮', '光晕'] },
      { title: '消息气泡', icon: 'comment', items: ['我发的气泡', 'Hermes 发的气泡'] },
      { title: '弹窗与菜单', icon: 'window', items: ['右键菜单', '标签栏'] },
      { title: '桌宠', icon: 'person', items: ['桌宠', '桌宠交互'] },
      /* 用户点名要的「设置弹窗」大类：只有一个子节也套一层（force） */
      { title: '设置弹窗', icon: 'settings-gear', items: ['磨砂', '问询弹窗'], force: true },
      { title: '窗口与布局', icon: 'lock', items: ['锁定布局'], force: true },
    ]
    const children = page && page.props ? page.props.children : null

    if (!Array.isArray(children)) return page

    const byTitle = new Map()

    for (const el of children) {
      const title = el && el.props ? el.props.title : null

      if (title && !byTitle.has(title)) byTitle.set(title, el)
    }

    const used = new Map()
    const out = []

    for (const group of GROUPS) {
      const subs = group.items.map(title => byTitle.get(title)).filter(Boolean)

      if (subs.length < 2 && !group.force) {
        /* 凑不齐两个就不套大节，原样放在原位 */
        continue
      }

      for (const el of subs) used.set(el, true)

      out.push(jsx(Section, {
        icon: group.icon,
        title: group.title,
        children: subs.map(el => Object.assign({}, el, { props: Object.assign({}, el.props, { depth: 1, first: false }) }))
      }))
    }

    /* 没被收进大节的照旧排在后面 */
    for (const el of children) {
      if (!used.get(el)) out.push(el)
    }

    if (out[0] && out[0].props) {
      out[0] = Object.assign({}, out[0], { props: Object.assign({}, out[0].props, { first: true }) })
    }

    /* 语言开关：钉在页面最上面 */
    out.unshift(jsx(Section, {
      hint: '切到英文后，这页的所有文字都会变成英文。/ Switch this page to English.',
      icon: 'globe',
      title: '语言 / Language',
      children: [langRow($settings.get(), v => $settings.set(Object.assign({}, $settings.get(), v)))]
    }))

    if (out[0] && out[0].props) {
      out[0] = Object.assign({}, out[0], { props: Object.assign({}, out[0].props, { first: true }) })
    }

    /* 页脚：反馈 / 交流的 QQ 群（小号灰字，一行，钉在最下面） */
    out.push(jsx('div', {
      className: 'mt-8 mb-3 select-text text-center text-[0.68rem] leading-relaxed text-(--ui-text-tertiary)',
      children: 'Hermes个性化插件QQ交流群：1047829560'
    }))

    /* 英文模式：整棵页面树过一遍字典（字典为空时原样返回） */
    const cur = $settings.get()
    const finalOut = cur.lang === 'en' ? out.map(el => translatePageNode(el, I18N_EN)) : out

    return Object.assign({}, page, { props: Object.assign({}, page.props, { children: finalOut }) })
  } catch {
    return page
  }
}

function BackgroundSettings() {
  /* 设置页一渲染就给面板打标记：apply 只在加载 / 改设置时跑，而用户是**之后**才打开设置页的，
     不在这里补一次，玻璃要等下次改设置才出现。useEffect 在 DOM 提交后跑，那时面板已经在了。 */
  useEffect(() => {
    markSettingsSurface()
  })

  const s = useValue($settings)
  const presets = useValue($presets)

  /* 实际生效的字色（浅面会自动配深字），用来在界面上说清楚 */
  const inkInfo = resolveInk(s, resolveSurface(s))
  const inkNote = !s.ink
    ? '跟随主题，自动配好字色。'
    : inkInfo.adjusted
      ? `当前：${s.ink} —— 和面板撞色，实际用 ${inkInfo.color}（否则看不清）。`
      : `当前：${s.ink}`

  const page = jsxs('div', {
    className: 'flex flex-col gap-1',
    children: [
      jsxs('div', {
        className: 'flex items-center gap-2 pb-2',
        children: [
          jsx(Codicon, { name: 'file-media', size: '0.875rem' }),
          jsx('div', {
            className: 'text-xs text-(--ui-text-tertiary)',
            children: '整窗背景、字色、输入框、运行程序条、会话、消息气泡、开机动画……按板块分好。改完立即生效并记住。'
          })
        ]
      }),

      jsx(Section, {
        first: true,
        hint: '整窗背景、字色与遮罩。',
        icon: 'symbol-color',
        title: '背景设置',
        children: [

      jsx(ListRow, {
        action: jsx(SegmentedControl, {
          onChange: id => {
            update({ mode: id })

            /* 还没有文件就直接把选文件窗口弹出来，省得选了「视频」却什么都不发生 */
            if ((id === 'video' || id === 'image') && !$settings.get().path) {
              pickBackgroundFile(id)
            }
          },
          options: [
            { id: 'off', label: '关闭' },
            { id: 'video', label: '视频' },
            { id: 'image', label: '图片' }
          ],
          value: s.mode
        }),
        description: '循环静音播放。',
        title: '背景类型'
      }),

      jsx('div', {
        onDragOver: event => event.preventDefault(),
        onDrop: event => {
          event.preventDefault()
          haptic('tap')
          addDroppedFiles(event.dataTransfer?.files, 'bg')
        },
        children: jsx(ListRow, {
          action: jsxs('div', {
            className: 'flex flex-wrap items-center gap-2',
            children: [
              jsx(Button, { onClick: () => addClips('bg'), children: '添加文件…' }),
              jsx(Button, {
                onClick: () => {
                  haptic('tap')
                  rotateClip('bg')
                },
                variant: 'default',
                children: '换一条'
              }),
              s.clips.length
                ? jsx(Button, {
                    onClick: () => clearClips('bg'),
                    variant: 'textStrong',
                    children: '清空'
                  })
                : null
            ]
          }),
          below: clipList(s.clips, s.path, 'bg'),
          description: `最多 10 条，启动时轮播；可拖文件到这行。`,
          title: '背景文件'
        })
      }),

      jsx(ListRow, {
        action: jsx(SegmentedControl, {
          onChange: id => update({ rotation: id }),
          options: [
            { id: 'sequence', label: '顺序' },
            { id: 'random', label: '随机' }
          ],
          value: s.rotation
        }),
        description: '启动时换一条：顺序或随机。',
        title: '轮播方式'
      }),

      jsx(ListRow, {
        action: jsx(SegmentedControl, {
          onChange: id => update({ bgRotateOn: id === 'on' }),
          options: [
            { id: 'off', label: '关闭' },
            { id: 'on', label: '开启' }
          ],
          value: s.bgRotateOn ? 'on' : 'off'
        }),
        description: '开着就在使用中按间隔自动更换。',
        title: '时长轮换'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex w-full items-center gap-3',
          children: [
            jsx('input', {
              className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
              max: 3600,
              min: 10,
              onChange: event => update({ bgRotateSeconds: Number(event.target.value) }),
              step: 10,
              type: 'range',
              value: s.bgRotateSeconds
            }),
            jsx('span', {
              className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
              children: `${s.bgRotateSeconds >= 60 ? (s.bgRotateSeconds / 60).toFixed(s.bgRotateSeconds % 60 ? 1 : 0) + " 分钟" : s.bgRotateSeconds + " 秒"}`
            })
          ]
        }),
        description: '使用中隔多久换一条。',
        title: '轮换间隔'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex w-full items-center gap-3',
          children: [
            jsx('input', {
              className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
              max: 80,
              min: 0,
              onChange: event => update({ scrim: Number(event.target.value) }),
              step: 2,
              type: 'range',
              value: s.scrim
            }),
            jsx('span', {
              className: 'w-10 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
              children: `${s.scrim}%`
            })
          ]
        }),
        description: '越大背景越淡、界面越清晰。',
        title: '遮罩浓度'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex w-full items-center gap-3',
          children: [
            jsx('input', {
              className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
              max: 100,
              min: 0,
              onChange: event => update({ bgOpacity: Number(event.target.value) }),
              step: 2,
              type: 'range',
              value: s.bgOpacity
            }),
            jsx('span', {
              className: 'w-10 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
              children: `${s.bgOpacity}%`
            })
          ]
        }),
        description: '背景本身的不透明度。',
        title: '背景透明度'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex items-start gap-4',
          children: [
            jsx(ColorSwatches, {
              clearLabel: '跟随主题',
              onChange: color => update({ ink: color }),
              swatches: INK_SWATCHES,
              value: s.ink
            }),
            jsxs('label', {
              className: 'flex items-center gap-2 text-xs text-(--ui-text-tertiary)',
              children: [
                jsx('input', {
                  onChange: event => update({ ink: event.target.value }),
                  type: 'color',
                  value: s.ink || '#e6edf3'
                }),
                '自定义'
              ]
            })
          ]
        }),
        description: inkNote,
        title: '文字颜色'
      }),

      jsx(ListRow, {
        action: jsx('select', {
          className: 'h-8 rounded-md border border-(--ui-stroke-secondary) bg-transparent px-2 text-xs',
          onChange: event => update({ fontFamily: event.target.value }),
          value: FONT_PRESETS.some(x => x[0] === (s.fontFamily || '')) ? s.fontFamily || '' : '__custom',
          children: [
            ...FONT_PRESETS.map(x => jsx('option', { value: x[0], children: x[1] }, x[0] || 'theme')),
            jsx('option', { value: '__custom', children: '自定义（在下面填）' }, '__custom')
          ]
        }),
        description: '整个界面的字体。',
        title: '界面字体'
      }),

      jsx(ListRow, {
        action: jsx('input', {
          className: 'h-8 w-full min-w-0 rounded-md border border-(--ui-stroke-secondary) bg-transparent px-2 text-xs',
          onChange: event => update({ fontFamily: String(event.target.value || '') }),
          placeholder: '例如 霞鹜文楷 / LXGW WenKai',
          spellCheck: false,
          type: 'text',
          value: s.fontFamily || ''
        }),
        description: '想用列表里没有的字体，直接填字体名。',
        title: '自定义字体名'
      }),

      jsx(ListRow, {
        action: jsx('select', {
          className: 'h-8 rounded-md border border-(--ui-stroke-secondary) bg-transparent px-2 text-xs',
          onChange: event => update({ fontMono: event.target.value }),
          value: MONO_PRESETS.some(x => x[0] === (s.fontMono || '')) ? s.fontMono || '' : '',
          children: MONO_PRESETS.map(x => jsx('option', { value: x[0], children: x[1] }, x[0] || 'theme'))
        }),
        description: '代码块、路径、日志用的字体。',
        title: '等宽字体'
      }),

      jsx(ListRow, {
        action: jsx(SegmentedControl, {
          onChange: id => update({ fontWeight: id === 'off' ? '' : id }),
          options: [
            { id: 'off', label: '正常' },
            { id: '500', label: '略粗' },
            { id: '600', label: '较粗' }
          ],
          value: s.fontWeight === '500' ? '500' : s.fontWeight === '600' ? '600' : 'off'
        }),
        description: '界面文字的整体粗细。',
        title: '字重'
      }),

      jsx(ListRow, {
        action: jsx(SegmentedControl, {
          onChange: id => update({ surface: id }),
          options: [
            { id: 'auto', label: '自动' },
            { id: 'dark', label: '深色面' },
            { id: 'light', label: '浅色面' }
          ],
          value: s.surface
        }),
        description: '按字色亮度自动配面板深浅。',
        title: '面板深浅'
      }),
          ]
        }),

      jsx(Section, {
        hint: '背景音乐与歌词投射。',
        icon: 'music',
        title: '背景音乐',
        children: [
          jsx(ListRow, {
            action: jsx(SegmentedControl, {
              onChange: id => update({ musicOn: id === 'on' }),
              options: [
                { id: 'off', label: '关闭' },
                { id: 'on', label: '开启' }
              ],
              value: s.musicOn ? 'on' : 'off'
            }),
            description: '标题栏出现音乐符号，点它静音/取消静音。',
            title: '音乐播放'
          }),

          jsx(ListRow, {
            action: jsx(SegmentedControl, {
              onChange: id => update({ musicMutedOn: id === 'on' }),
              options: [
                { id: 'off', label: '不静音' },
                { id: 'on', label: '静音' }
              ],
              value: s.musicMutedOn === true ? 'on' : 'off'
            }),
            description: '音乐继续放，只是没声音。',
            title: '静音'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex flex-wrap items-center gap-2',
              children: [
                jsx(Button, { onClick: addMusicFiles, children: '添加音乐…' }),
                jsx(Button, { onClick: addMusicFolder, variant: 'default', children: '导入文件夹…' }),
                (s.musicTracks || []).length
                  ? jsx(Button, {
                      onClick: () => update({ musicTracks: [] }),
                      variant: 'textStrong',
                      children: '清空'
                    })
                  : null
              ]
            }),
            below: jsxs('div', {
              className: 'mt-2 flex max-h-[18rem] flex-col gap-1 overflow-y-auto pr-1',
              children: [
                jsx('div', {
                  className: 'text-xs text-(--ui-text-tertiary)',
                  children: `共 ${(s.musicTracks || []).length} 首（不限数量）`
                }),
                musicRows(s)
              ]
            }),
            description:
              '不限数量，可多选或导入文件夹。',
            title: '音乐文件'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 100,
                  min: 0,
                  onChange: event => update({ musicVolume: Number(event.target.value) }),
                  step: 5,
                  type: 'range',
                  value: s.musicVolume
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.musicVolume}%`
                })
              ]
            }),
            description: '背景音乐的音量。',
            title: '音量'
          }),

          jsx(ListRow, {
            action: jsx(SegmentedControl, {
              onChange: id => update({ musicRepeat: id }),
              options: [
                { id: 'sequence', label: '顺序循环' },
                { id: 'single', label: '单曲循环' },
                { id: 'random', label: '随机' }
              ],
              value: s.musicRepeat
            }),
            description: '一首放完之后怎么走。',
            title: '播放方式'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex flex-wrap items-center gap-2',
              children: [
                jsx(Button, {
                  onClick: () => {
                    haptic('tap')
                    toggleMusic()
                  },
                  children: '播放 / 暂停'
                }),
                jsx(Button, {
                  onClick: () => {
                    haptic('tap')
                    nextMusic()
                  },
                  variant: 'default',
                  children: '下一首'
                })
              ]
            }),
            description: '被拦掉声音时点这里起播。',
            title: '播放控制'
          }),

          jsx(ListRow, {
            action: jsx(SegmentedControl, {
              onChange: id => update({ lyricsOn: id === 'on' }),
              options: [
                { id: 'off', label: '关闭' },
                { id: 'on', label: '开启' }
              ],
              value: s.lyricsOn ? 'on' : 'off'
            }),
            description: '有歌词时在右上角投一张歌词卡。',
            title: '歌词投射'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 460,
                  min: 150,
                  onChange: event => update({ lyricsWidth: Number(event.target.value) }),
                  step: 10,
                  type: 'range',
                  value: s.lyricsWidth
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.lyricsWidth} px`
                })
              ]
            }),
            description: '歌词卡片的宽度。',
            title: '卡片宽度'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 1.4,
                  min: 0.7,
                  onChange: event => update({ lyricsFontSize: Number(event.target.value) }),
                  step: 0.05,
                  type: 'range',
                  value: s.lyricsFontSize
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.lyricsFontSize} rem`
                })
              ]
            }),
            description: '歌词字号。',
            title: '字号'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 16,
                  min: -16,
                  onChange: event => update({ lyricsTilt: Number(event.target.value) }),
                  step: 1,
                  type: 'range',
                  value: s.lyricsTilt
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.lyricsTilt}°`
                })
              ]
            }),
            description: '卡片倾斜角度，负数为左倒。',
            title: '倾斜角度'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 100,
                  min: 15,
                  onChange: event => update({ lyricsOpacity: Number(event.target.value) }),
                  step: 5,
                  type: 'range',
                  value: s.lyricsOpacity
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.lyricsOpacity}%`
                })
              ]
            }),
            description: '卡片的通透程度。',
            title: '不透明度'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 16,
                  min: 0,
                  onChange: event => update({ lyricsFloatAmp: Number(event.target.value) }),
                  step: 0.5,
                  type: 'range',
                  value: s.lyricsFloatAmp
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.lyricsFloatAmp} px`
                })
              ]
            }),
            description: '上下漂浮的幅度。',
            title: '漂浮幅度'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 16,
                  min: 3,
                  onChange: event => update({ lyricsFloatSpeed: Number(event.target.value) }),
                  step: 0.5,
                  type: 'range',
                  value: s.lyricsFloatSpeed
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.lyricsFloatSpeed} s`
                })
              ]
            }),
            description: '漂一个来回的时间。',
            title: '漂浮周期'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 20,
                  min: 3,
                  onChange: event => update({ lyricsPlainSeconds: Number(event.target.value) }),
                  step: 1,
                  type: 'range',
                  value: s.lyricsPlainSeconds
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.lyricsPlainSeconds} s`
                })
              ]
            }),
            description: '没时间轴时隔几秒翻一句。',
            title: '无时间轴切换'
          })
        ]
      }),

      jsx(Section, {
        hint: '输入框的发光与毛玻璃。',
        icon: 'sparkle',
        title: '光效 · 磨砂',
        children: [

      jsx(ListRow, {
        action: jsx(SegmentedControl, {
          onChange: id => update({ glowOn: id === 'on' }),
          options: [
            { id: 'off', label: '关闭' },
            { id: 'on', label: '开启' }
          ],
          value: s.glowOn ? 'on' : 'off'
        }),
        description: '独立开关，随时可关。',
        title: '输入框光效'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex items-start gap-4',
          children: [
            jsx(ColorSwatches, {
              clearLabel: '恢复默认蓝',
              onChange: color => update({ glowColor: color || '#4a84fe' }),
              swatches: GLOW_SWATCHES,
              value: s.glowColor
            }),
            jsxs('label', {
              className: 'flex items-center gap-2 text-xs text-(--ui-text-tertiary)',
              children: [
                jsx('input', {
                  onChange: event => update({ glowColor: event.target.value }),
                  type: 'color',
                  value: s.glowColor
                }),
                '自定义'
              ]
            })
          ]
        }),
        description: '输入框发光颜色。',
        title: '发光颜色'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex w-full items-center gap-3',
          children: [
            jsx('input', {
              className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
              max: 100,
              min: 10,
              onChange: event => update({ glowStrength: Number(event.target.value) }),
              step: 5,
              type: 'range',
              value: s.glowStrength
            }),
            jsx('span', {
              className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
              children: `${s.glowStrength}%`
            })
          ]
        }),
        description: '发光强弱。',
        title: '强度'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex w-full items-center gap-3',
          children: [
            jsx('input', {
              className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
              max: 6,
              min: 0.5,
              onChange: event => update({ glowWidth: Number(event.target.value) }),
              step: 0.5,
              type: 'range',
              value: s.glowWidth
            }),
            jsx('span', {
              className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
              children: `${s.glowWidth} px`
            })
          ]
        }),
        description: '流动光带的粗细。',
        title: '光带厚度'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex w-full items-center gap-3',
          children: [
            jsx('input', {
              className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
              max: 60,
              min: 0,
              onChange: event => update({ glowBlur: Number(event.target.value) }),
              step: 2,
              type: 'range',
              value: s.glowBlur
            }),
            jsx('span', {
              className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
              children: `${s.glowBlur} px`
            })
          ]
        }),
        description: '柔光扩散的范围。',
        title: '柔光半径'
      }),

      jsx(ListRow, {
        action: jsx(SegmentedControl, {
          onChange: id => update({ glowFlow: id }),
          options: [
            { id: 'on', label: '流动' },
            { id: 'off', label: '静态' }
          ],
          value: s.glowFlow === 'off' ? 'off' : 'on'
        }),
        description: '光沿边框转圈或固定不动。',
        title: '发光流动'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex w-full items-center gap-3',
          children: [
            jsx('input', {
              className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
              max: 12,
              min: 0.5,
              onChange: event => update({ glowSpeed: Number(event.target.value) }),
              step: 0.5,
              type: 'range',
              value: s.glowSpeed
            }),
            jsx('span', {
              className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
              children: `${s.glowSpeed} s`
            })
          ]
        }),
        description: '转一圈的秒数，越小越快。',
        title: '流动速度'
      }),

                    lgxOnRow(s, update, 'lgxOn', '给输入框加磨砂（模糊它背后的画面）。'),
          ...lgxRecipeRows(s, update, 'comp', '输入框'),

          rangeRow(s, update, 'lgxRadius', 0, 24, 1, `${s.lgxRadius} px`, '输入框圆角。', '圆角'),

]
        }),

      jsx(Section, {
        hint: '输入框上方那条状态卡片。',
        icon: 'server-process',
        title: '运行程序条',
        children: [
          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 80,
                  min: 0,
                  onChange: event => update({ stackInset: Number(event.target.value) }),
                  step: 1,
                  type: 'range',
                  value: s.stackInset
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.stackInset} px`
                })
              ]
            }),
            description: '左右各内缩多少。',
            title: '左右内缩'
          }),

          jsx(ListRow, {
            action: jsx(SegmentedControl, {
              onChange: id => update({ stackFollow: id === 'on' }),
              options: [
                { id: 'on', label: '跟随输入框' },
                { id: 'off', label: '单独设置' }
              ],
              value: s.stackFollow === false ? 'off' : 'on'
            }),
            description: '跟随输入框或单独设置。',
            title: '跟随输入框'
          }),

          s.stackFollow === false
            ? jsxs('div', {
                className: 'flex flex-col gap-1',
                children: [
          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 100,
                  min: 0,
                  onChange: event => update({ stackAlpha: Number(event.target.value) }),
                  step: 5,
                  type: 'range',
                  value: s.stackAlpha
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.stackAlpha}%`
                })
              ]
            }),
            description: '这一条的填充通透程度：0% = 应用原样（不透明），越大背景越透出来。',
            title: '运行程序条透明度'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 40,
                  min: 0,
                  onChange: event => update({ stackBlur: Number(event.target.value) }),
                  step: 1,
                  type: 'range',
                  value: s.stackBlur
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.stackBlur} px`
                })
              ]
            }),
            description: '磨砂的模糊程度。',
            title: '磨砂模糊'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 200,
                  min: 100,
                  onChange: event => update({ stackSaturate: Number(event.target.value) }),
                  step: 5,
                  type: 'range',
                  value: s.stackSaturate
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.stackSaturate}%`
                })
              ]
            }),
            description: '背后颜色的饱和度，玻璃质感一般 130–160%。',
            title: '磨砂饱和度'
          }),

                  jsx(ListRow, {
                    action: jsx(SegmentedControl, {
                      onChange: id => update({ stackFrostOn: id === 'on' }),
                      options: [
                        { id: 'off', label: '关闭' },
                        { id: 'on', label: '开启' }
                      ],
                      value: s.stackFrostOn ? 'on' : 'off'
                    }),
                    description: '给运行程序条加毛玻璃（模糊它背后的背景）。',
                    title: '磨砂效果'
                  })
                ]
              })
            : null
        ]
      }),

      jsx(Section, {
        hint: '会话卡片的浮起与漂浮。',
        icon: 'layers',
        title: '会话悬浮',
        children: [

      jsx(ListRow, {
        action: jsx(SegmentedControl, {
          onChange: id => update({ sessOn: id === 'on' }),
          options: [
            { id: 'off', label: '关闭' },
            { id: 'on', label: '开启' }
          ],
          value: s.sessOn ? 'on' : 'off'
        }),
        description: '让会话卡片轻轻浮起来。',
        title: '会话悬浮'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex w-full items-center gap-3',
          children: [
            jsx('input', {
              className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
              max: 10,
              min: 0,
              onChange: event => update({ sessLift: Number(event.target.value) }),
              step: 1,
              type: 'range',
              value: s.sessLift
            }),
            jsx('span', {
              className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
              children: `${s.sessLift} px`
            })
          ]
        }),
        description: '空闲卡片的气泡抬升的高度。',
        title: '普通会话抬升'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex w-full items-center gap-3',
          children: [
            jsx('input', {
              className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
              max: 12,
              min: 0,
              onChange: event => update({ sessWorkExtra: Number(event.target.value) }),
              step: 1,
              type: 'range',
              value: s.sessWorkExtra
            }),
            jsx('span', {
              className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
              children: `+${s.sessWorkExtra} px`
            })
          ]
        }),
        description: `工作中的卡片额外抬高多少。`,
        title: '工作会话额外抬升'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex w-full items-center gap-3',
          children: [
            jsx('input', {
              className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
              max: 8,
              min: 0,
              onChange: event => update({ sessAmp: Number(event.target.value) }),
              step: 0.5,
              type: 'range',
              value: s.sessAmp
            }),
            jsx('span', {
              className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
              children: `${s.sessAmp} px`
            })
          ]
        }),
        description: '上下漂浮的幅度。',
        title: '漂浮幅度'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex w-full items-center gap-3',
          children: [
            jsx('input', {
              className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
              max: 14,
              min: 2,
              onChange: event => update({ sessSpeed: Number(event.target.value) }),
              step: 0.5,
              type: 'range',
              value: s.sessSpeed
            }),
            jsx('span', {
              className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
              children: `${s.sessSpeed} s`
            })
          ]
        }),
        description: '漂一个来回的时间。',
        title: '漂浮周期'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex w-full items-center gap-3',
          children: [
            jsx('input', {
              className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
              max: 32,
              min: 0,
              onChange: event => update({ sessRadius: Number(event.target.value) }),
              step: 1,
              type: 'range',
              value: s.sessRadius
            }),
            jsx('span', {
              className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
              children: `${s.sessRadius} px`
            })
          ]
        }),
        description: '会话卡片的圆角。',
        title: '圆角'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex w-full items-center gap-3',
          children: [
            jsx('input', {
              className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
              max: 10,
              min: 0,
              onChange: event => update({ sessGap: Number(event.target.value) }),
              step: 1,
              type: 'range',
              value: s.sessGap
            }),
            jsx('span', {
              className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
              children: `${s.sessGap * 2} px`
            })
          ]
        }),
        description: '相邻卡片之间的空隙。',
        title: '行间隙'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex w-full items-center gap-3',
          children: [
            jsx('input', {
              className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
              max: 20,
              min: 0,
              onChange: event => update({ sessInset: Number(event.target.value) }),
              step: 1,
              type: 'range',
              value: s.sessInset
            }),
            jsx('span', {
              className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
              children: `${s.sessInset} px`
            })
          ]
        }),
        description: `卡片左右内缩，给光晕留余量。`,
        title: '左右内缩'
      }),

      jsx(ListRow, {
        action: jsx(SegmentedControl, {
          onChange: id => update({ sessStagger: id }),
          options: [
            { id: 'on', label: '错开' },
            { id: 'off', label: '同步' }
          ],
          value: s.sessStagger === 'off' ? 'off' : 'on'
        }),
        description: '错开各漂各的，或整列同步。',
        title: '漂浮节奏'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex w-full items-center gap-3',
          children: [
            jsx('input', {
              className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
              max: 100,
              min: 0,
              onChange: event => update({ sessShadow: Number(event.target.value) }),
              step: 5,
              type: 'range',
              value: s.sessShadow
            }),
            jsx('span', {
              className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
              children: `${s.sessShadow}%`
            })
          ]
        }),
        description: '卡片投影的强度。',
        title: '阴影 / 光晕强度'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex items-start gap-4',
          children: [
            jsx(ColorSwatches, {
              clearLabel: '恢复默认',
              onChange: color => update({ sessGlowColor: color || '#4a84fe' }),
              swatches: GLOW_SWATCHES,
              value: s.sessGlowColor
            }),
            jsxs('label', {
              className: 'flex items-center gap-2 text-xs text-(--ui-text-tertiary)',
              children: [
                jsx('input', {
                  onChange: event => update({ sessGlowColor: event.target.value }),
                  type: 'color',
                  value: s.sessGlowColor
                }),
                '自定义'
              ]
            })
          ]
        }),
        description: '工作中卡片的光晕颜色。',
        title: '光晕颜色'
      }),
                    swRow(s, update, 'navCollapseOn', '收起这几个功能行', '收起侧栏顶部那几个功能行。', '展开', '收起'),
          swRow(s, update, 'sessTouchOn', '鼠标触碰反馈', '鼠标滑过时卡片缓缓膨大并跟随。', '关', '开'),
          rangeRow(s, update, 'sessTouchGrow', 0, 20, 1, `+${s.sessTouchGrow}%`, '悬停时放大的比例。', '膨大幅度'),
          rangeRow(s, update, 'sessTouchRise', 0, 20, 1, `${s.sessTouchRise} px`, '悬停时上飘的距离。', '上飘高度'),
          rangeRow(s, update, 'sessTouchFollow', 0, 24, 1, `${s.sessTouchFollow} px`, '悬停时跟随鼠标上下滑动。', '跟随幅度'),
          rangeRow(s, update, 'sessTouchMs', 150, 3000, 10, `${s.sessTouchMs} ms`, '膨大与跟随后用多久完成。', '反馈时长'),
          lgxOnRow(s, update, 'lgxSessOn', '给会话卡片加磨砂。'),
          ...lgxRecipeRows(s, update, 'sess', '会话框'),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 30, min: 10, step: 0.5, type: 'range',
                  onChange: event => update({ sessColWidth: Number(event.target.value) }),
                  value: s.sessColWidth
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${Number(s.sessColWidth).toFixed(1)} rem`
                })
              ]
            }),
            description: '左侧会话栏的宽度。',
            title: '会话列宽度'
          }),

          swRow(s, update, 'sessDragOn', '拖拽调宽', '侧栏右边缘有一条细线，按住左右拖就能改宽度。', '关', '开'),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 80, min: 0, step: 1, type: 'range',
                  onChange: event => update({ sessColPad: Number(event.target.value) }),
                  value: s.sessColPad
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.sessColPad} px`
                })
              ]
            }),
            description: '会话列表左右的内边距。',
            title: '列表左右内边距'
          }),
]
        }),

      jsx(Section, {
        hint: '右键菜单的玻璃。',
        icon: 'menu',
        title: '右键菜单',
        children: [
          lgxTriRow(s, update, 'lgxMenuOn', '玻璃', '右键菜单套上玻璃。'),
          ...lgxRecipeRows(s, update, 'menu', '右键菜单'),
          rangeRow(s, update, 'lgxMenuRadius', 0, 24, 1, `${s.lgxMenuRadius} px`, '右键菜单玻璃的圆角。', '玻璃圆角')
        ]
      }),

jsx(Section, {
        hint: '窗格标签条的显示方式。',
        icon: 'window',
        title: '标签栏',
        children: [
          swRow(s, update, 'hidePaneTabs', '藏起会话标签', '藏起会话名，保留 ✕ 和 ＋。', '显示', '藏起')
        ]
      }),

jsx(Section, {
        hint: '当前选中的那条会话要一眼看得出来。',
        icon: 'list',
        title: '会话行高亮',
        children: [

      jsx(ListRow, {
        action: jsx(SegmentedControl, {
          onChange: id => update({ sessHlOn: id === 'on' }),
          options: [
            { id: 'off', label: '关闭' },
            { id: 'on', label: '开启' }
          ],
          value: s.sessHlOn !== false ? 'on' : 'off'
        }),
        description: '选中的那条加底色、描边和发光，跟旁边的区分开。',
        title: '选中会话高亮'
      }),

      jsx(ListRow, {
        action: jsx(SegmentedControl, {
          onChange: id => update({ sessHlBar: id === 'on' }),
          options: [
            { id: 'off', label: '不要' },
            { id: 'on', label: '要' }
          ],
          value: s.sessHlBar !== false ? 'on' : 'off'
        }),
        description: '选中那条加一道斜向反光。',
        title: '反光'
      }),

      jsx(ListRow, {
        action: jsx(SegmentedControl, {
          onChange: id => update({ sessHlHover: id === 'on' }),
          options: [
            { id: 'off', label: '不要' },
            { id: 'on', label: '要' }
          ],
          value: s.sessHlHover !== false ? 'on' : 'off'
        }),
        description: '鼠标划过的会话也给一点提示。',
        title: '悬停也高亮'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex items-center gap-3',
          children: [
            jsx('input', {
              onChange: event => update({ sessHlColor: String(event.target.value || '#4dd0ff') }),
              type: 'color',
              value: s.sessHlColor || '#4dd0ff'
            }),
            jsx(Button, { onClick: () => update({ sessHlColor: '#4dd0ff' }), size: 'xs', variant: 'text', children: '恢复默认' })
          ]
        }),
        description: '高亮用的颜色。',
        title: '高亮颜色'
      }),

        ]
      }),

jsx(Section, {
        hint: '会话卡片的内外发光。',
        icon: 'paintcan',
        title: '光晕',
        children: [

      jsx(ListRow, {
        action: jsx(SegmentedControl, {
          onChange: id => update({ sessInOn: id === 'on' }),
          options: [
            { id: 'off', label: '关闭' },
            { id: 'on', label: '开启' }
          ],
          value: s.sessInOn === 'on' || s.sessInOn === true ? 'on' : 'off'
        }),
        description: '卡片内侧的一圈柔光。',
        title: '内发光'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex items-start gap-4',
          children: [
            jsx(ColorSwatches, {
              clearLabel: '恢复默认',
              onChange: color => update({ sessInColor: color || '#4a84fe' }),
              swatches: GLOW_SWATCHES,
              value: s.sessInColor
            }),
            jsxs('label', {
              className: 'flex items-center gap-2 text-xs text-(--ui-text-tertiary)',
              children: [
                jsx('input', {
                  onChange: event => update({ sessInColor: event.target.value }),
                  type: 'color',
                  value: s.sessInColor
                }),
                '自定义'
              ]
            })
          ]
        }),
        description: '内发光的颜色。',
        title: '内发光颜色'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex w-full items-center gap-3',
          children: [
            jsx('input', {
              className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
              max: 100,
              min: 0,
              onChange: event => update({ sessInStrength: Number(event.target.value) }),
              step: 5,
              type: 'range',
              value: s.sessInStrength
            }),
            jsx('span', {
              className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
              children: `${s.sessInStrength}%`
            })
          ]
        }),
        description: '内发光的强度。',
        title: '内发光强度'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex w-full items-center gap-3',
          children: [
            jsx('input', {
              className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
              max: 40,
              min: 0,
              onChange: event => update({ sessInBlur: Number(event.target.value) }),
              step: 1,
              type: 'range',
              value: s.sessInBlur
            }),
            jsx('span', {
              className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
              children: `${s.sessInBlur} px`
            })
          ]
        }),
        description: '柔光往里渗的半径。',
        title: '内发光半径'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex w-full items-center gap-3',
          children: [
            jsx('input', {
              className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
              max: 8,
              min: 0.5,
              onChange: event => update({ sessInWidth: Number(event.target.value) }),
              step: 0.5,
              type: 'range',
              value: s.sessInWidth
            }),
            jsx('span', {
              className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
              children: `${s.sessInWidth} px`
            })
          ]
        }),
        description: '边缘光带的厚度。',
        title: '内发光厚度'
      }),

      jsx(ListRow, {
        action: jsx(SegmentedControl, {
          onChange: id => update({ sessOutOn: id === 'on' }),
          options: [
            { id: 'off', label: '关闭' },
            { id: 'on', label: '开启' }
          ],
          value: s.sessOutOn === 'on' || s.sessOutOn === true ? 'on' : 'off'
        }),
        description: '卡片外侧的一圈光。',
        title: '外发光'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex items-start gap-4',
          children: [
            jsx(ColorSwatches, {
              clearLabel: '恢复默认',
              onChange: color => update({ sessOutColor: color || '#4a84fe' }),
              swatches: GLOW_SWATCHES,
              value: s.sessOutColor
            }),
            jsxs('label', {
              className: 'flex items-center gap-2 text-xs text-(--ui-text-tertiary)',
              children: [
                jsx('input', {
                  onChange: event => update({ sessOutColor: event.target.value }),
                  type: 'color',
                  value: s.sessOutColor
                }),
                '自定义'
              ]
            })
          ]
        }),
        description: '外发光的颜色。',
        title: '外发光颜色'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex w-full items-center gap-3',
          children: [
            jsx('input', {
              className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
              max: 100,
              min: 0,
              onChange: event => update({ sessOutStrength: Number(event.target.value) }),
              step: 5,
              type: 'range',
              value: s.sessOutStrength
            }),
            jsx('span', {
              className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
              children: `${s.sessOutStrength}%`
            })
          ]
        }),
        description: '外发光的强度。',
        title: '外发光强度'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex w-full items-center gap-3',
          children: [
            jsx('input', {
              className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
              max: 48,
              min: 0,
              onChange: event => update({ sessOutBlur: Number(event.target.value) }),
              step: 1,
              type: 'range',
              value: s.sessOutBlur
            }),
            jsx('span', {
              className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
              children: `${s.sessOutBlur} px`
            })
          ]
        }),
        description: '光往外扩散的半径。',
        title: '外发光半径'
      }),

      jsx(ListRow, {
        action: jsx(SegmentedControl, {
          onChange: id => update({ sessOutFlow: id === 'on' ? 'on' : 'off' }),
          options: [
            { id: 'off', label: '关闭' },
            { id: 'on', label: '开启' }
          ],
          value: s.sessOutFlow === 'on' || s.sessOutFlow === true ? 'on' : 'off'
        }),
        description: '光带沿卡片边框转圈。',
        title: '外发光流动'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex w-full items-center gap-3',
          children: [
            jsx('input', {
              className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
              max: 20,
              min: 1,
              onChange: event => update({ sessOutSpeed: Number(event.target.value) }),
              step: 0.5,
              type: 'range',
              value: s.sessOutSpeed
            }),
            jsx('span', {
              className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
              children: `${s.sessOutSpeed} s`
            })
          ]
        }),
        description: '转一圈的秒数，越小越快。',
        title: '流动速度'
      }),

      jsx(ListRow, {
        action: jsx(SegmentedControl, {
          onChange: id => update({ sessAuraMode: id }),
          options: [
            { id: 'off', label: '关闭' },
            { id: 'rainbow', label: '彩色流光' },
            { id: 'solid', label: '单色流光' }
          ],
          value: s.sessAuraMode === 'off' ? 'off' : s.sessAuraMode === 'solid' ? 'solid' : 'rainbow'
        }),
        description: '工作中的卡片转一圈光带。',
        title: '工作会话流光'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex items-start gap-4',
          children: [
            jsx(ColorSwatches, {
              clearLabel: '不参与',
              onChange: color => update({ sessAuraC1: color || '' }),
              swatches: GLOW_SWATCHES,
              value: s.sessAuraC1
            }),
            jsxs('label', {
              className: 'flex items-center gap-2 text-xs text-(--ui-text-tertiary)',
              children: [
                jsx('input', {
                  onChange: event => update({ sessAuraC1: event.target.value }),
                  type: 'color',
                  value: s.sessAuraC1 || '#4a84fe'
                }),
                '自定义'
              ]
            })
          ]
        }),
        description: '流光颜色一。',
        title: '流光颜色 1'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex items-start gap-4',
          children: [
            jsx(ColorSwatches, {
              clearLabel: '不参与',
              onChange: color => update({ sessAuraC2: color || '' }),
              swatches: GLOW_SWATCHES,
              value: s.sessAuraC2
            }),
            jsxs('label', {
              className: 'flex items-center gap-2 text-xs text-(--ui-text-tertiary)',
              children: [
                jsx('input', {
                  onChange: event => update({ sessAuraC2: event.target.value }),
                  type: 'color',
                  value: s.sessAuraC2 || '#4a84fe'
                }),
                '自定义'
              ]
            })
          ]
        }),
        description: '流光颜色二，留空不用。',
        title: '流光颜色 2'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex items-start gap-4',
          children: [
            jsx(ColorSwatches, {
              clearLabel: '不参与',
              onChange: color => update({ sessAuraC3: color || '' }),
              swatches: GLOW_SWATCHES,
              value: s.sessAuraC3
            }),
            jsxs('label', {
              className: 'flex items-center gap-2 text-xs text-(--ui-text-tertiary)',
              children: [
                jsx('input', {
                  onChange: event => update({ sessAuraC3: event.target.value }),
                  type: 'color',
                  value: s.sessAuraC3 || '#4a84fe'
                }),
                '自定义'
              ]
            })
          ]
        }),
        description: '流光颜色二，留空不用。',
        title: '流光颜色 3'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex w-full items-center gap-3',
          children: [
            jsx('input', {
              className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
              max: 8,
              min: 0.5,
              onChange: event => update({ sessAuraWidth: Number(event.target.value) }),
              step: 0.5,
              type: 'range',
              value: s.sessAuraWidth
            }),
            jsx('span', {
              className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
              children: `${s.sessAuraWidth} px`
            })
          ]
        }),
        description: '流光光带的厚度。',
        title: '光带厚度'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex w-full items-center gap-3',
          children: [
            jsx('input', {
              className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
              max: 20,
              min: 1,
              onChange: event => update({ sessAuraSpeed: Number(event.target.value) }),
              step: 0.5,
              type: 'range',
              value: s.sessAuraSpeed
            }),
            jsx('span', {
              className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
              children: `${s.sessAuraSpeed} s`
            })
          ]
        }),
        description: '转一圈的秒数，越小越快。',
        title: '流光速度'
      }),

          ]
        }),

      jsx(Section, {
        hint: '我发出的消息气泡。',
        icon: 'comment-discussion',
        title: '我发的气泡',
        children: [

          
          jsx(ListRow, {
            action: jsx(SegmentedControl, {
              onChange: id => update({ bubbleEnter: id }),
              options: [
                { id: 'off', label: '关闭' },
                { id: 'rise', label: '上浮淡入' },
                { id: 'fly', label: '从输入框飞入' },
                { id: 'pop', label: '弹出' },
                { id: 'slide', label: '侧滑淡入' }
              ],
              value:
                s.bubbleEnter === 'rise' || s.bubbleEnter === 'pop' || s.bubbleEnter === 'slide' || s.bubbleEnter === 'fly'
                  ? s.bubbleEnter
                  : 'off'
            }),
            description: '刚发出的那一条的入场动画。',
            title: '发送动画'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 1500,
                  min: 120,
                  onChange: event => update({ bubbleEnterMs: Number(event.target.value) }),
                  step: 20,
                  type: 'range',
                  value: s.bubbleEnterMs
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.bubbleEnterMs} ms`
                })
              ]
            }),
            description: '入场动画的时长。',
            title: '动画时长'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 60,
                  min: 2,
                  onChange: event => update({ bubbleEnterAmp: Number(event.target.value) }),
                  step: 1,
                  type: 'range',
                  value: s.bubbleEnterAmp
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.bubbleEnterAmp} px`
                })
              ]
            }),
            description: '上浮或侧滑的距离。',
            title: '动画幅度'
          }),

          jsx(ListRow, {
            action: jsx(SegmentedControl, {
              onChange: id => update({ bubbleFloat: id === 'on' }),
              options: [
                { id: 'off', label: '关闭' },
                { id: 'on', label: '开启' }
              ],
              value: s.bubbleFloat ? 'on' : 'off'
            }),
            description: '已发气泡轻轻浮起并上下漂。',
            title: '悬浮'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 12,
                  min: 0,
                  onChange: event => update({ bubbleLift: Number(event.target.value) }),
                  step: 1,
                  type: 'range',
                  value: s.bubbleLift
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.bubbleLift} px`
                })
              ]
            }),
            description: '气泡抬升的高度。',
            title: '抬升'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 10,
                  min: 0,
                  onChange: event => update({ bubbleAmp: Number(event.target.value) }),
                  step: 0.5,
                  type: 'range',
                  value: s.bubbleAmp
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.bubbleAmp} px`
                })
              ]
            }),
            description: '上下漂浮的幅度。',
            title: '漂浮幅度'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 14,
                  min: 2,
                  onChange: event => update({ bubbleSpeed: Number(event.target.value) }),
                  step: 0.5,
                  type: 'range',
                  value: s.bubbleSpeed
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.bubbleSpeed} s`
                })
              ]
            }),
            description: '漂一个来回的时间。',
            title: '漂浮周期'
          }),

          jsx(ListRow, {
            action: jsx(SegmentedControl, {
              onChange: id => update({ bubbleStagger: id }),
              options: [
                { id: 'on', label: '错开' },
                { id: 'off', label: '同步' }
              ],
              value: s.bubbleStagger === 'off' ? 'off' : 'on'
            }),
            description: '错开各漂各的，或整屏同步。',
            title: '漂浮节奏'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 28,
                  min: 0,
                  onChange: event => update({ bubbleRadius: Number(event.target.value) }),
                  step: 1,
                  type: 'range',
                  value: s.bubbleRadius
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.bubbleRadius === 0 ? "原样" : s.bubbleRadius + " px"}`
                })
              ]
            }),
            description: '气泡圆角。',
            title: '圆角'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 100,
                  min: 0,
                  onChange: event => update({ bubbleShadow: Number(event.target.value) }),
                  step: 5,
                  type: 'range',
                  value: s.bubbleShadow
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.bubbleShadow}%`
                })
              ]
            }),
            description: '悬浮时气泡的投影强度。',
            title: '阴影强度'
          }),

          jsx(ListRow, {
            action: jsx(SegmentedControl, {
              onChange: id => update({ bubbleInOn: id === 'on' }),
              options: [
                { id: 'off', label: '关闭' },
                { id: 'on', label: '开启' }
              ],
              value: s.bubbleInOn ? 'on' : 'off'
            }),
            description: '气泡内侧的一圈柔光。',
            title: '内发光'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex items-start gap-4',
              children: [
                jsx(ColorSwatches, {
                  clearLabel: '恢复默认',
                  onChange: color => update({ bubbleInColor: color || '#7ee7ff' }),
                  swatches: GLOW_SWATCHES,
                  value: s.bubbleInColor
                }),
                jsxs('label', {
                  className: 'flex items-center gap-2 text-xs text-(--ui-text-tertiary)',
                  children: [
                    jsx('input', {
                      onChange: event => update({ bubbleInColor: event.target.value }),
                      type: 'color',
                      value: s.bubbleInColor
                    }),
                    '自定义'
                  ]
                })
              ]
            }),
            description: '内发光的颜色。',
            title: '内发光颜色'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 100,
                  min: 0,
                  onChange: event => update({ bubbleInStrength: Number(event.target.value) }),
                  step: 5,
                  type: 'range',
                  value: s.bubbleInStrength
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.bubbleInStrength}%`
                })
              ]
            }),
            description: '内发光的强度。',
            title: '内发光强度'
          }),

          jsx(ListRow, {
            action: jsx(SegmentedControl, {
              onChange: id => update({ bubbleOutOn: id === 'on' }),
              options: [
                { id: 'off', label: '关闭' },
                { id: 'on', label: '开启' }
              ],
              value: s.bubbleOutOn ? 'on' : 'off'
            }),
            description: '气泡外侧的一圈光。',
            title: '外发光'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex items-start gap-4',
              children: [
                jsx(ColorSwatches, {
                  clearLabel: '恢复默认',
                  onChange: color => update({ bubbleOutColor: color || '#4a84fe' }),
                  swatches: GLOW_SWATCHES,
                  value: s.bubbleOutColor
                }),
                jsxs('label', {
                  className: 'flex items-center gap-2 text-xs text-(--ui-text-tertiary)',
                  children: [
                    jsx('input', {
                      onChange: event => update({ bubbleOutColor: event.target.value }),
                      type: 'color',
                      value: s.bubbleOutColor
                    }),
                    '自定义'
                  ]
                })
              ]
            }),
            description: '外发光的颜色。',
            title: '外发光颜色'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 100,
                  min: 0,
                  onChange: event => update({ bubbleOutStrength: Number(event.target.value) }),
                  step: 5,
                  type: 'range',
                  value: s.bubbleOutStrength
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.bubbleOutStrength}%`
                })
              ]
            }),
            description: '外发光的强度。',
            title: '外发光强度'
          }),

          jsx(ListRow, {
            action: jsx(SegmentedControl, {
              onChange: id => update({ bubbleOutFlow: id === 'on' }),
              options: [
                { id: 'off', label: '关闭' },
                { id: 'on', label: '开启' }
              ],
              value: s.bubbleOutFlow ? 'on' : 'off'
            }),
            description: '光带沿气泡边框转圈。',
            title: '外发光流动'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 20,
                  min: 1,
                  onChange: event => update({ bubbleOutSpeed: Number(event.target.value) }),
                  step: 0.5,
                  type: 'range',
                  value: s.bubbleOutSpeed
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.bubbleOutSpeed} s`
                })
              ]
            }),
            description: '转一圈的秒数，越小越快。',
            title: '流动速度'
          }),

                  swRow(s, update, 'userPinOn', '滚动时钉住我的消息（吸顶）', '你发的消息是否吸顶钉住。'),
    bubbleAlignRow(s, update, 'myBubbleAlign', '气泡位置', '气泡靠左、居中或靠右。'),
          rangeRow(s, update, 'myBubbleWidth', 40, 100, 1, `${s.myBubbleWidth}%`, '居中对齐时的最宽占比（靠左/靠右看下面那条）。', '最大宽度'),
          swRow(s, update, 'bubbleEdgeOn', '贴到最边', '靠左或靠右时，气泡一直铺到聊天区最边。', '留上限', '贴到边'),
          lgxOnRow(s, update, 'lgxBubbleOn', '给我发的气泡加磨砂。'),
          ...lgxRecipeRows(s, update, 'bubble', '我发的气泡'),
          rangeRow(s, update, 'lgxBubbleRadius', 0, 28, 1, `${s.lgxBubbleRadius} px`, '我发的气泡玻璃的圆角。', '玻璃圆角'),

          swRow(s, update, 'bubbleSelectTint', '选中文字的高亮跟随气泡色调', '选中文字的高亮跟随气泡色。', '用应用默认', '跟随气泡'),
          swRow(s, update, 'userBubbleClear', '去掉我发的气泡的黑底', '去掉气泡底色，露出背景。', '保留底色', '去掉黑底'),
]
      }),

      jsx(Section, {
        hint: 'Hermes 回复的气泡。',
        icon: 'comment-discussion',
        title: 'Hermes 发的气泡',
        children: [
          jsx(ListRow, {
            action: jsx(SegmentedControl, {
              onChange: id => update({ aBOn: id === 'on' }),
              options: [
                { id: 'off', label: '关闭' },
                { id: 'on', label: '开启' }
              ],
              value: s.aBOn === false ? 'off' : 'on'
            }),
            description: '让我发的消息也用气泡。',
            title: '开启气泡'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 32,
                  min: 0,
                  onChange: event => update({ aBRadius: Number(event.target.value) }),
                  step: 1,
                  type: 'range',
                  value: s.aBRadius
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.aBRadius} px`
                })
              ]
            }),
            description: '气泡的圆角。',
            title: '圆角'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 100,
                  min: 0,
                  onChange: event => update({ aBShadow: Number(event.target.value) }),
                  step: 1,
                  type: 'range',
                  value: s.aBShadow
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.aBShadow} %`
                })
              ]
            }),
            description: '气泡的阴影强度。',
            title: '阴影强度'
          }),

          jsx(ListRow, {
            action: jsx(SegmentedControl, {
              onChange: id => update({ aBFloat: id === 'on' }),
              options: [
                { id: 'off', label: '关闭' },
                { id: 'on', label: '开启' }
              ],
              value: s.aBFloat ? 'on' : 'off'
            }),
            description: '气泡缓慢上下漂。',
            title: '悬浮'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 12,
                  min: 0,
                  onChange: event => update({ aBLift: Number(event.target.value) }),
                  step: 1,
                  type: 'range',
                  value: s.aBLift
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.aBLift} px`
                })
              ]
            }),
            description: '气泡抬升的高度。',
            title: '抬升'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 10,
                  min: 0,
                  onChange: event => update({ aBAmp: Number(event.target.value) }),
                  step: 0.5,
                  type: 'range',
                  value: s.aBAmp
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.aBAmp} px`
                })
              ]
            }),
            description: '上下漂浮的幅度。',
            title: '漂浮幅度'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 14,
                  min: 2,
                  onChange: event => update({ aBSpeed: Number(event.target.value) }),
                  step: 0.5,
                  type: 'range',
                  value: s.aBSpeed
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.aBSpeed} s`
                })
              ]
            }),
            description: '漂一个来回的时间。',
            title: '漂浮周期'
          }),

          jsx(ListRow, {
            action: jsx(SegmentedControl, {
              onChange: id => update({ aBStagger: id }),
              options: [
                { id: 'off', label: '同步' },
                { id: 'on', label: '错开' }
              ],
              value: s.aBStagger === 'off' ? 'off' : 'on'
            }),
            description: '错开各漂各的。',
            title: '漂浮节奏'
          }),

          jsx(ListRow, {
            action: jsx(SegmentedControl, {
              onChange: id => update({ aBInOn: id === 'on' }),
              options: [
                { id: 'off', label: '关闭' },
                { id: 'on', label: '开启' }
              ],
              value: s.aBInOn === true || s.aBInOn === 'on' ? 'on' : 'off'
            }),
            description: '气泡内侧的一圈柔光。',
            title: '内发光'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex items-start gap-4',
              children: [
                jsx(ColorSwatches, {
                  clearLabel: '恢复默认',
                  onChange: color => update({ aBInColor: color || '#7ee7ff' }),
                  swatches: GLOW_SWATCHES,
                  value: s.aBInColor
                }),
                jsxs('label', {
                  className: 'flex items-center gap-2 text-xs text-(--ui-text-tertiary)',
                  children: [
                    jsx('input', {
                      onChange: event => update({ aBInColor: event.target.value }),
                      type: 'color',
                      value: s.aBInColor
                    }),
                    '自定义'
                  ]
                })
              ]
            }),
            description: '内发光的颜色。',
            title: '内发光颜色'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 100,
                  min: 0,
                  onChange: event => update({ aBInStrength: Number(event.target.value) }),
                  step: 1,
                  type: 'range',
                  value: s.aBInStrength
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.aBInStrength} %`
                })
              ]
            }),
            description: '内发光的强度。',
            title: '内发光强度'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 40,
                  min: 0,
                  onChange: event => update({ aBInBlur: Number(event.target.value) }),
                  step: 1,
                  type: 'range',
                  value: s.aBInBlur
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.aBInBlur} px`
                })
              ]
            }),
            description: '柔光往里渗的半径。',
            title: '内发光半径'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 8,
                  min: 0.5,
                  onChange: event => update({ aBInWidth: Number(event.target.value) }),
                  step: 0.5,
                  type: 'range',
                  value: s.aBInWidth
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.aBInWidth} px`
                })
              ]
            }),
            description: '边缘光带的厚度。',
            title: '内发光厚度'
          }),

          jsx(ListRow, {
            action: jsx(SegmentedControl, {
              onChange: id => update({ aBOutOn: id === 'on' }),
              options: [
                { id: 'off', label: '关闭' },
                { id: 'on', label: '开启' }
              ],
              value: s.aBOutOn === true || s.aBOutOn === 'on' ? 'on' : 'off'
            }),
            description: '气泡外侧的一圈光。',
            title: '外发光'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex items-start gap-4',
              children: [
                jsx(ColorSwatches, {
                  clearLabel: '恢复默认',
                  onChange: color => update({ aBOutColor: color || '#4a84fe' }),
                  swatches: GLOW_SWATCHES,
                  value: s.aBOutColor
                }),
                jsxs('label', {
                  className: 'flex items-center gap-2 text-xs text-(--ui-text-tertiary)',
                  children: [
                    jsx('input', {
                      onChange: event => update({ aBOutColor: event.target.value }),
                      type: 'color',
                      value: s.aBOutColor
                    }),
                    '自定义'
                  ]
                })
              ]
            }),
            description: '外发光的颜色。',
            title: '外发光颜色'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 100,
                  min: 0,
                  onChange: event => update({ aBOutStrength: Number(event.target.value) }),
                  step: 1,
                  type: 'range',
                  value: s.aBOutStrength
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.aBOutStrength} %`
                })
              ]
            }),
            description: '外发光的强度。',
            title: '外发光强度'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 48,
                  min: 0,
                  onChange: event => update({ aBOutBlur: Number(event.target.value) }),
                  step: 1,
                  type: 'range',
                  value: s.aBOutBlur
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.aBOutBlur} px`
                })
              ]
            }),
            description: '光往外扩散的半径。',
            title: '外发光半径'
          }),

          jsx(ListRow, {
            action: jsx(SegmentedControl, {
              onChange: id => update({ aBOutFlow: id }),
              options: [
                { id: 'off', label: '关闭' },
                { id: 'on', label: '开启' }
              ],
              value: s.aBOutFlow === 'on' ? 'on' : 'off'
            }),
            description: '光带沿气泡边框转圈。',
            title: '外发光流动'
          }),

          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 20,
                  min: 1,
                  onChange: event => update({ aBOutSpeed: Number(event.target.value) }),
                  step: 0.5,
                  type: 'range',
                  value: s.aBOutSpeed
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.aBOutSpeed} s`
                })
              ]
            }),
            description: '转一圈的秒数，越小越快。',
            title: '流动速度'
          }),

                  bubbleAlignRow(s, update, 'aBubbleAlign', '气泡位置', '气泡靠左、居中或靠右。'),
          rangeRow(s, update, 'aBubbleWidth', 40, 100, 1, `${s.aBubbleWidth}%`, '气泡最宽占聊天区的多少。', '最大宽度'),
          lgxOnRow(s, update, 'lgxABubbleOn', '给 Hermes 发的气泡加磨砂。'),
          ...lgxRecipeRows(s, update, 'aBubble', 'Hermes 发的气泡'),
          rangeRow(s, update, 'lgxABubbleRadius', 0, 28, 1, `${s.lgxABubbleRadius ?? s.lgxBubbleRadius} px`, 'Hermes 发的气泡玻璃的圆角。', '玻璃圆角'),

]
      }),

      jsx(Section, {
        hint: '每次启动播一次的动画。',
        icon: 'play-circle',
        title: '开机动画',
        children: [

      jsx(ListRow, {
        action: jsx(SegmentedControl, {
          onChange: id => {
            update({ startupMode: id })

            if ((id === 'video' || id === 'image') && !$settings.get().startupPath) {
              pickStartupFile()
            }
          },
          options: [
            { id: 'off', label: '关闭' },
            { id: 'video', label: '视频' },
            { id: 'image', label: '图片' }
          ],
          value: s.startupMode
        }),
        description: '静音播放。',
        title: '开机动画'
      }),

      jsx(ListRow, {
        action: jsx(SegmentedControl, {
          onChange: id => update({ startupSkipEarly: id }),
          options: [
            { id: 'off', label: '不允许' },
            { id: 'on', label: '允许' }
          ],
          value: s.startupSkipEarly === 'on' ? 'on' : 'off'
        }),
        description: '允许在加载完成前跳过动画。',
        title: '加载完成前可跳过'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex flex-wrap items-center gap-2',
          onDragOver: event => event.preventDefault(),
          onDrop: event => {
            event.preventDefault()
            haptic('tap')

            const dropped = event.dataTransfer?.files?.[0]

            if (dropped) {
              adoptStartupFile(dropped)
            }
          },
          children: [
            jsx(Button, { onClick: () => addClips('startup'), children: '添加文件…' }),
            jsx(Button, { onClick: previewStartup, variant: 'default', children: '预览播放' }),
            jsx(Button, {
              onClick: () => {
                haptic('tap')
                rotateClip('startup')
              },
              variant: 'default',
              children: '换一条'
            }),
            s.startupClips.length
              ? jsx(Button, {
                  onClick: () => clearClips('startup'),
                  variant: 'textStrong',
                  children: '清空'
                })
              : null
          ]
        }),
        below: startupClipRows(s),
        description: `最多 10 条，启动时轮播；可拖文件到这行。`,
        title: '动画文件'
      }),

      jsx(ListRow, {
        action: jsx(SegmentedControl, {
          onChange: id => update({ startupRotation: id }),
          options: [
            { id: 'sequence', label: '顺序' },
            { id: 'random', label: '随机' }
          ],
          value: s.startupRotation
        }),
        description: '启动时换一条：顺序或随机。',
        title: '轮播方式'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex w-full items-center gap-3',
          children: [
            jsx('input', {
              className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
              max: 30,
              min: 1,
              onChange: event => update({ startupMaxSeconds: Number(event.target.value) }),
              step: 1,
              type: 'range',
              value: s.startupMaxSeconds
            }),
            jsx('span', {
              className: 'w-10 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
              children: `${s.startupMaxSeconds}s`
            })
          ]
        }),
        description: '动画最多播多久。',
        title: '最长播放时长'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex w-full items-center gap-3',
          children: [
            jsx('input', {
              className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
              max: 2000,
              min: 0,
              onChange: event => update({ startupFadeIn: Number(event.target.value) }),
              step: 100,
              type: 'range',
              value: s.startupFadeIn
            }),
            jsx('span', {
              className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
              children: `${s.startupFadeIn} ms`
            })
          ]
        }),
        description: '画面出现的过渡时长。',
        title: '淡入时长'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex w-full items-center gap-3',
          children: [
            jsx('input', {
              className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
              max: 1500,
              min: 0,
              onChange: event => update({ startupFadeOut: Number(event.target.value) }),
              step: 50,
              type: 'range',
              value: s.startupFadeOut
            }),
            jsx('span', {
              className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
              children: `${s.startupFadeOut} ms`
            })
          ]
        }),
        description: '收场的过渡时长。',
        title: '淡出时长'
      }),

      jsx(ListRow, {
        action: jsx(SegmentedControl, {
          onChange: id => update({ startupEnter: id }),
          options: [
            { id: 'fade', label: '淡入' },
            { id: 'zoom', label: '放大淡入' }
          ],
          value: s.startupEnter === 'zoom' ? 'zoom' : 'fade'
        }),
        description: '出场的效果方式。',
        title: '出场效果'
      }),

      jsx(ListRow, {
        action: jsx(SegmentedControl, {
          onChange: id => update({ startupExit: id }),
          options: [
            { id: 'fade', label: '淡出' },
            { id: 'shrink', label: '缩小淡出' }
          ],
          value: s.startupExit === 'shrink' ? 'shrink' : 'fade'
        }),
        description: '收场的效果方式。',
        title: '收场效果'
      }),

      jsx(ListRow, {
        action: jsxs('div', {
          className: 'flex w-full items-center gap-3',
          children: [
            jsx('input', {
              className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
              max: 40,
              min: 2,
              onChange: event => update({ startupZoom: Number(event.target.value) }),
              step: 1,
              type: 'range',
              value: s.startupZoom
            }),
            jsx('span', {
              className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
              children: `${s.startupZoom}%`
            })
          ]
        }),
        description: '缩放出入的幅度。',
        title: '缩放幅度'
      }),

      jsx(ListRow, {
        action: jsx(SegmentedControl, {
          onChange: id => update({ startupFit: id }),
          options: [
            { id: 'contain', label: '适应' },
            { id: 'cover', label: '铺满' }
          ],
          value: s.startupFit
        }),
        description: '画面适应还是铺满屏幕。',
        title: '画面填充'
      }),

      jsx(ListRow, {
        action: jsx(Button, {
          /* 开机动画只在启动时播一次，改了设置不重启根本看不到 —— 所以给个预览。
             playStartup 本来就支持 options.force 绕过「本次已播过」的闸门。 */
          onClick: () => {
            try {
              playStartup($settings.get(), { force: true })
            } catch (error) {
              host.notify({ kind: 'warn', message: '预览失败：' + String(error && error.message ? error.message : error) })
            }
          },
          variant: 'textStrong',
          children: '预览一次'
        }),
        description: '不用重启，立刻按现在的设置播一遍。',
        title: '预览'
      }),

      jsx(ListRow, {
        action: jsx(SegmentedControl, {
          onChange: id => update({ startupBackdrop: id }),
          options: [
            { id: 'black', label: '黑' },
            { id: 'theme', label: '主题色' },
            { id: 'transparent', label: '透明' }
          ],
          value: s.startupBackdrop
        }),
        description: '画面以外的底色。',
        title: '背景底色'
      }),
          ]
        }),

      jsx(Section, {
        hint: '点、拖、甩、右键的操作。',
        icon: 'heart',
        title: '桌宠交互',
        children: petInteractRows(s)
      }),

      jsx(Section, {
        hint: '输入框右下角的模型与推理弹窗。',
        icon: 'settings-gear',
        title: '模型弹窗',
        children: [
          jsx(ListRow, {
            action: jsx(SegmentedControl, {
              onChange: id => update({ effortSliderOn: id === 'on' }),
              options: [
                { id: 'off', label: '用原版' },
                { id: 'on', label: '用滑条' }
              ],
              value: s.effortSliderOn === true ? 'on' : 'off'
            }),
            description: '拖滑条选推理等级，松手生效。',
            title: '推理滑条'
          }),

          /* ── 下面这些开关以前只在代码里、设置页没有入口（用户报「没找到开关」）── */
          ...(() => {
            const sw = (key, title, description, offLabel, onLabel) =>
              jsx(ListRow, {
                action: jsx(SegmentedControl, {
                  /* ⚠️ 护栏：分段控件挂载时可能拿当前值回调一次 onChange —— 对**默认开**的开关，
           那一下会把 true 写成 false（「一打开设置页，锁定布局自己关了、功能像不存在」，
           用户报了两轮）。回调值与当前值相同 → 忽略、不写盘；用户真点击必然不同，照旧生效。 */
      onChange: id => {
        const cur = s[key] === true ? 'on' : 'off'

        if (id === cur) return

        update({ [key]: id === 'on' })
      },
                  options: [
                    { id: 'off', label: offLabel || '关' },
                    { id: 'on', label: onLabel || '开' }
                  ],
                  value: s[key] === true ? 'on' : 'off'
                }),
                description,
                title
              })

            return [
              sw('hideReasonPill', '收起「推理强度」那个小 pill', '收起输入框右下角那个箭头。', '显示', '收起'),
              sw('hideAppModelPill', '收起应用自己的模型 pill', '收起应用原生的模型名+箭头。', '显示', '收起'),
              sw('hideModelPillArrow', '模型名右边的箭头', '隐藏模型名右侧的箭头。', '显示', '隐藏'),
              sw('modelPillLabelOn', '在模型 pill 上显示「模型名 · 强度」', '在模型名旁直接显示强度。', '关', '显示'),
              sw('menuEffortOn', '把推理强度放进「模型列表」弹窗', '在模型列表里也放一条强度滑条。', '关', '放进去'),
              sw('pillFlowOn', '模型名 / 强度的文字流光', '按钮文字上流光。', '关', '开'),
            ]
          })(),
          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex w-full items-center gap-3',
              children: [
                jsx('input', {
                  className: 'h-1.5 w-full cursor-pointer accent-(--ui-accent)',
                  max: 28, min: 6,
                  onChange: event => update({ effortSliderHeight: Number(event.target.value) }),
                  step: 2, type: 'range', value: s.effortSliderHeight
                }),
                jsx('span', {
                  className: 'w-16 shrink-0 text-right text-xs text-(--ui-text-tertiary)',
                  children: `${s.effortSliderHeight} px`
                })
              ]
            }),
            description: '滑条轨道的粗细。',
            title: '滑条粗细'
          }),

                  lgxTriRow(s, update, 'lgxPopOn', '玻璃', '弹窗套上玻璃。'),
          ...lgxRecipeRows(s, update, 'pop', '弹窗'),
          rangeRow(s, update, 'lgxPopRadius', 0, 28, 1, `${s.lgxPopRadius} px`, '弹窗玻璃的圆角。', '玻璃圆角'),

]
      }),

      jsx(Section, {
        hint: '角落那根挂绳。',
        icon: 'link',
        title: '角落挂绳',
        children: ropeRows(s)
      }),

      jsx(Section, {
        hint: '思考方块的彩色流光。',
        icon: 'color-mode',
        title: '思考方块',
        children: flowRows(s)
      }),

      jsx(Section, {
        hint: '运行中那一行的流光与计时。',
        icon: 'pulse',
        title: '运行状态条',
        children: runFlowRows(s)
      }),

      jsx(Section, {
        hint: '窗口里的动画桌宠。',
        icon: 'heart',
        title: '桌宠',
        children: [...petRows(s), ...petSoundRows(s, update), ...petBalanceRows(s, update)]
      }),

      jsx(Section, {
        hint: '设置面板的磨砂。',
        icon: 'settings-gear',
        title: '磨砂',
        children: [
          lgxOnRow(s, update, 'lgxSettingsOn', '给设置面板加磨砂。'),
          rangeRow(s, update, 'lgxSettingsRadius', 0, 40, 1, `${s.lgxSettingsRadius} px`, '设置面板的圆角。', '圆角'),
          lgxTintRow(s, update, 'lgxSettingsTint', '磨砂颜色', '面板磨砂的底色。'),
          swRow(s, update, 'lgxSettingsRailOn', '左列一起磨砂', '左列导航也一起磨砂。', '保持原样', '一起磨砂'),
          lgxTintRow(s, update, 'lgxSettingsRailTint', '左列颜色', '左列磨砂的底色。'),
          ...lgxRecipeRows(s, update, 'settings', '设置面板'),
          swRow(s, update, 'segGlassOn', '选择框磨砂', '把「开关/选项」那种按钮做成磨砂底 + 内发光。', '原样', '磨砂'),
          jsx(ListRow, {
            action: jsxs('div', {
              className: 'flex items-center gap-3',
              children: [
                jsx('input', {
                  onChange: event => update({ segGlowColor: String(event.target.value || '#4dd0ff') }),
                  type: 'color',
                  value: s.segGlowColor || '#4dd0ff'
                }),
                jsx(Button, { onClick: () => update({ segGlowColor: '#4dd0ff' }), size: 'xs', variant: 'text', children: '恢复默认' })
              ]
            }),
            description: '选择框内发光的颜色。',
            title: '发光颜色'
          }),
          rangeRow(s, update, 'segGlowStrength', 0, 100, 5, `${s.segGlowStrength}%`, '内发光的强度。', '发光强度'),
          swRow(s, update, 'navAutoJumpOn', '打开设置直接进本页', '打开设置弹窗时自动切到「个性化设置」这一页。', '不自动', '自动进入'),
          swRow(s, update, 'navAutoOpenOn', '插件入口自动展开', '打开设置时把「插件」这一组展开，「个性化设置」直接可见。', '手动展开', '自动展开')
        ]
      }),

      jsx(Section, {
        hint: '保存、导入导出整套配置。',
        icon: 'archive',
        title: '配置存档',
        children: [
          jsx(ListRow, {
            action: jsx(Button, { onClick: savePreset, children: '保存当前配置…' }),
            description: `把现在的全部设置存成一份新存档。`,
            title: '保存当前配置'
          }),

          presets.length >= MAX_PRESETS
            ? jsx('div', {
                className: 'mt-2 text-xs text-(--dt-destructive)',
                children: `⚠️ 存档已满 ${MAX_PRESETS} 份：先删掉一份才能保存新的（不会自动删掉旧存档）。`
              })
            : null,

          presets.length
            ? jsxs('div', {
                className: 'mt-2 flex flex-col gap-2',
                children: presets.map(item =>
                  jsxs(
                    'div',
                    {
                      className: 'rounded-md border border-(--ui-stroke-secondary) p-2',
                      children: [
                        jsxs('div', {
                          className: 'flex items-center gap-2 text-xs',
                          children: [
                            jsx('span', {
                              className: 'shrink-0 font-semibold',
                              children: `${item.seq}.`
                            }),
                            jsx('span', {
                              className: 'shrink-0 text-(--ui-text-tertiary)',
                              children: timeText(item.at)
                            }),
                            jsx('span', {
                              className: 'min-w-0 flex-1 truncate text-(--ui-text-tertiary)',
                              children: presetSummary(item.settings)
                            })
                          ]
                        }),
                        jsxs('div', {
                          className: 'mt-2 flex flex-wrap items-center gap-2 text-xs',
                          children: [
                            jsx(Button, { onClick: () => readPreset(item.seq), children: '读取' }),
                            jsx(Button, {
                              onClick: () => overwritePreset(item.seq),
                              variant: 'default',
                              children: '覆盖为当前'
                            }),
                            jsx(Button, {
                              onClick: () => removePreset(item.seq),
                              variant: 'textStrong',
                              children: '删除'
                            })
                          ]
                        })
                      ]
                    },
                    `preset-${item.seq}`
                  )
                )
              })
            : jsx('div', {
                className: 'mt-2 text-xs text-(--ui-text-tertiary)',
                children: '还没有存档。调好一套满意效果后按上面的按钮存一份。'
              }),

        jsx(ListRow, {
          action: jsx(Button, {
            onClick: () => {
              haptic('tap')
              exportBundle()
                .then(info => host.notify({
                  kind: info.failed.length ? 'error' : 'info',
                  message: info.failed.length
                    ? `已导出配置包：带上了 ${info.media} 个素材，另有 ${info.failed.length} 个读不到（已跳过）。`
                    : `已导出配置包：设置 + ${info.media} 个素材。`
                }))
                .catch(err => host.notify({ kind: 'error', message: `导出失败：${String((err && err.message) || err)}` }))
            },
            children: '导出配置包…'
          }),
          description: '把设置和正在用的素材存成 .zip。',
          title: '导出配置包'
        }),

        swRow(s, update, 'bundleWithMedia', '导出：包含素材', '导出时是否打包正在用的素材。'),

        swRow(s, update, 'bundleImportMedia', '导入：使用包里的素材', '导入时是否使用包里的素材。'),

        jsx(ListRow, {
          action: jsx(Button, {
            onClick: () => {
              haptic('tap')
              pickBundleFile()
            },
            variant: 'default',
            children: '导入配置包…'
          }),
          description: '导入一个 .zip 配置包。',
          title: '导入配置包'
        })
]
      }),

      jsx(Section, {
        hint: '自定义鼠标光标。',
        icon: 'symbol-color',
        title: '鼠标设置',
        children: cursorRows(s, update)
      }),

      jsx(Section, {
        hint: '启动时先看到这一页；外观也在这里调。',
        icon: 'rocket',
        title: '首页设置',
        children: welcomeRows(s, update)
      }),

      jsx(Section, {
        hint: '问你要答案的那个卡片。',
        icon: 'question',
        title: '问询弹窗',
        children: askRows(s, update)
      }),

      jsx(Section, {
        hint: '锁住窗格与会话的位置。',
        icon: 'lock',
        title: '锁定布局',
        children: [
          swRow(s, update, 'layoutLockOn', '锁定窗口位置', '窗格、会话、列表都不能拖动。', '解锁', '锁定'),
          swRow(s, update, 'sashLockOn', '分隔条位置', '窗格之间的分隔条能不能拖动。', '解锁位置', '锁定位置')
        ]
      }),

      jsx(Section, {
        hint: '出问题时给我看的结果。',
        icon: 'bug',
        title: '自检',
        children: [
          jsx(ListRow, {
            below: jsx('div', {
              className: 'mt-2 rounded-md bg-(--ui-surface-sunken, rgba(255,255,255,.05)) p-2 text-[11px] leading-relaxed text-(--ui-text-tertiary)',
              children: effortDiagText()
            }),
            description: '读到的推理等级，可复制给我。',
            title: '实际读到的等级'
          }),
          jsx(SelfCheck, {})
        ]
      }),

      jsx(Section, {
        hint: '清掉本插件的全部设置。',
        icon: 'discard',
        title: '还原设置',
        children: [
          jsx(ListRow, {
            action: jsx(Button, {
              onClick: () => {
                haptic('tap')
                update({ ...DEFAULTS })
              },
              variant: 'textStrong',
              children: '还原默认'
            }),
            description: '清掉全部设置，回到原样。',
            title: '还原'
          })
        ]
      }),

    ]
  })

  /* 归类：输入框的都归到「输入框设置」、会话的都归到「会话设置」…… */
  return sortSettingsSections(page)
}

/* ── 插件入口 ───────────────────────────────────────────────────── */
export default {
  id: ID,
  name: '个性化设置',
  register(ctx) {
    ctxRef = ctx

    /* 先在 localStorage 层面把旧 id 的「设置 + 存档」搬过来，再去读 ctx.storage */
    migrateLegacyStorage()
    apply($settings.get())

    try {
      const stored = ctx.storage?.get?.(KEY)
      const adopt = value => {
        if (!value || typeof value !== 'object') return

        const merged = normalizeSettings(value)

        $settings.set(merged)
        apply(merged)
      }

      if (stored && typeof stored.then === 'function') {
        stored.then(adopt).catch(() => {})
      } else {
        adopt(stored)
      }
    } catch {
      /* 读不到就用默认值 */
    }

    try {
      const storedPresets = ctx.storage?.get?.(PRESET_KEY)
      const adoptPresets = value => {
        if (!Array.isArray(value)) return

        /* 刻意不裁剪：万一存里超过上限，也保持原样让用户自己删 */
        $presets.set(value.filter(item => item && typeof item === 'object' && item.settings))
      }

      if (storedPresets && typeof storedPresets.then === 'function') {
        storedPresets.then(adoptPresets).catch(() => {})
      } else {
        adoptPresets(storedPresets)
      }
    } catch {
      /* 读不到就没有存档 */
    }

    $settings.subscribe(value => apply(value))

    /* 旧版「自绘窗口圆点」已去掉：把可能残留的那几个圆点从 DOM 里清掉 */
    try {
      document.getElementById('hs-win-dots')?.remove()
    } catch {
      /* 没有就算了 */
    }

    /* 「会话区上下渐隐」已整个去掉：把可能残留的标记和内联变量清掉，不留痕迹 */
    try {
      for (const el of document.querySelectorAll('[data-hs-conv], [data-hs-fade]')) {
        el.removeAttribute('data-hs-conv')
        el.removeAttribute('data-hs-fade')
        el.style.removeProperty('--hs-mt')
        el.style.removeProperty('--hs-mb')
        el.style.removeProperty('--hs-conv-fade')
        el.style.removeProperty('--hs-conv-fade-top')
      }
    } catch {
      /* 没有就算了 */
    }
    /* 探测自带的「大肥鱼」素材目录在不在；在就把它登记成一个内置包 */
    void builtinPetProbe()
    /* 余额一变：既刷牌子文字，也按档位播动作 */
    $petBal.subscribe(value => {
      petBalApplyLevel($settings.get(), value)
      syncPetBalance($settings.get())
    })

    /* 设置弹窗里「插件」那一组是应用默认折叠的；这里无条件地周期性检查一次，
       不依赖锁定布局 / 别的功能的定时器（否则用户关掉那个功能就没人管了）。 */
    if (!navTimer) navTimer = setInterval(() => openPluginNavGroup($settings.get()), 900)

    /* 细线要跟着侧栏边缘走（窗口缩放 / 面板开合 / 自己拖完），这里常驻重定位；
       只在位置真的变了才写 DOM（避免每拍都动布局）。 */
    if (!sessDragTimer) {
      sessDragTimer = setInterval(() => {
        const cur = $settings.get()

        /* 每项各自兜住异常：一处出错不能连累其它标记（否则一个函数抛错，
           后面几项就永远补不上了）。 */
        /* 回复中跳过拖宽细线的定位：它要读 getBoundingClientRect（强制重排），
           而回复期间布局每帧都在动、细线位置也不会变，这活儿纯属浪费。 */
        if (!hsStreaming()) {
          try {
            syncSessDrag(cur)
          } catch {
            /* 忽略 */
          }
        }

        /* 应用重绘会把运行时标记冲掉，这里兜底补回来（主要靠 hsRemarkSoon 按需补） */
        try {
          syncSeg(cur)
        } catch {
          /* 忽略 */
        }

        try {
          syncSessHighlight(cur)
        } catch {
          /* 忽略 */
        }

        /* 输入框高度会变（多行、附件），内部铺底层也跟着换 —— 周期重扫一次 */
        try {
          syncComposerClear()
        } catch {
          /* 忽略 */
        }
      }, 1200)
    }

    /* DOM 一变 / 一滚动就按需补标记（这是让选择框磨砂、会话行高亮
       在设置弹窗关掉之后依然生效的关键） */
    hsRemarkHook()
    hsRemarkSoon()

    /* 载入标记：从本机的 Local Storage 数据文件里能读到「这一版真的被读进窗口了」，排障用 */
    try {
      localStorage.setItem('hermes.navProbe', JSON.stringify({ v: EFFORT_BUILD, at: Date.now(), stage: 'loaded' }))
    } catch {
      /* 写不了就算了 */
    }

    /* 1) 本插件自己的设置页：设置 → 插件 → 「个性化设置」 */
    if (typeof ctx.registerSettingsPage === 'function') {
      ctx.registerSettingsPage({
        icon: 'file-media',
        id: 'background',
        order: 5,
        render: () => jsx(BackgroundSettings, {}),
        title: '个性化设置'
      })
    }

    /* 2) 「设置 → 外观」主页面底部再留一份入口 */
    ctx.register({
      area: APPEARANCE_AREAS.extra,
      id: 'appearance-extra',
      render: () => jsx(BackgroundSettings, {})
    })

    /* 3) ⌘K 命令，直接跳到本插件的设置页 */
    ctx.register({
      area: PALETTE_AREA,
      data: {
        id: `${ID}.open`,
        keywords: ['background', 'wallpaper', 'ink', '背景', '壁纸', '字色', '颜色', '个性化', '设置'],
        label: '打开「个性化设置」',
        run: () => host.navigate(pluginSettingsHref(ID))
      },
      id: 'open-settings'
    })

    /* 4) 标题栏右侧（设置齿轮那一片）放一个音乐符号 */
    ctx.register({
      area: TITLEBAR_AREAS.right,
      id: 'music-button',
      render: () => jsx(MusicButton, {})
    })

    /* 5) 启动时按轮播方式给背景、开机动画各换一条（每个窗口会话只换一次），
          再播一次开机动画（自带同样的「只播一次」保护）。
          这里**不延迟**：开机动画要尽早盖住窗口，否则应用自己的启动画面会先露出来。 */
    setTimeout(() => {
      rotateOncePerLaunch()
      playStartup($settings.get())
    }, 0)
  }
}
