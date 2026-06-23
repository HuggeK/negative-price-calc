"use client";

import { useMemo } from "react";
import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@sourceful-energy/ui";
import { LineChart as LineChartIcon } from "lucide-react";

interface DailyData {
  date?: string;
  production_kwh?: number;
  revenue_sek?: number;
  spot_sunlit_sek_per_kwh?: number;
}

interface PriceLineChartProps {
  dailyData?: DailyData[];
  title?: string;
}

const MONTHS = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

/**
 * Daily spot price (öre/kWh) over the period. When SMHI STRÅNG sunlit-hour data is available
 * the daily value is the mean spot over the hours the sun was up (when you could export);
 * otherwise it falls back to the production-weighted spot you actually exported at. Dips below
 * the zero line mark days when the spot price went negative during those hours.
 */
export function PriceLineChart({ dailyData, title }: PriceLineChartProps) {
  const usesSunlit = useMemo(
    () => !!dailyData?.some((d) => d.spot_sunlit_sek_per_kwh != null),
    [dailyData]
  );
  const chartData = useMemo(() => {
    if (!dailyData || dailyData.length === 0) return [];
    return dailyData
      .filter((d) => (d.production_kwh || 0) > 0)
      .map((item) => {
        const date = item.date || "";
        const [, m, d] = date.split("-");
        const label = m && d ? `${parseInt(d, 10)} ${MONTHS[parseInt(m, 10) - 1]}` : date;
        const ore =
          item.spot_sunlit_sek_per_kwh != null
            ? item.spot_sunlit_sek_per_kwh * 100
            : ((item.revenue_sek || 0) / (item.production_kwh || 1)) * 100;
        return { name: label, fullDate: date, ore: Math.round(ore * 10) / 10 };
      });
  }, [dailyData]);

  if (chartData.length === 0) return null;
  const heading = title ?? (usesSunlit ? "Dagligt spotpris under soltimmar (SMHI)" : "Dagligt spotpris (snitt)");

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <LineChartIcon className="h-5 w-5 text-primary" />
          <CardTitle className="text-lg">{heading}</CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              <XAxis dataKey="name" stroke="#666" fontSize={12} tickLine={false} minTickGap={24} />
              <YAxis
                stroke="#666"
                fontSize={12}
                tickLine={false}
                tickFormatter={(v) => `${Number(v).toFixed(0)}`}
                label={{ value: "öre/kWh", angle: -90, position: "insideLeft", fill: "#666", fontSize: 11 }}
              />
              <Tooltip
                contentStyle={{ backgroundColor: "#1a1a1a", border: "1px solid #333", borderRadius: "8px", fontSize: "12px" }}
                labelStyle={{ color: "#fff" }}
                itemStyle={{ color: "#fff" }}
                formatter={(value) => [`${(typeof value === "number" ? value : 0).toFixed(1)} öre/kWh`, "Spotpris"]}
              />
              <ReferenceLine y={0} stroke="#ef4444" strokeDasharray="4 4" />
              <Line
                type="monotone"
                dataKey="ore"
                name="Spotpris"
                stroke="#00FF84"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-3 text-center text-sm text-muted-foreground">
          {usesSunlit
            ? "Snittspot per dag över soltimmarna (SMHI STRÅNG, instrålning > 0) – priset under fönstret då du faktiskt kan exportera. Linjen under noll = negativt pris under soltimmar."
            : "Produktionsviktat snittpris per dag. Linjen under noll = dagar då spotpriset var negativt medan du producerade. Tips: välj en plats i inställningarna för att basera snittet på soltimmar (SMHI STRÅNG)."}
        </p>
      </CardContent>
    </Card>
  );
}
