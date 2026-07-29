import type { ProviderPoi } from "./data-provider";

export interface PlaceLinks {
  amapPlace: string;
  amapNavigation: string;
  diningSearch?: string;
}

export function buildPlaceLinks(poi: Pick<ProviderPoi, "name" | "city" | "lng" | "lat" | "category">): PlaceLinks {
  const common = {
    src: "activity-agent",
    coordinate: "gaode",
    callnative: "0",
  };
  const marker = new URLSearchParams({
    position: `${poi.lng},${poi.lat}`,
    name: poi.name,
    ...common,
  });
  const navigation = new URLSearchParams({
    to: `${poi.lng},${poi.lat},${poi.name}`,
    mode: "walk",
    policy: "1",
    ...common,
  });
  return {
    amapPlace: `https://uri.amap.com/marker?${marker}`,
    amapNavigation: `https://uri.amap.com/navigation?${navigation}`,
    diningSearch: poi.category === "dining"
      ? `https://www.dianping.com/search/keyword/${encodeURIComponent(poi.city)}/0_${encodeURIComponent(poi.name)}`
      : undefined,
  };
}
