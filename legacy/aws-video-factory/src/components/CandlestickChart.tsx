import React from 'react';
import { interpolate, useCurrentFrame, spring, useVideoConfig } from 'remotion';
import type { OHLCBar } from '../types';

interface CandlestickChartProps {
  data: OHLCBar[];
  width: number;
  height: number;
  supportLevel?: number;
  resistanceLevel?: number;
  annotation?: string;
  direction: 'up' | 'down' | 'flat';
}

export const CandlestickChart: React.FC<CandlestickChartProps> = ({
  data,
  width,
  height,
  supportLevel,
  resistanceLevel,
  annotation,
  direction,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  if (!data || data.length === 0) return null;

  // Show last 30 candles for good visibility
  const visibleData = data.slice(-30);
  const padding = { top: 30, right: 100, bottom: 50, left: 30 };

  // Price range with padding
  const allHighs = visibleData.map((d) => d.high);
  const allLows = visibleData.map((d) => d.low);
  const prices = [...allHighs, ...allLows];
  if (supportLevel) prices.push(supportLevel);
  if (resistanceLevel) prices.push(resistanceLevel);
  const rawMin = Math.min(...prices);
  const rawMax = Math.max(...prices);
  const rangePad = (rawMax - rawMin) * 0.08;
  const minPrice = rawMin - rangePad;
  const maxPrice = rawMax + rangePad;
  const priceRange = maxPrice - minPrice;

  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;
  const slotWidth = chartW / visibleData.length;
  const candleW = Math.max(6, slotWidth * 0.55);
  const gap = slotWidth;

  const priceToY = (p: number) => padding.top + chartH - ((p - minPrice) / priceRange) * chartH;

  // Animate: candles draw left-to-right
  const revealProgress = spring({ frame, fps, config: { damping: 80, stiffness: 40 }, durationInFrames: 50 });
  const visibleCount = Math.floor(revealProgress * visibleData.length);

  // Animate: levels appear after candles
  const levelProgress = interpolate(frame, [35, 50], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const annotationProgress = interpolate(frame, [50, 65], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  // Grid price levels (4 levels)
  const gridLevels = [0.2, 0.4, 0.6, 0.8].map((pct) => ({
    y: padding.top + chartH * pct,
    price: maxPrice - priceRange * pct,
  }));

  return (
    <svg width={width} height={height} style={{ overflow: 'visible' }}>
      {/* Background gradient */}
      <defs>
        <linearGradient id="chartBg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0f172a" />
          <stop offset="100%" stopColor="#1e293b" />
        </linearGradient>
        <linearGradient id="greenGlow" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#22c55e" stopOpacity="0.15" />
          <stop offset="100%" stopColor="#22c55e" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="redGlow" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ef4444" stopOpacity="0" />
          <stop offset="100%" stopColor="#ef4444" stopOpacity="0.15" />
        </linearGradient>
      </defs>

      <rect x={padding.left} y={padding.top} width={chartW} height={chartH} fill="url(#chartBg)" rx={8} />

      {/* Grid lines */}
      {gridLevels.map((g, i) => (
        <g key={i}>
          <line x1={padding.left} y1={g.y} x2={padding.left + chartW} y2={g.y} stroke="#1e293b" strokeWidth={1} />
          <text x={padding.left + chartW + 12} y={g.y + 5} fill="#475569" fontSize={14} fontFamily="system-ui" fontWeight={500}>
            {g.price.toFixed(0)}
          </text>
        </g>
      ))}

      {/* Area fill under last close prices */}
      {visibleCount > 1 && (
        <path
          d={
            `M ${padding.left + 0.5 * gap} ${priceToY(visibleData[0].close)} ` +
            visibleData.slice(0, visibleCount).map((d, i) => `L ${padding.left + i * gap + gap / 2} ${priceToY(d.close)}`).join(' ') +
            ` L ${padding.left + (visibleCount - 1) * gap + gap / 2} ${padding.top + chartH} ` +
            ` L ${padding.left + gap / 2} ${padding.top + chartH} Z`
          }
          fill={direction === 'up' ? 'url(#greenGlow)' : 'url(#redGlow)'}
        />
      )}

      {/* Price line connecting closes */}
      {visibleCount > 1 && (
        <path
          d={visibleData.slice(0, visibleCount).map((d, i) =>
            `${i === 0 ? 'M' : 'L'} ${padding.left + i * gap + gap / 2} ${priceToY(d.close)}`
          ).join(' ')}
          fill="none"
          stroke={direction === 'up' ? '#22c55e44' : '#ef444444'}
          strokeWidth={1.5}
        />
      )}

      {/* Candlesticks */}
      {visibleData.slice(0, visibleCount).map((bar, i) => {
        const x = padding.left + i * gap + gap / 2;
        const isGreen = bar.close >= bar.open;
        const color = isGreen ? '#22c55e' : '#ef4444';
        const bodyTop = priceToY(Math.max(bar.open, bar.close));
        const bodyBot = priceToY(Math.min(bar.open, bar.close));
        const bodyH = Math.max(2, bodyBot - bodyTop);

        // Slight glow on last candle
        const isLast = i === visibleCount - 1;
        const glowFilter = isLast ? `drop-shadow(0 0 6px ${color}88)` : undefined;

        return (
          <g key={i} style={{ filter: glowFilter }}>
            {/* Wick */}
            <line x1={x} y1={priceToY(bar.high)} x2={x} y2={priceToY(bar.low)} stroke={color} strokeWidth={1.5} strokeLinecap="round" />
            {/* Body */}
            <rect x={x - candleW / 2} y={bodyTop} width={candleW} height={bodyH} fill={color} rx={2} />
          </g>
        );
      })}

      {/* Support level */}
      {supportLevel && (
        <g opacity={levelProgress}>
          <line x1={padding.left} y1={priceToY(supportLevel)} x2={padding.left + chartW} y2={priceToY(supportLevel)} stroke="#3b82f6" strokeWidth={2} strokeDasharray="10,6" />
          <rect x={padding.left + chartW + 4} y={priceToY(supportLevel) - 14} width={90} height={24} rx={4} fill="#3b82f6" />
          <text x={padding.left + chartW + 50} y={priceToY(supportLevel) + 4} fill="#fff" fontSize={13} fontWeight={700} fontFamily="system-ui" textAnchor="middle">
            S {supportLevel.toLocaleString()}
          </text>
        </g>
      )}

      {/* Resistance level */}
      {resistanceLevel && (
        <g opacity={levelProgress}>
          <line x1={padding.left} y1={priceToY(resistanceLevel)} x2={padding.left + chartW} y2={priceToY(resistanceLevel)} stroke="#f97316" strokeWidth={2} strokeDasharray="10,6" />
          <rect x={padding.left + chartW + 4} y={priceToY(resistanceLevel) - 14} width={90} height={24} rx={4} fill="#f97316" />
          <text x={padding.left + chartW + 50} y={priceToY(resistanceLevel) + 4} fill="#fff" fontSize={13} fontWeight={700} fontFamily="system-ui" textAnchor="middle">
            R {resistanceLevel.toLocaleString()}
          </text>
        </g>
      )}

      {/* Annotation badge */}
      {annotation && (
        <g opacity={annotationProgress}>
          <rect x={padding.left + chartW / 2 - 200} y={padding.top + 16} width={400} height={40} rx={8} fill="rgba(16, 185, 129, 0.95)" />
          <text x={padding.left + chartW / 2} y={padding.top + 42} fill="#fff" fontSize={18} fontWeight={700} fontFamily="system-ui" textAnchor="middle">
            {annotation}
          </text>
        </g>
      )}
    </svg>
  );
};
