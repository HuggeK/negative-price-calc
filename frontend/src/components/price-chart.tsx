"use client";

import { useMemo } from "react";
import {
  ComposedChart,
  Bar,
  Area,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@sourceful-energy/ui";
import { TrendingUp } from "lucide-react";

interface DailyData {
  date?: string;
  production_kwh?: number;
  revenue_sek?: number;
  negative_value_sek?: number;
}

interface PriceChartProps {
  dailyData?: DailyData[];
  title?: string;
}

const MONTHS = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

/**
 * Daily overview: net export value (SEK) bars (green/red) on the left axis, with daily
 * production (kWh) as a light-yellow area in the background on the right axis.
 */
export function PriceChart({ dailyData, title = "Daglig översikt" }: PriceChartProps) {
  const chartData = useMemo(() => {
    if (!dailyData || dailyData.length === 0) return [];
    return dailyData.map((item) => {
      const date = item.date || "";
      const [, m, d] = date.split("-");
      const label = m && d ? `${parseInt(d, 10)} ${MONTHS[parseInt(m, 10) - 1]}` : date;
      return {
        name: label,
        fullDate: date,
        revenue: item.revenue_sek || 0,
        production: item.production_kwh || 0,
      };
    });
  }, [dailyData]);

  if (chartData.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-5 w-5 text-primary" />
          <CardTitle className="text-lg">{title}</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              <XAxis dataKey="name" stroke="#666" fontSize={12} tickLine={false} minTickGap={24} />
              <YAxis yAxisId="left" stroke="#666" fontSize={12} tickLine={false} tickFormatter={(v) => `${Number(v).toFixed(0)}`} />
              <YAxis
                yAxisId="right"
                orientation="right"
                stroke="#FDE68A"
                fontSize={12}
                tickLine={false}
                tickFormatter={(v) => `${Number(v).toFixed(0)}`}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#1a1a1a",
                  border: "1px solid #333",
                  borderRadius: "8px",
                  fontSize: "12px",
                }}
                labelStyle={{ color: "#fff" }}
                itemStyle={{ color: "#fff" }}
                formatter={(value, name) => {
                  const v = typeof value === "number" ? value : 0;
                  if (name === "Produktion") return [`${v.toFixed(1)} kWh`, name];
                  return [`${v.toFixed(2)} kr`, name];
                }}
              />
              <ReferenceLine yAxisId="left" y={0} stroke="#666" />
              {/* Production in the background (light yellow), on the right kWh axis. */}
              <Area
                yAxisId="right"
                type="monotone"
                dataKey="production"
                name="Produktion"
                stroke="#FDE68A"
                strokeOpacity={0.5}
                fill="#FDE68A"
                fillOpacity={0.18}
              />
              {/* Net value in front, on the left SEK axis. */}
              <Bar yAxisId="left" dataKey="revenue" name="Nettovärde" radius={[2, 2, 0, 0]}>
                {chartData.map((entry, i) => (
                  <Cell key={i} fill={entry.revenue >= 0 ? "#00FF84" : "#ef4444"} />
                ))}
              </Bar>
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div className="flex flex-wrap justify-center gap-x-6 gap-y-2 mt-4 text-sm">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-primary" />
            <span className="text-muted-foreground">Positivt nettovärde (kr/dag)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-destructive" />
            <span className="text-muted-foreground">Negativt nettovärde (kr/dag)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: "#FDE68A" }} />
            <span className="text-muted-foreground">Produktion (kWh/dag, höger axel)</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
