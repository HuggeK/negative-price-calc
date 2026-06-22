"use client";

import { useMemo } from "react";
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";

interface FusePoint {
  date?: string;
  peak_kw?: number;
}

interface FuseChartProps {
  serie?: FusePoint[];
  limitKw?: number;
}

const MONTHS = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

/** Daily peak export power (kW) with the main-fuse limit drawn as a reference line. */
export function FuseChart({ serie, limitKw }: FuseChartProps) {
  const data = useMemo(() => {
    if (!serie || serie.length === 0) return [];
    return serie.map((d) => {
      const iso = d.date || "";
      const [, m, day] = iso.split("-");
      const label = m && day ? `${parseInt(day, 10)} ${MONTHS[parseInt(m, 10) - 1]}` : iso;
      return { name: label, fullDate: iso, peak: d.peak_kw || 0 };
    });
  }, [serie]);

  if (data.length === 0) return null;
  const threshold = (limitKw ?? 0) * 0.98;

  return (
    <div className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#333" />
          <XAxis dataKey="name" stroke="#666" fontSize={12} tickLine={false} minTickGap={24} />
          <YAxis
            stroke="#666"
            fontSize={12}
            tickLine={false}
            tickFormatter={(v) => `${Number(v).toFixed(0)}`}
            domain={[0, (dataMax: number) => Math.max(dataMax, limitKw ?? 0) * 1.1]}
          />
          <Tooltip
            contentStyle={{ backgroundColor: "#1a1a1a", border: "1px solid #333", borderRadius: "8px", fontSize: "12px" }}
            labelStyle={{ color: "#fff" }}
            itemStyle={{ color: "#fff" }}
            formatter={(value) => [`${(typeof value === "number" ? value : 0).toFixed(2)} kW`, "Toppeffekt"]}
          />
          {limitKw !== undefined && limitKw > 0 && (
            <ReferenceLine
              y={limitKw}
              stroke="#ef4444"
              strokeDasharray="4 4"
              label={{ value: `Säkring ${limitKw.toFixed(1)} kW`, position: "insideTopRight", fill: "#ef4444", fontSize: 11 }}
            />
          )}
          <Bar dataKey="peak" name="Toppeffekt" radius={[2, 2, 0, 0]}>
            {data.map((entry, i) => (
              <Cell key={i} fill={entry.peak >= threshold ? "#ef4444" : "#00FF84"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
