export type Units = "imperial" | "metric";
export function formatDistance(meters: number, units: Units): string {
  if (units === "metric") return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
  const miles = meters / 1609.344;
  return miles < 0.1 ? `${Math.round(meters / 0.3048)} ft` : `${miles.toFixed(1)} mi`;
}
export function formatSpeed(mph: number, units: Units): string {
  return units === "metric" ? `${Math.round(mph * 1.609344)} km/h` : `${mph} mph`;
}
