export type MetricItem = { label: string; value: string; tone?: "gain" | "loss" | "muted" };

export function MetricStrip({ items }: { items: MetricItem[] }) {
  return (
    <div className="metric-strip">
      {items.map((item) => (
        <span key={item.label} className="metric-item">
          <span className="metric-label">{item.label}</span>
          <span className={`metric-value${item.tone ? ` ${item.tone}` : ""}`}>{item.value}</span>
        </span>
      ))}
    </div>
  );
}
