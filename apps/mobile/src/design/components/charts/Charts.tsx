import { useMemo, useRef, useState, type ReactNode } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import Svg, { Circle, Defs, G, Line, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { haptic } from '../../haptics';
import { Text } from '../Text';
import { arcPath, areaPath, extent, linePath, nearestIndex, toPoints } from './paths';

/**
 * Chart wrapper and charts. Colours, sizes and motion come from the theme;
 * callers pass data and a semantic colour role, never a colour value.
 */

export type ChartRole = 'income' | 'spending' | 'netWorth' | 'pending' | 'accent';

function useRoleColor(role: ChartRole): string {
  const { theme } = useUnistyles();
  return theme.colors[role];
}

function useWidth(): [number, (e: LayoutChangeEvent) => void] {
  const [width, setWidth] = useState(0);
  return [width, (e) => setWidth(Math.round(e.nativeEvent.layout.width))];
}

// ---------------------------------------------------------------------------
// Line / area chart with scrubbing
// ---------------------------------------------------------------------------

export interface LineChartProps {
  /** Main series. */
  values: readonly number[];
  /** Optional comparison series (last month), drawn dashed and muted. */
  compare?: readonly number[];
  /** Number of x slots; lets "this month so far" stop part-way across. */
  slots?: number;
  role?: ChartRole;
  height?: 'regular' | 'small';
  /** Called with the scrubbed index, or null when the finger lifts. */
  onScrub?: (index: number | null) => void;
  /** Fill under the line. */
  area?: boolean;
  accessibilityLabel: string;
  testID?: string;
}

export function LineChart({
  values,
  compare,
  slots,
  role = 'netWorth',
  height = 'regular',
  onScrub,
  area = true,
  accessibilityLabel,
  testID,
}: LineChartProps) {
  const { theme } = useUnistyles();
  const color = useRoleColor(role);
  const [width, onLayout] = useWidth();
  const h = height === 'small' ? theme.size.chartHeightSmall : theme.size.chartHeight;
  const [active, setActive] = useState<number | null>(null);
  const lastIndex = useRef<number | null>(null);
  const gradientId = `grad-${role}`;
  const pad = theme.space.sm;
  const total = Math.max(slots ?? values.length, compare?.length ?? 0, values.length);

  const geometry = useMemo(() => {
    if (width === 0) return null;
    const domain = extent(compare ? [values, compare] : [values]);
    const pts = toPoints(values, width, h, domain, total, pad, pad);
    const cmp = compare ? toPoints(compare, width, h, domain, total, pad, pad) : null;
    return {
      pts,
      cmp,
      line: linePath(pts),
      fill: areaPath(pts, h),
      cmpLine: cmp ? linePath(cmp) : '',
    };
  }, [width, h, values, compare, total, pad]);

  const update = (x: number) => {
    if (!geometry) return;
    const i = nearestIndex(geometry.pts, x);
    if (i !== lastIndex.current) {
      lastIndex.current = i;
      setActive(i);
      onScrub?.(i);
      haptic('tick');
    }
  };
  const end = () => {
    lastIndex.current = null;
    setActive(null);
    onScrub?.(null);
  };
  const pan = usePanGesture({
    runOnJS: true,
    activeOffsetX: [-4, 4],
    failOffsetY: [-12, 12],
    onBegin: (e) => update(e.x),
    onUpdate: (e) => update(e.x),
    onFinalize: () => end(),
  });

  const activePoint = active !== null ? geometry?.pts[active] : undefined;

  return (
    <GestureDetector gesture={pan}>
      <View
        onLayout={onLayout}
        style={styles.chart(h)}
        accessibilityRole="image"
        accessibilityLabel={accessibilityLabel}
        testID={testID}
      >
        {geometry ? (
          <Svg width={width} height={h}>
            <Defs>
              <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <Stop
                  offset="0"
                  stopColor={color}
                  stopOpacity={theme.scheme === 'dark' ? 0.32 : 0.2}
                />
                <Stop offset="1" stopColor={color} stopOpacity={0} />
              </LinearGradient>
            </Defs>
            {geometry.cmp ? (
              <Path
                d={geometry.cmpLine}
                stroke={theme.colors.chartComparison}
                strokeWidth={2}
                strokeDasharray="4 5"
                fill="none"
              />
            ) : null}
            {area ? <Path d={geometry.fill} fill={`url(#${gradientId})`} /> : null}
            <Path
              d={geometry.line}
              stroke={color}
              strokeWidth={2.5}
              fill="none"
              strokeLinecap="round"
            />
            {activePoint ? (
              <>
                <Line
                  x1={activePoint.x}
                  x2={activePoint.x}
                  y1={0}
                  y2={h}
                  stroke={theme.colors.borderStrong}
                  strokeWidth={1}
                />
                <Circle
                  cx={activePoint.x}
                  cy={activePoint.y}
                  r={5}
                  fill={color}
                  stroke={theme.colors.surface}
                  strokeWidth={2}
                />
              </>
            ) : (
              (() => {
                const last = geometry.pts[geometry.pts.length - 1];
                return last ? <Circle cx={last.x} cy={last.y} r={4} fill={color} /> : null;
              })()
            )}
          </Svg>
        ) : null}
      </View>
    </GestureDetector>
  );
}

// ---------------------------------------------------------------------------
// Sparkline (no interaction)
// ---------------------------------------------------------------------------

export function Sparkline({
  values,
  role = 'netWorth',
  accessibilityLabel,
}: {
  values: readonly number[];
  role?: ChartRole;
  accessibilityLabel: string;
}) {
  const { theme } = useUnistyles();
  const color = useRoleColor(role);
  const [width, onLayout] = useWidth();
  const h = theme.size.chartHeightSmall / 2;
  const d = useMemo(
    () =>
      width ? linePath(toPoints(values, width, h, extent([values]), values.length, 2, 2)) : '',
    [values, width, h],
  );
  return (
    <View
      onLayout={onLayout}
      style={styles.chart(h)}
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
    >
      {width ? (
        <Svg width={width} height={h}>
          <Path d={d} stroke={color} strokeWidth={1.75} fill="none" strokeLinecap="round" />
        </Svg>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Bar chart (income vs spending by month, spending by category)
// ---------------------------------------------------------------------------

export interface BarDatum {
  label: string;
  value: number;
  /** Second bar in the group (income next to spending). */
  value2?: number;
}

export interface BarChartProps {
  data: readonly BarDatum[];
  role?: ChartRole;
  role2?: ChartRole;
  /** Highlight one bar (the current month). */
  highlightIndex?: number;
  onSelect?: (index: number) => void;
  accessibilityLabel: string;
}

export function BarChart({
  data,
  role = 'spending',
  role2 = 'income',
  highlightIndex,
  onSelect,
  accessibilityLabel,
}: BarChartProps) {
  const { theme } = useUnistyles();
  const c1 = useRoleColor(role);
  const c2 = useRoleColor(role2);
  const [width, onLayout] = useWidth();
  const h = theme.size.chartHeight * 0.7;
  const labelH = theme.type.micro.lineHeight + theme.space.xs;
  const max = Math.max(1, ...data.map((d) => Math.max(d.value, d.value2 ?? 0)));
  const groups = data.length;
  const groupW = groups ? width / groups : 0;
  const paired = data.some((d) => d.value2 !== undefined);
  const barW = Math.max(
    3,
    Math.min(theme.space.xl, (groupW - theme.space.sm) / (paired ? 2 : 1) - theme.space.xxs),
  );
  return (
    <View accessibilityRole="image" accessibilityLabel={accessibilityLabel}>
      <View onLayout={onLayout} style={styles.chart(h)}>
        {width ? (
          <Svg width={width} height={h}>
            {data.map((d, i) => {
              const cx = i * groupW + groupW / 2;
              const dim = highlightIndex !== undefined && highlightIndex !== i;
              const bh1 = Math.max(2, (d.value / max) * (h - theme.space.xs));
              const bh2 =
                d.value2 !== undefined ? Math.max(2, (d.value2 / max) * (h - theme.space.xs)) : 0;
              const x1 = paired ? cx - barW - theme.space.xxs / 2 : cx - barW / 2;
              return (
                <G key={d.label}>
                  <Rect
                    x={x1}
                    y={h - bh1}
                    width={barW}
                    height={bh1}
                    rx={Math.min(theme.radius.sm, barW / 2)}
                    fill={c1}
                    opacity={dim ? 0.35 : 1}
                    onPress={onSelect ? () => onSelect(i) : undefined}
                  />
                  {paired ? (
                    <Rect
                      x={cx + theme.space.xxs / 2}
                      y={h - bh2}
                      width={barW}
                      height={bh2}
                      rx={Math.min(theme.radius.sm, barW / 2)}
                      fill={c2}
                      opacity={dim ? 0.35 : 1}
                      onPress={onSelect ? () => onSelect(i) : undefined}
                    />
                  ) : null}
                </G>
              );
            })}
          </Svg>
        ) : null}
      </View>
      <View style={styles.barLabels(labelH)}>
        {data.map((d, i) => (
          <Text
            key={d.label}
            variant="micro"
            tone={highlightIndex === i ? 'default' : 'faint'}
            align="center"
            style={styles.barLabel}
            numberOfLines={1}
          >
            {d.label}
          </Text>
        ))}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Donut (allocation, spending by category)
// ---------------------------------------------------------------------------

export interface DonutSegment {
  key: string;
  value: number;
  /** A theme colour (theme.colors.category.c1 etc.). */
  color: string;
}

export function DonutChart({
  segments,
  size = 'regular',
  center,
  accessibilityLabel,
}: {
  segments: readonly DonutSegment[];
  size?: 'regular' | 'small';
  center?: ReactNode;
  accessibilityLabel: string;
}) {
  const { theme } = useUnistyles();
  const dim = size === 'small' ? theme.size.chartHeight * 0.6 : theme.size.chartHeight * 0.9;
  const stroke = size === 'small' ? theme.space.md : theme.space.lg;
  const r = dim / 2 - stroke / 2;
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0) || 1;
  const gap = segments.length > 1 ? 0.025 : 0;
  const arcs: { key: string; color: string; d: string }[] = [];
  let angle = 0;
  for (const s of segments) {
    const sweep = (Math.max(0, s.value) / total) * Math.PI * 2;
    const start = angle + gap / 2;
    const end = angle + sweep - gap / 2;
    angle += sweep;
    if (end > start)
      arcs.push({ key: s.key, color: s.color, d: arcPath(dim / 2, dim / 2, r, start, end) });
  }
  return (
    <View
      style={styles.donut(dim)}
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
    >
      <Svg width={dim} height={dim}>
        <Circle
          cx={dim / 2}
          cy={dim / 2}
          r={r}
          stroke={theme.colors.surfaceSunken}
          strokeWidth={stroke}
          fill="none"
        />
        {arcs.map((a) => (
          <Path
            key={a.key}
            d={a.d}
            stroke={a.color}
            strokeWidth={stroke}
            strokeLinecap="butt"
            fill="none"
          />
        ))}
      </Svg>
      {center ? <View style={styles.donutCenter}>{center}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  chart: (height: number) => ({ height, width: '100%' }),
  barLabels: (height: number) => ({ flexDirection: 'row', height, alignItems: 'flex-end' }),
  barLabel: { flex: 1 },
  donut: (dim: number) => ({
    width: dim,
    height: dim,
    alignItems: 'center',
    justifyContent: 'center',
  }),
  donutCenter: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space.xxs,
  },
}));
