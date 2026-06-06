/**
 * Weather Service - 天气预报查询（mock）
 *
 * SOP 中"环境感知"环节的核心数据源。
 * Demo 阶段：内置确定性 mock 数据（基于日期 hash）。
 * 生产阶段：替换 fetchWeather() 实现为真实 API（和风/中国气象）。
 */

export type WeatherCondition = "sunny" | "cloudy" | "rainy" | "snowy" | "hot" | "cold";

export interface WeatherForecast {
  city: string;
  date: string;
  condition: WeatherCondition;
  emoji: string;
  description: string;
  tempMax: number;
  tempMin: number;
  precipitation: number;
  windSpeed: number;
  advice: string;
  suitableForOutdoor: boolean;
}

const CONDITION_POOL: WeatherCondition[] = ["sunny", "cloudy", "rainy", "sunny", "cloudy", "hot", "sunny", "rainy", "cloudy", "snowy"];

const CONDITION_META: Record<WeatherCondition, { emoji: string; description: string; outdoor: boolean }> = {
  sunny: { emoji: "☀️", description: "晴", outdoor: true },
  cloudy: { emoji: "⛅", description: "多云", outdoor: true },
  rainy: { emoji: "🌧️", description: "雨", outdoor: false },
  snowy: { emoji: "❄️", description: "雪", outdoor: false },
  hot: { emoji: "🔥", description: "高温 (>35°C)", outdoor: false },
  cold: { emoji: "🥶", description: "低温 (<5°C)", outdoor: false },
};

function dateToSeed(date: string): number {
  let h = 0;
  for (let i = 0; i < date.length; i++) h = (h * 31 + date.charCodeAt(i)) >>> 0;
  return h;
}

function generateWeather(city: string, date: string): WeatherForecast {
  const seed = dateToSeed(date + city);
  const cond = CONDITION_POOL[seed % CONDITION_POOL.length]!;
  const meta = CONDITION_META[cond];
  const baseTemp = 15 + ((seed >> 4) % 20);
  const tempMax = cond === "hot" ? 36 : cond === "cold" ? 4 : baseTemp + 8;
  const tempMin = cond === "hot" ? 28 : cond === "cold" ? -2 : baseTemp - 5;
  const precipitation = cond === "rainy" || cond === "snowy" ? 50 + (seed % 50) : cond === "cloudy" ? 10 + (seed % 20) : 0;
  const windSpeed = 5 + (seed % 15);

  const advicePool: string[] = [];
  if (!meta.outdoor) {
    advicePool.push("推荐室内活动");
    advicePool.push("出行请带伞");
  }
  if (tempMax > 32) advicePool.push("注意防晒、多喝水");
  if (tempMin < 5) advicePool.push("注意保暖");
  if (cond === "sunny") advicePool.push("适合户外活动");

  return {
    city,
    date,
    condition: cond,
    emoji: meta.emoji,
    description: meta.description,
    tempMax,
    tempMin,
    precipitation,
    windSpeed,
    advice: advicePool.length > 0 ? advicePool.join("；") : "天气适宜出行",
    suitableForOutdoor: meta.outdoor,
  };
}

export function getWeather(city: string, date: string): WeatherForecast {
  return generateWeather(city, date);
}

export function getWeatherAdvice(forecast: WeatherForecast): { recommendIndoor: boolean; reason: string } {
  return {
    recommendIndoor: !forecast.suitableForOutdoor,
    reason: forecast.advice,
  };
}
