"use client";

import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface LossPoint {
  date?: string;
  forlust_sek?: number;
}

interface LossChartProps {
  serie?: LossPoint[];
}

/** Daily total loss (SEK) from quarters exported below the loss threshold. */
export function LossChart({ serie }: LossChartProps) {
  const data = useMemo(() => {
    if (!serie || serie.length === 0) return [];
    return serie.map((d) => {
      const iso = d.date || "";
      const [, m, day] = iso.split("-");
      const monthNames = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
      const label = m && day ? `${parseInt(day, 10)} ${monthNames[parseInt(m, 10) - 1]}` : iso;
      return { name: label, fullDate: iso, loss: d.forlust_sek || 0 };
    });
  }, [serie]);

  if (data.length === 0) return null;

  return (
    <div className="h-56">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#333" />
          <XAxis dataKey="name" stroke="#666" fontSize={12} tickLine={false} minTickGap={16} />
          <YAxis stroke="#666" fontSize={12} tickLine={false} tickFormatter={(v) => `${Number(v).toFixed(0)}`} />
          <Tooltip
            contentStyle={{
              backgroundColor: "#1a1a1a",
              border: "1px solid #333",
              borderRadius: "8px",
              fontSize: "12px",
            }}
            labelStyle={{ color: "#fff" }}
            formatter={(value) => [`${(typeof value === "number" ? value : 0).toFixed(2)} kr`, "Förlust"]}
          />
          <Bar dataKey="loss" name="Förlust" fill="#ef4444" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
