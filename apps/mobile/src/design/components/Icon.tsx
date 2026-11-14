import type { ComponentType } from 'react';
import type { CategoryIcon } from '@manaclaude/shared';
import { useUnistyles } from 'react-native-unistyles';
import ArrowLeftRight from 'lucide-react-native/icons/arrow-left-right';
import Baby from 'lucide-react-native/icons/baby';
import Banknote from 'lucide-react-native/icons/banknote';
import Bell from 'lucide-react-native/icons/bell';
import Book from 'lucide-react-native/icons/book';
import Bot from 'lucide-react-native/icons/bot';
import Briefcase from 'lucide-react-native/icons/briefcase';
import Building from 'lucide-react-native/icons/building';
import Bus from 'lucide-react-native/icons/bus';
import Calendar from 'lucide-react-native/icons/calendar';
import Camera from 'lucide-react-native/icons/camera';
import Car from 'lucide-react-native/icons/car';
import ChartLine from 'lucide-react-native/icons/chart-line';
import ChartPie from 'lucide-react-native/icons/chart-pie';
import Check from 'lucide-react-native/icons/check';
import ChevronDown from 'lucide-react-native/icons/chevron-down';
import ChevronLeft from 'lucide-react-native/icons/chevron-left';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import ChevronUp from 'lucide-react-native/icons/chevron-up';
import Circle from 'lucide-react-native/icons/circle';
import Clock from 'lucide-react-native/icons/clock';
import CloudOff from 'lucide-react-native/icons/cloud-off';
import Coffee from 'lucide-react-native/icons/coffee';
import Coins from 'lucide-react-native/icons/coins';
import Copy from 'lucide-react-native/icons/copy';
import CreditCard from 'lucide-react-native/icons/credit-card';
import Dumbbell from 'lucide-react-native/icons/dumbbell';
import Ellipsis from 'lucide-react-native/icons/ellipsis';
import ExternalLink from 'lucide-react-native/icons/external-link';
import FileUp from 'lucide-react-native/icons/file-up';
import Film from 'lucide-react-native/icons/film';
import Fuel from 'lucide-react-native/icons/fuel';
import Funnel from 'lucide-react-native/icons/funnel';
import Gamepad from 'lucide-react-native/icons/gamepad-2';
import Gift from 'lucide-react-native/icons/gift';
import Globe from 'lucide-react-native/icons/globe';
import GraduationCap from 'lucide-react-native/icons/graduation-cap';
import HeartPulse from 'lucide-react-native/icons/heart-pulse';
import House from 'lucide-react-native/icons/house';
import Info from 'lucide-react-native/icons/info';
import KeyRound from 'lucide-react-native/icons/key-round';
import Landmark from 'lucide-react-native/icons/landmark';
import LayoutDashboard from 'lucide-react-native/icons/layout-dashboard';
import Link2 from 'lucide-react-native/icons/link-2';
import List from 'lucide-react-native/icons/list';
import Lock from 'lucide-react-native/icons/lock';
import Monitor from 'lucide-react-native/icons/monitor';
import Moon from 'lucide-react-native/icons/moon';
import Music from 'lucide-react-native/icons/music';
import Paperclip from 'lucide-react-native/icons/paperclip';
import PawPrint from 'lucide-react-native/icons/paw-print';
import Percent from 'lucide-react-native/icons/percent';
import PiggyBank from 'lucide-react-native/icons/piggy-bank';
import Pill from 'lucide-react-native/icons/pill';
import Plane from 'lucide-react-native/icons/plane';
import Plus from 'lucide-react-native/icons/plus';
import Receipt from 'lucide-react-native/icons/receipt';
import RefreshCw from 'lucide-react-native/icons/refresh-cw';
import Repeat from 'lucide-react-native/icons/repeat';
import Scissors from 'lucide-react-native/icons/scissors';
import Search from 'lucide-react-native/icons/search';
import Settings from 'lucide-react-native/icons/settings';
import Shield from 'lucide-react-native/icons/shield';
import Shirt from 'lucide-react-native/icons/shirt';
import ShoppingBag from 'lucide-react-native/icons/shopping-bag';
import ShoppingCart from 'lucide-react-native/icons/shopping-cart';
import SlidersHorizontal from 'lucide-react-native/icons/sliders-horizontal';
import Smartphone from 'lucide-react-native/icons/smartphone';
import Sparkles from 'lucide-react-native/icons/sparkles';
import Split from 'lucide-react-native/icons/split';
import Sun from 'lucide-react-native/icons/sun';
import Tag from 'lucide-react-native/icons/tag';
import TrendingDown from 'lucide-react-native/icons/trending-down';
import TrendingUp from 'lucide-react-native/icons/trending-up';
import TriangleAlert from 'lucide-react-native/icons/triangle-alert';
import Utensils from 'lucide-react-native/icons/utensils';
import Vibrate from 'lucide-react-native/icons/vibrate';
import Wallet from 'lucide-react-native/icons/wallet';
import Wifi from 'lucide-react-native/icons/wifi';
import Wrench from 'lucide-react-native/icons/wrench';
import X from 'lucide-react-native/icons/x';
import Zap from 'lucide-react-native/icons/zap';
import { toneColor, type TextTone } from './Text';

/**
 * Icons come from Lucide (ISC licence), a general-purpose open icon set. No
 * other app's icons are used. Add a name here before using a new icon.
 */
type LucideLike = ComponentType<{ color?: string; size?: number; strokeWidth?: number }>;

const UI_ICONS = {
  'arrow-left-right': ArrowLeftRight,
  bell: Bell,
  bot: Bot,
  building: Building,
  calendar: Calendar,
  camera: Camera,
  'chart-line': ChartLine,
  'chart-pie': ChartPie,
  check: Check,
  'chevron-down': ChevronDown,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'chevron-up': ChevronUp,
  clock: Clock,
  'cloud-off': CloudOff,
  coins: Coins,
  copy: Copy,
  ellipsis: Ellipsis,
  'external-link': ExternalLink,
  'file-up': FileUp,
  funnel: Funnel,
  info: Info,
  'key-round': KeyRound,
  'layout-dashboard': LayoutDashboard,
  link: Link2,
  list: List,
  lock: Lock,
  monitor: Monitor,
  moon: Moon,
  paperclip: Paperclip,
  plus: Plus,
  'refresh-cw': RefreshCw,
  search: Search,
  settings: Settings,
  'sliders-horizontal': SlidersHorizontal,
  smartphone: Smartphone,
  split: Split,
  sun: Sun,
  'trending-down': TrendingDown,
  'triangle-alert': TriangleAlert,
  vibrate: Vibrate,
  wallet: Wallet,
  x: X,
} satisfies Record<string, LucideLike>;

const CATEGORY_ICONS: Record<CategoryIcon, LucideLike> = {
  home: House,
  utensils: Utensils,
  'shopping-cart': ShoppingCart,
  coffee: Coffee,
  car: Car,
  fuel: Fuel,
  bus: Bus,
  plane: Plane,
  'heart-pulse': HeartPulse,
  pill: Pill,
  film: Film,
  music: Music,
  gamepad: Gamepad,
  zap: Zap,
  wifi: Wifi,
  phone: Smartphone,
  gift: Gift,
  book: Book,
  'graduation-cap': GraduationCap,
  briefcase: Briefcase,
  banknote: Banknote,
  'trending-up': TrendingUp,
  percent: Percent,
  landmark: Landmark,
  'piggy-bank': PiggyBank,
  repeat: Repeat,
  'credit-card': CreditCard,
  shield: Shield,
  'shopping-bag': ShoppingBag,
  shirt: Shirt,
  scissors: Scissors,
  dumbbell: Dumbbell,
  'paw-print': PawPrint,
  baby: Baby,
  wrench: Wrench,
  receipt: Receipt,
  globe: Globe,
  tag: Tag,
  sparkles: Sparkles,
  circle: Circle,
};

export type IconName = keyof typeof UI_ICONS | CategoryIcon;

const ALL: Record<IconName, LucideLike> = { ...CATEGORY_ICONS, ...UI_ICONS };

export type IconSize = 'xs' | 'sm' | 'md' | 'lg';

export interface IconProps {
  name: IconName;
  size?: IconSize;
  tone?: TextTone;
  /** Overrides tone; pass a theme colour (theme.colors.category.c3), never a literal. */
  color?: string;
  strokeWidth?: number;
}

export function Icon({ name, size = 'md', tone = 'default', color, strokeWidth = 2 }: IconProps) {
  const { theme } = useUnistyles();
  const Component = ALL[name] ?? Circle;
  const px = {
    xs: theme.size.iconXs,
    sm: theme.size.iconSm,
    md: theme.size.iconMd,
    lg: theme.size.iconLg,
  }[size];
  return <Component size={px} color={color ?? toneColor(theme, tone)} strokeWidth={strokeWidth} />;
}
