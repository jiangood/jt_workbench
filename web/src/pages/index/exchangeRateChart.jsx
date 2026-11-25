import React, {useEffect, useId, useMemo, useState} from 'react';

const WIDTH = 420;
const HEIGHT = 190;
const PAD = {left: 54, right: 12, top: 14, bottom: 28};

function pointTime(point) {
    return Date.parse(`${point.date}T00:00:00Z`);
}

function shortDate(date) {
    return String(date || '').slice(5);
}

/** 轻量 SVG 日线趋势：支持悬停、键盘查看每日数值，并保留可见的区间摘要。 */
export default function ExchangeRateChart({history = []}) {
    const gradientId = `exchange-fill-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const [activeIndex, setActiveIndex] = useState(null);
    const points = useMemo(() => (history || [])
        .filter((point) => point && /^\d{4}-\d{2}-\d{2}$/.test(point.date) && Number.isFinite(Number(point.close)))
        .map((point) => ({date: point.date, close: Number(point.close)}))
        .sort((a, b) => a.date.localeCompare(b.date)), [history]);

    useEffect(() => {
        setActiveIndex(null);
    }, [history]);

    if (points.length < 2) {
        return (
            <div style={{height: 170, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999', fontSize: 12}}>
                暂无足够趋势数据
            </div>
        );
    }

    const values = points.map((point) => point.close);
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const rawRange = Math.max(rawMax - rawMin, 0.002);
    const min = rawMin - rawRange * 0.14;
    const max = rawMax + rawRange * 0.14;
    const times = points.map(pointTime);
    const startTime = times[0];
    const endTime = times[times.length - 1];
    const timeRange = Math.max(endTime - startTime, 1);
    const plotWidth = WIDTH - PAD.left - PAD.right;
    const plotHeight = HEIGHT - PAD.top - PAD.bottom;
    const x = (time) => PAD.left + ((time - startTime) / timeRange) * plotWidth;
    const y = (value) => PAD.top + ((max - value) / (max - min)) * plotHeight;
    const coords = points.map((point, index) => ({x: x(times[index]), y: y(point.close)}));
    const line = coords.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
    const area = `${line} L ${coords[coords.length - 1].x.toFixed(2)} ${(HEIGHT - PAD.bottom).toFixed(2)} L ${coords[0].x.toFixed(2)} ${(HEIGHT - PAD.bottom).toFixed(2)} Z`;
    const last = values[values.length - 1];
    const first = values[0];
    const rising = last >= first;
    const stroke = rising ? '#cf1322' : '#389e0d';
    const fill = rising ? 'rgba(207,19,34,0.10)' : 'rgba(56,158,13,0.10)';
    const yTicks = Array.from({length: 4}, (_, index) => min + ((max - min) * index) / 3);
    const xTickIndexes = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
    const periodPct = first === 0 ? null : ((last - first) / first) * 100;
    const summary = `美元兑人民币汇率趋势，${points[0].date} 至 ${points[points.length - 1].date}，区间${rising ? '上涨' : '下跌'} ${Math.abs(periodPct ?? 0).toFixed(2)}%，最新 ${last.toFixed(4)}。使用左右方向键查看每日汇率。`;
    const active = activeIndex == null ? null : points[activeIndex];
    const activeCoord = activeIndex == null ? null : coords[activeIndex];

    const activateFromPointer = (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const pointerX = ((event.clientX - rect.left) / rect.width) * WIDTH;
        let nearest = 0;
        let distance = Infinity;
        coords.forEach((point, index) => {
            const nextDistance = Math.abs(point.x - pointerX);
            if (nextDistance < distance) {
                distance = nextDistance;
                nearest = index;
            }
        });
        setActiveIndex(nearest);
    };

    const onKeyDown = (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        setActiveIndex((current) => {
            if (event.key === 'Home') return 0;
            if (event.key === 'End') return points.length - 1;
            const base = current == null ? points.length - 1 : current;
            return Math.max(0, Math.min(points.length - 1, base + (event.key === 'ArrowRight' ? 1 : -1)));
        });
    };

    return (
        <div style={{position: 'relative'}}>
            <svg
                viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                width="100%"
                height={HEIGHT}
                preserveAspectRatio="none"
                style={{display: 'block', touchAction: 'pan-y', borderRadius: 4}}
                role="img"
                tabIndex={0}
                aria-label={active ? `${active.date}，1 美元兑 ${active.close.toFixed(4)} 人民币` : summary}
                onPointerMove={activateFromPointer}
                onPointerLeave={() => setActiveIndex(null)}
                onFocus={() => setActiveIndex((current) => current == null ? points.length - 1 : current)}
                onBlur={() => setActiveIndex(null)}
                onKeyDown={onKeyDown}
            >
                <title>美元兑人民币汇率趋势</title>
                <desc>{summary}</desc>
                <defs>
                    <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={stroke} stopOpacity="0.20"/>
                        <stop offset="100%" stopColor={stroke} stopOpacity="0.01"/>
                    </linearGradient>
                </defs>

                {yTicks.map((tick) => (
                    <g key={tick}>
                        <line x1={PAD.left} y1={y(tick)} x2={WIDTH - PAD.right} y2={y(tick)} stroke="#f0f0f0" strokeWidth="1"/>
                        <text x={PAD.left - 8} y={y(tick) + 3} textAnchor="end" fill="#999" fontSize="9.5" fontFamily="monospace">
                            {tick.toFixed(4)}
                        </text>
                    </g>
                ))}

                <path d={area} fill={`url(#${gradientId})`}/>
                <path d={line} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"/>
                <circle cx={coords[coords.length - 1].x} cy={coords[coords.length - 1].y} r="3" fill={stroke}/>

                {xTickIndexes.map((index) => (
                    <text
                        key={points[index].date}
                        x={coords[index].x}
                        y={HEIGHT - 8}
                        textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}
                        fill="#999"
                        fontSize="10"
                    >
                        {shortDate(points[index].date)}
                    </text>
                ))}

                {active && activeCoord ? (
                    <g pointerEvents="none">
                        <line x1={activeCoord.x} y1={PAD.top} x2={activeCoord.x} y2={HEIGHT - PAD.bottom} stroke="#bfbfbf" strokeDasharray="3 3"/>
                        <circle cx={activeCoord.x} cy={activeCoord.y} r="4" fill="#fff" stroke={stroke} strokeWidth="2"/>
                    </g>
                ) : null}
            </svg>

            {active && activeCoord ? (
                <div
                    role="status"
                    style={{
                        position: 'absolute',
                        left: `${Math.min(84, Math.max(16, (activeCoord.x / WIDTH) * 100))}%`,
                        top: `${(activeCoord.y / HEIGHT) * 100}%`,
                        transform: activeCoord.y > 64 ? 'translate(-50%, calc(-100% - 10px))' : 'translate(-50%, 12px)',
                        padding: '6px 8px',
                        borderRadius: 6,
                        background: 'rgba(0,0,0,0.82)',
                        color: '#fff',
                        fontSize: 12,
                        lineHeight: 1.45,
                        whiteSpace: 'nowrap',
                        pointerEvents: 'none',
                        zIndex: 2,
                    }}
                >
                    <div>{active.date}</div>
                    <div style={{fontFamily: 'monospace'}}>{active.close.toFixed(4)} CNY</div>
                </div>
            ) : null}
        </div>
    );
}
